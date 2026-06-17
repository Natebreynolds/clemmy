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

// ─────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────

export function isGoalFidelityGateEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_GOAL_FIDELITY_GATE', 'on') ?? 'on').toLowerCase();
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
  const [{ Agent, Runner }, { z }, { MODELS }, { normalizeZodForCodexStrict }] = await Promise.all([
    import('@openai/agents'),
    import('zod'),
    import('../../config.js'),
    import('../schema-normalizer.js'),
  ]);
  const VerdictSchema = z.object({
    fulfills: z.boolean().describe('False ONLY on a concrete, nameable gap between this action and the goal\'s intent or the skill\'s defining requirement. Vague/style/uncertain → true (fail open).'),
    gap: z.string().describe('One short sentence: the single specific gap and the concrete recovery, or why the action is faithful.'),
    blockKind: z.enum(['present_for_approval', 'other']).describe('When fulfills=false: "present_for_approval" if the ONLY gap is that the loaded skill is draft-only — it says "does not send" / "present for approval" / "never claim the email was sent" (that is the skill\'s SCOPE, NOT a ban on the user sending the approved draft). Use "other" for a genuine violation (wrong/byte-identical target, off-goal, un-rendered artifact, per-item research skipped). When fulfills=true, use "other".'),
  });
  const agent = new Agent({
    name: 'GoalFidelityJudge',
    instructions: 'Verify an about-to-fire irreversible external action against the run\'s goal and the loaded skill\'s defining requirement. Output only the structured verdict.',
    model: MODELS.fast,
    // Binary verdict against an explicit rubric — low reasoning effort trims the
    // largest chunk of per-call latency on this hot path (same as the
    // completion judge).
    modelSettings: { reasoning: { effort: 'low' } },
    outputType: normalizeZodForCodexStrict(VerdictSchema) as typeof VerdictSchema,
    tools: [],
  });
  const runner = new Runner({ workflowName: 'clementine-goal-fidelity-judge' });
  const result = await runner.run(agent, buildGoalFidelityPrompt(input), { maxTurns: 1 });
  const parsed = VerdictSchema.safeParse(result.finalOutput);
  if (!parsed.success) throw new Error('goal-fidelity judge output did not parse');
  return parsed.data;
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
  /** How the verdict was reached (telemetry / tests). */
  mode: 'renderer' | 'judge' | 'allow';
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
}

/**
 * Evaluate goal-fidelity for an irreversible external write. Fail-open at
 * every step: no goal / no skill / judge error → allow.
 */
export async function evaluateGoalFidelity(
  sessionId: string,
  toolName: string,
  rawArgs: unknown,
): Promise<GoalFidelityGateResult> {
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
      const failures = bumpFailure(sessionId, targets[0] ?? skill.name);
      return {
        action: 'block',
        mode: 'renderer',
        skill: gap.skill,
        reason: `the ${gap.skill} skill prescribes a producer script (${gap.prescribed.join(', ')}) but it never ran this session — the deliverable was not generated by the skill`,
        gap: `Run the ${gap.skill} skill's producer (${gap.prescribed.join(', ')}) to GENERATE the deliverable, then retry this write. Do not hand-roll what the skill is meant to produce.`,
        targets,
        failureCount: failures,
      };
    }
  }

  // 3a-iii. Nothing to check: with no goal AND no enforceable skill there is
  // nothing to verify against → allow, skip the judge (the §3 latency floor:
  // never add an unconditional second judge call).
  const goal = gatherGoalText(sessionId);
  if (!goal || skills.length === 0) {
    return { action: 'allow', mode: 'allow', reason: 'no goal + skill to verify against — gate stays out of the way', targets };
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

  const failures = bumpFailure(sessionId, targetKey);
  return {
    action: 'block',
    mode: 'judge',
    reason: verdict.gap,
    gap: verdict.gap,
    targets,
    failureCount: failures,
    blockKind: 'other',
  };
}

function bumpFailure(sessionId: string, target: string): number {
  const key = `${sessionId}::${target}`;
  const next = (failureCounts.get(key) ?? 0) + 1;
  failureCounts.set(key, next);
  return next;
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
