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

/**
 * Render the IRREVERSIBLE external actions that already SUCCEEDED in this session,
 * so a brain returning to an existing chat KNOWS what it already did. The text
 * transcript (user_input/conversation_completed) does NOT include tool results, so
 * without this the brain is blind to its own completed sends — the 2026-06-29
 * double-send (it re-ran a send because the prior turn's text didn't record it,
 * and an errored turn emits no conversation_completed at all). Reads external_write
 * events; deduped by (shape, target), newest first. '' when nothing was sent.
 */
export function renderRecentSessionActions(
  db: ReturnType<typeof openEventLog>,
  sessionId: string,
  limit = 20,
): string {
  let rows: Array<{ data_json: string }>;
  try {
    rows = db.prepare(
      `SELECT data_json FROM events WHERE session_id = ? AND type = 'external_write' ORDER BY seq DESC LIMIT ?`,
    ).all(sessionId, limit) as Array<{ data_json: string }>;
  } catch { return ''; }
  if (rows.length === 0) return '';
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const row of rows) {
    try {
      const d = JSON.parse(row.data_json) as { shapeKey?: string; toolName?: string; targets?: string[] };
      const shape = String(d.shapeKey ?? d.toolName ?? 'action');
      const targets = (d.targets ?? []).filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
      for (const t of (targets.length ? targets : ['(no target)'])) {
        const key = `${shape}::${t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`- ${shape} → ${t}`);
      }
    } catch { /* skip malformed rows */ }
  }
  if (lines.length === 0) return '';
  return [
    'ALREADY DONE in THIS conversation — these external actions SUCCEEDED earlier in this same session. Do NOT repeat any of them unless the user EXPLICITLY asks you to do it AGAIN. A prior turn that errored AFTER one of these still COUNTS as done — it was NOT cancelled:',
    ...lines,
  ].join('\n');
}

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
        const reply = typeof data.reply === 'string' && data.reply.trim() ? data.reply.trim() : '';
        const summary = typeof data.summary === 'string' && data.summary.trim() ? data.summary.trim() : '';
        const text = reply || summary;
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
