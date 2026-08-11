/**
 * Durable, provider-neutral write evidence.
 *
 * Phase one freezes exact provider-ready input, target selectors and response
 * mappings before a paid crossing. It has no manifest identity because the
 * manifest is compiled only after resolution closes. Phase two rehydrates
 * immutable settlement/result/lifecycle/source/readback/execution facts and
 * atomically inserts a content-addressed proof receipt plus its obligation CAS
 * under the later authoritative manifest.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

import { ExecutionStore } from '../../execution/store.js';
import {
  insertInternalEventInTransaction,
  openEventLog,
  publishCommittedInternalEvent,
  type EventRow,
} from './eventlog.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import {
  redeemDurableLogicalCallSettlementForHost,
  type DurableLogicalCallSettlement,
} from './logical-call-settlement-store.js';
import { loadManifestState, type SatisfactionRequest } from './obligation-store.js';
import { declaredObligation, type ObligationManifest } from './obligation-manifest.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import {
  canonicalWriteEvidenceDigest,
  evaluateWriteEvidence,
  freezeWriteEvidenceBinding,
  frozenWriteEvidenceBindingIsValid,
  normalizedWriteEvidenceProofIsValid,
  type BoundRawResultFact,
  type ExactRecordProjectionV1,
  type FrozenWriteEvidenceBindingV1,
  type HostDerivationFact,
  type LogicalSettlementFact,
  type NormalizedWriteEvidenceProofV1,
  type ReadbackEvidenceFact,
  type WriteEvidenceInput,
  type WriteEvidenceManifestScopeV1,
  type WriteEvidenceObligation,
  type WriteEvidenceReversibility,
  type WriteLifecycleFact,
  type WriteVerificationContractV1,
} from './write-evidence-kernel.js';

const DIGEST_RE = /^[a-f0-9]{64}$/;
const POINTER_RE = /^(?:|\/(?:[^~/]|~[01])*)$/u;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 300);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeJson(value: unknown): string | null {
  try {
    const digest = canonicalWriteEvidenceDigest(value);
    void digest;
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' && Buffer.byteLength(encoded, 'utf8') <= 8 * 1_024 * 1_024
      ? encoded
      : null;
  } catch {
    return null;
  }
}

function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer.slice(1).split('/').map((segment) =>
    segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function resolvePointer(root: unknown, pointer: string): { ok: true; value: unknown } | { ok: false } {
  if (!POINTER_RE.test(pointer) || pointer.length > 1_024) return { ok: false };
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

function schemaCoversPointer(schema: unknown, pointer: string): boolean {
  if (!POINTER_RE.test(pointer) || pointer.length > 1_024) return false;
  let current = schema;
  for (const segment of pointerSegments(pointer)) {
    if (!plainRecord(current)) return false;
    if (/^(?:0|[1-9][0-9]*)$/u.test(segment)) {
      current = current.items;
      continue;
    }
    if (!plainRecord(current.properties) || !(segment in current.properties)) return false;
    current = current.properties[segment];
  }
  return plainRecord(current) || typeof current === 'boolean';
}

function targetSelector(
  args: unknown,
  inputSchema: unknown,
  pointers: readonly string[],
): { ok: true; pointers: string[]; digest: string; selectorDigest: string } | { ok: false; reason: string } {
  const normalized = [...pointers].sort();
  if (
    normalized.length < 1
    || normalized.length > 16
    || new Set(normalized).size !== normalized.length
  ) return { ok: false, reason: 'target selector must contain 1-16 distinct RFC 6901 pointers' };
  const selected: Array<{ pointer: string; value: unknown }> = [];
  for (const pointer of normalized) {
    if (!schemaCoversPointer(inputSchema, pointer)) {
      return { ok: false, reason: `target selector ${pointer || '<root>'} is not present in the exact input schema` };
    }
    const value = resolvePointer(args, pointer);
    if (!value.ok || value.value === undefined) {
      return { ok: false, reason: `target selector ${pointer || '<root>'} is not present in provider-ready input` };
    }
    selected.push({ pointer, value: value.value });
  }
  try {
    return {
      ok: true,
      pointers: normalized,
      digest: canonicalWriteEvidenceDigest(selected),
      selectorDigest: canonicalWriteEvidenceDigest(normalized),
    };
  } catch {
    return { ok: false, reason: 'target selector resolves to non-canonical input' };
  }
}

interface WorkBindingRow {
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  logical_tool_call_id: string;
  contract_id: string;
  requirement_id: string;
  tool_name: string;
  argument_digest: string;
  effect_kind: 'read' | 'compute' | 'local_write' | 'external_write' | 'admin';
}

interface DurableWriteBindingRow {
  binding_id: string;
  protocol_version: number;
  semantic_digest: string;
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  work_contract_id: string;
  requirement_id: string;
  logical_tool_call_id: string;
  tool_name: string;
  argument_digest: string;
  effect_kind: 'external_write' | 'admin';
  reversibility: WriteEvidenceReversibility;
  target_selector_json: string;
  target_digest: string;
  write_input_json: string;
  write_input_digest: string;
  input_schema_json: string;
  source_requirement_ids_json: string;
  verification_json: string;
  schema_digest: string;
  mapping_digest: string;
  frozen_at: string;
}

export interface HostWriteEvidenceBindingInput {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
  /** Exact provider-ready input and callable schema observed by the host. */
  writeInput: unknown;
  inputSchema: unknown;
  /** Provider-neutral RFC 6901 selectors into writeInput. */
  targetArgumentPointers: readonly string[];
  reversibility: WriteEvidenceReversibility;
  verification: WriteVerificationContractV1;
}

export type FreezeWriteEvidenceResult =
  | { status: 'frozen' | 'replayed'; binding: FrozenWriteEvidenceBindingV1 }
  | { status: 'missing' | 'refused' | 'conflict' | 'storage_error'; reason: string };

function loadContractOperation(db: Database.Database, row: WorkBindingRow): {
  dataFrom: string[];
} | null {
  const stored = db.prepare(`
    SELECT contract_json FROM accepted_task_work_contracts
     WHERE contract_id = ? AND session_id = ? AND source_user_seq = ?
  `).get(row.contract_id, row.session_id, row.source_user_seq) as { contract_json: string } | undefined;
  if (!stored) return null;
  try {
    const contract = JSON.parse(stored.contract_json) as { operations?: unknown[] };
    const operation = contract.operations?.find((candidate) =>
      plainRecord(candidate) && candidate.id === row.requirement_id);
    if (!plainRecord(operation) || !Array.isArray(operation.dataFrom)) return null;
    const dataFrom = operation.dataFrom.filter((entry): entry is string => typeof entry === 'string').sort();
    if (dataFrom.length !== operation.dataFrom.length || new Set(dataFrom).size !== dataFrom.length) return null;
    return { dataFrom };
  } catch {
    return null;
  }
}

function bindingFromRow(row: DurableWriteBindingRow): FrozenWriteEvidenceBindingV1 | null {
  try {
    const sourceRequirementIds = JSON.parse(row.source_requirement_ids_json) as unknown;
    const verification = JSON.parse(row.verification_json) as unknown;
    const targetPointers = JSON.parse(row.target_selector_json) as unknown;
    const writeInput = JSON.parse(row.write_input_json) as unknown;
    const inputSchema = JSON.parse(row.input_schema_json) as unknown;
    if (
      row.protocol_version !== 1
      || !Array.isArray(sourceRequirementIds)
      || sourceRequirementIds.some((entry) => typeof entry !== 'string')
      || !Array.isArray(targetPointers)
      || targetPointers.some((entry) => typeof entry !== 'string')
      || !plainRecord(verification)
      || canonicalWriteEvidenceDigest(writeInput) !== row.write_input_digest
      || canonicalWriteEvidenceDigest(inputSchema) !== row.schema_digest
    ) return null;
    const frozen = freezeWriteEvidenceBinding({
      protocolVersion: 1,
      sessionId: row.session_id,
      sourceUserSeq: row.source_user_seq,
      acceptedTaskId: row.accepted_task_id,
      workContractId: row.work_contract_id,
      requirementId: row.requirement_id,
      logicalToolCallId: row.logical_tool_call_id,
      effect: row.effect_kind,
      reversibility: row.reversibility,
      targetDigest: row.target_digest,
      argumentDigest: row.argument_digest,
      writeInputDigest: row.write_input_digest,
      schemaDigest: row.schema_digest,
      targetSelectorDigest: canonicalWriteEvidenceDigest(targetPointers),
      sourceRequirementIds: sourceRequirementIds as string[],
      verification: verification as unknown as WriteVerificationContractV1,
    });
    if (
      !frozenWriteEvidenceBindingIsValid(frozen)
      || frozen.bindingId !== row.binding_id
      || row.semantic_digest !== row.binding_id.slice('write-binding:v1:'.length)
      || canonicalWriteEvidenceDigest(verification) !== row.mapping_digest
    ) return null;
    return frozen;
  } catch {
    return null;
  }
}

/** Freeze the schema/mapping/target contract before any physical crossing. */
export function freezeDurableWriteEvidenceBinding(
  input: HostWriteEvidenceBindingInput,
): FreezeWriteEvidenceResult {
  try {
    const db = openEventLog();
    const tx = db.transaction((): FreezeWriteEvidenceResult => {
      const work = db.prepare(`
        SELECT * FROM expected_work_call_bindings
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as WorkBindingRow | undefined;
      if (!work) return { status: 'missing', reason: 'exact expected-work call binding is missing' };
      if (work.effect_kind !== 'external_write' && work.effect_kind !== 'admin') {
        return { status: 'refused', reason: 'only an admitted external write or admin effect can freeze write evidence' };
      }
      const contractOperation = loadContractOperation(db, work);
      if (!contractOperation) return { status: 'conflict', reason: 'frozen work contract operation is unreadable' };
      const logical = durableLogicalCallContract(work.accepted_task_id, work.tool_name, input.writeInput);
      if (!logical || logical.argumentDigest !== work.argument_digest) {
        return { status: 'conflict', reason: 'provider-ready write input conflicts with logical admission' };
      }
      const encodedInput = safeJson(input.writeInput);
      const encodedSchema = safeJson(input.inputSchema);
      if (encodedInput === null || encodedSchema === null) {
        return { status: 'refused', reason: 'write input and callable schema must be bounded canonical JSON' };
      }
      const selected = targetSelector(input.writeInput, input.inputSchema, input.targetArgumentPointers);
      if (!selected.ok) return { status: 'refused', reason: selected.reason };
      const schemaDigest = canonicalWriteEvidenceDigest(input.inputSchema);
      const binding = freezeWriteEvidenceBinding({
        protocolVersion: 1,
        sessionId: work.session_id,
        sourceUserSeq: work.source_user_seq,
        acceptedTaskId: work.accepted_task_id,
        workContractId: work.contract_id,
        requirementId: work.requirement_id,
        logicalToolCallId: work.logical_tool_call_id,
        effect: work.effect_kind,
        reversibility: input.reversibility,
        targetDigest: selected.digest,
        argumentDigest: work.argument_digest,
        writeInputDigest: canonicalWriteEvidenceDigest(input.writeInput),
        schemaDigest,
        targetSelectorDigest: selected.selectorDigest,
        sourceRequirementIds: contractOperation.dataFrom,
        verification: input.verification,
      });
      if (!frozenWriteEvidenceBindingIsValid(binding)) {
        return { status: 'refused', reason: 'host verification mapping is incomplete or unsafe' };
      }
      const prior = db.prepare(`
        SELECT * FROM write_evidence_bindings
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as DurableWriteBindingRow | undefined;
      if (prior) {
        const loaded = bindingFromRow(prior);
        return loaded?.bindingId === binding.bindingId
          ? { status: 'replayed', binding: loaded }
          : { status: 'conflict', reason: 'logical write call already owns a different verification binding' };
      }
      const mappingDigest = canonicalWriteEvidenceDigest(binding.verification);
      db.prepare(`
        INSERT INTO write_evidence_bindings
          (binding_id, protocol_version, semantic_digest, session_id,
           source_user_seq, accepted_task_id, work_contract_id, requirement_id,
           logical_tool_call_id, tool_name, argument_digest, effect_kind,
           reversibility, target_selector_json, target_digest, write_input_json,
           write_input_digest, input_schema_json, source_requirement_ids_json, verification_json,
           schema_digest, mapping_digest, frozen_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        binding.bindingId,
        binding.bindingId.slice('write-binding:v1:'.length),
        binding.sessionId,
        binding.sourceUserSeq,
        binding.acceptedTaskId,
        binding.workContractId,
        binding.requirementId,
        binding.logicalToolCallId,
        work.tool_name,
        binding.argumentDigest,
        binding.effect,
        binding.reversibility,
        JSON.stringify(selected.pointers),
        binding.targetDigest,
        encodedInput,
        binding.writeInputDigest,
        encodedSchema,
        JSON.stringify(binding.sourceRequirementIds),
        JSON.stringify(binding.verification),
        binding.schemaDigest,
        mappingDigest,
        new Date().toISOString(),
      );
      return { status: 'frozen', binding };
    });
    return tx.immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export type DurableWriteBindingState =
  | { status: 'ok'; binding: FrozenWriteEvidenceBindingV1; writeInput: unknown }
  | { status: 'missing' | 'corrupt' | 'storage_error'; reason: string };

export function loadDurableWriteEvidenceBinding(bindingId: string): DurableWriteBindingState {
  try {
    const row = openEventLog().prepare('SELECT * FROM write_evidence_bindings WHERE binding_id = ?')
      .get(bindingId) as DurableWriteBindingRow | undefined;
    if (!row) return { status: 'missing', reason: 'write evidence binding is missing' };
    const binding = bindingFromRow(row);
    if (!binding) return { status: 'corrupt', reason: 'write evidence binding does not match its content address' };
    let writeInput: unknown;
    try { writeInput = JSON.parse(row.write_input_json) as unknown; } catch {
      return { status: 'corrupt', reason: 'write evidence input is unreadable' };
    }
    return { status: 'ok', binding, writeInput };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export interface HostReadbackBindingInput {
  bindingId: string;
  readLogicalToolCallId: string;
  readInput: unknown;
  inputSchema: unknown;
  targetArgumentPointers: readonly string[];
}

export type BindReadbackResult =
  | { status: 'bound' | 'replayed'; readbackBindingId: string }
  | { status: 'missing' | 'refused' | 'conflict' | 'storage_error'; reason: string };

export function freezeDurableWriteReadbackBinding(input: HostReadbackBindingInput): BindReadbackResult {
  try {
    const db = openEventLog();
    const tx = db.transaction((): BindReadbackResult => {
      const writeRow = db.prepare('SELECT * FROM write_evidence_bindings WHERE binding_id = ?')
        .get(input.bindingId) as DurableWriteBindingRow | undefined;
      if (!writeRow || !bindingFromRow(writeRow)) {
        return { status: 'missing', reason: 'exact durable write binding is missing or corrupt' };
      }
      if (writeRow.reversibility !== 'reversible') {
        return { status: 'refused', reason: 'irreversible effects use provider receipts, not readback bindings' };
      }
      const read = db.prepare(`
        SELECT * FROM expected_work_call_bindings
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(writeRow.session_id, writeRow.source_user_seq, input.readLogicalToolCallId) as WorkBindingRow | undefined;
      if (!read || read.effect_kind !== 'read' || read.contract_id !== writeRow.work_contract_id) {
        return { status: 'missing', reason: 'readback call is not an exact read in the same work contract' };
      }
      const contract = db.prepare('SELECT contract_json FROM accepted_task_work_contracts WHERE contract_id = ?')
        .get(writeRow.work_contract_id) as { contract_json: string } | undefined;
      let depends = false;
      try {
        const parsed = JSON.parse(contract?.contract_json ?? '') as { operations?: unknown[] };
        const operation = parsed.operations?.find((candidate) => plainRecord(candidate) && candidate.id === read.requirement_id);
        depends = plainRecord(operation)
          && Array.isArray(operation.dependsOn)
          && operation.dependsOn.includes(writeRow.requirement_id);
      } catch { depends = false; }
      if (!depends) return { status: 'refused', reason: 'readback requirement is not structurally dependent on this write' };
      const logical = durableLogicalCallContract(read.accepted_task_id, read.tool_name, input.readInput);
      if (!logical || logical.argumentDigest !== read.argument_digest) {
        return { status: 'conflict', reason: 'provider-ready readback input conflicts with logical admission' };
      }
      const selected = targetSelector(input.readInput, input.inputSchema, input.targetArgumentPointers);
      if (!selected.ok) return { status: 'refused', reason: selected.reason };
      if (selected.digest !== writeRow.target_digest) {
        return { status: 'conflict', reason: 'readback target does not equal the frozen write target' };
      }
      const body = {
        protocolVersion: 1,
        bindingId: writeRow.binding_id,
        sessionId: writeRow.session_id,
        sourceUserSeq: writeRow.source_user_seq,
        acceptedTaskId: writeRow.accepted_task_id,
        workContractId: writeRow.work_contract_id,
        writeRequirementId: writeRow.requirement_id,
        readRequirementId: read.requirement_id,
        readLogicalToolCallId: read.logical_tool_call_id,
        readToolName: read.tool_name,
        readArgumentDigest: read.argument_digest,
        targetPointers: selected.pointers,
        targetDigest: selected.digest,
        schemaDigest: canonicalWriteEvidenceDigest(input.inputSchema),
        verificationContractId: writeRow.binding_id,
      };
      const id = `write-readback-binding:v1:${canonicalWriteEvidenceDigest(body)}`;
      const prior = db.prepare(`
        SELECT readback_binding_id FROM write_evidence_readback_bindings
         WHERE binding_id = ? AND read_logical_tool_call_id = ?
      `).get(writeRow.binding_id, read.logical_tool_call_id) as { readback_binding_id: string } | undefined;
      if (prior) return prior.readback_binding_id === id
        ? { status: 'replayed', readbackBindingId: id }
        : { status: 'conflict', reason: 'readback call already owns a different target binding' };
      db.prepare(`
        INSERT INTO write_evidence_readback_bindings
          (readback_binding_id, binding_id, session_id, source_user_seq,
           accepted_task_id, work_contract_id, write_requirement_id,
           read_requirement_id, read_logical_tool_call_id, read_tool_name,
           read_argument_digest, target_selector_json, target_digest,
           schema_digest, verification_contract_id, frozen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, writeRow.binding_id, writeRow.session_id, writeRow.source_user_seq,
        writeRow.accepted_task_id, writeRow.work_contract_id, writeRow.requirement_id,
        read.requirement_id, read.logical_tool_call_id, read.tool_name,
        read.argument_digest, JSON.stringify(selected.pointers), selected.digest,
        body.schemaDigest, writeRow.binding_id, new Date().toISOString(),
      );
      return { status: 'bound', readbackBindingId: id };
    });
    return tx.immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export interface HostDerivationSourceInput {
  requirementId: string;
  logicalToolCallId: string;
}

export type RecordDerivationResult =
  | { status: 'recorded' | 'replayed'; derivationId: string }
  | { status: 'missing' | 'refused' | 'conflict' | 'storage_error'; reason: string };

/** Record exact successful source handles used by a host-owned transform. */
export function recordDurableWriteDerivation(input: {
  bindingId: string;
  transformArtifactDigest: string;
  sources: readonly HostDerivationSourceInput[];
}): RecordDerivationResult {
  if (!DIGEST_RE.test(input.transformArtifactDigest)) {
    return { status: 'refused', reason: 'host transform artifact digest is invalid' };
  }
  const loaded = loadDurableWriteEvidenceBinding(input.bindingId);
  if (loaded.status !== 'ok') return { status: loaded.status, reason: loaded.reason } as RecordDerivationResult;
  const expected = [...loaded.binding.sourceRequirementIds].sort();
  const supplied = [...input.sources].sort((a, b) => a.requirementId.localeCompare(b.requirementId));
  if (
    supplied.length !== expected.length
    || supplied.length === 0
    || new Set(supplied.map((entry) => entry.requirementId)).size !== supplied.length
    || supplied.some((entry, index) => entry.requirementId !== expected[index])
  ) return { status: 'conflict', reason: 'derivation sources do not exactly cover frozen data dependencies' };
  const sourceFacts: Array<HostDerivationSourceInput & { resultHandleId: string; contentDigest: string }> = [];
  for (const source of supplied) {
    const result = redeemSuccessfulSettlementResultForHost({
      sessionId: loaded.binding.sessionId,
      sourceUserSeq: loaded.binding.sourceUserSeq,
      acceptedTaskId: loaded.binding.acceptedTaskId,
      logicalToolCallId: source.logicalToolCallId,
    });
    if (result.status !== 'ok') {
      return { status: result.status === 'storage_error' ? 'storage_error' : 'missing', reason: result.reason };
    }
    try {
      const db = openEventLog();
      const work = db.prepare(`
        SELECT requirement_id, effect_kind, contract_id
          FROM expected_work_call_bindings
         WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
      `).get(
        loaded.binding.sessionId,
        loaded.binding.sourceUserSeq,
        source.logicalToolCallId,
      ) as { requirement_id: string; effect_kind: string; contract_id: string } | undefined;
      if (
        !work
        || work.requirement_id !== source.requirementId
        || work.effect_kind !== 'read'
        || work.contract_id !== loaded.binding.workContractId
      ) return { status: 'conflict', reason: 'derivation source is not its exact frozen read requirement' };
    } catch (error) {
      return { status: 'storage_error', reason: boundedReason(error) };
    }
    sourceFacts.push({
      ...source,
      resultHandleId: result.value.resultHandleId,
      contentDigest: result.value.rawPayloadSha256,
    });
  }
  const body = {
    protocolVersion: 1,
    bindingId: loaded.binding.bindingId,
    sessionId: loaded.binding.sessionId,
    sourceUserSeq: loaded.binding.sourceUserSeq,
    acceptedTaskId: loaded.binding.acceptedTaskId,
    workContractId: loaded.binding.workContractId,
    requirementId: loaded.binding.requirementId,
    outputDigest: loaded.binding.writeInputDigest,
    transformArtifactDigest: input.transformArtifactDigest,
    sources: sourceFacts,
  };
  const semantic = canonicalWriteEvidenceDigest(body);
  const id = `write-derivation:v1:${semantic}`;
  try {
    const db = openEventLog();
    const tx = db.transaction((): RecordDerivationResult => {
      const prior = db.prepare('SELECT derivation_id, semantic_digest FROM write_evidence_derivations WHERE binding_id = ?')
        .get(input.bindingId) as { derivation_id: string; semantic_digest: string } | undefined;
      if (prior) return prior.derivation_id === id && prior.semantic_digest === semantic
        ? { status: 'replayed', derivationId: id }
        : { status: 'conflict', reason: 'write binding already owns a different derivation fact' };
      db.prepare(`
        INSERT INTO write_evidence_derivations
          (derivation_id, binding_id, session_id, source_user_seq,
           accepted_task_id, work_contract_id, requirement_id, output_digest,
           transform_artifact_digest, source_count, semantic_digest, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, loaded.binding.bindingId, loaded.binding.sessionId, loaded.binding.sourceUserSeq,
        loaded.binding.acceptedTaskId, loaded.binding.workContractId,
        loaded.binding.requirementId, loaded.binding.writeInputDigest,
        input.transformArtifactDigest, sourceFacts.length, semantic, new Date().toISOString(),
      );
      const insert = db.prepare(`
        INSERT INTO write_evidence_derivation_sources
          (derivation_id, session_id, source_user_seq, requirement_id,
           logical_tool_call_id, result_handle_id, content_digest)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const source of sourceFacts) insert.run(
        id, loaded.binding.sessionId, loaded.binding.sourceUserSeq,
        source.requirementId, source.logicalToolCallId,
        source.resultHandleId, source.contentDigest,
      );
      return { status: 'recorded', derivationId: id };
    });
    return tx.immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

type ExecutionSnapshotResult =
  | { status: 'recorded' | 'replayed'; snapshotId: string }
  | { status: 'not_ready' | 'missing' | 'conflict' | 'storage_error'; reason: string };

export function captureDurableWriteExecutionSnapshot(bindingId: string): ExecutionSnapshotResult {
  const loaded = loadDurableWriteEvidenceBinding(bindingId);
  if (loaded.status !== 'ok') return { status: loaded.status, reason: loaded.reason } as ExecutionSnapshotResult;
  let execution;
  try {
    execution = new ExecutionStore().getForSource(loaded.binding.sessionId, loaded.binding.sourceUserSeq);
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
  if (!execution) return { status: 'missing', reason: 'no execution is owned by this accepted source' };
  if (execution.status !== 'completed') {
    return { status: 'not_ready', reason: `exact-source execution is ${execution.status}` };
  }
  const openedExecutionIds = [execution.id];
  const executions = [{ executionId: execution.id, state: 'completed' as const }];
  const body = {
    protocolVersion: 1,
    bindingId,
    sessionId: loaded.binding.sessionId,
    sourceUserSeq: loaded.binding.sourceUserSeq,
    acceptedTaskId: loaded.binding.acceptedTaskId,
    openedExecutionIds,
    executions,
  };
  const semantic = canonicalWriteEvidenceDigest(body);
  const id = `write-snapshot:v1:${semantic}`;
  try {
    const db = openEventLog();
    const tx = db.transaction((): ExecutionSnapshotResult => {
      const prior = db.prepare('SELECT snapshot_id, semantic_digest FROM write_evidence_execution_snapshots WHERE binding_id = ?')
        .get(bindingId) as { snapshot_id: string; semantic_digest: string } | undefined;
      if (prior) return prior.snapshot_id === id && prior.semantic_digest === semantic
        ? { status: 'replayed', snapshotId: id }
        : { status: 'conflict', reason: 'write binding already owns another execution snapshot' };
      db.prepare(`
        INSERT INTO write_evidence_execution_snapshots
          (snapshot_id, binding_id, session_id, source_user_seq, accepted_task_id,
           executions_json, opened_ids_json, semantic_digest, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, bindingId, loaded.binding.sessionId, loaded.binding.sourceUserSeq,
        loaded.binding.acceptedTaskId, JSON.stringify(executions),
        JSON.stringify(openedExecutionIds), semantic, new Date().toISOString(),
      );
      return { status: 'recorded', snapshotId: id };
    });
    return tx.immediate();
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

function settlementFact(
  settlement: DurableLogicalCallSettlement,
  db: Database.Database,
): LogicalSettlementFact | null {
  const states = db.prepare(`
    SELECT physical_dispatch_id, ordinal, state
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
     ORDER BY ordinal
  `).all(
    settlement.identity.sessionId,
    settlement.identity.sourceUserSeq,
    settlement.identity.logicalToolCallId,
  ) as Array<{ physical_dispatch_id: string; ordinal: number; state: string }>;
  if (states.length !== settlement.crossings.length) return null;
  return {
    sessionId: settlement.identity.sessionId,
    sourceUserSeq: settlement.identity.sourceUserSeq,
    acceptedTaskId: settlement.identity.acceptedTaskId,
    logicalToolCallId: settlement.identity.logicalToolCallId,
    argumentDigest: settlement.argumentDigest,
    executionKind: settlement.executionKind,
    outcomeKind: settlement.outcome.kind,
    ...(settlement.resultHandleId ? { resultHandleId: settlement.resultHandleId } : {}),
    crossings: states.map((row) => ({
      physicalDispatchId: row.physical_dispatch_id,
      ordinal: row.ordinal,
      state: row.state as LogicalSettlementFact['crossings'][number]['state'],
    })),
  };
}

function rawResultFact(input: {
  binding: FrozenWriteEvidenceBindingV1;
  logicalToolCallId: string;
}): BoundRawResultFact | undefined {
  const result = redeemSuccessfulSettlementResultForHost({
    sessionId: input.binding.sessionId,
    sourceUserSeq: input.binding.sourceUserSeq,
    acceptedTaskId: input.binding.acceptedTaskId,
    logicalToolCallId: input.logicalToolCallId,
  });
  if (result.status !== 'ok') return undefined;
  return {
    sessionId: input.binding.sessionId,
    sourceUserSeq: input.binding.sourceUserSeq,
    acceptedTaskId: input.binding.acceptedTaskId,
    logicalToolCallId: input.logicalToolCallId,
    physicalDispatchId: result.value.physicalDispatchId,
    resultHandleId: result.value.resultHandleId,
    rawPayloadJson: result.value.rawPayloadJson,
    rawPayloadSha256: result.value.rawPayloadSha256,
    rawByteCount: result.value.rawByteCount,
  };
}

export type DurableWriteEvidenceInputState =
  | { status: 'ok'; input: WriteEvidenceInput; manifest: ObligationManifest }
  | { status: 'missing' | 'corrupt' | 'conflict' | 'not_ready' | 'storage_error'; reason: string };

/** Rehydrate every fact; no caller supplies an outcome or a model verdict. */
export function loadDurableWriteEvidenceInput(input: {
  bindingId: string;
  manifestId: string;
  nodeId: string;
}): DurableWriteEvidenceInputState {
  const loaded = loadDurableWriteEvidenceBinding(input.bindingId);
  if (loaded.status !== 'ok') return { status: loaded.status, reason: loaded.reason };
  const manifestState = loadManifestState(loaded.binding.sessionId, loaded.binding.sourceUserSeq);
  if (manifestState.status !== 'ok') {
    return { status: manifestState.status === 'missing' ? 'missing' : 'corrupt', reason: manifestState.status === 'missing' ? 'manifest is missing' : manifestState.reason };
  }
  const manifest = manifestState.manifest;
  if (manifest.manifestId !== input.manifestId) return { status: 'conflict', reason: 'another manifest is in force' };
  const node = manifest.nodes.find((entry) => entry.nodeId === input.nodeId);
  if (!node) return { status: 'missing', reason: 'manifest write node is missing' };
  if (
    node.operationId !== loaded.binding.requirementId
    || node.resolvedTool !== (openEventLog().prepare('SELECT tool_name FROM write_evidence_bindings WHERE binding_id = ?').get(input.bindingId) as { tool_name: string }).tool_name
    || node.effectKind !== 'external_write'
    || node.reversibility !== loaded.binding.reversibility
  ) return { status: 'corrupt', reason: 'manifest write node conflicts with the pre-dispatch binding' };

  try {
    const db = openEventLog();
    const settlement = redeemDurableLogicalCallSettlementForHost({
      sessionId: loaded.binding.sessionId,
      sourceUserSeq: loaded.binding.sourceUserSeq,
      acceptedTaskId: loaded.binding.acceptedTaskId,
      logicalToolCallId: loaded.binding.logicalToolCallId,
    });
    if (settlement.status !== 'ok') {
      return { status: settlement.status === 'storage_error' ? 'storage_error' : settlement.status === 'missing' ? 'missing' : 'corrupt', reason: settlement.reason };
    }
    const writeSettlement = settlementFact(settlement.settlement, db);
    if (!writeSettlement) return { status: 'corrupt', reason: 'write crossing states conflict with settlement authority' };
    const lifecycleRows = db.prepare(`
      SELECT r.reservation_id, r.session_id, r.source_user_seq, r.accepted_task_id,
             r.logical_tool_call_id, r.physical_dispatch_id, r.target_digest,
             r.write_input_digest, o.outcome_id, o.kind, o.result_handle_id
        FROM write_evidence_dispatch_reservations r
        LEFT JOIN write_evidence_dispatch_outcomes o ON o.reservation_id = r.reservation_id
       WHERE r.binding_id = ? ORDER BY r.ordinal
    `).all(input.bindingId) as Array<Record<string, unknown>>;
    const writeLifecycle: WriteLifecycleFact[] = [];
    for (const row of lifecycleRows) {
      writeLifecycle.push({
        kind: 'reservation',
        eventId: String(row.reservation_id),
        sessionId: String(row.session_id),
        sourceUserSeq: Number(row.source_user_seq),
        acceptedTaskId: String(row.accepted_task_id),
        logicalToolCallId: String(row.logical_tool_call_id),
        physicalDispatchId: String(row.physical_dispatch_id),
        targetDigest: String(row.target_digest),
        writeInputDigest: String(row.write_input_digest),
      });
      if (typeof row.outcome_id === 'string') {
        writeLifecycle.push({
          kind: row.kind as 'succeeded' | 'failed' | 'orphaned',
          eventId: row.outcome_id,
          reservationEventId: String(row.reservation_id),
          sessionId: String(row.session_id),
          sourceUserSeq: Number(row.source_user_seq),
          acceptedTaskId: String(row.accepted_task_id),
          logicalToolCallId: String(row.logical_tool_call_id),
          physicalDispatchId: String(row.physical_dispatch_id),
          targetDigest: String(row.target_digest),
          writeInputDigest: String(row.write_input_digest),
          ...(typeof row.result_handle_id === 'string' ? { resultHandleId: row.result_handle_id } : {}),
        });
      }
    }

    let readback: ReadbackEvidenceFact | undefined;
    const readbackRows = db.prepare(`
      SELECT * FROM write_evidence_readback_bindings WHERE binding_id = ?
    `).all(input.bindingId) as Array<Record<string, unknown>>;
    const successfulReadbacks: ReadbackEvidenceFact[] = [];
    for (const row of readbackRows) {
      const logicalToolCallId = String(row.read_logical_tool_call_id);
      const readSettlement = redeemDurableLogicalCallSettlementForHost({
        sessionId: loaded.binding.sessionId,
        sourceUserSeq: loaded.binding.sourceUserSeq,
        acceptedTaskId: loaded.binding.acceptedTaskId,
        logicalToolCallId,
      });
      if (readSettlement.status !== 'ok') continue;
      const fact = settlementFact(readSettlement.settlement, db);
      const result = rawResultFact({ binding: loaded.binding, logicalToolCallId });
      if (!fact || !result) continue;
      successfulReadbacks.push({
        targetDigest: String(row.target_digest),
        verificationContractId: String(row.verification_contract_id),
        writeLogicalToolCallId: loaded.binding.logicalToolCallId,
        settlement: fact,
        result,
      });
    }
    if (successfulReadbacks.length === 1) readback = successfulReadbacks[0];
    else if (successfulReadbacks.length > 1) {
      return { status: 'corrupt', reason: 'multiple successful readbacks claim one write binding' };
    }

    let derivation: HostDerivationFact | undefined;
    const derivationRow = db.prepare('SELECT * FROM write_evidence_derivations WHERE binding_id = ?')
      .get(input.bindingId) as Record<string, unknown> | undefined;
    if (derivationRow) {
      const sources = db.prepare(`
        SELECT requirement_id, logical_tool_call_id, result_handle_id, content_digest
          FROM write_evidence_derivation_sources WHERE derivation_id = ?
         ORDER BY requirement_id
      `).all(derivationRow.derivation_id) as Array<Record<string, unknown>>;
      for (const source of sources) {
        const logicalToolCallId = String(source.logical_tool_call_id);
        const redeemed = redeemSuccessfulSettlementResultForHost({
          sessionId: loaded.binding.sessionId,
          sourceUserSeq: loaded.binding.sourceUserSeq,
          acceptedTaskId: loaded.binding.acceptedTaskId,
          logicalToolCallId,
        });
        const sourceWork = db.prepare(`
          SELECT requirement_id, effect_kind, contract_id
            FROM expected_work_call_bindings
           WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
        `).get(
          loaded.binding.sessionId,
          loaded.binding.sourceUserSeq,
          logicalToolCallId,
        ) as { requirement_id: string; effect_kind: string; contract_id: string } | undefined;
        if (
          redeemed.status !== 'ok'
          || redeemed.value.resultHandleId !== source.result_handle_id
          || redeemed.value.rawPayloadSha256 !== source.content_digest
          || !sourceWork
          || sourceWork.requirement_id !== source.requirement_id
          || sourceWork.effect_kind !== 'read'
          || sourceWork.contract_id !== loaded.binding.workContractId
        ) return { status: 'corrupt', reason: 'derivation source no longer redeems to its exact read result' };
      }
      const body = {
        protocolVersion: 1,
        bindingId: loaded.binding.bindingId,
        sessionId: loaded.binding.sessionId,
        sourceUserSeq: loaded.binding.sourceUserSeq,
        acceptedTaskId: loaded.binding.acceptedTaskId,
        workContractId: loaded.binding.workContractId,
        requirementId: loaded.binding.requirementId,
        outputDigest: String(derivationRow.output_digest),
        transformArtifactDigest: String(derivationRow.transform_artifact_digest),
        sources: sources.map((source) => ({
          requirementId: String(source.requirement_id),
          logicalToolCallId: String(source.logical_tool_call_id),
          resultHandleId: String(source.result_handle_id),
          contentDigest: String(source.content_digest),
        })),
      };
      if (
        canonicalWriteEvidenceDigest(body) !== derivationRow.semantic_digest
        || derivationRow.derivation_id !== `write-derivation:v1:${String(derivationRow.semantic_digest)}`
      ) return { status: 'corrupt', reason: 'derivation fact does not match its content address' };
      derivation = {
        kind: 'host_deterministic_transform',
        sessionId: loaded.binding.sessionId,
        sourceUserSeq: loaded.binding.sourceUserSeq,
        acceptedTaskId: loaded.binding.acceptedTaskId,
        workContractId: loaded.binding.workContractId,
        requirementId: loaded.binding.requirementId,
        sourceEvidence: sources.map((source) => ({
          requirementId: String(source.requirement_id),
          receiptId: String(source.result_handle_id),
          contentDigest: String(source.content_digest),
        })),
        outputDigest: String(derivationRow.output_digest),
        transformArtifactDigest: String(derivationRow.transform_artifact_digest),
      };
    }

    let executionSet: WriteEvidenceInput['executionSet'];
    const snapshot = db.prepare('SELECT * FROM write_evidence_execution_snapshots WHERE binding_id = ?')
      .get(input.bindingId) as Record<string, unknown> | undefined;
    if (snapshot) {
      const openedExecutionIds = JSON.parse(String(snapshot.opened_ids_json)) as string[];
      const executions = JSON.parse(String(snapshot.executions_json)) as Array<{ executionId: string; state: 'active' | 'completed' | 'failed' | 'cancelled' }>;
      const body = {
        protocolVersion: 1,
        bindingId: loaded.binding.bindingId,
        sessionId: loaded.binding.sessionId,
        sourceUserSeq: loaded.binding.sourceUserSeq,
        acceptedTaskId: loaded.binding.acceptedTaskId,
        openedExecutionIds,
        executions,
      };
      if (
        canonicalWriteEvidenceDigest(body) !== snapshot.semantic_digest
        || snapshot.snapshot_id !== `write-snapshot:v1:${String(snapshot.semantic_digest)}`
      ) return { status: 'corrupt', reason: 'execution snapshot does not match its content address' };
      const currentExecution = new ExecutionStore().getForSource(
        loaded.binding.sessionId,
        loaded.binding.sourceUserSeq,
      );
      if (
        !currentExecution
        || currentExecution.status !== 'completed'
        || openedExecutionIds.length !== 1
        || openedExecutionIds[0] !== currentExecution.id
        || executions.length !== 1
        || executions[0]?.executionId !== currentExecution.id
        || executions[0]?.state !== 'completed'
      ) return { status: 'corrupt', reason: 'execution snapshot no longer redeems to exact completed execution authority' };
      executionSet = {
        sessionId: loaded.binding.sessionId,
        sourceUserSeq: loaded.binding.sourceUserSeq,
        acceptedTaskId: loaded.binding.acceptedTaskId,
        openedExecutionIds,
        executions,
      };
    }

    const writeObligations: readonly WriteEvidenceObligation[] = [
      'derivation_from_current_source', 'commit_effect', 'verify_committed_readback',
      'stale_destination_reconciled', 'verify_committed_receipt', 'execution_terminal',
    ];
    const obligations = node.obligations.filter(
      (entry): entry is WriteEvidenceObligation => writeObligations.includes(entry as WriteEvidenceObligation),
    );
    if (obligations.length !== node.obligations.length) {
      return { status: 'corrupt', reason: 'manifest write node contains an unsupported obligation' };
    }
    const scope: WriteEvidenceManifestScopeV1 = {
      manifestId: manifest.manifestId,
      nodeId: node.nodeId,
      obligations,
    };
    return {
      status: 'ok',
      manifest,
      input: {
        binding: loaded.binding,
        scope,
        writeInput: loaded.writeInput,
        writeSettlement,
        writeResult: rawResultFact({ binding: loaded.binding, logicalToolCallId: loaded.binding.logicalToolCallId }),
        writeLifecycle,
        ...(readback ? { readback } : {}),
        ...(derivation ? { derivation } : {}),
        ...(executionSet ? { executionSet } : {}),
      },
    };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

function obligationKey(request: SatisfactionRequest): string {
  return [request.sessionId, request.sourceUserSeq, request.manifestId, request.nodeId, request.obligation].join('|');
}

export type PersistWriteProofResult =
  | { status: 'proved' | 'partial' | 'replayed'; proofIds: string[]; missing: string[] }
  | { status: 'missing' | 'not_ready' | 'conflict' | 'storage_error'; reason: string };

/** Evaluate host facts, then atomically persist each proof with its transition. */
export function proveAndSatisfyDurableWriteEvidence(input: {
  bindingId: string;
  manifestId: string;
  nodeId: string;
}): PersistWriteProofResult {
  const snapshot = captureDurableWriteExecutionSnapshot(input.bindingId);
  if (snapshot.status !== 'recorded' && snapshot.status !== 'replayed') {
    const failure = snapshot as Exclude<ExecutionSnapshotResult, { status: 'recorded' | 'replayed' }>;
    return { status: failure.status === 'not_ready' ? 'not_ready' : failure.status, reason: failure.reason } as PersistWriteProofResult;
  }
  const loaded = loadDurableWriteEvidenceInput(input);
  if (loaded.status !== 'ok') return { status: loaded.status, reason: loaded.reason } as PersistWriteProofResult;
  const evaluation = evaluateWriteEvidence(loaded.input);
  const proved = evaluation.verdicts.filter((entry) => entry.status === 'proved');
  const unproved = evaluation.verdicts.filter((entry) => entry.status === 'unproven');
  const writeResult = loaded.input.writeResult;
  if (!writeResult) return { status: 'not_ready', reason: 'write settlement result is not redeemable' };

  const mirrors: EventRow[] = [];
  try {
    const db = openEventLog();
    const tx = db.transaction((): PersistWriteProofResult => {
      const authority = db.prepare(`
        SELECT accepted_task_id, manifest_id, state FROM accepted_task_authority
         WHERE session_id = ? AND source_user_seq = ?
      `).get(
        loaded.input.binding.sessionId,
        loaded.input.binding.sourceUserSeq,
      ) as { accepted_task_id: string; manifest_id: string | null; state: string } | undefined;
      if (
        !authority
        || authority.accepted_task_id !== loaded.input.binding.acceptedTaskId
        || authority.manifest_id !== input.manifestId
        || authority.state !== 'manifested_verifying'
      ) return { status: 'conflict', reason: 'write proof no longer has exact manifested authority' };

      const persisted = new Set((db.prepare(`
        SELECT node_id, obligation FROM obligation_transitions
         WHERE session_id = ? AND source_user_seq = ? AND manifest_id = ?
      `).all(
        loaded.input.binding.sessionId,
        loaded.input.binding.sourceUserSeq,
        input.manifestId,
      ) as Array<{ node_id: string; obligation: string }>).map((row) => `${row.node_id}|${row.obligation}`));
      const proofIds: string[] = [];
      let replayed = 0;
      for (const verdict of proved) {
        const proof = verdict.proof;
        const declaration = declaredObligation(loaded.manifest, input.nodeId, verdict.obligation);
        if (!declaration) return { status: 'conflict', reason: `manifest does not declare ${verdict.obligation}` };
        const blocked = declaration.dependsOn.some((dependency) =>
          !persisted.has(`${dependency.nodeId}|${dependency.obligation}`));
        if (blocked) continue;
        const key = obligationKey({
          sessionId: proof.sessionId,
          sourceUserSeq: proof.sourceUserSeq,
          manifestId: proof.manifestId,
          nodeId: proof.nodeId,
          obligation: proof.obligation,
          receiptId: proof.proofId,
          physicalAttemptId: writeResult.physicalDispatchId,
        });
        const existingTransition = db.prepare(`
          SELECT obligation_key, receipt_id, physical_attempt_id,
                 logical_tool_call_id, physical_dispatch_id
            FROM obligation_transitions
           WHERE session_id = ? AND source_user_seq = ? AND manifest_id = ?
             AND node_id = ? AND obligation = ?
        `).get(
          proof.sessionId,
          proof.sourceUserSeq,
          proof.manifestId,
          proof.nodeId,
          proof.obligation,
        ) as Record<string, unknown> | undefined;
        if (existingTransition && (
          existingTransition.obligation_key !== key
          || existingTransition.receipt_id !== proof.proofId
          || existingTransition.physical_attempt_id !== writeResult.physicalDispatchId
          || existingTransition.logical_tool_call_id !== proof.logicalToolCallId
          || existingTransition.physical_dispatch_id !== writeResult.physicalDispatchId
        )) return { status: 'conflict', reason: `obligation already owns another receipt for ${verdict.obligation}` };
        const prior = db.prepare(`
          SELECT p.proof_json, t.receipt_id, t.physical_attempt_id
            FROM write_evidence_proofs p
            LEFT JOIN obligation_transitions t ON t.obligation_key = ?
           WHERE p.proof_id = ?
        `).get(key, proof.proofId) as {
          proof_json: string;
          receipt_id: string | null;
          physical_attempt_id: string | null;
        } | undefined;
        if (existingTransition && !prior) {
          return { status: 'conflict', reason: `obligation transition has no matching durable proof for ${verdict.obligation}` };
        }
        if (prior) {
          if (
            canonicalWriteEvidenceDigest(JSON.parse(prior.proof_json) as unknown) !== canonicalWriteEvidenceDigest(proof)
            || prior.receipt_id !== proof.proofId
            || prior.physical_attempt_id !== writeResult.physicalDispatchId
          ) return { status: 'conflict', reason: `stored proof conflicts for ${verdict.obligation}` };
          proofIds.push(proof.proofId);
          persisted.add(`${proof.nodeId}|${proof.obligation}`);
          replayed += 1;
          continue;
        }
        const mirror = insertInternalEventInTransaction(db, {
          sessionId: proof.sessionId,
          turn: 0,
          role: 'system',
          type: 'write_evidence_proved',
          data: {
            proofId: proof.proofId,
            sourceUserSeq: proof.sourceUserSeq,
            acceptedTaskId: proof.acceptedTaskId,
            manifestId: proof.manifestId,
            nodeId: proof.nodeId,
            obligation: proof.obligation,
            bindingId: proof.bindingId,
            logicalToolCallId: proof.logicalToolCallId,
            physicalDispatchId: writeResult.physicalDispatchId,
          },
        });
        db.prepare(`
          INSERT INTO write_evidence_proofs
            (proof_id, protocol_version, binding_id, session_id, source_user_seq,
             accepted_task_id, work_contract_id, manifest_id, node_id,
             requirement_id, obligation, logical_tool_call_id,
             anchor_physical_dispatch_id, target_digest,
             physical_dispatch_ids_json, evidence_digests_json, proof_json,
             receipt_event_id, issued_at)
          VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          proof.proofId, proof.bindingId, proof.sessionId, proof.sourceUserSeq,
          proof.acceptedTaskId, proof.workContractId, proof.manifestId,
          proof.nodeId, proof.requirementId, proof.obligation,
          proof.logicalToolCallId, writeResult.physicalDispatchId,
          proof.targetDigest, JSON.stringify(proof.physicalDispatchIds),
          JSON.stringify(proof.evidenceDigests), JSON.stringify(proof),
          mirror.id, mirror.createdAt,
        );
        db.prepare(`
          INSERT INTO obligation_transitions
            (obligation_key, session_id, source_user_seq, manifest_id, node_id,
             obligation, receipt_id, physical_attempt_id, logical_tool_call_id,
             physical_dispatch_id, claimed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          key, proof.sessionId, proof.sourceUserSeq, proof.manifestId,
          proof.nodeId, proof.obligation, proof.proofId,
          writeResult.physicalDispatchId, proof.logicalToolCallId,
          writeResult.physicalDispatchId, mirror.createdAt,
        );
        mirrors.push(mirror);
        proofIds.push(proof.proofId);
        persisted.add(`${proof.nodeId}|${proof.obligation}`);
      }
      const missing = loaded.input.scope.obligations.filter((obligation) =>
        !persisted.has(`${input.nodeId}|${obligation}`));
      return missing.length === 0
        ? { status: replayed === proofIds.length ? 'replayed' : 'proved', proofIds, missing }
        : { status: 'partial', proofIds, missing: [
            ...new Set([
              ...missing,
              ...unproved.map((entry) => `${entry.obligation}:${entry.reason}`),
            ]),
          ] };
    });
    const result = tx.immediate();
    for (const mirror of mirrors) publishCommittedInternalEvent(mirror);
    return result;
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

export type WriteEvidenceProofRedemption =
  | { status: 'ok'; proof: NormalizedWriteEvidenceProofV1 }
  | { status: 'missing' | 'corrupt' | 'storage_error'; reason: string };

/** Full restart-safe redemption: recompute the proof from current durable facts. */
export function redeemDurableWriteEvidenceProof(input: {
  sessionId: string;
  sourceUserSeq: number;
  receiptId: string;
  manifestId?: string;
  nodeId?: string;
  obligation?: string;
  physicalDispatchId?: string;
}): WriteEvidenceProofRedemption {
  try {
    const db = openEventLog();
    const row = db.prepare('SELECT * FROM write_evidence_proofs WHERE proof_id = ?')
      .get(input.receiptId) as Record<string, unknown> | undefined;
    if (!row) return { status: 'missing', reason: 'write evidence proof is missing' };
    if (
      row.session_id !== input.sessionId
      || row.source_user_seq !== input.sourceUserSeq
      || (input.manifestId !== undefined && row.manifest_id !== input.manifestId)
      || (input.nodeId !== undefined && row.node_id !== input.nodeId)
      || (input.obligation !== undefined && row.obligation !== input.obligation)
      || (input.physicalDispatchId !== undefined && row.anchor_physical_dispatch_id !== input.physicalDispatchId)
    ) return { status: 'corrupt', reason: 'write proof belongs to different authority' };
    const loaded = loadDurableWriteEvidenceInput({
      bindingId: String(row.binding_id),
      manifestId: String(row.manifest_id),
      nodeId: String(row.node_id),
    });
    if (loaded.status !== 'ok') return { status: loaded.status === 'storage_error' ? 'storage_error' : 'corrupt', reason: loaded.reason };
    const expected = evaluateWriteEvidence(loaded.input).verdicts.find((verdict) =>
      verdict.obligation === row.obligation && verdict.status === 'proved');
    if (!expected || expected.status !== 'proved') {
      return { status: 'corrupt', reason: 'current durable facts no longer prove this obligation' };
    }
    let stored: NormalizedWriteEvidenceProofV1;
    try { stored = JSON.parse(String(row.proof_json)) as NormalizedWriteEvidenceProofV1; } catch {
      return { status: 'corrupt', reason: 'write proof JSON is unreadable' };
    }
    if (
      !normalizedWriteEvidenceProofIsValid(stored)
      || stored.proofId !== input.receiptId
      || canonicalWriteEvidenceDigest(stored) !== canonicalWriteEvidenceDigest(expected.proof)
      || row.target_digest !== stored.targetDigest
      || row.logical_tool_call_id !== stored.logicalToolCallId
      || row.requirement_id !== stored.requirementId
    ) return { status: 'corrupt', reason: 'write proof does not match its content address or current evaluation' };
    const transition = db.prepare(`
      SELECT receipt_id, physical_attempt_id, logical_tool_call_id, physical_dispatch_id
        FROM obligation_transitions
       WHERE session_id = ? AND source_user_seq = ? AND manifest_id = ?
         AND node_id = ? AND obligation = ?
    `).get(
      input.sessionId, input.sourceUserSeq, row.manifest_id, row.node_id, row.obligation,
    ) as Record<string, unknown> | undefined;
    const event = db.prepare('SELECT session_id, type, data_json FROM events WHERE id = ?')
      .get(row.receipt_event_id) as { session_id: string; type: string; data_json: string } | undefined;
    let mirror: Record<string, unknown> | null = null;
    try { mirror = event ? JSON.parse(event.data_json) as Record<string, unknown> : null; } catch { mirror = null; }
    if (
      !transition
      || transition.receipt_id !== input.receiptId
      || transition.physical_attempt_id !== row.anchor_physical_dispatch_id
      || transition.logical_tool_call_id !== row.logical_tool_call_id
      || transition.physical_dispatch_id !== row.anchor_physical_dispatch_id
      || event?.session_id !== input.sessionId
      || event.type !== 'write_evidence_proved'
      || mirror?.proofId !== input.receiptId
      || mirror?.manifestId !== row.manifest_id
      || mirror?.nodeId !== row.node_id
      || mirror?.obligation !== row.obligation
    ) return { status: 'corrupt', reason: 'write proof transition or event mirror is inconsistent' };
    return { status: 'ok', proof: stored };
  } catch (error) {
    return { status: 'storage_error', reason: boundedReason(error) };
  }
}

/** Type-only export for host schema mapping authors. */
export type { ExactRecordProjectionV1 };
