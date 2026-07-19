import { Agent, Runner } from '@openai/agents';
import { MODELS } from '../../config.js';
import { codexSafeFast } from './model-roles.js';
import type { RuntimeContextValue } from '../../types.js';
import type { BoundaryJudgeRouting } from './debate-model.js';
import { recordJudgeMetric, withJudgeHedge, type JudgeMetricLane, type JudgeMetricOutcome } from './judge-family.js';
import { extractJsonCandidate } from './json-repair.js';

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
  '- A deliverable counts as complete only when the response contains VERIFIABLE EVIDENCE — the concrete result itself, its quoted output, or a pointer to the produced artifact — not a promise or summary of what was done.',
  '- Evidence takes WHATEVER FORM the objective implies. Demand a link, file, or record only when the objective itself calls for one; for a question, analysis, or plan the answer in the response IS the deliverable. NEVER mark the objective incomplete for lacking a URL or file it never asked for.',
  '- Do NOT accept proxy signals (e.g. "I have updated the records", "task complete", "✓") as completion by themselves. Require the artifact or its output.',
  '- A plan, intention, or "I will work on this next" is NOT complete.',
  '- Partial completion of multiple deliverables is NOT complete unless the objective only asked for one.',
  '- HONEST BLOCKER: if the response delivers the results it COULD produce AND explicitly names the specific part it could not, with a concrete reason that part is genuinely blocked (a named tool/endpoint unavailable, a record/field that does not exist, access denied), treat that as DONE — do NOT demand it retry a capability that is genuinely unavailable. Mark not-done ONLY when the assistant could plausibly still finish with the tools it has (it punted, guessed, promised, or stopped without actually trying).',
  '- Audit ONLY the deliverables the objective actually names. Do NOT invent extra deliverables (an "audit artifact", a "decision document", a saved file) that the user never asked for — demanding unnamed artifacts trains the assistant to write filler evidence files instead of doing work.',
  '- If the objective is ambiguous or is a bare conversational follow-up, judge it against the conversation context included with it. When the response reports concrete completed work with evidence for everything the objective ACTUALLY names, that is done — in an interactive chat the user will steer the next step; do not keep the loop running to chase deliverables nobody requested.',
  '- AWAITING THE USER: if the response asks the user a genuine direction or authorization question — which option to take, whether to proceed with an external action (sending, posting, deleting), or scope the objective left open — that question IS this turn\'s deliverable. The assistant must NOT take consequential external actions without the user\'s go-ahead, so demanding it "finish" instead of asking would be wrong. This includes an honest partial-progress report that pauses for the user\'s decision.',
  '',
  'Reply with EXACTLY ONE LINE and nothing else, one of:',
  '  "DONE: <one short sentence naming the artifact/URL/result that satisfied the objective>";',
  '  "AWAITING: <one short sentence naming the decision the user was asked to make>";',
  '  "INCOMPLETE: <one short sentence naming the missing evidence>".',
  '',
  'Examples:',
  '  DONE: Spreadsheet created at /Users/me/Q3.xlsx with URL returned',
  '  DONE: The requested analysis is fully present in the response with its supporting figures',
  '  AWAITING: Assistant asked whether to send the 55 prepared emails now or review them first',
  '  INCOMPLETE: Assistant proposed steps but did not produce the deliverable the objective named',
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
  /**
   * The judge ruled the turn's deliverable is a genuine direction/authorization
   * question to the user (AWAITING verdict). Treated as done for bounce purposes;
   * the caller should yield the turn as awaiting_user_input, never continue past
   * the question (ask-first batch regression: a bounced approval question became 10 unapproved
   * emails).
   */
  awaitingUser?: boolean;
}

export interface ObjectiveJudgeGateInput {
  /** The chat caller opted in (workflow steps never do). */
  optIn: boolean;
  /** The objective classified as an explicit ACTION ("build/deploy/set up…"). */
  actionIntent: boolean;
  /** Tool calls made across the whole conversation so far. */
  meaningfulToolEvidence: boolean;
  /** A batch/compound objective cannot be certified by one successful tool. */
  multiResultObjective?: boolean;
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
  /**
   * An approval card is OPEN for this session (THE-GRANT Phase 1, structural
   * question-immunity): the run is legitimately waiting on the human's card
   * decision — judging "did the work finish" while their decision is pending
   * is what scolded a parked ask into unapproved sends (Exhibit A). The judge
   * NEVER fires while a card is open.
   */
  openApprovalCard?: boolean;
}

/**
 * Whether to run the independent completion judge on a self-declared `done`.
 *
 * The judge is a recovery path for suspicious TEXT, not a second execution
 * controller. A concrete completion backed by real tool calls already has
 * durable evidence and must not be bounced into repeating those tools. A
 * zero-tool ACTION claim still needs proof.
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
    !input.openApprovalCard &&
    input.continuationsUsed < input.maxContinuations &&
    (Boolean(input.promiseShaped)
      || (input.actionIntent && (!input.meaningfulToolEvidence || Boolean(input.multiResultObjective))))
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
  // Restart-recovery auto-resume directive (restart-recovery.ts
  // AUTO_RESUME_DIRECTIVE) — dispatched as the resumed session's input, never
  // typed by the user. Without this entry, later bare follow-ups in a resumed
  // session compose the directive into the judged objective, and auto-memory
  // can learn it as a "user" fact.
  'The previous run in this session was interrupted by a daemon restart and has been automatically resumed.',
  // Background-task resume wrapper (background-tasks.ts) — "Resume background
  // task bg-… Original request: …" is a harness-dispatched continuation, never
  // a user message (the ORIGINAL request inside it is the real objective).
  'Resume background task ',
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
export function parseCompletionVerdict(finalOutput: unknown): { done: boolean; reason: string; awaitingUser?: boolean } | null {
  if (isRecord(finalOutput)) return parseCompletionObject(finalOutput);
  const raw = String(finalOutput ?? '').trim();
  const match = /^\s*(DONE|AWAITING|INCOMPLETE|NOT[- ]?DONE)\b(?:\s*[:\-]\s*|\s+)?(.*)$/im.exec(raw);
  if (match) {
    const marker = match[1].toUpperCase();
    const reason = (match[2] || '').trim().slice(0, 400);
    // AWAITING = the deliverable is a question to the user. Done for bounce
    // purposes (never scold-continue past it); the caller yields awaiting-user.
    if (marker === 'AWAITING') return { done: true, awaitingUser: true, reason };
    return { done: marker === 'DONE', reason };
  }
  const json = extractJsonCandidate(raw);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return isRecord(parsed) ? parseCompletionObject(parsed) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCompletionBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '-');
  if (/^(true|yes|done|complete|completed|pass|passed|met)$/.test(normalized)) return true;
  if (/^(false|no|incomplete|not-done|not-complete|not-completed|fail|failed|unmet)$/.test(normalized)) return false;
  return null;
}

function parseCompletionObject(obj: Record<string, unknown>): { done: boolean; reason: string } | null {
  let done = parseCompletionBool(obj.done ?? obj.complete ?? obj.completed ?? obj.pass ?? obj.passed);
  if (done === null) {
    done = parseCompletionBool(obj.verdict ?? obj.status ?? obj.result ?? obj.kind);
  }
  if (done === null) return null;
  const rawReason = obj.reason ?? obj.rationale ?? obj.explanation ?? obj.missing ?? obj.evidence ?? obj.summary;
  const reason = typeof rawReason === 'string' && rawReason.trim()
    ? rawReason.trim().slice(0, 400)
    : done ? 'objective satisfied' : 'objective missing required evidence';
  return { done, reason };
}

function buildJudgeAgent(routing?: BoundaryJudgeRouting, instructions: string = JUDGE_SYSTEM_PROMPT): Agent<RuntimeContextValue> {
  return new Agent<RuntimeContextValue>({
    name: 'ObjectiveCompletionJudge',
    instructions,
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
  lane: JudgeMetricLane = 'completion',
): void {
  recordJudgeMetric({
    lane,
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
  parts.push('', 'Audit it against the objective and respond with exactly one verdict line.');
  return parts.join('\n');
}

/** Thrown by an attempt whose model answered but off-contract — classified
 *  'invalid' (vs transport 'error') in the metric lane. */
class JudgeVerdictParseError extends Error {}

interface CompletionJudgeRun {
  /** Parsed verdict from the first attempt to answer, or null. */
  verdict: { done: boolean; reason: string; awaitingUser?: boolean } | null;
  /** null-verdict cause for metrics/fail semantics: pure deadline miss vs
   *  parse failure vs transport error. */
  failure: 'timeout' | 'invalid' | 'error' | null;
  /** The winning attempt's routing (primary routing when nothing won). */
  routing?: BoundaryJudgeRouting;
}

/**
 * One HEDGED judge run — the shared engine for every completion-lane verdict
 * shape. The primary cross-family judge starts immediately; if it hasn't
 * answered by the hedge delay (or dies first), a cheap judge from the other
 * flagship family races it, and the first PARSED value wins (judge-family.ts).
 * Metrics record the winner's model/family, so a hedge win is visible in
 * telemetry. Parametrized on (instructions, prompt, parse, lane) so the
 * one-line DONE/INCOMPLETE judge, the per-criterion checklist judge, and the
 * trajectory watcher share routing, hedging, metrics, and failure taxonomy
 * instead of forking them. Exported for the watcher (watcher-judge.ts).
 */
export async function runHedgedJudge<T>(
  instructions: string,
  prompt: string,
  parse: (finalOutput: unknown) => T | null,
  isPass: (value: T) => boolean,
  lane: JudgeMetricLane = 'completion',
): Promise<{ value: T | null; failure: 'timeout' | 'invalid' | 'error' | null; routing?: BoundaryJudgeRouting }> {
  const startedAt = Date.now();
  let routing: BoundaryJudgeRouting | undefined;
  try {
    const { resolveBoundaryJudge, resolveBoundaryJudgeHedge } = await import('./debate-model.js');
    routing = resolveBoundaryJudge();
    const hedgeRouting = resolveBoundaryJudgeHedge(routing);
    const attempt = (r: BoundaryJudgeRouting) => async () => {
      const runner = new Runner({ workflowName: 'clementine-objective-judge' });
      const result = await runner.run(buildJudgeAgent(r, instructions), prompt, { maxTurns: 1 });
      const value = parse(result.finalOutput);
      if (value === null) throw new JudgeVerdictParseError('judge output did not parse');
      return value;
    };
    const raced = await withJudgeHedge(attempt(routing), hedgeRouting ? attempt(hedgeRouting) : null);
    const winner = raced.winner === 'hedge' && hedgeRouting ? hedgeRouting : routing;
    if (raced.value !== null) {
      recordCompletionJudgeMetric(isPass(raced.value) ? 'passed' : 'blocked', startedAt, winner, lane);
      return { value: raced.value, failure: null, routing: winner };
    }
    const failure =
      raced.errors.length === 0
        ? 'timeout'
        : raced.errors.some((e) => e instanceof JudgeVerdictParseError)
          ? 'invalid'
          : 'error';
    recordCompletionJudgeMetric(failure, startedAt, routing, lane);
    return { value: null, failure, routing };
  } catch (err) {
    recordCompletionJudgeMetric('error', startedAt, routing, lane);
    logDebugSafe(err);
    return { value: null, failure: 'error', routing };
  }
}

async function runCompletionJudge(
  objective: string,
  assistantResponse: string,
  skillContext?: SkillExecutionContext,
): Promise<CompletionJudgeRun> {
  const run = await runHedgedJudge(
    JUDGE_SYSTEM_PROMPT,
    buildObjectiveJudgePrompt(objective, assistantResponse, skillContext),
    parseCompletionVerdict,
    (v) => v.done,
  );
  return { verdict: run.value, failure: run.failure, routing: run.routing };
}

/** Swallow-with-trace: the judge lanes are fail-open/fail-strict by CONTRACT,
 *  but a resolver bug should still be visible in debug logs. */
function logDebugSafe(err: unknown): void {
  try {
    // eslint-disable-next-line no-console
    if (process.env.CLEMMY_DEBUG) console.error('[objective-judge]', err instanceof Error ? err.message : err);
  } catch {
    /* never throws */
  }
}

// ─────────────────────────────────────────────────────────────────
// Per-criterion checklist judge — real granularity for goal contracts.
//
// validateGoal used to send all fuzzy criteria in one call and stamp the
// single DONE/INCOMPLETE on EVERY criterion — successRatePercent had fake
// granularity (all fuzzy criteria passed or failed together), and a run that
// met 4 of 5 criteria scored 0% on the fuzzy set. Same ONE call, but the
// judge now audits each criterion individually and answers one line per
// criterion; the parser is all-or-nothing (a partial listing throws →
// retry/hedge → caller's fail-strict semantics), so granularity is never
// silently degraded.
// ─────────────────────────────────────────────────────────────────

export const CRITERIA_JUDGE_SYSTEM_PROMPT = [
  'You are a goal-completion judge. You receive (1) a user objective, (2) a NUMBERED list of success criteria, and (3) the assistant\'s evidence.',
  '',
  'Audit EACH criterion INDIVIDUALLY against the evidence.',
  '',
  'Rules (apply to every criterion):',
  '- A criterion counts as MET only when the evidence contains VERIFIABLE proof — the concrete result itself, its quoted output, or a pointer to the produced artifact — not a promise or summary of what was done.',
  '- Proof takes WHATEVER FORM the criterion implies. Demand a link, file, or record only when the criterion itself calls for one; NEVER mark a criterion UNMET for lacking a URL or file it never asked for.',
  '- Do NOT accept proxy signals ("I have updated the records", "task complete", "✓") as completion by themselves.',
  '- A plan, intention, or "I will work on this next" is NOT met.',
  '- HONEST BLOCKER: if the evidence explicitly names why this specific criterion is genuinely blocked (a named tool/endpoint unavailable, a record that does not exist, access denied), treat it as MET rather than demanding a retry of an unavailable capability.',
  '- Judge ONLY the listed criteria. Do not invent extra requirements.',
  '',
  'Reply with EXACTLY ONE LINE PER CRITERION, in order, numbered to match, and nothing else:',
  '  "<n>: MET: <short evidence>" or "<n>: UNMET: <short missing piece>".',
  '',
  'Example for 3 criteria:',
  '  1: MET: spreadsheet URL present in the reply',
  '  2: UNMET: no send confirmation for the second email',
  '  3: MET: file path /tmp/report.pdf quoted with contents summary',
].join('\n');

export interface CriterionJudgeVerdict {
  pass: boolean;
  note: string;
}

/** Parse the per-criterion judge reply. ALL-OR-NOTHING: unless every one of the
 *  `count` criteria has a parsed line, returns null (→ the attempt is 'invalid'
 *  and the hedge/retry path takes over) — granularity is never silently partial. */
export function parseCriteriaVerdicts(finalOutput: unknown, count: number): CriterionJudgeVerdict[] | null {
  const raw = String(finalOutput ?? '').trim();
  if (!raw || count <= 0) return null;
  const verdicts = new Map<number, CriterionJudgeVerdict>();
  const re = /^\s*(\d{1,3})\s*[:.)\-]\s*(MET|UNMET|PASS|FAIL|DONE|INCOMPLETE)\b\s*[:—–-]?\s*(.*)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const idx = Number.parseInt(m[1], 10);
    if (idx < 1 || idx > count || verdicts.has(idx)) continue;
    verdicts.set(idx, { pass: /^(MET|PASS|DONE)$/i.test(m[2]), note: (m[3] || '').slice(0, 300) });
  }
  if (verdicts.size !== count) return null;
  return Array.from({ length: count }, (_, i) => verdicts.get(i + 1) as CriterionJudgeVerdict);
}

/**
 * STRICT per-criterion checklist judge: ONE hedged model call, one verdict per
 * criterion. Throws on infra failure exactly like judgeObjectiveCompleteStrict
 * (goal validation must fail toward not-passed, never auto-satisfy).
 */
export async function judgeGoalCriteriaStrict(
  objective: string,
  criteria: string[],
  evidenceText: string,
): Promise<CriterionJudgeVerdict[]> {
  const list = criteria.map((c) => c.trim()).filter((c) => c.length > 0);
  if (list.length === 0 || !evidenceText.trim()) {
    throw new Error('insufficient text to judge');
  }
  const shown = clipForJudge(evidenceText, JUDGE_RESPONSE_MAX_CHARS);
  const prompt = [
    `Objective: ${objective}`,
    '',
    'Success criteria to audit individually:',
    ...list.map((c, i) => `${i + 1}. ${c}`),
    '',
    shown.truncated
      ? "Assistant's evidence (LONG — windowed to its head and tail with the middle elided for length; judge ONLY what is visible and do NOT mark a criterion UNMET merely because its proof might fall in the omitted middle):"
      : "Assistant's evidence:",
    shown.text,
    '',
    `Audit each criterion and reply with exactly ${list.length} numbered lines as instructed.`,
  ].join('\n');
  const run = await runHedgedJudge(
    CRITERIA_JUDGE_SYSTEM_PROMPT,
    prompt,
    (o) => parseCriteriaVerdicts(o, list.length),
    (v) => v.every((x) => x.pass),
  );
  if (!run.value) {
    throw new Error(
      run.failure === 'timeout' ? 'judge timed out' : run.failure === 'invalid' ? 'judge output did not parse' : 'judge unavailable',
    );
  }
  return run.value;
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
  const run = await runCompletionJudge(objective, assistantResponse, skillContext);
  if (!run.verdict) {
    throw new Error(
      run.failure === 'timeout' ? 'judge timed out' : run.failure === 'invalid' ? 'judge output did not parse' : 'judge unavailable',
    );
  }
  return { done: run.verdict.done, reason: run.verdict.reason, ...(run.verdict.awaitingUser ? { awaitingUser: true } : {}) };
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
  const run = await runCompletionJudge(objective, assistantResponse, skillContext);
  if (!run.verdict) {
    const why =
      run.failure === 'timeout'
        ? 'judge timed out — accepting completion'
        : run.failure === 'invalid'
          ? 'judge output did not parse — accepting completion'
          : 'judge unavailable — accepting completion';
    return { done: true, reason: why, failedOpen: true };
  }
  return {
    done: run.verdict.done,
    reason: run.verdict.reason,
    selfJudge: run.routing?.selfJudge === true,
    ...(run.verdict.awaitingUser ? { awaitingUser: true } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────
// PROGRESS judge (Wave 3) — should a background run that hit its turn budget
// without finishing be GRANTED MORE compute to keep going unattended, or is it
// STUCK and should park for a human? Cross-family + hedged (reuses the Wave-1
// boundary-judge infra). Deliberately FAIL-CLOSED at the call site: uncertain /
// unavailable / unparseable ⇒ NOT progressing ⇒ park, so a judge hiccup can never
// grant a runaway more budget. The absolute wall-clock + a hard continue ceiling
// bound it regardless of this verdict.
// ─────────────────────────────────────────────────────────────────

const PROGRESS_JUDGE_SYSTEM_PROMPT = [
  'You decide whether a long-running AUTONOMOUS background run should be granted MORE turns to finish unattended, or STOPPED because it is stuck.',
  'The run hit an internal turn budget WITHOUT finishing its objective.',
  '',
  'Answer PROGRESS only when the run is making GENUINE forward progress toward the DELIVERABLE — new results, new artifacts, advancing coverage, each cycle moving closer to done.',
  'Answer STUCK when it is looping, repeating the same actions, thrashing, producing no new results, blocked on the same error, or drifting off the objective.',
  'Activity alone is NOT progress: many tool calls that repeat or do not advance the objective are STUCK.',
  'When UNCERTAIN, answer STUCK — stopping is safe (the user can resume); granting a stuck run more budget wastes it.',
  '',
  'Reply with EXACTLY ONE LINE: "PROGRESS: <short reason>" or "STUCK: <short reason>".',
].join('\n');

export interface RunProgressVerdict { progressing: boolean; reason: string }

// Parse ONLY the contract the prompt demands — a line that STARTS with the
// marker followed by a ":"/"-" delimiter ("PROGRESS: <reason>" / "STUCK:
// <reason>"). The earlier version scanned the whole blob for the FIRST of a wide
// synonym set (PROGRESS|STUCK|PROGRESSING|CONTINUE|STOP|PARK) with /is and NO
// anchor, so a STUCK verdict whose prose merely OPENED with the word "progress"
// ("No forward progress — STUCK: looping", "Progress toward the objective is
// minimal; the run is stuck.") matched the lowercase "progress" first and parsed
// as PROGRESSING — GRANTING a stuck run more unattended compute and inverting
// this gate's fail-CLOSED guarantee (caught by the Wave-3 adversarial review).
// Now, fail CLOSED by construction: (1) the marker must be line-anchored +
// delimiter-gated, so prose that opens with "progress" is never a verdict;
// (2) STUCK dominates — a STUCK marker line, OR any "stuck/thrash/loop/no
// progress" signal anywhere, forces progressing:false; (3) no clean anchored
// PROGRESS marker ⇒ null ⇒ the caller parks. Erring toward park is correct per
// the contract ("when uncertain, park; the user can resume"), so the rare cost
// is a genuine-progress reply that mentions "stuck" being parked, never a stuck
// run being granted more budget.
export function parseProgressVerdict(finalOutput: unknown): RunProgressVerdict | null {
  const raw = String(finalOutput ?? '').trim();
  if (!raw) return null;
  const stuckSignal = /\b(?:stuck|thrash(?:ing)?|looping|no (?:new |forward )?progress)\b/i.test(raw);
  let progressReason: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(PROGRESS|PROGRESSING|STUCK)\s*[:\-]\s*(.*)$/i.exec(line.trim());
    if (!m) continue;
    const reason = (m[2] || '').trim().slice(0, 300);
    if (m[1].toUpperCase() === 'STUCK') return { progressing: false, reason: reason || 'stuck' };
    if (progressReason === null) progressReason = reason;
  }
  if (stuckSignal) return { progressing: false, reason: 'stuck signal in verdict' };
  if (progressReason !== null) return { progressing: true, reason: progressReason };
  return null;
}

/** Cross-family progress judge for a budget-exhausted background run. Returns the
 *  verdict (or null on timeout/invalid/error — the caller treats null as NOT
 *  progressing / park). */
export async function judgeRunProgress(
  objective: string,
  recentActivity: string,
  toolCount: number,
): Promise<{ verdict: RunProgressVerdict | null; failure: 'timeout' | 'invalid' | 'error' | null; selfJudge: boolean }> {
  if (!objective.trim()) return { verdict: null, failure: 'invalid', selfJudge: false };
  const prompt = [
    `OBJECTIVE:\n${objective.trim().slice(0, 2000)}`,
    '',
    `The run hit its turn budget without finishing. In the last budget cycle it made ${Math.max(0, toolCount)} tool call(s).`,
    'Its most recent output / activity:',
    (recentActivity || '(no output captured)').slice(0, 4000),
    '',
    'Is it making genuine forward progress toward the objective, or stuck?',
  ].join('\n');
  const run = await runHedgedJudge(PROGRESS_JUDGE_SYSTEM_PROMPT, prompt, parseProgressVerdict, (v) => v.progressing);
  return { verdict: run.value, failure: run.failure, selfJudge: run.routing?.selfJudge === true };
}

/**
 * Deterministic detector for a DIRECTION-SEEKING question — a reply whose
 * closing move asks the user to choose, confirm, or authorize the next step.
 * Deliberately narrower than "ends with a question mark": a polite "anything
 * else?" tail does not count; "do you want me to send the 55 emails?" does.
 * Pure + exported for tests. Used by the loop's ask-first invariant to convert
 * a completed-tagged question turn into awaiting_user_input BEFORE the
 * completion judge can bounce it (ask-first batch regression: that bounce escalated a
 * permission question into unapproved sends).
 */
const DIRECTION_QUESTION_RE = new RegExp(
  [
    String.raw`\b(?:do|would|should|shall|can|could)\s+(?:you|i|we)\b[^?]{0,200}\?`,
    String.raw`\bwant\s+me\s+to\b[^?]{0,200}\?`,
    String.raw`\bwould\s+you\s+like\b[^?]{0,200}\?`,
    String.raw`\b(?:which|what)\s+(?:one|option|approach|order|account|list|version)\b[^?]{0,200}\?`,
    String.raw`\b(?:confirm|approve|authorize|green[- ]?light|go[- ]?ahead)\b[^?]{0,200}\?`,
    String.raw`\b(?:proceed|continue|resume|send|post|publish|delete)\b[^?]{0,120}\?`,
    String.raw`\bor\s+(?:should|do|would)\b[^?]{0,200}\?`,
  ].join('|'),
  'i',
);

// A plain-text model reply does not always use ask_user_question. Treat a
// substantive closing interrogative as the same pause, while excluding the
// conversational sign-offs that do not carry a decision. This is intentionally
// domain-neutral: clarification nouns should not require curated regex entries.
const MATERIAL_CLOSING_QUESTION_RE =
  /(?:^|[.!]\s+|\n+)(?:which|what|who|where|when|how|is|are|was|were|do|does|did|can|could|would|should|will|shall|may)\b[^?]{0,300}\?\s*$/i;
const COURTESY_CLOSING_QUESTION_RE =
  /(?:anything else|something else|(?:what|how) else can i help(?: with)?|does that (?:help|work|make sense)|sound good)\?\s*$/i;

export function isDirectionSeekingQuestion(reply?: string | null): boolean {
  const text = (reply ?? '').trim();
  if (!text || !text.includes('?')) return false;
  // Only the CLOSING move counts — a question answered mid-reply followed by a
  // delivered artifact is not a pause. Inspect the final ~400 chars.
  const tail = text.slice(-400);
  if (!/\?[\s"'\u2019)\]*_`]*$/u.test(tail)) return false;
  if (COURTESY_CLOSING_QUESTION_RE.test(tail)) return false;
  return DIRECTION_QUESTION_RE.test(tail) || MATERIAL_CLOSING_QUESTION_RE.test(tail);
}
