/**
 * Strip a NARRATED decision envelope out of a user-facing reply.
 *
 * Live 2026-07-31 on 3.5.0: a user was shown Clem's internal decision object as
 * prose — a question, then `summary:`, `reply:`, `done:`, `nextAction:`,
 * `reason:` lines. Those are the orchestrator's own contract field names. The
 * model had emitted the envelope as TEXT instead of returning it structurally,
 * and the whole blob went to the chat, so the user read Clem's bookkeeping
 * instead of Clem's answer.
 *
 * This is a display-layer repair, not model steering: when a reply provably
 * narrates the envelope, surface the `reply:` field — the part actually written
 * for the human — and drop the rest. Everything remains in the transcript and
 * event log; only the rendered text changes.
 *
 * Conservative by design. It requires THREE distinct contract keys at line
 * starts before it will touch anything, so ordinary prose that happens to
 * contain "summary:" or a colon-led list is never rewritten. If the envelope is
 * present but carries no usable `reply`, the original text is returned
 * unchanged — a partial parse must never blank out the only answer the user has.
 */

/** The orchestrator's decision-envelope fields, as the model would label them. */
const ENVELOPE_KEYS = ['summary', 'reply', 'done', 'nextaction', 'reason'] as const;

const KEY_LINE_RE = /^[ \t>*-]*(summary|reply|done|next\s*action|nextaction|reason)\s*:\s*/i;

function normalizeKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z]/g, '');
}

export interface NarratedEnvelope {
  /** Text written for the human — the `reply` field. */
  reply: string;
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
  // Three distinct contract fields is the evidence bar: fewer is ordinary prose
  // that happens to use a colon.
  if (found.size < 3) return null;

  const firstKeyLine = Math.min(...found.values());
  const preamble = lines.slice(0, firstKeyLine).join('\n').trim();

  const replyLine = found.get('reply');
  if (replyLine === undefined) return null;

  // The reply runs from its own line until the next contract-key line.
  const laterKeyLines = [...found.values()].filter((n) => n > replyLine);
  const end = laterKeyLines.length > 0 ? Math.min(...laterKeyLines) : lines.length;
  const firstLine = lines[replyLine].replace(KEY_LINE_RE, '');
  const reply = [firstLine, ...lines.slice(replyLine + 1, end)].join('\n').trim();
  if (!reply) return null;

  return { reply, preamble, keys: [...found.keys()] };
}

/**
 * User-facing text for a reply that may narrate the envelope. Returns the input
 * unchanged when it does not. The preamble is preserved ahead of the reply,
 * because in the live case it carried the actual question to the user.
 */
export function stripNarratedEnvelope(text: string): string {
  const parsed = parseNarratedEnvelope(text);
  if (!parsed) return text;
  return [parsed.preamble, parsed.reply].filter(Boolean).join('\n\n');
}
