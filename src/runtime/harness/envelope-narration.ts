/**
 * Parse a NARRATED decision envelope without treating it as a reply.
 *
 * Live 2026-07-31 on 3.5.0: a user was shown Clem's internal decision object as
 * prose — a question, then `summary:`, `reply:`, `done:`, `nextAction:`,
 * `reason:` lines. Those are the orchestrator's own contract field names. The
 * model had emitted the envelope as TEXT instead of returning it structurally,
 * and the whole blob went to the chat, so the user read Clem's bookkeeping
 * instead of Clem's answer.
 *
 * These fields have different semantics. Concatenating them after deleting the
 * labels still publishes control-plane narration, and it destroys the evidence
 * needed to decide whether the turn completed or paused. The parser therefore
 * preserves the fields. A compatibility helper exposes only the explicit reply
 * plus a genuine preamble question; evidence-rich reports must be composed from
 * the execution ledger by the public reply node.
 *
 * The raw text remains in the execution/audit ledger.
 *
 * Conservative by design. A line-anchored `reply` plus one other decision key
 * is already a narrated contract; combinations without `reply` require three
 * distinct keys. Ordinary prose that happens to contain one colon-led label is
 * never rewritten. If the envelope is present but carries no usable `reply`,
 * the public helper fails closed rather than laundering control fields.
 */

/** The orchestrator's decision-envelope fields, as the model would label them. */
const ENVELOPE_KEYS = ['summary', 'reply', 'done', 'nextaction', 'reason'] as const;
export type NarratedEnvelopeKey = (typeof ENVELOPE_KEYS)[number];

const KEY_LINE_RE = /^[ \t>*-]*(summary|reply|done|next\s*action|nextaction|reason)\s*:\s*/i;

function normalizeKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z]/g, '');
}

export interface NarratedEnvelope {
  /** Every field value, in the order the model wrote them, labels removed. */
  blocks: string[];
  /** Values keyed by their decision-contract meaning. */
  fields: Partial<Record<NarratedEnvelopeKey, string>>;
  /** Any text that preceded the envelope (often the real question). */
  preamble: string;
  /** Distinct contract keys found, for telemetry. */
  keys: string[];
}

/** Parse a narrated envelope, or null when the text is ordinary prose. */
export function parseNarratedEnvelope(text: string): NarratedEnvelope | null {
  const raw = (text ?? '').replace(/\r\n/g, '\n');
  if (!raw.trim()) return null;
  const lines = raw.split('\n');

  const found = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const match = KEY_LINE_RE.exec(lines[i]);
    if (!match) continue;
    const key = normalizeKey(match[1]);
    if (!ENVELOPE_KEYS.includes(key as (typeof ENVELOPE_KEYS)[number])) continue;
    if (!found.has(key)) found.set(key, i);
  }
  // `reply` is the contract's publication field, so one additional anchored
  // decision key is sufficient evidence. Without it, retain the stricter
  // three-key bar to avoid rewriting ordinary colon-led prose.
  if (found.size < 3 && !(found.has('reply') && found.size >= 2)) return null;

  const keyLines = [...found.values()].sort((a, b) => a - b);
  const firstKeyLine = keyLines[0];
  const preamble = lines.slice(0, firstKeyLine).join('\n').trim();

  // Each field runs from its own line until the next labelled line. Values are
  // kept verbatim and in order; only the label is removed.
  const blocks: string[] = [];
  const fields: Partial<Record<NarratedEnvelopeKey, string>> = {};
  for (let i = 0; i < keyLines.length; i++) {
    const start = keyLines[i];
    const end = i + 1 < keyLines.length ? keyLines[i + 1] : lines.length;
    const keyMatch = KEY_LINE_RE.exec(lines[start]);
    const key = keyMatch ? normalizeKey(keyMatch[1]) as NarratedEnvelopeKey : null;
    const head = lines[start].replace(KEY_LINE_RE, '');
    const value = [head, ...lines.slice(start + 1, end)].join('\n').trim();
    if (value) {
      blocks.push(value);
      if (key && ENVELOPE_KEYS.includes(key)) fields[key] = value;
    }
  }
  if (blocks.length === 0) return null;

  return { blocks, fields, preamble, keys: [...found.keys()] };
}

/**
 * Compatibility projection for a narrated envelope. Returns null for ordinary
 * prose and for an envelope without an explicit reply. When the preamble is a
 * question, put it last so the explanation leads naturally into the requested
 * user decision.
 */
export function publicReplyFromNarratedEnvelope(text: string): string | null {
  const parsed = parseNarratedEnvelope(text);
  if (!parsed) return null;
  const reply = parsed.fields.reply?.trim() ?? '';
  if (!reply) return null;
  if (!parsed.preamble) return reply;
  return parsed.preamble.includes('?')
    ? [reply, parsed.preamble].join('\n\n')
    : [parsed.preamble, reply].join('\n\n');
}

/**
 * Legacy API retained for callers during the publication-boundary migration.
 * Ordinary prose remains unchanged; narrated envelopes fail closed when they
 * do not contain an explicit reply.
 */
export function stripNarratedEnvelope(text: string): string {
  const parsed = parseNarratedEnvelope(text);
  if (!parsed) return text;
  return publicReplyFromNarratedEnvelope(text) ?? '';
}
