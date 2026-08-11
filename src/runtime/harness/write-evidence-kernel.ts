/**
 * Pure normalized proof for write obligations.
 *
 * This module deliberately has no event-log access and no tool taxonomy. It
 * consumes facts which a durable authority loader has already selected for one
 * accepted task, then checks that their identities and bytes agree. Provider
 * names, callable slugs, prose, and caller-supplied `matched` booleans have no
 * role in the verdict.
 *
 * The result is proof material, not persistence. A later schema/wiring slice
 * must load these inputs from normalized rows and persist the returned proof in
 * the same transaction as obligation satisfaction.
 */
import { createHash } from 'node:crypto';

import { providerRequestEchoKey } from './provider-read-evidence.js';
import { deriveResultHandleFactsFromRaw } from './result-facts.js';

export const WRITE_EVIDENCE_PROTOCOL_VERSION = 1 as const;

export type WriteEvidenceObligation =
  | 'derivation_from_current_source'
  | 'commit_effect'
  | 'verify_committed_readback'
  | 'stale_destination_reconciled'
  | 'verify_committed_receipt'
  | 'execution_terminal';

export type WriteEvidenceEffect = 'external_write' | 'admin';
export type WriteEvidenceReversibility = 'reversible' | 'irreversible';

export interface ExactProjectionFieldV1 {
  /** Opaque semantic slot fixed by the host mapping, not a provider field. */
  id: string;
  /** RFC 6901 pointer relative to one selected record. */
  valuePointer: string;
}

export interface ExactRecordProjectionV1 {
  shape: 'record' | 'set';
  /** RFC 6901 pointer from the source root to one record or a record array. */
  recordsPointer: string;
  /** Required for a set so duplicate identities cannot disappear in sorting. */
  identityField: string | null;
  fields: ExactProjectionFieldV1[];
}

export type WriteVerificationContractV1 =
  | {
      kind: 'reversible_exact_v1';
      expected: ExactRecordProjectionV1;
      observed: ExactRecordProjectionV1;
      /** Only an exact-destination observation can prove stale content absent. */
      observedCoverage: 'selected_records' | 'exact_destination';
    }
  | {
      kind: 'irreversible_receipt_v1';
      /** Non-root RFC 6901 pointer into exact provider-returned bytes. */
      receiptPointer: string;
    }
  | {
      /** Explicit fail-closed state while a host mapping is unavailable. */
      kind: 'unavailable';
    };

export interface WriteEvidenceBindingBodyV1 {
  protocolVersion: typeof WRITE_EVIDENCE_PROTOCOL_VERSION;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  workContractId: string;
  requirementId: string;
  logicalToolCallId: string;
  effect: WriteEvidenceEffect;
  reversibility: WriteEvidenceReversibility;
  /** Digests are value-opaque and are derived before provider dispatch. */
  targetDigest: string;
  argumentDigest: string;
  writeInputDigest: string;
  /** Exact host-observed callable schema and target selector content addresses. */
  schemaDigest: string;
  targetSelectorDigest: string;
  sourceRequirementIds: string[];
  verification: WriteVerificationContractV1;
}

export interface FrozenWriteEvidenceBindingV1 extends WriteEvidenceBindingBodyV1 {
  /** Content address of every field above. */
  bindingId: string;
}

/**
 * Manifest identity is deliberately NOT part of the pre-dispatch binding.
 * The authoritative manifest does not exist until resolution closes, while
 * selectors and projections must be frozen before a provider crossing.  This
 * later scope is derived from that closed manifest and is covered by every
 * proof receipt without rewriting the earlier binding.
 */
export interface WriteEvidenceManifestScopeV1 {
  manifestId: string;
  nodeId: string;
  obligations: WriteEvidenceObligation[];
}

export interface PhysicalCrossingFact {
  physicalDispatchId: string;
  ordinal: number;
  state: 'started' | 'returned' | 'threw' | 'timed_out' | 'cancelled' | 'unknown';
}

export interface LogicalSettlementFact {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  argumentDigest: string;
  executionKind: 'refused_pre_dispatch' | 'local_execution' | 'provider_execution';
  outcomeKind: string;
  resultHandleId?: string;
  crossings: PhysicalCrossingFact[];
}

export interface BoundRawResultFact {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  physicalDispatchId: string;
  resultHandleId: string;
  /** Exact stored JSON bytes, not a model-facing projection. */
  rawPayloadJson: string;
  rawPayloadSha256: string;
  rawByteCount: number;
}

interface WriteLifecycleIdentity {
  eventId: string;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  physicalDispatchId: string;
  targetDigest: string;
  writeInputDigest: string;
}

export type WriteLifecycleFact =
  | (WriteLifecycleIdentity & { kind: 'reservation' })
  | (WriteLifecycleIdentity & {
      kind: 'succeeded' | 'failed' | 'orphaned';
      reservationEventId: string;
      resultHandleId?: string;
    });

export interface ReadbackEvidenceFact {
  /** Host-derived from the read arguments under the frozen target selector. */
  targetDigest: string;
  verificationContractId: string;
  writeLogicalToolCallId: string;
  settlement: LogicalSettlementFact;
  result: BoundRawResultFact;
}

export interface HostDerivationFact {
  kind: 'host_deterministic_transform';
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  workContractId: string;
  requirementId: string;
  sourceEvidence: Array<{
    requirementId: string;
    receiptId: string;
    contentDigest: string;
  }>;
  /** Digest of the exact write input produced by the transform. */
  outputDigest: string;
  /** Content address of the host-owned transform implementation/config. */
  transformArtifactDigest: string;
}

export interface AcceptedTaskExecutionSetFact {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  /** Exact host query of every execution opened for this accepted task. */
  openedExecutionIds: string[];
  executions: Array<{
    executionId: string;
    state: 'active' | 'completed' | 'failed' | 'cancelled';
  }>;
}

export interface WriteEvidenceInput {
  binding: FrozenWriteEvidenceBindingV1;
  /** Closed, host-derived manifest scope selected after resolution. */
  scope: WriteEvidenceManifestScopeV1;
  /** Exact normalized provider-ready arguments retained by authority storage. */
  writeInput: unknown;
  writeSettlement: LogicalSettlementFact;
  writeResult?: BoundRawResultFact;
  /** Exact lifecycle rows selected for this logical write call. */
  writeLifecycle: WriteLifecycleFact[];
  readback?: ReadbackEvidenceFact;
  derivation?: HostDerivationFact;
  executionSet?: AcceptedTaskExecutionSetFact;
}

export interface NormalizedWriteEvidenceProofV1 {
  protocolVersion: typeof WRITE_EVIDENCE_PROTOCOL_VERSION;
  proofId: string;
  obligation: WriteEvidenceObligation;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  workContractId: string;
  bindingId: string;
  manifestId: string;
  nodeId: string;
  requirementId: string;
  logicalToolCallId: string;
  physicalDispatchIds: string[];
  targetDigest: string;
  /** Value-opaque digests of every fact used by this proof. */
  evidenceDigests: string[];
}

export type WriteEvidenceFailureReason =
  | 'invalid_binding'
  | 'write_input_conflict'
  | 'write_settlement_not_committed'
  | 'write_settlement_identity_mismatch'
  | 'write_crossing_not_bound'
  | 'write_result_missing'
  | 'write_result_corrupt'
  | 'write_result_unsuccessful'
  | 'write_lifecycle_missing'
  | 'write_lifecycle_ambiguous'
  | 'write_lifecycle_not_succeeded'
  | 'write_lifecycle_identity_mismatch'
  | 'commit_effect_unproven'
  | 'verification_contract_missing'
  | 'provider_receipt_unproven'
  | 'readback_missing'
  | 'readback_identity_mismatch'
  | 'readback_result_unproven'
  | 'readback_projection_invalid'
  | 'readback_projection_duplicate'
  | 'readback_did_not_match'
  | 'readback_not_complete'
  | 'readback_does_not_cover_exact_destination'
  | 'derivation_fact_missing'
  | 'derivation_fact_mismatch'
  | 'execution_set_missing'
  | 'execution_set_identity_mismatch'
  | 'execution_set_not_terminal';

export type WriteEvidenceVerdict =
  | {
      obligation: WriteEvidenceObligation;
      status: 'proved';
      proof: NormalizedWriteEvidenceProofV1;
    }
  | {
      obligation: WriteEvidenceObligation;
      status: 'unproven';
      reason: WriteEvidenceFailureReason;
    };

export interface WriteEvidenceEvaluation {
  status: 'evaluated' | 'invalid_binding';
  verdicts: WriteEvidenceVerdict[];
}

const MAX_DEPTH = 32;
const MAX_NODES = 32_768;
const MAX_FIELDS = 128;
const MAX_RECORDS = 4_096;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const OBLIGATION_ORDER: readonly WriteEvidenceObligation[] = [
  'derivation_from_current_source',
  'commit_effect',
  'verify_committed_readback',
  'stale_destination_reconciled',
  'verify_committed_receipt',
  'execution_terminal',
];

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown): string {
  const stack = new WeakSet<object>();
  let nodes = 0;
  const visit = (entry: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('value exceeds evidence bounds');
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') {
      return JSON.stringify(entry);
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new Error('non-finite number');
      return JSON.stringify(entry);
    }
    if (typeof entry !== 'object') throw new Error('value is not canonical JSON');
    if (stack.has(entry)) throw new Error('cyclic value');
    stack.add(entry);
    try {
      if (Array.isArray(entry)) {
        return `[${entry.map((child) => visit(child, depth + 1)).join(',')}]`;
      }
      if (!plainRecord(entry)) throw new Error('non-plain object');
      const keys = Object.keys(entry);
      if (keys.length > MAX_NODES) throw new Error('object exceeds evidence bounds');
      if (keys.some((key) => entry[key] === undefined)) throw new Error('undefined value');
      return `{${keys.sort().map((key) =>
        `${JSON.stringify(key)}:${visit(entry[key], depth + 1)}`).join(',')}}`;
    } finally {
      stack.delete(entry);
    }
  };
  return visit(value, 0);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function rawDigest(value: string): string {
  return sha256(value);
}

/** Stable digest helper used by the pre-dispatch freezer and test fixtures. */
export const canonicalWriteEvidenceDigest = Object.assign(canonicalDigest, {
  raw: rawDigest,
});

function canonicalObligations(values: readonly WriteEvidenceObligation[]): WriteEvidenceObligation[] {
  const selected = new Set(values);
  return OBLIGATION_ORDER.filter((entry) => selected.has(entry));
}

function canonicalProjection(projection: ExactRecordProjectionV1): ExactRecordProjectionV1 {
  return {
    shape: projection.shape,
    recordsPointer: projection.recordsPointer,
    identityField: projection.identityField,
    fields: [...projection.fields]
      .map((field) => ({ id: field.id, valuePointer: field.valuePointer }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

/**
 * Content-address a host-prepared work-call binding. This does not turn a
 * model proposal into authority; production must persist/load the returned
 * value through the accepted-task CAS before calling the evaluator.
 */
export function freezeWriteEvidenceBinding(
  input: WriteEvidenceBindingBodyV1,
): FrozenWriteEvidenceBindingV1 {
  const verification: WriteVerificationContractV1 = input.verification.kind === 'reversible_exact_v1'
    ? {
        kind: 'reversible_exact_v1',
        observedCoverage: input.verification.observedCoverage,
        expected: canonicalProjection(input.verification.expected),
        observed: canonicalProjection(input.verification.observed),
      }
    : input.verification.kind === 'irreversible_receipt_v1'
      ? { kind: 'irreversible_receipt_v1', receiptPointer: input.verification.receiptPointer }
      : { kind: 'unavailable' };
  const body: WriteEvidenceBindingBodyV1 = {
    ...input,
    sourceRequirementIds: [...input.sourceRequirementIds].sort(),
    verification,
  };
  return {
    ...body,
    bindingId: `write-binding:v1:${canonicalDigest(body)}`,
  };
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

function safeOpaqueId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safePointer(value: unknown, options: { allowRoot: boolean }): value is string {
  return typeof value === 'string'
    && value.length <= 1_024
    && (options.allowRoot ? value === '' || value.startsWith('/') : value.startsWith('/'))
    && !/~(?![01])/u.test(value);
}

function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer.slice(1).split('/').map((segment) =>
    segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function traversesRequestEcho(pointer: string): boolean {
  return pointerSegments(pointer).some((segment) => {
    const normalized = segment.toLowerCase().replace(/[^a-z0-9]/g, '');
    // `payload` is a common response carrier. The shared contradiction parser
    // makes the same distinction; unmistakable request carriers remain banned.
    return normalized !== 'payload' && providerRequestEchoKey(segment);
  });
}

function validProjection(projection: ExactRecordProjectionV1, observed: boolean): boolean {
  if (
    (projection.shape !== 'record' && projection.shape !== 'set')
    || !safePointer(projection.recordsPointer, { allowRoot: true })
    || projection.fields.length < 1
    || projection.fields.length > MAX_FIELDS
  ) return false;
  if (observed && traversesRequestEcho(projection.recordsPointer)) return false;
  const ids = new Set<string>();
  for (const field of projection.fields) {
    if (
      !safeId(field.id)
      || ids.has(field.id)
      || !safePointer(field.valuePointer, { allowRoot: true })
      || (observed && traversesRequestEcho(field.valuePointer))
    ) return false;
    ids.add(field.id);
  }
  if (projection.shape === 'set') {
    return projection.identityField !== null && ids.has(projection.identityField);
  }
  return projection.identityField === null || ids.has(projection.identityField);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function bindingBody(binding: FrozenWriteEvidenceBindingV1): WriteEvidenceBindingBodyV1 {
  const { bindingId: _bindingId, ...body } = binding;
  return body;
}

function bindingValid(binding: FrozenWriteEvidenceBindingV1): boolean {
  try {
    const body = bindingBody(binding);
    if (
      binding.protocolVersion !== WRITE_EVIDENCE_PROTOCOL_VERSION
      || binding.bindingId !== `write-binding:v1:${canonicalDigest(body)}`
      || !safeOpaqueId(binding.sessionId)
      || !Number.isSafeInteger(binding.sourceUserSeq)
      || binding.sourceUserSeq <= 0
      || !safeOpaqueId(binding.acceptedTaskId)
      || !safeOpaqueId(binding.workContractId)
      || !safeOpaqueId(binding.requirementId)
      || !safeOpaqueId(binding.logicalToolCallId)
      || (binding.effect !== 'external_write' && binding.effect !== 'admin')
      || (binding.reversibility !== 'reversible' && binding.reversibility !== 'irreversible')
      || !DIGEST_RE.test(binding.targetDigest)
      || !DIGEST_RE.test(binding.argumentDigest)
      || !DIGEST_RE.test(binding.writeInputDigest)
      || !DIGEST_RE.test(binding.schemaDigest)
      || !DIGEST_RE.test(binding.targetSelectorDigest)
      || binding.sourceRequirementIds.some((id) => !safeOpaqueId(id))
      || new Set(binding.sourceRequirementIds).size !== binding.sourceRequirementIds.length
    ) return false;
    if (binding.reversibility === 'reversible') {
      if (binding.verification.kind === 'irreversible_receipt_v1') return false;
      if (binding.verification.kind === 'reversible_exact_v1') {
        if (
          !validProjection(binding.verification.expected, false)
          || !validProjection(binding.verification.observed, true)
          || !sameStringSet(
            binding.verification.expected.fields.map((field) => field.id),
            binding.verification.observed.fields.map((field) => field.id),
          )
          || binding.verification.expected.shape !== binding.verification.observed.shape
          || binding.verification.expected.identityField !== binding.verification.observed.identityField
        ) return false;
      }
    } else {
      if (binding.verification.kind === 'reversible_exact_v1') return false;
      if (
        binding.verification.kind === 'irreversible_receipt_v1'
        && !safePointer(binding.verification.receiptPointer, { allowRoot: false })
      ) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Public integrity check for durable loaders; no semantic authority is added. */
export function frozenWriteEvidenceBindingIsValid(
  binding: FrozenWriteEvidenceBindingV1,
): boolean {
  return bindingValid(binding);
}

/** Recompute the content address of a normalized proof after restart. */
export function normalizedWriteEvidenceProofIsValid(
  value: NormalizedWriteEvidenceProofV1,
): boolean {
  try {
    const { proofId, ...body } = value;
    return proofId === `write-evidence:v1:${canonicalDigest(body)}`;
  } catch {
    return false;
  }
}

function scopeValid(
  binding: FrozenWriteEvidenceBindingV1,
  scope: WriteEvidenceManifestScopeV1,
): boolean {
  if (
    !safeOpaqueId(scope.manifestId)
    || !safeOpaqueId(scope.nodeId)
    || scope.obligations.length !== new Set(scope.obligations).size
    || !scope.obligations.every((value) => OBLIGATION_ORDER.includes(value))
    || !scope.obligations.includes('commit_effect')
    || !scope.obligations.includes('execution_terminal')
  ) return false;
  const obligations = new Set(scope.obligations);
  if (
    (binding.sourceRequirementIds.length > 0) !== obligations.has('derivation_from_current_source')
  ) return false;
  if (binding.reversibility === 'reversible') {
    return obligations.has('verify_committed_readback')
      && !obligations.has('verify_committed_receipt');
  }
  return obligations.has('verify_committed_receipt')
    && !obligations.has('verify_committed_readback')
    && !obligations.has('stale_destination_reconciled');
}

function sameTask(
  binding: FrozenWriteEvidenceBindingV1,
  value: { sessionId: string; sourceUserSeq: number; acceptedTaskId: string },
): boolean {
  return value.sessionId === binding.sessionId
    && value.sourceUserSeq === binding.sourceUserSeq
    && value.acceptedTaskId === binding.acceptedTaskId;
}

interface ValidRawResult {
  parsed: unknown;
  rawDigest: string;
  physicalDispatchId: string;
  resultHandleId: string;
}

type ResultValidation =
  | { ok: true; value: ValidRawResult }
  | { ok: false; reason: 'write_result_missing' | 'write_result_corrupt' | 'write_result_unsuccessful' };

function validateRawResult(
  settlement: LogicalSettlementFact,
  result: BoundRawResultFact | undefined,
): ResultValidation {
  if (!result) return { ok: false, reason: 'write_result_missing' };
  if (
    result.sessionId !== settlement.sessionId
    || result.sourceUserSeq !== settlement.sourceUserSeq
    || result.acceptedTaskId !== settlement.acceptedTaskId
    || result.logicalToolCallId !== settlement.logicalToolCallId
    || result.resultHandleId !== settlement.resultHandleId
    || !DIGEST_RE.test(result.rawPayloadSha256)
    || Buffer.byteLength(result.rawPayloadJson, 'utf8') !== result.rawByteCount
    || rawDigest(result.rawPayloadJson) !== result.rawPayloadSha256
  ) return { ok: false, reason: 'write_result_corrupt' };
  const ordered = [...settlement.crossings].sort((left, right) => left.ordinal - right.ordinal);
  const final = ordered.at(-1);
  if (!final || final.state !== 'returned' || final.physicalDispatchId !== result.physicalDispatchId) {
    return { ok: false, reason: 'write_result_corrupt' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.rawPayloadJson) as unknown;
  } catch {
    return { ok: false, reason: 'write_result_corrupt' };
  }
  if (!deriveResultHandleFactsFromRaw(parsed).success) {
    return { ok: false, reason: 'write_result_unsuccessful' };
  }
  return {
    ok: true,
    value: {
      parsed,
      rawDigest: result.rawPayloadSha256,
      physicalDispatchId: result.physicalDispatchId,
      resultHandleId: result.resultHandleId,
    },
  };
}

function settlementShapeValid(settlement: LogicalSettlementFact): boolean {
  if (settlement.crossings.length < 1 || !settlement.resultHandleId?.trim()) return false;
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (const crossing of settlement.crossings) {
    if (
      !crossing.physicalDispatchId.trim()
      || !Number.isSafeInteger(crossing.ordinal)
      || crossing.ordinal <= 0
      || ids.has(crossing.physicalDispatchId)
      || ordinals.has(crossing.ordinal)
      || crossing.state === 'started'
      || crossing.state === 'unknown'
    ) return false;
    ids.add(crossing.physicalDispatchId);
    ordinals.add(crossing.ordinal);
  }
  return true;
}

interface CommitProofContext {
  proof: NormalizedWriteEvidenceProofV1;
  raw: ValidRawResult;
}

type CommitDecision =
  | { ok: true; value: CommitProofContext }
  | { ok: false; reason: WriteEvidenceFailureReason };

function proof(
  binding: FrozenWriteEvidenceBindingV1,
  scope: WriteEvidenceManifestScopeV1,
  obligation: WriteEvidenceObligation,
  physicalDispatchIds: readonly string[],
  evidenceDigests: readonly string[],
): NormalizedWriteEvidenceProofV1 {
  const body = {
    protocolVersion: WRITE_EVIDENCE_PROTOCOL_VERSION,
    obligation,
    sessionId: binding.sessionId,
    sourceUserSeq: binding.sourceUserSeq,
    acceptedTaskId: binding.acceptedTaskId,
    workContractId: binding.workContractId,
    bindingId: binding.bindingId,
    manifestId: scope.manifestId,
    nodeId: scope.nodeId,
    requirementId: binding.requirementId,
    logicalToolCallId: binding.logicalToolCallId,
    physicalDispatchIds: [...physicalDispatchIds],
    targetDigest: binding.targetDigest,
    evidenceDigests: [...evidenceDigests].sort(),
  };
  return {
    ...body,
    proofId: `write-evidence:v1:${canonicalDigest(body)}`,
  };
}

function commitEffect(input: WriteEvidenceInput): CommitDecision {
  const { binding, writeSettlement: settlement } = input;
  let writeInputDigest: string;
  try {
    writeInputDigest = canonicalDigest(input.writeInput);
  } catch {
    return { ok: false, reason: 'write_input_conflict' };
  }
  if (writeInputDigest !== binding.writeInputDigest) {
    return { ok: false, reason: 'write_input_conflict' };
  }
  if (
    !sameTask(binding, settlement)
    || settlement.logicalToolCallId !== binding.logicalToolCallId
    || settlement.argumentDigest !== binding.argumentDigest
  ) return { ok: false, reason: 'write_settlement_identity_mismatch' };
  if (
    settlement.executionKind !== 'provider_execution'
    || !['succeeded', 'empty_result'].includes(settlement.outcomeKind)
  ) return { ok: false, reason: 'write_settlement_not_committed' };
  if (!settlementShapeValid(settlement)) {
    return { ok: false, reason: 'write_crossing_not_bound' };
  }
  const raw = validateRawResult(settlement, input.writeResult);
  if (!raw.ok) return raw;
  if (input.writeLifecycle.length === 0) {
    return { ok: false, reason: 'write_lifecycle_missing' };
  }
  const reservations = input.writeLifecycle.filter((fact) => fact.kind === 'reservation');
  const terminals = input.writeLifecycle.filter((fact) => fact.kind !== 'reservation');
  if (input.writeLifecycle.length !== 2 || reservations.length !== 1 || terminals.length !== 1) {
    return { ok: false, reason: 'write_lifecycle_ambiguous' };
  }
  const reservation = reservations[0]!;
  const terminal = terminals[0] as Exclude<WriteLifecycleFact, { kind: 'reservation' }>;
  if (terminal.kind !== 'succeeded') {
    return { ok: false, reason: 'write_lifecycle_not_succeeded' };
  }
  const crossingIds = new Set(settlement.crossings.map((crossing) => crossing.physicalDispatchId));
  const lifecycleIdentityMatches = sameTask(binding, reservation)
    && sameTask(binding, terminal)
    && reservation.logicalToolCallId === binding.logicalToolCallId
    && terminal.logicalToolCallId === binding.logicalToolCallId
    && reservation.eventId.trim().length > 0
    && terminal.eventId.trim().length > 0
    && terminal.reservationEventId === reservation.eventId
    && reservation.physicalDispatchId === terminal.physicalDispatchId
    && terminal.physicalDispatchId === raw.value.physicalDispatchId
    && crossingIds.has(terminal.physicalDispatchId)
    && reservation.targetDigest === binding.targetDigest
    && terminal.targetDigest === binding.targetDigest
    && reservation.writeInputDigest === binding.writeInputDigest
    && terminal.writeInputDigest === binding.writeInputDigest
    && terminal.resultHandleId === raw.value.resultHandleId;
  if (!lifecycleIdentityMatches) {
    return { ok: false, reason: 'write_lifecycle_identity_mismatch' };
  }
  const physicalDispatchIds = [...settlement.crossings]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((crossing) => crossing.physicalDispatchId);
  const result = proof(binding, input.scope, 'commit_effect', physicalDispatchIds, [
    binding.bindingId,
    raw.value.rawDigest,
    canonicalDigest(reservation),
    canonicalDigest(terminal),
    canonicalDigest(settlement.crossings),
  ]);
  return { ok: true, value: { proof: result, raw: raw.value } };
}

function resolvePointer(root: unknown, pointer: string): { ok: true; value: unknown } | { ok: false } {
  if (pointer === '') return { ok: true, value: root };
  let current = root;
  for (const segment of pointerSegments(pointer)) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return { ok: false };
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) return { ok: false };
      current = current[index];
      continue;
    }
    if (!plainRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { ok: false };
    }
    current = current[segment];
  }
  return { ok: true, value: current };
}

function providerReceipt(
  input: WriteEvidenceInput,
  commit: CommitProofContext,
): WriteEvidenceVerdict {
  const obligation = 'verify_committed_receipt' as const;
  if (input.binding.verification.kind !== 'irreversible_receipt_v1') {
    return { obligation, status: 'unproven', reason: 'verification_contract_missing' };
  }
  const pointer = input.binding.verification.receiptPointer;
  if (
    !safePointer(pointer, { allowRoot: false })
    || traversesRequestEcho(pointer)
  ) return { obligation, status: 'unproven', reason: 'provider_receipt_unproven' };
  const selected = resolvePointer(commit.raw.parsed, pointer);
  if (!selected.ok) return { obligation, status: 'unproven', reason: 'provider_receipt_unproven' };
  const value = selected.value;
  const valid = (typeof value === 'string' && value.trim().length > 0 && value.length <= 8_192)
    || (typeof value === 'number' && Number.isFinite(value));
  if (!valid) return { obligation, status: 'unproven', reason: 'provider_receipt_unproven' };
  const receiptDigest = canonicalDigest(value);
  return {
    obligation,
    status: 'proved',
    proof: proof(input.binding, input.scope, obligation, [commit.raw.physicalDispatchId], [
      commit.proof.proofId,
      commit.raw.rawDigest,
      canonicalDigest({ pointer }),
      receiptDigest,
    ]),
  };
}

type ProjectionDecision =
  | { ok: true; digest: string }
  | { ok: false; reason: 'readback_projection_invalid' | 'readback_projection_duplicate' };

function scalarIdentity(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? `s:${value}` : null;
  if (typeof value === 'number' && Number.isFinite(value)) return `n:${String(value)}`;
  if (typeof value === 'boolean') return `b:${String(value)}`;
  return null;
}

function projectExactRecords(root: unknown, projection: ExactRecordProjectionV1): ProjectionDecision {
  const selected = resolvePointer(root, projection.recordsPointer);
  if (!selected.ok) return { ok: false, reason: 'readback_projection_invalid' };
  const records = projection.shape === 'set'
    ? Array.isArray(selected.value) ? selected.value : null
    : [selected.value];
  if (!records || records.length > MAX_RECORDS) {
    return { ok: false, reason: 'readback_projection_invalid' };
  }
  const projected: Array<{ identity: string; value: Record<string, unknown> }> = [];
  const identities = new Set<string>();
  for (const record of records) {
    const value: Record<string, unknown> = {};
    for (const field of projection.fields) {
      const selectedField = resolvePointer(record, field.valuePointer);
      if (!selectedField.ok || selectedField.value === undefined) {
        return { ok: false, reason: 'readback_projection_invalid' };
      }
      try {
        canonicalJson(selectedField.value);
      } catch {
        return { ok: false, reason: 'readback_projection_invalid' };
      }
      value[field.id] = selectedField.value;
    }
    const identity = projection.identityField === null
      ? `record:${canonicalDigest(value)}`
      : scalarIdentity(value[projection.identityField]);
    if (!identity) return { ok: false, reason: 'readback_projection_invalid' };
    if (identities.has(identity)) {
      return { ok: false, reason: 'readback_projection_duplicate' };
    }
    identities.add(identity);
    projected.push({ identity, value });
  }
  projected.sort((left, right) => left.identity.localeCompare(right.identity));
  return { ok: true, digest: canonicalDigest(projected.map((entry) => entry.value)) };
}

interface ReadbackDecision {
  verdict: WriteEvidenceVerdict;
  exactDestination: boolean;
  comparisonDigest?: string;
  physicalDispatchId?: string;
}

function exactReadback(
  input: WriteEvidenceInput,
  commit: CommitProofContext,
): ReadbackDecision {
  const obligation = 'verify_committed_readback' as const;
  const verification = input.binding.verification;
  if (verification.kind !== 'reversible_exact_v1') {
    return {
      verdict: { obligation, status: 'unproven', reason: 'verification_contract_missing' },
      exactDestination: false,
    };
  }
  if (!input.readback) {
    return {
      verdict: { obligation, status: 'unproven', reason: 'readback_missing' },
      exactDestination: false,
    };
  }
  const readback = input.readback;
  if (
    readback.verificationContractId !== input.binding.bindingId
    || readback.writeLogicalToolCallId !== input.binding.logicalToolCallId
    || readback.targetDigest !== input.binding.targetDigest
    || !sameTask(input.binding, readback.settlement)
    || !sameTask(input.binding, readback.result)
    || readback.settlement.logicalToolCallId === input.binding.logicalToolCallId
  ) {
    return {
      verdict: { obligation, status: 'unproven', reason: 'readback_identity_mismatch' },
      exactDestination: false,
    };
  }
  if (
    readback.settlement.executionKind !== 'provider_execution'
    || !['succeeded', 'empty_result'].includes(readback.settlement.outcomeKind)
    || !settlementShapeValid(readback.settlement)
  ) {
    return {
      verdict: { obligation, status: 'unproven', reason: 'readback_result_unproven' },
      exactDestination: false,
    };
  }
  const result = validateRawResult(readback.settlement, readback.result);
  if (!result.ok) {
    return {
      verdict: { obligation, status: 'unproven', reason: 'readback_result_unproven' },
      exactDestination: false,
    };
  }
  const expected = projectExactRecords(input.writeInput, verification.expected);
  if (!expected.ok) {
    return {
      verdict: { obligation, status: 'unproven', reason: expected.reason },
      exactDestination: false,
    };
  }
  const observed = projectExactRecords(result.value.parsed, verification.observed);
  if (!observed.ok) {
    return {
      verdict: { obligation, status: 'unproven', reason: observed.reason },
      exactDestination: false,
    };
  }
  if (expected.digest !== observed.digest) {
    return {
      verdict: { obligation, status: 'unproven', reason: 'readback_did_not_match' },
      exactDestination: false,
    };
  }
  const facts = deriveResultHandleFactsFromRaw(result.value.parsed);
  const exactDestination = verification.observedCoverage === 'exact_destination';
  if (exactDestination && facts.completeness !== 'complete') {
    return {
      verdict: { obligation, status: 'unproven', reason: 'readback_not_complete' },
      exactDestination: false,
    };
  }
  const comparisonDigest = canonicalDigest({
    expectedDigest: expected.digest,
    observedDigest: observed.digest,
    mapping: verification,
    targetDigest: input.binding.targetDigest,
  });
  return {
    verdict: {
      obligation,
      status: 'proved',
      proof: proof(input.binding, input.scope, obligation, [
        commit.raw.physicalDispatchId,
        result.value.physicalDispatchId,
      ], [
        commit.proof.proofId,
        result.value.rawDigest,
        comparisonDigest,
      ]),
    },
    exactDestination,
    comparisonDigest,
    physicalDispatchId: result.value.physicalDispatchId,
  };
}

function derivationVerdict(input: WriteEvidenceInput): WriteEvidenceVerdict {
  const obligation = 'derivation_from_current_source' as const;
  const fact = input.derivation;
  if (!fact) return { obligation, status: 'unproven', reason: 'derivation_fact_missing' };
  const required = [...input.binding.sourceRequirementIds].sort();
  const observed = fact.sourceEvidence.map((entry) => entry.requirementId).sort();
  const sourceEvidenceValid = fact.sourceEvidence.length > 0
    && new Set(observed).size === observed.length
    && sameStringSet(required, observed)
    && fact.sourceEvidence.every((entry) =>
      safeOpaqueId(entry.requirementId)
      && safeOpaqueId(entry.receiptId)
      && DIGEST_RE.test(entry.contentDigest));
  if (
    fact.kind !== 'host_deterministic_transform'
    || !sameTask(input.binding, fact)
    || fact.workContractId !== input.binding.workContractId
    || fact.requirementId !== input.binding.requirementId
    || fact.outputDigest !== input.binding.writeInputDigest
    || !DIGEST_RE.test(fact.transformArtifactDigest)
    || !sourceEvidenceValid
  ) return { obligation, status: 'unproven', reason: 'derivation_fact_mismatch' };
  return {
    obligation,
    status: 'proved',
    proof: proof(input.binding, input.scope, obligation, [], [
      canonicalDigest(fact),
      fact.outputDigest,
      fact.transformArtifactDigest,
      ...fact.sourceEvidence.map((entry) => entry.contentDigest),
    ]),
  };
}

function executionVerdict(input: WriteEvidenceInput): WriteEvidenceVerdict {
  const obligation = 'execution_terminal' as const;
  const set = input.executionSet;
  if (!set) return { obligation, status: 'unproven', reason: 'execution_set_missing' };
  if (!sameTask(input.binding, set)) {
    return { obligation, status: 'unproven', reason: 'execution_set_identity_mismatch' };
  }
  const opened = [...set.openedExecutionIds].sort();
  const observed = set.executions.map((entry) => entry.executionId).sort();
  if (
    opened.length === 0
    || new Set(opened).size !== opened.length
    || new Set(observed).size !== observed.length
    || !sameStringSet(opened, observed)
    || set.executions.some((entry) => !['completed', 'failed', 'cancelled'].includes(entry.state))
  ) return { obligation, status: 'unproven', reason: 'execution_set_not_terminal' };
  return {
    obligation,
    status: 'proved',
    proof: proof(input.binding, input.scope, obligation, [], [canonicalDigest({ opened, executions: set.executions })]),
  };
}

function unproven(
  obligation: WriteEvidenceObligation,
  reason: WriteEvidenceFailureReason,
): WriteEvidenceVerdict {
  return { obligation, status: 'unproven', reason };
}

/**
 * Evaluate every obligation declared by one frozen write binding.
 *
 * Partial proof is intentional: for example, a durable commit may be recorded
 * while read-back remains outstanding. Dependency ordering in the obligation
 * store decides when each returned proof can be satisfied. No downstream proof
 * is emitted when commit identity is ambiguous.
 */
export function evaluateWriteEvidence(input: WriteEvidenceInput): WriteEvidenceEvaluation {
  const obligations = canonicalObligations(input.scope.obligations);
  if (!bindingValid(input.binding) || !scopeValid(input.binding, input.scope)) {
    return {
      status: 'invalid_binding',
      verdicts: obligations.map((obligation) => unproven(obligation, 'invalid_binding')),
    };
  }

  const commit = commitEffect(input);
  const verdicts: WriteEvidenceVerdict[] = [];
  for (const obligation of obligations) {
    switch (obligation) {
      case 'derivation_from_current_source':
        verdicts.push(derivationVerdict(input));
        break;
      case 'commit_effect':
        verdicts.push(commit.ok
          ? { obligation, status: 'proved', proof: commit.value.proof }
          : unproven(obligation, commit.reason));
        break;
      case 'verify_committed_readback': {
        if (!commit.ok) {
          verdicts.push(unproven(obligation, 'commit_effect_unproven'));
          break;
        }
        verdicts.push(exactReadback(input, commit.value).verdict);
        break;
      }
      case 'stale_destination_reconciled': {
        if (!commit.ok) {
          verdicts.push(unproven(obligation, 'commit_effect_unproven'));
          break;
        }
        const readback = exactReadback(input, commit.value);
        if (readback.verdict.status !== 'proved') {
          verdicts.push(unproven(obligation, readback.verdict.reason));
        } else if (!readback.exactDestination) {
          verdicts.push(unproven(obligation, 'readback_does_not_cover_exact_destination'));
        } else {
          verdicts.push({
            obligation,
            status: 'proved',
            proof: proof(input.binding, input.scope, obligation, [
              commit.value.raw.physicalDispatchId,
              readback.physicalDispatchId!,
            ], [commit.value.proof.proofId, readback.verdict.proof.proofId, readback.comparisonDigest!]),
          });
        }
        break;
      }
      case 'verify_committed_receipt':
        verdicts.push(commit.ok
          ? providerReceipt(input, commit.value)
          : unproven(obligation, 'commit_effect_unproven'));
        break;
      case 'execution_terminal':
        verdicts.push(executionVerdict(input));
        break;
    }
  }
  return { status: 'evaluated', verdicts };
}
