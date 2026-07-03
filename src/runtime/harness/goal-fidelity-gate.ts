/**
 * Goal-fidelity gate — does this irreversible write advance the run's STATED
 * GOAL and honor the loaded SKILL's defining requirement?
 *
 * Sibling to the grounding gate (grounding-gate.ts), same chokepoint
 * (wrapToolForHarness → runBrackets), same fail-open contract, same
 * soft-error reroute. The difference is the question:
 *
 *   - GROUNDING asks: is this payload faithful to the SOURCE ARTIFACTS the
 *     agent gathered for this target? (the Eley "Houston→Denver" mutation)
 *   - The completion/objective judge asks, AFTER the writes: is the whole
 *     task done?
 *   - GOAL-FIDELITY asks, BEFORE the write: does THIS one outgoing action
 *     advance the GOAL the user stated and honor the DEFINING requirement of
 *     the skill the agent loaded (a committed procedure)?
 *
 * The gap this closes: the 2026-06 outbound-emails run that sailed through
 * every existing gate (right mailbox, approved batch, payload internally
 * consistent) yet skipped the scorpion skill's per-firm research — every
 * recipient got a byte-identical generic opening. No gate asked "does this
 * honor the loaded skill's per-item step?" This one does.
 *
 * It is GENERAL: it reads the goal and the skill. It hardcodes NO task
 * heuristic ("emails need first names" would be wrong — the scorpion skill
 * bans generic greetings on purpose). It catches "skipped per-firm research"
 * because the SKILL says so, not because of a baked-in email rule.
 *
 * Cost discipline (the design's §3): a second unconditional judge call on
 * every irreversible write would double hot-path latency, so a DETERMINISTIC
 * pre-filter runs first and can short-circuit:
 *   3a-i.  Skill renderer/producer never ran → block deterministically
 *          (reuse skillBodyExecutionShortfall — the lunar-audit class). No judge.
 *   3a-ii. Batch-uniformity (this send's opening is byte-identical across
 *          DISTINCT targets) → evidence fed to the judge, NOT an auto-block
 *          (a legitimately-templated announcement is also identical — the
 *          judge disambiguates against the goal+skill).
 *   3a-iii.Nothing to check (no goal, or no skill with a concrete
 *          requirement) → allow, skip the judge.
 *   3b.    Goal-fidelity judge — ONE fast fail-open call, only when there IS
 *          a goal AND a loaded skill (or batch-uniformity surfaced). Output
 *          {fulfills, gap}; fulfills=false → soft-block + reroute.
 *
 * Fail-open at every step: no goal, no skill, judge error, unparseable
 * verdict → ALLOW. This gate must never wedge legitimate work. Env:
 * CLEMMY_GOAL_FIDELITY_GATE=off disables, =on (default) gates irreversible
 * writes.
 */
import { getRuntimeEnv } from '../../config.js';
import { listEvents } from './eventlog.js';
import { classifyExternalWrite } from './confirm-first-gate.js';
import { extractTargetKeys, renderPayloadForJudge } from './grounding-gate.js';
import { gatherSessionSkills, skillBodyExecutionShortfall, type SessionSkill } from './skill-execution.js';
import { composeJudgedObjective } from './objective-judge.js';
import { getActiveGoalForSession } from '../../agents/plan-proposals.js';

// ─────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────

export function isGoalFidelityGateEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_GOAL_FIDELITY_GATE', 'on') ?? 'on').toLowerCase();
  return raw !== 'off' && raw !== 'false' && raw !== '0';
}

/** CLEMMY_GOAL_ALIGNMENT_GATE (default on). Widens the goal-fidelity gate to also
 *  judge GOAL ALIGNMENT on an irreversible write when a GOAL is recovered but NO
 *  skill is loaded — the ad-hoc-send gap (2026-06-22 sess-mqplaw0l: a YOLO send
 *  fired with ZERO goal-alignment judging because the skill-less branch
 *  short-circuited to allow; only mechanical guards + the autonomy_note ran).
 *  YOLO still auto-approves; this just makes a cheap cross-family judge vet that
 *  the irreversible action serves the goal first (aligned → silent proceed,
 *  misaligned → bounce before the write). OFF = byte-identical legacy skip
 *  (skills.length===0 → allow). DELETE-WHEN-VALIDATED: fold the widening in
 *  unconditionally once a few live YOLO re-fires show aligned sends proceed +
 *  misaligned bounce with no false-positive on legit skill-less sends. */
export function isGoalAlignmentGateEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_GOAL_ALIGNMENT_GATE', 'on') ?? 'on').toLowerCase();
  return raw !== 'off' && raw !== 'false' && raw !== '0';
}

/** Draft-only-skill INFORM behavior (2026-06-17). When a send is blocked because
 *  the loaded skill is draft-only / present-for-approval (a SCOPE statement, not a
 *  prohibition), tell the model to PRESENT the drafts and ASK "good to send?"
 *  rather than the generic "rebuild the payload and retry the write" recovery —
 *  and don't count it as a fidelity FAILURE (no escalate). Still BLOCKS the send
 *  (it does not auto-send). =off reverts to the old generic block for that kind. */
export function isGoalFidelityDraftInformEnabled(): boolean {
  if (!isGoalFidelityGateEnabled()) return false;
  return (getRuntimeEnv('CLEMMY_GOAL_FIDELITY_DRAFT_INFORM', 'on') ?? 'on').toLowerCase() !== 'off';
}

// Write-time fidelity is ALWAYS judged against the BLESSED goal contract (the
// objective+successCriteria the completion validator uses), not a goal re-derived
// from raw events — so a send can't be blocked against a goal the user never
// approved. Re-derivation remains the fallback for goal-less sessions.
// (Graduated from CLEMMY_GOAL_FIDELITY_USE_CONTRACT 2026-06-24.)

// ─────────────────────────────────────────────────────────────────
// Goal assembly (mirrors loop.ts feeding the completion judge)
// ─────────────────────────────────────────────────────────────────

/**
 * Assemble the run's goal from `sessionId` alone — the exact pattern loop.ts
 * uses to feed the completion judge: the user_input_received events →
 * composeJudgedObjective(latest, priors). A bare follow-up ("just mine
 * please") is composed with the recent real priors so the gate judges what
 * the user actually asked for. Fail-open → ''.
 */
export function gatherGoalText(sessionId: string): string {
  try {
    // Prefer the BLESSED goal contract the user actually approved — the SAME
    // objective+successCriteria the completion validator judges against
    // (loop.ts) — over a goal RE-DERIVED from raw events. This removes the
    // contradiction where a write was blocked against a "goal" the user never
    // blessed while satisfying the one they did. Re-derivation (below) is the
    // fallback ONLY for goal-less sessions, so behavior is unchanged there.
    {
      const contract = getActiveGoalForSession(sessionId);
      const plan = contract?.approvedPlan ?? contract?.plan;
      if (plan) {
        const objective = (plan.objective ?? '').trim();
        const criteria = (plan.successCriteria ?? []).filter((c) => typeof c === 'string' && c.trim());
        if (objective || criteria.length > 0) {
          return [
            objective,
            ...(criteria.length ? ['Success criteria:', ...criteria.map((c) => `- ${c}`)] : []),
          ].filter(Boolean).join('\n').trim();
        }
      }
    }
    const inputs = listEvents(sessionId, { types: ['user_input_received'] })
      .map((ev) => String((ev.data as { text?: string } | undefined)?.text ?? ''))
      .filter((t) => t.trim().length > 0);
    if (inputs.length === 0) return '';
    const latest = inputs[inputs.length - 1];
    const priors = inputs.slice(0, -1);
    return composeJudgedObjective(latest, priors).trim();
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────
// Payload free-text + batch-uniformity (pure, deterministic — no LLM)
// ─────────────────────────────────────────────────────────────────

/** Arg keys that carry the natural-language MESSAGE of an external write —
 *  the region a per-target skill is supposed to personalize. Generic on
 *  purpose (covers composio email/CRM/social shapes + most custom tools). */
const BODY_KEY_RE = /(^|_)(body|html_body|text|message|content|comment|note|description|caption|post)$/i;

/**
 * Extract the outgoing message's free-text body from the call args — the
 * longest string found under a message-like key, descending through
 * composio's JSON-encoded nested `arguments`. Pure. Returns '' when the write
 * carries no natural-language body (a pure record update, a deploy command).
 */
export function extractMessageBody(rawArgs: unknown): string {
  let best = '';
  const consider = (s: string) => { if (s.length > best.length) best = s; };
  const visit = (value: unknown, keyHint?: string): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      if ((value.startsWith('{') || value.startsWith('[')) && value.length < 200_000) {
        try { visit(JSON.parse(value), keyHint); return; } catch { /* treat as plain string */ }
      }
      if (keyHint && BODY_KEY_RE.test(keyHint)) consider(value);
      return;
    }
    if (Array.isArray(value)) { for (const v of value) visit(v, keyHint); return; }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, k);
    }
  };
  visit(rawArgs);
  return best;
}

/** Minimum normalized-opening length below which a body is too thin to treat
 *  as a personalization region (skip the uniformity signal). */
const MIN_REGION_CHARS = 40;
/** How much of the opening to compare. The load-bearing personalization
 *  (per-firm research woven into the pitch) lives in the opening paragraph. */
const REGION_CHARS = 320;
const SALUTATION_RE = /^(?:dear|hi|hello|hey|greetings|good (?:morning|afternoon|evening))\b[^\n]*\n+/i;

/**
 * The normalized "personalization region" of a message — the opening, with a
 * leading salutation line stripped (a greeting differs trivially by name and
 * is NOT the per-target research), whitespace collapsed and lowercased, first
 * REGION_CHARS chars. Byte-identical regions across DISTINCT targets is the
 * signal that the per-item step was skipped. Pure. Returns '' when too thin.
 */
export function personalizationRegion(body: string): string {
  if (!body || typeof body !== 'string') return '';
  const deSaluted = body.replace(SALUTATION_RE, '');
  const normalized = deSaluted.replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalized.length < MIN_REGION_CHARS) return '';
  return normalized.slice(0, REGION_CHARS);
}

export interface PriorSend { target: string; region: string }
export interface BatchUniformity { uniform: boolean; peerTargets: string[] }

/**
 * Pure: is this send's opening byte-identical to prior same-shape sends this
 * session to DIFFERENT targets? Two identical sends to the SAME target are a
 * duplicate (the duplicate gate's job), not a personalization skip — so only
 * DISTINCT other targets count. Empty currentRegion / currentTarget → never
 * uniform (a bodyless write has no personalization to skip).
 */
export function detectBatchUniformity(input: {
  currentTarget: string;
  currentRegion: string;
  priorSends: PriorSend[];
}): BatchUniformity {
  if (!input.currentRegion || !input.currentTarget) return { uniform: false, peerTargets: [] };
  const peers = new Set<string>();
  for (const s of input.priorSends) {
    if (!s.target || !s.region) continue;
    if (s.target === input.currentTarget) continue;
    if (s.region === input.currentRegion) peers.add(s.target);
  }
  return { uniform: peers.size > 0, peerTargets: [...peers] };
}

/**
 * Gather prior same-shape irreversible sends (target + opening region) from
 * the session's tool_called events. The current call's own tool_called is
 * already logged (onToolStart fires before this gate) but carries the SAME
 * target, so detectBatchUniformity's distinct-target filter excludes it.
 * Fail-open → [].
 */
function gatherPriorSameShapeSends(sessionId: string, toolName: string, shapeKey: string | undefined): PriorSend[] {
  const out: PriorSend[] = [];
  let events;
  try { events = listEvents(sessionId, { types: ['tool_called'] }); } catch { return []; }
  for (const e of events) {
    if (e.data?.tool !== toolName) continue;
    const rawArgs = e.data?.arguments;
    let parsed: unknown = rawArgs;
    if (typeof rawArgs === 'string') { try { parsed = JSON.parse(rawArgs); } catch { parsed = rawArgs; } }
    let shape;
    try { shape = classifyExternalWrite(toolName, parsed); } catch { continue; }
    if (!shape.irreversible) continue;
    if (shapeKey && shape.shapeKey !== shapeKey) continue;
    const region = personalizationRegion(extractMessageBody(parsed));
    if (!region) continue;
    const target = extractTargetKeys(parsed)[0] ?? '';
    if (!target) continue;
    out.push({ target, region });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Explainability surface (pure, no judge call)
// ─────────────────────────────────────────────────────────────────

export interface GoalFidelitySkillSummary {
  name: string;
  bodyPreview: string;
  rendererShortfall: { skill: string; prescribed: string[] } | null;
}

export interface GoalFidelityEvidenceSummary {
  toolName: string;
  irreversible: boolean;
  shapeKey?: string;
  targets: string[];
  currentTarget: string;
  messageRegionPresent: boolean;
  priorSameShapeTargets: string[];
  uniform: boolean;
  uniformPeerTargets: string[];
  text: string;
  payloadPreview: string;
}

export interface GoalFidelityStateSummary {
  sessionId: string;
  generatedAt: string;
  enabled: boolean;
  alignmentEnabled: boolean;
  hasGoal: boolean;
  goal: string;
  skills: GoalFidelitySkillSummary[];
  mode: 'disabled' | 'no_goal' | 'legacy_no_skill' | 'alignment_judge_ready' | 'skill_judge_ready' | 'renderer_block_risk';
  issues: string[];
  evidence?: GoalFidelityEvidenceSummary;
}

function clipOneLine(s: string, max = 900): string {
  const compact = s.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

/**
 * Inspect the exact goal/skill/evidence inputs the write-time gate would use,
 * without invoking the LLM judge or mutating failure counters. This gives UI,
 * APIs, and tests a stable truth surface for "why would this write be judged?"
 * instead of forcing operators to reverse-engineer it from the event log.
 */
export function summarizeGoalFidelityState(
  sessionId: string,
  toolName?: string,
  rawArgs?: unknown,
): GoalFidelityStateSummary {
  const issues: string[] = [];
  const enabled = isGoalFidelityGateEnabled();
  const alignmentEnabled = isGoalAlignmentGateEnabled();
  const goal = gatherGoalText(sessionId);
  let rawSkills: SessionSkill[] = [];
  try {
    rawSkills = gatherSessionSkills(sessionId);
  } catch (err) {
    issues.push(`skills_unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const skills = rawSkills.map((skill) => {
    let rendererShortfall: { skill: string; prescribed: string[] } | null = null;
    try {
      rendererShortfall = skillBodyExecutionShortfall(skill.name, skill.body, sessionId, skill.dir);
    } catch {
      rendererShortfall = null;
    }
    return {
      name: skill.name,
      bodyPreview: clipOneLine(skill.body),
      rendererShortfall,
    };
  });

  if (!enabled) issues.push('goal fidelity gate is disabled');
  if (!goal) issues.push('no recoverable user goal or approved goal contract');
  if (goal && skills.length === 0 && !alignmentEnabled) issues.push('no loaded skill and the goal-alignment widening is disabled');
  for (const skill of skills) {
    if (skill.rendererShortfall) {
      issues.push(`skill "${skill.name}" has not run prescribed producer: ${skill.rendererShortfall.prescribed.join(', ')}`);
    }
  }

  let mode: GoalFidelityStateSummary['mode'] = 'skill_judge_ready';
  if (!enabled) mode = 'disabled';
  else if (!goal) mode = 'no_goal';
  else if (skills.some((skill) => skill.rendererShortfall)) mode = 'renderer_block_risk';
  else if (skills.length === 0 && !alignmentEnabled) mode = 'legacy_no_skill';
  else if (skills.length === 0) mode = 'alignment_judge_ready';

  let evidence: GoalFidelityEvidenceSummary | undefined;
  if (toolName && rawArgs !== undefined) {
    const targets = extractTargetKeys(rawArgs);
    let irreversible = false;
    let shapeKey: string | undefined;
    try {
      const shape = classifyExternalWrite(toolName, rawArgs);
      irreversible = shape.irreversible;
      shapeKey = shape.shapeKey;
    } catch (err) {
      issues.push(`write_shape_unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }

    const currentTarget = targets[0] ?? '';
    const currentRegion = personalizationRegion(extractMessageBody(rawArgs));
    const priorSends = gatherPriorSameShapeSends(sessionId, toolName, shapeKey);
    const uniform = detectBatchUniformity({ currentTarget, currentRegion, priorSends });
    let text = '(none)';
    if (uniform.uniform) {
      text = `This action's opening paragraph is BYTE-IDENTICAL to ${uniform.peerTargets.length} prior same-shape send(s) this session to DISTINCT target(s) (e.g. ${uniform.peerTargets.slice(0, 3).join(', ')}).`;
    }
    let payloadPreview = '';
    try {
      payloadPreview = clipOneLine(renderPayloadForJudge(toolName, rawArgs), 1200);
    } catch {
      payloadPreview = '';
    }
    evidence = {
      toolName,
      irreversible,
      shapeKey,
      targets,
      currentTarget,
      messageRegionPresent: currentRegion.length > 0,
      priorSameShapeTargets: priorSends.map((send) => send.target),
      uniform: uniform.uniform,
      uniformPeerTargets: uniform.peerTargets,
      text,
      payloadPreview,
    };
  }

  return {
    sessionId,
    generatedAt: new Date().toISOString(),
    enabled,
    alignmentEnabled,
    hasGoal: !!goal,
    goal,
    skills,
    mode,
    issues,
    evidence,
  };
}

// ─────────────────────────────────────────────────────────────────
// Judge (3b) — one fast fail-open call
// ─────────────────────────────────────────────────────────────────

export interface GoalFidelityVerdict {
  /** True unless there is a CONCRETE, nameable gap between this action and the
   *  goal's intent or the skill's defining requirement. Fail open. */
  fulfills: boolean;
  /** One sentence: the single specific gap (when fulfills=false), or why it passed. */
  gap: string;
  /** When fulfills=false: 'present_for_approval' if the ONLY gap is that the
   *  loaded skill is draft-only / requires presenting the draft for approval (a
   *  SCOPE statement, not a ban on the user-approved send) → recovery is
   *  present-and-ask, not retry-the-write, and it's not a fidelity FAILURE.
   *  'other' for a genuine violation (wrong target, off-goal, un-rendered,
   *  per-item research skipped). Absent ⇒ treated as 'other'. */
  blockKind?: 'present_for_approval' | 'other';
}

export interface GoalFidelityJudgeInput {
  goal: string;
  skills: SessionSkill[];
  payload: string;
  /** Deterministic evidence from 3a (e.g. "opening identical across N targets"). */
  evidence: string;
}

export type GoalFidelityJudgeFn = (input: GoalFidelityJudgeInput) => Promise<GoalFidelityVerdict>;

// Test injection seam — brackets.ts integration tests + unit tests stub the judge.
let judgeOverride: GoalFidelityJudgeFn | null = null;
export function _setGoalFidelityJudgeForTests(fn: GoalFidelityJudgeFn | null): void { judgeOverride = fn; }

const SKILL_BODY_CLIP = 5000;

export function buildGoalFidelityPrompt(input: GoalFidelityJudgeInput): string {
  return [
    'You are a goal-fidelity judge. An agent is ABOUT TO perform an IRREVERSIBLE external action (send an email, publish a site, update a record). You verify this ONE outgoing action — BEFORE it happens — against (1) the run\'s stated GOAL and (2) the loaded SKILL, which is a committed procedure the agent agreed to follow.',
    '',
    'You are NOT judging whether the whole task is done. Judge ONLY whether THIS action honors the goal\'s intent and the skill\'s DEFINING requirement — the expensive, per-item step that is the reason the skill exists (e.g. "research each firm before writing", "personalize per recipient", "render the deliverable with the bundled script"). IGNORE the skill\'s cheap/generic template language (tone, signature, formatting, persona).',
    '',
    'Mark fulfills=false ONLY for a concrete, NAMEABLE gap, such as:',
    '- the skill requires per-target research/personalization and this payload is generic or byte-identical across DISTINCT targets (see the deterministic evidence below);',
    '- the goal says do ONLY X and this action also does Y;',
    '- the skill requires a produced/rendered artifact and this action ships raw or unprocessed data.',
    'Vague dissatisfaction, style, "could be better", or anything you cannot put a name to → fulfills=true (FAIL OPEN). When in doubt, fulfills=true. A pure-advice/persona skill with no concrete per-item requirement has nothing to enforce → fulfills=true.',
    ...(input.skills.length === 0
      ? ['', 'NO SKILL IS LOADED for this run — judge ONLY goal-alignment, and FAIL OPEN AGGRESSIVELY. The bar to bounce is a CONTRADICTION you can name, NOT mere under-specification. Mark fulfills=false ONLY when: (a) the goal named a SPECIFIC recipient/destination and this action targets a DIFFERENT one, OR the goal said do-not-contact X and this contacts X; (b) the goal asked for X and this action does an unrelated or contradictory Y; or (c) the content is plainly off-topic from the stated goal. CRITICAL — an UNDERSPECIFIED goal that does not spell out a recipient ("reply to them", "send it", "follow up", "email a summary", "let them know") is NOT a mismatch: the agent resolving a sensible recipient/content PLAUSIBLY serves the goal → fulfills=true. If the goal is vague or generic, or you are at all uncertain whether the action serves it → fulfills=true (FAIL OPEN). Only a clear, nameable contradiction blocks; everything else proceeds.']
      : []),
    '',
    'SCOPE vs PROHIBITION: a skill that says "this skill does not send", "present for approval", or "never claim the email was sent" is describing its OWN SCOPE (it drafts; it does not itself send). That is NOT a prohibition on the user sending the approved draft. If the ONLY gap is that this present-for-approval step has not happened yet, set fulfills=false AND blockKind="present_for_approval" — the recovery is to present the draft to the user and ask "good to send?", NOT to rebuild the payload. Reserve blockKind="other" for a genuine violation (wrong target, off-goal, un-rendered artifact, per-item research skipped).',
    '',
    'Name the single specific gap and the concrete recovery.',
    '',
    '=== GOAL (what the user asked for) ===',
    input.goal || '(no explicit goal recovered)',
    '',
    '=== LOADED SKILL(S) — committed procedure; enforce the DEFINING requirement, ignore generic template language ===',
    ...(input.skills.length > 0
      ? input.skills.map((s) => `--- skill: ${s.name} ---\n${s.body.slice(0, SKILL_BODY_CLIP)}`)
      : ['(no skill loaded)']),
    '',
    '=== DETERMINISTIC EVIDENCE (computed, not inferred) ===',
    input.evidence || '(none)',
    '',
    '=== OUTGOING ACTION (about to fire) ===',
    input.payload,
    '',
    'Respond with the structured verdict.',
  ].join('\n');
}

/** Real judge: one fast-model call, structured output, throws on infra error
 *  (caller converts to fail-open). Dynamic imports keep brackets.ts free of an
 *  SDK dependency at module load — same pattern as the grounding judge. */
async function runGoalFidelityJudge(input: GoalFidelityJudgeInput): Promise<GoalFidelityVerdict> {
  const [{ Agent, Runner }, { z }, { normalizeZodForCodexStrict }, { resolveBoundaryJudge }, { withJudgeTimeout, recordJudgeMetric }] = await Promise.all([
    import('@openai/agents'),
    import('zod'),
    import('../schema-normalizer.js'),
    import('./debate-model.js'),
    import('./judge-family.js'),
  ]);
  const VerdictSchema = z.object({
    fulfills: z.boolean().describe('False ONLY on a concrete, nameable gap between this action and the goal\'s intent or the skill\'s defining requirement. Vague/style/uncertain → true (fail open).'),
    gap: z.string().describe('One short sentence: the single specific gap and the concrete recovery, or why the action is faithful.'),
    blockKind: z.enum(['present_for_approval', 'other']).describe('When fulfills=false: "present_for_approval" if the ONLY gap is that the loaded skill is draft-only — it says "does not send" / "present for approval" / "never claim the email was sent" (that is the skill\'s SCOPE, NOT a ban on the user sending the approved draft). Use "other" for a genuine violation (wrong/byte-identical target, off-goal, un-rendered artifact, per-item research skipped). When fulfills=true, use "other".'),
  });
  const routing = resolveBoundaryJudge();
  const agent = new Agent({
    name: 'GoalFidelityJudge',
    instructions: 'Verify an about-to-fire irreversible external action against the run\'s goal and the loaded skill\'s defining requirement. Output only the structured verdict.',
    // Cross-family boundary judge (avoids same-family self-grading); falls open to
    // the brain-family-safe cheap id (routing.modelId, never a repurposed BYO fast
    // slot) when no different family is logged in.
    model: routing.model ?? routing.modelId,
    // Binary verdict against an explicit rubric — low reasoning effort trims the
    // largest chunk of per-call latency on this hot path (same as the
    // completion judge).
    modelSettings: { reasoning: { effort: 'low' } },
    outputType: normalizeZodForCodexStrict(VerdictSchema) as typeof VerdictSchema,
    tools: [],
  });
  const runner = new Runner({ workflowName: 'clementine-goal-fidelity-judge' });
  const startedAt = Date.now();
  let recorded = false;
  const record = (outcome: 'passed' | 'blocked' | 'advisory' | 'timeout' | 'invalid' | 'error') => {
    recorded = true;
    recordJudgeMetric({
      lane: 'goal_fidelity',
      outcome,
      durationMs: Date.now() - startedAt,
      modelId: routing.modelId,
      judgeFamily: routing.judgeFamily,
      brainFamily: routing.brainFamily,
      selfJudge: routing.selfJudge,
    });
  };
  try {
    const result = await withJudgeTimeout(runner.run(agent, buildGoalFidelityPrompt(input), { maxTurns: 1 }));
    if (!result) {
      record('timeout');
      throw new Error('goal-fidelity judge timed out');
    }
    const parsed = VerdictSchema.safeParse(result.finalOutput);
    if (!parsed.success) {
      record('invalid');
      throw new Error('goal-fidelity judge output did not parse');
    }
    record(parsed.data.fulfills ? 'passed' : (input.skills.length === 0 ? 'advisory' : 'blocked'));
    return parsed.data;
  } catch (err) {
    if (!recorded) record('error');
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────
// Gate evaluation (called from brackets.ts for irreversible writes)
// ─────────────────────────────────────────────────────────────────

/** Per-(session,target) consecutive goal-fidelity failures — after 2, the
 *  block message escalates to "stop and ask the user". In-memory: a daemon
 *  restart resets the count, which only makes the gate gentler. Copied from
 *  grounding. */
const failureCounts = new Map<string, number>();
export function _resetGoalFidelityStateForTests(): void { failureCounts.clear(); }

export interface GoalFidelityGateResult {
  action: 'allow' | 'block';
  reason: string;
  /** How the verdict was reached (telemetry / tests). 'advisory' = the skill-less
   *  goal-alignment widening found a miss but INFORMS rather than blocks (the send
   *  proceeds; brackets records + surfaces the verdict). */
  mode: 'renderer' | 'judge' | 'allow' | 'advisory';
  /** The skill whose requirement was missed (renderer mode) / consulted. */
  skill?: string;
  /** The single specific gap (block) — fed to the reroute error. */
  gap?: string;
  /** Target keys extracted from the payload (telemetry). */
  targets: string[];
  /** Consecutive failures for this target including this one (block only). */
  failureCount?: number;
  /** Why the block fired: 'present_for_approval' (draft-only skill — present the
   *  draft + ask, do NOT count as a failure) vs 'other' (genuine violation). */
  blockKind?: 'present_for_approval' | 'other';
  /** Set ONLY when evaluated with { deferCommit: true } (the parallel pre-write
   *  path): persists the failure increment. The caller invokes it exactly when it
   *  actually surfaces this block — so an eagerly-started verdict that is DISCARDED
   *  because an earlier gate short-circuited never bumps the counter (integrity
   *  audit #2.4). Undefined on the inline path (already committed). */
  commitFailure?: () => void;
}

/**
 * Evaluate goal-fidelity for an irreversible external write. Fail-open at
 * every step: no goal / no skill / judge error → allow.
 */
export async function evaluateGoalFidelity(
  sessionId: string,
  toolName: string,
  rawArgs: unknown,
  opts: { deferCommit?: boolean } = {},
): Promise<GoalFidelityGateResult> {
  const deferCommit = opts.deferCommit === true;
  const targets = extractTargetKeys(rawArgs);
  const skills = gatherSessionSkills(sessionId);

  // 3a-i. DETERMINISTIC renderer floor (no judge): a loaded skill whose
  // RENDERER/producer script never ran was not executed — its deliverable was
  // hand-rolled (the lunar-audit "data gathered, generate-html.js never ran"
  // class). Block before the irreversible publish so the model runs the
  // renderer and retries. Reuses the proven skill-execution floor.
  for (const skill of skills) {
    let gap;
    try { gap = skillBodyExecutionShortfall(skill.name, skill.body, sessionId); } catch { gap = null; }
    if (gap) {
      const { failures, commitFailure } = recordFailure(sessionId, targets[0] ?? skill.name, deferCommit);
      return {
        action: 'block',
        mode: 'renderer',
        skill: gap.skill,
        reason: `the ${gap.skill} skill prescribes a producer script (${gap.prescribed.join(', ')}) but it never ran this session — the deliverable was not generated by the skill`,
        gap: `Run the ${gap.skill} skill's producer (${gap.prescribed.join(', ')}) to GENERATE the deliverable, then retry this write. Do not hand-roll what the skill is meant to produce.`,
        targets,
        failureCount: failures,
        commitFailure,
      };
    }
  }

  // 3a-iii. Nothing to verify WITHOUT a goal → allow (the gate never invents a
  // goal). With a goal but NO skill, the CLEMMY_GOAL_ALIGNMENT_GATE widening
  // (default on) proceeds to the judge for a pure GOAL-ALIGNMENT verdict — this
  // closes the ad-hoc-irreversible-send gap (a YOLO send that loaded no skill
  // previously fired with zero goal-alignment judging). Flag off → legacy
  // skill-less skip (byte-identical). Still irreversible-only + a single cheap
  // cross-family fail-open call, so the §3 latency floor holds.
  const goal = gatherGoalText(sessionId);
  if (!goal) {
    return { action: 'allow', mode: 'allow', reason: 'no goal to verify against — gate stays out of the way', targets };
  }
  if (skills.length === 0 && !isGoalAlignmentGateEnabled()) {
    return { action: 'allow', mode: 'allow', reason: 'no skill to verify against (alignment gate off) — gate stays out of the way', targets };
  }

  // 3a-ii. Batch-uniformity evidence (the emails class). Computed from the
  // tool_called ledger — NOT an auto-block (a legitimately-templated
  // announcement is identical too); the judge disambiguates with goal+skill.
  let evidence = '(none)';
  try {
    const shapeKey = classifyExternalWrite(toolName, rawArgs).shapeKey;
    const currentTarget = targets[0] ?? '';
    const currentRegion = personalizationRegion(extractMessageBody(rawArgs));
    const uni = detectBatchUniformity({
      currentTarget,
      currentRegion,
      priorSends: gatherPriorSameShapeSends(sessionId, toolName, shapeKey),
    });
    if (uni.uniform) {
      evidence = `This action's opening paragraph is BYTE-IDENTICAL to ${uni.peerTargets.length} prior same-shape send(s) this session to DISTINCT target(s) (e.g. ${uni.peerTargets.slice(0, 3).join(', ')}). If the loaded skill requires per-target research/personalization, that per-item step was likely skipped.`;
    }
  } catch { /* evidence stays '(none)' — fail toward allow */ }

  // 3b. Goal-fidelity judge — one fast fail-open call.
  let verdict: GoalFidelityVerdict;
  try {
    verdict = await (judgeOverride ?? runGoalFidelityJudge)({ goal, skills, payload: renderPayloadForJudge(toolName, rawArgs), evidence });
  } catch {
    return { action: 'allow', mode: 'judge', reason: 'goal-fidelity judge unavailable — fail open', targets };
  }

  const targetKey = targets[0] ?? skills[0]?.name ?? 'goal';
  if (verdict.fulfills) {
    failureCounts.delete(`${sessionId}::${targetKey}`);
    return { action: 'allow', mode: 'judge', reason: verdict.gap, targets };
  }

  // Goal-ALIGNMENT widening (skill-less): a fuzzy goal-alignment MISS must INFORM,
  // not hard-block (north-star: guardrails inform, rarely block — and live
  // 2026-06-22 a hard block false-positived a legit self-send to the user's own
  // other address). The send PROCEEDS; brackets records the verdict + surfaces it
  // for review. The skill-LOADED fidelity path below stays a hard block — that is
  // the validated per-item-requirement behavior (per-firm research, renderer skip).
  if (skills.length === 0) {
    failureCounts.delete(`${sessionId}::${targetKey}`);
    return { action: 'allow', mode: 'advisory', reason: verdict.gap, gap: verdict.gap, targets, blockKind: verdict.blockKind };
  }

  // Draft-only-skill block: the skill scoped itself out of sending (it drafts +
  // presents). This is NOT a fidelity FAILURE to escalate — it's an inform:
  // present the drafts and ask "good to send?". Don't bump the failure count
  // (so it never escalates to STOP) and tag the kind so the error message tells
  // the model to present-and-ask, not rebuild-and-retry. Still BLOCKS the send.
  const presentForApproval = verdict.blockKind === 'present_for_approval' && isGoalFidelityDraftInformEnabled();
  if (presentForApproval) {
    return {
      action: 'block',
      mode: 'judge',
      reason: verdict.gap,
      gap: verdict.gap,
      targets,
      blockKind: 'present_for_approval',
    };
  }

  const { failures, commitFailure } = recordFailure(sessionId, targetKey, deferCommit);
  return {
    action: 'block',
    mode: 'judge',
    reason: verdict.gap,
    gap: verdict.gap,
    targets,
    failureCount: failures,
    commitFailure,
    blockKind: 'other',
  };
}

/** Compute the would-be consecutive-failure count for (session,target). When
 *  defer is false (inline path) the increment is committed immediately and
 *  commitFailure is undefined — byte-identical to the old bumpFailure. When defer
 *  is true (parallel eager-start) NOTHING is persisted; the returned commitFailure
 *  thunk does the increment, and the caller invokes it only if it actually
 *  surfaces this block (integrity audit #2.4). */
function recordFailure(sessionId: string, target: string, defer: boolean): { failures: number; commitFailure?: () => void } {
  const key = `${sessionId}::${target}`;
  const next = (failureCounts.get(key) ?? 0) + 1;
  if (!defer) { failureCounts.set(key, next); return { failures: next }; }
  return { failures: next, commitFailure: () => failureCounts.set(key, next) };
}

/**
 * Thrown for a goal-fidelity failure. Surfaced to the model as a SOFT tool
 * error (same path as GroundingCheckFailedError) so it can recover — recall
 * the per-item research, rebuild from the verbatim source, run the skill's
 * producer — instead of the run aborting. After repeated failures it instructs
 * an explicit user check-in, per the operator contract: validate, loop until
 * valid, and when it still doesn't look right, come back to the user.
 */
export class GoalFidelityCheckFailedError extends Error {
  public readonly toolName: string;
  public readonly targets: string[];
  public readonly failureCount: number;
  public readonly blockKind: 'present_for_approval' | 'other';
  constructor(opts: { toolName: string; reason: string; gap?: string; targets: string[]; failureCount: number; blockKind?: 'present_for_approval' | 'other' }) {
    const blockKind = opts.blockKind ?? 'other';
    // Draft-only-skill block: the skill drafts + presents but does not itself
    // send. The recovery is NOT "rebuild and retry the write" (the old generic
    // suffix, which is meaningless here — there is no fixed payload to retry and
    // sending it is what the skill scoped out). It is: present the drafts to the
    // user and ASK. End the turn — don't hunt for another tool. This is the
    // inform-not-block path the user asked for: a draft-only block should hand
    // the drafts back, not crash or loop.
    const recovery = blockKind === 'present_for_approval'
      ? 'This is NOT a failure — the skill drafts and presents; it does not send. Do NOT retry this write and do NOT call another tool. PRESENT the drafted item(s) to the user as your reply now — show, per item, the To, Subject, Body and the research/insight used — then ask plainly "Good to send?" and END YOUR TURN. When the user confirms, send.'
      : (opts.failureCount >= 2
        ? 'This target has now failed goal-fidelity repeatedly — STOP. Do NOT retry the write. Use ask_user_question to show the user the gap and let them decide.'
        : 'Recover: honor the missed requirement before this write — recall the per-item research (recall_tool_result / re-read the source) and rebuild the payload from the VERBATIM source, or run the skill\'s producer script to generate the deliverable — then retry. Do not re-fire the same payload.');
    super(
      `GOAL_FIDELITY_CHECK_FAILED: this irreversible ${opts.toolName} does not yet honor the run's stated goal and the loaded skill's defining requirement. ` +
        `Gap: ${opts.gap ?? opts.reason} ` +
        recovery,
    );
    this.name = 'GoalFidelityCheckFailedError';
    this.toolName = opts.toolName;
    this.targets = opts.targets;
    this.failureCount = opts.failureCount;
    this.blockKind = blockKind;
  }
}
