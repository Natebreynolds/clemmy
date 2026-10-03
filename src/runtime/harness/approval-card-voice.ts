import { openEventLog } from './eventlog.js';

/**
 * Clem's own question for an approval card, as its approval_requested event
 * carries it (the checker wrote it from the exact call). Needs you, Home and
 * the phone title the card with it instead of an operation name. Display
 * only; one session-scoped read per pending card.
 */
export function approvalCardAsk(sessionId: string, approvalId: string): string | null {
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
    return ask ? ask.slice(0, 200) : null;
  } catch {
    return null;
  }
}
