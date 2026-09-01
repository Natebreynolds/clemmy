import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

import {
  ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE,
  ASYNC_READ_REFINEMENT_INTENTS_TABLE,
  ASYNC_READ_REFINEMENT_START_RECEIPTS_TABLE,
  ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE,
} from './async-read-refinement-schema.js';
import { parseAsyncReadContinuationRecipe, type AsyncReadContinuationRecipeV1 } from './async-read-continuation-contract.js';
import { getKillRequest, getTurnGraphEventForSource, openEventLog } from './eventlog.js';
import {
  canonicalCatalogIdentityOf,
  catalogIdentitiesEqual,
  freezeCatalogSnapshotForSource,
  loadSealedNodeBinding,
} from './host-capability-catalog-factory.js';
import { loadHostCallCapabilityBinding } from './host-call-capability-binding.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import { redeemDurableLogicalCallSettlementForHost } from './logical-call-settlement-store.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import {
  prepareRecentArticleBatchCandidates,
  VERIFIED_RECENT_ARTICLES_PROTOCOL,
  verifyRecentArticleDateEvidence,
  type RecentArticleCandidateV1,
  type VerifiedRecentArticlesV1,
} from './recent-article-date-evidence.js';

const SHA256 = /^[a-f0-9]{64}$/u;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function record(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseItems(value: string): Array<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => record(item))
      ? parsed as Array<Record<string, unknown>>
      : null;
  } catch { return null; }
}

function boundedReason(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 300) || 'async read refinement authority is unavailable';
}

export interface PreparedAsyncReadRefinementIntentV1 {
  readonly version: 1;
  readonly sessionId: string;
  readonly sourceUserSeq: number;
  readonly acceptedTaskId: string;
  readonly startLogicalToolCallId: string;
  readonly requirementId: string;
  readonly recipe: AsyncReadContinuationRecipeV1;
  readonly sourceLogicalToolCallId: string;
  readonly sourceResultHandleId: string;
  readonly sourceProjectionCallId: string;
  readonly sourceProjectionDigest: string;
  readonly candidates: readonly RecentArticleCandidateV1[];
  readonly candidateDigest: string;
  readonly acceptedAt: string;
  readonly maxAgeDays: number;
  readonly minDistinctRecords: number;
}

export interface DurableAsyncReadRefinementOwnerV1 {
  readonly intent: PreparedAsyncReadRefinementIntentV1;
  readonly startArgumentDigest: string;
  readonly providerStartLogicalToolCallId: string | null;
  readonly jobId: string | null;
  readonly startRecordedAt: string | null;
  readonly completedEvidence: VerifiedRecentArticlesV1 | null;
  readonly terminalGate: AsyncReadRefinementTerminalGateV1 | null;
}

export const ASYNC_READ_REFINEMENT_TERMINAL_PROTOCOL =
  'clementine.async_read_refinement_terminal.v1' as const;

export type AsyncReadRefinementTerminalKind =
  | 'insufficient_evidence'
  | 'provider_failed'
  | 'provider_cancelled'
  | 'deadline_exhausted'
  | 'attempts_exhausted'
  | 'user_cancelled';

export interface AsyncReadRefinementTerminalGateV1 {
  readonly protocol: typeof ASYNC_READ_REFINEMENT_TERMINAL_PROTOCOL;
  readonly status: 'needs_scope';
  readonly terminalKind: AsyncReadRefinementTerminalKind;
  readonly reason: string;
  readonly options: readonly [
    'Retry a materially different query within the same 30-day window',
    'Change the content brief',
    'Pause this task without creating a Workspace',
  ];
}

const ASYNC_READ_SCOPE_OPTIONS = [
  'Retry a materially different query within the same 30-day window',
  'Change the content brief',
  'Pause this task without creating a Workspace',
] as const;

function terminalGate(input: {
  kind: AsyncReadRefinementTerminalKind;
  reason: string;
  recordedAt?: string;
}): AsyncReadRefinementTerminalGateV1 {
  return {
    protocol: ASYNC_READ_REFINEMENT_TERMINAL_PROTOCOL,
    status: 'needs_scope',
    terminalKind: input.kind,
    reason: input.reason,
    options: ASYNC_READ_SCOPE_OPTIONS,
  };
}

export type PrepareAsyncReadRefinementIntentResult =
  | { status: 'prepared'; intent: PreparedAsyncReadRefinementIntentV1 }
  | { status: 'not_applicable' }
  | { status: 'refused'; reason: string; canonicalRecordIds?: readonly string[] };

interface WorkOperation {
  id: string;
  effect: string;
  dependsOn: string[];
  dataFrom: string[];
  cardinality: { kind: string };
}

function contractOperations(value: string): WorkOperation[] | null {
  try {
    const parsed = JSON.parse(value) as { operations?: unknown[] };
    if (!Array.isArray(parsed.operations)) return null;
    const out: WorkOperation[] = [];
    for (const item of parsed.operations) {
      const row = record(item);
      const cardinality = row ? record(row.cardinality) : null;
      if (
        !row
        || typeof row.id !== 'string'
        || typeof row.effect !== 'string'
        || !Array.isArray(row.dependsOn)
        || !row.dependsOn.every((entry) => typeof entry === 'string')
        || !Array.isArray(row.dataFrom)
        || !row.dataFrom.every((entry) => typeof entry === 'string')
        || typeof cardinality?.kind !== 'string'
      ) return null;
      out.push({
        id: row.id,
        effect: row.effect,
        dependsOn: row.dependsOn as string[],
        dataFrom: row.dataFrom as string[],
        cardinality: { kind: cardinality.kind },
      });
    }
    return out;
  } catch { return null; }
}

/** Predispatch S→R source gate. It runs before expected-work admission, so a
 * bad model nomination consumes no R attempt and crosses no provider edge. */
export function prepareAsyncReadRefinementIntentBeforeAdmission(input: {
  db?: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  startLogicalToolCallId: string;
  requirementId: string;
  declaredSourceCallIds: unknown;
  declaredSourceRecordIds: unknown;
  providerOperationId: string | null;
  providerArguments: unknown;
}): PrepareAsyncReadRefinementIntentResult {
  if (input.providerOperationId !== 'FIRECRAWL_BATCH_SCRAPE') return { status: 'not_applicable' };
  try {
    const db = input.db ?? openEventLog();
    const binding = loadSealedNodeBinding(input.sessionId, input.sourceUserSeq, input.requirementId);
    const recipe = binding?.asyncRead ? parseAsyncReadContinuationRecipe(binding.asyncRead) : null;
    if (
      !binding
      || !recipe
      || recipe.acceptedTaskId !== input.acceptedTaskId
      || recipe.ownerRequirementId !== input.requirementId
      || binding.providerOperationId !== 'FIRECRAWL_BATCH_SCRAPE'
    ) return { status: 'refused', reason: 'batch scrape requirement has no exact sealed async-read owner' };

    const contracts = db.prepare(`
      SELECT accepted_task_id, contract_id, contract_json
        FROM accepted_task_work_contracts
       WHERE session_id = ? AND source_user_seq = ?
    `).all(input.sessionId, input.sourceUserSeq) as Array<{
      accepted_task_id: string; contract_id: string; contract_json: string;
    }>;
    if (
      contracts.length !== 1
      || contracts[0]!.accepted_task_id !== input.acceptedTaskId
      || contracts[0]!.contract_id !== recipe.workContractId
    ) return { status: 'refused', reason: 'batch scrape work contract is missing or contradictory' };
    const operations = contractOperations(contracts[0]!.contract_json);
    const start = operations?.find((operation) => operation.id === input.requirementId);
    if (
      !start
      || start.effect !== 'read'
      || start.cardinality.kind !== 'once'
      || start.dataFrom.length !== 0
      || start.dependsOn.length !== 1
    ) return { status: 'refused', reason: 'batch scrape is not one exact read successor' };
    const sourceRequirementId = start.dependsOn[0]!;
    const source = operations!.find((operation) => operation.id === sourceRequirementId);
    if (!source || source.effect !== 'read' || source.dataFrom.length !== 0) {
      return { status: 'refused', reason: 'batch scrape predecessor is not one exact settled Search read' };
    }
    if (
      !Array.isArray(input.declaredSourceCallIds)
      || input.declaredSourceCallIds.length !== 1
      || typeof input.declaredSourceCallIds[0] !== 'string'
    ) return { status: 'refused', reason: 'batch scrape must nominate exactly one model-visible Search result' };

    const sourceCallId = input.declaredSourceCallIds[0];
    const projections = db.prepare(`
      SELECT call_id, settlement_logical_tool_call_id, result_class,
             result_item_bytes, result_item_sha256
        FROM logical_model_result_projection_receipts
       WHERE session_id = ? AND source_user_seq = ? AND call_id = ?
    `).all(input.sessionId, input.sourceUserSeq, sourceCallId) as Array<{
      call_id: string;
      settlement_logical_tool_call_id: string;
      result_class: string;
      result_item_bytes: number;
      result_item_sha256: string;
    }>;
    if (projections.length !== 1 || !['text', 'structured'].includes(projections[0]!.result_class)) {
      return { status: 'refused', reason: 'batch scrape named Search projection is missing or ambiguous' };
    }
    const projection = projections[0]!;
    const sourceBinding = db.prepare(`
      SELECT b.accepted_task_id, b.contract_id, b.requirement_id, b.logical_tool_call_id,
             s.result_handle_id
        FROM expected_work_call_bindings b
        JOIN logical_call_settlements s
          ON s.session_id = b.session_id
         AND s.source_user_seq = b.source_user_seq
         AND s.logical_tool_call_id = b.logical_tool_call_id
       WHERE b.session_id = ? AND b.source_user_seq = ?
         AND b.logical_tool_call_id = ? AND b.requirement_id = ?
         AND b.effect_kind = 'read' AND s.outcome_kind = 'succeeded'
         AND s.continues_requirement = 0 AND s.requires_reconciliation = 0
         AND s.result_handle_id IS NOT NULL
    `).get(
      input.sessionId,
      input.sourceUserSeq,
      projection.settlement_logical_tool_call_id,
      sourceRequirementId,
    ) as {
      accepted_task_id: string; contract_id: string; requirement_id: string;
      logical_tool_call_id: string; result_handle_id: string;
    } | undefined;
    if (
      !sourceBinding
      || sourceBinding.accepted_task_id !== input.acceptedTaskId
      || sourceBinding.contract_id !== recipe.workContractId
    ) return { status: 'refused', reason: 'batch scrape named result is not its exact settled Search predecessor' };
    const redeemed = redeemSuccessfulSettlementResultForHost({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: input.acceptedTaskId,
      logicalToolCallId: sourceBinding.logical_tool_call_id,
    });
    if (redeemed.status !== 'ok') {
      return { status: 'refused', reason: `batch scrape Search result cannot be redeemed: ${redeemed.reason}` };
    }

    const batches = db.prepare(`
      SELECT accepted_task_id, work_contract_id, frame_history_json, pre_history_json
        FROM accepted_model_batch_admissions
       WHERE session_id = ? AND source_user_seq = ?
         AND EXISTS (SELECT 1 FROM json_each(call_ids_json) WHERE json_each.value = ?)
    `).all(input.sessionId, input.sourceUserSeq, input.startLogicalToolCallId) as Array<{
      accepted_task_id: string; work_contract_id: string;
      frame_history_json: string; pre_history_json: string;
    }>;
    if (batches.length !== 1) return { status: 'refused', reason: 'batch scrape accepted model frame is missing or ambiguous' };
    const batch = batches[0]!;
    const frame = parseItems(batch.frame_history_json);
    const preHistory = parseItems(batch.pre_history_json);
    if (
      batch.accepted_task_id !== input.acceptedTaskId
      || batch.work_contract_id !== recipe.workContractId
      || !frame
      || !preHistory
    ) return { status: 'refused', reason: 'batch scrape accepted model frame contradicts frozen authority' };
    const calls = frame.filter((item) => item.type === 'function_call'
      && item.callId === input.startLogicalToolCallId && item.name === 'work_call');
    if (calls.length !== 1 || typeof calls[0]!.arguments !== 'string') {
      return { status: 'refused', reason: 'batch scrape accepted carrier is missing or ambiguous' };
    }
    let carrier: Record<string, unknown>;
    try { carrier = JSON.parse(calls[0]!.arguments as string) as Record<string, unknown>; } catch {
      return { status: 'refused', reason: 'batch scrape accepted carrier is unreadable' };
    }
    if (
      carrier.requirement_id !== input.requirementId
      || JSON.stringify(carrier.source_call_ids ?? null) !== JSON.stringify(input.declaredSourceCallIds ?? null)
      || JSON.stringify(carrier.source_record_ids ?? null) !== JSON.stringify(input.declaredSourceRecordIds ?? null)
    ) return { status: 'refused', reason: 'batch scrape source nomination changed after model-batch admission' };
    const sourceItems = preHistory.filter((item) => item.type === 'function_call_result'
      && item.callId === projection.call_id);
    if (sourceItems.length !== 1) {
      return { status: 'refused', reason: 'batch scrape accepted history does not contain the nominated Search result' };
    }
    const sourceItem = sourceItems[0]!;
    const sourceItemJson = canonicalJson(sourceItem);
    if (
      Buffer.byteLength(sourceItemJson, 'utf8') !== projection.result_item_bytes
      || sha256(sourceItemJson) !== projection.result_item_sha256
    ) return { status: 'refused', reason: 'batch scrape nominated Search projection bytes changed' };
    const prepared = prepareRecentArticleBatchCandidates({
      rawSearchResult: redeemed.value.rawPayload,
      projectedSearchResult: sourceItem.output,
      selectedRecordIds: input.declaredSourceRecordIds,
      batchArguments: input.providerArguments,
    });
    if (prepared.status !== 'prepared') return prepared;
    const graphEvent = getTurnGraphEventForSource(input.sessionId, input.sourceUserSeq);
    const graph = record(graphEvent?.data.graph);
    const nodes = Array.isArray(graph?.nodes)
      ? graph.nodes.flatMap((node) => record(node) ? [record(node)!] : [])
      : [];
    const evidenceRows = nodes.flatMap((node) => {
      const locator = record(node.structuredCollectionLocator);
      const evidence = record(locator?.sourceEvidence);
      return evidence?.operationId === input.requirementId ? [evidence] : [];
    });
    const evidence = evidenceRows.length === 1 ? evidenceRows[0]! : null;
    const accepted = db.prepare(`
      SELECT created_at FROM events WHERE session_id = ? AND seq = ? AND type = 'user_input_received'
    `).get(input.sessionId, input.sourceUserSeq) as { created_at: string } | undefined;
    if (
      !evidence
      || !accepted
      || evidence.asOf !== accepted.created_at
      || !Number.isSafeInteger(evidence.maxAgeDays)
      || !Number.isSafeInteger(evidence.minDistinctRecords)
    ) {
      return { status: 'refused', reason: 'batch scrape recency contract is not host-owned' };
    }
    return {
      status: 'prepared',
      intent: {
        version: 1,
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: input.acceptedTaskId,
        startLogicalToolCallId: input.startLogicalToolCallId,
        requirementId: input.requirementId,
        recipe,
        sourceLogicalToolCallId: sourceBinding.logical_tool_call_id,
        sourceResultHandleId: sourceBinding.result_handle_id,
        sourceProjectionCallId: projection.call_id,
        sourceProjectionDigest: projection.result_item_sha256,
        candidates: prepared.candidates,
        candidateDigest: prepared.candidateDigest,
        acceptedAt: accepted.created_at,
        maxAgeDays: evidence.maxAgeDays as number,
        minDistinctRecords: evidence.minDistinctRecords as number,
      },
    };
  } catch (error) {
    return { status: 'refused', reason: boundedReason(error) };
  }
}

export function recordAsyncReadRefinementIntent(input: {
  intent: PreparedAsyncReadRefinementIntentV1;
  startArgumentDigest: string;
  db?: Database.Database;
}): { status: 'recorded' | 'replayed' } | { status: 'refused'; reason: string } {
  try {
    if (!SHA256.test(input.startArgumentDigest)) return { status: 'refused', reason: 'start argument digest is invalid' };
    const db = input.db ?? openEventLog();
    const expected = db.prepare(`
      SELECT accepted_task_id, contract_id, requirement_id, argument_digest, effect_kind
        FROM expected_work_call_bindings
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(
      input.intent.sessionId,
      input.intent.sourceUserSeq,
      input.intent.startLogicalToolCallId,
    ) as {
      accepted_task_id: string; contract_id: string; requirement_id: string;
      argument_digest: string; effect_kind: string;
    } | undefined;
    if (
      !expected
      || expected.accepted_task_id !== input.intent.acceptedTaskId
      || expected.contract_id !== input.intent.recipe.workContractId
      || expected.requirement_id !== input.intent.requirementId
      || expected.argument_digest !== input.startArgumentDigest
      || expected.effect_kind !== 'read'
    ) return { status: 'refused', reason: 'async refinement intent does not match the admitted start call' };
    const row = {
      session_id: input.intent.sessionId,
      source_user_seq: input.intent.sourceUserSeq,
      accepted_task_id: input.intent.acceptedTaskId,
      start_logical_tool_call_id: input.intent.startLogicalToolCallId,
      requirement_id: input.intent.requirementId,
      recipe_digest: input.intent.recipe.recipeDigest,
      owner_binding_digest: input.intent.recipe.ownerBindingDigest,
      start_argument_digest: input.startArgumentDigest,
      source_logical_tool_call_id: input.intent.sourceLogicalToolCallId,
      source_result_handle_id: input.intent.sourceResultHandleId,
      source_projection_call_id: input.intent.sourceProjectionCallId,
      source_projection_digest: input.intent.sourceProjectionDigest,
      candidates_json: canonicalJson(input.intent.candidates),
      candidate_digest: input.intent.candidateDigest,
      accepted_at: input.intent.acceptedAt,
      max_age_days: input.intent.maxAgeDays,
      min_distinct_records: input.intent.minDistinctRecords,
      recorded_at: new Date().toISOString(),
    };
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO ${ASYNC_READ_REFINEMENT_INTENTS_TABLE}
        (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})
    `).run(...Object.values(row));
    if (inserted.changes === 1) return { status: 'recorded' };
    const existing = db.prepare(`
      SELECT * FROM ${ASYNC_READ_REFINEMENT_INTENTS_TABLE}
       WHERE session_id = ? AND source_user_seq = ? AND start_logical_tool_call_id = ?
    `).get(row.session_id, row.source_user_seq, row.start_logical_tool_call_id) as Record<string, unknown> | undefined;
    if (!existing || Object.entries(row).some(([key, value]) => key !== 'recorded_at' && existing[key] !== value)) {
      return { status: 'refused', reason: 'a different async refinement intent already owns this requirement' };
    }
    return { status: 'replayed' };
  } catch (error) {
    return { status: 'refused', reason: boundedReason(error) };
  }
}

function parsedEvidence(value: unknown): VerifiedRecentArticlesV1 | null {
  const row = record(value);
  if (
    row?.protocol !== VERIFIED_RECENT_ARTICLES_PROTOCOL
    || !Array.isArray(row.records)
    || typeof row.evidenceDigest !== 'string'
    || !SHA256.test(row.evidenceDigest)
  ) return null;
  return row as unknown as VerifiedRecentArticlesV1;
}

/** Reopen only the immutable host-owned continuation. Current catalog/model
 * bytes are deliberately absent: execution must separately re-attest the
 * exact sealed recipe before any child provider call. */
export function loadAsyncReadRefinementOwner(input: {
  sessionId: string;
  sourceUserSeq: number;
  startLogicalToolCallId: string;
  db?: Database.Database;
}): DurableAsyncReadRefinementOwnerV1 | null {
  try {
    const db = input.db ?? openEventLog();
    const row = db.prepare(`
      SELECT intent.*, start.provider_start_logical_tool_call_id, start.job_id,
             start.recorded_at AS start_recorded_at,
             start.accepted_task_id AS start_accepted_task_id,
             start.receipt_version AS start_receipt_version,
             start.recipe_digest AS start_recipe_digest,
             start.start_result_handle_id, start.start_raw_payload_sha256,
             start.job_url,
             completion.accepted_task_id AS completion_accepted_task_id,
             completion.recipe_digest AS completion_recipe_digest,
             completion.getter_logical_tool_call_id AS completion_getter_logical_tool_call_id,
             completion.getter_result_handle_id AS completion_getter_result_handle_id,
             completion.getter_raw_payload_sha256 AS completion_getter_raw_payload_sha256,
             completion.evidence_json, completion.evidence_digest,
             terminal.accepted_task_id AS terminal_accepted_task_id,
             terminal.recipe_digest AS terminal_recipe_digest,
             terminal.terminal_kind, terminal.reason AS terminal_reason,
             terminal.recorded_at AS terminal_recorded_at,
             terminal.getter_logical_tool_call_id AS terminal_getter_logical_tool_call_id,
             terminal.getter_result_handle_id AS terminal_getter_result_handle_id,
             terminal.getter_raw_payload_sha256 AS terminal_getter_raw_payload_sha256,
             terminal.cancellation_run_attempt_id,
             terminal.cancellation_requested_at
        FROM ${ASYNC_READ_REFINEMENT_INTENTS_TABLE} intent
        LEFT JOIN ${ASYNC_READ_REFINEMENT_START_RECEIPTS_TABLE} start
          ON start.session_id = intent.session_id
         AND start.source_user_seq = intent.source_user_seq
         AND start.start_logical_tool_call_id = intent.start_logical_tool_call_id
        LEFT JOIN ${ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE} completion
          ON completion.session_id = intent.session_id
         AND completion.source_user_seq = intent.source_user_seq
         AND completion.start_logical_tool_call_id = intent.start_logical_tool_call_id
        LEFT JOIN ${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE} terminal
          ON terminal.session_id = intent.session_id
         AND terminal.source_user_seq = intent.source_user_seq
         AND terminal.start_logical_tool_call_id = intent.start_logical_tool_call_id
       WHERE intent.session_id = ? AND intent.source_user_seq = ?
         AND intent.start_logical_tool_call_id = ?
    `).get(input.sessionId, input.sourceUserSeq, input.startLogicalToolCallId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const recipe = parseAsyncReadContinuationRecipe(JSON.parse(String(row.recipe_json ?? 'null')));
    // v71 stores the recipe on the sealed node rather than duplicating it in
    // the intent. Reopen that exact node and require its digest to match.
    const sealed = loadSealedNodeBinding(
      input.sessionId,
      input.sourceUserSeq,
      String(row.requirement_id),
    );
    const sealedRecipe = sealed?.asyncRead
      ? parseAsyncReadContinuationRecipe(sealed.asyncRead)
      : null;
    const exactRecipe = recipe ?? sealedRecipe;
    if (
      !exactRecipe
      || exactRecipe.recipeDigest !== row.recipe_digest
      || exactRecipe.ownerBindingDigest !== row.owner_binding_digest
      || exactRecipe.acceptedTaskId !== row.accepted_task_id
      || exactRecipe.ownerRequirementId !== row.requirement_id
    ) return null;
    if (row.provider_start_logical_tool_call_id != null) {
      if (
        row.start_accepted_task_id !== row.accepted_task_id
        || row.start_receipt_version !== 1
        || row.start_recipe_digest !== exactRecipe.recipeDigest
        || typeof row.start_result_handle_id !== 'string'
        || typeof row.start_raw_payload_sha256 !== 'string'
        || typeof row.job_id !== 'string'
        || typeof row.job_url !== 'string'
      ) return null;
      const startReplay = recordAsyncReadRefinementStartReceipt({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: String(row.accepted_task_id),
        startLogicalToolCallId: input.startLogicalToolCallId,
        providerStartLogicalToolCallId: String(row.provider_start_logical_tool_call_id),
        db,
      });
      if (startReplay.status === 'held' || startReplay.jobId !== row.job_id) return null;
    } else if (
      row.start_accepted_task_id != null
      || row.start_result_handle_id != null
      || row.job_id != null
    ) return null;
    const candidates = JSON.parse(String(row.candidates_json)) as unknown;
    if (
      !Array.isArray(candidates)
      || sha256(canonicalJson(candidates)) !== row.candidate_digest
    ) return null;
    let evidence = row.evidence_json == null
      ? null
      : parsedEvidence(JSON.parse(String(row.evidence_json)));
    if (row.evidence_json != null && !evidence) return null;
    if (evidence) {
      if (
        row.completion_accepted_task_id !== row.accepted_task_id
        || row.completion_recipe_digest !== exactRecipe.recipeDigest
        || typeof row.completion_getter_logical_tool_call_id !== 'string'
        || typeof row.completion_getter_result_handle_id !== 'string'
        || typeof row.completion_getter_raw_payload_sha256 !== 'string'
        || row.evidence_digest !== evidence.evidenceDigest
      ) return null;
      const redeemed = redeemSuccessfulSettlementResultForHost({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: String(row.accepted_task_id),
        logicalToolCallId: row.completion_getter_logical_tool_call_id,
      });
      if (
        redeemed.status !== 'ok'
        || redeemed.value.resultHandleId !== row.completion_getter_result_handle_id
        || redeemed.value.rawPayloadSha256 !== row.completion_getter_raw_payload_sha256
      ) return null;
      const reproved = verifyRecentArticleDateEvidence({
        acceptedAt: String(row.accepted_at),
        maxAgeDays: Number(row.max_age_days),
        minDistinctRecords: Number(row.min_distinct_records),
        candidates: candidates as RecentArticleCandidateV1[],
        completedBatchResult: redeemed.value.rawPayload,
      });
      if (
        reproved.status !== 'verified'
        || canonicalJson(reproved.evidence) !== canonicalJson(evidence)
      ) return null;
      evidence = reproved.evidence;
    }
    const terminalKind = row.terminal_kind == null
      ? null
      : String(row.terminal_kind) as AsyncReadRefinementTerminalKind;
    const terminal = terminalKind === null
      ? null
      : terminalGate({ kind: terminalKind, reason: String(row.terminal_reason ?? '') });
    if (
      terminalKind !== null
      && ![
        'insufficient_evidence',
        'provider_failed',
        'provider_cancelled',
        'deadline_exhausted',
        'attempts_exhausted',
        'user_cancelled',
      ].includes(terminalKind)
    ) return null;
    if (evidence && terminal) return null;
    if (terminal) {
      if (
        row.terminal_accepted_task_id !== row.accepted_task_id
        || row.terminal_recipe_digest !== exactRecipe.recipeDigest
      ) return null;
      const getterId = row.terminal_getter_logical_tool_call_id;
      const getterHandle = row.terminal_getter_result_handle_id;
      const getterDigest = row.terminal_getter_raw_payload_sha256;
      const hasGetter = getterId != null || getterHandle != null || getterDigest != null;
      if (hasGetter) {
        if (
          typeof getterId !== 'string'
          || typeof getterHandle !== 'string'
          || typeof getterDigest !== 'string'
        ) return null;
        const redeemed = redeemSuccessfulSettlementResultForHost({
          sessionId: input.sessionId,
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: String(row.accepted_task_id),
          logicalToolCallId: getterId,
        });
        if (
          redeemed.status !== 'ok'
          || redeemed.value.resultHandleId !== getterHandle
          || redeemed.value.rawPayloadSha256 !== getterDigest
        ) return null;
        const verified = verifyRecentArticleDateEvidence({
          acceptedAt: String(row.accepted_at),
          maxAgeDays: Number(row.max_age_days),
          minDistinctRecords: Number(row.min_distinct_records),
          candidates: candidates as RecentArticleCandidateV1[],
          completedBatchResult: redeemed.value.rawPayload,
        });
        const outer = record(redeemed.value.rawPayload);
        const provider = record(outer?.data);
        const providerStatus = typeof provider?.status === 'string'
          ? provider.status.toLocaleLowerCase('en-US')
          : '';
        let expectedReason: string | null = null;
        if (terminalKind === 'insufficient_evidence' && verified.status === 'insufficient') {
          expectedReason = verified.reason;
        } else if (terminalKind === 'provider_failed') {
          expectedReason = providerStatus === 'failed'
            ? 'The batch getter ended failed.'
            : 'The batch getter returned an unusable or unsupported terminal response.';
        } else if (terminalKind === 'provider_cancelled') {
          expectedReason = 'The batch getter ended cancelled.';
        } else if (terminalKind === 'attempts_exhausted') {
          expectedReason = 'All bounded getter attempts completed without one terminal verified recent-article result.';
        }
        if (
          (terminalKind === 'insufficient_evidence'
            && (providerStatus !== 'completed' || verified.status !== 'insufficient'))
          || (terminalKind === 'provider_failed'
            && providerStatus !== 'failed'
            && ['completed', 'cancelled', 'queued', 'running', 'scraping', 'processing'].includes(providerStatus))
          || (terminalKind === 'provider_cancelled' && providerStatus !== 'cancelled')
          || (terminalKind === 'attempts_exhausted'
            && (verified.status === 'verified'
              || !['queued', 'running', 'scraping', 'processing'].includes(providerStatus)
              || !exactBoundedGetterSettlementSequence({
                db,
                sessionId: input.sessionId,
                sourceUserSeq: input.sourceUserSeq,
                acceptedTaskId: String(row.accepted_task_id),
                startLogicalToolCallId: input.startLogicalToolCallId,
                attemptCount: exactRecipe.maximumGetterAttempts,
              })))
          || terminalKind === 'deadline_exhausted'
          || expectedReason === null
          || row.terminal_reason !== expectedReason
        ) return null;
      } else if (![
        'deadline_exhausted',
        'attempts_exhausted',
        'user_cancelled',
        'provider_failed',
      ].includes(terminalKind!)) {
        return null;
      } else {
        const expectedReason = terminalKind === 'deadline_exhausted'
          ? 'The bounded recent-article verification deadline elapsed before a terminal completed result.'
          : terminalKind === 'attempts_exhausted'
            ? 'All bounded getter attempts completed without one terminal verified recent-article result.'
            : terminalKind === 'user_cancelled'
              ? 'The async article verification was cancelled by the user\'s exact stop request.'
              : 'The batch provider child ended without a retryable successful result.';
        if (row.terminal_reason !== expectedReason) return null;
        if (terminalKind === 'deadline_exhausted') {
          const startAt = Date.parse(String(row.start_recorded_at));
          const terminalAt = Date.parse(String(row.terminal_recorded_at));
          if (
            !Number.isFinite(startAt)
            || !Number.isFinite(terminalAt)
            || terminalAt - startAt < exactRecipe.maximumElapsedMs
          ) return null;
        } else if (terminalKind === 'attempts_exhausted' && !exactBoundedGetterSettlementSequence({
          db,
          sessionId: input.sessionId,
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: String(row.accepted_task_id),
          startLogicalToolCallId: input.startLogicalToolCallId,
          attemptCount: exactRecipe.maximumGetterAttempts,
        })) return null;
        if (terminalKind === 'user_cancelled') {
          if (
            typeof row.cancellation_run_attempt_id !== 'string'
            || typeof row.cancellation_requested_at !== 'string'
            || !Number.isFinite(Date.parse(row.cancellation_requested_at))
          ) return null;
          const attempt = db.prepare(`
            SELECT session_id, source_user_seq FROM run_attempts WHERE attempt_id = ?
          `).get(row.cancellation_run_attempt_id) as {
            session_id: string; source_user_seq: number | null;
          } | undefined;
          if (
            !attempt
            || attempt.session_id !== input.sessionId
            || attempt.source_user_seq !== input.sourceUserSeq
          ) return null;
        } else if (row.cancellation_run_attempt_id != null || row.cancellation_requested_at != null) {
          return null;
        }
        if (terminalKind === 'provider_failed' && !exactDefinitiveChildFailure({
          sessionId: input.sessionId,
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: String(row.accepted_task_id),
          startLogicalToolCallId: input.startLogicalToolCallId,
          maximumGetterAttempts: exactRecipe.maximumGetterAttempts,
        })) return null;
      }
    }
    return {
      intent: {
        version: 1,
        sessionId: String(row.session_id),
        sourceUserSeq: Number(row.source_user_seq),
        acceptedTaskId: String(row.accepted_task_id),
        startLogicalToolCallId: String(row.start_logical_tool_call_id),
        requirementId: String(row.requirement_id),
        recipe: exactRecipe,
        sourceLogicalToolCallId: String(row.source_logical_tool_call_id),
        sourceResultHandleId: String(row.source_result_handle_id),
        sourceProjectionCallId: String(row.source_projection_call_id),
        sourceProjectionDigest: String(row.source_projection_digest),
        candidates: candidates as RecentArticleCandidateV1[],
        candidateDigest: String(row.candidate_digest),
        acceptedAt: String(row.accepted_at),
        maxAgeDays: Number(row.max_age_days),
        minDistinctRecords: Number(row.min_distinct_records),
      },
      startArgumentDigest: String(row.start_argument_digest),
      providerStartLogicalToolCallId: row.provider_start_logical_tool_call_id == null
        ? null : String(row.provider_start_logical_tool_call_id),
      jobId: row.job_id == null ? null : String(row.job_id),
      startRecordedAt: row.start_recorded_at == null ? null : String(row.start_recorded_at),
      completedEvidence: evidence,
      terminalGate: terminal,
    };
  } catch {
    return null;
  }
}

function parseExactStartReceipt(value: unknown): { jobId: string; jobUrl: string } | null {
  const outer = record(value);
  const data = record(outer?.data);
  if (outer?.successful !== true || outer.error || !data || data.success !== true) return null;
  if (typeof data.id !== 'string' || data.id !== data.id.trim() || !data.id || data.id.length > 512) return null;
  if (Array.isArray(data.invalidURLs) && data.invalidURLs.length > 0) return null;
  if (typeof data.url !== 'string' || data.url !== data.url.trim()) return null;
  try {
    const url = new URL(data.url);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const finalSegment = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '');
    if (finalSegment !== data.id) return null;
    return { jobId: data.id, jobUrl: url.href };
  } catch { return null; }
}

export function asyncReadProviderStartLogicalCallId(ownerLogicalToolCallId: string): string {
  if (!ownerLogicalToolCallId.trim()) throw new Error('async read owner logical call id is empty');
  return `async-read-start:v1:${sha256(ownerLogicalToolCallId)}`;
}

export function recordAsyncReadRefinementStartReceipt(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  startLogicalToolCallId: string;
  providerStartLogicalToolCallId: string;
  db?: Database.Database;
}): { status: 'recorded' | 'replayed'; jobId: string } | { status: 'held'; reason: string } {
  try {
    const db = input.db ?? openEventLog();
    const intent = db.prepare(`SELECT * FROM ${ASYNC_READ_REFINEMENT_INTENTS_TABLE}
      WHERE session_id = ? AND source_user_seq = ? AND start_logical_tool_call_id = ?`
    ).get(input.sessionId, input.sourceUserSeq, input.startLogicalToolCallId) as Record<string, unknown> | undefined;
    if (!intent || intent.accepted_task_id !== input.acceptedTaskId) {
      return { status: 'held', reason: 'async refinement start owner is missing' };
    }
    if (
      input.providerStartLogicalToolCallId
      !== asyncReadProviderStartLogicalCallId(input.startLogicalToolCallId)
    ) return { status: 'held', reason: 'provider start logical call is not the deterministic child' };
    const recipe = loadSealedNodeBinding(
      input.sessionId,
      input.sourceUserSeq,
      String(intent.requirement_id),
    )?.asyncRead;
    const parsedRecipe = recipe ? parseAsyncReadContinuationRecipe(recipe) : null;
    const frozen = freezeCatalogSnapshotForSource({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
    });
    const currentStarts = frozen.ok
      ? frozen.entries.filter((entry) => (
          entry.capabilityId === loadSealedNodeBinding(
            input.sessionId,
            input.sourceUserSeq,
            String(intent.requirement_id),
          )?.capabilityId
          && entry.manifest?.externalDefinition?.providerOutputSchemaDigest
            === parsedRecipe?.owner.providerOutputSchemaDigest
        ))
      : [];
    const expectedArgs = JSON.parse(String(intent.candidates_json)) as RecentArticleCandidateV1[];
    const startArgs = {
      urls: expectedArgs.map((candidate) => candidate.url),
      formats: ['rawHtml'],
    };
    const logical = durableLogicalCallContract(
      input.acceptedTaskId,
      'FIRECRAWL_BATCH_SCRAPE',
      startArgs,
    );
    const childBinding = loadHostCallCapabilityBinding({
      db,
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      logicalToolCallId: input.providerStartLogicalToolCallId,
    });
    if (
      !parsedRecipe
      || currentStarts.length !== 1
      || parsedRecipe.recipeDigest !== intent.recipe_digest
      || !logical
      || childBinding.status !== 'ok'
      || childBinding.binding.acceptedTaskId !== input.acceptedTaskId
      || childBinding.binding.operationId !== parsedRecipe.owner.operationId
      || childBinding.binding.accountId !== parsedRecipe.owner.account
      || childBinding.binding.providerInputSchemaDigest !== parsedRecipe.owner.providerInputSchemaDigest
      || childBinding.binding.attestedArgumentDigest !== logical.argumentDigest
      || childBinding.binding.effect !== 'read'
    ) return { status: 'held', reason: 'provider start child does not reopen the exact sealed recipe' };
    const redeemed = redeemSuccessfulSettlementResultForHost({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: input.acceptedTaskId,
      logicalToolCallId: input.providerStartLogicalToolCallId,
    });
    if (redeemed.status !== 'ok') return { status: 'held', reason: `start settlement is ${redeemed.status}: ${redeemed.reason}` };
    const receipt = parseExactStartReceipt(redeemed.value.rawPayload);
    if (!receipt) return { status: 'held', reason: 'start settlement is not one exact successful Firecrawl job receipt' };
    const startSettlement = db.prepare(`
      SELECT settled_at FROM logical_call_settlements
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(
      input.sessionId,
      input.sourceUserSeq,
      input.providerStartLogicalToolCallId,
    ) as { settled_at: string } | undefined;
    if (!startSettlement || !Number.isFinite(Date.parse(startSettlement.settled_at))) {
      return { status: 'held', reason: 'provider start settlement time is unavailable' };
    }
    const row = {
      session_id: input.sessionId,
      source_user_seq: input.sourceUserSeq,
      accepted_task_id: input.acceptedTaskId,
      start_logical_tool_call_id: input.startLogicalToolCallId,
      provider_start_logical_tool_call_id: input.providerStartLogicalToolCallId,
      receipt_version: 1,
      recipe_digest: intent.recipe_digest,
      start_result_handle_id: redeemed.value.resultHandleId,
      start_raw_payload_sha256: redeemed.value.rawPayloadSha256,
      job_id: receipt.jobId,
      job_url: receipt.jobUrl,
      recorded_at: startSettlement.settled_at,
    };
    const inserted = db.prepare(`INSERT OR IGNORE INTO ${ASYNC_READ_REFINEMENT_START_RECEIPTS_TABLE}
      (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`
    ).run(...Object.values(row));
    if (inserted.changes === 0) {
      const existing = db.prepare(`SELECT * FROM ${ASYNC_READ_REFINEMENT_START_RECEIPTS_TABLE}
        WHERE session_id = ? AND source_user_seq = ? AND start_logical_tool_call_id = ?`
      ).get(input.sessionId, input.sourceUserSeq, input.startLogicalToolCallId) as Record<string, unknown> | undefined;
      if (!existing || Object.entries(row).some(([key, value]) => key !== 'recorded_at' && existing[key] !== value)) {
        return { status: 'held', reason: 'a different start receipt already owns this async refinement' };
      }
      return { status: 'replayed', jobId: receipt.jobId };
    }
    return { status: 'recorded', jobId: receipt.jobId };
  } catch (error) {
    return { status: 'held', reason: boundedReason(error) };
  }
}

export function asyncReadGetterLogicalCallId(startLogicalToolCallId: string, attemptOrdinal: number): string {
  if (!Number.isSafeInteger(attemptOrdinal) || attemptOrdinal < 0 || attemptOrdinal >= 6) {
    throw new Error('async read getter attempt ordinal is out of bounds');
  }
  return `async-read-get:v1:${sha256(`${startLogicalToolCallId}\0${attemptOrdinal}`)}`;
}

function exactDefinitiveChildFailure(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  startLogicalToolCallId: string;
  maximumGetterAttempts: number;
  expectedChildLogicalToolCallId?: string;
}): boolean {
  const childIds = [
    asyncReadProviderStartLogicalCallId(input.startLogicalToolCallId),
    ...Array.from(
      { length: input.maximumGetterAttempts },
      (_, ordinal) => asyncReadGetterLogicalCallId(input.startLogicalToolCallId, ordinal),
    ),
  ];
  const definitive: string[] = [];
  let seenMissing = false;
  for (const childId of childIds) {
    const redeemed = redeemDurableLogicalCallSettlementForHost({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: input.acceptedTaskId,
      logicalToolCallId: childId,
    });
    if (redeemed.status === 'missing') {
      seenMissing = true;
      continue;
    }
    if (redeemed.status !== 'ok' || seenMissing) return false;
    const settlement = redeemed.settlement;
    if (
      !['succeeded', 'empty_result'].includes(settlement.outcome.kind)
      && settlement.outcome.directive.action !== 'retry_with_backoff'
      && settlement.outcome.directive.requiresReconciliation !== true
      && settlement.executionKind === 'provider_execution'
      && settlement.physicalCrossingCount > 0
    ) definitive.push(childId);
  }
  return definitive.length === 1
    && (!input.expectedChildLogicalToolCallId
      || definitive[0] === input.expectedChildLogicalToolCallId);
}

function exactBoundedGetterSettlementSequence(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  startLogicalToolCallId: string;
  attemptCount: number;
}): boolean {
  const ids = Array.from(
    { length: input.attemptCount },
    (_, ordinal) => asyncReadGetterLogicalCallId(input.startLogicalToolCallId, ordinal),
  );
  const rows = input.db.prepare(`
    SELECT settlement.logical_tool_call_id, settlement.outcome_kind,
           settlement.recovery_action, settlement.requires_reconciliation,
           event.seq AS settlement_seq
      FROM logical_call_settlements settlement
      JOIN logical_tool_calls call
        ON call.session_id = settlement.session_id
       AND call.source_user_seq = settlement.source_user_seq
       AND call.logical_tool_call_id = settlement.logical_tool_call_id
      JOIN events event ON event.id = settlement.settlement_event_id
     WHERE settlement.session_id = ? AND settlement.source_user_seq = ?
       AND call.accepted_task_id = ?
       AND settlement.logical_tool_call_id IN (${ids.map(() => '?').join(',')})
  `).all(
    input.sessionId,
    input.sourceUserSeq,
    input.acceptedTaskId,
    ...ids,
  ) as Array<{
    logical_tool_call_id: string;
    outcome_kind: string;
    recovery_action: string;
    requires_reconciliation: number;
    settlement_seq: number;
  }>;
  if (rows.length !== ids.length) return false;
  const byId = new Map(rows.map((entry) => [entry.logical_tool_call_id, entry]));
  const ordered = ids.map((id) => byId.get(id));
  return ordered.every((entry, index) => Boolean(
    entry
    && entry.requires_reconciliation === 0
    && (index === 0 || entry.settlement_seq > ordered[index - 1]!.settlement_seq)
    && (['succeeded', 'empty_result'].includes(entry.outcome_kind)
      || entry.recovery_action === 'retry_with_backoff'),
  ));
}

function recordTerminalReceipt(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  startLogicalToolCallId: string;
  recipeDigest: string;
  kind: AsyncReadRefinementTerminalKind;
  reason: string;
  getter?: {
    logicalToolCallId: string;
    resultHandleId: string;
    rawPayloadSha256: string;
  };
  cancellation?: {
    runAttemptId: string;
    requestedAt: string;
  };
  recordedAt?: string;
}): { status: 'recorded' | 'replayed'; gate: AsyncReadRefinementTerminalGateV1 }
  | { status: 'held'; reason: string } {
  const reason = boundedReason(input.reason);
  const row = {
    session_id: input.sessionId,
    source_user_seq: input.sourceUserSeq,
    accepted_task_id: input.acceptedTaskId,
    start_logical_tool_call_id: input.startLogicalToolCallId,
    receipt_version: 1,
    recipe_digest: input.recipeDigest,
    terminal_kind: input.kind,
    reason,
    getter_logical_tool_call_id: input.getter?.logicalToolCallId ?? null,
    getter_result_handle_id: input.getter?.resultHandleId ?? null,
    getter_raw_payload_sha256: input.getter?.rawPayloadSha256 ?? null,
    cancellation_run_attempt_id: input.cancellation?.runAttemptId ?? null,
    cancellation_requested_at: input.cancellation?.requestedAt ?? null,
    recorded_at: input.recordedAt ?? new Date().toISOString(),
  };
  try {
    const inserted = input.db.prepare(`INSERT OR IGNORE INTO ${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE}
      (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`
    ).run(...Object.values(row));
    if (inserted.changes === 0) {
      const existing = input.db.prepare(`SELECT * FROM ${ASYNC_READ_REFINEMENT_TERMINAL_RECEIPTS_TABLE}
        WHERE session_id = ? AND source_user_seq = ? AND start_logical_tool_call_id = ?`
      ).get(input.sessionId, input.sourceUserSeq, input.startLogicalToolCallId) as Record<string, unknown> | undefined;
      if (!existing || Object.entries(row).some(([key, value]) => key !== 'recorded_at' && existing[key] !== value)) {
        return { status: 'held', reason: 'a different terminal outcome already owns this async refinement' };
      }
      return { status: 'replayed', gate: terminalGate({ kind: input.kind, reason }) };
    }
    return { status: 'recorded', gate: terminalGate({ kind: input.kind, reason }) };
  } catch (error) {
    const winner = loadAsyncReadRefinementOwner({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      startLogicalToolCallId: input.startLogicalToolCallId,
      db: input.db,
    });
    if (winner?.terminalGate?.terminalKind === input.kind) {
      return { status: 'replayed', gate: winner.terminalGate };
    }
    if (winner?.completedEvidence) {
      return { status: 'held', reason: 'a completed result already owns this async refinement' };
    }
    return { status: 'held', reason: boundedReason(error) };
  }
}

/** Freeze an exact user stop before clearing restart ownership. The request is
 * checked against the same source-bound run attempt and copied into the
 * immutable terminal receipt so replay remains provable after kill cleanup. */
export function recordAsyncReadRefinementCancellationTerminalOutcome(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  startLogicalToolCallId: string;
  runAttemptId: string;
  db?: Database.Database;
}): { status: 'recorded' | 'replayed'; gate: AsyncReadRefinementTerminalGateV1 }
  | { status: 'held'; reason: string } {
  try {
    const db = input.db ?? openEventLog();
    const owner = loadAsyncReadRefinementOwner({ ...input, db });
    if (
      !owner
      || owner.intent.acceptedTaskId !== input.acceptedTaskId
      || owner.completedEvidence
    ) return { status: 'held', reason: 'async cancellation owner is missing or already completed' };
    if (owner.terminalGate) {
      return owner.terminalGate.terminalKind === 'user_cancelled'
        ? { status: 'replayed', gate: owner.terminalGate }
        : { status: 'held', reason: 'a different terminal outcome already owns this async refinement' };
    }
    const attempt = db.prepare(`
      SELECT session_id, source_user_seq FROM run_attempts WHERE attempt_id = ?
    `).get(input.runAttemptId) as {
      session_id: string; source_user_seq: number | null;
    } | undefined;
    if (
      !attempt
      || attempt.session_id !== input.sessionId
      || attempt.source_user_seq !== input.sourceUserSeq
    ) return { status: 'held', reason: 'stop request does not own the async accepted source attempt' };
    const kill = getKillRequest(input.sessionId, {
      attemptId: input.runAttemptId,
      sourceUserSeq: input.sourceUserSeq,
    });
    if (!kill || !Number.isFinite(Date.parse(kill.requestedAt))) {
      return { status: 'held', reason: 'exact user stop request is unavailable' };
    }
    return recordTerminalReceipt({
      db,
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: input.acceptedTaskId,
      startLogicalToolCallId: input.startLogicalToolCallId,
      recipeDigest: owner.intent.recipe.recipeDigest,
      kind: 'user_cancelled',
      reason: 'The async article verification was cancelled by the user\'s exact stop request.',
      cancellation: {
        runAttemptId: input.runAttemptId,
        requestedAt: kill.requestedAt,
      },
    });
  } catch (error) {
    return { status: 'held', reason: boundedReason(error) };
  }
}

/** Freeze one definitive provider-child failure without inventing a provider
 * result. The child identity is deterministic and the durable settlement must
 * prove a real provider crossing, a non-retry directive, and no reconciliation
 * obligation. Uncertain and retryable failures remain privately held. */
export function recordAsyncReadRefinementChildFailureTerminalOutcome(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  startLogicalToolCallId: string;
  childLogicalToolCallId: string;
  db?: Database.Database;
}): { status: 'recorded' | 'replayed'; gate: AsyncReadRefinementTerminalGateV1 }
  | { status: 'held'; reason: string } {
  try {
    const db = input.db ?? openEventLog();
    const owner = loadAsyncReadRefinementOwner({ ...input, db });
    if (
      !owner
      || owner.intent.acceptedTaskId !== input.acceptedTaskId
      || owner.completedEvidence
    ) return { status: 'held', reason: 'async provider-failure owner is missing or already completed' };
    if (owner.terminalGate) {
      return owner.terminalGate.terminalKind === 'provider_failed'
        ? { status: 'replayed', gate: owner.terminalGate }
        : { status: 'held', reason: 'a different terminal outcome already owns this async refinement' };
    }
    if (!exactDefinitiveChildFailure({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: input.acceptedTaskId,
      startLogicalToolCallId: input.startLogicalToolCallId,
      maximumGetterAttempts: owner.intent.recipe.maximumGetterAttempts,
      expectedChildLogicalToolCallId: input.childLogicalToolCallId,
    })) {
      return {
        status: 'held',
        reason: 'provider child settlement is retryable, uncertain, foreign, or incomplete',
      };
    }
    return recordTerminalReceipt({
      db,
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: input.acceptedTaskId,
      startLogicalToolCallId: input.startLogicalToolCallId,
      recipeDigest: owner.intent.recipe.recipeDigest,
      kind: 'provider_failed',
      reason: 'The batch provider child ended without a retryable successful result.',
    });
  } catch (error) {
    return { status: 'held', reason: boundedReason(error) };
  }
}

/** Freeze the no-more-provider-work outcome after the durable elapsed/attempt
 * ceiling. This owns no new GET: it can only redeem already-settled child
 * calls and append one immutable terminal receipt. */
export function recordAsyncReadRefinementBudgetTerminalOutcome(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  startLogicalToolCallId: string;
  kind: 'deadline_exhausted' | 'attempts_exhausted';
  now?: () => number;
  db?: Database.Database;
}): { status: 'recorded' | 'replayed'; gate: AsyncReadRefinementTerminalGateV1 }
  | { status: 'held'; reason: string } {
  try {
    const db = input.db ?? openEventLog();
    const owner = loadAsyncReadRefinementOwner({ ...input, db });
    if (
      !owner
      || owner.intent.acceptedTaskId !== input.acceptedTaskId
      || !owner.jobId
      || !owner.startRecordedAt
      || owner.completedEvidence
    ) return { status: 'held', reason: 'async refinement budget owner is missing or already completed' };
    if (owner.terminalGate) {
      return owner.terminalGate.terminalKind === input.kind
        ? { status: 'replayed', gate: owner.terminalGate }
        : { status: 'held', reason: 'a different terminal outcome already owns this async refinement' };
    }
    const recipe = owner.intent.recipe;
    const startedAt = Date.parse(owner.startRecordedAt);
    if (!Number.isFinite(startedAt)) return { status: 'held', reason: 'durable batch start time is unavailable' };
    if (input.kind === 'deadline_exhausted') {
      const nowMs = (input.now ?? Date.now)();
      if (nowMs - startedAt < recipe.maximumElapsedMs) {
        return { status: 'held', reason: 'durable batch deadline has not elapsed' };
      }
      return recordTerminalReceipt({
        db,
        ...input,
        recipeDigest: recipe.recipeDigest,
        reason: 'The bounded recent-article verification deadline elapsed before a terminal completed result.',
        recordedAt: new Date(nowMs).toISOString(),
      });
    }
    const ids = Array.from(
      { length: recipe.maximumGetterAttempts },
      (_, ordinal) => asyncReadGetterLogicalCallId(input.startLogicalToolCallId, ordinal),
    );
    const rows = db.prepare(`
      SELECT settlement.logical_tool_call_id, settlement.settlement_event_id,
             settlement.outcome_kind, settlement.recovery_action,
             settlement.requires_reconciliation, event.seq AS settlement_seq
        FROM logical_call_settlements settlement
        JOIN events event ON event.id = settlement.settlement_event_id
       WHERE settlement.session_id = ? AND settlement.source_user_seq = ?
         AND settlement.logical_tool_call_id IN (${ids.map(() => '?').join(',')})
    `).all(input.sessionId, input.sourceUserSeq, ...ids) as Array<{
      logical_tool_call_id: string; settlement_event_id: string;
      outcome_kind: string; recovery_action: string;
      requires_reconciliation: number; settlement_seq: number;
    }>;
    const byId = new Map(rows.map((entry) => [entry.logical_tool_call_id, entry]));
    const ordered = ids.map((id) => byId.get(id));
    if (
      rows.length !== ids.length
      || ordered.some((entry) => !entry)
      || ordered.some((entry, index) => (
        entry!.requires_reconciliation !== 0
        || (index > 0 && entry!.settlement_seq <= ordered[index - 1]!.settlement_seq)
        || (!['succeeded', 'empty_result'].includes(entry!.outcome_kind)
          && entry!.recovery_action !== 'retry_with_backoff')
      ))
    ) {
      return { status: 'held', reason: 'not every bounded getter attempt has settled' };
    }
    const lastId = ids.at(-1)!;
    const redeemed = redeemSuccessfulSettlementResultForHost({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: input.acceptedTaskId,
      logicalToolCallId: lastId,
    });
    return recordTerminalReceipt({
      db,
      ...input,
      recipeDigest: recipe.recipeDigest,
      reason: 'All bounded getter attempts completed without one terminal verified recent-article result.',
      ...(redeemed.status === 'ok'
        ? {
            getter: {
              logicalToolCallId: lastId,
              resultHandleId: redeemed.value.resultHandleId,
              rawPayloadSha256: redeemed.value.rawPayloadSha256,
            },
          }
        : {}),
    });
  } catch (error) {
    const winner = loadAsyncReadRefinementOwner({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      startLogicalToolCallId: input.startLogicalToolCallId,
      db: input.db,
    });
    if (winner?.terminalGate?.terminalKind === input.kind) {
      return { status: 'replayed', gate: winner.terminalGate };
    }
    if (winner?.completedEvidence) {
      return { status: 'held', reason: 'a completed result already owns this async refinement' };
    }
    return { status: 'held', reason: boundedReason(error) };
  }
}

export function recordAsyncReadRefinementCompletion(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  startLogicalToolCallId: string;
  getterLogicalToolCallId: string;
  db?: Database.Database;
}): { status: 'recorded' | 'replayed'; evidence: VerifiedRecentArticlesV1 }
  | { status: 'terminal'; gate: AsyncReadRefinementTerminalGateV1 }
  | { status: 'pending' | 'held'; reason: string } {
  try {
    const db = input.db ?? openEventLog();
    const row = db.prepare(`
      SELECT intent.*, start.job_id, start.provider_start_logical_tool_call_id,
             start.recorded_at AS start_recorded_at
        FROM ${ASYNC_READ_REFINEMENT_INTENTS_TABLE} intent
        JOIN ${ASYNC_READ_REFINEMENT_START_RECEIPTS_TABLE} start
          ON start.session_id = intent.session_id
         AND start.source_user_seq = intent.source_user_seq
         AND start.start_logical_tool_call_id = intent.start_logical_tool_call_id
       WHERE intent.session_id = ? AND intent.source_user_seq = ?
         AND intent.start_logical_tool_call_id = ?
    `).get(input.sessionId, input.sourceUserSeq, input.startLogicalToolCallId) as Record<string, unknown> | undefined;
    if (!row || row.accepted_task_id !== input.acceptedTaskId) return { status: 'held', reason: 'async refinement owner/start receipt is missing' };
    const validIds = Array.from({ length: 6 }, (_, ordinal) => asyncReadGetterLogicalCallId(input.startLogicalToolCallId, ordinal));
    const getterOrdinal = validIds.indexOf(input.getterLogicalToolCallId);
    if (getterOrdinal < 0) return { status: 'held', reason: 'getter logical call is not one bounded deterministic attempt' };
    const sealed = loadSealedNodeBinding(
      input.sessionId,
      input.sourceUserSeq,
      String(row.requirement_id),
    );
    const recipe = sealed?.asyncRead ? parseAsyncReadContinuationRecipe(sealed.asyncRead) : null;
    const getterArgs = { [recipe?.getterIdArgument ?? 'id']: String(row.job_id) };
    const getterLogical = recipe
      ? durableLogicalCallContract(input.acceptedTaskId, recipe.getter.operationId, getterArgs)
      : null;
    const getterBinding = loadHostCallCapabilityBinding({
      db,
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      logicalToolCallId: input.getterLogicalToolCallId,
    });
    const frozen = freezeCatalogSnapshotForSource({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
    });
    const currentGetters = frozen.ok
      ? frozen.entries.filter((entry) => {
          const identity = canonicalCatalogIdentityOf(entry);
          return Boolean(
            identity
            && catalogIdentitiesEqual(identity, recipe!.getter)
            && entry.manifest?.externalDefinition?.providerOutputSchemaDigest
              === recipe!.getterProviderOutputSchemaDigest,
          );
        })
      : [];
    if (
      !recipe
      || currentGetters.length !== 1
      || recipe.recipeDigest !== row.recipe_digest
      || !getterLogical
      || getterBinding.status !== 'ok'
      || getterBinding.binding.acceptedTaskId !== input.acceptedTaskId
      || getterBinding.binding.operationId !== recipe.getter.operationId
      || getterBinding.binding.capabilityId !== recipe.getter.capabilityId
      || getterBinding.binding.manifestId !== recipe.getter.manifestId
      || getterBinding.binding.manifestDigest !== recipe.getter.manifestDigest
      || getterBinding.binding.accountId !== recipe.getter.account
      || getterBinding.binding.providerInputSchemaDigest !== recipe.getter.providerInputSchemaDigest
      || getterBinding.binding.schemaFingerprint !== recipe.getter.schemaDigest
      || getterBinding.binding.invokePortId !== recipe.getter.invokePortId
      || getterBinding.binding.attestedArgumentDigest !== getterLogical.argumentDigest
      || getterBinding.binding.effect !== 'read'
    ) return { status: 'held', reason: 'getter call does not reopen the exact sealed recipe and job id' };
    const redeemed = redeemSuccessfulSettlementResultForHost({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: input.acceptedTaskId,
      logicalToolCallId: input.getterLogicalToolCallId,
    });
    if (redeemed.status !== 'ok') return { status: 'pending', reason: `getter settlement is ${redeemed.status}: ${redeemed.reason}` };
    const settledRows = db.prepare(`
      SELECT settlement.logical_tool_call_id, settlement.settled_at,
             event.seq AS settlement_seq
        FROM logical_call_settlements settlement
        JOIN events event ON event.id = settlement.settlement_event_id
       WHERE settlement.session_id = ? AND settlement.source_user_seq = ?
         AND settlement.logical_tool_call_id IN (${validIds.map(() => '?').join(',')})
    `).all(
      input.sessionId,
      input.sourceUserSeq,
      ...validIds,
    ) as Array<{ logical_tool_call_id: string; settled_at: string; settlement_seq: number }>;
    const settledById = new Map(settledRows.map((entry) => [entry.logical_tool_call_id, entry]));
    if (validIds.slice(0, getterOrdinal).some((id) => !settledById.has(id))) {
      return { status: 'held', reason: 'getter attempt skipped an earlier deterministic ordinal' };
    }
    const startAt = Date.parse(String(row.start_recorded_at));
    const getterEntry = settledById.get(input.getterLogicalToolCallId);
    const getterAt = Date.parse(getterEntry?.settled_at ?? '');
    if (
      !Number.isFinite(startAt)
      || !Number.isFinite(getterAt)
      || getterAt < startAt
      || getterAt - startAt > recipe.maximumElapsedMs
    ) return { status: 'held', reason: 'getter settlement lies outside the frozen elapsed-time window' };
    const priorEntries = validIds.slice(0, getterOrdinal).map((id) => settledById.get(id)!);
    if (priorEntries.some((entry, index) => (
      !Number.isSafeInteger(entry.settlement_seq)
      || entry.settlement_seq >= getterEntry!.settlement_seq
      || (index > 0 && entry.settlement_seq <= priorEntries[index - 1]!.settlement_seq)
    ))) return { status: 'held', reason: 'getter attempt settlements are not in chronological ordinal order' };
    const candidates = JSON.parse(String(row.candidates_json)) as RecentArticleCandidateV1[];
    const verified = verifyRecentArticleDateEvidence({
      acceptedAt: String(row.accepted_at),
      maxAgeDays: Number(row.max_age_days),
      minDistinctRecords: Number(row.min_distinct_records),
      candidates,
      completedBatchResult: redeemed.value.rawPayload,
    });
    if (verified.status !== 'verified') {
      const outer = record(redeemed.value.rawPayload);
      const provider = record(outer?.data);
      const providerStatus = typeof provider?.status === 'string'
        ? provider.status.toLocaleLowerCase('en-US')
        : '';
      if (providerStatus === 'completed') {
        const terminal = recordTerminalReceipt({
          db,
          sessionId: input.sessionId,
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: input.acceptedTaskId,
          startLogicalToolCallId: input.startLogicalToolCallId,
          recipeDigest: recipe.recipeDigest,
          kind: 'insufficient_evidence',
          reason: verified.reason,
          getter: {
            logicalToolCallId: input.getterLogicalToolCallId,
            resultHandleId: redeemed.value.resultHandleId,
            rawPayloadSha256: redeemed.value.rawPayloadSha256,
          },
        });
        return terminal.status === 'held'
          ? terminal
          : { status: 'terminal', gate: terminal.gate };
      }
      if (providerStatus === 'failed' || providerStatus === 'cancelled') {
        const terminal = recordTerminalReceipt({
          db,
          sessionId: input.sessionId,
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: input.acceptedTaskId,
          startLogicalToolCallId: input.startLogicalToolCallId,
          recipeDigest: recipe.recipeDigest,
          kind: providerStatus === 'failed' ? 'provider_failed' : 'provider_cancelled',
          reason: `The batch getter ended ${providerStatus}.`,
          getter: {
            logicalToolCallId: input.getterLogicalToolCallId,
            resultHandleId: redeemed.value.resultHandleId,
            rawPayloadSha256: redeemed.value.rawPayloadSha256,
          },
        });
        return terminal.status === 'held'
          ? terminal
          : { status: 'terminal', gate: terminal.gate };
      }
      if (['queued', 'running', 'scraping', 'processing'].includes(providerStatus)) {
        return { status: 'pending', reason: verified.reason };
      }
      const terminal = recordTerminalReceipt({
        db,
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: input.acceptedTaskId,
        startLogicalToolCallId: input.startLogicalToolCallId,
        recipeDigest: recipe.recipeDigest,
        kind: 'provider_failed',
        reason: 'The batch getter returned an unusable or unsupported terminal response.',
        getter: {
          logicalToolCallId: input.getterLogicalToolCallId,
          resultHandleId: redeemed.value.resultHandleId,
          rawPayloadSha256: redeemed.value.rawPayloadSha256,
        },
      });
      return terminal.status === 'held'
        ? terminal
        : { status: 'terminal', gate: terminal.gate };
    }
    const completion = {
      session_id: input.sessionId,
      source_user_seq: input.sourceUserSeq,
      accepted_task_id: input.acceptedTaskId,
      start_logical_tool_call_id: input.startLogicalToolCallId,
      receipt_version: 1,
      recipe_digest: row.recipe_digest,
      getter_logical_tool_call_id: input.getterLogicalToolCallId,
      getter_result_handle_id: redeemed.value.resultHandleId,
      getter_raw_payload_sha256: redeemed.value.rawPayloadSha256,
      evidence_json: canonicalJson(verified.evidence),
      evidence_digest: verified.evidence.evidenceDigest,
      recorded_at: new Date().toISOString(),
    };
    const inserted = db.prepare(`INSERT OR IGNORE INTO ${ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE}
      (${Object.keys(completion).join(',')}) VALUES (${Object.keys(completion).map(() => '?').join(',')})`
    ).run(...Object.values(completion));
    if (inserted.changes === 0) {
      const existing = db.prepare(`SELECT * FROM ${ASYNC_READ_REFINEMENT_COMPLETION_RECEIPTS_TABLE}
        WHERE session_id = ? AND source_user_seq = ? AND start_logical_tool_call_id = ?`
      ).get(input.sessionId, input.sourceUserSeq, input.startLogicalToolCallId) as Record<string, unknown> | undefined;
      if (!existing || Object.entries(completion).some(([key, value]) => key !== 'recorded_at' && existing[key] !== value)) {
        return { status: 'held', reason: 'a different completion already owns this async refinement' };
      }
      return { status: 'replayed', evidence: verified.evidence };
    }
    return { status: 'recorded', evidence: verified.evidence };
  } catch (error) {
    const winner = loadAsyncReadRefinementOwner({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      startLogicalToolCallId: input.startLogicalToolCallId,
      db: input.db,
    });
    if (winner?.completedEvidence) {
      return { status: 'replayed', evidence: winner.completedEvidence };
    }
    if (winner?.terminalGate) {
      return { status: 'terminal', gate: winner.terminalGate };
    }
    return { status: 'held', reason: boundedReason(error) };
  }
}
