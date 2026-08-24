/**
 * Durable, value-opaque capability authority for one foreground host call.
 *
 * The production host mints the in-process attestation. This module persists
 * that exact envelope only after the logical call exists and reopens it for
 * replay/terminal proof without importing the event-log runtime. Arguments
 * remain digests; the logical ledger owns the sole monotonic raw -> effective
 * refinement relationship.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import type { HostCallAttestation } from './accepted-turn-call-authority.js';
import {
  acceptedTurnCallAuthorityDigest,
  acceptedTurnCallSurfaceDigest,
  acceptedTurnSourceEventDigest,
} from './eventlog-schema.js';

export interface HostCallCapabilityBinding {
  protocolVersion: 1;
  rootAuthorityKind: 'host_v1';
  rootGraphEventId?: string;
  rootGraphHash?: string;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  sourceEventId: string;
  sourceEventDigest: string;
  logicalToolCallId: string;
  toolName: string;
  attestedArgumentDigest: string;
  logicalRawArgumentDigest: string;
  boundEffectiveArgumentDigest?: string;
  effectiveArgumentDigest: string;
  effect: HostCallAttestation['effect'];
  bindingKind: HostCallAttestation['bindingKind'];
  capabilityId: string;
  providerInputSchemaDigest?: string;
  schemaFingerprint: string;
  accountId: string;
  invokePortId: string;
  operationId: string;
  manifestId: string;
  manifestDigest: string;
  hostBindingDigest: string;
  engineVersion: string;
  surfaceVersion: string;
  authorityDigest: string;
  authorityRevision: number;
  surfaceDigest: string;
  catalogRevisionDigest: string;
  bindingRevisionDigest: string;
  durableBindingDigest: string;
  boundAt: string;
}

export type HostCallCapabilityBindingReadResult =
  | { status: 'ok'; binding: HostCallCapabilityBinding }
  | { status: 'missing' | 'conflict' | 'storage_error'; reason: string };

export type HostCallCapabilityBindingAdmissionResult =
  | { status: 'bound' | 'replayed'; binding: HostCallCapabilityBinding }
  | { status: 'not_applicable' }
  | { status: 'conflict' | 'storage_error'; reason: string };

interface BindingRow {
  protocol_version: number;
  root_authority_kind: 'host_v1';
  root_graph_event_id: string | null;
  root_graph_hash: string | null;
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  source_event_id: string;
  source_event_digest: string;
  logical_tool_call_id: string;
  tool_name: string;
  attested_argument_digest: string;
  logical_raw_argument_digest: string;
  bound_effective_argument_digest: string | null;
  effect: HostCallAttestation['effect'];
  binding_kind: HostCallAttestation['bindingKind'];
  capability_id: string;
  provider_input_schema_digest: string | null;
  schema_fingerprint: string;
  account_id: string;
  invoke_port_id: string;
  operation_id: string;
  manifest_id: string;
  manifest_digest: string;
  host_binding_digest: string;
  engine_version: string;
  surface_version: string;
  authority_digest: string;
  authority_revision: number;
  surface_digest: string;
  catalog_revision_digest: string;
  binding_revision_digest: string;
  durable_binding_digest: string;
  bound_at: string;
}

interface RootRow {
  accepted_task_id: string;
  authority_protocol: number;
  authority_kind: string;
  source_event_id: string;
  source_event_digest: string;
  source_turn: number;
  engine_version: string;
  surface_version: string;
  surface_digest: string;
  effect_ceiling: string;
  effect_bounds_json: string;
  max_logical_calls: number | null;
  max_parallel_calls: number | null;
  catalog_revision_digest: string | null;
  binding_revision_digest: string | null;
  graph_event_id: string | null;
  graph_hash: string | null;
  authority_digest: string;
  state: string;
  revision: number;
}

interface LogicalRow {
  accepted_task_id: string;
  tool_name: string;
  argument_digest: string;
  raw_argument_digest: string;
  effective_argument_digest: string | null;
  state: string;
}

interface SourceRow {
  id: string;
  session_id: string;
  seq: number;
  turn: number;
  role: string;
  type: string;
  parent_event_id: string | null;
  data_json: string;
  created_at: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const EFFECTS = new Set(['admin', 'compute', 'external_write', 'host_only', 'local_write', 'read']);

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').trim().slice(0, 240);
}

function safeIdentity(value: string, max = 512): boolean {
  return value === value.trim() && value.length > 0 && value.length <= max;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Same closed encoder used by the production host when it mints bindingDigest. */
export function hostCallAttestationBindingDigest(
  input: Pick<HostCallAttestation,
    | 'bindingKind' | 'capabilityId' | 'providerInputSchemaDigest'
    | 'schemaFingerprint' | 'accountId' | 'invokePortId' | 'operationId'
    | 'manifestId' | 'manifestDigest' | 'effect'>,
): string {
  return sha256(closedCanonicalJson({
    version: 1,
    bindingKind: input.bindingKind,
    capabilityId: input.capabilityId,
    ...(input.providerInputSchemaDigest
      ? { providerInputSchemaDigest: input.providerInputSchemaDigest }
      : {}),
    schemaFingerprint: input.schemaFingerprint,
    accountId: input.accountId,
    invokePortId: input.invokePortId,
    operationId: input.operationId,
    manifestId: input.manifestId,
    manifestDigest: input.manifestDigest,
    effect: input.effect,
  }));
}

type DurableDigestInput = Omit<HostCallCapabilityBinding,
  'effectiveArgumentDigest' | 'durableBindingDigest' | 'boundAt'>;

export function hostCallCapabilityBindingDigest(input: DurableDigestInput): string {
  return sha256(closedCanonicalJson({
    protocolVersion: 1,
    rootAuthorityKind: input.rootAuthorityKind,
    rootGraphEventId: input.rootGraphEventId ?? null,
    rootGraphHash: input.rootGraphHash ?? null,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    sourceEventId: input.sourceEventId,
    sourceEventDigest: input.sourceEventDigest,
    logicalToolCallId: input.logicalToolCallId,
    toolName: input.toolName,
    attestedArgumentDigest: input.attestedArgumentDigest,
    logicalRawArgumentDigest: input.logicalRawArgumentDigest,
    boundEffectiveArgumentDigest: input.boundEffectiveArgumentDigest ?? null,
    effect: input.effect,
    bindingKind: input.bindingKind,
    capabilityId: input.capabilityId,
    providerInputSchemaDigest: input.providerInputSchemaDigest ?? null,
    schemaFingerprint: input.schemaFingerprint,
    accountId: input.accountId,
    invokePortId: input.invokePortId,
    operationId: input.operationId,
    manifestId: input.manifestId,
    manifestDigest: input.manifestDigest,
    hostBindingDigest: input.hostBindingDigest,
    engineVersion: input.engineVersion,
    surfaceVersion: input.surfaceVersion,
    authorityDigest: input.authorityDigest,
    authorityRevision: input.authorityRevision,
    surfaceDigest: input.surfaceDigest,
    catalogRevisionDigest: input.catalogRevisionDigest,
    bindingRevisionDigest: input.bindingRevisionDigest,
  }));
}

function attestationIsExact(attestation: HostCallAttestation): boolean {
  const catalog = attestation.bindingKind === 'catalog_manifest';
  return safeIdentity(attestation.sessionId)
    && Number.isSafeInteger(attestation.sourceUserSeq)
    && attestation.sourceUserSeq > 0
    && attestation.acceptedTaskId === `task:${attestation.sessionId}#${attestation.sourceUserSeq}`
    && safeIdentity(attestation.sourceEventId)
    && SHA256.test(attestation.sourceEventDigest)
    && safeIdentity(attestation.logicalToolCallId)
    && safeIdentity(attestation.toolName)
    && SHA256.test(attestation.argumentDigest)
    && EFFECTS.has(attestation.effect)
    && safeIdentity(attestation.capabilityId)
    && SHA256.test(attestation.schemaFingerprint)
    && safeIdentity(attestation.invokePortId)
    && safeIdentity(attestation.operationId)
    && SHA256.test(attestation.bindingDigest)
    && safeIdentity(attestation.engineVersion, 128)
    && safeIdentity(attestation.surfaceVersion, 128)
    && SHA256.test(attestation.authorityDigest)
    && Number.isSafeInteger(attestation.authorityRevision)
    && attestation.authorityRevision >= 0
    && SHA256.test(attestation.surfaceDigest)
    && SHA256.test(attestation.catalogRevisionDigest)
    && SHA256.test(attestation.bindingRevisionDigest)
    && (catalog
      ? safeIdentity(attestation.accountId)
        && safeIdentity(attestation.manifestId)
        && SHA256.test(attestation.manifestDigest)
        && (attestation.providerInputSchemaDigest === undefined
          || SHA256.test(attestation.providerInputSchemaDigest))
      : attestation.accountId === ''
        && attestation.manifestId === ''
        && attestation.manifestDigest === ''
        && attestation.providerInputSchemaDigest === undefined)
    && hostCallAttestationBindingDigest(attestation) === attestation.bindingDigest;
}

function rootRow(db: Database.Database, sessionId: string, sourceUserSeq: number): RootRow | undefined {
  return db.prepare(`
    SELECT accepted_task_id, authority_protocol, authority_kind, source_event_id,
           source_event_digest, source_turn, engine_version, surface_version,
           surface_digest, effect_ceiling, effect_bounds_json, max_logical_calls,
           max_parallel_calls, catalog_revision_digest, binding_revision_digest,
           graph_event_id, graph_hash, authority_digest, state, revision
      FROM accepted_turn_call_authorities
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, sourceUserSeq) as RootRow | undefined;
}

function logicalRow(
  db: Database.Database,
  sessionId: string,
  sourceUserSeq: number,
  logicalToolCallId: string,
): LogicalRow | undefined {
  return db.prepare(`
    SELECT accepted_task_id, tool_name, argument_digest, raw_argument_digest,
           effective_argument_digest, state
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(sessionId, sourceUserSeq, logicalToolCallId) as LogicalRow | undefined;
}

function rootIsCryptographicallyExact(
  db: Database.Database,
  sessionId: string,
  sourceUserSeq: number,
  root: RootRow,
): boolean {
  if (root.authority_kind !== 'host_v1') return false;
  if (
    root.graph_event_id !== null
    || root.graph_hash !== null
  ) return false;
  const source = db.prepare(`
    SELECT id, session_id, seq, turn, role, type, parent_event_id, data_json, created_at
      FROM events WHERE id = ?
  `).get(root.source_event_id) as SourceRow | undefined;
  if (
    !source
    || source.session_id !== sessionId
    || source.seq !== sourceUserSeq
    || source.turn !== root.source_turn
    || source.role !== 'user'
    || source.type !== 'user_input_received'
  ) return false;
  const sourceDigest = acceptedTurnSourceEventDigest({
    id: source.id,
    sessionId: source.session_id,
    seq: source.seq,
    turn: source.turn,
    role: source.role,
    type: source.type,
    parentEventId: source.parent_event_id,
    dataJson: source.data_json,
    createdAt: source.created_at,
  });
  if (sourceDigest !== root.source_event_digest) return false;
  const surfaceDigest = acceptedTurnCallSurfaceDigest({
    authorityKind: root.authority_kind,
    engineVersion: root.engine_version,
    surfaceVersion: root.surface_version,
    effectCeiling: root.effect_ceiling,
    effectBoundsJson: root.effect_bounds_json,
    maxLogicalCalls: root.max_logical_calls,
    maxParallelCalls: root.max_parallel_calls,
    catalogRevisionDigest: root.catalog_revision_digest,
    bindingRevisionDigest: root.binding_revision_digest,
    graphEventId: root.graph_event_id,
    graphHash: root.graph_hash,
  });
  if (surfaceDigest !== root.surface_digest) return false;
  return acceptedTurnCallAuthorityDigest({
    authorityKind: root.authority_kind,
    sessionId,
    sourceUserSeq,
    acceptedTaskId: root.accepted_task_id,
    sourceEventId: root.source_event_id,
    sourceEventDigest: root.source_event_digest,
    sourceTurn: root.source_turn,
    engineVersion: root.engine_version,
    surfaceVersion: root.surface_version,
    surfaceDigest: root.surface_digest,
    effectCeiling: root.effect_ceiling,
    effectBoundsJson: root.effect_bounds_json,
    maxLogicalCalls: root.max_logical_calls,
    maxParallelCalls: root.max_parallel_calls,
    catalogRevisionDigest: root.catalog_revision_digest,
    bindingRevisionDigest: root.binding_revision_digest,
    graphEventId: root.graph_event_id,
    graphHash: root.graph_hash,
  }) === root.authority_digest;
}

function rowToBinding(row: BindingRow, effectiveArgumentDigest: string): HostCallCapabilityBinding {
  return {
    protocolVersion: 1,
    rootAuthorityKind: row.root_authority_kind,
    ...(row.root_graph_event_id ? { rootGraphEventId: row.root_graph_event_id } : {}),
    ...(row.root_graph_hash ? { rootGraphHash: row.root_graph_hash } : {}),
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    acceptedTaskId: row.accepted_task_id,
    sourceEventId: row.source_event_id,
    sourceEventDigest: row.source_event_digest,
    logicalToolCallId: row.logical_tool_call_id,
    toolName: row.tool_name,
    attestedArgumentDigest: row.attested_argument_digest,
    logicalRawArgumentDigest: row.logical_raw_argument_digest,
    ...(row.bound_effective_argument_digest
      ? { boundEffectiveArgumentDigest: row.bound_effective_argument_digest }
      : {}),
    effectiveArgumentDigest,
    effect: row.effect,
    bindingKind: row.binding_kind,
    capabilityId: row.capability_id,
    ...(row.provider_input_schema_digest
      ? { providerInputSchemaDigest: row.provider_input_schema_digest }
      : {}),
    schemaFingerprint: row.schema_fingerprint,
    accountId: row.account_id,
    invokePortId: row.invoke_port_id,
    operationId: row.operation_id,
    manifestId: row.manifest_id,
    manifestDigest: row.manifest_digest,
    hostBindingDigest: row.host_binding_digest,
    engineVersion: row.engine_version,
    surfaceVersion: row.surface_version,
    authorityDigest: row.authority_digest,
    authorityRevision: row.authority_revision,
    surfaceDigest: row.surface_digest,
    catalogRevisionDigest: row.catalog_revision_digest,
    bindingRevisionDigest: row.binding_revision_digest,
    durableBindingDigest: row.durable_binding_digest,
    boundAt: row.bound_at,
  };
}

function durableFields(binding: HostCallCapabilityBinding): DurableDigestInput {
  const {
    effectiveArgumentDigest: _effectiveArgumentDigest,
    durableBindingDigest: _durableBindingDigest,
    boundAt: _boundAt,
    ...fields
  } = binding;
  return fields;
}

/** Reopen and independently verify the exact durable host capability row. */
export function loadHostCallCapabilityBinding(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
}): HostCallCapabilityBindingReadResult {
  try {
    const row = input.db.prepare(`
      SELECT * FROM host_call_capability_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as BindingRow | undefined;
    if (!row) return { status: 'missing', reason: 'durable host-call capability binding is missing' };
    const root = rootRow(input.db, input.sessionId, input.sourceUserSeq);
    const logical = logicalRow(input.db, input.sessionId, input.sourceUserSeq, input.logicalToolCallId);
    if (
      row.protocol_version !== 1
      || row.session_id !== input.sessionId
      || row.source_user_seq !== input.sourceUserSeq
      || !root
      || root.authority_protocol !== 1
      || root.authority_kind !== 'host_v1'
      || root.state === 'conflict'
      || !rootIsCryptographicallyExact(input.db, input.sessionId, input.sourceUserSeq, root)
      || !logical
      || logical.state === 'conflict'
      || row.accepted_task_id !== root.accepted_task_id
      || row.accepted_task_id !== logical.accepted_task_id
      || row.source_event_id !== root.source_event_id
      || row.source_event_digest !== root.source_event_digest
      || row.root_authority_kind !== root.authority_kind
      || row.root_graph_event_id !== root.graph_event_id
      || row.root_graph_hash !== root.graph_hash
      || row.tool_name !== logical.tool_name
      || row.logical_raw_argument_digest !== logical.raw_argument_digest
      || row.attested_argument_digest !== (
        row.bound_effective_argument_digest ?? row.logical_raw_argument_digest
      )
      || (row.bound_effective_argument_digest !== null
        && logical.effective_argument_digest !== row.bound_effective_argument_digest)
      || (logical.effective_argument_digest === null
        ? logical.argument_digest !== logical.raw_argument_digest
        : logical.argument_digest !== logical.effective_argument_digest
          || logical.effective_argument_digest === logical.raw_argument_digest)
      || row.engine_version !== root.engine_version
      || row.surface_version !== root.surface_version
      || row.authority_digest !== root.authority_digest
      || row.authority_revision > root.revision
      || row.surface_digest !== root.surface_digest
      || row.catalog_revision_digest !== root.catalog_revision_digest
      || row.binding_revision_digest !== root.binding_revision_digest
      || !SHA256.test(row.host_binding_digest)
      || !SHA256.test(row.durable_binding_digest)
    ) return { status: 'conflict', reason: 'durable host-call capability binding conflicts with its root or logical call' };
    const binding = rowToBinding(row, logical.argument_digest);
    if (
      !attestationIsExact({
        sessionId: binding.sessionId,
        sourceUserSeq: binding.sourceUserSeq,
        acceptedTaskId: binding.acceptedTaskId,
        sourceEventId: binding.sourceEventId,
        sourceEventDigest: binding.sourceEventDigest,
        logicalToolCallId: binding.logicalToolCallId,
        toolName: binding.toolName,
        argumentDigest: binding.attestedArgumentDigest,
        effect: binding.effect,
        bindingKind: binding.bindingKind,
        capabilityId: binding.capabilityId,
        ...(binding.providerInputSchemaDigest
          ? { providerInputSchemaDigest: binding.providerInputSchemaDigest }
          : {}),
        schemaFingerprint: binding.schemaFingerprint,
        accountId: binding.accountId,
        invokePortId: binding.invokePortId,
        operationId: binding.operationId,
        manifestId: binding.manifestId,
        manifestDigest: binding.manifestDigest,
        bindingDigest: binding.hostBindingDigest,
        engineVersion: binding.engineVersion,
        surfaceVersion: binding.surfaceVersion,
        authorityDigest: binding.authorityDigest,
        authorityRevision: binding.authorityRevision,
        surfaceDigest: binding.surfaceDigest,
        catalogRevisionDigest: binding.catalogRevisionDigest,
        bindingRevisionDigest: binding.bindingRevisionDigest,
      })
      || hostCallCapabilityBindingDigest(durableFields(binding)) !== binding.durableBindingDigest
    ) return { status: 'conflict', reason: 'durable host-call capability binding digest is invalid' };
    return { status: 'ok', binding };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export function hostCallCapabilityBindingMatchesAttestation(
  binding: HostCallCapabilityBinding,
  attestation: HostCallAttestation,
): boolean {
  return attestationIsExact(attestation)
    && binding.sessionId === attestation.sessionId
    && binding.sourceUserSeq === attestation.sourceUserSeq
    && binding.acceptedTaskId === attestation.acceptedTaskId
    && binding.sourceEventId === attestation.sourceEventId
    && binding.sourceEventDigest === attestation.sourceEventDigest
    && binding.logicalToolCallId === attestation.logicalToolCallId
    && binding.toolName === attestation.toolName
    && binding.attestedArgumentDigest === attestation.argumentDigest
    && binding.effect === attestation.effect
    && binding.bindingKind === attestation.bindingKind
    && binding.capabilityId === attestation.capabilityId
    && (binding.providerInputSchemaDigest ?? null) === (attestation.providerInputSchemaDigest ?? null)
    && binding.schemaFingerprint === attestation.schemaFingerprint
    && binding.accountId === attestation.accountId
    && binding.invokePortId === attestation.invokePortId
    && binding.operationId === attestation.operationId
    && binding.manifestId === attestation.manifestId
    && binding.manifestDigest === attestation.manifestDigest
    && binding.hostBindingDigest === attestation.bindingDigest
    && binding.engineVersion === attestation.engineVersion
    && binding.surfaceVersion === attestation.surfaceVersion
    && binding.authorityDigest === attestation.authorityDigest
    && binding.authorityRevision === attestation.authorityRevision
    && binding.surfaceDigest === attestation.surfaceDigest
    && binding.catalogRevisionDigest === attestation.catalogRevisionDigest
    && binding.bindingRevisionDigest === attestation.bindingRevisionDigest;
}

function exactExpectedCall(input: {
  binding: HostCallCapabilityBinding;
  acceptedTaskId: string;
  toolName: string;
  argumentDigest: string;
  effect: HostCallAttestation['effect'];
}): boolean {
  return input.binding.acceptedTaskId === input.acceptedTaskId
    && input.binding.toolName === input.toolName
    // Replay re-presents the host envelope, whose digest is deliberately the
    // attested/raw side. Terminal proof separately consumes the logical
    // ledger's current effective digest after an authorized one-shot refine.
    && input.binding.attestedArgumentDigest === input.argumentDigest
    && input.binding.effect === input.effect;
}

/**
 * Persist at the first post-logical-admission instruction. A production-host
 * call under host_v1 must have the exact module-minted attestation. A
 * turn_graph root belongs to the typed executor and is an ownership conflict,
 * not a host-call compatibility lane.
 */
export function persistHostCallCapabilityBinding(input: {
  db: Database.Database;
  attestation?: Readonly<HostCallAttestation>;
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
  acceptedTaskId: string;
  toolName: string;
  argumentDigest: string;
  effect: HostCallAttestation['effect'];
}): HostCallCapabilityBindingAdmissionResult {
  try {
    const transact = input.db.transaction((): HostCallCapabilityBindingAdmissionResult => {
      const root = rootRow(input.db, input.sessionId, input.sourceUserSeq);
      if (!root) return { status: 'conflict', reason: 'accepted call root is missing' };
      if (root.authority_kind !== 'host_v1') {
        if (root.authority_kind === 'turn_graph') {
          return { status: 'conflict', reason: 'turn-graph call cannot cross through the production host executor' };
        }
        return input.attestation
          ? { status: 'conflict', reason: 'host attestation cannot bind this accepted root kind' }
          : { status: 'not_applicable' };
      }
      const attestation = input.attestation;
      if (!attestation || !attestationIsExact(attestation)) {
        return { status: 'conflict', reason: 'host-executed logical call lacks its exact module attestation' };
      }
      const existing = loadHostCallCapabilityBinding({
        db: input.db,
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        logicalToolCallId: input.logicalToolCallId,
      });
      if (existing.status === 'ok') {
        return hostCallCapabilityBindingMatchesAttestation(existing.binding, attestation)
          && exactExpectedCall({ binding: existing.binding, ...input })
          ? { status: 'replayed', binding: existing.binding }
          : { status: 'conflict', reason: 'existing host-call capability binding conflicts with this invocation' };
      }
      if (existing.status === 'conflict') return { status: 'conflict', reason: existing.reason };
      if (existing.status === 'storage_error') return { status: 'storage_error', reason: existing.reason };
      const logical = logicalRow(input.db, input.sessionId, input.sourceUserSeq, input.logicalToolCallId);
      if (
        root.state !== 'open'
        || !rootIsCryptographicallyExact(input.db, input.sessionId, input.sourceUserSeq, root)
        || root.accepted_task_id !== input.acceptedTaskId
        || !logical
        || logical.state !== 'open'
        || logical.accepted_task_id !== input.acceptedTaskId
        || logical.tool_name !== input.toolName
        || logical.argument_digest !== input.argumentDigest
        || attestation.sessionId !== input.sessionId
        || attestation.sourceUserSeq !== input.sourceUserSeq
        || attestation.acceptedTaskId !== input.acceptedTaskId
        || attestation.logicalToolCallId !== input.logicalToolCallId
        || attestation.toolName !== input.toolName
        || attestation.argumentDigest !== input.argumentDigest
        || attestation.effect !== input.effect
        || attestation.sourceEventId !== root.source_event_id
        || attestation.sourceEventDigest !== root.source_event_digest
        || attestation.engineVersion !== root.engine_version
        || attestation.surfaceVersion !== root.surface_version
        || attestation.authorityDigest !== root.authority_digest
        || attestation.authorityRevision !== root.revision
        || attestation.surfaceDigest !== root.surface_digest
        || attestation.catalogRevisionDigest !== root.catalog_revision_digest
        || attestation.bindingRevisionDigest !== root.binding_revision_digest
      ) return { status: 'conflict', reason: 'host attestation does not match the admitted logical call and root' };
      const durable: DurableDigestInput = {
        protocolVersion: 1,
        rootAuthorityKind: 'host_v1',
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: input.acceptedTaskId,
        sourceEventId: attestation.sourceEventId,
        sourceEventDigest: attestation.sourceEventDigest,
        logicalToolCallId: input.logicalToolCallId,
        toolName: input.toolName,
        attestedArgumentDigest: attestation.argumentDigest,
        logicalRawArgumentDigest: logical.raw_argument_digest,
        ...(logical.effective_argument_digest
          ? { boundEffectiveArgumentDigest: logical.effective_argument_digest }
          : {}),
        effect: attestation.effect,
        bindingKind: attestation.bindingKind,
        capabilityId: attestation.capabilityId,
        ...(attestation.providerInputSchemaDigest
          ? { providerInputSchemaDigest: attestation.providerInputSchemaDigest }
          : {}),
        schemaFingerprint: attestation.schemaFingerprint,
        accountId: attestation.accountId,
        invokePortId: attestation.invokePortId,
        operationId: attestation.operationId,
        manifestId: attestation.manifestId,
        manifestDigest: attestation.manifestDigest,
        hostBindingDigest: attestation.bindingDigest,
        engineVersion: attestation.engineVersion,
        surfaceVersion: attestation.surfaceVersion,
        authorityDigest: attestation.authorityDigest,
        authorityRevision: attestation.authorityRevision,
        surfaceDigest: attestation.surfaceDigest,
        catalogRevisionDigest: attestation.catalogRevisionDigest,
        bindingRevisionDigest: attestation.bindingRevisionDigest,
      };
      const durableBindingDigest = hostCallCapabilityBindingDigest(durable);
      input.db.prepare(`
        INSERT INTO host_call_capability_bindings (
          protocol_version, root_authority_kind, root_graph_event_id,
          root_graph_hash, session_id, source_user_seq, accepted_task_id,
          source_event_id, source_event_digest, logical_tool_call_id, tool_name,
          attested_argument_digest, logical_raw_argument_digest,
          bound_effective_argument_digest, effect, binding_kind, capability_id,
          provider_input_schema_digest, schema_fingerprint, account_id,
          invoke_port_id, operation_id, manifest_id, manifest_digest,
          host_binding_digest, engine_version, surface_version, authority_digest,
          authority_revision, surface_digest, catalog_revision_digest,
          binding_revision_digest, durable_binding_digest, bound_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        durable.rootAuthorityKind,
        durable.rootGraphEventId ?? null,
        durable.rootGraphHash ?? null,
        durable.sessionId,
        durable.sourceUserSeq,
        durable.acceptedTaskId,
        durable.sourceEventId,
        durable.sourceEventDigest,
        durable.logicalToolCallId,
        durable.toolName,
        durable.attestedArgumentDigest,
        durable.logicalRawArgumentDigest,
        durable.boundEffectiveArgumentDigest ?? null,
        durable.effect,
        durable.bindingKind,
        durable.capabilityId,
        durable.providerInputSchemaDigest ?? null,
        durable.schemaFingerprint,
        durable.accountId,
        durable.invokePortId,
        durable.operationId,
        durable.manifestId,
        durable.manifestDigest,
        durable.hostBindingDigest,
        durable.engineVersion,
        durable.surfaceVersion,
        durable.authorityDigest,
        durable.authorityRevision,
        durable.surfaceDigest,
        durable.catalogRevisionDigest,
        durable.bindingRevisionDigest,
        durableBindingDigest,
        new Date().toISOString(),
      );
      const loaded = loadHostCallCapabilityBinding({
        db: input.db,
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        logicalToolCallId: input.logicalToolCallId,
      });
      if (loaded.status !== 'ok' || !hostCallCapabilityBindingMatchesAttestation(loaded.binding, attestation)) {
        throw new Error(loaded.status === 'ok' ? 'inserted binding changed' : loaded.reason);
      }
      return { status: 'bound', binding: loaded.binding };
    });
    // Own serialization before any child lease/body can exist. The exact
    // concurrent winner is reopened as replay; a different envelope conflicts.
    return transact.immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

/** Settled replay cannot adopt bytes under a different or missing host envelope. */
export function verifyHostCallCapabilityBindingForReplay(input: {
  db: Database.Database;
  attestation?: Readonly<HostCallAttestation>;
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
  acceptedTaskId: string;
  toolName: string;
  argumentDigest: string;
  effect: HostCallAttestation['effect'];
}): HostCallCapabilityBindingAdmissionResult {
  try {
    const root = rootRow(input.db, input.sessionId, input.sourceUserSeq);
    if (!root) return { status: 'conflict', reason: 'accepted call root is missing on replay' };
    if (root.authority_kind !== 'host_v1') {
      if (root.authority_kind === 'turn_graph') {
        return { status: 'conflict', reason: 'turn-graph call cannot replay through the production host executor' };
      }
      return input.attestation
        ? { status: 'conflict', reason: 'host attestation cannot replay this accepted root kind' }
        : { status: 'not_applicable' };
    }
    if (!input.attestation) return { status: 'conflict', reason: 'host-executed replay lacks its current module attestation' };
    const loaded = loadHostCallCapabilityBinding(input);
    if (loaded.status !== 'ok') return loaded.status === 'storage_error'
      ? { status: 'storage_error', reason: loaded.reason }
      : { status: 'conflict', reason: loaded.reason };
    if (
      !hostCallCapabilityBindingMatchesAttestation(loaded.binding, input.attestation)
      || !exactExpectedCall({ binding: loaded.binding, ...input })
    ) return { status: 'conflict', reason: 'settled replay conflicts with its durable host-call capability binding' };
    return { status: 'replayed', binding: loaded.binding };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}
