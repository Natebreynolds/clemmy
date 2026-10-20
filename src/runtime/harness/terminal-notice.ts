/**
 * An app status attached to a terminal. When a terminal carries a notice, its
 * stored text is a short app-voice line with no first person (kept for the CLI,
 * channels and model history); desktop and phone render the notice as chrome,
 * never as Clem's bubble, and voice never speaks it. Clem's own words never
 * become a notice: a notice is only for the facts no model should phrase.
 * Leaf module: the committer, the reducers and the public projection share it.
 */
export const TERMINAL_NOTICE_CODES = [
  'stopped',
  'response_format_unmet',
  'response_format_unqualified',
  'provider_quota',
  'card_decision',
  'saved_model_unavailable',
  'model_unavailable_on_sign_in',
  'no_model_connected',
  'codex_sign_in_expired',
  'provider_out_of_credit',
  'model_stalled',
  'run_failed',
  'steering_unavailable',
  'continuation_unavailable',
] as const;

export type TerminalNoticeCode = typeof TERMINAL_NOTICE_CODES[number];

export interface TerminalNotice {
  code: TerminalNoticeCode;
  agentName?: string;
  model?: string;
  /** The provider's own words, when there are any. Never Clem's. */
  providerSaid?: string;
}

const CODES: ReadonlySet<string> = new Set(TERMINAL_NOTICE_CODES);

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

/** The one accepted shape: a known code plus bounded optional strings. Any
 * other value is dropped rather than repaired into a different notice. */
export function normalizeTerminalNotice(value: unknown): TerminalNotice | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.code !== 'string' || !CODES.has(raw.code)) return undefined;
  const agentName = bounded(raw.agentName, 64);
  const model = bounded(raw.model, 120);
  const providerSaid = bounded(raw.providerSaid, 400);
  return {
    code: raw.code as TerminalNoticeCode,
    ...(agentName ? { agentName } : {}),
    ...(model ? { model } : {}),
    ...(providerSaid ? { providerSaid } : {}),
  };
}

/** App-voice line for an owner Stop. No first person: the owner's own
 * decision is chrome, not something Clem says. */
export const OWNER_STOP_TERMINAL_TEXT = 'Stopped. Nothing further runs for this turn.';

/** The same Stop when completed results exist to keep. */
export const OWNER_STOP_RESULTS_KEPT_TERMINAL_TEXT = 'Stopped. Completed results are kept.';

/** The host's machine reason when a turn cannot read or reopen the
 * conversation's mid-turn message record before starting work. The loop maps
 * it to the notice below. */
export const STEERING_REOPEN_UNAVAILABLE_BLOCKED_REASON = 'owner_steering_cutover_reopen_unavailable';

/** App-voice line for that stop. No first person: the record is a host fact
 * no model phrased, and the clients draw its notice as chrome. It is worded
 * for a new message, since the block meets every message in the conversation,
 * and names the edge that clears it rather than a retry that cannot. */
export const STEERING_REOPEN_UNAVAILABLE_TERMINAL_TEXT =
  'This conversation’s steering record could not be read; the message did not start. Start a new conversation to continue.';
