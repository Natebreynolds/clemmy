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

/** Shared first-content wall used by streaming transports. */
export function modelFirstByteStallMs(): number {
  const ceiling = modelStreamStallMs();
  const raw = Number.parseInt(
    getRuntimeEnv('CLEMMY_MODEL_FIRST_BYTE_STALL_MS', '75000') ?? '75000',
    10,
  );
  if (!Number.isFinite(raw) || raw <= 0) return ceiling;
  return ceiling > 0 ? Math.min(raw, ceiling) : raw;
}

/** Legacy SDK-runner retry budget. The host stepper deliberately never uses it. */
export function modelStreamStallRetries(): number {
  const raw = Number.parseInt(
    getRuntimeEnv('CLEMMY_MODEL_STREAM_STALL_RETRIES', '3') ?? '3',
    10,
  );
  if (!Number.isFinite(raw) || raw < 0) return 3;
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
