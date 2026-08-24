/**
 * Crash-safe forensic ownership for one returned staged physical attempt.
 *
 * A return checkpoint is not a success oracle. It is created only after an
 * exact opaque staged attempt has entered its already-persisted physical body,
 * and it commits with the physical `returned` state and immutable stage receipt.
 * Only ordinary logical settlement can publish or redeem business success.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import {
  planStagedFileDownloads,
  type StagedFileTransferNode,
} from '../../integrations/composio/staged-file-transfer-plan.js';
import { digestSchema } from '../../tools/tool-contract-store.js';
import {
  composioFilesDir,
  executePreparedComposioPresign,
  executePreparedComposioTool,
  inspectPreparedComposioPresignOneShot,
  inspectPreparedComposioOneShotDispatch,
  type PreparedComposioPresignOneShot,
  type PreparedComposioOneShotDispatch,
} from '../../integrations/composio/client.js';
import {
  createStagedFileBlobWriter,
  publishStagedFileBlob,
  type PublishedStagedFileBlob,
} from '../../integrations/composio/staged-file-blob-store.js';
import { currentToolAbortSignal } from '../tool-abort-context.js';
import { createPublicHttpsOriginTransport } from './public-https-origin.js';
import {
  persistAuthorityEncryptedPayload,
  readAuthorityEncryptedPayload,
  type AuthorityEncryptedPayloadReference,
} from './authority-encrypted-payload-store.js';
import { openEventLog } from './eventlog.js';
import {
  consumeStagedDownloadBodyCarrier,
  inspectStagedPhysicalDispatchAuthority,
  insertStagedBlobOwnerForReturnCheckpointInTransaction,
  insertStagedDownloadBlobOwnerForReturnCheckpointInTransaction,
  stagedBlobBodyResultOwnsCheckpoint,
  stagedUploadTransferBodyResultOwnsCheckpoint,
  type StagedBlobBodyResult,
  type StagedDownloadBodyCarrier,
  type StagedPhysicalDispatchAuthority,
  type StagedTransferStageKind,
  type StagedUploadTransferBodyResult,
} from './staged-transfer-authority.js';

const MAX_RETURN_BYTES = 32 * 1024 * 1024;

export interface PhysicalReturnCheckpointIdentity {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  physicalDispatchId: string;
  stageId: string;
  stageAuthorityId: string;
  stageAuthorityDigest: string;
  stageKind: StagedTransferStageKind;
  stageOrdinal: number;
  attemptOrdinal: number;
  toolName: string;
  argumentDigest: string;
  providerArgumentDigest: string;
  leaseScopeId: string;
  leaseId: string;
}

export interface PreparedPhysicalReturnCheckpoint {
  readonly version: 2;
}

interface PreparedPhysicalReturnCheckpointState {
  checkpointId: string;
  identity: PhysicalReturnCheckpointIdentity;
  bindingDigest: string;
  payload: AuthorityEncryptedPayloadReference;
  createdAt: string;
  blobOwner?: Readonly<
    | {
        kind: 'staged_blob_body';
        authority: StagedPhysicalDispatchAuthority;
        result: StagedBlobBodyResult;
        sha256: string;
        md5: string;
        byteCount: number;
        bodyDigest: string;
        resultDigest: string;
      }
    | {
        kind: 'staged_download_blob';
        authority: StagedPhysicalDispatchAuthority;
        blob: CommittedStagedDownloadBlob;
        sha256: string;
        md5: string;
        byteCount: number;
        bodyDigest: string;
        resultDigest: string;
      }
  >;
  secretOwner?: Readonly<{
    authority: StagedPhysicalDispatchAuthority;
    reference: AuthorityEncryptedPayloadReference;
    resultDigest: string;
    expiresAt: string;
  }>;
}

export interface CommittedStagedPhysicalReturn {
  readonly version: 2;
}

interface CommittedStagedPhysicalReturnState {
  identity: PhysicalReturnCheckpointIdentity;
  checkpointId: string;
  payloadSha256: string;
  payloadBytes: number;
  rawPayloadBytes: Buffer;
}

export interface CommittedComposioDownloadPlan {
  readonly version: 1;
}

export interface CommittedComposioDownloadAuthority {
  readonly version: 1;
}

/** Process-opaque ownership of one exact, fully published download body. */
export interface CommittedStagedDownloadBlob {
  readonly version: 1;
}

interface CommittedComposioDownloadPlanState {
  returned: CommittedStagedPhysicalReturn;
  resultDigest: string;
  nodes: readonly StagedFileTransferNode[];
  data: unknown;
}

interface CommittedComposioDownloadAuthorityState {
  plan: CommittedComposioDownloadPlan;
  resultDigest: string;
  pointer: string;
  descriptorDigest: string;
  descriptor: { s3url: string; mimetype: string | null };
}

interface CommittedStagedDownloadBlobState {
  authority: StagedPhysicalDispatchAuthority;
  downloadAuthority: CommittedComposioDownloadAuthority;
  blob: PublishedStagedFileBlob;
  bodyDigest: string;
  resultDigest: string;
}

const preparedCheckpoints = new WeakMap<object, PreparedPhysicalReturnCheckpointState>();
const committedStageReturns = new WeakMap<object, CommittedStagedPhysicalReturnState>();
const committedDownloadPlans = new WeakMap<object, CommittedComposioDownloadPlanState>();
const committedDownloadAuthorities = new WeakMap<object, CommittedComposioDownloadAuthorityState>();
const committedDownloadBlobs = new WeakMap<object, CommittedStagedDownloadBlobState>();
const enteredProviderBodies = new WeakSet<object>();

interface StagedSecretSqlAdmission {
  payloadId: string;
  stageAuthorityId: string;
  bindingDigest: string;
  plaintextSha256: string;
  plaintextBytes: number;
  chunkCount: number;
  sealedSha256: string;
  sealedBytes: number;
  expiresAt: string;
  consumed: boolean;
}

const stagedSecretSqlFunctionInstalled = new WeakSet<object>();
const activeStagedSecretSqlAdmissions = new WeakMap<object, StagedSecretSqlAdmission>();

export class PhysicalReturnCheckpointError extends Error {
  constructor(
    readonly code:
      | 'physical_return_identity_invalid'
      | 'physical_return_checkpoint_invalid'
      | 'physical_return_checkpoint_storage_failed',
  ) {
    super(
      code === 'physical_return_identity_invalid'
        ? 'physical return checkpoint identity is invalid'
        : code === 'physical_return_checkpoint_storage_failed'
          ? 'physical return checkpoint could not be persisted'
          : 'physical return checkpoint authority is invalid',
    );
    this.name = 'PhysicalReturnCheckpointError';
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalReturnBytes(value: unknown): Buffer {
  return Buffer.from(closedCanonicalJson(value, {
    maxDepth: 96,
    maxNodes: 500_000,
    maxStringBytes: MAX_RETURN_BYTES,
    maxTotalBytes: MAX_RETURN_BYTES,
  }), 'utf8');
}

function identityFromAuthority(
  authority: StagedPhysicalDispatchAuthority,
): PhysicalReturnCheckpointIdentity | null {
  const state = inspectStagedPhysicalDispatchAuthority(authority);
  if (!state) return null;
  return {
    sessionId: state.sessionId,
    sourceUserSeq: state.sourceUserSeq,
    acceptedTaskId: state.acceptedTaskId,
    logicalToolCallId: state.logicalToolCallId,
    physicalDispatchId: state.physicalDispatchId,
    stageId: state.stageId,
    stageAuthorityId: state.stageAuthorityId,
    stageAuthorityDigest: state.authorityDigest,
    stageKind: state.stageKind,
    stageOrdinal: state.stageOrdinal,
    attemptOrdinal: state.attemptOrdinal,
    toolName: state.toolName,
    argumentDigest: state.argumentDigest,
    providerArgumentDigest: state.providerArgumentDigest,
    leaseScopeId: state.lease.scopeId,
    leaseId: state.lease.leaseId,
  };
}

function canonicalIdentity(identity: PhysicalReturnCheckpointIdentity): string {
  return closedCanonicalJson({ protocol: 'physical_return_checkpoint_v2', ...identity }, {
    maxDepth: 8,
    maxNodes: 64,
    maxStringBytes: 8 * 1024,
    maxTotalBytes: 32 * 1024,
  });
}

export function physicalReturnCheckpointBindingDigest(
  identity: PhysicalReturnCheckpointIdentity,
): string {
  return sha256(canonicalIdentity(identity));
}

function sameIdentity(
  left: PhysicalReturnCheckpointIdentity,
  right: PhysicalReturnCheckpointIdentity,
): boolean {
  return canonicalIdentity(left) === canonicalIdentity(right);
}

function prepareCheckpoint(
  identity: PhysicalReturnCheckpointIdentity,
  rawPayloadBytes: Buffer,
  blobOwner?: PreparedPhysicalReturnCheckpointState['blobOwner'],
  secretOwner?: PreparedPhysicalReturnCheckpointState['secretOwner'],
): PreparedPhysicalReturnCheckpoint {
  const bindingDigest = physicalReturnCheckpointBindingDigest(identity);
  const payload = persistAuthorityEncryptedPayload({
    payloadKind: 'physical_return',
    bindingDigest,
    bytes: rawPayloadBytes,
  });
  const checkpointId = `physical-return:${sha256(closedCanonicalJson({
    protocol: 'physical_return_checkpoint_id_v2',
    bindingDigest,
    payloadSha256: payload.plaintextSha256,
    payloadBytes: payload.plaintextBytes,
  }))}`;
  const checkpoint = Object.freeze({ version: 2 as const });
  preparedCheckpoints.set(checkpoint, {
    checkpointId,
    identity: { ...identity },
    bindingDigest,
    payload,
    createdAt: new Date().toISOString(),
    ...(blobOwner ? { blobOwner } : {}),
    ...(secretOwner ? { secretOwner } : {}),
  });
  return checkpoint;
}

export type ExecuteStagedPreparedComposioBodyResult =
  | { status: 'returned'; checkpoint: PreparedPhysicalReturnCheckpoint }
  | { status: 'threw'; error: PhysicalReturnCheckpointError }
  | { status: 'checkpoint_failed'; error: PhysicalReturnCheckpointError }
  | { status: 'conflict'; reason: string };

/**
 * The Composio provider-return carrier mint. It accepts the provider adapter's
 * existing process-opaque one-shot, never an arbitrary work callback or bytes,
 * and will not enter work until the exact staged physical row is already started.
 * A checkpoint fault after body return is never rewritten as a provider throw.
 */
export async function executeStagedPreparedComposioBody(input: {
  authority: StagedPhysicalDispatchAuthority;
  preparedDispatch: PreparedComposioOneShotDispatch;
}): Promise<ExecuteStagedPreparedComposioBodyResult> {
  const identity = identityFromAuthority(input.authority);
  if (!identity) return { status: 'conflict', reason: 'staged provider body authority no longer reopens' };
  if (identity.stageKind !== 'business_execute') {
    return { status: 'conflict', reason: 'Composio one-shot can execute only the staged business operation' };
  }
  const preparedIdentity = inspectPreparedComposioOneShotDispatch(input.preparedDispatch);
  const plan = openEventLog().prepare(`
    SELECT plan.host_operation_id, plan.host_account_id, plan.operation_version
      FROM staged_transfer_stage_authorities attempt
      JOIN staged_transfer_plans plan ON plan.plan_id = attempt.plan_id
     WHERE attempt.stage_authority_id = ? AND attempt.stage_kind = 'business_execute'
  `).get(identity.stageAuthorityId) as {
    host_operation_id: string;
    host_account_id: string;
    operation_version: string;
  } | undefined;
  if (
    !preparedIdentity
    || !plan
    || preparedIdentity.lane !== 'sdk'
    || preparedIdentity.toolSlug.toLowerCase() !== identity.toolName
    || preparedIdentity.toolSlug !== plan.host_operation_id
    || preparedIdentity.providerArgumentDigest !== identity.providerArgumentDigest
    || preparedIdentity.connectedAccountId !== plan.host_account_id
    || preparedIdentity.providerOperationVersion !== plan.operation_version
  ) return { status: 'conflict', reason: 'prepared Composio one-shot does not match staged authority' };
  if (enteredProviderBodies.has(input.authority as object)) {
    return { status: 'conflict', reason: 'staged provider body authority was already consumed' };
  }
  const row = openEventLog().prepare(`
    SELECT state, staged_authority_digest, provider_argument_digest
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
  `).get(identity.sessionId, identity.sourceUserSeq, identity.physicalDispatchId) as {
    state: string;
    staged_authority_digest: string | null;
    provider_argument_digest: string | null;
  } | undefined;
  if (
    !row
    || row.state !== 'started'
    || row.staged_authority_digest !== identity.stageAuthorityDigest
    || row.provider_argument_digest !== identity.providerArgumentDigest
  ) return { status: 'conflict', reason: 'staged provider body lacks its exact started physical reservation' };
  enteredProviderBodies.add(input.authority as object);

  let value: unknown;
  try {
    value = await executePreparedComposioTool(input.preparedDispatch);
  } catch {
    return {
      status: 'threw',
      error: new PhysicalReturnCheckpointError('physical_return_checkpoint_invalid'),
    };
  }
  try {
    return {
      status: 'returned',
      checkpoint: prepareCheckpoint(identity, canonicalReturnBytes(value)),
    };
  } catch {
    return {
      status: 'checkpoint_failed',
      error: new PhysicalReturnCheckpointError('physical_return_checkpoint_storage_failed'),
    };
  }
}

export type ExecuteStagedPreparedComposioPresignBodyResult =
  | { status: 'returned'; checkpoint: PreparedPhysicalReturnCheckpoint }
  | { status: 'threw'; error: PhysicalReturnCheckpointError }
  | { status: 'checkpoint_failed'; error: PhysicalReturnCheckpointError }
  | { status: 'conflict'; reason: string };

function normalizedPresignReturn(value: unknown): {
  bytes: Buffer;
  expiresAt: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const key = record.key;
  const signedUrl = record.new_presigned_url;
  const metadata = record.metadata;
  const storageBackend = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).storage_backend
    : undefined;
  if (
    typeof key !== 'string'
    || key.length < 1
    || key.length > 4096
    || /[\u0000-\u001f\u007f]/.test(key)
    || typeof signedUrl !== 'string'
    || signedUrl.length < 1
    || signedUrl.length > 64 * 1024
    || (storageBackend !== 's3' && storageBackend !== 'azure_blob_storage')
  ) return null;
  let url: URL;
  try {
    url = new URL(signedUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  const nowMs = Date.now();
  let expiryMs = nowMs + 5 * 60 * 1000;
  const isoExpiry = url.searchParams.get('se') ?? url.searchParams.get('expires_at');
  if (isoExpiry) {
    const parsed = Date.parse(isoExpiry);
    if (Number.isFinite(parsed)) expiryMs = Math.min(expiryMs, parsed);
  }
  const awsDate = url.searchParams.get('X-Amz-Date') ?? url.searchParams.get('X-Goog-Date');
  const awsSeconds = url.searchParams.get('X-Amz-Expires') ?? url.searchParams.get('X-Goog-Expires');
  if (awsDate && awsSeconds && /^\d{8}T\d{6}Z$/.test(awsDate) && /^\d{1,7}$/.test(awsSeconds)) {
    const base = Date.parse(
      `${awsDate.slice(0, 4)}-${awsDate.slice(4, 6)}-${awsDate.slice(6, 8)}`
      + `T${awsDate.slice(9, 11)}:${awsDate.slice(11, 13)}:${awsDate.slice(13, 15)}Z`,
    );
    const seconds = Number(awsSeconds);
    if (Number.isFinite(base) && Number.isSafeInteger(seconds)) {
      expiryMs = Math.min(expiryMs, base + seconds * 1000);
    }
  }
  if (!Number.isFinite(expiryMs) || expiryMs <= nowMs + 5_000) return null;
  const normalized = { key, new_presigned_url: signedUrl, storage_backend: storageBackend };
  return {
    bytes: canonicalReturnBytes(normalized),
    expiresAt: new Date(expiryMs).toISOString(),
  };
}

/** One exact no-retry presign POST. The returned URL is immediately encrypted
 * into both the forensic return checkpoint and its separately bound secret
 * owner; neither the URL nor provider payload is returned to the caller. */
export async function executeStagedPreparedComposioPresignBody(input: {
  authority: StagedPhysicalDispatchAuthority;
  preparedPresign: PreparedComposioPresignOneShot;
}): Promise<ExecuteStagedPreparedComposioPresignBodyResult> {
  const identity = identityFromAuthority(input.authority);
  if (!identity || identity.stageKind !== 'upload_presign') {
    return { status: 'conflict', reason: 'presign body lacks its exact staged physical identity' };
  }
  const prepared = inspectPreparedComposioPresignOneShot(input.preparedPresign);
  const plan = openEventLog().prepare(`
    SELECT plan.host_operation_id, plan.toolkit_slug
      FROM staged_transfer_stage_authorities attempt
      JOIN staged_transfer_plans plan ON plan.plan_id = attempt.plan_id
     WHERE attempt.stage_authority_id = ? AND attempt.stage_kind = 'upload_presign'
  `).get(identity.stageAuthorityId) as {
    host_operation_id: string;
    toolkit_slug: string;
  } | undefined;
  if (
    !prepared
    || !plan
    || prepared.providerArgumentDigest !== identity.providerArgumentDigest
    || prepared.toolSlug !== plan.host_operation_id
    || prepared.toolkitSlug !== plan.toolkit_slug
  ) return { status: 'conflict', reason: 'prepared presign one-shot does not match staged authority' };
  if (enteredProviderBodies.has(input.authority as object)) {
    return { status: 'conflict', reason: 'staged presign body authority was already consumed' };
  }
  const row = openEventLog().prepare(`
    SELECT state, staged_authority_digest, provider_argument_digest
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
  `).get(identity.sessionId, identity.sourceUserSeq, identity.physicalDispatchId) as {
    state: string;
    staged_authority_digest: string | null;
    provider_argument_digest: string | null;
  } | undefined;
  if (
    !row
    || row.state !== 'started'
    || row.staged_authority_digest !== identity.stageAuthorityDigest
    || row.provider_argument_digest !== identity.providerArgumentDigest
  ) return { status: 'conflict', reason: 'staged presign body lacks its exact started physical reservation' };
  enteredProviderBodies.add(input.authority as object);

  let value: unknown;
  try {
    value = await executePreparedComposioPresign(input.preparedPresign);
  } catch {
    return {
      status: 'threw',
      error: new PhysicalReturnCheckpointError('physical_return_checkpoint_invalid'),
    };
  }
  const normalized = normalizedPresignReturn(value);
  if (!normalized) {
    return {
      status: 'threw',
      error: new PhysicalReturnCheckpointError('physical_return_checkpoint_invalid'),
    };
  }
  try {
    const resultDigest = sha256(normalized.bytes);
    const bindingDigest = sha256(closedCanonicalJson({
      protocol: 'staged_signed_url_binding_v1',
      stageAuthorityId: identity.stageAuthorityId,
      physicalDispatchId: identity.physicalDispatchId,
      resultDigest,
    }));
    const reference = persistAuthorityEncryptedPayload({
      payloadKind: 'staged_signed_url',
      bindingDigest,
      bytes: normalized.bytes,
    });
    return {
      status: 'returned',
      checkpoint: prepareCheckpoint(identity, normalized.bytes, undefined, Object.freeze({
        authority: input.authority,
        reference,
        resultDigest,
        expiresAt: normalized.expiresAt,
      })),
    };
  } catch {
    return {
      status: 'checkpoint_failed',
      error: new PhysicalReturnCheckpointError('physical_return_checkpoint_storage_failed'),
    };
  }
}

export type PrepareStagedBlobBodyReturnCheckpointResult =
  | { status: 'prepared'; checkpoint: PreparedPhysicalReturnCheckpoint }
  | { status: 'conflict' | 'storage_error'; reason: string };

export type PrepareStagedUploadTransferReturnCheckpointResult =
  | { status: 'prepared'; checkpoint: PreparedPhysicalReturnCheckpoint }
  | { status: 'conflict' | 'storage_error'; reason: string };

/**
 * Synchronous post-PUT checkpoint mint. The upload kernel calls this before it
 * yields control after the provider body, so a caller never observes a 2xx
 * without either the encrypted return checkpoint or an honest unknown started
 * crossing. The opaque WeakMap result, not copyable digests, owns the mint.
 */
export function prepareStagedUploadTransferReturnCheckpoint(input: {
  authority: StagedPhysicalDispatchAuthority;
  result: StagedUploadTransferBodyResult;
  bodyDigest: string;
  resultDigest: string;
  byteCount: number;
}): PrepareStagedUploadTransferReturnCheckpointResult {
  const identity = identityFromAuthority(input.authority);
  if (
    !identity
    || identity.stageKind !== 'upload_transfer'
    || !stagedUploadTransferBodyResultOwnsCheckpoint(input)
  ) return { status: 'conflict', reason: 'staged upload return does not own the exact physical body' };
  try {
    const bytes = canonicalReturnBytes({
      successful: true,
      data: {
        protocol: 'staged_upload_transfer_return_v1',
        body_digest: input.bodyDigest,
        byte_count: input.byteCount,
      },
    });
    if (sha256(bytes) !== input.resultDigest) {
      return { status: 'conflict', reason: 'staged upload return digest changed before checkpoint' };
    }
    return {
      status: 'prepared',
      checkpoint: prepareCheckpoint(identity, bytes),
    };
  } catch {
    return { status: 'storage_error', reason: 'staged upload return checkpoint could not be persisted' };
  }
}

/**
 * Mint a return checkpoint from the blob kernel's process-opaque body result.
 * Callers can see content digests and byte count, never the local/source/blob
 * path or bytes, and cannot substitute safe-looking metadata from another
 * attempt because the WeakMap carrier owns the complete exact tuple.
 */
export function prepareStagedBlobBodyReturnCheckpoint(input: {
  authority: StagedPhysicalDispatchAuthority;
  result: StagedBlobBodyResult;
  sha256: string;
  md5: string;
  byteCount: number;
  bodyDigest: string;
  resultDigest: string;
}): PrepareStagedBlobBodyReturnCheckpointResult {
  const identity = identityFromAuthority(input.authority);
  if (
    !identity
    || !['local_snapshot', 'source_download', 'download_transfer', 'local_commit'].includes(identity.stageKind)
    || !stagedBlobBodyResultOwnsCheckpoint(input)
  ) return { status: 'conflict', reason: 'staged blob return does not own the exact physical body' };
  try {
    const payload = {
      successful: true,
      data: {
        protocol: 'staged_blob_body_return_v1',
        stage_kind: identity.stageKind,
        body_digest: input.bodyDigest,
        sha256: input.sha256,
        md5: input.md5,
        byte_count: input.byteCount,
      },
    };
    const bytes = canonicalReturnBytes(payload);
    if (sha256(bytes) !== input.resultDigest) {
      return { status: 'conflict', reason: 'staged blob return digest changed before checkpoint' };
    }
    return {
      status: 'prepared',
      checkpoint: prepareCheckpoint(identity, bytes, Object.freeze({
        kind: 'staged_blob_body',
        authority: input.authority,
        result: input.result,
        sha256: input.sha256,
        md5: input.md5,
        byteCount: input.byteCount,
        bodyDigest: input.bodyDigest,
        resultDigest: input.resultDigest,
      })),
    };
  } catch {
    return { status: 'storage_error', reason: 'staged blob return checkpoint could not be persisted' };
  }
}

function installStagedSecretSqlAdmissionFunction(db: Database.Database): void {
  if (stagedSecretSqlFunctionInstalled.has(db)) return;
  db.function(
    'clementine_staged_secret_admitted_v1',
    (
      payloadId: unknown,
      stageAuthorityId: unknown,
      bindingDigest: unknown,
      plaintextSha256: unknown,
      plaintextBytes: unknown,
      chunkCount: unknown,
      sealedSha256: unknown,
      sealedBytes: unknown,
      expiresAt: unknown,
    ): number => {
      const admission = activeStagedSecretSqlAdmissions.get(db);
      if (
        !admission
        || admission.consumed
        || payloadId !== admission.payloadId
        || stageAuthorityId !== admission.stageAuthorityId
        || bindingDigest !== admission.bindingDigest
        || plaintextSha256 !== admission.plaintextSha256
        || plaintextBytes !== admission.plaintextBytes
        || chunkCount !== admission.chunkCount
        || sealedSha256 !== admission.sealedSha256
        || sealedBytes !== admission.sealedBytes
        || expiresAt !== admission.expiresAt
      ) return 0;
      admission.consumed = true;
      return 1;
    },
  );
  stagedSecretSqlFunctionInstalled.add(db);
}

function insertPreparedStagedSecretOwnerInTransaction(
  db: Database.Database,
  state: PreparedPhysicalReturnCheckpointState,
): void {
  const secret = state.secretOwner;
  if (!secret || db !== openEventLog() || !db.inTransaction) {
    throw new PhysicalReturnCheckpointError('physical_return_checkpoint_invalid');
  }
  const identity = identityFromAuthority(secret.authority);
  const reference = secret.reference;
  const expectedBindingDigest = sha256(closedCanonicalJson({
    protocol: 'staged_signed_url_binding_v1',
    stageAuthorityId: state.identity.stageAuthorityId,
    physicalDispatchId: state.identity.physicalDispatchId,
    resultDigest: secret.resultDigest,
  }));
  if (
    !identity
    || identity.stageKind !== 'upload_presign'
    || !sameIdentity(identity, state.identity)
    || reference.payloadKind !== 'staged_signed_url'
    || reference.bindingDigest !== expectedBindingDigest
    || reference.plaintextSha256 !== secret.resultDigest
    || reference.plaintextSha256 !== state.payload.plaintextSha256
    || !Number.isFinite(Date.parse(secret.expiresAt))
    || Date.parse(secret.expiresAt) <= Date.parse(state.createdAt)
  ) throw new PhysicalReturnCheckpointError('physical_return_checkpoint_invalid');
  const returned = db.prepare(`
    SELECT receipt.recorded_at
      FROM staged_transfer_stage_authorities attempt
      JOIN physical_dispatches physical
        ON physical.session_id = attempt.session_id
       AND physical.source_user_seq = attempt.source_user_seq
       AND physical.physical_dispatch_id = attempt.physical_dispatch_id
      JOIN staged_transfer_stage_receipts receipt
        ON receipt.stage_authority_id = attempt.stage_authority_id
      JOIN physical_dispatch_return_checkpoints checkpoint
        ON checkpoint.stage_authority_id = attempt.stage_authority_id
     WHERE attempt.stage_authority_id = ?
       AND attempt.stage_kind = 'upload_presign'
       AND attempt.authority_digest = ?
       AND attempt.provider_argument_digest = ?
       AND physical.state = 'returned'
       AND physical.staged_authority_digest = attempt.authority_digest
       AND physical.provider_argument_digest = attempt.provider_argument_digest
       AND receipt.terminal_state = 'returned'
       AND receipt.result_digest = ?
       AND checkpoint.payload_plaintext_sha256 = ?
       AND checkpoint.payload_plaintext_bytes = ?
  `).get(
    identity.stageAuthorityId,
    identity.stageAuthorityDigest,
    identity.providerArgumentDigest,
    secret.resultDigest,
    state.payload.plaintextSha256,
    state.payload.plaintextBytes,
  ) as { recorded_at: string } | undefined;
  if (!returned) throw new PhysicalReturnCheckpointError('physical_return_checkpoint_invalid');
  const existing = db.prepare(`
    SELECT payload_id, payload_kind, binding_digest, plaintext_sha256,
           plaintext_bytes, chunk_count, sealed_sha256, sealed_bytes, expires_at
      FROM staged_transfer_secret_payloads
     WHERE stage_authority_id = ?
  `).get(identity.stageAuthorityId) as Record<string, unknown> | undefined;
  if (existing) {
    if (
      existing.payload_id !== reference.payloadId
      || existing.payload_kind !== reference.payloadKind
      || existing.binding_digest !== reference.bindingDigest
      || existing.plaintext_sha256 !== reference.plaintextSha256
      || existing.plaintext_bytes !== reference.plaintextBytes
      || existing.chunk_count !== reference.chunkCount
      || existing.sealed_sha256 !== reference.sealedFileSha256
      || existing.sealed_bytes !== reference.sealedFileBytes
      || existing.expires_at !== secret.expiresAt
    ) throw new PhysicalReturnCheckpointError('physical_return_checkpoint_invalid');
    return;
  }
  installStagedSecretSqlAdmissionFunction(db);
  if (activeStagedSecretSqlAdmissions.has(db)) {
    throw new PhysicalReturnCheckpointError('physical_return_checkpoint_invalid');
  }
  const admission: StagedSecretSqlAdmission = {
    payloadId: reference.payloadId,
    stageAuthorityId: identity.stageAuthorityId,
    bindingDigest: reference.bindingDigest,
    plaintextSha256: reference.plaintextSha256,
    plaintextBytes: reference.plaintextBytes,
    chunkCount: reference.chunkCount,
    sealedSha256: reference.sealedFileSha256,
    sealedBytes: reference.sealedFileBytes,
    expiresAt: secret.expiresAt,
    consumed: false,
  };
  activeStagedSecretSqlAdmissions.set(db, admission);
  try {
    const inserted = db.prepare(`
      INSERT INTO staged_transfer_secret_payloads
        (payload_id, stage_authority_id, payload_kind, binding_digest,
         plaintext_sha256, plaintext_bytes, chunk_count, sealed_sha256,
         sealed_bytes, expires_at, created_at)
      VALUES (?, ?, 'staged_signed_url', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reference.payloadId,
      identity.stageAuthorityId,
      reference.bindingDigest,
      reference.plaintextSha256,
      reference.plaintextBytes,
      reference.chunkCount,
      reference.sealedFileSha256,
      reference.sealedFileBytes,
      secret.expiresAt,
      returned.recorded_at,
    );
    if (inserted.changes !== 1 || !admission.consumed) {
      throw new PhysicalReturnCheckpointError('physical_return_checkpoint_invalid');
    }
  } finally {
    activeStagedSecretSqlAdmissions.delete(db);
  }
}

/** Called from the physical settlement IMMEDIATE transaction after its exact
 * row CASes to returned. Checkpoint and stage receipt are one atomic fact. */
export function insertPreparedPhysicalReturnCheckpointInTransaction(
  db: Database.Database,
  prepared: PreparedPhysicalReturnCheckpoint,
): void {
  const state = preparedCheckpoints.get(prepared as object);
  if (!state) throw new PhysicalReturnCheckpointError('physical_return_checkpoint_invalid');
  const i = state.identity;
  try {
    db.prepare(`
      INSERT INTO physical_dispatch_return_checkpoints
        (checkpoint_id, session_id, source_user_seq, accepted_task_id,
         logical_tool_call_id, physical_dispatch_id, stage_authority_id,
         stage_kind, stage_ordinal, attempt_ordinal, tool_name, argument_digest,
         provider_argument_digest, lease_scope_id, lease_id, payload_id,
         payload_plaintext_sha256, payload_plaintext_bytes, payload_chunk_count,
         payload_sealed_sha256, payload_sealed_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      state.checkpointId,
      i.sessionId,
      i.sourceUserSeq,
      i.acceptedTaskId,
      i.logicalToolCallId,
      i.physicalDispatchId,
      i.stageAuthorityId,
      i.stageKind,
      i.stageOrdinal,
      i.attemptOrdinal,
      i.toolName,
      i.argumentDigest,
      i.providerArgumentDigest,
      i.leaseScopeId,
      i.leaseId,
      state.payload.payloadId,
      state.payload.plaintextSha256,
      state.payload.plaintextBytes,
      state.payload.chunkCount,
      state.payload.sealedFileSha256,
      state.payload.sealedFileBytes,
      state.createdAt,
    );
    const receipt = db.prepare(`
      INSERT INTO staged_transfer_stage_receipts
        (stage_authority_id, stage_id, plan_id, session_id, source_user_seq,
         stage_ordinal, attempt_ordinal, physical_dispatch_id, terminal_state,
         result_digest, recorded_at)
      SELECT authority.stage_authority_id, authority.stage_id, authority.plan_id,
             authority.session_id, authority.source_user_seq,
             authority.stage_ordinal, authority.attempt_ordinal,
             authority.physical_dispatch_id, 'returned', ?, ?
        FROM staged_transfer_stage_authorities authority
       WHERE authority.stage_authority_id = ?
    `).run(state.payload.plaintextSha256, state.createdAt, i.stageAuthorityId);
    if (receipt.changes !== 1) {
      throw new PhysicalReturnCheckpointError('physical_return_checkpoint_invalid');
    }
    if (state.blobOwner?.kind === 'staged_blob_body') {
      insertStagedBlobOwnerForReturnCheckpointInTransaction({
        db,
        authority: state.blobOwner.authority,
        result: state.blobOwner.result,
        sha256: state.blobOwner.sha256,
        md5: state.blobOwner.md5,
        byteCount: state.blobOwner.byteCount,
        bodyDigest: state.blobOwner.bodyDigest,
        resultDigest: state.blobOwner.resultDigest,
      });
    } else if (state.blobOwner?.kind === 'staged_download_blob') {
      insertStagedDownloadBlobOwnerForReturnCheckpointInTransaction({
        db,
        authority: state.blobOwner.authority,
        blob: state.blobOwner.blob,
        sha256: state.blobOwner.sha256,
        md5: state.blobOwner.md5,
        byteCount: state.blobOwner.byteCount,
        bodyDigest: state.blobOwner.bodyDigest,
        resultDigest: state.blobOwner.resultDigest,
      });
    }
    if (state.secretOwner) {
      insertPreparedStagedSecretOwnerInTransaction(db, state);
    }
  } catch {
    throw new PhysicalReturnCheckpointError('physical_return_checkpoint_storage_failed');
  }
}

export function stagedPhysicalReturnCheckpointIdentity(
  db: Database.Database,
  input: {
    sessionId: string;
    sourceUserSeq: number;
    acceptedTaskId: string;
    logicalToolCallId: string;
    physicalDispatchId: string;
    toolName: string;
    argumentDigest: string;
    leaseScopeId: string | null;
    leaseId: string | null;
  },
): PhysicalReturnCheckpointIdentity | null {
  const row = db.prepare(`
    SELECT attempt.stage_id, attempt.stage_authority_id,
           attempt.authority_digest AS stage_authority_digest,
           attempt.stage_kind, attempt.stage_ordinal, attempt.attempt_ordinal,
           attempt.accepted_task_id, attempt.logical_tool_call_id,
           attempt.physical_dispatch_id, attempt.tool_name,
           attempt.argument_digest, attempt.provider_argument_digest,
           attempt.lease_scope_id, attempt.lease_id,
           physical.staged_authority_digest AS physical_staged_authority_digest,
           physical.provider_argument_digest AS physical_provider_argument_digest
      FROM staged_transfer_stage_authorities attempt
      JOIN physical_dispatches physical
        ON physical.session_id = attempt.session_id
       AND physical.source_user_seq = attempt.source_user_seq
       AND physical.physical_dispatch_id = attempt.physical_dispatch_id
     WHERE attempt.session_id = ? AND attempt.source_user_seq = ?
       AND attempt.physical_dispatch_id = ?
  `).get(input.sessionId, input.sourceUserSeq, input.physicalDispatchId) as Record<string, unknown> | undefined;
  if (!row) return null;
  if (
    row.accepted_task_id !== input.acceptedTaskId
    || row.logical_tool_call_id !== input.logicalToolCallId
    || row.physical_dispatch_id !== input.physicalDispatchId
    || row.tool_name !== input.toolName
    || row.argument_digest !== input.argumentDigest
    || row.lease_scope_id !== input.leaseScopeId
    || row.lease_id !== input.leaseId
    || row.physical_staged_authority_digest !== row.stage_authority_digest
    || row.physical_provider_argument_digest !== row.provider_argument_digest
  ) throw new PhysicalReturnCheckpointError('physical_return_checkpoint_invalid');
  return {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    logicalToolCallId: input.logicalToolCallId,
    physicalDispatchId: input.physicalDispatchId,
    stageId: String(row.stage_id),
    stageAuthorityId: String(row.stage_authority_id),
    stageAuthorityDigest: String(row.stage_authority_digest),
    stageKind: row.stage_kind as StagedTransferStageKind,
    stageOrdinal: Number(row.stage_ordinal),
    attemptOrdinal: Number(row.attempt_ordinal),
    toolName: input.toolName,
    argumentDigest: input.argumentDigest,
    providerArgumentDigest: String(row.provider_argument_digest),
    leaseScopeId: String(row.lease_scope_id),
    leaseId: String(row.lease_id),
  };
}

export function preparedPhysicalReturnCheckpointOwns(
  prepared: PreparedPhysicalReturnCheckpoint,
  expected: PhysicalReturnCheckpointIdentity,
): boolean {
  const state = preparedCheckpoints.get(prepared as object);
  return Boolean(state && sameIdentity(state.identity, expected));
}

export function persistedPhysicalReturnCheckpointOwns(
  db: Database.Database,
  prepared: PreparedPhysicalReturnCheckpoint,
): boolean {
  const state = preparedCheckpoints.get(prepared as object);
  if (!state) return false;
  const row = db.prepare(`
    SELECT checkpoint_id, stage_authority_id, stage_kind, stage_ordinal,
           attempt_ordinal, tool_name, argument_digest, provider_argument_digest,
           lease_scope_id, lease_id, payload_id, payload_plaintext_sha256,
           payload_plaintext_bytes, payload_chunk_count, payload_sealed_sha256,
           payload_sealed_bytes
      FROM physical_dispatch_return_checkpoints
     WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
  `).get(
    state.identity.sessionId,
    state.identity.sourceUserSeq,
    state.identity.physicalDispatchId,
  ) as Record<string, unknown> | undefined;
  return Boolean(row
    && row.checkpoint_id === state.checkpointId
    && row.stage_authority_id === state.identity.stageAuthorityId
    && row.stage_kind === state.identity.stageKind
    && row.stage_ordinal === state.identity.stageOrdinal
    && row.attempt_ordinal === state.identity.attemptOrdinal
    && row.tool_name === state.identity.toolName
    && row.argument_digest === state.identity.argumentDigest
    && row.provider_argument_digest === state.identity.providerArgumentDigest
    && row.lease_scope_id === state.identity.leaseScopeId
    && row.lease_id === state.identity.leaseId
    && row.payload_id === state.payload.payloadId
    && row.payload_plaintext_sha256 === state.payload.plaintextSha256
    && row.payload_plaintext_bytes === state.payload.plaintextBytes
    && row.payload_chunk_count === state.payload.chunkCount
    && row.payload_sealed_sha256 === state.payload.sealedFileSha256
    && row.payload_sealed_bytes === state.payload.sealedFileBytes);
}

export type RecoverCommittedStagedPhysicalReturnResult =
  | {
      status: 'committed';
      returned: CommittedStagedPhysicalReturn;
      payloadSha256: string;
      payloadBytes: number;
    }
  | { status: 'missing' | 'conflict' | 'corrupt' | 'storage_error'; reason: string };

/** Reopen an already-atomic return behind the same opaque stage authority. */
export function recoverCommittedStagedPhysicalReturn(input: {
  authority: StagedPhysicalDispatchAuthority;
}): RecoverCommittedStagedPhysicalReturnResult {
  const expected = identityFromAuthority(input.authority);
  if (!expected) return { status: 'conflict', reason: 'staged return authority no longer reopens' };
  const bindingDigest = physicalReturnCheckpointBindingDigest(expected);
  try {
    const db = openEventLog();
    const row = db.prepare(`
      SELECT checkpoint.*, physical.state, physical.staged_authority_digest,
             receipt.terminal_state, receipt.result_digest
        FROM physical_dispatch_return_checkpoints checkpoint
        JOIN physical_dispatches physical
          ON physical.session_id = checkpoint.session_id
         AND physical.source_user_seq = checkpoint.source_user_seq
         AND physical.physical_dispatch_id = checkpoint.physical_dispatch_id
        JOIN staged_transfer_stage_receipts receipt
          ON receipt.stage_authority_id = checkpoint.stage_authority_id
       WHERE checkpoint.stage_authority_id = ?
    `).get(expected.stageAuthorityId) as Record<string, unknown> | undefined;
    if (!row) return { status: 'missing', reason: 'committed staged physical return is missing' };
    if (
      row.state !== 'returned'
      || row.terminal_state !== 'returned'
      || row.result_digest !== row.payload_plaintext_sha256
      || row.staged_authority_digest !== expected.stageAuthorityDigest
      || row.session_id !== expected.sessionId
      || row.source_user_seq !== expected.sourceUserSeq
      || row.accepted_task_id !== expected.acceptedTaskId
      || row.logical_tool_call_id !== expected.logicalToolCallId
      || row.physical_dispatch_id !== expected.physicalDispatchId
      || row.stage_authority_id !== expected.stageAuthorityId
      || row.stage_kind !== expected.stageKind
      || row.stage_ordinal !== expected.stageOrdinal
      || row.attempt_ordinal !== expected.attemptOrdinal
      || row.tool_name !== expected.toolName
      || row.argument_digest !== expected.argumentDigest
      || row.provider_argument_digest !== expected.providerArgumentDigest
      || row.lease_scope_id !== expected.leaseScopeId
      || row.lease_id !== expected.leaseId
    ) return { status: 'conflict', reason: 'committed staged return tuple changed' };
    const reference: AuthorityEncryptedPayloadReference = {
      version: 1,
      payloadId: String(row.payload_id),
      payloadKind: 'physical_return',
      bindingDigest,
      plaintextSha256: String(row.payload_plaintext_sha256),
      plaintextBytes: Number(row.payload_plaintext_bytes),
      chunkCount: Number(row.payload_chunk_count),
      sealedFileSha256: String(row.payload_sealed_sha256),
      sealedFileBytes: Number(row.payload_sealed_bytes),
    };
    const opened = readAuthorityEncryptedPayload({
      reference,
      payloadKind: 'physical_return',
      bindingDigest,
    });
    if (opened.status !== 'ok') {
      return {
        status: opened.status === 'storage_error' ? 'storage_error' : 'corrupt',
        reason: 'committed staged return payload is unavailable',
      };
    }
    const returned = Object.freeze({ version: 2 as const });
    committedStageReturns.set(returned, {
      identity: expected,
      checkpointId: String(row.checkpoint_id),
      payloadSha256: reference.plaintextSha256,
      payloadBytes: reference.plaintextBytes,
      rawPayloadBytes: opened.bytes,
    });
    return {
      status: 'committed',
      returned,
      payloadSha256: reference.plaintextSha256,
      payloadBytes: reference.plaintextBytes,
    };
  } catch {
    return { status: 'storage_error', reason: 'committed staged return recovery failed' };
  }
}

/** Validate the exact successful Composio envelope and enumerate from `.data`
 * only. Returned nodes contain pointers only; signed URLs stay process-opaque. */
export function planCommittedComposioDownloads(input: {
  returned: CommittedStagedPhysicalReturn;
  outputSchema: Record<string, unknown>;
}):
  | { status: 'planned'; plan: CommittedComposioDownloadPlan; nodes: readonly StagedFileTransferNode[] }
  | { status: 'not_applicable' | 'conflict'; reason: string } {
  const state = committedStageReturns.get(input.returned as object);
  if (!state || state.identity.stageKind !== 'business_execute') {
    return { status: 'conflict', reason: 'download projection requires an exact committed business return' };
  }
  try {
    const db = openEventLog();
    const owner = db.prepare(`
      SELECT plan.output_schema_digest
        FROM staged_transfer_stage_authorities attempt
        JOIN staged_transfer_plans plan ON plan.plan_id = attempt.plan_id
       WHERE attempt.stage_authority_id = ? AND attempt.stage_kind = 'business_execute'
    `).get(state.identity.stageAuthorityId) as { output_schema_digest: string | null } | undefined;
    if (!owner?.output_schema_digest || digestSchema(input.outputSchema) !== owner.output_schema_digest) {
      return { status: 'conflict', reason: 'download output schema does not match the frozen provider definition' };
    }
    const envelope = JSON.parse(state.rawPayloadBytes.toString('utf8')) as unknown;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return { status: 'conflict', reason: 'Composio business return envelope is malformed' };
    }
    const record = envelope as Record<string, unknown>;
    if (record.successful !== true || !Object.prototype.hasOwnProperty.call(record, 'data')) {
      return { status: 'conflict', reason: 'failed Composio envelope cannot authorize downloads' };
    }
    const nodes = planStagedFileDownloads(input.outputSchema, record.data);
    if (!nodes.length) {
      return { status: 'not_applicable', reason: 'successful Composio data contains no authorized downloads' };
    }
    const plan = Object.freeze({ version: 1 as const });
    committedDownloadPlans.set(plan, {
      returned: input.returned,
      resultDigest: state.payloadSha256,
      nodes: Object.freeze(nodes.map((node) => Object.freeze({ ...node }))),
      data: record.data,
    });
    return { status: 'planned', plan, nodes: nodes.map((node) => ({ ...node })) };
  } catch {
    return { status: 'conflict', reason: 'Composio business return cannot authorize downloads' };
  }
}

export type ProjectCommittedComposioResult =
  | {
      status: 'projected';
      value: {
        successful: true;
        error: null;
        data: unknown;
      };
    }
  | { status: 'conflict'; reason: string };

function replaceProjectionPointer(
  root: unknown,
  pointer: string,
  replacement: unknown,
): { ok: true; value: unknown } | { ok: false } {
  if (pointer === '') return { ok: true, value: replacement };
  if (!pointer.startsWith('/')) return { ok: false };
  const tokens = pointer.slice(1).split('/').map((encoded) =>
    encoded.replace(/~1/g, '/').replace(/~0/g, '~'));
  let parent = root;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const key = tokens[index]!;
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return { ok: false };
    if (Array.isArray(parent)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return { ok: false };
      const property = Object.getOwnPropertyDescriptor(parent, key);
      if (!property || 'get' in property || 'set' in property) return { ok: false };
      parent = property.value;
      continue;
    }
    if (!parent || typeof parent !== 'object') return { ok: false };
    const property = Object.getOwnPropertyDescriptor(parent, key);
    if (!property || 'get' in property || 'set' in property) return { ok: false };
    parent = property.value;
  }
  const key = tokens.at(-1)!;
  if (key === '__proto__' || key === 'prototype' || key === 'constructor') return { ok: false };
  if (Array.isArray(parent)) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return { ok: false };
  } else if (!parent || typeof parent !== 'object') {
    return { ok: false };
  }
  const property = Object.getOwnPropertyDescriptor(parent, key);
  if (!property || 'get' in property || 'set' in property || property.writable === false) return { ok: false };
  Object.defineProperty(parent, key, {
    value: replacement,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return { ok: true, value: root };
}

/**
 * Project one exact staged business return for the ordinary host-result lane.
 * Raw provider bytes remain private. Schema-authorized file descriptors are
 * released only after their download+local-commit receipts exist, and signed
 * URLs/absolute paths are replaced by content-addressed artifact handles.
 * This is presentation, not a success oracle: the outer logical settlement is
 * still the only component allowed to publish redeemable success.
 */
export function projectCommittedComposioResult(input: {
  returned: CommittedStagedPhysicalReturn;
  outputSchema: Record<string, unknown>;
}): ProjectCommittedComposioResult {
  const state = committedStageReturns.get(input.returned as object);
  if (!state || state.identity.stageKind !== 'business_execute') {
    return { status: 'conflict', reason: 'result projection requires an exact committed business return' };
  }
  try {
    const db = openEventLog();
    const owner = db.prepare(`
      SELECT plan.plan_id, plan.output_schema_digest,
             plan.output_may_contain_downloads, business.stage_ordinal
        FROM staged_transfer_stage_authorities attempt
        JOIN staged_transfer_plans plan ON plan.plan_id = attempt.plan_id
        JOIN staged_transfer_stages business ON business.stage_id = attempt.stage_id
       WHERE attempt.stage_authority_id = ?
         AND attempt.stage_kind = 'business_execute'
    `).get(state.identity.stageAuthorityId) as {
      plan_id: string;
      output_schema_digest: string | null;
      output_may_contain_downloads: number;
      stage_ordinal: number;
    } | undefined;
    if (!owner?.output_schema_digest || digestSchema(input.outputSchema) !== owner.output_schema_digest) {
      return { status: 'conflict', reason: 'result output schema does not match the frozen provider definition' };
    }
    const envelope = JSON.parse(state.rawPayloadBytes.toString('utf8')) as unknown;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return { status: 'conflict', reason: 'Composio business return envelope is malformed' };
    }
    const record = envelope as Record<string, unknown>;
    if (
      record.successful !== true
      || !Object.prototype.hasOwnProperty.call(record, 'data')
      || (record.error !== null && record.error !== undefined)
    ) return { status: 'conflict', reason: 'failed Composio envelope cannot project success' };
    const nodes = planStagedFileDownloads(input.outputSchema, record.data);
    let projectedData = JSON.parse(canonicalReturnBytes(record.data).toString('utf8')) as unknown;
    if (owner.output_may_contain_downloads === 1) {
      const topology = db.prepare(`
        SELECT business_result_digest, successor_stage_count
          FROM staged_transfer_download_topology_receipts
         WHERE plan_id = ? AND business_stage_authority_id = ?
      `).get(owner.plan_id, state.identity.stageAuthorityId) as {
        business_result_digest: string;
        successor_stage_count: number;
      } | undefined;
      if (
        !topology
        || topology.business_result_digest !== state.payloadSha256
        || topology.successor_stage_count !== nodes.length * 2
      ) return { status: 'conflict', reason: 'result projection lacks its exact download topology receipt' };
      const unfinished = db.prepare(`
        SELECT COUNT(*) AS count
          FROM staged_transfer_stages stage
         WHERE stage.plan_id = ? AND stage.stage_ordinal > ?
           AND NOT EXISTS (
             SELECT 1
               FROM staged_transfer_stage_authorities attempt
               JOIN staged_transfer_stage_receipts receipt
                 ON receipt.stage_authority_id = attempt.stage_authority_id
              WHERE attempt.stage_id = stage.stage_id
                AND receipt.terminal_state = 'returned'
           )
      `).get(owner.plan_id, owner.stage_ordinal) as { count: number };
      if (unfinished.count !== 0) {
        return { status: 'conflict', reason: 'result projection has unfinished download stages' };
      }
    } else if (nodes.length > 0) {
      return { status: 'conflict', reason: 'result contains downloads outside its frozen provider definition' };
    }

    for (const node of nodes) {
      const pointerDigest = sha256(closedCanonicalJson({
        protocol: 'staged_file_pointer_v1',
        pointer: node.pointer,
      }));
      const rows = db.prepare(`
        SELECT owner.blob_sha256, owner.blob_md5, owner.blob_bytes
          FROM staged_transfer_stages commit_stage
          JOIN staged_transfer_blob_owners owner
            ON owner.plan_id = commit_stage.plan_id
           AND owner.stage_id = commit_stage.stage_id
          JOIN staged_transfer_stages download_stage
            ON download_stage.plan_id = commit_stage.plan_id
           AND download_stage.stage_ordinal = commit_stage.depends_on_stage_ordinal
           AND download_stage.stage_kind = 'download_transfer'
           AND download_stage.json_pointer_digest = commit_stage.json_pointer_digest
          JOIN staged_transfer_stage_authorities commit_attempt
            ON commit_attempt.stage_id = commit_stage.stage_id
          JOIN staged_transfer_stage_receipts commit_receipt
            ON commit_receipt.stage_authority_id = commit_attempt.stage_authority_id
           AND commit_receipt.terminal_state = 'returned'
          JOIN staged_transfer_stage_authorities download_attempt
            ON download_attempt.stage_id = download_stage.stage_id
          JOIN staged_transfer_stage_receipts download_receipt
            ON download_receipt.stage_authority_id = download_attempt.stage_authority_id
           AND download_receipt.terminal_state = 'returned'
         WHERE commit_stage.plan_id = ?
           AND commit_stage.stage_kind = 'local_commit'
           AND commit_stage.json_pointer_digest = ?
         LIMIT 2
      `).all(owner.plan_id, pointerDigest) as Array<{
        blob_sha256: string;
        blob_md5: string;
        blob_bytes: number;
      }>;
      if (rows.length !== 1) {
        return { status: 'conflict', reason: 'result projection lacks one exact materialized file receipt' };
      }
      const original = pointerValue(projectedData, node.pointer);
      const mimetype = original && typeof original === 'object' && !Array.isArray(original)
        ? ((original as Record<string, unknown>).mimetype
          ?? (original as Record<string, unknown>).mimeType
          ?? null)
        : null;
      const replacement = {
        file_downloaded: true,
        artifact_handle: `staged-file:${rows[0]!.blob_sha256}`,
        sha256: rows[0]!.blob_sha256,
        byte_count: rows[0]!.blob_bytes,
        ...(typeof mimetype === 'string' ? { mimetype } : {}),
      };
      const replaced = replaceProjectionPointer(projectedData, node.pointer, replacement);
      if (!replaced.ok) {
        return { status: 'conflict', reason: 'result projection pointer no longer matches provider data' };
      }
      projectedData = replaced.value;
    }
    const serialized = closedCanonicalJson(projectedData, {
      maxDepth: 96,
      maxNodes: 500_000,
      maxStringBytes: MAX_RETURN_BYTES,
      maxTotalBytes: MAX_RETURN_BYTES,
    });
    if (/https:\/\//i.test(serialized) && nodes.length > 0) {
      // A schema-authorized descriptor URL must never survive replacement.
      // Other ordinary provider URLs are allowed only on no-download results.
      for (const node of nodes) {
        const remaining = pointerValue(projectedData, node.pointer);
        if (remaining && typeof remaining === 'object'
          && typeof (remaining as Record<string, unknown>).s3url === 'string') {
          return { status: 'conflict', reason: 'result projection retained a signed file URL' };
        }
      }
    }
    return {
      status: 'projected',
      value: { successful: true, error: null, data: projectedData },
    };
  } catch {
    return { status: 'conflict', reason: 'committed Composio result could not be projected safely' };
  }
}

export function committedComposioDownloadPlanOwns(
  plan: CommittedComposioDownloadPlan,
  returned: CommittedStagedPhysicalReturn,
  pointer: string,
): boolean {
  const state = committedDownloadPlans.get(plan as object);
  return Boolean(state && state.returned === returned
    && state.nodes.some((node) => node.pointer === pointer));
}

function pointerValue(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  if (!pointer.startsWith('/')) return undefined;
  let value = root;
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return undefined;
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return undefined;
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || 'get' in property || 'set' in property) return undefined;
      value = property.value;
      continue;
    }
    if (!value || typeof value !== 'object') return undefined;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || 'get' in property || 'set' in property) return undefined;
    value = property.value;
  }
  return value;
}

/** Mint a per-pointer opaque descriptor owner. Only digests leave this module;
 * the signed URL remains in the WeakMap and can later be consumed by the
 * module-owned one-GET transport. */
export function authorizeCommittedComposioDownload(input: {
  plan: CommittedComposioDownloadPlan;
  pointer: string;
}):
  | {
      status: 'authorized';
      authority: CommittedComposioDownloadAuthority;
      resultDigest: string;
      descriptorDigest: string;
    }
  | { status: 'conflict'; reason: string } {
  const state = committedDownloadPlans.get(input.plan as object);
  if (!state || !state.nodes.some((node) => node.pointer === input.pointer)) {
    return { status: 'conflict', reason: 'download pointer is not authorized by the exact committed result' };
  }
  const value = pointerValue(state.data, input.pointer);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'conflict', reason: 'download descriptor is malformed' };
  }
  const descriptor = value as Record<string, unknown>;
  const s3url = descriptor.s3url;
  const mimetype = descriptor.mimetype ?? descriptor.mimeType ?? null;
  if (
    typeof s3url !== 'string'
    || s3url.length < 1
    || s3url.length > 16 * 1024
    || !/^https:\/\//i.test(s3url)
    || (mimetype !== null && (typeof mimetype !== 'string' || mimetype.length > 512))
  ) return { status: 'conflict', reason: 'download descriptor is not an exact HTTPS provider file' };
  const normalized = { s3url, mimetype: mimetype as string | null };
  const descriptorDigest = sha256(closedCanonicalJson({
    protocol: 'staged_composio_download_descriptor_v1',
    resultDigest: state.resultDigest,
    pointer: input.pointer,
    descriptor: normalized,
  }));
  const authority = Object.freeze({ version: 1 as const });
  committedDownloadAuthorities.set(authority, {
    plan: input.plan,
    resultDigest: state.resultDigest,
    pointer: input.pointer,
    descriptorDigest,
    descriptor: normalized,
  });
  return { status: 'authorized', authority, resultDigest: state.resultDigest, descriptorDigest };
}

/** Copy-safe identity for stage derivation; never returns the signed URL. */
export function inspectCommittedComposioDownloadAuthority(
  authority: CommittedComposioDownloadAuthority,
): Readonly<{ resultDigest: string; pointer: string; descriptorDigest: string }> | null {
  const state = committedDownloadAuthorities.get(authority as object);
  return state
    ? {
        resultDigest: state.resultDigest,
        pointer: state.pointer,
        descriptorDigest: state.descriptorDigest,
      }
    : null;
}

export type ExecuteCommittedComposioDownloadBodyResult =
  | {
      status: 'returned';
      checkpoint: PreparedPhysicalReturnCheckpoint;
      blob: CommittedStagedDownloadBlob;
      sha256: string;
      md5: string;
      byteCount: number;
      bodyDigest: string;
      resultDigest: string;
    }
  | {
      status: 'threw';
      code: 'download_unavailable' | 'blob_too_large' | 'storage_error';
    }
  | { status: 'checkpoint_failed'; reason: string }
  | { status: 'conflict'; reason: string };

function stagedDownloadCheckpointPayload(input: {
  bodyDigest: string;
  blob: Pick<PublishedStagedFileBlob, 'sha256' | 'md5' | 'byteCount'>;
}): Record<string, unknown> {
  return {
    successful: true,
    data: {
      protocol: 'staged_blob_body_return_v1',
      stage_kind: 'download_transfer',
      body_digest: input.bodyDigest,
      sha256: input.blob.sha256,
      md5: input.blob.md5,
      byte_count: input.blob.byteCount,
    },
  };
}

function classifyDownloadBodyFailure(error: unknown): Extract<
  ExecuteCommittedComposioDownloadBodyResult,
  { status: 'threw' }
>['code'] {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code ?? '');
    if (code === 'blob_too_large') return 'blob_too_large';
    if (
      code === 'unsafe_store'
      || code === 'invalid_configuration'
      || code === 'storage_error'
      || code === 'invalid_staged_blob'
      || code === 'digest_mismatch'
    ) return 'storage_error';
  }
  return 'download_unavailable';
}

/**
 * Execute one exact provider-file GET behind the opaque descriptor carrier.
 * The signed URL is read only inside this module, redirects and retries are
 * disabled, and the response streams directly into the host-owned blob store.
 * A safe-metadata checkpoint is encrypted before any value returns to callers,
 * so a post-body fault leaves the physical attempt started/unknown instead of
 * inventing a provider throw or exposing response bytes.
 */
export async function executeCommittedComposioDownloadBody(input: {
  authority: StagedPhysicalDispatchAuthority;
  carrier: StagedDownloadBodyCarrier;
}): Promise<ExecuteCommittedComposioDownloadBodyResult> {
  const identity = identityFromAuthority(input.authority);
  if (!identity || identity.stageKind !== 'download_transfer') {
    return { status: 'conflict', reason: 'download body lacks its exact staged physical identity' };
  }
  const downloadAuthority = consumeStagedDownloadBodyCarrier(input);
  const descriptor = downloadAuthority
    ? committedDownloadAuthorities.get(downloadAuthority as object)
    : null;
  if (!downloadAuthority || !descriptor) {
    return { status: 'conflict', reason: 'download descriptor carrier no longer reopens' };
  }
  const transport = createPublicHttpsOriginTransport(descriptor.descriptor.s3url);
  if (!transport) {
    return { status: 'threw', code: 'download_unavailable' };
  }

  let writer: ReturnType<typeof createStagedFileBlobWriter> | null = null;
  let published: PublishedStagedFileBlob;
  try {
    writer = createStagedFileBlobWriter({ storeDirectory: composioFilesDir() });
    const response = await fetch(descriptor.descriptor.s3url, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/octet-stream' },
      signal: currentToolAbortSignal(),
      dispatcher: transport.dispatcher,
    } as RequestInit & { dispatcher: typeof transport.dispatcher });
    if (!response.ok || !response.body) {
      throw new Error('provider download did not return one byte stream');
    }
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        writer.write(next.value);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* the response body is already terminal */ }
    }
    published = publishStagedFileBlob({
      storeDirectory: composioFilesDir(),
      sealed: writer.seal(),
    });
  } catch (error) {
    writer?.abort();
    return { status: 'threw', code: classifyDownloadBodyFailure(error) };
  } finally {
    await transport.close();
  }

  const bodyDigest = sha256(closedCanonicalJson({
    protocol: 'staged_composio_download_body_v1',
    stageAuthorityId: identity.stageAuthorityId,
    stageAuthorityDigest: identity.stageAuthorityDigest,
    providerArgumentDigest: identity.providerArgumentDigest,
    sourceResultDigest: descriptor.resultDigest,
    descriptorDigest: descriptor.descriptorDigest,
    blob: {
      sha256: published.sha256,
      md5: published.md5,
      byteCount: published.byteCount,
    },
  }));
  const payloadBytes = canonicalReturnBytes(stagedDownloadCheckpointPayload({
    bodyDigest,
    blob: published,
  }));
  const resultDigest = sha256(payloadBytes);
  const blob = Object.freeze({ version: 1 as const });
  committedDownloadBlobs.set(blob, {
    authority: input.authority,
    downloadAuthority,
    blob: published,
    bodyDigest,
    resultDigest,
  });
  let checkpoint: PreparedPhysicalReturnCheckpoint;
  try {
    checkpoint = prepareCheckpoint(identity, payloadBytes, Object.freeze({
      kind: 'staged_download_blob',
      authority: input.authority,
      blob,
      sha256: published.sha256,
      md5: published.md5,
      byteCount: published.byteCount,
      bodyDigest,
      resultDigest,
    }));
  } catch {
    return {
      status: 'checkpoint_failed',
      reason: 'download body returned but its physical checkpoint could not be persisted',
    };
  }
  return {
    status: 'returned',
    checkpoint,
    blob,
    sha256: published.sha256,
    md5: published.md5,
    byteCount: published.byteCount,
    bodyDigest,
    resultDigest,
  };
}

/** Exact safe-metadata predicate for post-receipt blob-owner adoption. */
export function committedStagedDownloadBlobOwns(input: {
  authority: StagedPhysicalDispatchAuthority;
  blob: CommittedStagedDownloadBlob;
  sha256: string;
  md5: string;
  byteCount: number;
  bodyDigest: string;
  resultDigest: string;
}): boolean {
  const state = committedDownloadBlobs.get(input.blob as object);
  const expected = identityFromAuthority(input.authority);
  return Boolean(
    state
    && expected
    && expected.stageKind === 'download_transfer'
    && state.authority === input.authority
    && state.blob.sha256 === input.sha256
    && state.blob.md5 === input.md5
    && state.blob.byteCount === input.byteCount
    && state.bodyDigest === input.bodyDigest
    && state.resultDigest === input.resultDigest
    && sha256(canonicalReturnBytes(stagedDownloadCheckpointPayload({
      bodyDigest: state.bodyDigest,
      blob: state.blob,
    }))) === state.resultDigest,
  );
}

export function committedStagedPhysicalReturnOwns(
  returned: CommittedStagedPhysicalReturn,
  authority: StagedPhysicalDispatchAuthority,
): boolean {
  const state = committedStageReturns.get(returned as object);
  const expected = identityFromAuthority(authority);
  return Boolean(state && expected && sameIdentity(state.identity, expected));
}
