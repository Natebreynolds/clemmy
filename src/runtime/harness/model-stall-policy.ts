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

/** Silence budgets grow with the prompt. Before 2026-09-01 the first-byte
 * fallover (150 s) and watchdog (180 s) were flat, so a 45k–100k-token prefill
 * on a slow brain read as a hang: the pinned brain was silenced and the turn
 * fell to a rate-limited rescue. +10 s per 10k estimated input tokens above
 * the free 20k, capped at the stream wall. The fallover budget is additionally
 * capped strictly below the sized watchdog so cross-brain fallover always gets
 * to act first (adversarial review 07-06). */
export const FIRST_BYTE_SIZING_FREE_TOKENS = 20_000;
export const FIRST_BYTE_SIZING_MS_PER_10K_TOKENS = 10_000;

/** Cheap, provider-neutral estimate of a request input's token count. */
export function estimateRequestInputTokens(input: unknown): number {
  try {
    return Math.ceil(JSON.stringify(input ?? '').length / 4);
  } catch {
    return 0;
  }
}

export function sizeFirstByteBudgetMs(baseMs: number, inputTokens: number, ceilingMs = modelStreamStallMs()): number {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return baseMs;
  const tokens = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const extra = Math.max(0, tokens - FIRST_BYTE_SIZING_FREE_TOKENS) / 10_000 * FIRST_BYTE_SIZING_MS_PER_10K_TOKENS;
  const sized = Math.round(baseMs + extra);
  return ceilingMs > 0 ? Math.min(sized, ceilingMs) : sized;
}

/** The host watchdog's first-content wall, sized to this request. */
export function sizedFirstByteStallMs(input: unknown): number {
  const base = modelFirstByteStallMs();
  return base > 0 ? sizeFirstByteBudgetMs(base, estimateRequestInputTokens(input)) : base;
}

/** A brain's first-content fallover budget, sized to this request and kept
 * strictly below the (equally sized) watchdog. */
export function sizedBrainFalloverFirstByteMs(baseMs: number, input: unknown): number {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return baseMs;
  const watchdog = sizedFirstByteStallMs(input);
  const ceiling = watchdog > 0 ? Math.max(1_000, watchdog - 5_000) : modelStreamStallMs();
  return sizeFirstByteBudgetMs(baseMs, estimateRequestInputTokens(input), ceiling);
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

/** Absolute wall for ONE model attempt, activity or not. The stream-stall and
 * first-content walls only measure silence; a brain that keeps emitting
 * private reasoning can hold a workflow step, its run and its pool slot
 * indefinitely (daily-standup, 2026-09-02: "Still working inside turn 1"
 * every three minutes for over ten). 0 disables. */
export function modelResponseWallMs(): number {
  const raw = Number.parseInt(
    getRuntimeEnv('CLEMMY_MODEL_RESPONSE_WALL_MS', '900000') ?? '900000',
    10,
  );
  if (!Number.isFinite(raw)) return 900_000;
  return raw <= 0 ? 0 : raw;
}
