/**
 * What the phone can still show with the lid shut.
 *
 * A closed laptop is the NORMAL state of the machine this app depends on, and
 * until now a cold open with no reachable Mac was a correct-looking empty app:
 * the service worker (correctly) refuses to cache /m/api/*, and every screen's
 * in-memory last-good died with the process.
 *
 * So the service worker keeps a durable last-good copy of a SMALL, deliberately
 * chosen set of routes and serves it only when the network fails, stamped with
 * when it was taken. Three rules make that honest rather than a lie:
 *
 *  1. READ-ONLY ROUTES ONLY. Nothing here can be acted on — a summary count, a
 *     run list, one run's detail. A stale approval must never be actionable as
 *     though it were current, so approvals, questions, plans and trust requests
 *     are NOT cached at all: their screens stay empty and say why.
 *  2. STAMPED, NEVER PASSED OFF AS LIVE. Every served copy carries its age, the
 *     UI says how old it is, and the connection door stays "offline" — a cached
 *     200 must not tell the app it reached the Mac.
 *  3. IT DIES WITH THE SESSION. Sign-out drops the whole cache (see
 *     clearLastGood) so a signed-out phone cannot page through the last
 *     session's work.
 */

/** Response header the service worker stamps a served copy with (ISO time). */
export const LAST_GOOD_HEADER = 'x-clem-last-good';
/** Cache Storage name. Bump the suffix to invalidate every stored copy. */
export const LAST_GOOD_CACHE = 'clem-mobile-last-good-v1';
/** postMessage type that tells the service worker to drop everything. */
export const CLEAR_LAST_GOOD_MESSAGE = 'clem:clear-last-good';

/**
 * The routes a last-good copy is allowed for. Each is a GET that renders a
 * read-only screen; sw.ts holds the same list literally (a classic worker
 * cannot import this module) and last-good.test.ts pins the two together.
 */
export const LAST_GOOD_PATHS: readonly string[] = [
  '/m/api/inbox/summary',
  '/m/api/runs',
];

export function isLastGoodPath(pathname: string): boolean {
  return LAST_GOOD_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// ─── the stamp registry ────────────────────────────────────────────────────
//
// api() records the stamp of every response; a screen asks whether what it is
// rendering came from the network or from the shelf. Keyed by path without its
// query, so `/m/api/runs?limit=20` and `/m/api/runs` are one row.

const stamps = new Map<string, string>();

function pathKey(path: string): string {
  return path.split('?')[0] ?? path;
}

/** Record (or clear) the age of the copy that answered this path. */
export function noteLastGood(path: string, stamp: string | null | undefined): void {
  const key = pathKey(path);
  if (stamp && Number.isFinite(Date.parse(stamp))) stamps.set(key, stamp);
  else stamps.delete(key);
}

/** When the data now on screen for this path was actually taken; null = live. */
export function lastGoodAt(path: string): string | null {
  return stamps.get(pathKey(path)) ?? null;
}

/** Sign-out, and the service-worker cache drop that goes with it. */
export function forgetLastGoodStamps(): void {
  stamps.clear();
}

/** Test seam: the registry without touching a real response. */
export function _lastGoodStampsForTest(): Map<string, string> {
  return stamps;
}

// ─── saying how old it is ──────────────────────────────────────────────────

export function ageLabel(stampIso: string, nowMs: number): string {
  const taken = Date.parse(stampIso);
  if (!Number.isFinite(taken)) return 'a while ago';
  const seconds = Math.max(0, Math.round((nowMs - taken) / 1000));
  if (seconds < 90) return 'a moment ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * The one line a screen shows above stale data. It says three things because
 * all three matter: this is not live, this is how old it is, and you can ask
 * again. The offline half is included only when the transport itself is down —
 * a served copy IS evidence of that, but the caller owns the distinction.
 */
export function lastGoodNotice(stampIso: string | null, nowMs: number): string | null {
  if (!stampIso) return null;
  return `Can't reach your Mac. This is what I last saw, ${ageLabel(stampIso, nowMs)}.`;
}

/**
 * Ask the service worker to drop every stored copy. Called on sign-out and on
 * a confirmed dead session, so nothing outlives the credential that earned it.
 */
export function clearLastGood(): void {
  forgetLastGoodStamps();
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: CLEAR_LAST_GOOD_MESSAGE });
    // A controller only exists once the worker has claimed this page; ask the
    // registration too so a fresh tab still clears.
    void navigator.serviceWorker?.ready
      ?.then((registration) => registration.active?.postMessage({ type: CLEAR_LAST_GOOD_MESSAGE }))
      ?.catch(() => undefined);
  } catch { /* no service worker here — the stamps above are the whole story */ }
}
