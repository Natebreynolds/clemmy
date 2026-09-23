/** Durable context for independently parked sources. These records never grant
 * execution authority: resume still redeems the exact consent and call ledger.
 * Revision tombstones prevent a stale activation resurrecting a cleared pause.
 */
import { randomUUID } from 'node:crypto';
import type { McpToolScope } from '../mcp-tool-scope.js';
import { getSession, listEvents, openEventLog } from './eventlog.js';

export const SOURCE_APPROVAL_CHECKPOINTS_KEY = '__source_approval_checkpoints';
const KEY = SOURCE_APPROVAL_CHECKPOINTS_KEY;
export interface ApprovalCheckpointIdentity { sessionId: string; sourceUserSeq: number }
export interface SourceApprovalCheckpoint {
  serialized: string;
  mcpToolScope: McpToolScope | null;
}
export interface ApprovalCheckpointSnapshot {
  revision: string | null;
  checkpoint: SourceApprovalCheckpoint | null;
}
interface StoredCheckpoint extends ApprovalCheckpointSnapshot { revision: string }

function sourcePath(identity: ApprovalCheckpointIdentity): string {
  if (!Number.isSafeInteger(identity.sourceUserSeq) || identity.sourceUserSeq <= 0) {
    throw new Error('Approval checkpoint requires an exact accepted source');
  }
  return `$.${KEY}."${identity.sourceUserSeq}"`;
}

export function sourceApprovalSnapshotFromMetadata(
  metadata: Record<string, unknown>, sourceUserSeq: number,
): ApprovalCheckpointSnapshot {
  sourcePath({ sessionId: '', sourceUserSeq });
  const raw = metadata[KEY];
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error('Malformed source approval checkpoint index');
  }
  const entry = (raw as Record<string, StoredCheckpoint> | undefined)?.[String(sourceUserSeq)];
  if (!entry) return { revision: null, checkpoint: null };
  if (typeof entry.revision !== 'string' || !entry.revision
    || (entry.checkpoint !== null && typeof entry.checkpoint?.serialized !== 'string')) {
    throw new Error('Malformed source approval checkpoint');
  }
  return JSON.parse(JSON.stringify(entry)) as ApprovalCheckpointSnapshot;
}

export function readSourceApprovalCheckpoint(identity: ApprovalCheckpointIdentity): ApprovalCheckpointSnapshot {
  return sourceApprovalSnapshotFromMetadata(getSession(identity.sessionId)?.metadata ?? {}, identity.sourceUserSeq);
}

/** Extract context identity without importing the runner into session storage.
 * Legacy SDK/early host pauses remain on their historical storage path. */
export function hostApprovalCheckpointSource(serialized: string, sessionId: string): number | undefined {
  let state: any;
  try { state = JSON.parse(serialized); } catch { return undefined; }
  if (!state || !Number.isInteger(state.__clemHostInterrupt)) return undefined;
  const identities = [state.acceptedModelBatchRef,
    ...(Array.isArray(state.pending) ? state.pending.map((call: any) => call?.consentSubject) : [])].filter(Boolean);
  if (!identities.length) return undefined;
  const source = identities[0].sourceUserSeq;
  if (!Number.isSafeInteger(source) || source <= 0 || identities.some(value =>
    value.sessionId !== sessionId || value.sourceUserSeq !== source)) {
    throw new Error('Approval checkpoint bytes do not belong to one exact source');
  }
  return source;
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
