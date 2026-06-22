import { listEvents } from '../runtime/harness/eventlog.js';

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
