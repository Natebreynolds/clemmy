import { SOURCE_APPROVAL_CHECKPOINTS_KEY, sourceApprovalCheckpointPath as sourcePath, sourceApprovalSnapshotFromMetadata, hostApprovalCheckpointSource, type ApprovalCheckpointIdentity, type SourceApprovalCheckpoint, type ApprovalCheckpointSnapshot, type StoredCheckpoint } from './source-approval-checkpoint-data.js';
export { SOURCE_APPROVAL_CHECKPOINTS_KEY, sourceApprovalSnapshotFromMetadata, hostApprovalCheckpointSource } from './source-approval-checkpoint-data.js';
export type { ApprovalCheckpointIdentity, SourceApprovalCheckpoint, ApprovalCheckpointSnapshot } from './source-approval-checkpoint-data.js';
const KEY = SOURCE_APPROVAL_CHECKPOINTS_KEY;
/** Durable context for independently parked sources. These records never grant
 * execution authority: resume still redeems the exact consent and call ledger.
 * Revision tombstones prevent a stale activation resurrecting a cleared pause.
 */
import { randomUUID } from 'node:crypto';
import { getSession, listEvents, openEventLog } from './eventlog.js';

export function readSourceApprovalCheckpoint(identity: ApprovalCheckpointIdentity): ApprovalCheckpointSnapshot {
  return sourceApprovalSnapshotFromMetadata(getSession(identity.sessionId)?.metadata ?? {}, identity.sourceUserSeq);
}

export function listSourceApprovalCheckpoints(sessionId: string): Array<ApprovalCheckpointIdentity & ApprovalCheckpointSnapshot> {
  const metadata = getSession(sessionId)?.metadata ?? {};
  const raw = metadata[KEY];
  if (raw == null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Malformed source approval checkpoint index');
  return Object.keys(raw).map(Number).sort((a, b) => a - b).flatMap(sourceUserSeq => {
    const identity = { sessionId, sourceUserSeq };
    const snapshot = sourceApprovalSnapshotFromMetadata(metadata, sourceUserSeq);
    return snapshot.checkpoint ? [{ ...identity, ...snapshot }] : [];
  });
}

function validateCheckpoint(identity: ApprovalCheckpointIdentity, checkpoint: SourceApprovalCheckpoint): void {
  const source = listEvents(identity.sessionId, { sinceSeq: identity.sourceUserSeq - 1,
    types: ['user_input_received'], limit: 1 })[0];
  if (source?.seq !== identity.sourceUserSeq || source.role !== 'user' || source.data.synthetic === true) {
    throw new Error('Approval checkpoint source is not an accepted user event');
  }
  const state = JSON.parse(checkpoint.serialized) as {
    __clemHostInterrupt?: unknown;
    acceptedModelBatchRef?: ApprovalCheckpointIdentity;
    pending?: Array<{ consentSubject?: ApprovalCheckpointIdentity }>;
  };
  if (!Number.isInteger(state.__clemHostInterrupt) || !Array.isArray(state.pending)) {
    throw new Error('Source approval checkpoint requires host-owned interruption bytes');
  }
  const identities = [state.acceptedModelBatchRef,
    ...state.pending.map(call => call.consentSubject)].filter((value): value is ApprovalCheckpointIdentity => Boolean(value));
  if (!identities.length || identities.some(value => value.sessionId !== identity.sessionId
    || value.sourceUserSeq !== identity.sourceUserSeq)) {
    throw new Error('Approval checkpoint bytes do not belong to the selected source');
  }
}

/** Compare-and-swap ONLY this source's record, preserving sibling pauses and
 * unrelated session metadata. A caller must retain the snapshot it observed. */
export function replaceSourceApprovalCheckpoint(input: ApprovalCheckpointIdentity & {
  expectedRevision: string | null;
  checkpoint: SourceApprovalCheckpoint | null;
}): { updated: true; snapshot: ApprovalCheckpointSnapshot } | { updated: false } {
  const path = sourcePath(input);
  return openEventLog().transaction(() => {
    if (!getSession(input.sessionId)) throw new Error('Unknown approval checkpoint session');
    const prior = readSourceApprovalCheckpoint(input);
    if (prior.revision !== input.expectedRevision) return { updated: false } as const;
    if (input.checkpoint) validateCheckpoint(input, input.checkpoint);
    const snapshot: StoredCheckpoint = {
      revision: randomUUID(),
      checkpoint: input.checkpoint ? JSON.parse(JSON.stringify(input.checkpoint)) : null,
    };
    openEventLog().prepare(`UPDATE sessions SET metadata_json = json_set(metadata_json, ?, json(?)),
      updated_at = ? WHERE id = ?`).run(path, JSON.stringify(snapshot), new Date().toISOString(), input.sessionId);
    return { updated: true, snapshot } as const;
  }).immediate();
}
