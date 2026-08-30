/**
 * Module-owned authority for a crash-reopenable staged file transfer.
 *
 * Durable rows are deliberately insufficient to mint execution.  A caller
 * must present the process-opaque parent admission produced by the single
 * consent/work reducer, and every restart must decrypt the manifest and
 * independently re-open the exact work binding, host catalog binding, live
 * paired provider definition, account observation, and derived stage graph.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import {
  composioFilesDir,
  inspectPreparedComposioOneShotDispatch,
  inspectPreparedComposioPresignOneShot,
  peekCurrentConnectedToolkits,
  prepareComposioOneShotDispatch,
  prepareComposioPresignOneShot,
  type ConnectedToolkit,
  type PreparedComposioOneShotDispatch,
  type PreparedComposioPresignOneShot,
} from '../../integrations/composio/client.js';
import {
  COMPOSIO_PROVIDER_SURFACE_VERSION,
  fingerprintComposioProviderDefinition,
} from '../../integrations/composio/provider-definition-identity.js';
import { registeredToolkitOfSlug } from '../../integrations/composio/toolkit-slug.js';
import {
  planStagedFileUploads,
  type StagedFileTransferNode,
} from '../../integrations/composio/staged-file-transfer-plan.js';
import {
  createStagedFileBlobWriter,
  materializeStagedFileBlob,
  publishStagedFileBlob,
  snapshotAllowedLocalFile,
  StagedFileBlobError,
  verifyStagedFileMaterialization,
  type PublishedStagedFileBlob,
} from '../../integrations/composio/staged-file-blob-store.js';
import { BASE_DIR } from '../../config.js';
import { getWorkspaceDirs } from '../../tools/shared.js';
import { currentToolAbortSignal } from '../tool-abort-context.js';
import { createPublicHttpsOriginTransport } from './public-https-origin.js';
import {
  digestSchema,
  fingerprintSchema,
} from '../../tools/tool-contract-store.js';
import {
  deriveExternalCapabilityCallSignalsV1,
  loadExternalCapabilityRiskAttestationV1,
} from './external-capability-risk-loader.js';
import {
  getCachedToolSchema,
  liveComposioOperationVersion,
  liveComposioOutputSchema,
  liveComposioSchemaFingerprint,
} from '../../tools/composio-schema-cache.js';
import {
  persistAuthorityEncryptedPayload,
  readAuthorityEncryptedPayload,
  type AuthorityEncryptedPayloadReference,
} from './authority-encrypted-payload-store.js';
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import { openEventLog } from './eventlog.js';
import { loadExpectedWorkCallBindingState } from './expected-work-admission.js';
import { loadHostCallCapabilityBinding } from './host-call-capability-binding.js';
import {
  activateDispatchLease,
  currentDispatchLease,
  isDispatchLeaseCurrent,
  type DispatchLeaseRef,
} from './dispatch-lease.js';
import {
  canonicalLogicalToolName,
  durableLogicalCallContract,
} from './logical-call-contract.js';
import {
  inspectStagedParentCallAdmission,
  type StagedParentCallAdmission,
} from './nested-tool-approval-admission.js';
import {
  authorizeCommittedComposioDownload,
  committedStagedDownloadBlobOwns,
  inspectCommittedComposioDownloadAuthority,
  planCommittedComposioDownloads,
  prepareStagedBlobBodyReturnCheckpoint,
  prepareStagedUploadTransferReturnCheckpoint,
  recoverCommittedStagedPhysicalReturn,
  type CommittedComposioDownloadAuthority,
  type CommittedStagedDownloadBlob,
  type PreparedPhysicalReturnCheckpoint,
} from './physical-return-checkpoint.js';

const DIGEST_RE = /^[a-f0-9]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9_.:@/#-]{1,512}$/;
const MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
const MANIFEST_MAX_NODES = 500_000;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export type StagedTransferStageKind =
  | 'local_snapshot'
  | 'source_download'
  | 'upload_presign'
  | 'upload_transfer'
  | 'business_execute'
  | 'download_transfer'
  | 'local_commit';

export type StagedTransferEffect = 'read' | 'compute' | 'local_write' | 'external_write' | 'admin';
export type StagedTransferRetryPolicy = 'none' | 'safe_terminal' | 'reconcile_before_retry';

interface StagedTransferManifestStageV2 {
  ordinal: number;
  kind: StagedTransferStageKind;
  pointer: string | null;
  pointerDigest: string | null;
  toolName: string;
  effect: StagedTransferEffect;
  dependsOnOrdinal: number | null;
  retryPolicy: StagedTransferRetryPolicy;
  manifestNodeDigest: string;
  stageDigest: string;
  /** Encrypted manifest material only. Never copied into SQLite or events. */
  source?: { kind: 'local_path' | 'remote_url'; value: string; valueDigest: string };
  /** Post-business-only value-opaque binding. The descriptor (including its
   * signed URL) remains owned by the physical-return checkpoint module. */
  download?: { resultDigest: string; descriptorDigest: string };
}

interface StagedTransferManifestV2 {
  protocol: 'staged_transfer_manifest_v2';
  parent: {
    sessionId: string;
    sourceUserSeq: number;
    acceptedTaskId: string;
    logicalToolCallId: string;
    toolName: string;
    argumentDigest: string;
    effect: StagedTransferEffect;
  };
  binding: {
    expectedWorkDigest: string;
    hostDurableBindingDigest: string;
    manifestId: string;
    manifestDigest: string;
  };
  provider: {
    operationId: string;
    operationVersion: string;
    providerVersion: string;
    invokePortId: string;
    toolkitSlug: string;
    accountId: string;
    accountIdentityDigest: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown> | null;
    inputSchemaDigest: string;
    outputSchemaDigest: string | null;
    definitionFingerprint: string;
    providerArgs: Record<string, unknown>;
    providerArgsDigest: string;
  };
  uploads: readonly StagedFileTransferNode[];
  outputMayContainDownloads: boolean;
  stages: readonly StagedTransferManifestStageV2[];
}

export interface StagedTransferPlanAuthority {
  readonly version: 1;
}

interface StagedTransferPlanAuthorityState {
  planId: string;
  planAuthorityDigest: string;
  manifest: StagedTransferManifestV2;
  manifestReference: AuthorityEncryptedPayloadReference;
  /** Initial manifest stages plus any exact post-business successors rederived
   * from the encrypted successful provider checkpoint. */
  stages: readonly StagedTransferManifestStageV2[];
  downloadAuthorities: ReadonlyMap<string, CommittedComposioDownloadAuthority>;
}

const planAuthorities = new WeakMap<object, StagedTransferPlanAuthorityState>();
/** Synchronous cycle breaker for checkpoint recovery while a plan is itself
 * being re-opened. Entries are already fully rederived through the frozen
 * parent/manifest/stable-stage tuple and never escape this call stack. */
const activePlanReopens = new Map<string, StagedTransferPlanAuthorityState>();

export interface StagedPhysicalDispatchAuthority {
  readonly version: 1;
}

export interface StagedPhysicalDispatchAuthorityState {
  planId: string;
  planAuthorityDigest: string;
  stageId: string;
  stageAuthorityId: string;
  stageKind: StagedTransferStageKind;
  stageOrdinal: number;
  attemptOrdinal: number;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  physicalDispatchId: string;
  toolName: string;
  argumentDigest: string;
  providerArgumentDigest: string;
  /** Immutable logical/control material used by the shared dispatch ledger.
   * It never appears in a prepared result or stage-body result. */
  ledgerArgs: Readonly<Record<string, unknown>>;
  /** Binds the compiler output to the exact immutable manifest and returned
   * dependency evidence without exposing that material. */
  dependencyBindingDigest: string;
  effect: StagedTransferEffect;
  lease: DispatchLeaseRef;
  retryOfStageAuthorityId?: string;
  authorityDigest: string;
  /** Forensic reopen of an already-returned crossing. It can recover encrypted
   * result ownership but can never authorize another provider body. */
  terminalOnly?: true;
}

const physicalAuthorities = new WeakMap<object, Readonly<StagedPhysicalDispatchAuthorityState>>();
const physicalInvocationArguments = new WeakMap<object, Readonly<Record<string, unknown>>>();
const physicalDownloadAuthorities = new WeakMap<object, CommittedComposioDownloadAuthority>();

/** Process-opaque ownership of one completed host-owned staged blob body. */
export interface StagedBlobBodyResult {
  readonly version: 1;
}

/** One-shot opaque handoff from a started download stage to the checkpoint
 * module that privately owns the authorized provider descriptor. */
export interface StagedDownloadBodyCarrier {
  readonly version: 1;
}

/** Process-opaque proof that one exact upload PUT reached an unambiguous 2xx
 * response and is ready for its synchronous return checkpoint. */
export interface StagedUploadTransferBodyResult {
  readonly version: 1;
}

interface StagedDownloadBodyCarrierState {
  authority: StagedPhysicalDispatchAuthority;
  downloadAuthority: CommittedComposioDownloadAuthority;
  stageAuthorityId: string;
  authorityDigest: string;
  providerArgumentDigest: string;
  resultDigest: string;
  descriptorDigest: string;
  consumed: boolean;
}

interface StagedBlobBodyResultState {
  authority: StagedPhysicalDispatchAuthority;
  stageAuthorityId: string;
  stageKind: 'local_snapshot' | 'source_download' | 'download_transfer' | 'local_commit';
  authorityDigest: string;
  providerArgumentDigest: string;
  blob: PublishedStagedFileBlob;
  bodyDigest: string;
  resultDigest: string;
}

interface StagedUploadTransferBodyResultState {
  authority: StagedPhysicalDispatchAuthority;
  stageAuthorityId: string;
  authorityDigest: string;
  providerArgumentDigest: string;
  blobSha256: string;
  blobMd5: string;
  byteCount: number;
  headerDigest: string;
  httpStatus: number;
  bodyDigest: string;
  resultDigest: string;
}

const enteredStagedBlobBodies = new WeakSet<object>();
const enteredStagedUploadTransferBodies = new WeakSet<object>();
const stagedBlobBodyResults = new WeakMap<object, Readonly<StagedBlobBodyResultState>>();
const stagedDownloadBodyCarriers = new WeakMap<object, StagedDownloadBodyCarrierState>();
const physicalDownloadBodyCarriers = new WeakMap<object, StagedDownloadBodyCarrier>();
const adoptedStagedDownloadBlobs = new WeakMap<object, Readonly<PublishedStagedFileBlob>>();
const physicalBusinessPreparations = new WeakMap<object, PreparedComposioOneShotDispatch>();
const physicalPresignPreparations = new WeakMap<object, PreparedComposioPresignOneShot>();
const stagedUploadTransferBodyResults = new WeakMap<
  object,
  Readonly<StagedUploadTransferBodyResultState>
>();

export type PrepareStagedTransferPlanResult =
  | { status: 'prepared' | 'replayed'; authority: StagedTransferPlanAuthority; planId: string }
  | { status: 'not_applicable' | 'preparation_required' | 'conflict' | 'storage_error'; reason: string };

export class StagedTransferAuthorityError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'storage_error', message: string) {
    super(message);
    this.name = 'StagedTransferAuthorityError';
  }
}

interface ExpectedWorkBindingRow {
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  logical_tool_call_id: string;
  contract_id: string;
  requirement_id: string;
  tool_name: string;
  argument_digest: string;
  effect_kind: StagedTransferEffect;
  cardinality_kind: string;
  universe_id: string | null;
  universe_seal: string | null;
  universe_item_id: string | null;
  universe_selector_json: string | null;
  universe_member_digest: string | null;
  universe_member_count: number | null;
  input_source_kind: string | null;
  input_source_ref: string | null;
  input_source_digest: string | null;
  evidence_mode: string | null;
  evidence_basis: string | null;
  schema_fingerprint: string | null;
  schema_digest: string | null;
  bound_at: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  return closedCanonicalJson(value, {
    maxDepth: 96,
    maxNodes: MANIFEST_MAX_NODES,
    maxStringBytes: MANIFEST_MAX_BYTES,
    maxTotalBytes: MANIFEST_MAX_BYTES,
  });
}

function digest(value: unknown): string {
  return sha256(canonical(value));
}

function expectedWorkBindingDigest(row: ExpectedWorkBindingRow): string {
  return digest({ protocol: 'staged_expected_work_binding_v1', row });
}

function safeId(value: unknown, max = 512): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && value.length <= max
    && SAFE_ID_RE.test(value);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pointerValue(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  let current = root;
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (RESERVED_KEYS.has(key)) throw new StagedTransferAuthorityError('invalid', 'reserved file pointer');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(key)) throw new StagedTransferAuthorityError('invalid', 'invalid file pointer');
      const index = Number(key);
      const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
      if (!descriptor || 'get' in descriptor || 'set' in descriptor) {
        throw new StagedTransferAuthorityError('invalid', 'unsafe file pointer');
      }
      current = descriptor.value;
      continue;
    }
    if (!plainRecord(current)) throw new StagedTransferAuthorityError('invalid', 'file pointer is absent');
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (!descriptor || 'get' in descriptor || 'set' in descriptor) {
      throw new StagedTransferAuthorityError('invalid', 'unsafe file pointer');
    }
    current = descriptor.value;
  }
  return current;
}

function schemaContainsAnnotation(root: unknown, annotation: 'file_downloadable'): boolean {
  const queue: unknown[] = [root];
  const seen = new Set<object>();
  let visited = 0;
  while (queue.length > 0) {
    if (++visited > 100_000) throw new StagedTransferAuthorityError('invalid', 'output schema traversal exceeded its bound');
    const value = queue.shift();
    if (value === null || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (!Array.isArray(value) && !plainRecord(value)) {
      throw new StagedTransferAuthorityError('invalid', 'output schema is not closed JSON');
    }
    for (const key of Object.keys(value)) {
      if (RESERVED_KEYS.has(key) || key === 'pattern' || key === 'patternProperties') {
        throw new StagedTransferAuthorityError('invalid', 'output schema contains unsupported authority syntax');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || 'get' in descriptor || 'set' in descriptor) {
        throw new StagedTransferAuthorityError('invalid', 'output schema contains an accessor');
      }
      if (key === annotation && descriptor.value === true) return true;
      queue.push(descriptor.value);
    }
  }
  return false;
}

function exactManifest(db: Database.Database, manifestId: string, manifestDigest: string): CapabilityManifestV1 | null {
  const row = db.prepare(`
    SELECT digest, manifest_json, lifecycle FROM capability_manifests WHERE manifest_id = ?
  `).get(manifestId) as { digest: string; manifest_json: string; lifecycle: string } | undefined;
  if (!row || row.digest !== manifestDigest || row.lifecycle !== 'current') return null;
  try {
    const parsed = currentCapabilityManifest(JSON.parse(row.manifest_json) as CapabilityManifestV1);
    return parsed && capabilityManifestDigest(parsed) === row.digest ? parsed : null;
  } catch {
    return null;
  }
}

function exactAccountIdentity(
  accountId: string,
  toolkitSlug: string,
  snapshot: readonly ConnectedToolkit[] | null,
): { digest: string } | null {
  if (!snapshot) return null;
  const exact = snapshot.filter((row) => row.connectionId === accountId && row.slug === toolkitSlug);
  if (exact.length !== 1) return null;
  const row = exact[0]!;
  if (!/active|enabled|initiat/i.test(row.status ?? '') || !row.ownerUserId?.trim()) return null;
  return {
    digest: digest({
      protocol: 'staged_composio_account_identity_v1',
      toolkitSlug: row.slug,
      connectionId: row.connectionId,
      ownerUserId: row.ownerUserId.trim(),
      accountEmail: row.accountEmail?.trim().toLowerCase() ?? null,
      wordId: row.wordId?.trim() ?? null,
    }),
  };
}

function stageDefinition(input: Omit<StagedTransferManifestStageV2, 'manifestNodeDigest' | 'stageDigest'> & {
  planSeed: string;
}): StagedTransferManifestStageV2 {
  const { planSeed, ...unsealedDefinition } = input;
  // The durable stage, child logical call, lease recovery contract, and
  // physical authority all cross independently persisted boundaries. Bind
  // every one to the same runtime-effective callable spelling up front. In
  // particular, MCP transport names such as `mcp__staged_http__get` normalize
  // to `staged_http__get`; persisting the transport spelling made the child
  // logical row disagree with the exact-stage authority trigger.
  const toolName = canonicalLogicalToolName(unsealedDefinition.toolName);
  if (!toolName) {
    throw new StagedTransferAuthorityError('invalid', 'staged transfer tool name is unsafe');
  }
  const definition = { ...unsealedDefinition, toolName };
  const manifestNodeDigest = digest({
    protocol: 'staged_transfer_manifest_node_v2',
    planSeed,
    ...definition,
  });
  return {
    ...definition,
    manifestNodeDigest,
    stageDigest: digest({
      protocol: 'staged_transfer_stage_v2',
      planSeed,
      manifestNodeDigest,
      ordinal: definition.ordinal,
    }),
  };
}

function deriveInitialStages(input: {
  planSeed: string;
  uploads: readonly StagedFileTransferNode[];
  providerArgs: Record<string, unknown>;
  operationId: string;
  effect: StagedTransferEffect;
}): StagedTransferManifestStageV2[] {
  const stages: StagedTransferManifestStageV2[] = [];
  for (const upload of input.uploads) {
    const pointerDigest = digest({ protocol: 'staged_file_pointer_v1', pointer: upload.pointer });
    const value = pointerValue(input.providerArgs, upload.pointer);
    if (typeof value !== 'string' || !value.trim()) {
      throw new StagedTransferAuthorityError('invalid', 'staged upload source must be a local path or HTTPS URL');
    }
    const sourceValue = value.trim();
    const remote = /^https:\/\//i.test(sourceValue);
    if (!remote && /^[a-z][a-z0-9+.-]*:\/\//i.test(sourceValue)) {
      throw new StagedTransferAuthorityError('invalid', 'only HTTPS remote upload sources are supported');
    }
    let dependency: number | null = null;
    if (remote) {
      const sourceOrdinal = stages.length + 1;
      stages.push(stageDefinition({
        planSeed: input.planSeed,
        ordinal: sourceOrdinal,
        kind: 'source_download',
        pointer: upload.pointer,
        pointerDigest,
        toolName: 'mcp__staged_http__get',
        effect: 'read',
        dependsOnOrdinal: null,
        retryPolicy: 'safe_terminal',
        source: { kind: 'remote_url', value: sourceValue, valueDigest: sha256(sourceValue) },
      }));
      dependency = sourceOrdinal;
    }
    const snapshotOrdinal = stages.length + 1;
    stages.push(stageDefinition({
      planSeed: input.planSeed,
      ordinal: snapshotOrdinal,
      kind: 'local_snapshot',
      pointer: upload.pointer,
      pointerDigest,
      toolName: 'write_file',
      effect: 'local_write',
      dependsOnOrdinal: dependency,
      retryPolicy: 'safe_terminal',
      source: {
        kind: remote ? 'remote_url' : 'local_path',
        value: sourceValue,
        valueDigest: sha256(sourceValue),
      },
    }));
    const presignOrdinal = stages.length + 1;
    stages.push(stageDefinition({
      planSeed: input.planSeed,
      ordinal: presignOrdinal,
      kind: 'upload_presign',
      pointer: upload.pointer,
      pointerDigest,
      toolName: 'composio_files_create_presigned_url',
      effect: 'external_write',
      dependsOnOrdinal: snapshotOrdinal,
      retryPolicy: 'reconcile_before_retry',
    }));
    const transferOrdinal = stages.length + 1;
    stages.push(stageDefinition({
      planSeed: input.planSeed,
      ordinal: transferOrdinal,
      kind: 'upload_transfer',
      pointer: upload.pointer,
      pointerDigest,
      toolName: 'mcp__staged_object_store__put',
      effect: 'external_write',
      dependsOnOrdinal: presignOrdinal,
      retryPolicy: 'reconcile_before_retry',
    }));
  }
  stages.push(stageDefinition({
    planSeed: input.planSeed,
    ordinal: stages.length + 1,
    kind: 'business_execute',
    pointer: null,
    pointerDigest: null,
    toolName: input.operationId,
    effect: input.effect,
    dependsOnOrdinal: stages.length > 0 ? stages.length : null,
    retryPolicy: 'none',
  }));
  return stages;
}

function providerDefinition(input: {
  operationId: string;
  operationVersion: string;
  accountId: string;
  invokePortId: string;
}): {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  inputSchemaDigest: string;
  outputSchemaDigest: string | null;
  definitionFingerprint: string;
} | null {
  const inputSchema = getCachedToolSchema(input.operationId);
  const liveInputFingerprint = liveComposioSchemaFingerprint(input.operationId);
  const liveVersion = liveComposioOperationVersion(input.operationId);
  const outputSchema = liveComposioOutputSchema(input.operationId);
  if (!inputSchema || !liveInputFingerprint || liveVersion !== input.operationVersion || outputSchema === undefined) {
    return null;
  }
  if (fingerprintSchema(inputSchema) !== liveInputFingerprint) return null;
  const definitionFingerprint = fingerprintComposioProviderDefinition({
    operationId: input.operationId,
    operationVersion: input.operationVersion,
    accountId: input.accountId,
    invokePortId: input.invokePortId,
    inputSchema,
    outputSchema,
  });
  if (!definitionFingerprint) return null;
  return {
    inputSchema,
    outputSchema,
    inputSchemaDigest: digestSchema(inputSchema),
    outputSchemaDigest: outputSchema ? digestSchema(outputSchema) : null,
    definitionFingerprint,
  };
}

type StagedConsentRisk =
  | { status: 'ready'; exactGrantRequired: boolean }
  | { status: 'unknown' };

/**
 * Independently project the same current external-definition risk facts before
 * any staged plan or encrypted manifest is persisted. The opaque parent grant
 * remains the authority, but a caller cannot label send/admin work "ordinary"
 * and thereby bypass the host consent reducer.
 */
function stagedConsentRisk(input: {
  capability: CapabilityManifestV1;
  definition: NonNullable<ReturnType<typeof providerDefinition>>;
  providerArgs: Record<string, unknown>;
}): StagedConsentRisk {
  if (input.capability.effect === 'admin') {
    return { status: 'ready', exactGrantRequired: true };
  }
  if (input.capability.effect !== 'external_write') {
    return { status: 'ready', exactGrantRequired: false };
  }
  const persisted = input.capability.externalDefinition;
  if (!persisted) return { status: 'unknown' };
  const callSignals = deriveExternalCapabilityCallSignalsV1({
    version: 1,
    inputSchema: input.definition.inputSchema,
    arguments: input.providerArgs,
  });
  if (callSignals.status !== 'projected') return { status: 'unknown' };
  const posture = input.capability.destination?.posture ?? 'not_applicable';
  if (!['create_new', 'named_existing', 'not_applicable'].includes(posture)) {
    return { status: 'unknown' };
  }
  const projected = loadExternalCapabilityRiskAttestationV1({
    version: 1,
    manifest: input.capability,
    currentDefinition: {
      version: 1,
      providerKind: 'composio',
      providerIdentity: input.capability.providerIdentity,
      providerVersion: input.capability.providerVersion,
      operationId: input.capability.operationId,
      operationVersion: input.capability.operationVersion,
      accountId: input.capability.accountId,
      manifestDefinitionFingerprint: input.capability.definitionFingerprint,
      schemaDigest: input.definition.inputSchemaDigest,
      inputSchema: input.definition.inputSchema,
      semanticName: persisted.semanticName,
      behaviorHints: { ...persisted.behaviorHints },
    },
    destination: {
      posture: posture as 'create_new' | 'named_existing' | 'not_applicable',
      digest: digest({
        protocol: 'staged_consent_destination_v1',
        manifestId: input.capability.manifestId,
        accountId: input.capability.accountId,
        destination: input.capability.destination ?? null,
      }),
    },
    callSignals: callSignals.callSignals,
    safety: 'admissible',
  });
  if (!projected.ok) return { status: 'unknown' };
  const risk = projected.attestation.projection.risk;
  return {
    status: 'ready',
    exactGrantRequired: risk.destructive
      || risk.reversibility === 'irreversible'
      || risk.consequence === 'send'
      || risk.consequence === 'delete'
      || risk.consequence === 'admin',
  };
}

function planRowFields(input: {
  planId: string;
  planAuthorityDigest: string;
  manifest: StagedTransferManifestV2;
  manifestReference: AuthorityEncryptedPayloadReference;
  expected: ExpectedWorkBindingRow;
  host: ReturnType<typeof loadHostCallCapabilityBinding> & { status: 'ok' };
  capability: CapabilityManifestV1;
  transferManifestDigest: string;
  manifestBindingDigest: string;
  consent: { requirement: 'none' | 'exact_grant'; subjectDigest: string | null };
  now: string;
}): readonly unknown[] {
  const parent = input.manifest.parent;
  const provider = input.manifest.provider;
  return [
    input.planId, parent.sessionId, parent.sourceUserSeq, parent.acceptedTaskId,
    parent.logicalToolCallId, parent.toolName, parent.argumentDigest, parent.effect,
    input.expected.contract_id, input.expected.requirement_id,
    input.manifest.binding.expectedWorkDigest, input.host.binding.durableBindingDigest,
    input.host.binding.capabilityId, input.host.binding.accountId,
    input.host.binding.invokePortId, input.host.binding.operationId,
    input.host.binding.providerInputSchemaDigest, input.host.binding.schemaFingerprint,
    input.capability.definitionFingerprint, input.capability.manifestId,
    capabilityManifestDigest(input.capability), provider.inputSchemaDigest,
    provider.outputSchemaDigest, input.manifest.outputMayContainDownloads ? 1 : 0,
    provider.operationVersion, provider.toolkitSlug,
    provider.accountIdentityDigest, input.transferManifestDigest, input.manifestBindingDigest,
    input.manifestReference.payloadId, input.manifestReference.plaintextSha256,
    input.manifestReference.plaintextBytes, input.manifestReference.chunkCount,
    input.manifestReference.sealedFileSha256, input.manifestReference.sealedFileBytes,
    input.consent.requirement, input.consent.subjectDigest, input.planAuthorityDigest,
    input.now, input.now,
  ];
}

function persistPlan(input: {
  db: Database.Database;
  planId: string;
  planAuthorityDigest: string;
  manifest: StagedTransferManifestV2;
  manifestReference: AuthorityEncryptedPayloadReference;
  expected: ExpectedWorkBindingRow;
  host: ReturnType<typeof loadHostCallCapabilityBinding> & { status: 'ok' };
  capability: CapabilityManifestV1;
  transferManifestDigest: string;
  manifestBindingDigest: string;
  consent: {
    requirement: 'none' | 'exact_grant';
    subjectDigest: string | null;
    exactGrant?: { approvalId: string; consentSubjectDigest: string; grantDigest: string };
  };
}): 'prepared' | 'replayed' {
  const existing = input.db.prepare(`
    SELECT plan_authority_digest FROM staged_transfer_plans
     WHERE session_id = ? AND source_user_seq = ? AND parent_logical_tool_call_id = ?
  `).get(
    input.manifest.parent.sessionId,
    input.manifest.parent.sourceUserSeq,
    input.manifest.parent.logicalToolCallId,
  ) as { plan_authority_digest: string } | undefined;
  if (existing) {
    if (existing.plan_authority_digest !== input.planAuthorityDigest) {
      throw new StagedTransferAuthorityError('conflict', 'parent call already owns a different staged plan');
    }
    return 'replayed';
  }
  const now = new Date().toISOString();
  if (input.consent.requirement === 'exact_grant') {
    const grant = input.consent.exactGrant;
    if (!grant || grant.consentSubjectDigest !== input.consent.subjectDigest) {
      throw new StagedTransferAuthorityError('conflict', 'exact staged consent grant was lost');
    }
    const resumeKey = `host-consent:v1:${grant.consentSubjectDigest}`;
    const claimed = input.db.prepare(`
      UPDATE pending_approvals
         SET consumed_at = ?
       WHERE approval_id = ?
         AND session_id = ?
         AND resume_key = ?
         AND status = 'resolved'
         AND resolution = 'approved'
         AND resolved_at IS NOT NULL
         AND resolved_at <= expires_at
         AND expires_at >= ?
         AND consumed_at IS NULL
    `).run(
      now,
      grant.approvalId,
      input.manifest.parent.sessionId,
      resumeKey,
      now,
    );
    if (claimed.changes !== 1) {
      throw new StagedTransferAuthorityError(
        'conflict',
        'exact staged consent grant is unavailable or already consumed',
      );
    }
  }
  input.db.prepare(`
    INSERT INTO staged_transfer_plans
      (plan_id, session_id, source_user_seq, accepted_task_id,
       parent_logical_tool_call_id, parent_tool_name, parent_argument_digest,
       parent_effect_kind, expected_work_contract_id, expected_work_requirement_id,
       expected_work_binding_digest, host_durable_binding_digest, host_capability_id,
       host_account_id, host_invoke_port_id, host_operation_id,
       host_provider_input_schema_digest, host_schema_fingerprint,
       host_definition_fingerprint, host_manifest_id, host_manifest_digest,
       input_schema_digest, output_schema_digest, output_may_contain_downloads,
       operation_version, toolkit_slug,
       account_identity_digest, transfer_manifest_digest, manifest_binding_digest,
       manifest_payload_id, manifest_format, manifest_plaintext_sha256,
       manifest_plaintext_bytes, manifest_chunk_count, manifest_sealed_sha256,
       manifest_sealed_bytes, consent_requirement, consent_subject_digest,
       plan_authority_digest, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged_transfer_manifest_v2', ?, ?, ?, ?, ?,
            ?, ?, ?, 'prepared', ?, ?)
  `).run(...planRowFields({ ...input, now }));
  for (const stage of input.manifest.stages) {
    const stageId = `staged-stage:${stage.stageDigest}`;
    input.db.prepare(`
      INSERT INTO staged_transfer_stages
        (stage_id, plan_id, session_id, source_user_seq, accepted_task_id,
         stage_ordinal, stage_kind, json_pointer_digest, tool_name, effect_kind,
         depends_on_stage_ordinal, retry_policy, manifest_node_digest, stage_digest,
         created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      stageId,
      input.planId,
      input.manifest.parent.sessionId,
      input.manifest.parent.sourceUserSeq,
      input.manifest.parent.acceptedTaskId,
      stage.ordinal,
      stage.kind,
      stage.pointerDigest,
      stage.toolName,
      stage.effect,
      stage.dependsOnOrdinal,
      stage.retryPolicy,
      stage.manifestNodeDigest,
      stage.stageDigest,
      now,
    );
  }
  if (input.consent.requirement === 'exact_grant') {
    const grant = input.consent.exactGrant;
    // The exact approval was claimed above in this same IMMEDIATE
    // transaction. Any later plan/stage/redemption failure therefore rolls
    // the claim back with the authority rows instead of creating a
    // claim-before-plan crash gap.
    if (!grant) throw new StagedTransferAuthorityError('conflict', 'exact staged consent grant was lost');
    input.db.prepare(`
      INSERT INTO staged_transfer_consent_redemptions
        (plan_id, approval_id, consent_subject_digest, grant_digest, redeemed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.planId, grant.approvalId, grant.consentSubjectDigest, grant.grantDigest, now);
  }
  return 'prepared';
}

/** Persist an upload/download saga without reading file bytes or starting I/O. */
export function prepareStagedTransferPlan(input: {
  parentAdmission: StagedParentCallAdmission;
  providerArgs: Record<string, unknown>;
}): PrepareStagedTransferPlanResult {
  const parent = inspectStagedParentCallAdmission(input.parentAdmission);
  if (!parent) return { status: 'conflict', reason: 'staged parent admission is not opaque and current' };
  const initialContract = plainRecord(input.providerArgs)
    ? durableLogicalCallContract(parent.acceptedTaskId, parent.toolName, input.providerArgs)
    : null;
  if (
    !initialContract
    || initialContract.toolName !== parent.toolName
    || initialContract.argumentDigest !== parent.argumentDigest
  ) return { status: 'conflict', reason: 'staged manifest arguments differ from the exact parent call' };
  try {
    const db = openEventLog();
    const expectedState = loadExpectedWorkCallBindingState({
      sessionId: parent.sessionId,
      sourceUserSeq: parent.sourceUserSeq,
      logicalToolCallId: parent.logicalToolCallId,
    });
    const host = loadHostCallCapabilityBinding({
      db,
      sessionId: parent.sessionId,
      sourceUserSeq: parent.sourceUserSeq,
      logicalToolCallId: parent.logicalToolCallId,
    });
    if (expectedState.status !== 'ok' || host.status !== 'ok') {
      return { status: 'conflict', reason: 'staged parent durable work or catalog binding is unavailable' };
    }
    const expected = db.prepare(`
      SELECT * FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(parent.sessionId, parent.sourceUserSeq, parent.logicalToolCallId) as ExpectedWorkBindingRow | undefined;
    if (!expected) return { status: 'conflict', reason: 'staged expected-work row is missing' };
    const expectedDigest = expectedWorkBindingDigest(expected);
    if (
      expected.accepted_task_id !== parent.acceptedTaskId
      || expected.contract_id !== parent.contractId
      || expected.requirement_id !== parent.requirementId
      || expected.tool_name !== parent.toolName
      || expected.argument_digest !== parent.argumentDigest
      || expected.effect_kind !== parent.effect
      || expectedState.binding.contractId !== parent.contractId
      || host.binding.durableBindingDigest !== parent.hostCapabilityBindingDigest
      || host.binding.bindingKind !== 'catalog_manifest'
      || host.binding.toolName !== parent.toolName
      || host.binding.effectiveArgumentDigest !== parent.argumentDigest
      || host.binding.effect !== parent.effect
    ) return { status: 'conflict', reason: 'staged parent binding tuple changed' };
    const capability = exactManifest(db, host.binding.manifestId, host.binding.manifestDigest);
    if (
      !capability
      || capability.providerKind !== 'composio'
      || capability.manifestId !== host.binding.manifestId
      || capability.operationId !== host.binding.operationId
      || capability.accountId !== host.binding.accountId
      || capability.invokePortId !== host.binding.invokePortId
      || capability.definitionFingerprint !== host.binding.schemaFingerprint
      || capability.providerVersion !== COMPOSIO_PROVIDER_SURFACE_VERSION
      || capability.externalDefinition?.providerOutputSchemaObserved !== true
    ) return { status: 'preparation_required', reason: 'exact current paired Composio definition is unavailable' };
    const definition = providerDefinition({
      operationId: capability.operationId,
      operationVersion: capability.operationVersion,
      accountId: capability.accountId,
      invokePortId: capability.invokePortId,
    });
    if (
      !definition
      || definition.definitionFingerprint !== capability.definitionFingerprint
      || definition.inputSchemaDigest !== capability.externalDefinition.providerInputSchemaDigest
      || definition.inputSchemaDigest !== host.binding.providerInputSchemaDigest
      || definition.outputSchemaDigest !== (capability.externalDefinition.providerOutputSchemaDigest ?? null)
    ) return { status: 'preparation_required', reason: 'current Composio input/output/version identity drifted' };
    const toolkitSlug = registeredToolkitOfSlug(capability.operationId);
    const account = exactAccountIdentity(capability.accountId, toolkitSlug, peekCurrentConnectedToolkits());
    if (!account) return { status: 'preparation_required', reason: 'current exact Composio account identity is unavailable' };
    const uploads = planStagedFileUploads(definition.inputSchema, input.providerArgs);
    const outputMayContainDownloads = definition.outputSchema
      ? schemaContainsAnnotation(definition.outputSchema, 'file_downloadable')
      : false;
    if (uploads.length === 0 && !outputMayContainDownloads) {
      return { status: 'not_applicable', reason: 'the exact runtime call has no staged file transfer' };
    }
    const consentRisk = stagedConsentRisk({
      capability,
      definition,
      providerArgs: input.providerArgs,
    });
    if (consentRisk.status !== 'ready') {
      return {
        status: 'preparation_required',
        reason: 'the exact staged call consent risk could not be projected',
      };
    }
    const exactGrant = parent.exactGrant;
    const exactGrantIsClosed = Boolean(
      exactGrant
      && SAFE_ID_RE.test(exactGrant.approvalId)
      && DIGEST_RE.test(exactGrant.consentSubjectDigest)
      && DIGEST_RE.test(exactGrant.grantDigest)
    );
    if (consentRisk.exactGrantRequired && parent.consentBasis !== 'exact_user_grant') {
      return {
        status: 'preparation_required',
        reason: 'this high-consequence staged call requires its exact redeemed user grant',
      };
    }
    if (parent.consentBasis === 'exact_user_grant' && !exactGrantIsClosed) {
      return { status: 'conflict', reason: 'high-consequence staged call lost its exact grant' };
    }
    const consent = parent.consentBasis === 'exact_user_grant'
      ? {
          requirement: 'exact_grant' as const,
          subjectDigest: exactGrant!.consentSubjectDigest,
          exactGrant: exactGrant!,
        }
      : { requirement: 'none' as const, subjectDigest: null };
    const providerArgsBytes = canonical(input.providerArgs);
    const providerArgsDigest = sha256(providerArgsBytes);
    const planSeed = digest({
      protocol: 'staged_transfer_plan_seed_v2',
      sessionId: parent.sessionId,
      sourceUserSeq: parent.sourceUserSeq,
      logicalToolCallId: parent.logicalToolCallId,
      expectedDigest,
      hostDigest: host.binding.durableBindingDigest,
      providerArgsDigest,
      definitionFingerprint: definition.definitionFingerprint,
    });
    const stages = deriveInitialStages({
      planSeed,
      uploads,
      providerArgs: input.providerArgs,
      // Stage admission reuses the already-canonical durable parent logical
      // tool name. The provider's raw operation identifier stays in the
      // frozen provider manifest for the invocation edge.
      operationId: parent.toolName,
      effect: parent.effect,
    });
    const manifest: StagedTransferManifestV2 = {
      protocol: 'staged_transfer_manifest_v2',
      parent: {
        sessionId: parent.sessionId,
        sourceUserSeq: parent.sourceUserSeq,
        acceptedTaskId: parent.acceptedTaskId,
        logicalToolCallId: parent.logicalToolCallId,
        toolName: parent.toolName,
        argumentDigest: parent.argumentDigest,
        effect: parent.effect,
      },
      binding: {
        expectedWorkDigest: expectedDigest,
        hostDurableBindingDigest: host.binding.durableBindingDigest,
        manifestId: capability.manifestId,
        manifestDigest: capabilityManifestDigest(capability),
      },
      provider: {
        operationId: capability.operationId,
        operationVersion: capability.operationVersion,
        providerVersion: capability.providerVersion,
        invokePortId: capability.invokePortId,
        toolkitSlug,
        accountId: capability.accountId,
        accountIdentityDigest: account.digest,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        inputSchemaDigest: definition.inputSchemaDigest,
        outputSchemaDigest: definition.outputSchemaDigest,
        definitionFingerprint: definition.definitionFingerprint,
        providerArgs: JSON.parse(providerArgsBytes) as Record<string, unknown>,
        providerArgsDigest,
      },
      uploads,
      outputMayContainDownloads,
      stages,
    };
    const manifestBytes = Buffer.from(canonical(manifest), 'utf8');
    const transferManifestDigest = sha256(manifestBytes);
    const planId = `staged-plan:${digest({ protocol: 'staged_transfer_plan_id_v2', planSeed, transferManifestDigest })}`;
    const manifestBindingDigest = digest({
      protocol: 'staged_transfer_manifest_binding_v2',
      planId,
      transferManifestDigest,
      expectedDigest,
      hostDigest: host.binding.durableBindingDigest,
    });
    const manifestReference = persistAuthorityEncryptedPayload({
      payloadKind: 'staged_transfer_manifest',
      bindingDigest: manifestBindingDigest,
      bytes: manifestBytes,
    });
    const planAuthorityDigest = digest({
      protocol: 'staged_transfer_plan_authority_v2',
      planId,
      transferManifestDigest,
      manifestBindingDigest,
      manifestReference,
      consentRequirement: consent.requirement,
      consentSubjectDigest: consent.subjectDigest,
    });
    const transaction = db.transaction(() => persistPlan({
      db,
      planId,
      planAuthorityDigest,
      manifest,
      manifestReference,
      expected,
      host,
      capability,
      transferManifestDigest,
      manifestBindingDigest,
      consent,
    }));
    const status = transaction.immediate();
    const authority = Object.freeze({ version: 1 as const });
    planAuthorities.set(authority, {
      planId,
      planAuthorityDigest,
      manifest,
      manifestReference,
      stages: manifest.stages,
      downloadAuthorities: new Map(),
    });
    return { status, authority, planId };
  } catch (error) {
    if (error instanceof StagedTransferAuthorityError) {
      return {
        status: error.code === 'storage_error'
          ? 'storage_error'
          : error.code === 'conflict' ? 'conflict' : 'preparation_required',
        reason: error.message,
      };
    }
    return { status: 'storage_error', reason: 'staged transfer plan could not be persisted' };
  }
}

function referenceFromPlanRow(row: Record<string, unknown>): AuthorityEncryptedPayloadReference {
  return {
    version: 1,
    payloadId: String(row.manifest_payload_id),
    payloadKind: 'staged_transfer_manifest',
    bindingDigest: String(row.manifest_binding_digest),
    plaintextSha256: String(row.manifest_plaintext_sha256),
    plaintextBytes: Number(row.manifest_plaintext_bytes),
    chunkCount: Number(row.manifest_chunk_count),
    sealedFileSha256: String(row.manifest_sealed_sha256),
    sealedFileBytes: Number(row.manifest_sealed_bytes),
  };
}

interface DerivedDownloadSuccessors {
  status: 'pending' | 'ready' | 'conflict';
  stages: readonly StagedTransferManifestStageV2[];
  authorities: ReadonlyMap<string, CommittedComposioDownloadAuthority>;
  business?: Readonly<{
    stageAuthorityId: string;
    resultDigest: string;
  }>;
  reason?: string;
}

interface StoredDownloadTopologyReceipt {
  plan_id: string;
  business_stage_authority_id: string;
  business_result_digest: string;
  topology_digest: string;
  successor_stage_count: number;
}

interface DownloadTopologySqlAdmission {
  planId: string;
  businessStageAuthorityId: string;
  businessResultDigest: string;
  topologyDigest: string;
  successorStageCount: number;
  consumed: boolean;
}

const topologySqlFunctionInstalled = new WeakSet<object>();
const activeTopologySqlAdmissions = new WeakMap<object, DownloadTopologySqlAdmission>();

interface StagedBlobOwnerSqlAdmission {
  planId: string;
  stageId: string;
  sha256: string;
  md5: string;
  byteCount: number;
  consumed: boolean;
}

const blobOwnerSqlFunctionInstalled = new WeakSet<object>();
const activeBlobOwnerSqlAdmissions = new WeakMap<object, StagedBlobOwnerSqlAdmission>();

function installDownloadTopologySqlAdmissionFunction(db: Database.Database): void {
  if (topologySqlFunctionInstalled.has(db)) return;
  db.function(
    'clementine_staged_topology_admitted_v1',
    (
      planId: unknown,
      businessStageAuthorityId: unknown,
      businessResultDigest: unknown,
      topologyDigest: unknown,
      successorStageCount: unknown,
    ): number => {
      const admission = activeTopologySqlAdmissions.get(db);
      if (
        !admission
        || admission.consumed
        || planId !== admission.planId
        || businessStageAuthorityId !== admission.businessStageAuthorityId
        || businessResultDigest !== admission.businessResultDigest
        || topologyDigest !== admission.topologyDigest
        || successorStageCount !== admission.successorStageCount
      ) return 0;
      admission.consumed = true;
      return 1;
    },
  );
  topologySqlFunctionInstalled.add(db);
}

function insertAdmittedDownloadTopologyReceipt(input: {
  db: Database.Database;
  planId: string;
  businessStageAuthorityId: string;
  businessResultDigest: string;
  topologyDigest: string;
  successorStageCount: number;
  recordedAt: string;
}): void {
  installDownloadTopologySqlAdmissionFunction(input.db);
  if (activeTopologySqlAdmissions.has(input.db)) {
    throw new StagedTransferAuthorityError('conflict', 'download topology SQL admission is already active');
  }
  const admission: DownloadTopologySqlAdmission = {
    planId: input.planId,
    businessStageAuthorityId: input.businessStageAuthorityId,
    businessResultDigest: input.businessResultDigest,
    topologyDigest: input.topologyDigest,
    successorStageCount: input.successorStageCount,
    consumed: false,
  };
  activeTopologySqlAdmissions.set(input.db, admission);
  try {
    const inserted = input.db.prepare(`
      INSERT INTO staged_transfer_download_topology_receipts
        (plan_id, business_stage_authority_id, business_result_digest,
         topology_digest, successor_stage_count, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.planId,
      input.businessStageAuthorityId,
      input.businessResultDigest,
      input.topologyDigest,
      input.successorStageCount,
      input.recordedAt,
    );
    if (inserted.changes !== 1 || !admission.consumed) {
      throw new StagedTransferAuthorityError('conflict', 'download topology SQL admission was not consumed exactly');
    }
  } finally {
    activeTopologySqlAdmissions.delete(input.db);
  }
}

function installStagedBlobOwnerSqlAdmissionFunction(db: Database.Database): void {
  if (blobOwnerSqlFunctionInstalled.has(db)) return;
  db.function(
    'clementine_staged_blob_owner_admitted_v1',
    (
      planId: unknown,
      stageId: unknown,
      sha256Digest: unknown,
      md5Digest: unknown,
      byteCount: unknown,
    ): number => {
      const admission = activeBlobOwnerSqlAdmissions.get(db);
      if (
        !admission
        || admission.consumed
        || planId !== admission.planId
        || stageId !== admission.stageId
        || sha256Digest !== admission.sha256
        || md5Digest !== admission.md5
        || byteCount !== admission.byteCount
      ) return 0;
      admission.consumed = true;
      return 1;
    },
  );
  blobOwnerSqlFunctionInstalled.add(db);
}

function insertAdmittedStagedBlobOwner(input: {
  db: Database.Database;
  planId: string;
  stageId: string;
  sha256: string;
  md5: string;
  byteCount: number;
  createdAt: string;
}): void {
  installStagedBlobOwnerSqlAdmissionFunction(input.db);
  if (activeBlobOwnerSqlAdmissions.has(input.db)) {
    throw new StagedTransferAuthorityError('conflict', 'staged blob-owner SQL admission is already active');
  }
  const admission: StagedBlobOwnerSqlAdmission = {
    planId: input.planId,
    stageId: input.stageId,
    sha256: input.sha256,
    md5: input.md5,
    byteCount: input.byteCount,
    consumed: false,
  };
  activeBlobOwnerSqlAdmissions.set(input.db, admission);
  try {
    const inserted = input.db.prepare(`
      INSERT INTO staged_transfer_blob_owners
        (plan_id, stage_id, blob_sha256, blob_md5, blob_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.planId,
      input.stageId,
      input.sha256,
      input.md5,
      input.byteCount,
      input.createdAt,
    );
    if (inserted.changes !== 1 || !admission.consumed) {
      throw new StagedTransferAuthorityError('conflict', 'staged blob-owner SQL admission was not consumed exactly');
    }
  } finally {
    activeBlobOwnerSqlAdmissions.delete(input.db);
  }
}

function storedSuccessorMatches(
  stored: Record<string, unknown>,
  stage: StagedTransferManifestStageV2,
): boolean {
  return stored.stage_ordinal === stage.ordinal
    && stored.stage_kind === stage.kind
    && stored.json_pointer_digest === stage.pointerDigest
    && stored.tool_name === stage.toolName
    && stored.effect_kind === stage.effect
    && stored.depends_on_stage_ordinal === stage.dependsOnOrdinal
    && stored.retry_policy === stage.retryPolicy
    && stored.manifest_node_digest === stage.manifestNodeDigest
    && stored.stage_digest === stage.stageDigest;
}

function downloadTopologyDigest(input: {
  state: StagedTransferPlanAuthorityState;
  business: Readonly<{ stageAuthorityId: string; resultDigest: string }>;
  stages: readonly StagedTransferManifestStageV2[];
}): string {
  return digest({
    protocol: 'staged_download_topology_v1',
    planAuthorityDigest: input.state.planAuthorityDigest,
    businessStageAuthorityId: input.business.stageAuthorityId,
    businessResultDigest: input.business.resultDigest,
    successors: input.stages.map((stage) => ({
      stageId: `staged-stage:${stage.stageDigest}`,
      ordinal: stage.ordinal,
      kind: stage.kind,
      pointer: stage.pointer,
      pointerDigest: stage.pointerDigest,
      toolName: stage.toolName,
      effect: stage.effect,
      dependsOnOrdinal: stage.dependsOnOrdinal,
      retryPolicy: stage.retryPolicy,
      manifestNodeDigest: stage.manifestNodeDigest,
      stageDigest: stage.stageDigest,
      source: stage.source ?? null,
      download: stage.download ?? null,
    })),
  });
}

function deriveDownloadSuccessors(
  state: StagedTransferPlanAuthorityState,
): DerivedDownloadSuccessors {
  if (!state.manifest.outputMayContainDownloads) {
    return { status: 'ready', stages: [], authorities: new Map() };
  }
  if (!state.manifest.provider.outputSchema) {
    return {
      status: 'conflict',
      stages: [],
      authorities: new Map(),
      reason: 'download applicability lost its frozen output schema',
    };
  }
  const businessStage = state.manifest.stages.find((stage) => stage.kind === 'business_execute');
  if (!businessStage) return {
    status: 'conflict',
    stages: [],
    authorities: new Map(),
    reason: 'staged business stage is missing',
  };
  const db = openEventLog();
  const businessEvidence = successfulStageEvidence(
    db,
    state.planId,
    `staged-stage:${businessStage.stageDigest}`,
  );
  if (!businessEvidence) {
    return { status: 'pending', stages: [], authorities: new Map() };
  }
  const business = Object.freeze({
    stageAuthorityId: businessEvidence.stageAuthorityId,
    resultDigest: businessEvidence.resultDigest,
  });
  const reopened = reopenStagedPhysicalFromExactPlan({
    state,
    stageOrdinal: businessStage.ordinal,
    attemptOrdinal: businessEvidence.attemptOrdinal,
  });
  if (reopened.status !== 'replayed') return {
    status: 'conflict',
    stages: [],
    authorities: new Map(),
    reason: 'returned business attempt cannot be reopened exactly',
  };
  const recovered = recoverCommittedStagedPhysicalReturn({ authority: reopened.authority });
  if (recovered.status !== 'committed') return {
    status: 'conflict',
    stages: [],
    authorities: new Map(),
    reason: 'returned business checkpoint cannot be recovered exactly',
  };
  const planned = planCommittedComposioDownloads({
    returned: recovered.returned,
    outputSchema: state.manifest.provider.outputSchema,
  });
  if (planned.status === 'not_applicable') {
    return { status: 'ready', stages: [], authorities: new Map(), business };
  }
  if (planned.status !== 'planned') return {
    status: 'conflict',
    stages: [],
    authorities: new Map(),
    reason: 'returned business data cannot authorize downloads',
  };
  const authorities = new Map<string, CommittedComposioDownloadAuthority>();
  const stages: StagedTransferManifestStageV2[] = [];
  for (const node of planned.nodes) {
    const authorized = authorizeCommittedComposioDownload({
      plan: planned.plan,
      pointer: node.pointer,
    });
    if (authorized.status !== 'authorized') return {
      status: 'conflict',
      stages: [],
      authorities: new Map(),
      reason: 'returned download descriptor cannot be authorized exactly',
    };
    const pointerDigest = digest({
      protocol: 'staged_file_pointer_v1',
      pointer: node.pointer,
    });
    const dynamicSeed = digest({
      protocol: 'staged_download_successor_seed_v1',
      planAuthorityDigest: state.planAuthorityDigest,
      outputSchemaDigest: state.manifest.provider.outputSchemaDigest,
      resultDigest: authorized.resultDigest,
      pointer: node.pointer,
      pointerDigest,
      descriptorDigest: authorized.descriptorDigest,
    });
    const downloadOrdinal = state.manifest.stages.length + stages.length + 1;
    const download = stageDefinition({
      planSeed: dynamicSeed,
      ordinal: downloadOrdinal,
      kind: 'download_transfer',
      pointer: node.pointer,
      pointerDigest,
      toolName: 'mcp__staged_http__get',
      effect: 'read',
      dependsOnOrdinal: businessStage.ordinal,
      retryPolicy: 'safe_terminal',
      download: {
        resultDigest: authorized.resultDigest,
        descriptorDigest: authorized.descriptorDigest,
      },
    });
    const commit = stageDefinition({
      planSeed: dynamicSeed,
      ordinal: downloadOrdinal + 1,
      kind: 'local_commit',
      pointer: node.pointer,
      pointerDigest,
      toolName: 'write_file',
      effect: 'local_write',
      dependsOnOrdinal: downloadOrdinal,
      retryPolicy: 'safe_terminal',
      download: {
        resultDigest: authorized.resultDigest,
        descriptorDigest: authorized.descriptorDigest,
      },
    });
    stages.push(download, commit);
    authorities.set(download.stageDigest, authorized.authority);
  }
  return {
    status: 'ready',
    stages: Object.freeze(stages),
    authorities,
    business,
  };
}

/** Restart entry: decrypt and re-derive before recreating a process token. */
export function reopenStagedTransferPlanAuthority(input: {
  sessionId: string;
  sourceUserSeq: number;
  parentLogicalToolCallId: string;
}): { status: 'ok'; authority: StagedTransferPlanAuthority; planId: string }
  | { status: 'missing' | 'conflict' | 'storage_error'; reason: string } {
  try {
    const db = openEventLog();
    const row = db.prepare(`
      SELECT * FROM staged_transfer_plans
       WHERE session_id = ? AND source_user_seq = ? AND parent_logical_tool_call_id = ?
    `).get(input.sessionId, input.sourceUserSeq, input.parentLogicalToolCallId) as Record<string, unknown> | undefined;
    if (!row) return { status: 'missing', reason: 'staged transfer plan is missing' };
    const reference = referenceFromPlanRow(row);
    const opened = readAuthorityEncryptedPayload({
      reference,
      payloadKind: 'staged_transfer_manifest',
      bindingDigest: reference.bindingDigest,
    });
    if (opened.status !== 'ok') {
      return { status: opened.status === 'storage_error' ? 'storage_error' : 'conflict', reason: 'staged manifest is unavailable' };
    }
    if (sha256(opened.bytes) !== row.transfer_manifest_digest) {
      return { status: 'conflict', reason: 'staged manifest digest changed' };
    }
    const parsed = JSON.parse(opened.bytes.toString('utf8')) as StagedTransferManifestV2;
    if (
      parsed.protocol !== 'staged_transfer_manifest_v2'
      || canonical(parsed) !== opened.bytes.toString('utf8')
      || parsed.parent.sessionId !== input.sessionId
      || parsed.parent.sourceUserSeq !== input.sourceUserSeq
      || parsed.parent.logicalToolCallId !== input.parentLogicalToolCallId
      || parsed.binding.expectedWorkDigest !== row.expected_work_binding_digest
      || parsed.binding.hostDurableBindingDigest !== row.host_durable_binding_digest
      || parsed.binding.manifestId !== row.host_manifest_id
      || parsed.binding.manifestDigest !== row.host_manifest_digest
      || parsed.provider.inputSchemaDigest !== row.input_schema_digest
      || parsed.provider.outputSchemaDigest !== row.output_schema_digest
      || (parsed.outputMayContainDownloads ? 1 : 0) !== row.output_may_contain_downloads
      || parsed.provider.operationVersion !== row.operation_version
      || parsed.provider.accountIdentityDigest !== row.account_identity_digest
      || parsed.provider.definitionFingerprint !== row.host_definition_fingerprint
    ) return { status: 'conflict', reason: 'staged manifest does not match its durable owner' };
    const expected = db.prepare(`
      SELECT * FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(input.sessionId, input.sourceUserSeq, input.parentLogicalToolCallId) as ExpectedWorkBindingRow | undefined;
    const host = loadHostCallCapabilityBinding({ db, ...input, logicalToolCallId: input.parentLogicalToolCallId });
    const capability = exactManifest(db, String(row.host_manifest_id), String(row.host_manifest_digest));
    const definition = capability ? providerDefinition({
      operationId: capability.operationId,
      operationVersion: capability.operationVersion,
      accountId: capability.accountId,
      invokePortId: capability.invokePortId,
    }) : null;
    const account = capability
      ? exactAccountIdentity(capability.accountId, parsed.provider.toolkitSlug, peekCurrentConnectedToolkits())
      : null;
    if (
      !expected
      || expectedWorkBindingDigest(expected) !== parsed.binding.expectedWorkDigest
      || host.status !== 'ok'
      || host.binding.durableBindingDigest !== parsed.binding.hostDurableBindingDigest
      || !capability
      || !definition
      || definition.definitionFingerprint !== parsed.provider.definitionFingerprint
      || definition.inputSchemaDigest !== parsed.provider.inputSchemaDigest
      || definition.outputSchemaDigest !== parsed.provider.outputSchemaDigest
      || canonical(definition.inputSchema) !== canonical(parsed.provider.inputSchema)
      || canonical(definition.outputSchema) !== canonical(parsed.provider.outputSchema)
      || !account
      || account.digest !== parsed.provider.accountIdentityDigest
      || sha256(canonical(parsed.provider.providerArgs)) !== parsed.provider.providerArgsDigest
    ) return { status: 'conflict', reason: 'staged transfer authority no longer reopens exactly' };
    const storedStages = db.prepare(`
      SELECT stage_ordinal, stage_kind, json_pointer_digest, tool_name, effect_kind,
             depends_on_stage_ordinal, retry_policy, manifest_node_digest, stage_digest
        FROM staged_transfer_stages WHERE plan_id = ?
       ORDER BY stage_ordinal
    `).all(String(row.plan_id)) as Array<Record<string, unknown>>;
    const initialStored = storedStages.slice(0, parsed.stages.length);
    if (initialStored.length !== parsed.stages.length || initialStored.some((stored, index) => {
      const stage = parsed.stages[index]!;
      return stored.stage_ordinal !== stage.ordinal
        || stored.stage_kind !== stage.kind
        || stored.json_pointer_digest !== stage.pointerDigest
        || stored.tool_name !== stage.toolName
        || stored.effect_kind !== stage.effect
        || stored.depends_on_stage_ordinal !== stage.dependsOnOrdinal
        || stored.retry_policy !== stage.retryPolicy
        || stored.manifest_node_digest !== stage.manifestNodeDigest
        || stored.stage_digest !== stage.stageDigest;
    })) return { status: 'conflict', reason: 'staged transfer topology changed' };
    const planAuthorityDigest = digest({
      protocol: 'staged_transfer_plan_authority_v2',
      planId: row.plan_id,
      transferManifestDigest: row.transfer_manifest_digest,
      manifestBindingDigest: row.manifest_binding_digest,
      manifestReference: reference,
      consentRequirement: row.consent_requirement,
      consentSubjectDigest: row.consent_subject_digest,
    });
    if (!DIGEST_RE.test(planAuthorityDigest) || planAuthorityDigest !== row.plan_authority_digest) {
      return { status: 'conflict', reason: 'staged plan authority digest changed' };
    }
    const consentRows = db.prepare(`
      SELECT redemption.approval_id, redemption.consent_subject_digest,
             redemption.grant_digest,
             approval.session_id AS approval_session_id,
             approval.resume_key, approval.status, approval.resolution,
             approval.requested_at, approval.expires_at,
             approval.resolved_at, approval.consumed_at
        FROM staged_transfer_consent_redemptions redemption
        JOIN pending_approvals approval
          ON approval.approval_id = redemption.approval_id
       WHERE redemption.plan_id = ?
       LIMIT 2
    `).all(String(row.plan_id)) as Array<{
      approval_id: string;
      consent_subject_digest: string;
      grant_digest: string;
      approval_session_id: string;
      resume_key: string | null;
      status: string;
      resolution: string | null;
      requested_at: string;
      expires_at: string;
      resolved_at: string | null;
      consumed_at: string | null;
    }>;
    if (row.consent_requirement === 'none') {
      if (row.consent_subject_digest !== null || consentRows.length !== 0) {
        return { status: 'conflict', reason: 'ordinary staged plan gained consent authority' };
      }
    } else {
      const redemption = consentRows.length === 1 ? consentRows[0]! : null;
      const requestedAt = redemption ? Date.parse(redemption.requested_at) : Number.NaN;
      const expiresAt = redemption ? Date.parse(redemption.expires_at) : Number.NaN;
      const resolvedAt = redemption?.resolved_at ? Date.parse(redemption.resolved_at) : Number.NaN;
      const consumedAt = redemption?.consumed_at ? Date.parse(redemption.consumed_at) : Number.NaN;
      if (
        row.consent_requirement !== 'exact_grant'
        || typeof row.consent_subject_digest !== 'string'
        || !DIGEST_RE.test(row.consent_subject_digest)
        || !redemption
        || redemption.approval_session_id !== row.session_id
        || redemption.consent_subject_digest !== row.consent_subject_digest
        || !DIGEST_RE.test(redemption.grant_digest)
        || redemption.resume_key !== `host-consent:v1:${row.consent_subject_digest}`
        || redemption.status !== 'resolved'
        || redemption.resolution !== 'approved'
        || !Number.isFinite(requestedAt)
        || !Number.isFinite(expiresAt)
        || !Number.isFinite(resolvedAt)
        || !Number.isFinite(consumedAt)
        || requestedAt > resolvedAt
        || resolvedAt > expiresAt
        || consumedAt > expiresAt
      ) return { status: 'conflict', reason: 'exact staged consent redemption no longer reopens' };
    }
    const provisional: StagedTransferPlanAuthorityState = {
      planId: String(row.plan_id),
      planAuthorityDigest,
      manifest: parsed,
      manifestReference: reference,
      stages: parsed.stages,
      downloadAuthorities: new Map(),
    };
    activePlanReopens.set(provisional.planId, provisional);
    let derived: DerivedDownloadSuccessors;
    try {
      derived = deriveDownloadSuccessors(provisional);
    } finally {
      activePlanReopens.delete(provisional.planId);
    }
    if (derived.status === 'conflict') {
      return { status: 'conflict', reason: derived.reason ?? 'staged download topology cannot be rederived' };
    }
    const storedSuccessors = storedStages.slice(parsed.stages.length);
    const successorRowsMatch = storedSuccessors.length === derived.stages.length
      && storedSuccessors.every((stored, index) => (
        storedSuccessorMatches(stored, derived.stages[index]!)
      ));
    const topology = db.prepare(`
      SELECT plan_id, business_stage_authority_id, business_result_digest,
             topology_digest, successor_stage_count
        FROM staged_transfer_download_topology_receipts
       WHERE plan_id = ?
    `).get(String(row.plan_id)) as StoredDownloadTopologyReceipt | undefined;
    let topologyProjected = false;
    if (!parsed.outputMayContainDownloads) {
      if (topology || storedSuccessors.length > 0) {
        return { status: 'conflict', reason: 'staged download topology exists outside frozen applicability' };
      }
    } else if (derived.status === 'pending') {
      if (topology || storedSuccessors.length > 0) {
        return { status: 'conflict', reason: 'staged download topology precedes its business checkpoint' };
      }
    } else {
      if (!derived.business) {
        return { status: 'conflict', reason: 'staged download topology lost its business checkpoint identity' };
      }
      const expectedTopologyDigest = downloadTopologyDigest({
        state: provisional,
        business: derived.business,
        stages: derived.stages,
      });
      if (topology) {
        if (
          topology.plan_id !== provisional.planId
          || topology.business_stage_authority_id !== derived.business.stageAuthorityId
          || topology.business_result_digest !== derived.business.resultDigest
          || topology.topology_digest !== expectedTopologyDigest
          || topology.successor_stage_count !== derived.stages.length
          || !successorRowsMatch
        ) return { status: 'conflict', reason: 'staged download topology receipt changed' };
        topologyProjected = true;
      } else if (storedSuccessors.length > 0) {
        return { status: 'conflict', reason: 'staged download successors lack their projection receipt' };
      }
    }
    const completeStages = topologyProjected
      ? Object.freeze([...parsed.stages, ...derived.stages])
      : parsed.stages;
    const downloadAuthorities = topologyProjected
      ? derived.authorities
      : new Map<string, CommittedComposioDownloadAuthority>();
    const authority = Object.freeze({ version: 1 as const });
    planAuthorities.set(authority, {
      planId: String(row.plan_id),
      planAuthorityDigest,
      manifest: parsed,
      manifestReference: reference,
      stages: completeStages,
      downloadAuthorities,
    });
    return { status: 'ok', authority, planId: String(row.plan_id) };
  } catch {
    return { status: 'storage_error', reason: 'staged transfer authority could not be reopened' };
  }
}

/** Internal consumers can verify only WeakMap identity, never visible fields. */
export function inspectStagedTransferPlanAuthority(
  authority: StagedTransferPlanAuthority,
): Readonly<Pick<StagedTransferPlanAuthorityState, 'planId' | 'planAuthorityDigest'>> | null {
  const state = planAuthorities.get(authority as object);
  return state ? { planId: state.planId, planAuthorityDigest: state.planAuthorityDigest } : null;
}

export type PrepareStagedDownloadSuccessorsResult =
  | {
      status: 'prepared' | 'replayed';
      authority: StagedTransferPlanAuthority;
      planId: string;
      stageIds: readonly string[];
    }
  | {
      status: 'not_applicable';
      authority: StagedTransferPlanAuthority;
      planId: string;
      reason: string;
    }
  | { status: 'missing' | 'conflict' | 'storage_error'; reason: string };

/**
 * Materialize the immutable post-business topology. The caller supplies no
 * pointer, URL, destination, or result bytes: the exact returned business
 * checkpoint is reopened, its successful Composio `.data` is validated against
 * the frozen output schema, and one GET + one local commit stage is appended
 * for each concrete planner pointer in deterministic order.
 */
export function prepareStagedDownloadSuccessors(input: {
  planAuthority: StagedTransferPlanAuthority;
}): PrepareStagedDownloadSuccessorsResult {
  const state = exactPlanState(input.planAuthority);
  if (!state) return { status: 'conflict', reason: 'staged plan authority no longer reopens' };
  if (!state.manifest.outputMayContainDownloads) {
    return {
      status: 'not_applicable',
      authority: input.planAuthority,
      planId: state.planId,
      reason: 'the frozen provider output cannot contain downloadable file authority',
    };
  }
  try {
    activePlanReopens.set(state.planId, state);
    let derived: DerivedDownloadSuccessors;
    try {
      derived = deriveDownloadSuccessors(state);
    } finally {
      activePlanReopens.delete(state.planId);
    }
    if (derived.status === 'pending') {
      return { status: 'missing', reason: 'successful business return checkpoint is not committed' };
    }
    if (derived.status === 'conflict') {
      return { status: 'conflict', reason: derived.reason ?? 'download successors cannot be derived exactly' };
    }
    if (!derived.business) {
      return { status: 'conflict', reason: 'download projection lost its exact business checkpoint identity' };
    }
    const db = openEventLog();
    const topologyDigest = downloadTopologyDigest({
      state,
      business: derived.business,
      stages: derived.stages,
    });
    const transaction = db.transaction((): 'prepared' | 'replayed' => {
      const existing = db.prepare(`
        SELECT stage_ordinal, stage_kind, json_pointer_digest, tool_name,
               effect_kind, depends_on_stage_ordinal, retry_policy,
               manifest_node_digest, stage_digest
          FROM staged_transfer_stages
         WHERE plan_id = ? AND stage_ordinal > ?
         ORDER BY stage_ordinal
      `).all(state.planId, state.manifest.stages.length) as Array<Record<string, unknown>>;
      const exactRows = existing.length === derived.stages.length
        && existing.every((stored, index) => (
          storedSuccessorMatches(stored, derived.stages[index]!)
        ));
      const existingTopology = db.prepare(`
        SELECT plan_id, business_stage_authority_id, business_result_digest,
               topology_digest, successor_stage_count
          FROM staged_transfer_download_topology_receipts
         WHERE plan_id = ?
      `).get(state.planId) as StoredDownloadTopologyReceipt | undefined;
      if (existingTopology) {
        if (
          !exactRows
          || existingTopology.plan_id !== state.planId
          || existingTopology.business_stage_authority_id !== derived.business!.stageAuthorityId
          || existingTopology.business_result_digest !== derived.business!.resultDigest
          || existingTopology.topology_digest !== topologyDigest
          || existingTopology.successor_stage_count !== derived.stages.length
        ) throw new StagedTransferAuthorityError('conflict', 'download successor replay differs');
        return 'replayed';
      }
      if (existing.length > 0) {
        throw new StagedTransferAuthorityError('conflict', 'download successors lack their projection receipt');
      }
      const now = new Date().toISOString();
      for (const stage of derived.stages) {
        db.prepare(`
          INSERT INTO staged_transfer_stages
            (stage_id, plan_id, session_id, source_user_seq, accepted_task_id,
             stage_ordinal, stage_kind, json_pointer_digest, tool_name, effect_kind,
             depends_on_stage_ordinal, retry_policy, manifest_node_digest,
             stage_digest, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `staged-stage:${stage.stageDigest}`,
          state.planId,
          state.manifest.parent.sessionId,
          state.manifest.parent.sourceUserSeq,
          state.manifest.parent.acceptedTaskId,
          stage.ordinal,
          stage.kind,
          stage.pointerDigest,
          stage.toolName,
          stage.effect,
          stage.dependsOnOrdinal,
          stage.retryPolicy,
          stage.manifestNodeDigest,
          stage.stageDigest,
          now,
        );
      }
      insertAdmittedDownloadTopologyReceipt({
        db,
        planId: state.planId,
        businessStageAuthorityId: derived.business!.stageAuthorityId,
        businessResultDigest: derived.business!.resultDigest,
        topologyDigest,
        successorStageCount: derived.stages.length,
        recordedAt: now,
      });
      return 'prepared';
    });
    const status = transaction.immediate();
    const reopened = reopenStagedTransferPlanAuthority({
      sessionId: state.manifest.parent.sessionId,
      sourceUserSeq: state.manifest.parent.sourceUserSeq,
      parentLogicalToolCallId: state.manifest.parent.logicalToolCallId,
    });
    if (reopened.status !== 'ok') {
      return { status: 'conflict', reason: 'persisted download successors do not reopen exactly' };
    }
    return {
      status,
      authority: reopened.authority,
      planId: reopened.planId,
      stageIds: Object.freeze(derived.stages.map((stage) => `staged-stage:${stage.stageDigest}`)),
    };
  } catch (error) {
    if (error instanceof StagedTransferAuthorityError) {
      return { status: error.code === 'storage_error' ? 'storage_error' : 'conflict', reason: error.message };
    }
    return { status: 'storage_error', reason: 'download successors could not be persisted' };
  }
}

function exactPlanState(authority: StagedTransferPlanAuthority): StagedTransferPlanAuthorityState | null {
  const state = planAuthorities.get(authority as object);
  if (!state) return null;
  const reopened = reopenStagedTransferPlanAuthority({
    sessionId: state.manifest.parent.sessionId,
    sourceUserSeq: state.manifest.parent.sourceUserSeq,
    parentLogicalToolCallId: state.manifest.parent.logicalToolCallId,
  });
  if (reopened.status !== 'ok') return null;
  const fresh = planAuthorities.get(reopened.authority as object);
  return fresh
    && fresh.planId === state.planId
    && fresh.planAuthorityDigest === state.planAuthorityDigest
    ? fresh
    : null;
}

function stageAt(
  state: StagedTransferPlanAuthorityState,
  ordinal: number,
): StagedTransferManifestStageV2 | null {
  if (!Number.isSafeInteger(ordinal) || ordinal <= 0) return null;
  return state.stages.find((stage) => stage.ordinal === ordinal) ?? null;
}

function stageLogicalArgs(input: {
  planId: string;
  stage: StagedTransferManifestStageV2;
  attemptOrdinal: number;
}): Record<string, unknown> {
  return {
    staged_plan_id: input.planId,
    staged_stage_digest: input.stage.stageDigest,
    staged_attempt_ordinal: input.attemptOrdinal,
  };
}

interface SuccessfulStageEvidence {
  stageId: string;
  stageAuthorityId: string;
  stageKind: StagedTransferStageKind;
  stageOrdinal: number;
  attemptOrdinal: number;
  physicalDispatchId: string;
  resultDigest: string;
}

interface ExactBlobOwner {
  planId: string;
  stageId: string;
  sha256: string;
  md5: string;
  byteCount: number;
}

interface ExactPresignSecret {
  reference: AuthorityEncryptedPayloadReference;
  key: string;
  signedUrl: string;
  storageBackend: 's3' | 'azure_blob_storage';
  expiresAt: string;
}

interface CompiledStageDispatch {
  providerArgs: Record<string, unknown>;
  ledgerArgs: Record<string, unknown>;
  dependencyBindingDigest: string;
}

function successfulStageEvidence(
  db: Database.Database,
  planId: string,
  stageId: string,
): SuccessfulStageEvidence | null {
  const rows = db.prepare(`
    SELECT attempt.stage_authority_id, attempt.stage_kind, attempt.stage_ordinal,
           attempt.attempt_ordinal, attempt.physical_dispatch_id,
           receipt.result_digest
      FROM staged_transfer_stage_authorities attempt
      JOIN staged_transfer_stage_receipts receipt
        ON receipt.stage_authority_id = attempt.stage_authority_id
     WHERE attempt.plan_id = ? AND attempt.stage_id = ?
       AND receipt.terminal_state = 'returned'
     ORDER BY attempt.attempt_ordinal
     LIMIT 2
  `).all(planId, stageId) as Array<{
    stage_authority_id: string;
    stage_kind: StagedTransferStageKind;
    stage_ordinal: number;
    attempt_ordinal: number;
    physical_dispatch_id: string;
    result_digest: string;
  }>;
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (!DIGEST_RE.test(row.result_digest)) return null;
  return {
    stageId,
    stageAuthorityId: row.stage_authority_id,
    stageKind: row.stage_kind,
    stageOrdinal: row.stage_ordinal,
    attemptOrdinal: row.attempt_ordinal,
    physicalDispatchId: row.physical_dispatch_id,
    resultDigest: row.result_digest,
  };
}

function exactBlobOwner(
  db: Database.Database,
  planId: string,
  stageId: string,
): ExactBlobOwner | null {
  const rows = db.prepare(`
    SELECT plan_id, stage_id, blob_sha256, blob_md5, blob_bytes
      FROM staged_transfer_blob_owners
     WHERE plan_id = ? AND stage_id = ?
     ORDER BY blob_sha256
     LIMIT 2
  `).all(planId, stageId) as Array<{
    plan_id: string;
    stage_id: string;
    blob_sha256: string;
    blob_md5: string;
    blob_bytes: number;
  }>;
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (
    !DIGEST_RE.test(row.blob_sha256)
    || !/^[a-f0-9]{32}$/.test(row.blob_md5)
    || !Number.isSafeInteger(row.blob_bytes)
    || row.blob_bytes < 0
  ) return null;
  return {
    planId: row.plan_id,
    stageId: row.stage_id,
    sha256: row.blob_sha256,
    md5: row.blob_md5,
    byteCount: row.blob_bytes,
  };
}

function parsePresignSecret(bytes: Buffer): {
  key: string;
  signedUrl: string;
  storageBackend: 's3' | 'azure_blob_storage';
} | null {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (canonical(parsed) !== text || !plainRecord(parsed)) return null;
    if (Object.keys(parsed).sort().join('\0') !== 'key\0new_presigned_url\0storage_backend') return null;
    const key = parsed.key;
    const signedUrl = parsed.new_presigned_url;
    const storageBackend = parsed.storage_backend;
    if (
      typeof key !== 'string'
      || key.length === 0
      || key.length > 4096
      || typeof signedUrl !== 'string'
      || signedUrl.length === 0
      || signedUrl.length > MANIFEST_MAX_BYTES
      || (storageBackend !== 's3' && storageBackend !== 'azure_blob_storage')
    ) return null;
    const url = new URL(signedUrl);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    return { key, signedUrl, storageBackend };
  } catch {
    return null;
  }
}

function exactPresignSecret(
  db: Database.Database,
  evidence: SuccessfulStageEvidence,
  allowExpired = false,
): ExactPresignSecret | null {
  if (evidence.stageKind !== 'upload_presign') return null;
  const row = db.prepare(`
    SELECT payload_id, payload_kind, binding_digest, plaintext_sha256,
           plaintext_bytes, chunk_count, sealed_sha256, sealed_bytes,
           expires_at
      FROM staged_transfer_secret_payloads
     WHERE stage_authority_id = ?
  `).get(evidence.stageAuthorityId) as {
    payload_id: string;
    payload_kind: string;
    binding_digest: string;
    plaintext_sha256: string;
    plaintext_bytes: number;
    chunk_count: number;
    sealed_sha256: string;
    sealed_bytes: number;
    expires_at: string;
  } | undefined;
  if (!row || row.payload_kind !== 'staged_signed_url') return null;
  const expectedBindingDigest = digest({
    protocol: 'staged_signed_url_binding_v1',
    stageAuthorityId: evidence.stageAuthorityId,
    physicalDispatchId: evidence.physicalDispatchId,
    resultDigest: evidence.resultDigest,
  });
  if (row.binding_digest !== expectedBindingDigest) return null;
  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || (!allowExpired && expiresAt <= Date.now())) return null;
  const reference: AuthorityEncryptedPayloadReference = {
    version: 1,
    payloadId: row.payload_id,
    payloadKind: 'staged_signed_url',
    bindingDigest: row.binding_digest,
    plaintextSha256: row.plaintext_sha256,
    plaintextBytes: row.plaintext_bytes,
    chunkCount: row.chunk_count,
    sealedFileSha256: row.sealed_sha256,
    sealedFileBytes: row.sealed_bytes,
  };
  const opened = readAuthorityEncryptedPayload({
    reference,
    payloadKind: 'staged_signed_url',
    bindingDigest: reference.bindingDigest,
  });
  if (opened.status !== 'ok') return null;
  const parsed = parsePresignSecret(opened.bytes);
  return parsed ? { reference, ...parsed, expiresAt: row.expires_at } : null;
}

function sourceFileName(stage: Pick<
  StagedTransferManifestStageV2,
  'source' | 'pointerDigest' | 'stageDigest'
>): string {
  const source = stage.source;
  if (!source) return `staged-${stage.pointerDigest?.slice(0, 16) ?? stage.stageDigest.slice(0, 16)}.bin`;
  try {
    const pathname = source.kind === 'remote_url' ? new URL(source.value).pathname : source.value;
    const normalized = pathname.replace(/\\/g, '/');
    const basename = normalized.slice(normalized.lastIndexOf('/') + 1).trim();
    if (
      basename.length > 0
      && basename.length <= 255
      && basename !== '.'
      && basename !== '..'
      && !/[\u0000-\u001f\u007f]/.test(basename)
    ) return basename;
  } catch {
    // The source itself was already validated when the immutable plan was
    // built; a malformed basename simply receives a deterministic safe name.
  }
  return `staged-${source.valueDigest.slice(0, 16)}.bin`;
}

function localCommitDestinationName(input: {
  ordinal: number;
  pointerDigest: string | null;
  stageDigest: string;
  baseName: string;
}): string {
  const pointer = (input.pointerDigest ?? input.stageDigest).slice(0, 16);
  // Dynamic download successors have no manifest source, so their existing
  // compiler basename is already a short ASCII fallback. The ordinal/pointer
  // prefix makes two concrete array/object results collision-free even if a
  // future provider reports the same filename for both descriptors.
  return `${String(input.ordinal).padStart(6, '0')}-${pointer}-${input.baseName}`;
}

function localCommitDestinationForStage(input: {
  planId: string;
  stage: Pick<
    StagedTransferManifestStageV2,
    'ordinal' | 'pointerDigest' | 'stageDigest' | 'source'
  >;
}): { directory: string; name: string; materializedPath: string } {
  const directory = path.join(
    stagedBlobStoreDirectory(),
    'materialized',
    sha256(input.planId).slice(0, 32),
  );
  const name = localCommitDestinationName({
    ordinal: input.stage.ordinal,
    pointerDigest: input.stage.pointerDigest,
    stageDigest: input.stage.stageDigest,
    baseName: sourceFileName(input.stage),
  });
  let canonicalDirectory = directory;
  try {
    canonicalDirectory = realpathSync(directory);
  } catch {
    // Before the body executes, the managed destination does not exist yet.
  }
  return {
    directory,
    name,
    materializedPath: path.join(canonicalDirectory, name),
  };
}

function cloneProviderArgs(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(canonical(value)) as Record<string, unknown>;
}

function replacePointerValue(
  root: Record<string, unknown>,
  pointer: string,
  replacement: unknown,
): void {
  if (pointer === '') {
    throw new StagedTransferAuthorityError('invalid', 'root file arguments cannot be substituted safely');
  }
  const segments = pointer.slice(1).split('/').map((encoded) => encoded.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index]!;
    if (RESERVED_KEYS.has(key)) throw new StagedTransferAuthorityError('invalid', 'reserved file pointer');
    current = pointerValue(current, `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
  }
  const last = segments.at(-1)!;
  if (RESERVED_KEYS.has(last) || (!plainRecord(current) && !Array.isArray(current))) {
    throw new StagedTransferAuthorityError('invalid', 'file pointer cannot be substituted safely');
  }
  const descriptor = Object.getOwnPropertyDescriptor(current, last);
  if (!descriptor || 'get' in descriptor || 'set' in descriptor || descriptor.writable === false) {
    throw new StagedTransferAuthorityError('invalid', 'file pointer cannot be substituted safely');
  }
  (current as Record<string, unknown>)[last] = replacement;
}

function stageByPointer(
  state: StagedTransferPlanAuthorityState,
  kind: StagedTransferStageKind,
  pointerDigest: string | null,
): StagedTransferManifestStageV2 | null {
  const matches = state.stages.filter((candidate) => (
    candidate.kind === kind && candidate.pointerDigest === pointerDigest
  ));
  return matches.length === 1 ? matches[0]! : null;
}

function dependencyEvidenceFor(
  db: Database.Database,
  state: StagedTransferPlanAuthorityState,
  stage: StagedTransferManifestStageV2,
): SuccessfulStageEvidence | null {
  if (stage.dependsOnOrdinal === null) return null;
  const dependency = stageAt(state, stage.dependsOnOrdinal);
  return dependency
    ? successfulStageEvidence(db, state.planId, `staged-stage:${dependency.stageDigest}`)
    : null;
}

function compiledBusinessArgs(
  db: Database.Database,
  state: StagedTransferPlanAuthorityState,
  allowExpiredSecrets = false,
): { args: Record<string, unknown>; dependencies: unknown[] } | null {
  const args = cloneProviderArgs(state.manifest.provider.providerArgs);
  const dependencies: unknown[] = [];
  for (const upload of state.manifest.uploads) {
    const presign = stageByPointer(state, 'upload_presign', digest({
      protocol: 'staged_file_pointer_v1',
      pointer: upload.pointer,
    }));
    const transfer = stageByPointer(state, 'upload_transfer', presign?.pointerDigest ?? null);
    const snapshot = stageByPointer(state, 'local_snapshot', presign?.pointerDigest ?? null);
    if (!presign || !transfer || !snapshot) return null;
    const presignEvidence = successfulStageEvidence(db, state.planId, `staged-stage:${presign.stageDigest}`);
    const transferEvidence = successfulStageEvidence(db, state.planId, `staged-stage:${transfer.stageDigest}`);
    const blob = exactBlobOwner(db, state.planId, `staged-stage:${snapshot.stageDigest}`);
    const secret = presignEvidence ? exactPresignSecret(db, presignEvidence, allowExpiredSecrets) : null;
    if (!presignEvidence || !transferEvidence || !blob || !secret) return null;
    const descriptor = {
      name: sourceFileName(snapshot),
      mimetype: 'application/octet-stream',
      s3key: secret.key,
    };
    replacePointerValue(args, upload.pointer, descriptor);
    dependencies.push({
      pointerDigest: snapshot.pointerDigest,
      blob,
      presign: presignEvidence,
      transfer: transferEvidence,
      secretReference: secret.reference,
      secretExpiresAt: secret.expiresAt,
      descriptorDigest: digest(descriptor),
    });
  }
  return { args, dependencies };
}

function compileStageDispatch(input: {
  db: Database.Database;
  state: StagedTransferPlanAuthorityState;
  stage: StagedTransferManifestStageV2;
  attemptOrdinal: number;
  forensic?: boolean;
}): CompiledStageDispatch | null {
  const { db, state, stage, attemptOrdinal } = input;
  const stageId = `staged-stage:${stage.stageDigest}`;
  const dependency = dependencyEvidenceFor(db, state, stage);
  if (stage.dependsOnOrdinal !== null && !dependency) return null;
  let providerArgs: Record<string, unknown>;
  let dependencyMaterial: unknown = dependency;
  switch (stage.kind) {
    case 'source_download': {
      if (stage.source?.kind !== 'remote_url') return null;
      providerArgs = { url: stage.source.value };
      break;
    }
    case 'local_snapshot': {
      if (!stage.source) return null;
      if (stage.source.kind === 'local_path') {
        providerArgs = { source_path: stage.source.value };
      } else {
        if (!dependency) return null;
        const blob = exactBlobOwner(db, state.planId, dependency.stageId);
        if (!blob) return null;
        providerArgs = { staged_blob: blob };
        dependencyMaterial = { dependency, blob };
      }
      break;
    }
    case 'upload_presign': {
      if (!dependency) return null;
      const blob = exactBlobOwner(db, state.planId, dependency.stageId);
      const snapshot = stageAt(state, dependency.stageOrdinal);
      if (!blob || !snapshot || snapshot.kind !== 'local_snapshot') return null;
      providerArgs = {
        filename: sourceFileName(snapshot),
        mimetype: 'application/octet-stream',
        md5: blob.md5,
        tool_slug: state.manifest.provider.operationId,
        toolkit_slug: state.manifest.provider.toolkitSlug,
      };
      dependencyMaterial = { dependency, blob };
      break;
    }
    case 'upload_transfer': {
      if (!dependency || dependency.stageKind !== 'upload_presign') return null;
      const secret = exactPresignSecret(db, dependency, input.forensic === true);
      const snapshot = stageByPointer(state, 'local_snapshot', stage.pointerDigest);
      const blob = snapshot
        ? exactBlobOwner(db, state.planId, `staged-stage:${snapshot.stageDigest}`)
        : null;
      if (!secret || !blob) return null;
      const headers = secret.storageBackend === 'azure_blob_storage'
        ? {
            'content-type': 'application/octet-stream',
            'x-ms-blob-type': 'BlockBlob',
          }
        : { 'content-type': 'application/octet-stream' };
      providerArgs = {
        signed_url: secret.signedUrl,
        headers,
        staged_blob: blob,
      };
      dependencyMaterial = {
        dependency,
        blob,
        secretReference: secret.reference,
        secretExpiresAt: secret.expiresAt,
        secretKeyDigest: sha256(secret.key),
        storageBackend: secret.storageBackend,
        headerDigest: digest(headers),
      };
      break;
    }
    case 'business_execute': {
      const compiled = compiledBusinessArgs(db, state, input.forensic === true);
      if (!compiled) return null;
      providerArgs = compiled.args;
      dependencyMaterial = compiled.dependencies;
      break;
    }
    case 'download_transfer': {
      const downloadAuthority = state.downloadAuthorities.get(stage.stageDigest);
      const download = downloadAuthority
        ? inspectCommittedComposioDownloadAuthority(downloadAuthority)
        : null;
      if (
        !stage.download
        || !download
        || download.resultDigest !== stage.download.resultDigest
        || download.descriptorDigest !== stage.download.descriptorDigest
        || download.pointer !== stage.pointer
        || !dependency
        || dependency.stageKind !== 'business_execute'
      ) {
        return null;
      }
      providerArgs = {
        result_digest: download.resultDigest,
        descriptor_digest: download.descriptorDigest,
        pointer_digest: stage.pointerDigest,
      };
      dependencyMaterial = { dependency, download };
      break;
    }
    case 'local_commit': {
      if (!dependency || dependency.stageKind !== 'download_transfer') return null;
      const blob = exactBlobOwner(db, state.planId, dependency.stageId);
      if (!blob) return null;
      const destination = localCommitDestinationForStage({ planId: state.planId, stage });
      if (input.forensic === true) {
        try {
          verifyStagedFileMaterialization({
            blob: {
              sha256: blob.sha256,
              md5: blob.md5,
              byteCount: blob.byteCount,
            },
            destinationDirectory: destination.directory,
            destinationName: destination.name,
          });
        } catch {
          return null;
        }
      }
      providerArgs = {
        staged_blob: blob,
        destination_name: destination.name,
      };
      dependencyMaterial = {
        dependency,
        blob,
        destinationOwnerDigest: digest({
          protocol: 'staged_local_commit_destination_v1',
          planId: state.planId,
          stageOrdinal: stage.ordinal,
          pointerDigest: stage.pointerDigest,
          stageDigest: stage.stageDigest,
          destinationName: destination.name,
        }),
      };
      break;
    }
  }
  const providerArgumentDigest = sha256(canonical(providerArgs));
  const dependencyBindingDigest = digest({
    protocol: 'staged_compiled_dependency_binding_v1',
    planAuthorityDigest: state.planAuthorityDigest,
    stageId,
    stageDigest: stage.stageDigest,
    attemptOrdinal,
    providerArgumentDigest,
    dependencyMaterial,
  });
  return {
    providerArgs,
    // The business crossing reuses the admitted parent logical call. Its
    // ledger identity must therefore remain the exact frozen parent argument
    // payload even when upload descriptors make the provider-ready physical
    // payload differ. Every control child owns only its stage-local tuple.
    ledgerArgs: stage.kind === 'business_execute'
      ? cloneProviderArgs(state.manifest.provider.providerArgs)
      : stageLogicalArgs({ planId: state.planId, stage, attemptOrdinal }),
    dependencyBindingDigest,
  };
}

function ensureStagedChildLogical(input: {
  db: Database.Database;
  state: StagedTransferPlanAuthorityState;
  stage: StagedTransferManifestStageV2;
  attemptOrdinal: number;
  logicalToolCallId: string;
  logicalArgs: Record<string, unknown>;
}): { argumentDigest: string } {
  const parent = input.state.manifest.parent;
  const contract = durableLogicalCallContract(parent.acceptedTaskId, input.stage.toolName, input.logicalArgs);
  if (!contract) throw new StagedTransferAuthorityError('invalid', 'staged child logical contract is unsafe');
  const existing = input.db.prepare(`
    SELECT accepted_task_id, tool_name, argument_digest, state
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(parent.sessionId, parent.sourceUserSeq, input.logicalToolCallId) as {
    accepted_task_id: string;
    tool_name: string;
    argument_digest: string;
    state: string;
  } | undefined;
  if (existing) {
    if (
      existing.accepted_task_id !== parent.acceptedTaskId
      || existing.tool_name !== contract.toolName
      || existing.argument_digest !== contract.argumentDigest
      || existing.state !== 'open'
    ) throw new StagedTransferAuthorityError('conflict', 'staged child logical call conflicts');
    return { argumentDigest: contract.argumentDigest };
  }
  const root = input.db.prepare(`
    SELECT accepted_task_id, authority_kind, state, max_logical_calls, max_parallel_calls
      FROM accepted_turn_call_authorities
     WHERE session_id = ? AND source_user_seq = ?
  `).get(parent.sessionId, parent.sourceUserSeq) as {
    accepted_task_id: string;
    authority_kind: string;
    state: string;
    max_logical_calls: number | null;
    max_parallel_calls: number | null;
  } | undefined;
  const counts = input.db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open_count
      FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ?
  `).get(parent.sessionId, parent.sourceUserSeq) as { total: number; open_count: number | null };
  if (
    !root
    || root.accepted_task_id !== parent.acceptedTaskId
    || root.authority_kind !== 'host_v1'
    || root.state !== 'open'
    || counts.total >= (root.max_logical_calls ?? 0)
    || (counts.open_count ?? 0) >= (root.max_parallel_calls ?? 0)
  ) throw new StagedTransferAuthorityError('conflict', 'host authority cannot admit another staged child');
  input.db.prepare(`
    INSERT INTO logical_tool_calls
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
       tool_name, argument_digest, raw_argument_digest, state, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
  `).run(
    parent.sessionId,
    parent.sourceUserSeq,
    parent.acceptedTaskId,
    input.logicalToolCallId,
    contract.toolName,
    contract.argumentDigest,
    contract.argumentDigest,
    new Date().toISOString(),
  );
  return { argumentDigest: contract.argumentDigest };
}

export type PrepareStagedPhysicalDispatchResult =
  | {
      status: 'prepared' | 'replayed';
      authority: StagedPhysicalDispatchAuthority;
      planId: string;
      stageId: string;
      stageAuthorityId: string;
      physicalDispatchId: string;
    }
  | { status: 'missing' | 'conflict' | 'storage_error'; reason: string };

function stagedPhysicalAuthorityDigest(input: {
  planAuthorityDigest: string;
  stageId: string;
  stageAuthorityId: string;
  stageDigest: string;
  attemptOrdinal: number;
  logicalToolCallId: string;
  physicalDispatchId: string;
  toolName: string;
  argumentDigest: string;
  providerArgumentDigest: string;
  dependencyBindingDigest: string;
  effect: StagedTransferEffect;
  leaseScopeId: string;
  leaseId: string;
  retryOfStageAuthorityId?: string;
}): string {
  return digest({
    protocol: 'staged_physical_dispatch_authority_v1',
    planAuthorityDigest: input.planAuthorityDigest,
    stageId: input.stageId,
    stageAuthorityId: input.stageAuthorityId,
    stageDigest: input.stageDigest,
    attemptOrdinal: input.attemptOrdinal,
    logicalToolCallId: input.logicalToolCallId,
    physicalDispatchId: input.physicalDispatchId,
    toolName: input.toolName,
    argumentDigest: input.argumentDigest,
    providerArgumentDigest: input.providerArgumentDigest,
    dependencyBindingDigest: input.dependencyBindingDigest,
    effect: input.effect,
    leaseScopeId: input.leaseScopeId,
    leaseId: input.leaseId,
    retryOfStageAuthorityId: input.retryOfStageAuthorityId ?? null,
  });
}

/**
 * Mint one exact attempt generation. Child logical calls are control/dependency
 * calls and never receive expected-work bindings; the business stage reuses
 * the parent call and is the only stage that can discharge the requirement.
 */
export function prepareStagedPhysicalDispatch(input: {
  planAuthority: StagedTransferPlanAuthority;
  stageOrdinal: number;
  attemptOrdinal?: number;
  parentDispatchLease?: DispatchLeaseRef;
}): PrepareStagedPhysicalDispatchResult {
  const state = exactPlanState(input.planAuthority);
  if (!state) return { status: 'conflict', reason: 'staged plan authority no longer reopens' };
  const stage = stageAt(state, input.stageOrdinal);
  if (!stage) return { status: 'missing', reason: 'staged transfer stage is missing' };
  const attemptOrdinal = input.attemptOrdinal ?? 1;
  if (!Number.isSafeInteger(attemptOrdinal) || attemptOrdinal <= 0) {
    return { status: 'conflict', reason: 'staged attempt ordinal is invalid' };
  }
  try {
    const db = openEventLog();
    const parent = state.manifest.parent;
    const stageId = `staged-stage:${stage.stageDigest}`;
    const compiled = compileStageDispatch({ db, state, stage, attemptOrdinal });
    if (!compiled) {
      return {
        status: 'missing',
        reason: 'staged attempt lacks its exact returned dependency material',
      };
    }
    const logicalToolCallId = stage.kind === 'business_execute'
      ? parent.logicalToolCallId
      : `call:staged:${digest({
          protocol: 'staged_child_logical_call_v1',
          planId: state.planId,
          stageDigest: stage.stageDigest,
          attemptOrdinal,
        })}`;
    const logicalArgs = stage.kind === 'business_execute'
      ? state.manifest.provider.providerArgs
      : compiled.ledgerArgs;
    const logicalContract = durableLogicalCallContract(parent.acceptedTaskId, stage.toolName, logicalArgs);
    if (!logicalContract) return { status: 'conflict', reason: 'staged logical contract is unsafe' };
    const providerArgumentDigest = sha256(canonical(compiled.providerArgs));
    const physicalDispatchId = `dispatch:staged:${digest({
      protocol: 'staged_physical_dispatch_id_v1',
      planId: state.planId,
      stageDigest: stage.stageDigest,
      attemptOrdinal,
      logicalToolCallId,
      providerArgumentDigest,
    })}`;
    const stageAuthorityId = `staged-attempt:${digest({
      protocol: 'staged_stage_authority_id_v1',
      planId: state.planId,
      stageDigest: stage.stageDigest,
      attemptOrdinal,
      physicalDispatchId,
    })}`;
    const existing = db.prepare(`
      SELECT * FROM staged_transfer_stage_authorities
       WHERE stage_id = ? AND attempt_ordinal = ?
    `).get(stageId, attemptOrdinal) as Record<string, unknown> | undefined;
    const retryOfStageAuthorityId = attemptOrdinal === 1
      ? undefined
      : String((db.prepare(`
          SELECT prior.stage_authority_id
            FROM staged_transfer_stage_authorities prior
            JOIN staged_transfer_stage_receipts receipt
              ON receipt.stage_authority_id = prior.stage_authority_id
           WHERE prior.stage_id = ? AND prior.attempt_ordinal = ?
             AND receipt.terminal_state != 'returned'
        `).get(stageId, attemptOrdinal - 1) as { stage_authority_id: string } | undefined)?.stage_authority_id ?? '');
    if (attemptOrdinal > 1 && !retryOfStageAuthorityId) {
      return { status: 'missing', reason: 'staged retry lacks its exact prior terminal attempt' };
    }
    let lease: DispatchLeaseRef | undefined;
    if (existing) {
      lease = {
        sessionId: parent.sessionId,
        scopeId: String(existing.lease_scope_id),
        leaseId: String(existing.lease_id),
        sourceUserSeq: parent.sourceUserSeq,
        acceptedTaskId: parent.acceptedTaskId,
        logicalToolCallId,
      };
      if (!isDispatchLeaseCurrent(lease)) {
        return { status: 'conflict', reason: 'staged attempt lease is no longer current' };
      }
    } else if (stage.kind === 'business_execute') {
      lease = input.parentDispatchLease ?? currentDispatchLease()!;
      if (
        !lease
        || lease.sessionId !== parent.sessionId
        || lease.sourceUserSeq !== parent.sourceUserSeq
        || lease.acceptedTaskId !== parent.acceptedTaskId
        || lease.logicalToolCallId !== parent.logicalToolCallId
        || !isDispatchLeaseCurrent(lease)
      ) return { status: 'conflict', reason: 'business stage lacks its exact current parent lease' };
    }
    let authorityDigest: string | undefined;
    const transaction = db.transaction((): 'prepared' | 'replayed' => {
      if (stage.kind !== 'business_execute') {
        ensureStagedChildLogical({
          db,
          state,
          stage,
          attemptOrdinal,
          logicalToolCallId,
          logicalArgs,
        });
        if (!lease) {
          const childContract = durableLogicalCallContract(parent.acceptedTaskId, stage.toolName, logicalArgs);
          if (!childContract) {
            throw new StagedTransferAuthorityError('invalid', 'staged child recovery contract is unsafe');
          }
          // This runs on the same Database handle and therefore inside this
          // immediate transaction. The call-bound lease trigger observes the
          // exact child logical row above, and a later authority INSERT fault
          // rolls both rows back together.
          lease = activateDispatchLease({
            sessionId: parent.sessionId,
            scopeId: `${state.planId}::stage:${stage.ordinal}:attempt:${attemptOrdinal}`,
            ...(input.parentDispatchLease ? { parentLease: input.parentDispatchLease } : {}),
            sourceUserSeq: parent.sourceUserSeq,
            acceptedTaskId: parent.acceptedTaskId,
            logicalToolCallId,
            recovery: {
              effect: stage.effect,
              businessCall: false,
              material: {
                toolName: childContract.toolName,
                argumentDigest: childContract.argumentDigest,
                args: logicalArgs,
              },
            },
          });
        }
      } else {
        const parentLogical = db.prepare(`
          SELECT accepted_task_id, tool_name, argument_digest, state
            FROM logical_tool_calls
           WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
        `).get(parent.sessionId, parent.sourceUserSeq, parent.logicalToolCallId) as Record<string, unknown> | undefined;
        if (
          !parentLogical
          || parentLogical.accepted_task_id !== parent.acceptedTaskId
          || parentLogical.tool_name !== stage.toolName
          || parentLogical.argument_digest !== logicalContract.argumentDigest
          || parentLogical.state !== 'open'
        ) throw new StagedTransferAuthorityError('conflict', 'business stage parent call changed');
      }
      if (!lease) throw new StagedTransferAuthorityError('conflict', 'staged attempt lease is unavailable');
      authorityDigest = stagedPhysicalAuthorityDigest({
        planAuthorityDigest: state.planAuthorityDigest,
        stageId,
        stageAuthorityId,
        stageDigest: stage.stageDigest,
        attemptOrdinal,
        logicalToolCallId,
        physicalDispatchId,
        toolName: stage.toolName,
        argumentDigest: logicalContract.argumentDigest,
        providerArgumentDigest,
        dependencyBindingDigest: compiled.dependencyBindingDigest,
        effect: stage.effect,
        leaseScopeId: lease.scopeId,
        leaseId: lease.leaseId,
        ...(retryOfStageAuthorityId ? { retryOfStageAuthorityId } : {}),
      });
      if (existing) {
        if (
          existing.stage_authority_id !== stageAuthorityId
          || existing.plan_id !== state.planId
          || existing.logical_tool_call_id !== logicalToolCallId
          || existing.physical_dispatch_id !== physicalDispatchId
          || existing.tool_name !== stage.toolName
          || existing.argument_digest !== logicalContract.argumentDigest
          || existing.provider_argument_digest !== providerArgumentDigest
          || existing.lease_scope_id !== lease.scopeId
          || existing.lease_id !== lease.leaseId
          || existing.authority_digest !== authorityDigest
          || existing.retry_of_stage_authority_id !== (retryOfStageAuthorityId ?? null)
        ) throw new StagedTransferAuthorityError('conflict', 'staged attempt replay differs');
        return 'replayed';
      }
      db.prepare(`
        INSERT INTO staged_transfer_stage_authorities
          (stage_authority_id, stage_id, plan_id, session_id, source_user_seq,
           accepted_task_id, stage_ordinal, stage_kind, attempt_ordinal,
           logical_tool_call_id, physical_dispatch_id, tool_name, argument_digest,
           provider_argument_digest, effect_kind, lease_scope_id, lease_id,
           retry_of_stage_authority_id, authority_digest, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        stageAuthorityId,
        stageId,
        state.planId,
        parent.sessionId,
        parent.sourceUserSeq,
        parent.acceptedTaskId,
        stage.ordinal,
        stage.kind,
        attemptOrdinal,
        logicalToolCallId,
        physicalDispatchId,
        stage.toolName,
        logicalContract.argumentDigest,
        providerArgumentDigest,
        stage.effect,
        lease.scopeId,
        lease.leaseId,
        retryOfStageAuthorityId ?? null,
        authorityDigest,
        new Date().toISOString(),
      );
      return 'prepared';
    });
    const status = transaction.immediate();
    if (!lease || !authorityDigest) {
      throw new StagedTransferAuthorityError('storage_error', 'staged attempt lease or digest was lost');
    }
    const identity: StagedPhysicalDispatchAuthorityState = {
      planId: state.planId,
      planAuthorityDigest: state.planAuthorityDigest,
      stageId,
      stageAuthorityId,
      stageKind: stage.kind,
      stageOrdinal: stage.ordinal,
      attemptOrdinal,
      sessionId: parent.sessionId,
      sourceUserSeq: parent.sourceUserSeq,
      acceptedTaskId: parent.acceptedTaskId,
      logicalToolCallId,
      physicalDispatchId,
      toolName: stage.toolName,
      argumentDigest: logicalContract.argumentDigest,
      providerArgumentDigest,
      ledgerArgs: Object.freeze(cloneProviderArgs(compiled.ledgerArgs)),
      dependencyBindingDigest: compiled.dependencyBindingDigest,
      effect: stage.effect,
      lease,
      ...(retryOfStageAuthorityId
        ? { retryOfStageAuthorityId }
        : {}),
      authorityDigest,
    };
    const authority = Object.freeze({ version: 1 as const });
    physicalAuthorities.set(authority, Object.freeze(identity));
    physicalInvocationArguments.set(authority, Object.freeze(cloneProviderArgs(compiled.providerArgs)));
    const downloadAuthority = state.downloadAuthorities.get(stage.stageDigest);
    if (downloadAuthority) physicalDownloadAuthorities.set(authority, downloadAuthority);
    return {
      status,
      authority,
      planId: state.planId,
      stageId,
      stageAuthorityId,
      physicalDispatchId,
    };
  } catch (error) {
    if (error instanceof StagedTransferAuthorityError) {
      return { status: error.code === 'storage_error' ? 'storage_error' : 'conflict', reason: error.message };
    }
    return {
      status: 'storage_error',
      reason: `staged physical authority could not be persisted: ${String(
        error instanceof Error ? error.message : error,
      ).replace(/\s+/g, ' ').slice(0, 180)}`,
    };
  }
}

function reopenStagedPhysicalFromExactPlan(input: {
  state: StagedTransferPlanAuthorityState;
  stageOrdinal: number;
  attemptOrdinal: number;
}): PrepareStagedPhysicalDispatchResult {
  const { state, attemptOrdinal } = input;
  const stage = stageAt(state, input.stageOrdinal);
  if (!stage) return { status: 'missing', reason: 'staged transfer stage is missing' };
  if (!Number.isSafeInteger(attemptOrdinal) || attemptOrdinal <= 0) {
    return { status: 'conflict', reason: 'staged attempt ordinal is invalid' };
  }
  try {
    const db = openEventLog();
    const compiled = compileStageDispatch({ db, state, stage, attemptOrdinal, forensic: true });
    if (!compiled) return { status: 'conflict', reason: 'staged attempt dependencies no longer rederive' };
    const parent = state.manifest.parent;
    const stageId = `staged-stage:${stage.stageDigest}`;
    const row = db.prepare(`
      SELECT * FROM staged_transfer_stage_authorities
       WHERE stage_id = ? AND attempt_ordinal = ?
    `).get(stageId, attemptOrdinal) as Record<string, unknown> | undefined;
    if (!row) return { status: 'missing', reason: 'staged attempt authority is missing' };
    const logicalToolCallId = stage.kind === 'business_execute'
      ? parent.logicalToolCallId
      : `call:staged:${digest({
          protocol: 'staged_child_logical_call_v1',
          planId: state.planId,
          stageDigest: stage.stageDigest,
          attemptOrdinal,
        })}`;
    const logicalArgs = stage.kind === 'business_execute'
      ? state.manifest.provider.providerArgs
      : compiled.ledgerArgs;
    const logicalContract = durableLogicalCallContract(parent.acceptedTaskId, stage.toolName, logicalArgs);
    if (!logicalContract) return { status: 'conflict', reason: 'staged logical contract no longer rederives' };
    const providerArgumentDigest = sha256(canonical(compiled.providerArgs));
    const physicalDispatchId = `dispatch:staged:${digest({
      protocol: 'staged_physical_dispatch_id_v1',
      planId: state.planId,
      stageDigest: stage.stageDigest,
      attemptOrdinal,
      logicalToolCallId,
      providerArgumentDigest,
    })}`;
    const stageAuthorityId = `staged-attempt:${digest({
      protocol: 'staged_stage_authority_id_v1',
      planId: state.planId,
      stageDigest: stage.stageDigest,
      attemptOrdinal,
      physicalDispatchId,
    })}`;
    const lease: DispatchLeaseRef = {
      sessionId: parent.sessionId,
      scopeId: String(row.lease_scope_id),
      leaseId: String(row.lease_id),
      sourceUserSeq: parent.sourceUserSeq,
      acceptedTaskId: parent.acceptedTaskId,
      logicalToolCallId,
    };
    const retryOfStageAuthorityId = row.retry_of_stage_authority_id === null
      ? undefined
      : String(row.retry_of_stage_authority_id);
    const authorityDigest = stagedPhysicalAuthorityDigest({
      planAuthorityDigest: state.planAuthorityDigest,
      stageId,
      stageAuthorityId,
      stageDigest: stage.stageDigest,
      attemptOrdinal,
      logicalToolCallId,
      physicalDispatchId,
      toolName: stage.toolName,
      argumentDigest: logicalContract.argumentDigest,
      providerArgumentDigest,
      dependencyBindingDigest: compiled.dependencyBindingDigest,
      effect: stage.effect,
      leaseScopeId: lease.scopeId,
      leaseId: lease.leaseId,
      ...(retryOfStageAuthorityId ? { retryOfStageAuthorityId } : {}),
    });
    if (
      row.stage_authority_id !== stageAuthorityId
      || row.plan_id !== state.planId
      || row.session_id !== parent.sessionId
      || row.source_user_seq !== parent.sourceUserSeq
      || row.accepted_task_id !== parent.acceptedTaskId
      || row.stage_ordinal !== stage.ordinal
      || row.stage_kind !== stage.kind
      || row.logical_tool_call_id !== logicalToolCallId
      || row.physical_dispatch_id !== physicalDispatchId
      || row.tool_name !== stage.toolName
      || row.argument_digest !== logicalContract.argumentDigest
      || row.provider_argument_digest !== providerArgumentDigest
      || row.effect_kind !== stage.effect
      || row.authority_digest !== authorityDigest
    ) return { status: 'conflict', reason: 'staged attempt durable tuple changed' };
    const physical = db.prepare(`
      SELECT state, staged_authority_digest, provider_argument_digest,
             lease_scope_id, lease_id
        FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
    `).get(parent.sessionId, parent.sourceUserSeq, physicalDispatchId) as {
      state: string;
      staged_authority_digest: string | null;
      provider_argument_digest: string | null;
      lease_scope_id: string | null;
      lease_id: string | null;
    } | undefined;
    if (physical && (
      physical.staged_authority_digest !== authorityDigest
      || physical.provider_argument_digest !== providerArgumentDigest
      || physical.lease_scope_id !== lease.scopeId
      || physical.lease_id !== lease.leaseId
    )) return { status: 'conflict', reason: 'staged physical durable tuple changed' };
    const terminalReturned = physical?.state === 'returned' && Boolean(db.prepare(`
      SELECT 1
        FROM staged_transfer_stage_receipts receipt
        JOIN physical_dispatch_return_checkpoints checkpoint
          ON checkpoint.stage_authority_id = receipt.stage_authority_id
       WHERE receipt.stage_authority_id = ?
         AND receipt.terminal_state = 'returned'
         AND receipt.result_digest = checkpoint.payload_plaintext_sha256
         AND checkpoint.physical_dispatch_id = ?
    `).get(stageAuthorityId, physicalDispatchId));
    if (!isDispatchLeaseCurrent(lease) && !terminalReturned) {
      return { status: 'conflict', reason: 'staged attempt lease is no longer current' };
    }
    const identity: StagedPhysicalDispatchAuthorityState = {
      planId: state.planId,
      planAuthorityDigest: state.planAuthorityDigest,
      stageId,
      stageAuthorityId,
      stageKind: stage.kind,
      stageOrdinal: stage.ordinal,
      attemptOrdinal,
      sessionId: parent.sessionId,
      sourceUserSeq: parent.sourceUserSeq,
      acceptedTaskId: parent.acceptedTaskId,
      logicalToolCallId,
      physicalDispatchId,
      toolName: stage.toolName,
      argumentDigest: logicalContract.argumentDigest,
      providerArgumentDigest,
      ledgerArgs: Object.freeze(cloneProviderArgs(compiled.ledgerArgs)),
      dependencyBindingDigest: compiled.dependencyBindingDigest,
      effect: stage.effect,
      lease,
      ...(retryOfStageAuthorityId ? { retryOfStageAuthorityId } : {}),
      authorityDigest,
      ...(terminalReturned ? { terminalOnly: true as const } : {}),
    };
    const authority = Object.freeze({ version: 1 as const });
    physicalAuthorities.set(authority, Object.freeze(identity));
    if (!terminalReturned) {
      physicalInvocationArguments.set(authority, Object.freeze(cloneProviderArgs(compiled.providerArgs)));
    }
    const downloadAuthority = state.downloadAuthorities.get(stage.stageDigest);
    if (downloadAuthority) physicalDownloadAuthorities.set(authority, downloadAuthority);
    return {
      status: 'replayed',
      authority,
      planId: state.planId,
      stageId,
      stageAuthorityId,
      physicalDispatchId,
    };
  } catch {
    return { status: 'storage_error', reason: 'staged physical authority could not be reopened' };
  }
}

/** Restart entry for an already-persisted attempt. A returned attempt may be
 * reopened after lease expiry, but only as a terminal forensic carrier. */
export function reopenStagedPhysicalDispatchAuthority(input: {
  planAuthority: StagedTransferPlanAuthority;
  stageOrdinal: number;
  attemptOrdinal?: number;
}): PrepareStagedPhysicalDispatchResult {
  const state = exactPlanState(input.planAuthority);
  if (!state) return { status: 'conflict', reason: 'staged plan authority no longer reopens' };
  return reopenStagedPhysicalFromExactPlan({
    state,
    stageOrdinal: input.stageOrdinal,
    attemptOrdinal: input.attemptOrdinal ?? 1,
  });
}

/** Exact DB re-open performed at both physical admission and settlement. */
export function inspectStagedPhysicalDispatchAuthority(
  authority: StagedPhysicalDispatchAuthority,
): Readonly<StagedPhysicalDispatchAuthorityState> | null {
  const state = physicalAuthorities.get(authority as object);
  if (!state) return null;
  try {
    const db = openEventLog();
    const row = db.prepare(`
      SELECT * FROM staged_transfer_stage_authorities WHERE stage_authority_id = ?
    `).get(state.stageAuthorityId) as Record<string, unknown> | undefined;
    const parent = db.prepare(`
      SELECT session_id, source_user_seq, parent_logical_tool_call_id
        FROM staged_transfer_plans WHERE plan_id = ?
    `).get(state.planId) as {
      session_id: string;
      source_user_seq: number;
      parent_logical_tool_call_id: string;
    } | undefined;
    // Terminality is durable evidence, not a property of whichever in-process
    // token happened to witness the return. Re-derive it for both original and
    // restart-minted carriers so a settled crossing can replay without keeping
    // a live lease, while provider invocation remains permanently disabled.
    const terminal = db.prepare(`
      SELECT 1
        FROM physical_dispatches physical
        JOIN staged_transfer_stage_receipts receipt
          ON receipt.session_id = physical.session_id
         AND receipt.source_user_seq = physical.source_user_seq
         AND receipt.physical_dispatch_id = physical.physical_dispatch_id
        JOIN physical_dispatch_return_checkpoints checkpoint
          ON checkpoint.stage_authority_id = receipt.stage_authority_id
       WHERE physical.session_id = ? AND physical.source_user_seq = ?
         AND physical.physical_dispatch_id = ?
         AND physical.state = 'returned'
         AND physical.staged_authority_digest = ?
         AND receipt.stage_authority_id = ?
         AND receipt.terminal_state = 'returned'
         AND receipt.result_digest = checkpoint.payload_plaintext_sha256
    `).get(
      state.sessionId,
      state.sourceUserSeq,
      state.physicalDispatchId,
      state.authorityDigest,
      state.stageAuthorityId,
    );
    const active = activePlanReopens.get(state.planId);
    const reopened = !active && parent ? reopenStagedTransferPlanAuthority({
      sessionId: parent.session_id,
      sourceUserSeq: parent.source_user_seq,
      parentLogicalToolCallId: parent.parent_logical_tool_call_id,
    }) : null;
    const planState = active ?? (reopened?.status === 'ok'
      ? planAuthorities.get(reopened.authority as object)
      : null);
    const stage = planState ? stageAt(planState, state.stageOrdinal) : null;
    const compiled = planState && stage
      ? compileStageDispatch({
          db,
          state: planState,
          stage,
          attemptOrdinal: state.attemptOrdinal,
          forensic: Boolean(terminal),
        })
      : null;
    if (
      !row
      || !compiled
      || sha256(canonical(compiled.providerArgs)) !== state.providerArgumentDigest
      || compiled.dependencyBindingDigest !== state.dependencyBindingDigest
      || canonical(compiled.ledgerArgs) !== canonical(state.ledgerArgs)
      || row.plan_id !== state.planId
      || row.stage_id !== state.stageId
      || row.stage_kind !== state.stageKind
      || row.stage_ordinal !== state.stageOrdinal
      || row.attempt_ordinal !== state.attemptOrdinal
      || row.session_id !== state.sessionId
      || row.source_user_seq !== state.sourceUserSeq
      || row.accepted_task_id !== state.acceptedTaskId
      || row.logical_tool_call_id !== state.logicalToolCallId
      || row.physical_dispatch_id !== state.physicalDispatchId
      || row.tool_name !== state.toolName
      || row.argument_digest !== state.argumentDigest
      || row.provider_argument_digest !== state.providerArgumentDigest
      || row.effect_kind !== state.effect
      || row.lease_scope_id !== state.lease.scopeId
      || row.lease_id !== state.lease.leaseId
      || row.retry_of_stage_authority_id !== (state.retryOfStageAuthorityId ?? null)
      || row.authority_digest !== state.authorityDigest
      || (!terminal && !isDispatchLeaseCurrent(state.lease))
    ) return null;
    return {
      ...state,
      ledgerArgs: cloneProviderArgs(state.ledgerArgs as Record<string, unknown>),
      lease: { ...state.lease },
      ...(terminal ? { terminalOnly: true as const } : {}),
    };
  } catch {
    return null;
  }
}

export type ExecuteStagedLocalSnapshotBodyResult =
  | {
      status: 'returned';
      result: StagedBlobBodyResult;
      sha256: string;
      md5: string;
      byteCount: number;
      bodyDigest: string;
      resultDigest: string;
    }
  | {
      status: 'threw';
      code: 'source_unavailable' | 'source_refused' | 'blob_too_large' | 'storage_error';
    }
  | { status: 'conflict'; reason: string };

export type ExecuteStagedSourceDownloadBodyResult =
  | {
      status: 'returned';
      checkpoint: PreparedPhysicalReturnCheckpoint;
      result: StagedBlobBodyResult;
      sha256: string;
      md5: string;
      byteCount: number;
      bodyDigest: string;
      resultDigest: string;
    }
  | {
      status: 'threw';
      code: 'source_unavailable' | 'blob_too_large' | 'storage_error';
    }
  | { status: 'preparation_required'; reason: string }
  | { status: 'checkpoint_failed'; reason: string }
  | { status: 'conflict'; reason: string };

function exactStartedStagedPhysicalBody(input: {
  authority: StagedPhysicalDispatchAuthority;
  stageKind: StagedTransferStageKind;
}): {
  state: Readonly<StagedPhysicalDispatchAuthorityState>;
  providerArgs: Readonly<Record<string, unknown>>;
} | null {
  const state = inspectStagedPhysicalDispatchAuthority(input.authority);
  const providerArgs = physicalInvocationArguments.get(input.authority as object);
  if (
    !state
    || state.terminalOnly
    || state.stageKind !== input.stageKind
    || !providerArgs
    || sha256(canonical(providerArgs)) !== state.providerArgumentDigest
  ) return null;
  const started = openEventLog().prepare(`
    SELECT 1 FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
       AND state = 'started' AND staged_authority_digest = ?
       AND provider_argument_digest = ?
       AND lease_scope_id = ? AND lease_id = ?
  `).get(
    state.sessionId,
    state.sourceUserSeq,
    state.physicalDispatchId,
    state.authorityDigest,
    state.providerArgumentDigest,
    state.lease.scopeId,
    state.lease.leaseId,
  );
  return started ? { state, providerArgs } : null;
}

function exactStartedStagedBlobBody(input: {
  authority: StagedPhysicalDispatchAuthority;
  stageKind: 'local_snapshot' | 'source_download' | 'download_transfer' | 'local_commit';
}): {
  state: Readonly<StagedPhysicalDispatchAuthorityState>;
  providerArgs: Readonly<Record<string, unknown>>;
} | null {
  return exactStartedStagedPhysicalBody(input);
}

function exactLocalCommitMaterialization(input: {
  db: Database.Database;
  state: Readonly<StagedPhysicalDispatchAuthorityState>;
}): {
  blob: ExactBlobOwner;
  destination: { directory: string; name: string; materializedPath: string };
} | null {
  if (input.state.stageKind !== 'local_commit') return null;
  const row = input.db.prepare(`
    SELECT stage.stage_ordinal, stage.json_pointer_digest, stage.stage_digest,
           dependency.stage_id AS dependency_stage_id,
           dependency.stage_kind AS dependency_stage_kind
      FROM staged_transfer_stages stage
      JOIN staged_transfer_stages dependency
        ON dependency.plan_id = stage.plan_id
       AND dependency.stage_ordinal = stage.depends_on_stage_ordinal
     WHERE stage.plan_id = ? AND stage.stage_id = ?
       AND stage.stage_ordinal = ? AND stage.stage_kind = 'local_commit'
       AND stage.stage_id = 'staged-stage:' || stage.stage_digest
  `).get(
    input.state.planId,
    input.state.stageId,
    input.state.stageOrdinal,
  ) as {
    stage_ordinal: number;
    json_pointer_digest: string | null;
    stage_digest: string;
    dependency_stage_id: string;
    dependency_stage_kind: string;
  } | undefined;
  if (
    !row
    || row.dependency_stage_kind !== 'download_transfer'
    || !DIGEST_RE.test(row.stage_digest)
    || (row.json_pointer_digest !== null && !DIGEST_RE.test(row.json_pointer_digest))
  ) return null;
  const dependency = successfulStageEvidence(input.db, input.state.planId, row.dependency_stage_id);
  const blob = exactBlobOwner(input.db, input.state.planId, row.dependency_stage_id);
  if (
    !dependency
    || dependency.stageKind !== 'download_transfer'
    || dependency.stageId !== row.dependency_stage_id
    || !blob
  ) return null;
  return {
    blob,
    destination: localCommitDestinationForStage({
      planId: input.state.planId,
      stage: {
        ordinal: row.stage_ordinal,
        pointerDigest: row.json_pointer_digest,
        stageDigest: row.stage_digest,
      },
    }),
  };
}

function exactUploadTransferMaterial(input: {
  db: Database.Database;
  state: Readonly<StagedPhysicalDispatchAuthorityState>;
  providerArgs: Readonly<Record<string, unknown>>;
}): {
  signedUrl: string;
  headers: Readonly<Record<string, string>>;
  blob: ExactBlobOwner;
  headerDigest: string;
} | null {
  if (input.state.stageKind !== 'upload_transfer') return null;
  const rows = input.db.prepare(`
    SELECT presign.stage_id AS presign_stage_id,
           snapshot.stage_id AS snapshot_stage_id
      FROM staged_transfer_stages transfer
      JOIN staged_transfer_stages presign
        ON presign.plan_id = transfer.plan_id
       AND presign.stage_ordinal = transfer.depends_on_stage_ordinal
       AND presign.stage_kind = 'upload_presign'
      JOIN staged_transfer_stages snapshot
        ON snapshot.plan_id = transfer.plan_id
       AND snapshot.stage_kind = 'local_snapshot'
       AND snapshot.json_pointer_digest = transfer.json_pointer_digest
     WHERE transfer.plan_id = ? AND transfer.stage_id = ?
       AND transfer.stage_ordinal = ? AND transfer.stage_kind = 'upload_transfer'
     ORDER BY snapshot.stage_ordinal
     LIMIT 2
  `).all(
    input.state.planId,
    input.state.stageId,
    input.state.stageOrdinal,
  ) as Array<{ presign_stage_id: string; snapshot_stage_id: string }>;
  if (rows.length !== 1) return null;
  const presign = successfulStageEvidence(input.db, input.state.planId, rows[0]!.presign_stage_id);
  const secret = presign ? exactPresignSecret(input.db, presign) : null;
  const blob = exactBlobOwner(input.db, input.state.planId, rows[0]!.snapshot_stage_id);
  if (!presign || !secret || !blob) return null;
  const headers: Readonly<Record<string, string>> = secret.storageBackend === 'azure_blob_storage'
    ? Object.freeze<Record<string, string>>({
          'content-type': 'application/octet-stream',
          'x-ms-blob-type': 'BlockBlob',
        })
    : Object.freeze<Record<string, string>>({ 'content-type': 'application/octet-stream' });
  const expectedArgs = {
    signed_url: secret.signedUrl,
    headers,
    staged_blob: blob,
  };
  if (canonical(input.providerArgs) !== canonical(expectedArgs)) return null;
  return {
    signedUrl: secret.signedUrl,
    headers,
    blob,
    headerDigest: digest(headers),
  };
}

function exactBusinessPreparationMaterial(input: {
  db: Database.Database;
  state: Readonly<StagedPhysicalDispatchAuthorityState>;
  providerArgs: Readonly<Record<string, unknown>>;
}): {
  operationId: string;
  operationVersion: string;
  accountId: string;
  args: Record<string, unknown>;
} | null {
  if (input.state.stageKind !== 'business_execute') return null;
  const row = input.db.prepare(`
    SELECT session_id, source_user_seq, parent_logical_tool_call_id,
           host_operation_id, host_account_id, operation_version
      FROM staged_transfer_plans
     WHERE plan_id = ?
  `).get(input.state.planId) as {
    session_id: string;
    source_user_seq: number;
    parent_logical_tool_call_id: string;
    host_operation_id: string;
    host_account_id: string;
    operation_version: string;
  } | undefined;
  if (
    !row
    || row.session_id !== input.state.sessionId
    || row.source_user_seq !== input.state.sourceUserSeq
    || row.parent_logical_tool_call_id !== input.state.logicalToolCallId
  ) return null;
  const reopened = reopenStagedTransferPlanAuthority({
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    parentLogicalToolCallId: row.parent_logical_tool_call_id,
  });
  const plan = reopened.status === 'ok'
    ? planAuthorities.get(reopened.authority as object)
    : null;
  const stage = plan ? stageAt(plan, input.state.stageOrdinal) : null;
  const compiled = plan ? compiledBusinessArgs(input.db, plan) : null;
  if (
    !plan
    || plan.planId !== input.state.planId
    || plan.planAuthorityDigest !== input.state.planAuthorityDigest
    || !stage
    || stage.kind !== 'business_execute'
    || stage.toolName !== input.state.toolName
    || !compiled
    || canonical(compiled.args) !== canonical(input.providerArgs)
    || sha256(canonical(compiled.args)) !== input.state.providerArgumentDigest
    || plan.manifest.provider.operationId !== row.host_operation_id
    || plan.manifest.provider.operationVersion !== row.operation_version
    || plan.manifest.provider.accountId !== row.host_account_id
    || plan.manifest.provider.operationId.toLowerCase() !== input.state.toolName
  ) return null;
  return {
    operationId: plan.manifest.provider.operationId,
    operationVersion: plan.manifest.provider.operationVersion,
    accountId: plan.manifest.provider.accountId,
    args: compiled.args,
  };
}

export type PrepareStagedComposioBusinessBodyResult =
  | {
      status: 'prepared' | 'replayed';
      preparedDispatch: PreparedComposioOneShotDispatch;
    }
  | { status: 'conflict' | 'preparation_required'; reason: string };

/**
 * Convert one exact started business authority into the Composio adapter's
 * opaque no-retry one-shot. Uploaded-file descriptors are recompiled from
 * exact returned stage evidence and remain private with all provider args.
 */
export function prepareStagedComposioBusinessBody(input: {
  authority: StagedPhysicalDispatchAuthority;
}): PrepareStagedComposioBusinessBodyResult {
  const exact = exactStartedStagedPhysicalBody({
    authority: input.authority,
    stageKind: 'business_execute',
  });
  if (!exact) {
    return { status: 'conflict', reason: 'business preparation lacks its exact started physical authority' };
  }
  const material = exactBusinessPreparationMaterial({
    db: openEventLog(),
    state: exact.state,
    providerArgs: exact.providerArgs,
  });
  if (!material) {
    return { status: 'conflict', reason: 'business provider dependencies no longer reopen exactly' };
  }
  const ownsExactPreparation = (prepared: PreparedComposioOneShotDispatch): boolean => {
    const inspected = inspectPreparedComposioOneShotDispatch(prepared);
    return Boolean(
      inspected
      && inspected.lane === 'sdk'
      && inspected.toolSlug === material.operationId
      && inspected.toolSlug.toLowerCase() === exact.state.toolName
      && inspected.providerArgumentDigest === exact.state.providerArgumentDigest
      && inspected.connectedAccountId === material.accountId
      && inspected.providerOperationVersion === material.operationVersion
    );
  };
  const existing = physicalBusinessPreparations.get(input.authority as object);
  if (existing) {
    if (!ownsExactPreparation(existing)) {
      return { status: 'conflict', reason: 'business one-shot was already consumed or changed' };
    }
    return { status: 'replayed', preparedDispatch: existing };
  }
  try {
    const preparedDispatch = prepareComposioOneShotDispatch({
      toolSlug: material.operationId,
      args: cloneProviderArgs(material.args),
      connectedAccountId: material.accountId,
      providerOperationVersion: material.operationVersion,
    });
    if (!ownsExactPreparation(preparedDispatch)) {
      return { status: 'conflict', reason: 'business one-shot does not match its exact staged compiler' };
    }
    physicalBusinessPreparations.set(input.authority as object, preparedDispatch);
    return { status: 'prepared', preparedDispatch };
  } catch {
    return {
      status: 'preparation_required',
      reason: 'the exact no-retry Composio business transport is unavailable',
    };
  }
}

export type PrepareStagedComposioPresignBodyResult =
  | {
      status: 'prepared' | 'replayed';
      preparedPresign: PreparedComposioPresignOneShot;
    }
  | { status: 'conflict' | 'preparation_required'; reason: string };

/**
 * Convert one exact started upload-presign authority into the provider
 * adapter's opaque no-retry one-shot. Provider arguments remain in the two
 * owning modules and are never returned beside the token.
 */
export function prepareStagedComposioPresignBody(input: {
  authority: StagedPhysicalDispatchAuthority;
}): PrepareStagedComposioPresignBodyResult {
  const exact = exactStartedStagedPhysicalBody({
    authority: input.authority,
    stageKind: 'upload_presign',
  });
  if (!exact) {
    return { status: 'conflict', reason: 'presign preparation lacks its exact started physical authority' };
  }
  const existing = physicalPresignPreparations.get(input.authority as object);
  if (existing) {
    const inspected = inspectPreparedComposioPresignOneShot(existing);
    if (!inspected || inspected.providerArgumentDigest !== exact.state.providerArgumentDigest) {
      return { status: 'conflict', reason: 'presign one-shot was already consumed or changed' };
    }
    return { status: 'replayed', preparedPresign: existing };
  }
  try {
    const preparedPresign = prepareComposioPresignOneShot({
      args: cloneProviderArgs(exact.providerArgs as Record<string, unknown>),
    });
    const inspected = inspectPreparedComposioPresignOneShot(preparedPresign);
    if (!inspected || inspected.providerArgumentDigest !== exact.state.providerArgumentDigest) {
      return { status: 'conflict', reason: 'presign one-shot does not match its exact staged compiler' };
    }
    physicalPresignPreparations.set(input.authority as object, preparedPresign);
    return { status: 'prepared', preparedPresign };
  } catch {
    return {
      status: 'preparation_required',
      reason: 'the exact no-retry Composio presign transport is unavailable',
    };
  }
}

export type PrepareStagedDownloadBodyCarrierResult =
  | {
      status: 'prepared' | 'replayed';
      carrier: StagedDownloadBodyCarrier;
      resultDigest: string;
      descriptorDigest: string;
    }
  | { status: 'conflict'; reason: string };

/**
 * Bind the exact started download crossing to its checkpoint-owned descriptor
 * without disclosing the URL. Repeated preparation returns the same carrier;
 * consumption at the checkpoint edge is one-shot.
 */
export function prepareStagedDownloadBodyCarrier(input: {
  authority: StagedPhysicalDispatchAuthority;
}): PrepareStagedDownloadBodyCarrierResult {
  const exact = exactStartedStagedBlobBody({
    authority: input.authority,
    stageKind: 'download_transfer',
  });
  if (!exact) return { status: 'conflict', reason: 'download body lacks its exact started physical authority' };
  const existing = physicalDownloadBodyCarriers.get(input.authority as object);
  if (existing) {
    const state = stagedDownloadBodyCarriers.get(existing as object);
    if (!state || state.consumed) {
      return { status: 'conflict', reason: 'download body carrier was already consumed' };
    }
    return {
      status: 'replayed',
      carrier: existing,
      resultDigest: state.resultDigest,
      descriptorDigest: state.descriptorDigest,
    };
  }
  const downloadAuthority = physicalDownloadAuthorities.get(input.authority as object);
  const download = downloadAuthority
    ? inspectCommittedComposioDownloadAuthority(downloadAuthority)
    : null;
  if (!download) return { status: 'conflict', reason: 'download descriptor authority no longer reopens' };
  const carrier = Object.freeze({ version: 1 as const });
  stagedDownloadBodyCarriers.set(carrier, {
    authority: input.authority,
    downloadAuthority: downloadAuthority!,
    stageAuthorityId: exact.state.stageAuthorityId,
    authorityDigest: exact.state.authorityDigest,
    providerArgumentDigest: exact.state.providerArgumentDigest,
    resultDigest: download.resultDigest,
    descriptorDigest: download.descriptorDigest,
    consumed: false,
  });
  physicalDownloadBodyCarriers.set(input.authority as object, carrier);
  return {
    status: 'prepared',
    carrier,
    resultDigest: download.resultDigest,
    descriptorDigest: download.descriptorDigest,
  };
}

/** Checkpoint-only one-shot handoff. The returned value is itself opaque and
 * reveals no URL, path, bytes, or provider arguments. */
export function consumeStagedDownloadBodyCarrier(input: {
  authority: StagedPhysicalDispatchAuthority;
  carrier: StagedDownloadBodyCarrier;
}): CommittedComposioDownloadAuthority | null {
  const carrier = stagedDownloadBodyCarriers.get(input.carrier as object);
  if (!carrier || carrier.consumed || carrier.authority !== input.authority) return null;
  const exact = exactStartedStagedBlobBody({
    authority: input.authority,
    stageKind: 'download_transfer',
  });
  const download = inspectCommittedComposioDownloadAuthority(carrier.downloadAuthority);
  if (
    !exact
    || enteredStagedBlobBodies.has(input.authority as object)
    || exact.state.stageAuthorityId !== carrier.stageAuthorityId
    || exact.state.authorityDigest !== carrier.authorityDigest
    || exact.state.providerArgumentDigest !== carrier.providerArgumentDigest
    || !download
    || download.resultDigest !== carrier.resultDigest
    || download.descriptorDigest !== carrier.descriptorDigest
  ) return null;
  carrier.consumed = true;
  enteredStagedBlobBodies.add(input.authority as object);
  return carrier.downloadAuthority;
}

function stagedBlobStoreDirectory(): string {
  return path.resolve(composioFilesDir());
}

function stagedPublishedBlobPath(sha256Digest: string): string {
  const configured = stagedBlobStoreDirectory();
  // Blob publication canonicalizes its store with realpathSync. On macOS the
  // temp/home path can traverse `/var` while the published path is rooted at
  // `/private/var`; reconstruct the same host-owned canonical child once the
  // store exists, without ever exposing that path to the caller.
  let store = configured;
  try {
    store = realpathSync(configured);
  } catch {
    // A pre-publication compiler may run before the directory exists. Its
    // explicit configured path still resolves to the same child when created.
  }
  return path.join(store, `sha256-${sha256Digest}`);
}

function stagedLocalFileAllowRoots(storeDirectory: string): readonly string[] {
  const roots = [storeDirectory, BASE_DIR, process.cwd(), ...getWorkspaceDirs()]
    .map((candidate) => path.resolve(candidate));
  return Object.freeze([...new Set(roots)]);
}

function stagedBlobCheckpointPayload(input: {
  stageKind: StagedBlobBodyResultState['stageKind'];
  bodyDigest: string;
  blob: Pick<PublishedStagedFileBlob, 'sha256' | 'md5' | 'byteCount'>;
}): Record<string, unknown> {
  return {
    successful: true,
    data: {
      protocol: 'staged_blob_body_return_v1',
      stage_kind: input.stageKind,
      body_digest: input.bodyDigest,
      sha256: input.blob.sha256,
      md5: input.blob.md5,
      byte_count: input.blob.byteCount,
    },
  };
}

function stagedUploadTransferCheckpointPayload(input: {
  bodyDigest: string;
  byteCount: number;
}): Record<string, unknown> {
  return {
    successful: true,
    data: {
      protocol: 'staged_upload_transfer_return_v1',
      body_digest: input.bodyDigest,
      byte_count: input.byteCount,
    },
  };
}

/** Exact WeakMap predicate for the checkpoint module. Copyable safe metadata
 * cannot mint or substitute an upload return for another physical attempt. */
export function stagedUploadTransferBodyResultOwnsCheckpoint(input: {
  authority: StagedPhysicalDispatchAuthority;
  result: StagedUploadTransferBodyResult;
  bodyDigest: string;
  resultDigest: string;
  byteCount: number;
}): boolean {
  const result = stagedUploadTransferBodyResults.get(input.result as object);
  const exact = result ? exactStartedStagedPhysicalBody({
    authority: input.authority,
    stageKind: 'upload_transfer',
  }) : null;
  return Boolean(
    result
    && exact
    && result.authority === input.authority
    && result.stageAuthorityId === exact.state.stageAuthorityId
    && result.authorityDigest === exact.state.authorityDigest
    && result.providerArgumentDigest === exact.state.providerArgumentDigest
    && result.bodyDigest === input.bodyDigest
    && result.resultDigest === input.resultDigest
    && result.byteCount === input.byteCount
    && sha256(canonical(stagedUploadTransferCheckpointPayload({
      bodyDigest: result.bodyDigest,
      byteCount: result.byteCount,
    }))) === result.resultDigest
  );
}

function sameUploadBlobStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function verifyExactUploadBlobFile(blob: ExactBlobOwner): BigIntStats {
  const blobPath = stagedPublishedBlobPath(blob.sha256);
  let fd: number | null = null;
  try {
    fd = openSync(blobPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || (before.mode & 0o777n) !== 0o600n
      || before.size !== BigInt(blob.byteCount)
    ) throw new StagedTransferAuthorityError('conflict', 'staged upload blob file is not exact');
    const sha = createHash('sha256');
    const md5 = createHash('md5');
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let position = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.byteLength, position);
      if (count === 0) break;
      position += count;
      if (position > blob.byteCount) {
        throw new StagedTransferAuthorityError('conflict', 'staged upload blob grew during verification');
      }
      const chunk = buffer.subarray(0, count);
      sha.update(chunk);
      md5.update(chunk);
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      !sameUploadBlobStat(before, after)
      || position !== blob.byteCount
      || sha.digest('hex') !== blob.sha256
      || md5.digest('hex') !== blob.md5
    ) throw new StagedTransferAuthorityError('conflict', 'staged upload blob bytes are not exact');
    return before;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export type ExecuteStagedUploadTransferBodyResult =
  | {
      status: 'returned';
      checkpoint: PreparedPhysicalReturnCheckpoint;
      result: StagedUploadTransferBodyResult;
      byteCount: number;
      bodyDigest: string;
      resultDigest: string;
    }
  | { status: 'threw'; code: 'source_unavailable' | 'upload_ambiguous' }
  | { status: 'checkpoint_failed'; reason: string }
  | { status: 'conflict'; reason: string };

/**
 * Execute one exact object-store PUT and synchronously mint its checkpoint
 * before yielding a successful result. Network failures, aborts, and non-2xx
 * responses are deliberately ambiguous; the stage's durable retry policy
 * requires reconciliation before any later attempt can cross again.
 */
export async function executeStagedUploadTransferBody(input: {
  authority: StagedPhysicalDispatchAuthority;
}): Promise<ExecuteStagedUploadTransferBodyResult> {
  const exact = exactStartedStagedPhysicalBody({
    authority: input.authority,
    stageKind: 'upload_transfer',
  });
  if (!exact) return { status: 'conflict', reason: 'upload body lacks its exact started physical authority' };
  if (enteredStagedUploadTransferBodies.has(input.authority as object)) {
    return { status: 'conflict', reason: 'upload body authority was already consumed' };
  }
  const material = exactUploadTransferMaterial({
    db: openEventLog(),
    state: exact.state,
    providerArgs: exact.providerArgs,
  });
  if (!material) return { status: 'conflict', reason: 'upload body dependencies no longer reopen exactly' };
  const transport = createPublicHttpsOriginTransport(material.signedUrl);
  if (!transport) return { status: 'threw', code: 'source_unavailable' };
  enteredStagedUploadTransferBodies.add(input.authority as object);

  let sourceBefore: BigIntStats;
  try {
    sourceBefore = verifyExactUploadBlobFile(material.blob);
  } catch {
    await transport.close();
    return { status: 'threw', code: 'source_unavailable' };
  }
  const blobPath = stagedPublishedBlobPath(material.blob.sha256);
  let stream: ReturnType<typeof createReadStream> | null = null;
  let response: Response;
  try {
    const fd = openSync(blobPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (!sameUploadBlobStat(sourceBefore, opened)) {
      closeSync(fd);
      await transport.close();
      return { status: 'threw', code: 'source_unavailable' };
    }
    stream = createReadStream(blobPath, {
      fd,
      autoClose: true,
      start: 0,
    });
    response = await fetch(material.signedUrl, {
      method: 'PUT',
      redirect: 'error',
      headers: { ...material.headers },
      body: stream,
      signal: currentToolAbortSignal(),
      duplex: 'half',
      dispatcher: transport.dispatcher,
    } as unknown as RequestInit & { dispatcher: typeof transport.dispatcher });
  } catch {
    stream?.destroy();
    await transport.close();
    return { status: 'threw', code: 'upload_ambiguous' };
  } finally {
    stream?.destroy();
  }
  try {
    await response.body?.cancel();
  } catch {
    // Response bytes are not authority-bearing; the HTTP status is sufficient.
  }
  await transport.close();
  if (!response.ok) return { status: 'threw', code: 'upload_ambiguous' };
  try {
    const sourceAfter = verifyExactUploadBlobFile(material.blob);
    if (!sameUploadBlobStat(sourceBefore, sourceAfter)) {
      return { status: 'threw', code: 'upload_ambiguous' };
    }
  } catch {
    return { status: 'threw', code: 'upload_ambiguous' };
  }

  const bodyDigest = digest({
    protocol: 'staged_upload_transfer_body_v1',
    stageAuthorityId: exact.state.stageAuthorityId,
    stageAuthorityDigest: exact.state.authorityDigest,
    providerArgumentDigest: exact.state.providerArgumentDigest,
    blob: {
      sha256: material.blob.sha256,
      md5: material.blob.md5,
      byteCount: material.blob.byteCount,
    },
    headerDigest: material.headerDigest,
    httpStatus: response.status,
  });
  const resultDigest = sha256(canonical(stagedUploadTransferCheckpointPayload({
    bodyDigest,
    byteCount: material.blob.byteCount,
  })));
  const result = Object.freeze({ version: 1 as const });
  stagedUploadTransferBodyResults.set(result, Object.freeze({
    authority: input.authority,
    stageAuthorityId: exact.state.stageAuthorityId,
    authorityDigest: exact.state.authorityDigest,
    providerArgumentDigest: exact.state.providerArgumentDigest,
    blobSha256: material.blob.sha256,
    blobMd5: material.blob.md5,
    byteCount: material.blob.byteCount,
    headerDigest: material.headerDigest,
    httpStatus: response.status,
    bodyDigest,
    resultDigest,
  }));
  const checkpoint = prepareStagedUploadTransferReturnCheckpoint({
    authority: input.authority,
    result,
    bodyDigest,
    resultDigest,
    byteCount: material.blob.byteCount,
  });
  if (checkpoint.status !== 'prepared') {
    return {
      status: 'checkpoint_failed',
      reason: 'upload returned but its exact checkpoint could not be persisted',
    };
  }
  return {
    status: 'returned',
    checkpoint: checkpoint.checkpoint,
    result,
    byteCount: material.blob.byteCount,
    bodyDigest,
    resultDigest,
  };
}

function mintStagedBlobBodyResult(input: {
  authority: StagedPhysicalDispatchAuthority;
  state: Readonly<StagedPhysicalDispatchAuthorityState>;
  stageKind: StagedBlobBodyResultState['stageKind'];
  blob: PublishedStagedFileBlob;
}): ExecuteStagedLocalSnapshotBodyResult & { status: 'returned' } {
  const bodyDigest = digest({
    protocol: 'staged_blob_body_v1',
    stageAuthorityId: input.state.stageAuthorityId,
    stageAuthorityDigest: input.state.authorityDigest,
    providerArgumentDigest: input.state.providerArgumentDigest,
    stageKind: input.stageKind,
    blob: {
      sha256: input.blob.sha256,
      md5: input.blob.md5,
      byteCount: input.blob.byteCount,
    },
  });
  const resultDigest = sha256(canonical(stagedBlobCheckpointPayload({
    stageKind: input.stageKind,
    bodyDigest,
    blob: input.blob,
  })));
  const result = Object.freeze({ version: 1 as const });
  stagedBlobBodyResults.set(result, Object.freeze({
    authority: input.authority,
    stageAuthorityId: input.state.stageAuthorityId,
    stageKind: input.stageKind,
    authorityDigest: input.state.authorityDigest,
    providerArgumentDigest: input.state.providerArgumentDigest,
    blob: Object.freeze({ ...input.blob }),
    bodyDigest,
    resultDigest,
  }));
  return {
    status: 'returned',
    result,
    sha256: input.blob.sha256,
    md5: input.blob.md5,
    byteCount: input.blob.byteCount,
    bodyDigest,
    resultDigest,
  };
}

function stagedBlobBodyFailureCode(error: unknown): Extract<
  ExecuteStagedLocalSnapshotBodyResult,
  { status: 'threw' }
>['code'] {
  if (!(error instanceof StagedFileBlobError)) return 'storage_error';
  if (error.code === 'blob_too_large') return 'blob_too_large';
  if (error.code === 'source_not_allowed' || error.code === 'sensitive_source') return 'source_refused';
  if (
    error.code === 'source_missing'
    || error.code === 'source_not_regular'
    || error.code === 'source_changed'
    || error.code === 'digest_mismatch'
    || error.code === 'invalid_staged_blob'
  ) return 'source_unavailable';
  return 'storage_error';
}

function exactRemoteSourceUrl(
  providerArgs: Readonly<Record<string, unknown>>,
): string | null {
  if (
    Object.keys(providerArgs).sort().join('\0') !== 'url'
    || typeof providerArgs.url !== 'string'
    || providerArgs.url.trim() !== providerArgs.url
  ) return null;
  try {
    const parsed = new URL(providerArgs.url);
    if (
      parsed.protocol !== 'https:'
      || !parsed.hostname
      || parsed.username !== ''
      || parsed.password !== ''
    ) return null;
    return providerArgs.url;
  } catch {
    return null;
  }
}

/**
 * Download one exact manifest-owned HTTPS upload source into the private
 * content-addressed blob store. The body is one-shot and owns exactly one GET;
 * a successful GET is synchronously checkpointed before any result is yielded.
 * The URL, bytes, and host path never leave this module.
 */
export async function executeStagedSourceDownloadBody(input: {
  authority: StagedPhysicalDispatchAuthority;
}): Promise<ExecuteStagedSourceDownloadBodyResult> {
  const exact = exactStartedStagedBlobBody({
    authority: input.authority,
    stageKind: 'source_download',
  });
  if (!exact) {
    return { status: 'conflict', reason: 'source download lacks its exact started physical authority' };
  }
  if (enteredStagedBlobBodies.has(input.authority as object)) {
    return { status: 'conflict', reason: 'source download body authority was already consumed' };
  }
  const sourceUrl = exactRemoteSourceUrl(exact.providerArgs);
  if (!sourceUrl) {
    return { status: 'conflict', reason: 'source download compiler changed before execution' };
  }
  const transport = createPublicHttpsOriginTransport(sourceUrl);
  if (!transport) {
    return {
      status: 'preparation_required',
      reason: 'remote upload sources require a public HTTPS origin',
    };
  }
  enteredStagedBlobBodies.add(input.authority as object);
  let response: Response;
  try {
    response = await fetch(sourceUrl, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/octet-stream' },
      signal: currentToolAbortSignal(),
      dispatcher: transport.dispatcher,
    } as RequestInit & { dispatcher: typeof transport.dispatcher });
  } catch {
    await transport.close();
    return { status: 'threw', code: 'source_unavailable' };
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* response bytes carry no authority */ }
    await transport.close();
    return { status: 'threw', code: 'source_unavailable' };
  }

  let writer: ReturnType<typeof createStagedFileBlobWriter> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    writer = createStagedFileBlobWriter({ storeDirectory: stagedBlobStoreDirectory() });
    reader = response.body?.getReader() ?? null;
    if (reader) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value.byteLength > 0) writer.write(chunk.value);
      }
    }
    const sealed = writer.seal();
    const blob = publishStagedFileBlob({
      storeDirectory: stagedBlobStoreDirectory(),
      sealed,
    });
    writer = null;
    const returned = mintStagedBlobBodyResult({
      authority: input.authority,
      state: exact.state,
      stageKind: 'source_download',
      blob,
    });
    const checkpoint = prepareStagedBlobBodyReturnCheckpoint({
      authority: input.authority,
      result: returned.result,
      sha256: returned.sha256,
      md5: returned.md5,
      byteCount: returned.byteCount,
      bodyDigest: returned.bodyDigest,
      resultDigest: returned.resultDigest,
    });
    if (checkpoint.status !== 'prepared') {
      return {
        status: 'checkpoint_failed',
        reason: 'source download returned but its exact checkpoint could not be persisted',
      };
    }
    return { ...returned, checkpoint: checkpoint.checkpoint };
  } catch (error) {
    try { await reader?.cancel(); } catch { /* the primary body error is authoritative */ }
    writer?.abort();
    const code = stagedBlobBodyFailureCode(error);
    return {
      status: 'threw',
      code: code === 'source_refused' ? 'source_unavailable' : code,
    };
  } finally {
    try { reader?.releaseLock(); } catch { /* best effort */ }
    await transport.close();
  }
}

/**
 * Execute exactly one local-snapshot body. The local path and blob-store path
 * remain in this module; callers receive only an opaque result plus digest and
 * size metadata suitable for an exact return-checkpoint handoff.
 */
export function executeStagedLocalSnapshotBody(input: {
  authority: StagedPhysicalDispatchAuthority;
}): ExecuteStagedLocalSnapshotBodyResult {
  const exact = exactStartedStagedBlobBody({
    authority: input.authority,
    stageKind: 'local_snapshot',
  });
  if (!exact) return { status: 'conflict', reason: 'local snapshot lacks its exact started physical authority' };
  if (enteredStagedBlobBodies.has(input.authority as object)) {
    return { status: 'conflict', reason: 'local snapshot body authority was already consumed' };
  }
  const dependencyBlob = plainRecord(exact.providerArgs.staged_blob)
    && DIGEST_RE.test(String(exact.providerArgs.staged_blob.sha256 ?? ''))
    && /^[a-f0-9]{32}$/.test(String(exact.providerArgs.staged_blob.md5 ?? ''))
    && Number.isSafeInteger(exact.providerArgs.staged_blob.byteCount)
    && Number(exact.providerArgs.staged_blob.byteCount) >= 0
    ? {
        sha256: String(exact.providerArgs.staged_blob.sha256),
        md5: String(exact.providerArgs.staged_blob.md5),
        byteCount: Number(exact.providerArgs.staged_blob.byteCount),
      }
    : null;
  const sourcePath = typeof exact.providerArgs.source_path === 'string'
    ? exact.providerArgs.source_path
    : dependencyBlob
      ? stagedPublishedBlobPath(dependencyBlob.sha256)
      : null;
  if (!sourcePath) return { status: 'conflict', reason: 'local snapshot source compiler changed' };
  enteredStagedBlobBodies.add(input.authority as object);
  try {
    const storeDirectory = stagedBlobStoreDirectory();
    const snapshot = snapshotAllowedLocalFile({
      sourcePath,
      allowRoots: stagedLocalFileAllowRoots(storeDirectory),
      storeDirectory,
    });
    if (dependencyBlob && (
      snapshot.sha256 !== dependencyBlob.sha256
      || snapshot.md5 !== dependencyBlob.md5
      || snapshot.byteCount !== dependencyBlob.byteCount
    )) {
      throw new StagedFileBlobError('digest_mismatch', 'staged dependency blob changed before snapshot');
    }
    return mintStagedBlobBodyResult({
      authority: input.authority,
      state: exact.state,
      stageKind: 'local_snapshot',
      blob: {
        blobPath: snapshot.blobPath,
        sha256: snapshot.sha256,
        md5: snapshot.md5,
        byteCount: snapshot.byteCount,
      },
    });
  } catch (error) {
    return { status: 'threw', code: stagedBlobBodyFailureCode(error) };
  }
}

/**
 * Materialize one returned download into its deterministic host-managed
 * destination. The dependency blob and final path never cross this module;
 * callers receive the same opaque metadata-only carrier as a local snapshot.
 */
export function executeStagedLocalCommitBody(input: {
  authority: StagedPhysicalDispatchAuthority;
}): ExecuteStagedLocalSnapshotBodyResult {
  const exact = exactStartedStagedBlobBody({
    authority: input.authority,
    stageKind: 'local_commit',
  });
  if (!exact) return { status: 'conflict', reason: 'local commit lacks its exact started physical authority' };
  if (enteredStagedBlobBodies.has(input.authority as object)) {
    return { status: 'conflict', reason: 'local commit body authority was already consumed' };
  }
  const materialization = exactLocalCommitMaterialization({
    db: openEventLog(),
    state: exact.state,
  });
  if (!materialization) {
    return { status: 'conflict', reason: 'local commit dependency owner no longer reopens' };
  }
  const providerBlob = plainRecord(exact.providerArgs.staged_blob)
    ? exact.providerArgs.staged_blob
    : null;
  if (
    !providerBlob
    || canonical(providerBlob) !== canonical(materialization.blob)
    || exact.providerArgs.destination_name !== materialization.destination.name
    || Object.keys(exact.providerArgs).sort().join('\0') !== 'destination_name\0staged_blob'
  ) return { status: 'conflict', reason: 'local commit compiler changed before execution' };

  enteredStagedBlobBodies.add(input.authority as object);
  try {
    const receipt = materializeStagedFileBlob({
      blob: {
        blobPath: stagedPublishedBlobPath(materialization.blob.sha256),
        sha256: materialization.blob.sha256,
        md5: materialization.blob.md5,
        byteCount: materialization.blob.byteCount,
      },
      destinationDirectory: materialization.destination.directory,
      destinationName: materialization.destination.name,
    });
    const committedDestination = exactLocalCommitMaterialization({
      db: openEventLog(),
      state: exact.state,
    });
    if (
      !committedDestination
      || committedDestination.destination.name !== materialization.destination.name
      || committedDestination.blob.sha256 !== receipt.sha256
      || committedDestination.blob.md5 !== receipt.md5
      || committedDestination.blob.byteCount !== receipt.byteCount
    ) throw new StagedFileBlobError('source_changed', 'local commit owner changed during materialization');
    return mintStagedBlobBodyResult({
      authority: input.authority,
      state: exact.state,
      stageKind: 'local_commit',
      blob: {
        blobPath: committedDestination.destination.materializedPath,
        sha256: receipt.sha256,
        md5: receipt.md5,
        byteCount: receipt.byteCount,
      },
    });
  } catch (error) {
    return { status: 'threw', code: stagedBlobBodyFailureCode(error) };
  }
}

/** Exact predicate for the checkpoint module's opaque carrier handoff. */
export function stagedBlobBodyResultOwnsCheckpoint(input: {
  authority: StagedPhysicalDispatchAuthority;
  result: StagedBlobBodyResult;
  sha256: string;
  md5: string;
  byteCount: number;
  bodyDigest: string;
  resultDigest: string;
}): boolean {
  const state = stagedBlobBodyResults.get(input.result as object);
  const started = state ? exactStartedStagedBlobBody({
    authority: input.authority,
    stageKind: state.stageKind,
  }) : null;
  return Boolean(
    state
    && started
    && started.state.stageAuthorityId === state.stageAuthorityId
    && started.state.authorityDigest === state.authorityDigest
    && state.authority === input.authority
    && state.blob.sha256 === input.sha256
    && state.blob.md5 === input.md5
    && state.blob.byteCount === input.byteCount
    && state.bodyDigest === input.bodyDigest
    && state.resultDigest === input.resultDigest
    && sha256(canonical(stagedBlobCheckpointPayload({
      stageKind: state.stageKind,
      bodyDigest: state.bodyDigest,
      blob: state.blob,
    }))) === state.resultDigest,
  );
}

export type CommitStagedBlobBodyResult =
  | {
      status: 'inserted' | 'replayed';
      sha256: string;
      md5: string;
      byteCount: number;
    }
  | { status: 'conflict' | 'storage_error'; reason: string };

function exactStagedBlobBodyResult(input: {
  authority: StagedPhysicalDispatchAuthority;
  result: StagedBlobBodyResult;
  sha256: string;
  md5: string;
  byteCount: number;
  bodyDigest: string;
  resultDigest: string;
}): {
  body: Readonly<StagedBlobBodyResultState>;
  state: Readonly<StagedPhysicalDispatchAuthorityState>;
} | null {
  const body = stagedBlobBodyResults.get(input.result as object);
  const state = physicalAuthorities.get(input.authority as object);
  if (
    !body
    || !state
    || body.authority !== input.authority
    || state.stageAuthorityId !== body.stageAuthorityId
    || state.stageKind !== body.stageKind
    || state.authorityDigest !== body.authorityDigest
    || state.providerArgumentDigest !== body.providerArgumentDigest
    || body.blob.sha256 !== input.sha256
    || body.blob.md5 !== input.md5
    || body.blob.byteCount !== input.byteCount
    || body.bodyDigest !== input.bodyDigest
    || body.resultDigest !== input.resultDigest
  ) return null;
  const expectedBlobPath = body.stageKind === 'local_commit'
    ? exactLocalCommitMaterialization({ db: openEventLog(), state })?.destination.materializedPath
    : stagedPublishedBlobPath(body.blob.sha256);
  if (!expectedBlobPath || body.blob.blobPath !== expectedBlobPath) return null;
  const expectedBodyDigest = digest({
    protocol: 'staged_blob_body_v1',
    stageAuthorityId: state.stageAuthorityId,
    stageAuthorityDigest: state.authorityDigest,
    providerArgumentDigest: state.providerArgumentDigest,
    stageKind: body.stageKind,
    blob: {
      sha256: body.blob.sha256,
      md5: body.blob.md5,
      byteCount: body.blob.byteCount,
    },
  });
  if (
    body.bodyDigest !== expectedBodyDigest
    || body.resultDigest !== sha256(canonical(stagedBlobCheckpointPayload({
      stageKind: body.stageKind,
      bodyDigest: body.bodyDigest,
      blob: body.blob,
    })))
  ) return null;
  return { body, state };
}

function exactReturnedStagedBlobReceipt(input: {
  db: Database.Database;
  state: Readonly<StagedPhysicalDispatchAuthorityState>;
  resultDigest: string;
}): { recordedAt: string } | null {
  const { state } = input;
  const row = input.db.prepare(`
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
       AND checkpoint.session_id = attempt.session_id
       AND checkpoint.source_user_seq = attempt.source_user_seq
       AND checkpoint.physical_dispatch_id = attempt.physical_dispatch_id
     WHERE attempt.stage_authority_id = ?
       AND attempt.plan_id = ? AND attempt.stage_id = ?
       AND attempt.session_id = ? AND attempt.source_user_seq = ?
       AND attempt.accepted_task_id = ?
       AND attempt.stage_ordinal = ? AND attempt.stage_kind = ?
       AND attempt.attempt_ordinal = ?
       AND attempt.logical_tool_call_id = ?
       AND attempt.physical_dispatch_id = ?
       AND attempt.tool_name = ?
       AND attempt.argument_digest = ?
       AND attempt.provider_argument_digest = ?
       AND attempt.lease_scope_id = ? AND attempt.lease_id = ?
       AND attempt.authority_digest = ?
       AND physical.state = 'returned'
       AND physical.staged_authority_digest = ?
       AND physical.provider_argument_digest = ?
       AND receipt.terminal_state = 'returned'
       AND receipt.result_digest = ?
       AND checkpoint.payload_plaintext_sha256 = ?
  `).get(
    state.stageAuthorityId,
    state.planId,
    state.stageId,
    state.sessionId,
    state.sourceUserSeq,
    state.acceptedTaskId,
    state.stageOrdinal,
    state.stageKind,
    state.attemptOrdinal,
    state.logicalToolCallId,
    state.physicalDispatchId,
    state.toolName,
    state.argumentDigest,
    state.providerArgumentDigest,
    state.lease.scopeId,
    state.lease.leaseId,
    state.authorityDigest,
    state.authorityDigest,
    state.providerArgumentDigest,
    input.resultDigest,
    input.resultDigest,
  ) as { recorded_at: string } | undefined;
  return row ? { recordedAt: row.recorded_at } : null;
}

function exactOrInsertStagedBlobOwner(input: {
  db: Database.Database;
  state: Readonly<StagedPhysicalDispatchAuthorityState>;
  sha256: string;
  md5: string;
  byteCount: number;
  resultDigest: string;
  replayConflictReason: string;
  missingReturnReason: string;
}): 'inserted' | 'replayed' {
  const returned = exactReturnedStagedBlobReceipt({
    db: input.db,
    state: input.state,
    resultDigest: input.resultDigest,
  });
  if (!returned) {
    throw new StagedTransferAuthorityError('conflict', input.missingReturnReason);
  }
  const existing = input.db.prepare(`
    SELECT blob_sha256, blob_md5, blob_bytes
      FROM staged_transfer_blob_owners
     WHERE plan_id = ? AND stage_id = ?
     ORDER BY blob_sha256
     LIMIT 2
  `).all(input.state.planId, input.state.stageId) as Array<{
    blob_sha256: string;
    blob_md5: string;
    blob_bytes: number;
  }>;
  if (existing.length > 0) {
    if (
      existing.length !== 1
      || existing[0]!.blob_sha256 !== input.sha256
      || existing[0]!.blob_md5 !== input.md5
      || existing[0]!.blob_bytes !== input.byteCount
    ) throw new StagedTransferAuthorityError('conflict', input.replayConflictReason);
    return 'replayed';
  }
  insertAdmittedStagedBlobOwner({
    db: input.db,
    planId: input.state.planId,
    stageId: input.state.stageId,
    sha256: input.sha256,
    md5: input.md5,
    byteCount: input.byteCount,
    createdAt: returned.recordedAt,
  });
  return 'inserted';
}

/**
 * Checkpoint-module edge for the local blob body. The caller must already be
 * inside the physical settlement IMMEDIATE transaction, after inserting the
 * exact return checkpoint and returned stage receipt. This avoids a crash
 * window in which the physical attempt is durably returned but its published
 * blob has no durable stage owner.
 *
 * The exported arguments are copy-safe metadata plus two process-opaque
 * carriers. The private WeakMap state remains the only authority to admit the
 * connection-local, tuple-exact blob-owner INSERT.
 */
export function insertStagedBlobOwnerForReturnCheckpointInTransaction(input: {
  db: Database.Database;
  authority: StagedPhysicalDispatchAuthority;
  result: StagedBlobBodyResult;
  sha256: string;
  md5: string;
  byteCount: number;
  bodyDigest: string;
  resultDigest: string;
}): void {
  if (input.db !== openEventLog() || !input.db.inTransaction) {
    throw new StagedTransferAuthorityError(
      'conflict',
      'staged blob owner requires the exact physical return transaction',
    );
  }
  const exact = exactStagedBlobBodyResult(input);
  if (!exact) {
    throw new StagedTransferAuthorityError('conflict', 'staged blob owner carrier is not exact');
  }
  const { body, state } = exact;
  exactOrInsertStagedBlobOwner({
    db: input.db,
    state,
    sha256: body.blob.sha256,
    md5: body.blob.md5,
    byteCount: body.blob.byteCount,
    resultDigest: body.resultDigest,
    replayConflictReason: 'staged blob owner replay differs',
    missingReturnReason: 'staged blob owner lacks its exact body return',
  });
}

/**
 * Append exactly one durable blob owner after the exact returned checkpoint
 * and stage receipt exist. The opaque body result is the only path from the
 * private published blob to this safe metadata row.
 */
export function commitStagedBlobBodyResult(input: {
  authority: StagedPhysicalDispatchAuthority;
  result: StagedBlobBodyResult;
}): CommitStagedBlobBodyResult {
  const body = stagedBlobBodyResults.get(input.result as object);
  const state = inspectStagedPhysicalDispatchAuthority(input.authority);
  if (
    !body
    || body.authority !== input.authority
    || !state
    || !state.terminalOnly
    || state.stageAuthorityId !== body.stageAuthorityId
    || state.stageKind !== body.stageKind
    || state.authorityDigest !== body.authorityDigest
    || state.providerArgumentDigest !== body.providerArgumentDigest
  ) return { status: 'conflict', reason: 'staged blob body no longer owns its exact returned authority' };
  try {
    const db = openEventLog();
    const transaction = db.transaction((): 'inserted' | 'replayed' => {
      const existing = db.prepare(`
        SELECT blob_sha256, blob_md5, blob_bytes
          FROM staged_transfer_blob_owners
         WHERE plan_id = ? AND stage_id = ?
         ORDER BY blob_sha256
         LIMIT 2
      `).all(state.planId, state.stageId) as Array<{
        blob_sha256: string;
        blob_md5: string;
        blob_bytes: number;
      }>;
      if (existing.length > 0) {
        if (
          existing.length !== 1
          || existing[0]!.blob_sha256 !== body.blob.sha256
          || existing[0]!.blob_md5 !== body.blob.md5
          || existing[0]!.blob_bytes !== body.blob.byteCount
        ) throw new StagedTransferAuthorityError('conflict', 'staged blob owner replay differs');
        return 'replayed';
      }
      insertStagedBlobOwnerForReturnCheckpointInTransaction({
        db,
        authority: input.authority,
        result: input.result,
        sha256: body.blob.sha256,
        md5: body.blob.md5,
        byteCount: body.blob.byteCount,
        bodyDigest: body.bodyDigest,
        resultDigest: body.resultDigest,
      });
      return 'inserted';
    });
    const status = transaction.immediate();
    return {
      status,
      sha256: body.blob.sha256,
      md5: body.blob.md5,
      byteCount: body.blob.byteCount,
    };
  } catch (error) {
    if (error instanceof StagedTransferAuthorityError) {
      return { status: error.code === 'storage_error' ? 'storage_error' : 'conflict', reason: error.message };
    }
    return { status: 'storage_error', reason: 'staged blob owner could not be committed' };
  }
}

type StagedDownloadBlobOwnerInput = {
  authority: StagedPhysicalDispatchAuthority;
  blob: CommittedStagedDownloadBlob;
  sha256: string;
  md5: string;
  byteCount: number;
  bodyDigest: string;
  resultDigest: string;
};

function exactStagedDownloadBlobOwner(input: StagedDownloadBlobOwnerInput): {
  state: Readonly<StagedPhysicalDispatchAuthorityState>;
  adopted: PublishedStagedFileBlob;
} | null {
  if (!committedStagedDownloadBlobOwns(input)) {
    return null;
  }
  const state = physicalAuthorities.get(input.authority as object);
  if (!state || state.stageKind !== 'download_transfer') return null;
  const adopted: PublishedStagedFileBlob = {
    blobPath: stagedPublishedBlobPath(input.sha256),
    sha256: input.sha256,
    md5: input.md5,
    byteCount: input.byteCount,
  };
  const priorAdoption = adoptedStagedDownloadBlobs.get(input.blob as object);
  if (priorAdoption && (
    priorAdoption.blobPath !== adopted.blobPath
    || priorAdoption.sha256 !== adopted.sha256
    || priorAdoption.md5 !== adopted.md5
    || priorAdoption.byteCount !== adopted.byteCount
  )) return null;
  adoptedStagedDownloadBlobs.set(input.blob as object, Object.freeze(adopted));
  return { state, adopted };
}

/**
 * Checkpoint-module edge for a completed one-GET download. Like the local
 * body sibling, it can run only inside the exact return transaction after the
 * checkpoint and receipt rows are visible. The URL, response bytes, and blob
 * path remain owned by opaque module state throughout.
 */
export function insertStagedDownloadBlobOwnerForReturnCheckpointInTransaction(
  input: StagedDownloadBlobOwnerInput & { db: Database.Database },
): void {
  if (input.db !== openEventLog() || !input.db.inTransaction) {
    throw new StagedTransferAuthorityError(
      'conflict',
      'download blob owner requires the exact physical return transaction',
    );
  }
  const exact = exactStagedDownloadBlobOwner(input);
  if (!exact) {
    throw new StagedTransferAuthorityError('conflict', 'download blob owner carrier is not exact');
  }
  exactOrInsertStagedBlobOwner({
    db: input.db,
    state: exact.state,
    sha256: exact.adopted.sha256,
    md5: exact.adopted.md5,
    byteCount: exact.adopted.byteCount,
    resultDigest: input.resultDigest,
    replayConflictReason: 'download blob owner replay differs',
    missingReturnReason: 'download blob owner lacks its exact body return',
  });
}

/**
 * Post-return compatibility/replay edge. New checkpoints commit the owner in
 * their physical-return transaction; this API can only observe that exact
 * owner or insert it for a checkpoint created by an older in-process caller.
 */
export function commitStagedDownloadBlobOwner(
  input: StagedDownloadBlobOwnerInput,
): CommitStagedBlobBodyResult {
  const terminal = inspectStagedPhysicalDispatchAuthority(input.authority);
  if (!terminal || !terminal.terminalOnly || terminal.stageKind !== 'download_transfer') {
    return { status: 'conflict', reason: 'download blob lacks its exact returned physical authority' };
  }
  const exact = exactStagedDownloadBlobOwner(input);
  if (!exact) {
    return { status: 'conflict', reason: 'download blob does not own the exact staged body' };
  }
  try {
    const db = openEventLog();
    const transaction = db.transaction((): 'inserted' | 'replayed' => {
      const existing = db.prepare(`
        SELECT blob_sha256, blob_md5, blob_bytes
          FROM staged_transfer_blob_owners
         WHERE plan_id = ? AND stage_id = ?
         ORDER BY blob_sha256
         LIMIT 2
      `).all(exact.state.planId, exact.state.stageId) as Array<{
        blob_sha256: string;
        blob_md5: string;
        blob_bytes: number;
      }>;
      if (existing.length > 0) {
        if (
          existing.length !== 1
          || existing[0]!.blob_sha256 !== input.sha256
          || existing[0]!.blob_md5 !== input.md5
          || existing[0]!.blob_bytes !== input.byteCount
        ) throw new StagedTransferAuthorityError('conflict', 'download blob owner replay differs');
        return 'replayed';
      }
      insertStagedDownloadBlobOwnerForReturnCheckpointInTransaction({
        db,
        authority: input.authority,
        blob: input.blob,
        sha256: input.sha256,
        md5: input.md5,
        byteCount: input.byteCount,
        bodyDigest: input.bodyDigest,
        resultDigest: input.resultDigest,
      });
      return 'inserted';
    });
    const status = transaction.immediate();
    return {
      status,
      sha256: input.sha256,
      md5: input.md5,
      byteCount: input.byteCount,
    };
  } catch (error) {
    if (error instanceof StagedTransferAuthorityError) {
      return { status: error.code === 'storage_error' ? 'storage_error' : 'conflict', reason: error.message };
    }
    return { status: 'storage_error', reason: 'download blob owner could not be committed' };
  }
}

/**
 * Final adapter edge for a staged provider body. The invocation arguments are
 * never returned as a durable/copyable authority object: the exact live token
 * is re-opened first, then the module lends a fresh closed-JSON copy only to
 * the synchronous body builder. Signed URLs and local paths therefore cannot
 * enter SQLite, events, errors, or model-visible prepared results through this
 * API.
 */
function withStagedPhysicalInvocationArguments<T>(input: {
  authority: StagedPhysicalDispatchAuthority;
  invoke: (toolName: string, providerArgs: Readonly<Record<string, unknown>>) => T;
}): T {
  const state = inspectStagedPhysicalDispatchAuthority(input.authority);
  const providerArgs = physicalInvocationArguments.get(input.authority as object);
  if (!state || state.terminalOnly || !providerArgs) {
    throw new StagedTransferAuthorityError('conflict', 'staged physical invocation authority no longer reopens');
  }
  const started = openEventLog().prepare(`
    SELECT 1 FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
       AND state = 'started' AND staged_authority_digest = ?
       AND provider_argument_digest = ?
  `).get(
    state.sessionId,
    state.sourceUserSeq,
    state.physicalDispatchId,
    state.authorityDigest,
    state.providerArgumentDigest,
  );
  if (!started) {
    throw new StagedTransferAuthorityError('conflict', 'staged physical invocation has no exact started reservation');
  }
  const exactDigest = sha256(canonical(providerArgs));
  if (exactDigest !== state.providerArgumentDigest) {
    throw new StagedTransferAuthorityError('conflict', 'staged physical invocation arguments changed');
  }
  return input.invoke(state.toolName, cloneProviderArgs(providerArgs as Record<string, unknown>));
}

/** Exact opaque descriptor carrier for the checkpoint-owned one-GET adapter.
 * It discloses no URL and is absent for every non-download stage. */
function stagedPhysicalDownloadAuthority(
  authority: StagedPhysicalDispatchAuthority,
): CommittedComposioDownloadAuthority | null {
  const state = inspectStagedPhysicalDispatchAuthority(authority);
  if (!state || state.terminalOnly || state.stageKind !== 'download_transfer') return null;
  const started = openEventLog().prepare(`
    SELECT 1 FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
       AND state = 'started' AND staged_authority_digest = ?
  `).get(state.sessionId, state.sourceUserSeq, state.physicalDispatchId, state.authorityDigest);
  if (!started) return null;
  const download = physicalDownloadAuthorities.get(authority as object);
  const inspected = download ? inspectCommittedComposioDownloadAuthority(download) : null;
  return inspected ? download! : null;
}
