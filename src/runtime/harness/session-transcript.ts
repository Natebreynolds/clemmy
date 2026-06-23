/**
 * session-transcript — a neutral, event-log-backed reader for a session's recent
 * conversation turns, shared by the Discord cross-session prefix and the Claude
 * brain's within-session history injection. Lives in runtime/harness (a low-level
 * module) so claude-agent-brain.ts can import it without a cycle through the
 * channel layer (discord-harness.ts). The Claude brain writes both
 * user_input_received and conversation_completed to the event log, so this returns
 * the brain's own prior turns with no schema change.
 */
import { openEventLog } from './eventlog.js';

export interface PriorTurn { who: 'user' | 'assistant'; text: string; at: string }

/** Read the recent user+assistant turns for ONE session, chronological order. */
export function pullRecentTurnsForSession(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  maxTurns: number,
): PriorTurn[] {
  // Read the last 2*maxTurns events (user inputs + agent completions) so we have
  // headroom to filter and reorder chronologically.
  const rows = db.prepare(
    `SELECT type, data_json, created_at FROM events
       WHERE session_id = ?
         AND type IN ('user_input_received', 'conversation_completed')
       ORDER BY seq DESC
       LIMIT ?`,
  ).all(sessionId, maxTurns * 2) as Array<{ type: string; data_json: string; created_at: string }>;
  const turns: PriorTurn[] = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as { text?: string; summary?: string; reply?: string };
      if (row.type === 'user_input_received' && typeof data.text === 'string') {
        turns.push({ who: 'user', text: data.text, at: row.created_at });
      } else if (row.type === 'conversation_completed') {
        // Prefer the user-facing summary (already trimmed); fall back to reply.
        const text = typeof data.summary === 'string' && data.summary
          ? data.summary
          : (typeof data.reply === 'string' ? data.reply : '');
        if (text) turns.push({ who: 'assistant', text, at: row.created_at });
      }
    } catch { /* skip malformed rows */ }
  }
  // Newest last (chronological); cap to maxTurns of each kind.
  turns.reverse();
  return turns.slice(-maxTurns * 2);
}

const TURN_TRIM = 800;

/** Render prior turns as USER:/YOU: lines (per-turn 800-char trim). The caller
 *  adds any header. Used by both the cross-session prefix and the brain history. */
export function renderTranscriptTurns(turns: Array<{ who: 'user' | 'assistant'; text: string }>): string {
  return turns
    .map((t) => {
      const label = t.who === 'user' ? 'USER' : 'YOU';
      const trimmed = t.text.length > TURN_TRIM ? `${t.text.slice(0, TURN_TRIM)}…` : t.text;
      return `  ${label}: ${trimmed}`;
    })
    .join('\n');
}
