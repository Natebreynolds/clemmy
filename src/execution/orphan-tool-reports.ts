/**
 * Stranded-tool reunification driver (daemon tick). A turn that died on an infra
 * error while a tool was still in flight registered an `orphaned_tool_inflight`
 * marker (loop.ts recordOrphanedToolInFlight). Once the tool completes, this poke
 * drains the completed orphans into follow-up REPORT turns so the session
 * self-reports the result to the user — the interrupted turn never posted it.
 *
 * Fire-and-forget per report (mirrors goal-resume's fireResume): a report-turn
 * failure never affects the tick. drainOrphanedToolCompletions marks each orphan
 * reported, so a report fires exactly once even across ticks.
 */
import pino from 'pino';
import type { OrphanedToolReport } from '../runtime/harness/loop.js';

const logger = pino({ name: 'clementine-next.orphan-tool-reports' });

/** Only sweep sessions touched within this window — an orphan older than the
 *  loop-side ORPHAN_TOOL_MAX_AGE_MS is already dropped by the drain. */
const ORPHAN_SWEEP_WINDOW_MS = 60 * 60_000;
/** Max report turns fired per sweep — they run as parallel fire-and-forget
 *  brain turns, so an unbounded post-crash drain is the machine-exhaustion
 *  shape of the v3.0.1 incident. Held sessions stay queued for the next tick. */
const MAX_REPORT_FIRES_PER_SWEEP = 2;

export interface OrphanReportDeps {
  now: () => number;
  recentSessionIds: (sinceIso: string) => string[];
  drain: (sessionId: string) => OrphanedToolReport[];
  /** Fire ONE follow-up report turn for a completed orphan (fire-and-forget). */
  fire: (sessionId: string, report: OrphanedToolReport) => void;
}

/** Pure sweep over the injected seams — unit-testable without a daemon. Returns
 *  how many report turns were fired. */
export function sweepOrphanedToolReports(deps: OrphanReportDeps): { fired: number } {
  let fired = 0;
  const since = new Date(deps.now() - ORPHAN_SWEEP_WINDOW_MS).toISOString();
  let sessionIds: string[];
  try { sessionIds = deps.recentSessionIds(since); } catch { return { fired: 0 }; }
  for (const sessionId of sessionIds) {
    // Per-sweep budget (v3.0.1 stampede family): each fire is a PARALLEL
    // fire-and-forget brain turn, and the post-crash case — the one this sweep
    // exists for — is exactly when many sessions have stranded completions at
    // once. Stop DRAINING new sessions once the budget is spent; undrained
    // sessions keep their reports and the sweep (every tick, 60-min lookback)
    // picks them up next pass. Never split within a session: drain() is
    // removal, so a partially-fired drain would silently drop the rest.
    if (fired >= MAX_REPORT_FIRES_PER_SWEEP) break;
    let reports: OrphanedToolReport[];
    try { reports = deps.drain(sessionId); } catch { continue; }
    for (const report of reports) {
      try { deps.fire(sessionId, report); fired += 1; } catch { /* one report failure never stops the sweep */ }
    }
  }
  return { fired };
}

/** Daemon entry point: wire the live seams (event-log sessions + drain, orchestrator
 *  runConversation) and run one sweep. Best-effort — never throws into the tick. */
export async function processOrphanedToolReports(): Promise<void> {
  try {
    const [{ drainOrphanedToolCompletions, runConversation }, { listSessions }, { buildOrchestratorAgent }] = await Promise.all([
      import('../runtime/harness/loop.js'),
      import('../runtime/harness/eventlog.js'),
      import('../agents/orchestrator.js'),
    ]);
    const result = sweepOrphanedToolReports({
      now: () => Date.now(),
      recentSessionIds: (sinceIso) => {
        try { return listSessions({ updatedAfter: sinceIso, limit: 200 }).map((s) => s.id); } catch { return []; }
      },
      drain: (sessionId) => drainOrphanedToolCompletions(sessionId),
      fire: (sessionId, report) => {
        void (async () => {
          try {
            const agent = await buildOrchestratorAgent({ userInput: report.directive, sessionId });
            await runConversation({ agent, sessionId, input: report.directive });
          } catch (err) {
            logger.warn({ err: err instanceof Error ? err.message : err, sessionId, callId: report.callId }, 'orphan report turn failed');
          }
        })();
      },
    });
    if (result.fired > 0) logger.info(result, 'stranded-tool report turns fired');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'processOrphanedToolReports failed');
  }
}
