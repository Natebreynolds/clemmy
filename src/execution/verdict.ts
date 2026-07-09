/**
 * Verdict door (strategic wave T3-B4) — ONE canonical verdict shape + audit
 * event for every judge decision the harness acts on.
 *
 * The judge CORE is already unified (objective-judge.ts runHedgedJudge: one
 * hedged cross-family engine behind completion, per-criterion, and target
 * judges). What was still forked was the RECORD: a completion verdict lived in
 * a heartbeat's prose, a goal verdict in the checker report, a workflow-target
 * verdict in a quality advisory, a delivery verdict in conversation_completed
 * data — four vocabularies for one concept, none queryable as "what did the
 * judges decide on this run?". This module is the one door: a canonical
 * `RecordedVerdict` + `recordVerdictEvent` emitting a single `verdict_recorded`
 * eventlog row from each call site that owns the session context.
 *
 * DELIBERATELY NOT here: fail policies. Each door fails in its own direction
 * on purpose (chat completion fails OPEN toward done; goal validation fails
 * STRICT toward not-passed; the workflow target judge is conservative toward
 * reached; delivery verification fails open toward delivered). Those policies
 * stay at the doors as explicit behavior — pinned by tests — and this module
 * only RECORDS what each door decided. Recording is best-effort: an eventlog
 * hiccup never affects the verdict it describes.
 */
import { appendEvent } from '../runtime/harness/eventlog.js';

/** Which judge door produced the verdict. */
export type VerdictDoor =
  | 'completion'        // chat objective judge (loop.ts, fail-open)
  | 'goal_validation'   // parked goal contract (validateGoal, fail-strict)
  | 'workflow_target'   // end-of-run legacy target judge (conservative)
  | 'delivery';         // verifyDelivered honesty gate (fail-open)

export interface RecordedVerdict {
  door: VerdictDoor;
  /** The door's binary outcome in ITS OWN semantics (done/passed/reached/delivered). */
  pass: boolean;
  /** The judge's one-line reason / gap / evidence note. */
  reason?: string | undefined;
  /** Completion was accepted WITHOUT a real verdict (timeout/error/unparsed). */
  failedOpen?: boolean | undefined;
  /** Verdict came from the brain's own model family (tagged lower-confidence). */
  selfJudge?: boolean | undefined;
  /** Per-criterion scorecard where the door has one (goal validation). */
  criteriaMet?: number | undefined;
  criteriaTotal?: number | undefined;
  /** Structured extras a door wants alongside the canonical fields. */
  detail?: Record<string, unknown> | undefined;
}

/**
 * Append the canonical `verdict_recorded` audit row. Best-effort by contract:
 * NEVER throws — a telemetry failure must not alter the judged outcome.
 */
export function recordVerdictEvent(
  sessionId: string,
  turn: number,
  verdict: RecordedVerdict,
): void {
  try {
    appendEvent({
      sessionId,
      turn,
      role: 'system',
      type: 'verdict_recorded',
      data: {
        door: verdict.door,
        pass: verdict.pass,
        ...(verdict.reason ? { reason: verdict.reason.slice(0, 400) } : {}),
        ...(verdict.failedOpen !== undefined ? { failedOpen: verdict.failedOpen } : {}),
        ...(verdict.selfJudge !== undefined ? { selfJudge: verdict.selfJudge } : {}),
        ...(verdict.criteriaMet !== undefined ? { criteriaMet: verdict.criteriaMet } : {}),
        ...(verdict.criteriaTotal !== undefined ? { criteriaTotal: verdict.criteriaTotal } : {}),
        ...(verdict.detail ? { detail: verdict.detail } : {}),
      },
    });
  } catch {
    /* recording is best-effort — never affects the verdict */
  }
}
