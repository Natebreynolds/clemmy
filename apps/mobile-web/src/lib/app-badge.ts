/**
 * The number on the app icon.
 *
 * The Badging API works for an installed web app on iOS 16.4+, which is exactly
 * how this PWA is used, and it is the only thing this product can say to a
 * person who has not opened it: how many things need them. So the badge counts
 * DECISIONS — the shell's one Needs-you total — never unread updates, because a
 * badge that includes finished work teaches the user to ignore it.
 *
 * Honesty rules, both of which the pure function below encodes:
 *  - An unknown count clears nothing and sets nothing. The shell keeps its last
 *    authoritative summary through a failed poll (see app.tsx), and a guessed
 *    zero on the icon would say "you're clear" on the strength of a dropped
 *    request.
 *  - Zero is a real answer and must CLEAR the badge, not leave yesterday's
 *    number sitting on the home screen.
 */

/**
 * What the SESSION says the icon may do, before the count is even consulted.
 *
 * The same honesty rule one level up: "not yet known" is not "signed out". The
 * shell's auth status starts null on every cold open, and treating that null as
 * a negative wiped a badge that said 3 and left the icon claiming "you're
 * clear" while three things needed the user — the exact lie the count gate
 * below exists to prevent. Only a CONFIRMED negative clears.
 *
 *  - 'sync'  — signed in: apply the count (which has its own known/unknown gate)
 *  - 'clear' — confirmed signed out: the icon must not keep a dead session's count
 *  - 'hold'  — auth not yet known: leave the icon exactly as it is
 */
export function appBadgeAuthAction(
  authStatus: { authenticated: boolean } | null | undefined,
): 'sync' | 'clear' | 'hold' {
  if (!authStatus) return 'hold';
  return authStatus.authenticated ? 'sync' : 'clear';
}

/** What the icon should show: a count, 0 to clear, or null to leave it alone. */
export function appBadgeCount(input: { count: number; known: boolean }): number | null {
  if (!input.known) return null;
  if (!Number.isFinite(input.count) || input.count < 0) return null;
  return Math.min(Math.trunc(input.count), 99);
}

/** The subset of navigator this needs; absent on every browser that lacks the API. */
export interface BadgeTarget {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/**
 * Apply the count. Every call is best-effort: an unsupported browser has no
 * methods at all, and a supported one still rejects when the app is not
 * installed — neither is a reason to disturb the page.
 */
export function syncAppBadge(
  input: { count: number; known: boolean },
  target: BadgeTarget | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): number | null {
  const badge = appBadgeCount(input);
  if (badge === null || !target) return badge;
  try {
    if (badge === 0) void target.clearAppBadge?.()?.catch(() => undefined);
    else void target.setAppBadge?.(badge)?.catch(() => undefined);
  } catch { /* an installed-app-only API in a plain tab */ }
  return badge;
}

/** Sign-out and lock: the icon must not keep a signed-out session's count. */
export function clearAppBadge(
  target: BadgeTarget | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): void {
  if (!target) return;
  try {
    void target.clearAppBadge?.()?.catch(() => undefined);
  } catch { /* see syncAppBadge */ }
}
