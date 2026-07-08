import { Agent, Runner } from '@openai/agents';
import { MODELS } from '../../config.js';
import { codexSafeFast } from './model-roles.js';
import type { RuntimeContextValue } from '../../types.js';
import type { BoundaryJudgeRouting } from './debate-model.js';
import { recordJudgeMetric, withJudgeTimeout, type JudgeMetricOutcome } from './judge-family.js';

/**
 * Judge system prompt — modeled on OpenAI Codex's continuation.md auditor
 * pattern (Codex CLI 0.128.0, April 2026): "Do not accept proxy signals as
 * completion by themselves. Build an audit checklist mapping requirements →
 * verifiable evidence before marking done."
 *
 * Canonical home (goal-contract): the legacy /goal loop that originally
 * owned this prompt was deleted in Phase 3 — the goal-contract store +
 * harness validation (goal-validate.ts) replaced it.
 */
export const JUDGE_SYSTEM_PROMPT = [
  'You are a goal-completion judge. You receive (1) a user objective and (2) the most recent assistant response.',
  '',
  'Use an AUDIT CHECKLIST: enumerate the concrete, verifiable deliverables the objective implies, then check each one against the assistant\'s response.',
  '',
  'Rules:',
  '- A deliverable counts as complete only when the response contains VERIFIABLE EVIDENCE (a URL, a file path, a quoted result, an emitted artifact) — not a promise or summary of what was done.',
  '- Do NOT accept proxy signals (e.g. "I have updated the records", "task complete", "✓") as completion by themselves. Require the artifact or its output.',
  '- A plan, intention, or "I will work on this next" is NOT complete.',
  '- Partial completion of multiple deliverables is NOT complete unless the objective only asked for one.',
  '- HONEST BLOCKER: if the response delivers the results it COULD produce AND explicitly names the specific part it could not, with a concrete reason that part is genuinely blocked (a named tool/endpoint unavailable, a record/field that does not exist, access denied), treat that as DONE — do NOT demand it retry a capability that is genuinely unavailable. Mark not-done ONLY when the assistant could plausibly still finish with the tools it has (it punted, guessed, promised, or stopped without actually trying).',
  '- Audit ONLY the deliverables the objective actually names. Do NOT invent extra deliverables (an "audit artifact", a "decision document", a saved file) that the user never asked for — demanding unnamed artifacts trains the assistant to write filler evidence files instead of doing work.',
  '- If the objective is ambiguous or is a bare conversational follow-up, judge it against the conversation context included with it. When the response reports concrete completed work with evidence for everything the objective ACTUALLY names, that is done — in an interactive chat the user will steer the next step; do not keep the loop running to chase deliverables nobody requested.',
  '',
  'Reply with EXACTLY ONE LINE and nothing else, one of:',
  '  "DONE: <one short sentence naming the artifact/URL/result that satisfied the objective>";',
  '  "INCOMPLETE: <one short sentence naming the missing evidence>".',
  '',
  'Examples:',
  '  DONE: Spreadsheet created at /Users/me/Q3.xlsx with URL returned',
  '  INCOMPLETE: Assistant proposed steps but no artifact or URL was produced',
  '  INCOMPLETE: Two of three deliverables remain — emails drafted but no send confirmation evidence',
].join('\n');

/**
 * Independent objective-completion judge for the chat continuation loop.
 *
 * The harness loop already auto-continues until the ORCHESTRATOR declares
 * itself done (loop.ts). But LLMs over-declare completion — they answer "here
 * is what I'd do" or promise an artifact and stop. Hermes' edge is an
 * INDEPENDENT judge that verifies real evidence before yielding. This reuses
 * the same audit-checklist prompt as the /goal loop (JUDGE_SYSTEM_PROMPT) but
 * is invoked as a GATE on self-declared completion, so it FAILS OPEN: any
 * error / unparseable verdict resolves to done:true, so a flaky judge can
 * never wedge a turn that the model believes is finished.
 */

export interface ObjectiveJudgeVerdict {
  done: boolean;
  reason: string;
  /**
   * Verification PROVENANCE (Move 4 — defeat silent success). Callers surface
   * these so a "done" the user trusts is distinguishable from an ASSUMED done:
   * - failedOpen: the judge timed out / errored / didn't parse, so completion was
   *   ACCEPTED WITHOUT a real verdict (the silent-success risk made visible).
   * - selfJudge: graded by the SAME model family as the brain (no cross-family
   *   judge logged in) — a real verdict, but lower-confidence (model graded its
   *   own homework).
   * Absent ⇒ a clean cross-family verdict (full confidence).
   */
  failedOpen?: boolean;
  selfJudge?: boolean;
}

export interface ObjectiveJudgeGateInput {
  /** The chat caller opted in (workflow steps never do). */
  optIn: boolean;
  /** The objective classified as an explicit ACTION ("build/deploy/set up…"). */
  actionIntent: boolean;
  /** Tool calls made across the whole conversation so far. */
  totalToolCalls: number;
  /** A turn at/above this many tool calls did substantive multi-step work. */
  workThreshold: number;
  /** Independent judge continuations already spent this turn. */
  continuationsUsed: number;
  /** Hard cap on judge continuations. */
  maxContinuations: number;
  /** The orchestrator's self-declared next action. */
  nextAction: string;
  /**
   * The reply is a future-tense PROMISE of work ("I'll prep them…", "let me go
   * build that") with no evidence of an actual artifact/result. These are the
   * turns that look low-effort (non-action intent, few tool calls) and so used
   * to skip the judge — exactly the "chatbot" shape where Clem narrates intent
   * and marks itself done. Computed at the callsite from the reply text.
   */
  promiseShaped?: boolean;
}

/**
 * Whether to run the independent completion judge on a self-declared `done`.
 *
 * Gate on OBSERVED WORK, not phrasing. A turn that fired several tool calls did
 * real multi-step work and is worth verifying — even when the request reads as
 * a "lookup" ("find me the accounts and drop them in a sheet" classifies as
 * lookup but is multi-step action). The intent branch keeps the cheap path for
 * a clearly-phrased ACTION objective. A trivial lookup ("what's on my
 * calendar") stays below the work threshold and is never judged.
 *
 * PLUS: a PROMISE-SHAPED reply (future-tense intent, no artifact) is always
 * judged even when it looks low-effort — that is the precise turn where the
 * model says "I'll do that next" and completes without doing it. The judge's
 * own rubric rejects "a promise or plan", so running it forces a real artifact
 * or an honest blocker. Fail-open + bounded by maxContinuations, so a false
 * positive costs one cheap judge call, never a wedge.
 */
export function shouldRunObjectiveJudge(input: ObjectiveJudgeGateInput): boolean {
  return (
    input.optIn &&
    input.nextAction === 'completed' &&
    input.continuationsUsed < input.maxContinuations &&
    (input.actionIntent || input.totalToolCalls >= input.workThreshold || Boolean(input.promiseShaped))
  );
}

/**
 * Detect a future-tense PROMISE of work with no evidence of a produced artifact.
 * Pure + exported for tests. Future/deferral phrasing ("I'll…", "let me…",
 * "going to…", "let's…") with NO completion/artifact marker ("done", "created",
 * a URL, a path, "here's…"). The artifact whitelist suppresses false positives
 * on turns that actually delivered something. English-only (a backstop after the
 * existing observed-work gate, not the primary signal).
 */
const PROMISE_PHRASE_RE =
  /\b(?:i'?ll|i will|i'?m going to|i am going to|going to|about to|let me|let'?s|i can (?:now )?(?:go|start|begin|prep|put together|pull)|once you|next i'?ll|then i'?ll|i'?ll go (?:ahead|and))\b/i;
const ARTIFACT_EVIDENCE_RE =
  /\b(?:done|completed|finished|created|drafted|generated|saved|wrote|written|sent|posted|updated|added|attached|here'?s|here is|i'?ve (?:created|drafted|saved|sent|added|updated|built|put together)|https?:\/\/|\/[\w.-]+\/)/i;

export function isPromiseShapedReply(reply?: string | null): boolean {
  const text = (reply ?? '').trim();
  if (!text) return false;
  // Conversational alignment: "going forward I'll treat X as Y" is a durable
  // correction/acknowledgement, not a promise to perform this turn's work.
  if (/\b(?:going forward|from now on)\s+i'?ll\b/i.test(text)) return false;
  return PROMISE_PHRASE_RE.test(text) && !ARTIFACT_EVIDENCE_RE.test(text);
}

/** Harness-injected inputs recorded as user_input_received that are NOT real
 *  user messages — continuation drips, judge retries, prose-corrections,
 *  parse re-issues, grounding/YOLO/outcome re-prompts. Used to (a) filter
 *  conversation history when composing the judged objective, and (b) keep
 *  auto-memory from learning these as "user" facts (the 2026-06-23 pollution:
 *  judge/stall/grounding re-prompts were stored as pinned "Standing prohibition"
 *  facts injected into every chat + voice prompt). Every prefix is harness-
 *  unique — a real user message never starts with one. */
export const HARNESS_INJECTED_INPUT_PREFIXES = [
  'You hit a step / time budget on the previous turn and the user has now replied `continue`.',
  'Continue with the next step of your plan.',
  'You marked this objective complete,',
  'Your previous response was prose, not an action.',
  'Your previous response could not be parsed into the required structured decision',
  'You already auto-resolved that approval question under YOLO',
  'Before you deliver this:',
] as const;

export function isHarnessInjectedInput(text: string): boolean {
  const t = (text ?? '').trimStart();
  if (HARNESS_INJECTED_INPUT_PREFIXES.some((p) => t.startsWith(p))) return true;
  // Outcome-relay turns are injected with the durable `[<sourceLabel> <id> …]`
  // marker (outcome.ts outcomePrefix) — a report-back from a background/workflow
  // run, never a user message.
  if (/^\[(?:background|workflow|cron|execution|task|run)\b[^\]]{0,80}\]/i.test(t)) return true;
  return false;
}

/** Below this length, a user message is likely a bare follow-up ("just mine
 *  please", "lets do it") that is meaningless as a standalone objective. */
const BARE_FOLLOWUP_MAX_CHARS = 120;

/**
 * Compose the objective text the judge audits. A bare follow-up judged in
 * isolation is inherently "ambiguous" → the judge demands artifacts the
 * message never named → up to maxContinuations wasted full model turns per
 * message (live 2026-06-11: "just mine please" and "lets do it" each judged
 * as standalone objectives, 5 false NOT-finished retries in one session).
 * When the current input is short and real prior user messages exist, include
 * the recent priors so the judge audits what the USER actually asked for.
 * Pure — the caller gathers (and pre-filters) the prior messages.
 */
export function composeJudgedObjective(input: string, priorUserMessages: string[]): string {
  const current = (input ?? '').trim();
  if (current.length >= BARE_FOLLOWUP_MAX_CHARS) return current;
  const priors = priorUserMessages
    .map((m) => (m ?? '').trim())
    .filter((m) => m.length > 0 && !isHarnessInjectedInput(m))
    .slice(-2)
    .map((m) => (m.length > 600 ? `${m.slice(0, 600)}…` : m));
  if (priors.length === 0) return current;
  return [
    'Earlier user messages in this conversation (the follow-up below continues them):',
    ...priors.map((m, i) => `${i + 1}. ${m}`),
    '',
    `Current user message (the follow-up being judged): ${current}`,
  ].join('\n');
}

/** Optional skill-execution rubric: the skills loaded this session + compact
 *  evidence of what tools actually fired. When present, the judge verifies the
 *  agent EXECUTED the skill (produced its deliverables), not just read it. */
export interface SkillExecutionContext {
  skills: { name: string; body: string }[];
  toolCallSummary: string;
}

export type ObjectiveJudgeFn = (
  objective: string,
  assistantResponse: string,
  skillContext?: SkillExecutionContext,
) => Promise<ObjectiveJudgeVerdict>;

// PLAIN-TEXT verdict, parsed deterministically — same treatment the batch certify
// (2e10714e) and goal-fidelity (2538d916) judges got after structured output flaked
// live on the safety path. One line, two markers ("DONE:" / "INCOMPLETE:"), a regex:
// nothing left to reject a valid verdict on presentation. Returns null on no marker
// so each caller applies its OWN fail semantics (strict throws → not-passed; the
// interactive judge fails open → done:true), preserving both directions unchanged.
export function parseCompletionVerdict(finalOutput: unknown): { done: boolean; reason: string } | null {
  const raw = String(finalOutput ?? '').trim();
  const match = /^\s*(DONE|INCOMPLETE|NOT[- ]?DONE)\s*:?\s*(.*)$/im.exec(raw);
  if (!match) return null;
  return { done: match[1].toUpperCase() === 'DONE', reason: (match[2] || '').slice(0, 400) };
}

function buildJudgeAgent(routing?: BoundaryJudgeRouting): Agent<RuntimeContextValue> {
  return new Agent<RuntimeContextValue>({
    name: 'ObjectiveCompletionJudge',
    instructions: JUDGE_SYSTEM_PROMPT,
    // Cross-family boundary judge (avoids the brain self-grading); falls open to
    // the brain-family-safe cheap id when no different family is available (never a
    // repurposed BYO fast slot that would storm an unintended provider).
    model: routing?.model ?? routing?.modelId ?? codexSafeFast(),
    // A binary done/not-done verdict against an explicit rubric does not need
    // deep chain-of-thought — low reasoning effort cuts the largest chunk of
    // per-call latency on this hot path (the judge runs on most action turns).
    modelSettings: { reasoning: { effort: 'low' } },
    tools: [],
  });
}

function recordCompletionJudgeMetric(
  outcome: JudgeMetricOutcome,
  startedAt: number,
  routing?: BoundaryJudgeRouting,
): void {
  recordJudgeMetric({
    lane: 'completion',
    outcome,
    durationMs: Date.now() - startedAt,
    modelId: routing?.modelId,
    judgeFamily: routing?.judgeFamily,
    brainFamily: routing?.brainFamily,
    selfJudge: routing?.selfJudge,
  });
}

/** Binding cap on the response text shown to the completion judge. Above this
 *  we window the head AND tail (artifact evidence — a sheet URL, a file path, a
 *  send confirmation — clusters at the TAIL of a long multi-deliverable reply)
 *  and TELL the judge the middle was elided for length, so a self-inflicted cut
 *  is never misread as a genuinely incomplete deliverable → false done:false.
 *  Also the binding cap for the workflow target judge, which calls through here
 *  (workflow-objective-judge.ts pre-renders to MAX_DELIVERABLE_CHARS first). */
export const JUDGE_RESPONSE_MAX_CHARS = 8000;

/** Window a long body for a judge so the cut is self-describing. Returns the
 *  text unchanged when it fits. Head 65% / tail 35% — keep the bulk of the work
 *  while preserving the trailing artifact evidence the rubric looks for. */
export function clipForJudge(text: string, max = JUDGE_RESPONSE_MAX_CHARS): { text: string; truncated: boolean } {
  const t = text ?? '';
  if (t.length <= max) return { text: t, truncated: false };
  const head = Math.floor(max * 0.65);
  const tail = max - head;
  const omitted = t.length - max;
  const windowed = `${t.slice(0, head)}\n\n…[${omitted} chars elided from the MIDDLE for length — the response is longer and may be COMPLETE]…\n\n${t.slice(t.length - tail)}`;
  return { text: windowed, truncated: true };
}

export function buildObjectiveJudgePrompt(
  objective: string,
  assistantResponse: string,
  skillContext?: SkillExecutionContext,
): string {
  const shown = clipForJudge(assistantResponse, JUDGE_RESPONSE_MAX_CHARS);
  const parts = [
    `Objective: ${objective}`,
    '',
    shown.truncated
      ? "Assistant's most recent response (LONG — windowed to its head and tail with the middle elided for length; judge ONLY what is visible and do NOT mark the objective incomplete merely because an expected deliverable might fall in the omitted middle):"
      : "Assistant's most recent response:",
    shown.text,
  ];
  // Tool-call evidence — surface it whenever we have it, EVEN with no skill
  // loaded. The judge audits an ACTION objective ("build/deploy X"); without the
  // list of tools that actually fired it sees only the prose reply and can
  // hallucinate a missing deliverable on a genuinely-finished run. Suppressed
  // for zero-tool turns so a bare promise still shows no evidence (the judge
  // correctly demands the artifact).
  const toolSummary = skillContext?.toolCallSummary?.trim();
  if (toolSummary && toolSummary !== '(no tool calls made)') {
    parts.push(
      '',
      `Tool calls made this session (evidence the work actually ran — corroborates the reply, but the response must still contain the artifact/URL the objective named): ${toolSummary}`,
    );
  }
  if (skillContext && skillContext.skills.length > 0) {
    parts.push(
      '',
      '=== SKILLS LOADED THIS SESSION — verify they were EXECUTED, not just read ===',
      'A loaded skill is a procedure the assistant committed to run. For EACH skill below, check the assistant actually carried out its prescribed steps and produced its deliverables (a file, image, URL, record, deploy). Use the tool-call evidence above: if a skill clearly prescribes a step (e.g. generate imagery, run a bundled script, create a file) and the evidence shows that step was NOT done, the objective is NOT done — set done=false and name the specific skipped step. A pure-advice/persona skill with no concrete deliverables has nothing to enforce.',
      ...skillContext.skills.map((s) => `\n--- skill: ${s.name} (first 5000 chars) ---\n${s.body.slice(0, 5000)}`),
    );
  }
  parts.push('', 'Audit it against the objective and respond with the structured verdict.');
  return parts.join('\n');
}

/**
 * STRICT judge variant (goal-contract Phase 1): same audit-checklist judge,
 * but infra failures THROW instead of resolving to done. Goal validation
 * fails open in the OPPOSITE direction from the chat gate — a dead judge
 * must never auto-satisfy a parked goal — so the caller (goal-validate.ts)
 * catches the throw and resolves to not-passed + judgeFailedOpen.
 */
export async function judgeObjectiveCompleteStrict(
  objective: string,
  assistantResponse: string,
  skillContext?: SkillExecutionContext,
): Promise<ObjectiveJudgeVerdict> {
  if (!objective.trim() || !assistantResponse.trim()) {
    throw new Error('insufficient text to judge');
  }
  const startedAt = Date.now();
  let routing: BoundaryJudgeRouting | undefined;
  let recorded = false;
  const record = (outcome: JudgeMetricOutcome) => {
    recorded = true;
    recordCompletionJudgeMetric(outcome, startedAt, routing);
  };
  try {
    const { resolveBoundaryJudge } = await import('./debate-model.js');
    routing = resolveBoundaryJudge();
    const runner = new Runner({ workflowName: 'clementine-objective-judge' });
    const result = await withJudgeTimeout(
      runner.run(buildJudgeAgent(routing), buildObjectiveJudgePrompt(objective, assistantResponse, skillContext), {
        maxTurns: 1,
      }),
    );
    if (!result) {
      record('timeout');
      throw new Error('judge timed out');
    }
    const verdict = parseCompletionVerdict(result.finalOutput);
    if (!verdict) {
      record('invalid');
      throw new Error('judge output did not parse');
    }
    record(verdict.done ? 'passed' : 'blocked');
    return { done: verdict.done, reason: verdict.reason };
  } catch (err) {
    if (!recorded) record('error');
    throw err;
  }
}

/**
 * Judge whether the objective is genuinely complete given the assistant's most
 * recent response. FAILS OPEN (done:true) on any error so completion is never
 * blocked by a judge hiccup.
 */
export async function judgeObjectiveComplete(
  objective: string,
  assistantResponse: string,
  skillContext?: SkillExecutionContext,
): Promise<ObjectiveJudgeVerdict> {
  if (!objective.trim() || !assistantResponse.trim()) {
    return { done: true, reason: 'insufficient text to judge — accepting completion' };
  }
  const startedAt = Date.now();
  let routing: BoundaryJudgeRouting | undefined;
  let recorded = false;
  const record = (outcome: JudgeMetricOutcome) => {
    recorded = true;
    recordCompletionJudgeMetric(outcome, startedAt, routing);
  };
  try {
    const { resolveBoundaryJudge } = await import('./debate-model.js');
    routing = resolveBoundaryJudge();
    const runner = new Runner({ workflowName: 'clementine-objective-judge' });
    const result = await withJudgeTimeout(
      runner.run(buildJudgeAgent(routing), buildObjectiveJudgePrompt(objective, assistantResponse, skillContext), {
        maxTurns: 1,
      }),
    );
    if (!result) {
      record('timeout');
      return { done: true, reason: 'judge timed out — accepting completion', failedOpen: true };
    }
    const verdict = parseCompletionVerdict(result.finalOutput);
    if (!verdict) {
      record('invalid');
      return { done: true, reason: 'judge output did not parse — accepting completion', failedOpen: true };
    }
    record(verdict.done ? 'passed' : 'blocked');
    return { done: verdict.done, reason: verdict.reason, selfJudge: routing?.selfJudge === true };
  } catch {
    if (!recorded) record('error');
    return { done: true, reason: 'judge unavailable — accepting completion', failedOpen: true };
  }
}
