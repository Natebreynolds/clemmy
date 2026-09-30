/** A durable connection control identifies an existing execution, never a new
 * Execute claim. This reader uses only the event-log database and pure checks. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { presentationEventFromCompletionData } from './turn-outcome.js';
import { validateConnectionExecutionPause } from './connection-execution-pause-proof.js';

export interface ConnectionExecutionActivationV1 {
  version: 1;
  requestId: string;
  pauseEventId: string;
  checkpointDigest: string;
  executionSourceUserSeq: number;
  deliverySourceUserSeq: number;
  receiptRequestId: string;
  inputHash: string;
  runId: string;
  verificationBinding: string;
}

type Event = { id: string; seq: number; turn: number; role: string; parent_event_id: string | null; data_json: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function readConnectionExecutionActivation(db: Database.Database, input: {
  sessionId: string; deliverySourceUserSeq?: number; requestId?: string; activationEventId?: string;
}): { eventId: string; activation: ConnectionExecutionActivationV1 } | null {
  const invalid = (): never => { throw new Error('The connection continuation does not match its durable activation.'); };
  if (!input.sessionId || (!input.deliverySourceUserSeq && !input.requestId && !input.activationEventId)) return invalid();
  const rows = db.prepare(`SELECT id, seq, turn, role, parent_event_id, data_json FROM events
    WHERE session_id = ? AND type = 'run_resumed'
      AND json_extract(data_json, '$.connectionContinuationVersion') = 1
      AND (? IS NULL OR json_extract(data_json, '$.connectionContinuation.deliverySourceUserSeq') = ?)
      AND (? IS NULL OR json_extract(data_json, '$.connectionContinuation.requestId') = ?)
      AND (? IS NULL OR id = ?) ORDER BY seq LIMIT 2`)
    .all(input.sessionId, input.deliverySourceUserSeq ?? null, input.deliverySourceUserSeq ?? null,
      input.requestId ?? null, input.requestId ?? null, input.activationEventId ?? null, input.activationEventId ?? null) as Event[];
  if (!rows.length) return null;
  if (rows.length !== 1) return invalid();
  const event = rows[0]!;
  const a = JSON.parse(event.data_json).connectionContinuation as ConnectionExecutionActivationV1;
  if (event.role !== 'system' || !a || a.version !== 1
    || !Number.isSafeInteger(a.executionSourceUserSeq) || a.executionSourceUserSeq <= 0
    || !Number.isSafeInteger(a.deliverySourceUserSeq) || a.deliverySourceUserSeq <= a.executionSourceUserSeq
    || event.seq <= a.deliverySourceUserSeq
    || [a.requestId, a.pauseEventId, a.receiptRequestId, a.runId].some(value => typeof value !== 'string' || !value)
    || [a.checkpointDigest, a.inputHash, a.verificationBinding].some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) return invalid();
  // A lookup narrowed by control/event must still reject a second activation
  // for this dependency. A second device cannot establish another owner.
  const duplicates = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'run_resumed'
    AND json_extract(data_json, '$.connectionContinuationVersion') = 1
    AND json_extract(data_json, '$.connectionContinuation.requestId') = ?`)
    .get(input.sessionId, a.requestId) as { n: number };
  if (duplicates.n !== 1) return invalid();
  const control = db.prepare(`SELECT id, seq, turn, role, parent_event_id, data_json FROM events
    WHERE session_id = ? AND seq = ? AND type = 'user_input_received'`)
    .get(input.sessionId, a.deliverySourceUserSeq) as Event | undefined;
  const pause = db.prepare(`SELECT id, seq, turn, role, parent_event_id, data_json FROM events
    WHERE session_id = ? AND id = ? AND type = 'conversation_completed'`)
    .get(input.sessionId, a.pauseEventId) as Event | undefined;
  if (!control || control.role !== 'user' || event.parent_event_id !== control.id || event.turn !== control.turn
    || !pause || pause.seq >= control.seq || pause.seq <= a.executionSourceUserSeq) return invalid();
  const data = JSON.parse(control.data_json);
  const receipt = db.prepare(`SELECT session_id, run_id, input_hash FROM harness_chat_requests WHERE request_id = ?`)
    .get(a.receiptRequestId) as { session_id: string; run_id: string; input_hash: string } | undefined;
  const expectedRequestId = `connection-${hash(a.requestId).slice(0, 32)}`;
  const inputHash = hash(JSON.stringify({ connectionRequestId: a.requestId, sessionId: input.sessionId, text: data.text }));
  if (typeof data.text !== 'string' || data.source !== 'connection_continuation'
    || data.connectionRequestId !== a.requestId || data.requestId !== a.receiptRequestId
    || data.clientRequestId !== a.receiptRequestId || data.runId !== a.runId || a.receiptRequestId !== expectedRequestId
    || receipt?.session_id !== input.sessionId || receipt.run_id !== a.runId
    || receipt.input_hash !== a.inputHash || inputHash !== a.inputHash) return invalid();
  const pauseData = JSON.parse(pause.data_json);
  const presentation = presentationEventFromCompletionData(pauseData);
  if (!presentation || presentation.identity.sessionId !== input.sessionId || presentation.identity.turn !== pause.turn
    || presentation.identity.sourceUserSeq !== a.executionSourceUserSeq) return invalid();
  const retained = validateConnectionExecutionPause({ db, presentation, metadata: pauseData, historical: true });
  if (!retained || retained.requestId !== a.requestId || retained.checkpointDigest !== a.checkpointDigest) return invalid();
  return { eventId: event.id, activation: { ...a } };
}
