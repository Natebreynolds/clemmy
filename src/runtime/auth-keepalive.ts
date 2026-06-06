/**
 * Proactive Codex OAuth keepalive.
 *
 * The request-path token loader (codex-client.loadFreshCodexAccessToken) only
 * refreshes when a model call happens, and only ~60s before expiry. An idle
 * daemon therefore lets the token go stale, so the FIRST job after idle eats a
 * refresh round-trip (or a 401 → refresh), and a terminal failure (revoked /
 * expired refresh token) isn't seen until something fails mid-task.
 *
 * This keepalive — driven by a low-frequency daemon timer — refreshes a
 * soon-to-expire token WHILE IDLE and surfaces a re-auth prompt EARLY. It routes
 * through refreshStoredNativeOAuth, so it inherits the single-flight + cross-
 * process lock + skip-if-recent guards and adds no reuse-revoke risk. It also
 * announces a dead→alive recovery (e.g. after the user re-authenticates) so the
 * "expired" notification gets a matching "recovered" one.
 *
 * Kill switch: CLEMENTINE_AUTH_KEEPALIVE=off.
 */
import pino from 'pino';
import {
  getStoredCodexOAuthTokens,
  refreshStoredNativeOAuth,
  accessTokenExpiresSoon,
  isCodexAuthDead,
  getCodexAuthDead,
} from './auth-store.js';
import { notifyCodexAuthExpired } from './codex-native-runtime.js';
import { addNotification, getNotification } from './notifications.js';

const logger = pino({ name: 'clementine.auth-keepalive' });

// Refresh further ahead than the lazy request path (~60s) so the token is ALWAYS
// warm before a job runs, and a terminal failure surfaces while idle.
const KEEPALIVE_SKEW_MS = 5 * 60 * 1000;

let lastDead = false;

function notifyCodexAuthRecovered(): void {
  const id = `system-codex-auth-recovered-${new Date().toISOString().slice(0, 10)}`;
  if (getNotification(id)) return;
  addNotification({
    id,
    kind: 'system',
    title: 'Codex sign-in recovered — resuming agent work',
    body: 'Clementine re-authenticated with ChatGPT/Codex. Background jobs, cron, and chat can run again.',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { errorCategory: 'auth_recovered', provider: 'codex' },
  });
}

export function isAuthKeepaliveEnabled(): boolean {
  return (process.env.CLEMENTINE_AUTH_KEEPALIVE ?? 'on').toLowerCase() !== 'off';
}

/** One keepalive tick. Best-effort — never throws into the daemon loop. */
export async function tickAuthKeepalive(): Promise<void> {
  try {
    const deadNow = isCodexAuthDead();
    // dead→alive transition (a re-auth landed): announce recovery once per day.
    if (lastDead && !deadNow) notifyCodexAuthRecovered();
    lastDead = deadNow;

    if (deadNow) {
      // Never replay a dead refresh token. Surface the (daily-bucketed) re-auth
      // prompt EARLY (idle) instead of waiting for the next job to fail.
      notifyCodexAuthExpired(getCodexAuthDead()?.reason);
      return;
    }

    const tokens = getStoredCodexOAuthTokens();
    if (!tokens?.accessToken) return; // api_key mode or not signed in — nothing to warm

    if (accessTokenExpiresSoon(tokens.accessToken, KEEPALIVE_SKEW_MS)) {
      const result = await refreshStoredNativeOAuth();
      if (!result.ok && result.terminal) {
        // The refresh token itself is dead — surface re-auth now, while idle.
        notifyCodexAuthExpired(result.message);
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'auth keepalive tick failed (non-fatal)');
  }
}

/** Test seam: reset the dead-transition latch between tests. */
export function __resetAuthKeepaliveStateForTests(): void {
  lastDead = false;
}
