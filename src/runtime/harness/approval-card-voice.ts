import { openEventLog } from './eventlog.js';

/**
 * Clem's own question for an approval card, as its approval_requested event
 * carries it (the checker wrote it from the exact call). Needs you, Home and
 * the phone title the card with it instead of an operation name. Display
 * only; one session-scoped read per pending card.
 */
export function approvalCardAsk(sessionId: string, approvalId: string): string | null {
  return approvalCardVoice(sessionId, approvalId)?.ask ?? null;
}

/** The card's question and why, as its approval_requested event carries them. */
export function approvalCardVoice(sessionId: string, approvalId: string): { ask: string; why?: string } | null {
  try {
    const rows = openEventLog().prepare(`
      SELECT data_json AS dataJson FROM events
       WHERE session_id = ? AND type = 'approval_requested'
         AND json_extract(data_json, '$.approvalId') = ?
       ORDER BY seq DESC LIMIT 1
    `).all(sessionId, approvalId) as Array<{ dataJson: string }>;
    const data = rows[0] ? JSON.parse(rows[0].dataJson) as Record<string, unknown> : null;
    const preview = data?.preview && typeof data.preview === 'object' && !Array.isArray(data.preview)
      ? data.preview as Record<string, unknown>
      : null;
    const ask = typeof preview?.ask === 'string' ? preview.ask.trim() : '';
    const why = typeof preview?.why === 'string' ? preview.why.trim() : '';
    return ask ? { ask: ask.slice(0, 200), ...(why ? { why: why.slice(0, 260) } : {}) } : null;
  } catch {
    return null;
  }
}
