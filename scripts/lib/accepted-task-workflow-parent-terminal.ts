import path from 'node:path';
import Database from 'better-sqlite3';
import { workflowParentTerminalIdentityFromSnapshot, type WorkflowParentProofEvent,
  type WorkflowParentTerminalIdentityInput } from '../../src/execution/workflow-parent-terminal-proof-data.js';

interface StoredEvent { id: string; seq: number; turn: number; session_id: string; type: string; role: string; data_json: string }
function eventFromRow(row: StoredEvent): WorkflowParentProofEvent | null {
  let data: unknown;
  try { data = JSON.parse(row.data_json); } catch { return null; }
  return data && typeof data === 'object' && !Array.isArray(data)
    ? { id: row.id, seq: row.seq, turn: row.turn, sessionId: row.session_id, type: row.type, role: row.role,
      data: data as Record<string, unknown> } : null;
}

/** Full parent-terminal predicate against one explicit read-only store. The
 * shared pure matcher keeps runtime and accounting evidence rules identical;
 * an unavailable/older/malformed store supplies no retention waiver. */
export function readAcceptedTaskWorkflowParentTerminalIdentity(home: string,
  input: WorkflowParentTerminalIdentityInput): boolean {
  if (!path.isAbsolute(home) || !Number.isSafeInteger(input.terminal.sourceUserSeq)
    || input.terminal.sourceUserSeq <= 0) return false;
  let db: Database.Database;
  try { db = new Database(path.join(home, 'state', 'harness.db'), { readonly: true, fileMustExist: true, timeout: 5_000 }); }
  catch { return false; }
  try {
    db.pragma('query_only = ON');
    return db.transaction(() => {
      const terminalRows = db.prepare(`SELECT id, seq, turn, session_id, type, role, data_json FROM events
        WHERE session_id = ? AND type = 'conversation_completed' AND id = ? LIMIT 2`)
        .all(input.terminal.sessionId, input.terminal.eventId) as StoredEvent[];
      if (terminalRows.length !== 1) return false;
      const terminalEvent = eventFromRow(terminalRows[0]!);
      if (!terminalEvent) return false;
      // Match getRunAttemptBySourceUserSeq exactly, scoped to this source.
      const attempt = db.prepare(`SELECT attempt_id FROM run_attempts WHERE session_id = ? AND source_user_seq = ?
        ORDER BY started_at DESC, rowid DESC LIMIT 1`)
        .get(input.terminal.sessionId, input.terminal.sourceUserSeq) as { attempt_id: string } | undefined;
      if (!attempt) return false;
      const requests = db.prepare(`SELECT id, seq, turn, session_id, type, role, data_json FROM events
        WHERE session_id = ? AND type = 'workflow_parent_continuation_requested' AND role = 'system' AND seq < ?
          AND CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.sourceUserSeq') = ?
            AND json_extract(data_json, '$.attemptId') = ? AND json_extract(data_json, '$.sourceGroupId') = ?
            AND json_extract(data_json, '$.sourceGroupDigest') = ? ELSE 0 END
        ORDER BY seq LIMIT 20001`).all(input.terminal.sessionId, terminalEvent.seq,
          input.terminal.sourceUserSeq, attempt.attempt_id, input.sourceGroupId, input.sourceGroupDigest) as StoredEvent[];
      if (requests.length > 20_000) return false;
      return workflowParentTerminalIdentityFromSnapshot(input, { terminalEvent,
        latestAttemptId: attempt.attempt_id,
        continuationRequests: requests.flatMap(row => { const event = eventFromRow(row); return event ? [event] : []; }) });
    })();
  } catch { return false; }
  finally { db.close(); }
}
