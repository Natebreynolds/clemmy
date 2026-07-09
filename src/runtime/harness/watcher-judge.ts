/**
 * WATCHER judge — a trajectory co-pilot for autonomous action turns.
 *
 * Every other judge in the harness is either TERMINAL (completion / goal
 * contract, at end-of-turn) or a PER-WRITE gate (grounding / goal-fidelity, on
 * irreversible calls). Nothing watches TRAJECTORY — so a run that drifts at
 * tool-call 3 burns the whole turn before the completion judge bounces it, and
 * the bounce costs a full re-loop. The watcher closes that gap: it spans the
 * run, checks progress against the GOAL at tool-call milestones, and INJECTS a
 * one-sentence steer into the next continuation when the agent is confidently
 * missing something. Mid-course correction instead of end-course rejection.
 *
 * Design rules (all load-bearing):
 *  - NON-BLOCKING. Checks run in the background WHILE the next turn executes
 *    (loop.ts fires them without awaiting); a resolved drift verdict is
 *    injected at the NEXT continuation boundary. The watcher never adds a
 *    millisecond to the critical path.
 *  - GOAL ONLY. The rubric judges against the stated goal/criteria — it never
 *    demands artifacts, steps, or formats the goal doesn't name (the same
 *    clean-rubric contract as the completion judge).
 *  - ADVISORY ONLY. A steer is information for the model, never a block —
 *    blocking stays the write-gates' job (guardrails inform, not override).
 *  - SILENT WHEN UNSURE. Uncertain / stylistic / no-verdict → say nothing.
 *    Bounded at MAX_WATCHER_INJECTIONS steers per turn.
 *  - FAIL-OPEN. Any judge error/timeout → no injection, run untouched.
 *
 * Kill-switch: CLEMMY_WATCHER_JUDGE=off. Cadence: CLEMMY_WATCHER_INTERVAL_TOOLS
 * (default 8 tool calls between checks).
 */
import { getRuntimeEnv } from '../../config.js';

export function watcherJudgeEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_WATCHER_JUDGE', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

/** Tool calls between trajectory checks. Low enough to catch drift before it
 *  compounds, high enough that a focused run sees at most a few checks. */
export function watcherCheckIntervalTools(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_WATCHER_INTERVAL_TOOLS', '8') ?? '8', 10);
  return Number.isFinite(raw) && raw >= 2 ? raw : 8;
}

/** Hard cap on steers per turn — the watcher nudges, it never nags. */
export const MAX_WATCHER_INJECTIONS = 2;

/** Hard cap on trajectory CHECKS per run/turn (on-track checks don't spend an
 *  injection, so without this a 20-step workflow would pay a blocking check
 *  every interval for the whole run — minutes of wall-clock for zero steers).
 *  Early checks are the valuable ones: drift caught late is barely correctable. */
export const MAX_WATCHER_CHECKS = 4;

/** Workflow mount cadence: completed steps between trajectory checks. Steps
 *  are heavyweight (each is many tool calls), so the interval is small. */
export function watcherWorkflowIntervalSteps(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_WATCHER_WORKFLOW_INTERVAL_STEPS', '2') ?? '2', 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 2;
}

// ─────────────────────────────────────────────────────────────────
// Pure gate (deterministically testable, mirrors shouldRunObjectiveJudge)
// ─────────────────────────────────────────────────────────────────

export interface WatcherGateInput {
  /** watcherJudgeEnabled() && the chat caller opted into completion judging —
   *  the same opt-in signal that arms the objective judge (workflow steps and
   *  purely conversational turns never get a watcher). */
  enabled: boolean;
  totalToolCalls: number;
  /** totalToolCalls when the last check STARTED (0 = never checked). */
  lastCheckedAtToolCalls: number;
  checkIntervalTools: number;
  injectionsUsed: number;
  maxInjections: number;
  /** Checks already started this run/turn (on-track ones included). */
  checksUsed: number;
  maxChecks: number;
  /** A previous check is still in flight — never stack checks. */
  checkInFlight: boolean;
}

export function shouldStartWatcherCheck(input: WatcherGateInput): boolean {
  return (
    input.enabled &&
    !input.checkInFlight &&
    input.injectionsUsed < input.maxInjections &&
    input.checksUsed < input.maxChecks &&
    input.totalToolCalls - input.lastCheckedAtToolCalls >= input.checkIntervalTools
  );
}

// ─────────────────────────────────────────────────────────────────
// Verdict contract — one plain-text line, parsed deterministically
// (the same no-schema-to-flake treatment as every other boundary judge)
// ─────────────────────────────────────────────────────────────────

export interface WatcherVerdict {
  onTrack: boolean;
  /** !onTrack → the specific goal-named thing being missed. */
  miss: string;
  /** !onTrack → the one-sentence corrective instruction to inject. */
  steer: string;
}

export function parseWatcherVerdict(finalOutput: unknown): WatcherVerdict | null {
  const raw = String(finalOutput ?? '').trim();
  const m = /^\s*(ON-?TRACK|DRIFT)\s*:?\s*(.*)$/im.exec(raw);
  if (!m) return null;
  if (m[1].toUpperCase().replace('-', '') === 'ONTRACK') return { onTrack: true, miss: '', steer: '' };
  const rest = (m[2] || '').trim();
  const steerMatch = /\|\s*STEER\s*:?\s*/i.exec(rest);
  const miss = (steerMatch ? rest.slice(0, steerMatch.index) : rest).trim().slice(0, 300);
  const steer = (steerMatch ? rest.slice(steerMatch.index + steerMatch[0].length) : '').trim().slice(0, 300);
  if (!miss && !steer) return null; // a bare "DRIFT" with no content is not actionable
  return { onTrack: false, miss: miss || steer, steer: steer || miss };
}

export const WATCHER_JUDGE_SYSTEM_PROMPT = [
  'You are a TRAJECTORY WATCHER for an autonomous agent mid-run. You receive (1) the goal the user stated (with success criteria when declared), (2) a summary of the tool calls made so far, and (3) the agent\'s latest note.',
  '',
  'Decide whether the work so far is ON TRACK to satisfy the goal.',
  '',
  'Rules:',
  '- Judge against the GOAL ONLY. Never demand artifacts, steps, tools, or formats the goal does not name.',
  '- Report DRIFT only for a SPECIFIC, NAMEABLE miss: the work contradicts the goal, a goal-named deliverable or criterion has clearly not been touched late in the run, a committed procedure step is being skipped, or the agent is repeating the same failing action without adjusting.',
  '- The agent is mid-run: incomplete work is EXPECTED and is NOT drift. Order of operations is the agent\'s choice.',
  '- Uncertain, stylistic, or preference-level observations → ON-TRACK. Silence is the default; a steer must be worth an interruption.',
  '',
  'Reply with EXACTLY ONE LINE and nothing else, one of:',
  '  "ON-TRACK: <three words on the trajectory>";',
  '  "DRIFT: <the specific goal-named miss> | STEER: <one concrete sentence telling the agent what to address before finishing>".',
].join('\n');

export interface WatcherJudgeInput {
  /** The composed objective (what the user actually asked for). */
  objective: string;
  /** Parked success criteria when a goal contract exists. */
  successCriteria?: string[];
  /** Compact tool-call evidence (summarizeToolCallsForJudge). */
  toolCallSummary: string;
  /** The agent's latest reply/summary — its own read on where it is. */
  latestAssistantNote: string;
  /** Tool calls so far (context for "late in the run"). */
  toolCallCount: number;
}

export function buildWatcherPrompt(input: WatcherJudgeInput): string {
  const parts = [
    `Goal: ${input.objective}`,
    ...((input.successCriteria?.length ?? 0) > 0
      ? ['', 'Declared success criteria:', ...input.successCriteria!.map((c, i) => `${i + 1}. ${c}`)]
      : []),
    '',
    `Tool calls so far (${input.toolCallCount}): ${input.toolCallSummary || '(none recorded)'}`,
    '',
    `Agent's latest note: ${(input.latestAssistantNote || '(none)').slice(0, 1500)}`,
    '',
    'Is this trajectory on track for the goal? Respond with the one-line verdict.',
  ];
  return parts.join('\n');
}

export type WatcherJudgeFn = (input: WatcherJudgeInput) => Promise<WatcherVerdict | null>;

/**
 * One trajectory check: a single hedged cross-family judge call on the shared
 * engine (objective-judge.ts runHedgedJudge → routing, hedging, 'watcher'
 * metric lane). Returns null on ANY failure — a watcher that can't judge says
 * nothing (fail-open by silence, never by a fabricated steer).
 */
export async function runWatcherJudge(input: WatcherJudgeInput): Promise<WatcherVerdict | null> {
  if (!input.objective.trim()) return null;
  try {
    const { runHedgedJudge } = await import('./objective-judge.js');
    const run = await runHedgedJudge(
      WATCHER_JUDGE_SYSTEM_PROMPT,
      buildWatcherPrompt(input),
      parseWatcherVerdict,
      (v) => v.onTrack,
      'watcher',
    );
    return run.value;
  } catch {
    return null;
  }
}
