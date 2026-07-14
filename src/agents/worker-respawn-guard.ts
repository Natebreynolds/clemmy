import { listEvents, getSession } from '../runtime/harness/eventlog.js';
import { getRuntimeEnv } from '../config.js';

/**
 * Drift-tolerant key for the respawn guard. The model re-describes a capped item
 * across respawns ("Howard Barker Lane — barkerlanelaw.com" then
 * "...barkerlanelaw.com (Savannah, GA)"), so exact-string matching misses the
 * loop. Anchor on the bare domain when present (most stable); else strip the
 * first parenthetical and fold separators/case. Pure + deterministic — no fuzzy
 * match. Deliberate trade-off: two distinct items sharing one domain collide
 * (favor no-respawn-loop over a rare false-refuse, per the forEach idempotency
 * precedent). In the multi-client research pattern each client IS one domain.
 */
export function normalizeWorkerItemKey(item: string | null | undefined): string {
  if (!item) return '';
  let s = String(item).toLowerCase().trim();
  const paren = s.indexOf('(');
  if (paren >= 0) s = s.slice(0, paren).trim();
  const domain = s.match(/([a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)/)?.[1];
  if (domain) return domain;
  return s.replace(/[\s—–-]+/g, ' ').trim();
}

/**
 * True if THIS item already produced a worker_capped event earlier in this run
 * session — i.e. a re-spawn of an item whose worker already exhausted its turn
 * budget. A re-run with the same packet just caps again (the non-converging loop
 * observed live 2026-06-22), so the orchestrator refuses on the FIRST re-spawn.
 * Matches via the drift-tolerant key. Best-effort: any read failure returns
 * false (fail-open) so the guard can never block legitimate fan-out.
 */
export function workerItemAlreadyCapped(sessionId: string, item: string | null | undefined): boolean {
  try {
    const key = normalizeWorkerItemKey(item);
    if (!key) return false;
    const capped = listEvents(sessionId, { types: ['worker_capped'] });
    return capped.some((e) => {
      const prior = (e.data as { item?: unknown } | undefined)?.item;
      return typeof prior === 'string' && normalizeWorkerItemKey(prior) === key;
    });
  } catch {
    return false;
  }
}

// Wave 4 Stage 1 (durable swarm resume). Default ON; `=off` is the kill-switch.
// When a 30–60-min fan-out is interrupted (daemon restart / crash) and resumes,
// the brain replays the SAME run_worker calls — without this guard a worker that
// already finished re-runs from scratch AND re-issues any external writes it made.
export function workerResumeIdempotencyEnabled(): boolean {
  // Accept the full off convention (off|0|false|no), matching sibling switches.
  const v = (getRuntimeEnv('CLEMMY_WORKER_RESUME_IDEMPOTENCY', 'on') ?? 'on').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

/**
 * Durable-resume idempotency: TRUE if THIS exact job packet already produced a
 * successful (ok:true) `worker_result` earlier in this run session — i.e. the run
 * was interrupted and is now replaying a worker that already completed. The caller
 * REUSES the prior result instead of re-executing (which would redo the work and
 * re-issue the completed worker's external writes). Matched on the packet key
 * (workerPacketKey over the material packet fields), so ONLY an identical packet
 * short-circuits — a genuinely different re-processing of the same item (new
 * instructions/tools/context) gets a distinct key and runs normally. Best-effort /
 * fail-open: any read error returns false so the guard can never block a first
 * spawn. Note: pre-Stage-1 `worker_result` events carry no packetKey and so never
 * match — the guard only fires for runs that STARTED on this build (forward-only).
 */
export function workerAlreadyCompletedForPacket(sessionId: string, packetKey: string | null | undefined): boolean {
  try {
    if (!packetKey) return false;
    // Scope to unattended RUN sessions (execution/workflow/agent), NEVER a plain
    // chat session (adversarial review F5). A chat session persists across user
    // turns, so an identical packet re-issued in a LATER turn ("resend those
    // emails, I don't think they went") must NOT be short-circuited as a resume
    // replay. Background/workflow run sessions are per-run (unique id), so the
    // whole-session scan has no cross-turn ambiguity. Unknown/missing session →
    // do not fire (fail toward re-execution, which the duplicate-send wall backstops).
    const kind = getSession(sessionId)?.kind;
    if (!kind || kind === 'chat') return false;
    const results = listEvents(sessionId, { types: ['worker_result'] });
    return results.some((e) => {
      const d = e.data as { ok?: unknown; packetKey?: unknown } | undefined;
      return d?.ok === true && typeof d.packetKey === 'string' && d.packetKey === packetKey;
    });
  } catch {
    return false;
  }
}
