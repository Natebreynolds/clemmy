/**
 * What the client does after an authenticated request is refused with 401.
 *
 * One 401 is not a sign-out. The daemon rotates session tokens, the device
 * proof signs over a fingerprint derived from the token, and a request queued
 * across that boundary can be refused while the session itself is healthy.
 * The only honest arbiter is a LIVE status answer: if it still says
 * authenticated, the session stands and the fingerprint it reports is the one
 * every later proof must be signed over — adopting it is what lets a visit
 * that was signing over a retired fingerprint heal on its next request instead
 * of being refused until the app is force-quit. Only a confirmed dead session
 * flips the app to the gate.
 */
export interface LiveAuthStatus {
  authenticated?: boolean;
  sessionFingerprint?: string | null;
}

export type UnauthorizedRecovery =
  | { kind: 'session_alive'; adoptFingerprint: string | null }
  | { kind: 'session_dead' };

export function recoverFromUnauthorized(status: LiveAuthStatus | null | undefined): UnauthorizedRecovery {
  if (!status?.authenticated) return { kind: 'session_dead' };
  const fingerprint = typeof status.sessionFingerprint === 'string' && status.sessionFingerprint.length > 0
    ? status.sessionFingerprint
    : null;
  return { kind: 'session_alive', adoptFingerprint: fingerprint };
}
