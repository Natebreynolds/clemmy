/** Pure retained checkpoint metadata codecs; no store or execution authority. */
import type { McpToolScope } from '../mcp-tool-scope.js';

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
export interface StoredCheckpoint extends ApprovalCheckpointSnapshot { revision: string }

export function sourceApprovalCheckpointPath(identity: ApprovalCheckpointIdentity): string {
  if (!Number.isSafeInteger(identity.sourceUserSeq) || identity.sourceUserSeq <= 0) {
    throw new Error('Approval checkpoint requires an exact accepted source');
  }
  return `$.${KEY}."${identity.sourceUserSeq}"`;
}

export function sourceApprovalSnapshotFromMetadata(
  metadata: Record<string, unknown>, sourceUserSeq: number,
): ApprovalCheckpointSnapshot {
  sourceApprovalCheckpointPath({ sessionId: '', sourceUserSeq });
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
