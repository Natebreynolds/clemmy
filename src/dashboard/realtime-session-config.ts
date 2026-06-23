/**
 * Pure helpers for resolving the per-session Realtime voice config.
 *
 * The voice settings UI may override turn-taking (VAD) parameters via the
 * session request body. Every value is clamped to the same safe range as the
 * env-default path so UI input can never push out-of-range numbers into the
 * OpenAI Realtime session config. Kept pure + side-effect-free so it can be
 * unit-tested without standing up the route or mocking the OpenAI fetch.
 */

export interface RealtimeVadDefaults {
  vadThreshold: number;
  prefixPaddingMs: number;
  silenceMs: number;
}

export interface RealtimeVad {
  vadThreshold: number;
  prefixPaddingMs: number;
  silenceMs: number;
}

// Safe ranges — must stay in sync with the env clamps in console-routes.ts.
export const REALTIME_VAD_RANGES = {
  vadThreshold: { min: 0.1, max: 0.95 },
  prefixPaddingMs: { min: 0, max: 1500 },
  silenceMs: { min: 150, max: 2000 },
} as const;

/**
 * Clamp a (possibly user-supplied, possibly absent) numeric value into a safe
 * range, falling back to `fallback` when it is missing or not finite.
 */
export function clampRealtimeNumber(value: unknown, fallback: number, min: number, max: number): number {
  // Treat absent/empty as missing. Number(null) and Number('') are both 0, so
  // without this guard a null/blank field would slip through as 0 instead of
  // falling back to the default.
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/**
 * Resolve the effective VAD parameters from the request body, falling back to
 * the env-resolved defaults and clamping every value.
 */
export function resolveRealtimeVad(body: Record<string, unknown> | null | undefined, defaults: RealtimeVadDefaults): RealtimeVad {
  const b = body ?? {};
  return {
    vadThreshold: clampRealtimeNumber(b.vadThreshold, defaults.vadThreshold, REALTIME_VAD_RANGES.vadThreshold.min, REALTIME_VAD_RANGES.vadThreshold.max),
    prefixPaddingMs: clampRealtimeNumber(b.prefixPaddingMs, defaults.prefixPaddingMs, REALTIME_VAD_RANGES.prefixPaddingMs.min, REALTIME_VAD_RANGES.prefixPaddingMs.max),
    silenceMs: clampRealtimeNumber(b.silenceMs, defaults.silenceMs, REALTIME_VAD_RANGES.silenceMs.min, REALTIME_VAD_RANGES.silenceMs.max),
  };
}

/**
 * Thin instruction for the one-loop voice surface. The realtime model is NOT a
 * brain here — it only hears (VAD+STT) and speaks the text it is handed by the
 * real Clementine agent. No memory/goals context is injected because the brain
 * (the chat loop) owns all of that.
 */
export const VOICE_DELIVERY_INSTRUCTIONS = [
  "You are Clementine's voice. You do not think or decide anything on your own.",
  'When you are asked to say something, speak it naturally and warmly, as Clementine would.',
  'Never add, invent, summarize, or answer on your own initiative. Only speak what you are given.',
  'Keep a natural spoken cadence. Do not read markdown, URLs, or code aloud.',
].join(' ');

/** The legacy relay tool, exposed to the persona path only (not one-loop). */
export const SEND_TO_CLEMENTINE_TOOL = {
  type: 'function',
  name: 'send_to_clementine',
  description: 'Send a spoken user request to the local Clementine agent for tool use, local computer actions, project work, approvals, or long-running execution.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      request: { type: 'string', description: 'The exact user request to send to Clementine.' },
      reason: { type: 'string', description: 'Why this request should be handled by the local agent instead of only the realtime voice model.' },
    },
    required: ['request', 'reason'],
  },
} as const;

export interface RealtimeSessionConfigInput {
  model: string;
  voice: string;
  transcriptionModel: string;
  instructions: string;
  vad: RealtimeVad;
  idleTimeoutMs: number;
  /**
   * One-loop mode: the realtime model is ears+mouth only. VAD+STT still fire,
   * but it never auto-responds (create_response:false) and has no tools — the
   * real brain (chat loop) drives every spoken reply.
   */
  oneLoop: boolean;
  expiresAfterSeconds?: number;
}

/**
 * Build the OpenAI Realtime client-secret session payload. Pure so the
 * one-loop vs persona shape is unit-testable without the network fetch.
 */
export function buildRealtimeSessionConfig(input: RealtimeSessionConfigInput): Record<string, unknown> {
  const { model, voice, transcriptionModel, instructions, vad, idleTimeoutMs, oneLoop } = input;
  return {
    session: {
      type: 'realtime',
      model,
      instructions,
      audio: {
        input: {
          transcription: { model: transcriptionModel },
          turn_detection: {
            type: 'server_vad',
            threshold: vad.vadThreshold,
            prefix_padding_ms: vad.prefixPaddingMs,
            silence_duration_ms: vad.silenceMs,
            idle_timeout_ms: idleTimeoutMs,
            interrupt_response: true,
            // One-loop: the model must NOT generate its own replies; we drive
            // speech from the brain's text via out-of-band response.create.
            create_response: !oneLoop,
          },
        },
        output: { voice },
      },
      // One-loop strips the relay tool — the model decides nothing.
      tools: oneLoop ? [] : [SEND_TO_CLEMENTINE_TOOL],
      tool_choice: oneLoop ? 'none' : 'auto',
    },
    expires_after: {
      anchor: 'created_at',
      seconds: input.expiresAfterSeconds ?? 600,
    },
  };
}
