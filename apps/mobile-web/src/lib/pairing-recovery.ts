import { authBootstrapMode } from './auth-bootstrap';

export function pairingRecovery(error: unknown, nowMs = Date.now()): { retryable: boolean; message: string; retryAt?: number } {
  const failure = error && typeof error === 'object' ? error as { status?: number; body?: { error?: string; retryAfterMs?: number } } : {};
  if (failure.status === 401 && failure.body?.error === 'INVALID_PAIRING_CODE') return {
    retryable: false,
    message: 'That QR code expired or was already used. Open Apps & devices → Pair your phone on your computer and scan a fresh code.',
  };
  if (failure.status === 429) {
    // The server may limit the request before looking at the code. Preserve
    // it, honor the reported wait, and let the same server decide on retry.
    const wait = failure.body?.retryAfterMs;
    return {
      retryable: true,
      retryAt: nowMs + (typeof wait === 'number' && Number.isFinite(wait) && wait > 0 ? wait : 60_000),
      message: 'Too many pairing attempts. Your QR code is kept here. Wait for the timer, then try pairing again.',
    };
  }
  if (failure.status === undefined || failure.status === 0 || failure.status === 408 || failure.status >= 500) return {
    retryable: true,
    message: 'Pairing could not finish. Keep Clem open and check that both devices are on the same Wi-Fi, then try again.',
  };
  return {
    retryable: false,
    message: 'This pairing request was refused. Open Apps & devices → Pair your phone on your computer and scan a fresh code.',
  };
}

/** Retry only the exact retained attempt, through the existing single-owner boot. */
export function canRetryPairing(search: string, attemptedToken: string | null, retryable: boolean, retryAt?: number | null, nowMs = Date.now()): boolean {
  return retryable && Boolean(attemptedToken) && authBootstrapMode(search) === 'pair'
    && new URLSearchParams(search).get('pair') === attemptedToken && (!retryAt || nowMs >= retryAt);
}
