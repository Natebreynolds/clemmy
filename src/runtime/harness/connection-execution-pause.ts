/** An explicit, private binding between one public connection pause and its
 * retained reviewed execution. A generic question or an old dependency row is
 * never enough to keep execution authority alive. */
import { createHash } from 'node:crypto';
import { openEventLog, readValidatedTerminalEvent } from './eventlog.js';
import { readSourceConnectionCheckpoint } from './source-connection-checkpoints.js';
import { readSourceConnectionHostRecovery } from './connection-host-recovery.js';
import { validateConnectionExecutionPause, type ConnectionExecutionPauseV1 } from './connection-execution-pause-proof.js';
export type { ConnectionExecutionPauseV1 } from './connection-execution-pause-proof.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function retained(input: { sessionId: string; binding: ConnectionExecutionPauseV1 }) {
  const checkpoint = readSourceConnectionCheckpoint({ sessionId: input.sessionId, requestId: input.binding.requestId });
  if (!checkpoint || checkpoint.sourceUserSeq !== input.binding.executionSourceUserSeq
    || digest(checkpoint) !== input.binding.checkpointDigest || !checkpoint.agent?.modelId
    || !checkpoint.agent.sessionContext || !checkpoint.hostProgress
    || checkpoint.agent.sessionContext.sessionId !== input.sessionId
    || checkpoint.agent.sessionContext.sourceUserSeq !== checkpoint.sourceUserSeq) {
    throw new Error('The connection pause has no matching complete execution checkpoint.');
  }
  return checkpoint;
}

/** Used only beside an actual typed connection pause, after checkpoint
 * capture. Missing historical context leaves the existing needs-input path;
 * it cannot be upgraded into resumable execution by filling current defaults. */
export function prepareConnectionExecutionPause(input: {
  sessionId: string; sourceUserSeq: number; requestId: string;
}): ConnectionExecutionPauseV1 | undefined {
  try {
    const checkpoint = readSourceConnectionCheckpoint(input);
    if (!checkpoint || checkpoint.sourceUserSeq !== input.sourceUserSeq) return undefined;
    const binding: ConnectionExecutionPauseV1 = { version: 1, requestId: input.requestId,
      executionSourceUserSeq: checkpoint.sourceUserSeq, checkpointDigest: digest(checkpoint) };
    retained({ sessionId: input.sessionId, binding });
    if (readSourceConnectionHostRecovery(input).rootState !== 'open') return undefined;
    return binding;
  } catch { return undefined; }
}

/** Read an already committed pause for the exact dependency, without granting
 * a new activation or touching current connection/provider state. */
export function readConnectionExecutionPause(sessionId: string, requestId: string): {
  eventId: string; sourceUserSeq: number; binding: ConnectionExecutionPauseV1;
} | null {
  const db = openEventLog();
  const rows = db.prepare(`SELECT id, data_json FROM events WHERE session_id = ? AND type = 'conversation_completed'
    AND json_extract(data_json, '$.connectionExecutionPause.requestId') = ? ORDER BY seq LIMIT 2`)
    .all(sessionId, requestId) as Array<{ id: string; data_json: string }>;
  if (!rows.length) return null;
  if (rows.length !== 1) throw new Error('The connection has more than one execution pause.');
  const metadata = JSON.parse(rows[0]!.data_json) as Record<string, unknown>;
  const claimed = metadata.connectionExecutionPause as ConnectionExecutionPauseV1 | undefined;
  if (!claimed || !Number.isSafeInteger(claimed.executionSourceUserSeq)) throw new Error('The retained connection pause has no execution source.');
  const event = readValidatedTerminalEvent(rows[0]!.id, sessionId, claimed.executionSourceUserSeq);
  const presentation = event.data.presentation as import('./turn-outcome.js').PresentationEvent;
  const binding = validateConnectionExecutionPause({ db, presentation, metadata: event.data, historical: true });
  if (!binding) throw new Error('The retained connection pause lost its execution binding.');
  retained({ sessionId, binding });
  return { eventId: rows[0]!.id, sourceUserSeq: binding.executionSourceUserSeq, binding };
}
