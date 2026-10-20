/** Display-only result jobs. None of these serialized fields grants execution. */
import { createHash } from 'node:crypto';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';

export const APPROVED_ACTION_RESULT_PROJECTION_JOBS_TABLE = 'approved_action_result_projection_jobs_v1';
export const APPROVED_ACTION_RESULT_PROJECTION_RESULTS_TABLE = 'approved_action_result_projections_v1';
export const APPROVED_ACTION_RESULT_PROJECTION_MAX_RAW_BYTES = 65_536;
export const APPROVED_ACTION_RESULT_PROJECTION_MAX_TEXT = 600;
export interface ApprovedActionResultProjectionBinding {
  version: 1;
  sessionId: string;
  sourceUserSeq: number;
  attemptId: string;
  originalSourceUserSeq: number;
  originalSourceDigest: string;
  sourceDigest: string;
  terminalEventId: string;
  terminalDigest: string;
  approvalId: string;
  pendingActionId: string;
  payloadHash: string;
  recordUpdatedAt: string;
  resultSummaryDigest: string;
  approvalSnapshotDigest: string;
  executionAuthorityDigest: string;
  claimHash: string;
  intentId: string;
  completionReceiptId: string;
  completionReceiptDigest: string;
  logicalToolCallId: string;
  settlementDigest: string;
  resultHandleId: string;
  rawPayloadSha256: string;
  rawByteCount: number;
  retainedWorkNeedsVerification: boolean;
}
const KEYS: ReadonlyArray<keyof ApprovedActionResultProjectionBinding> = [
  'version', 'sessionId', 'sourceUserSeq', 'attemptId', 'originalSourceUserSeq', 'originalSourceDigest', 'sourceDigest',
  'terminalEventId', 'terminalDigest', 'approvalId', 'pendingActionId', 'payloadHash', 'recordUpdatedAt',
  'resultSummaryDigest', 'approvalSnapshotDigest', 'executionAuthorityDigest', 'claimHash', 'intentId',
  'completionReceiptId', 'completionReceiptDigest', 'logicalToolCallId', 'settlementDigest', 'resultHandleId',
  'rawPayloadSha256', 'rawByteCount', 'retainedWorkNeedsVerification',
];
const DIGEST_KEYS = ['originalSourceDigest', 'sourceDigest', 'terminalDigest', 'resultSummaryDigest',
  'approvalSnapshotDigest', 'executionAuthorityDigest', 'claimHash', 'completionReceiptDigest',
  'settlementDigest', 'rawPayloadSha256'] as const;
export const projectionTextDigest = (text: string): string => createHash('sha256').update(text).digest('hex');
export const projectionBindingDigest = (binding: ApprovedActionResultProjectionBinding): string =>
  projectionTextDigest(closedCanonicalJson(binding));
export const approvedActionResultProjectionId = (binding: ApprovedActionResultProjectionBinding): string =>
  `approved-result:v1:${projectionBindingDigest(binding)}`;

export function normalizeApprovedActionResultProjectionBinding(value: unknown): ApprovedActionResultProjectionBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = (input: unknown) => typeof input === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,255}$/.test(input);
  if (Object.keys(row).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(row, key)) || row.version !== 1
    || !Number.isSafeInteger(row.sourceUserSeq) || Number(row.sourceUserSeq) < 1
    || !Number.isSafeInteger(row.originalSourceUserSeq) || Number(row.originalSourceUserSeq) < 1
    || Number(row.originalSourceUserSeq) >= Number(row.sourceUserSeq)
    || !['sessionId', 'attemptId', 'terminalEventId', 'approvalId', 'pendingActionId', 'intentId', 'completionReceiptId', 'logicalToolCallId', 'resultHandleId'].every(key => id(row[key]))
    || !DIGEST_KEYS.every(key => typeof row[key] === 'string' && /^[a-f0-9]{64}$/.test(row[key] as string))
    || typeof row.payloadHash !== 'string' || !/^[a-f0-9]{16}$/.test(row.payloadHash)
    || typeof row.recordUpdatedAt !== 'string' || row.recordUpdatedAt.length > 64 || !Number.isFinite(Date.parse(row.recordUpdatedAt))
    || !Number.isSafeInteger(row.rawByteCount) || Number(row.rawByteCount) < 1
    || Number(row.rawByteCount) > APPROVED_ACTION_RESULT_PROJECTION_MAX_RAW_BYTES
    || typeof row.retainedWorkNeedsVerification !== 'boolean') return null;
  return Object.fromEntries(KEYS.map(key => [key, row[key]])) as unknown as ApprovedActionResultProjectionBinding;
}

export interface ApprovedActionResultProjection {
  id: string;
  revision: 1;
  evidenceDigest: string;
  textDigest: string;
  text: string;
  publishedAt: string;
}
export interface ApprovedActionResultProjectionStatus {
  id: string;
  revision: 1;
  evidenceDigest: string;
  status: 'queued' | 'started' | 'published' | 'failed' | 'cancelled' | 'unknown';
  transportClosed: boolean;
}

/** Serialized attribution shape only. This does not mint the nominal host
 * authorship token or prove that a model was called. */
export interface ApprovedActionResultProjectionAuthorshipData {
  modelCallId: string;
  physicalAttempt: number;
  providerResponseIdDigest: string;
  hostResultReceiptId: string;
  responseOutputDigest: string;
  textDigest: string;
  usageJobId: string;
  operationId: string;
  revisionDigest: string;
}
export function normalizeApprovedActionResultProjectionAuthorshipData(value: unknown): ApprovedActionResultProjectionAuthorshipData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row=value as Record<string,unknown>;
  const keys=['modelCallId','physicalAttempt','providerResponseIdDigest','hostResultReceiptId','responseOutputDigest','textDigest','usageJobId','operationId','revisionDigest'];
  if(Object.keys(row).length!==keys.length || keys.some(key=>!Object.hasOwn(row,key))
    || !Number.isSafeInteger(row.physicalAttempt) || Number(row.physicalAttempt)<1
    || !['modelCallId','hostResultReceiptId','usageJobId','operationId'].every(key=>typeof row[key]==='string' && /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,255}$/.test(row[key] as string))
    || !['providerResponseIdDigest','responseOutputDigest','textDigest','revisionDigest'].every(key=>typeof row[key]==='string' && /^[a-f0-9]{64}$/.test(row[key] as string))) return null;
  return Object.fromEntries(keys.map(key=>[key,row[key]])) as unknown as ApprovedActionResultProjectionAuthorshipData;
}
