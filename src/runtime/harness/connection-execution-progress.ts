/** The running connection continuation's consumed allowances, without a second
 * copy of conversation history. Recovery must separately reopen the exact
 * current batch, account, Stop state and executor lease. */
import { createHash } from 'node:crypto';
import { getSession, openEventLog } from './eventlog.js';
import { assertHostConnectionProgress, type HostConnectionProgress } from './host-connection-progress.js';
import { assertRecoveryActivationOwned, readConnectionRecoveryActivation, recoveryActivationOwner,
  type RecoveryActivationOwner } from './recovery-activation.js';

const KEY = '__connection_execution_progress';
const digest = (json: string) => createHash('sha256').update(json).digest('hex');
interface ProgressRecord {
  version: 1;
  activationEventId: string;
  deliverySourceUserSeq: number;
  attemptId: string;
  progress: HostConnectionProgress;
}

/** Called at host boundaries, not from browser/model input. Storage failure
 * must stop dispatch: silently losing spent allowances would buy a new budget
 * on restart. No-op outside a connection execution activation. */
export function retainConnectionExecutionProgress(progress: HostConnectionProgress): void {
  const { sessionId, sourceUserSeq } = progress.batch;
  const owner = recoveryActivationOwner(sessionId, { sourceUserSeq });
  if (!owner.connectionContinuation) return;
  assertRecoveryActivationOwned();
  assertHostConnectionProgress(progress);
  const current = readConnectionRecoveryActivation(sessionId);
  if (!owner.attemptId || !current || current.attemptId !== owner.attemptId
    || current.sourceUserSeq !== owner.sourceUserSeq
    || current.connectionContinuation?.activationEventId !== owner.connectionContinuation.activationEventId
    || current.connectionContinuation.requestSourceUserSeq !== sourceUserSeq) {
    throw new Error('The running connection progress lost its execution owner.');
  }
  const batch = progress.batch;
  const record: ProgressRecord = { version: 1, activationEventId: owner.connectionContinuation.activationEventId,
    deliverySourceUserSeq: owner.sourceUserSeq, attemptId: owner.attemptId,
    progress: { ...progress, batch: { sessionId, sourceUserSeq, acceptedTaskId: batch.acceptedTaskId,
      batchOrdinal: batch.batchOrdinal, batchId: batch.batchId, authorityDigest: batch.authorityDigest } } };
  const json = JSON.stringify(record);
  const now = new Date().toISOString();
  const result = openEventLog().prepare(`UPDATE sessions SET metadata_json = json_set(metadata_json,
    '$.${KEY}', json(?)) WHERE id = ?
    AND json_extract(metadata_json, '$.__continuation_owner.sourceUserSeq') = ?
    AND json_extract(metadata_json, '$.__continuation_owner.attemptId') = ?
    AND EXISTS (SELECT 1 FROM run_attempts a WHERE a.session_id = sessions.id
      AND a.attempt_id = ? AND a.source_user_seq = ? AND a.status = 'active'
      AND a.finished_at IS NULL AND a.lease_expires_at > ?)`)
    .run(JSON.stringify({ json, digest: digest(json) }), sessionId, owner.sourceUserSeq, owner.attemptId,
      owner.attemptId, owner.sourceUserSeq, now);
  if (result.changes !== 1) throw new Error('The running connection progress could not be retained by its executor.');
}

/** Historical progress is context only. The caller must prove current task
 * ownership and exact canonical batch freshness before installing recovery. */
export function readConnectionExecutionProgress(sessionId: string, owner: RecoveryActivationOwner): HostConnectionProgress | null {
  const raw = getSession(sessionId)?.metadata[KEY] as { json?: unknown; digest?: unknown } | undefined;
  if (raw === undefined) return null;
  const invalid = (): never => { throw new Error('The running connection progress is inconsistent with its exact owner.'); };
  if (typeof raw?.json !== 'string' || typeof raw.digest !== 'string' || digest(raw.json) !== raw.digest) return invalid();
  const record = JSON.parse(raw.json) as ProgressRecord;
  if (!record || record.version !== 1 || !owner.connectionContinuation || !owner.attemptId
    || record.activationEventId !== owner.connectionContinuation.activationEventId
    || record.deliverySourceUserSeq !== owner.sourceUserSeq || record.attemptId !== owner.attemptId) return invalid();
  assertHostConnectionProgress(record.progress);
  if (record.progress.batch.sessionId !== sessionId
    || record.progress.batch.sourceUserSeq !== owner.connectionContinuation.requestSourceUserSeq) return invalid();
  return record.progress;
}
