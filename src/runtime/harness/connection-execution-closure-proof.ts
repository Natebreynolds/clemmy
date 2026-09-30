/** A binding to the existing terminal authority, not a second completion
 * decision. Eventlog writes it in the same transaction that closes execution.
 * Keep this module free of model, provider and eventlog runtime imports. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { presentationEventFromCompletionData, type PresentationEvent } from './turn-outcome.js';
import { readConnectionExecutionDelivery } from './connection-execution-activation-proof.js';

export function hostTurnCallAuthorityTerminalTarget(presentation: PresentationEvent): {
  state: 'closed' | 'conflict'; reason: string;
} | null {
  if (presentation.status === 'needs_input' && presentation.needs?.kind === 'approval') return null;
  switch (presentation.status) {
    case 'done': return { state: 'closed', reason: 'host_completed' };
    case 'blocked': return { state: 'closed', reason: 'host_blocked' };
    case 'cancelled': return { state: 'closed', reason: 'host_cancelled' };
    case 'needs_input': return { state: 'closed', reason: 'host_needs_input' };
    case 'failed': return { state: 'conflict', reason: 'host_failed' };
    case 'uncertain': return { state: 'conflict', reason: 'host_uncertain' };
    case 'transferred': return { state: 'conflict', reason: 'host_transferred' };
  }
}

interface ClosureRow {
  session_id: string;
  execution_source_user_seq: number;
  delivery_source_user_seq: number;
  activation_event_id: string;
  terminal_event_id: string;
  terminal_digest: string;
}
type TerminalRow = { id: string; session_id: string; seq: number; turn: number; role: string;
  type: string; data_json: string; created_at: string };
const digest = (row: TerminalRow) => createHash('sha256').update(JSON.stringify([
  row.id, row.session_id, row.seq, row.turn, row.role, row.type, row.data_json, row.created_at,
])).digest('hex');

function table(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS source_connection_execution_closures_v1 (
    session_id TEXT NOT NULL, execution_source_user_seq INTEGER NOT NULL,
    delivery_source_user_seq INTEGER NOT NULL, activation_event_id TEXT NOT NULL,
    terminal_event_id TEXT NOT NULL UNIQUE, terminal_digest TEXT NOT NULL,
    PRIMARY KEY (session_id, execution_source_user_seq),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (activation_event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (terminal_event_id) REFERENCES events(id) ON DELETE CASCADE
  );
  CREATE TRIGGER IF NOT EXISTS source_connection_execution_closures_v1_no_update
    BEFORE UPDATE ON source_connection_execution_closures_v1
    BEGIN SELECT RAISE(ABORT, 'connection closure is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS source_connection_execution_closures_v1_no_delete
    BEFORE DELETE ON source_connection_execution_closures_v1
    WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
    BEGIN SELECT RAISE(ABORT, 'connection closure is immutable'); END;`);
}

export function readConnectionExecutionClosure(db: Database.Database, input: {
  sessionId: string; executionSourceUserSeq: number;
}): { terminalEventId: string; deliverySourceUserSeq: number; activationEventId: string } | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_connection_execution_closures_v1'").get()) return null;
  const closure = db.prepare(`SELECT * FROM source_connection_execution_closures_v1
    WHERE session_id = ? AND execution_source_user_seq = ?`).get(input.sessionId, input.executionSourceUserSeq) as ClosureRow | undefined;
  if (!closure) return null;
  const invalid = (): never => { throw new Error('The connection execution lost its exact terminal closure.'); };
  const terminal = db.prepare('SELECT * FROM events WHERE id = ?').get(closure.terminal_event_id) as TerminalRow | undefined;
  const marker = readConnectionExecutionDelivery(db, { sessionId: input.sessionId,
    deliverySourceUserSeq: closure.delivery_source_user_seq }, true);
  const activationSeq = db.prepare('SELECT seq FROM events WHERE id = ?').get(closure.activation_event_id) as { seq: number } | undefined;
  if (!marker || marker.eventId !== closure.activation_event_id || marker.activation.executionSourceUserSeq !== input.executionSourceUserSeq
    || !terminal || terminal.session_id !== input.sessionId || terminal.role !== 'system'
    || terminal.type !== 'conversation_completed' || !activationSeq || terminal.seq <= activationSeq.seq
    || digest(terminal) !== closure.terminal_digest) return invalid();
  const data = JSON.parse(terminal.data_json);
  const presentation = presentationEventFromCompletionData(data);
  if (!presentation || presentation.identity.sessionId !== input.sessionId || presentation.identity.turn !== terminal.turn
    || presentation.identity.sourceUserSeq !== closure.delivery_source_user_seq
    || data.sourceUserSeq !== closure.delivery_source_user_seq || data.connectionExecutionPause !== undefined
    || (closure.delivery_source_user_seq === marker.activation.deliverySourceUserSeq && data.runId !== marker.activation.runId)
    || typeof data.attemptId !== 'string' || typeof data.runId !== 'string'
    || !db.prepare('SELECT 1 FROM run_attempts WHERE session_id = ? AND source_user_seq = ? AND attempt_id = ? AND run_id = ?')
      .get(input.sessionId, closure.delivery_source_user_seq, data.attemptId, data.runId)) return invalid();
  const target = hostTurnCallAuthorityTerminalTarget(presentation);
  const root = db.prepare(`SELECT state, close_reason, closed_at FROM accepted_turn_call_authorities
    WHERE session_id = ? AND source_user_seq = ? AND authority_kind = 'host_v1'`)
    .get(input.sessionId, input.executionSourceUserSeq) as { state: string; close_reason: string; closed_at: string } | undefined;
  if (!target || root?.state !== target.state || root.close_reason !== target.reason || root.closed_at !== terminal.created_at) return invalid();
  const task = db.prepare(`SELECT state, terminal_event_id FROM accepted_task_authority
    WHERE session_id = ? AND source_user_seq = ?`).get(input.sessionId, input.executionSourceUserSeq) as {
    state: string; terminal_event_id: string | null;
  } | undefined;
  if (task && (task.terminal_event_id !== terminal.id || !['terminal', 'conflict'].includes(task.state))) return invalid();
  return { terminalEventId: terminal.id, deliverySourceUserSeq: closure.delivery_source_user_seq,
    activationEventId: closure.activation_event_id };
}

/** Called only by eventlog after both existing terminal lifecycle validators
 * succeed. The binding and terminal are committed or rolled back together. */
export function bindConnectionExecutionClosure(db: Database.Database, input: {
  sessionId: string; executionSourceUserSeq: number; deliverySourceUserSeq: number;
  activationEventId: string; terminalEventId: string;
}): void {
  if (!db.inTransaction) throw new Error('Connection closure requires the terminal publication transaction.');
  table(db);
  const terminal = db.prepare('SELECT * FROM events WHERE id = ?').get(input.terminalEventId) as TerminalRow | undefined;
  if (!terminal) throw new Error('Connection closure requires its persisted terminal.');
  db.prepare('INSERT INTO source_connection_execution_closures_v1 VALUES (?, ?, ?, ?, ?, ?)')
    .run(input.sessionId, input.executionSourceUserSeq, input.deliverySourceUserSeq,
      input.activationEventId, input.terminalEventId, digest(terminal));
  if (!readConnectionExecutionClosure(db, input)) throw new Error('Connection closure was not persisted.');
}
