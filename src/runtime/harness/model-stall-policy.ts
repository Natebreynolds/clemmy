import { getRuntimeEnv } from '../../config.js';

/** Shared finite wall for an active model response. */
export function modelStreamStallMs(): number {
  const raw = Number.parseInt(
    getRuntimeEnv('CLEMMY_MODEL_STREAM_STALL_MS', '300000') ?? '300000',
    10,
  );
  if (!Number.isFinite(raw)) return 300_000;
  return raw <= 0 ? 0 : raw;
}

/** Shared first-content wall used by streaming transports. 2026-09-01: 75s →
 * 180s together with the brain fallover budget (60s → 150s), which must stay
 * strictly below this wall; see brainFalloverFirstByteMs. */
export function modelFirstByteStallMs(): number {
  const ceiling = modelStreamStallMs();
  const raw = Number.parseInt(
    getRuntimeEnv('CLEMMY_MODEL_FIRST_BYTE_STALL_MS', '180000') ?? '180000',
    10,
  );
  if (!Number.isFinite(raw) || raw <= 0) return ceiling;
  return ceiling > 0 ? Math.min(raw, ceiling) : raw;
}

/** Absolute wall for an interactive foreground attempt to produce its first
 * actionable assistant text/tool item. Provider-private reasoning proves the
 * connection is alive, but cannot keep a person on a silent UI indefinitely.
 * Background/workflow/worker lanes do not opt into this policy. */
export function modelInteractivePreActionableMs(): number {
  const raw = Number.parseInt(
    getRuntimeEnv('CLEMMY_MODEL_INTERACTIVE_PRE_ACTIONABLE_MS', '60000') ?? '60000',
    10,
  );
  if (!Number.isFinite(raw)) return 60_000;
  return raw <= 0 ? 0 : raw;
}

/** Shared pre-content retry budget. One clean retry is enough to move to the
 * already-selected rescue model without multiplying a silent provider wall
 * into a multi-minute foreground hang. Callers may override this for an
 * explicit diagnostic/rehearsal, but ordinary turns default to one. */
export function modelStreamStallRetries(): number {
  const raw = Number.parseInt(
    getRuntimeEnv('CLEMMY_MODEL_STREAM_STALL_RETRIES', '1') ?? '1',
    10,
  );
  if (!Number.isFinite(raw) || raw < 0) return 1;
  return raw;
}

export class ModelStreamStalledError extends Error {
  constructor(
    public readonly seconds: number,
    public readonly preContent: boolean,
    /** A paid request may still exist behind a non-streaming compatibility
     * adapter. Such an attempt is never automatically replayable. */
    public readonly bufferedProviderRequestInFlight = false,
  ) {
    super(
      preContent
        ? `Your model provider didn't start responding within ${seconds}s, so the request timed out before any output. `
          + 'This is almost always the provider being overloaded or a transient network hiccup on their end — not your request. Re-send to retry.'
        : `Your model provider stopped responding mid-answer (no output for ${seconds}s) and the call timed out. `
          + 'This is usually a provider or network hiccup. Re-send to retry.',
    );
    this.name = 'ModelStreamStalledError';
  }
}
