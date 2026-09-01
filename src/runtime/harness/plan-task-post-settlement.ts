/**
 * Durable hand-off between the foreground plan control and the shared host
 * invocation kernel.
 *
 * The model-authored plan has no execution authority merely because its graph
 * or preamble exists. Action work activates only after one exact first-class
 * plan_task call has all of these durable facts:
 *
 *   accepted source -> admitted action graph -> structured-model work contract
 *   -> exact public preamble -> bound transport receipt -> successful local
 *   plan_task settlement whose redeemed result says ok:true.
 *
 * No process-local Map participates. An exact restart can reconstruct the same
 * winner and replay the expected-work activation without another model pass.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ConversationPreambleDeliveryCallback,
  ConversationPreambleDeliveryResult,
  ConversationPreambleTransportReceipt,
} from '../../types.js';
import { acceptedTaskIdFor } from './attempt-identity.js';
import {
  conversationPreambleDeliveryRequest,
  getTurnGraphEventForSource,
  insertInternalEventInTransaction,
  listEvents,
  openEventLog,
  publishCommittedInternalEvent,
  type EventRow,
} from './eventlog.js';
import {
  loadExpectedWorkContract,
  prepareActionExpectedWorkContract,
} from './expected-work-contract.js';
import { activateActionExpectedWork } from './expected-work-admission.js';
import { turnGraphFromShadowEvent } from '../graph/turn-graph-shadow.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { hostDurableConversationPreambleDelivery } from './durable-conversation-preamble.js';
import { effectiveTurnObjective } from './turn-control.js';
import {
  PLAN_TASK_ACTIVATION_RECEIPTS_TABLE,
  PLAN_TASK_BINDING_SEAL_RECOVERY_CURSOR_TABLE,
  PLAN_TASK_BINDING_SEAL_INTENTS_TABLE,
  PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE,
} from './host-planned-resolution-coexistence.js';

const DELIVERY_EVENT = 'conversation_preamble_delivered' as const;

export interface PlanTaskActivationIdentity {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
}

interface PlanLogicalRow {
  accepted_task_id: string;
  logical_tool_call_id: string;
  tool_name: string;
  argument_digest: string;
  state: 'open' | 'settled' | 'conflict';
  outcome_kind: string | null;
}

interface DeliveryReceiptData {
  version: 1;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  planArgumentDigest: string;
  preambleEventId: string;
  preambleEventDigest: string;
  deliveryKey: string;
  deliveryStatus: 'delivered' | 'not_applicable';
  deliveryReason?: 'quiet_presentation' | 'non_user_surface';
  transportReceipt: ConversationPreambleTransportReceipt;
  transportReceiptDigest: string;
}

interface ExactPlanTopology {
  graphEvent: EventRow;
  graphId: string;
  graphHash: string;
  contractId: string;
}

interface PlanTaskPreparationCheckpointRow {
  accepted_task_id: string;
  logical_tool_call_id: string;
  checkpoint_version: number;
  plan_argument_digest: string;
  graph_event_id: string;
  graph_id: string;
  graph_hash: string;
  contract_id: string;
  preamble_event_id: string;
  preamble_event_digest: string;
  delivery_key: string;
  delivery_owner: 'durable_conversation' | 'carrier_owned' | 'legacy_unknown';
  recorded_at: string;
}

interface PlanTaskBindingSealIntentRow {
  accepted_task_id: string;
  logical_tool_call_id: string;
  intent_version: number;
  intent_origin: 'current' | 'legacy_backfill';
  plan_argument_digest: string;
  graph_event_id: string;
  graph_id: string;
  graph_hash: string;
  contract_id: string;
  objective_text: string;
  objective_digest: string;
  semantic_input_digest: string;
  operation_ids_json: string;
  operation_ids_digest: string;
  preamble_text: string;
  preamble_text_digest: string;
  delivery_owner: 'durable_conversation' | 'carrier_owned' | 'legacy_unknown';
  recorded_at: string;
}

export interface PlanTaskBindingSealIntent {
  identity: PlanTaskActivationIdentity;
  graphEvent: EventRow;
  graph: NonNullable<ReturnType<typeof turnGraphFromShadowEvent>>;
  contractId: string;
  objective: string;
  operationIds: string[];
  preamble: string;
  deliveryOwner: 'durable_conversation' | 'carrier_owned';
}

interface SuccessfulPlanTaskEvidence extends ExactPlanTopology {
  identity: PlanTaskActivationIdentity;
  logical: PlanLogicalRow;
  preamble: EventRow;
  deliveryOwner: PlanTaskPreparationCheckpointRow['delivery_owner'];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index]);
}

function validIdentity(input: PlanTaskActivationIdentity): boolean {
  return Boolean(input.sessionId.trim())
    && Number.isSafeInteger(input.sourceUserSeq)
    && input.sourceUserSeq > 0
    && input.acceptedTaskId === acceptedTaskIdFor(input.sessionId, input.sourceUserSeq)
    && Boolean(input.logicalToolCallId.trim());
}

function planLogicalRow(
  db: ReturnType<typeof openEventLog>,
  input: PlanTaskActivationIdentity,
): PlanLogicalRow | null {
  const row = db.prepare(`
    SELECT accepted_task_id, logical_tool_call_id, tool_name, argument_digest, state, outcome_kind
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as PlanLogicalRow | undefined;
  if (
    !row
    || row.accepted_task_id !== input.acceptedTaskId
    || row.logical_tool_call_id !== input.logicalToolCallId
    || row.tool_name !== 'plan_task'
    || !/^[a-f0-9]{64}$/.test(row.argument_digest)
  ) return null;
  return row;
}

function canonicalOperationIds(graph: NonNullable<ReturnType<typeof turnGraphFromShadowEvent>>): string[] | null {
  const operationIds = graph.workTopology?.topology.operations.map((operation) => operation.id) ?? [];
  return operationIds.length > 0 && new Set(operationIds).size === operationIds.length
    ? operationIds
    : null;
}

function durableObjectiveForSource(input: { sessionId: string; sourceUserSeq: number }): string | null {
  const source = listEvents(input.sessionId, {
    sinceSeq: input.sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  }).find((event) => event.seq === input.sourceUserSeq);
  const display = typeof source?.data.displayText === 'string' ? source.data.displayText.trim() : '';
  const text = typeof source?.data.text === 'string' ? source.data.text.trim() : '';
  const fallback = display || text;
  return fallback ? effectiveTurnObjective(input.sessionId, fallback, input.sourceUserSeq).trim() : null;
}

function rawPlanTaskBindingSealIntent(
  db: Database.Database,
  input: Pick<PlanTaskActivationIdentity, 'sessionId' | 'sourceUserSeq'>,
): PlanTaskBindingSealIntentRow | null {
  return db.prepare(`
    SELECT accepted_task_id, logical_tool_call_id, intent_version, intent_origin,
           plan_argument_digest, graph_event_id, graph_id, graph_hash, contract_id,
           objective_text, objective_digest, operation_ids_json,
           semantic_input_digest,
           operation_ids_digest, preamble_text, preamble_text_digest,
           delivery_owner, recorded_at
      FROM ${PLAN_TASK_BINDING_SEAL_INTENTS_TABLE}
     WHERE session_id = ? AND source_user_seq = ?
  `).get(input.sessionId, input.sourceUserSeq) as PlanTaskBindingSealIntentRow | undefined ?? null;
}

/** Decode the sole immutable pre-seal owner. This proof deliberately works
 * before the expected-work contract is frozen: the contract id is recomputed
 * from the exact graph topology and must later freeze byte-for-byte. */
export function exactPlanTaskBindingSealIntent(input: {
  sessionId: string;
  sourceUserSeq: number;
}): PlanTaskBindingSealIntent | null {
  const db = openEventLog();
  const row = rawPlanTaskBindingSealIntent(db, input);
  if (!row || row.intent_version !== 1 || row.intent_origin !== 'current') return null;
  const identity: PlanTaskActivationIdentity = {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: row.accepted_task_id,
    logicalToolCallId: row.logical_tool_call_id,
  };
  if (!validIdentity(identity)) return null;
  const logical = planLogicalRow(db, identity);
  const graphEvent = getTurnGraphEventForSource(input.sessionId, input.sourceUserSeq);
  const graph = turnGraphFromShadowEvent(graphEvent);
  if (!logical || !graphEvent || !graph || graph.classification.route !== 'act') return null;
  const operationIds = canonicalOperationIds(graph);
  let storedOperationIds: unknown;
  try { storedOperationIds = JSON.parse(row.operation_ids_json) as unknown; } catch { return null; }
  if (
    !operationIds
    || !Array.isArray(storedOperationIds)
    || storedOperationIds.some((value) => typeof value !== 'string')
    || JSON.stringify(storedOperationIds) !== JSON.stringify(operationIds)
    || row.operation_ids_digest !== sha256(closedCanonicalJson(operationIds))
    || row.plan_argument_digest !== logical.argument_digest
    || row.graph_event_id !== graphEvent.id
    || row.graph_id !== graph.graphId
    || row.graph_hash !== graph.compiler.graphHash
    || row.objective_text !== row.objective_text.trim()
    || !row.objective_text
    || row.objective_digest !== sha256(row.objective_text)
    || row.objective_text !== durableObjectiveForSource(input)
    || row.semantic_input_digest !== graph.source.inputHash
    || row.preamble_text !== row.preamble_text.trim()
    || !row.preamble_text
    || row.preamble_text_digest !== sha256(row.preamble_text)
    || (row.delivery_owner !== 'durable_conversation' && row.delivery_owner !== 'carrier_owned')
  ) return null;
  const prepared = prepareActionExpectedWorkContract({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    proposal: graph.workTopology?.topology,
  });
  if (prepared.status !== 'prepared' || prepared.contract.contractId !== row.contract_id) return null;
  return {
    identity,
    graphEvent,
    graph,
    contractId: row.contract_id,
    objective: row.objective_text,
    operationIds,
    preamble: row.preamble_text,
    deliveryOwner: row.delivery_owner,
  };
}

/** Classify the pre-checkpoint owner without guessing. A v70 graph or an
 * unreadable/legacy intent is explicitly held; only an exact current intent
 * may drive host-owned seal recovery. */
export function planTaskBindingSealRecoveryOwner(input: {
  sessionId: string;
  sourceUserSeq: number;
}): { status: 'missing' } | { status: 'held' } | { status: 'ready'; intent: PlanTaskBindingSealIntent } {
  const intent = exactPlanTaskBindingSealIntent(input);
  if (intent) return { status: 'ready', intent };
  const db = openEventLog();
  if (rawPlanTaskBindingSealIntent(db, input)) return { status: 'held' };
  const graph = turnGraphFromShadowEvent(getTurnGraphEventForSource(input.sessionId, input.sourceUserSeq));
  if (!graph || graph.classification.route !== 'act' || !graph.workTopology) return { status: 'missing' };
  const planCall = db.prepare(`
    SELECT 1
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND tool_name = 'plan_task'
     LIMIT 1
  `).get(input.sessionId, input.sourceUserSeq);
  return planCall ? { status: 'held' } : { status: 'missing' };
}

/** Bounded durable work queue for pre-checkpoint plan preparation. Selection
 * is intentionally broader than exact decoding: a corrupt/legacy row remains
 * visible to the recovery owner and is reported held, never silently skipped
 * as though the immutable graph had no continuation. `after` is a durable-row
 * keyset cursor used by the daemon sweep, so a held prefix cannot starve later
 * owners. Storage failures deliberately throw into the daemon's retry/logging
 * boundary instead of masquerading as an empty healthy queue. */
export function pendingPlanTaskBindingSealRecoveryCandidates(input: {
  limit?: number;
  after?: { sessionId: string; sourceUserSeq: number } | null;
} = {}): Array<{ sessionId: string; sourceUserSeq: number }> {
  const limit = Math.max(1, Math.min(32, Math.floor(input.limit ?? 8)));
  const db = openEventLog();
  const after = input.after
    ? db.prepare(`
        SELECT recorded_at AS recordedAt
          FROM ${PLAN_TASK_BINDING_SEAL_INTENTS_TABLE}
         WHERE session_id = ? AND source_user_seq = ?
      `).get(input.after.sessionId, input.after.sourceUserSeq) as { recordedAt: string } | undefined
    : undefined;
  return pendingPlanTaskBindingSealRecoveryCandidateRows(db, {
    limit,
    after: after && input.after
      ? {
          recordedAt: after.recordedAt,
          sessionId: input.after.sessionId,
          sourceUserSeq: input.after.sourceUserSeq,
        }
      : null,
  }).map(({ sessionId, sourceUserSeq }) => ({ sessionId, sourceUserSeq }));
}

interface PlanTaskBindingSealRecoveryCursor {
  recordedAt: string;
  sessionId: string;
  sourceUserSeq: number;
}

function pendingPlanTaskBindingSealRecoveryCandidateRows(
  db: ReturnType<typeof openEventLog>,
  input: { limit: number; after?: PlanTaskBindingSealRecoveryCursor | null },
): Array<PlanTaskBindingSealRecoveryCursor> {
  const afterWhere = input.after
    ? `AND (
         intent.recorded_at > ?
         OR (intent.recorded_at = ? AND intent.session_id > ?)
         OR (intent.recorded_at = ? AND intent.session_id = ? AND intent.source_user_seq > ?)
       )`
    : '';
  const args = input.after
    ? [
        input.after.recordedAt,
        input.after.recordedAt,
        input.after.sessionId,
        input.after.recordedAt,
        input.after.sessionId,
        input.after.sourceUserSeq,
        input.limit,
      ]
    : [input.limit];
  return db.prepare(`
      SELECT intent.session_id AS sessionId,
             intent.source_user_seq AS sourceUserSeq,
             intent.recorded_at AS recordedAt
        FROM ${PLAN_TASK_BINDING_SEAL_INTENTS_TABLE} intent
       WHERE NOT EXISTS (
         SELECT 1
           FROM ${PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE} checkpoint
          WHERE checkpoint.session_id = intent.session_id
            AND checkpoint.source_user_seq = intent.source_user_seq
       )
       ${afterWhere}
       ORDER BY intent.recorded_at ASC, intent.session_id ASC,
                intent.source_user_seq ASC
       LIMIT ?
    `).all(...args) as Array<PlanTaskBindingSealRecoveryCursor>;
}

/** Atomically reserve the next bounded page and advance a durable keyset
 * cursor before any recovery work begins. If this process dies immediately
 * after the claim, the next process continues past the claimed page and the
 * skipped rows are revisited after the cursor wraps at the durable tail. */
export function claimPendingPlanTaskBindingSealRecoveryCandidates(input: {
  limit?: number;
} = {}): Array<{ sessionId: string; sourceUserSeq: number }> {
  const limit = Math.max(1, Math.min(32, Math.floor(input.limit ?? 8)));
  const db = openEventLog();
  return db.transaction(() => {
    const cursor = db.prepare(`
      SELECT cursor_recorded_at AS recordedAt,
             cursor_session_id AS sessionId,
             cursor_source_user_seq AS sourceUserSeq
        FROM ${PLAN_TASK_BINDING_SEAL_RECOVERY_CURSOR_TABLE}
       WHERE cursor_key = 1
    `).get() as PlanTaskBindingSealRecoveryCursor | undefined;
    let rows = pendingPlanTaskBindingSealRecoveryCandidateRows(db, {
      limit,
      after: cursor ?? null,
    });
    if (rows.length === 0 && cursor) {
      rows = pendingPlanTaskBindingSealRecoveryCandidateRows(db, { limit, after: null });
    }
    if (rows.length === 0) {
      db.prepare(`DELETE FROM ${PLAN_TASK_BINDING_SEAL_RECOVERY_CURSOR_TABLE} WHERE cursor_key = 1`).run();
      return [];
    }
    const last = rows[rows.length - 1]!;
    db.prepare(`
      INSERT INTO ${PLAN_TASK_BINDING_SEAL_RECOVERY_CURSOR_TABLE}
        (cursor_key, cursor_recorded_at, cursor_session_id,
         cursor_source_user_seq, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(cursor_key) DO UPDATE SET
        cursor_recorded_at = excluded.cursor_recorded_at,
        cursor_session_id = excluded.cursor_session_id,
        cursor_source_user_seq = excluded.cursor_source_user_seq,
        updated_at = excluded.updated_at
    `).run(
      last.recordedAt,
      last.sessionId,
      last.sourceUserSeq,
      new Date().toISOString(),
    );
    return rows.map(({ sessionId, sourceUserSeq }) => ({ sessionId, sourceUserSeq }));
  })();
}

/** Insert the pre-seal owner inside the same IMMEDIATE transaction that first
 * writes the admitted graph. A thrown validation aborts both rows, eliminating
 * the graph-with-no-owner crash window. */
export function recordPlanTaskBindingSealIntentInTransaction(input: {
  db: Database.Database;
  identity: PlanTaskActivationIdentity;
  graphEvent: EventRow;
  objective: string;
  operationIds: readonly string[];
  preamble: string;
  deliveryOwner: 'durable_conversation' | 'carrier_owned';
}): { contractId: string } {
  if (!validIdentity(input.identity)) throw new Error('plan_task binding-seal intent identity is invalid');
  const logical = planLogicalRow(input.db, input.identity);
  const graph = turnGraphFromShadowEvent(input.graphEvent);
  const objective = input.objective.trim();
  const preamble = input.preamble.trim();
  const operationIds = graph ? canonicalOperationIds(graph) : null;
  const requestedOperationIds = [...input.operationIds];
  if (
    !logical
    || logical.state !== 'open'
    || !graph
    || graph.classification.route !== 'act'
    || graph.identity.sessionId !== input.identity.sessionId
    || graph.identity.sourceUserSeq !== input.identity.sourceUserSeq
    || !operationIds
    || requestedOperationIds.length !== operationIds.length
    || new Set(requestedOperationIds).size !== requestedOperationIds.length
    || requestedOperationIds.some((operationId) => !operationIds.includes(operationId))
    || !objective
    || objective !== durableObjectiveForSource(input.identity)
    || !preamble
  ) throw new Error('plan_task binding-seal intent requires its exact open call, graph, objective, operations, and preamble');
  const prepared = prepareActionExpectedWorkContract({
    sessionId: input.identity.sessionId,
    sourceUserSeq: input.identity.sourceUserSeq,
    proposal: graph.workTopology?.topology,
  });
  if (prepared.status !== 'prepared') {
    throw new Error(`plan_task binding-seal intent could not prepare exact work: ${prepared.reason}`);
  }
  const prior = rawPlanTaskBindingSealIntent(input.db, input.identity);
  if (prior) throw new Error('plan_task binding-seal intent already has a durable owner');
  const operationIdsJson = closedCanonicalJson(operationIds);
  input.db.prepare(`
    INSERT INTO ${PLAN_TASK_BINDING_SEAL_INTENTS_TABLE}
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
       intent_version, intent_origin, plan_argument_digest, graph_event_id,
       graph_id, graph_hash, contract_id, objective_text, objective_digest,
       semantic_input_digest,
       operation_ids_json, operation_ids_digest, preamble_text,
       preamble_text_digest, delivery_owner, recorded_at)
    VALUES (?, ?, ?, ?, 1, 'current', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.identity.sessionId,
    input.identity.sourceUserSeq,
    input.identity.acceptedTaskId,
    input.identity.logicalToolCallId,
    logical.argument_digest,
    input.graphEvent.id,
    graph.graphId,
    graph.compiler.graphHash,
    prepared.contract.contractId,
    objective,
    sha256(objective),
    graph.source.inputHash,
    operationIdsJson,
    sha256(operationIdsJson),
    preamble,
    sha256(preamble),
    input.deliveryOwner,
    new Date().toISOString(),
  );
  return { contractId: prepared.contract.contractId };
}

function exactPreamble(
  input: Pick<PlanTaskActivationIdentity, 'sessionId' | 'sourceUserSeq'>,
): { event: EventRow; eventDigest: string; deliveryKey: string } | null {
  const matches = listEvents(input.sessionId, { types: ['conversation_preamble'] })
    .filter((event) => event.data.sourceUserSeq === input.sourceUserSeq);
  if (matches.length !== 1) return null;
  const event = matches[0]!;
  try {
    const request = conversationPreambleDeliveryRequest(event);
    if (
      request.sessionId !== input.sessionId
      || request.sourceUserSeq !== input.sourceUserSeq
      || request.eventId !== event.id
    ) return null;
    return { event, eventDigest: request.eventDigest, deliveryKey: request.deliveryKey };
  } catch {
    return null;
  }
}

function validTransportReceipt(
  receipt: unknown,
  preamble: { event: EventRow; eventDigest: string; deliveryKey: string },
): receipt is ConversationPreambleTransportReceipt {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
  const value = receipt as Record<string, unknown>;
  return exactKeys(value, ['version', 'deliveryKey', 'eventId', 'eventDigest', 'surface', 'target'])
    && value.version === 1
    && value.deliveryKey === preamble.deliveryKey
    && value.eventId === preamble.event.id
    && value.eventDigest === preamble.eventDigest
    && (value.surface === 'channel_message' || value.surface === 'not_applicable')
    && typeof value.target === 'string'
    && Boolean(value.target.trim())
    && value.target.length <= 512
    && !value.target.includes('\0');
}

function validatedDelivery(input: {
  delivery: Exclude<ConversationPreambleDeliveryResult, { status: 'failed' }>;
  preamble: { event: EventRow; eventDigest: string; deliveryKey: string };
}): Pick<DeliveryReceiptData, 'deliveryStatus' | 'deliveryReason' | 'transportReceipt' | 'transportReceiptDigest'> {
  if (!validTransportReceipt(input.delivery.receipt, input.preamble)) {
    throw new Error('plan_task delivery receipt does not bind its exact preamble');
  }
  if (
    (input.delivery.status === 'delivered' && input.delivery.receipt.surface !== 'channel_message')
    || (input.delivery.status === 'not_applicable' && (
      input.delivery.receipt.surface !== 'not_applicable'
      || input.delivery.receipt.target !== input.delivery.reason
    ))
  ) throw new Error('plan_task delivery status conflicts with its transport receipt');
  const transportReceipt = { ...input.delivery.receipt };
  return {
    deliveryStatus: input.delivery.status,
    ...(input.delivery.status === 'not_applicable' ? { deliveryReason: input.delivery.reason } : {}),
    transportReceipt,
    transportReceiptDigest: sha256(closedCanonicalJson(transportReceipt)),
  };
}

function receiptData(event: EventRow): DeliveryReceiptData | null {
  if (event.type !== DELIVERY_EVENT || event.role !== 'system') return null;
  const data = event.data;
  const allowed = [
    'version',
    'sourceUserSeq',
    'acceptedTaskId',
    'logicalToolCallId',
    'planArgumentDigest',
    'preambleEventId',
    'preambleEventDigest',
    'deliveryKey',
    'deliveryStatus',
    'deliveryReason',
    'transportReceipt',
    'transportReceiptDigest',
  ];
  const expected = data.deliveryStatus === 'not_applicable'
    ? allowed
    : allowed.filter((key) => key !== 'deliveryReason');
  if (
    !exactKeys(data, expected)
    || data.version !== 1
    || !Number.isSafeInteger(data.sourceUserSeq)
    || Number(data.sourceUserSeq) <= 0
    || typeof data.acceptedTaskId !== 'string'
    || typeof data.logicalToolCallId !== 'string'
    || typeof data.planArgumentDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(data.planArgumentDigest)
    || typeof data.preambleEventId !== 'string'
    || typeof data.preambleEventDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(data.preambleEventDigest)
    || typeof data.deliveryKey !== 'string'
    || (data.deliveryStatus !== 'delivered' && data.deliveryStatus !== 'not_applicable')
    || (data.deliveryStatus === 'not_applicable'
      && data.deliveryReason !== 'quiet_presentation'
      && data.deliveryReason !== 'non_user_surface')
    || typeof data.transportReceiptDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(data.transportReceiptDigest)
  ) return null;
  return data as unknown as DeliveryReceiptData;
}

function exactDeliveryReceipt(input: {
  identity: PlanTaskActivationIdentity;
  logical: PlanLogicalRow;
  preamble: { event: EventRow; eventDigest: string; deliveryKey: string };
}): EventRow | null {
  const receipts = listEvents(input.identity.sessionId, { types: [DELIVERY_EVENT] })
    .filter((event) => event.data.sourceUserSeq === input.identity.sourceUserSeq
      && event.data.logicalToolCallId === input.identity.logicalToolCallId);
  if (receipts.length !== 1) return null;
  const event = receipts[0]!;
  const data = receiptData(event);
  if (
    !data
    || event.turn !== input.preamble.event.turn
    || event.parentEventId !== input.preamble.event.id
    || data.sourceUserSeq !== input.identity.sourceUserSeq
    || data.acceptedTaskId !== input.identity.acceptedTaskId
    || data.logicalToolCallId !== input.identity.logicalToolCallId
    || data.planArgumentDigest !== input.logical.argument_digest
    || data.preambleEventId !== input.preamble.event.id
    || data.preambleEventDigest !== input.preamble.eventDigest
    || data.deliveryKey !== input.preamble.deliveryKey
    || !validTransportReceipt(data.transportReceipt, input.preamble)
    || data.transportReceiptDigest !== sha256(closedCanonicalJson(data.transportReceipt))
    || (data.deliveryStatus === 'delivered' && data.transportReceipt.surface !== 'channel_message')
    || (data.deliveryStatus === 'not_applicable' && (
      data.transportReceipt.surface !== 'not_applicable'
      || data.transportReceipt.target !== data.deliveryReason
    ))
  ) return null;
  const topology = exactPlanTopology(input.identity);
  const checkpoint = exactPreparationCheckpoint(input.identity);
  if (!topology || !checkpoint) return null;
  if (
    (checkpoint.delivery_owner === 'durable_conversation'
      && data.transportReceipt.target !== 'durable_conversation')
    || (checkpoint.delivery_owner !== 'durable_conversation'
      && data.transportReceipt.target === 'durable_conversation')
  ) return null;
  const normalized = openEventLog().prepare(`
    SELECT accepted_task_id, logical_tool_call_id, plan_argument_digest,
           graph_event_id, graph_id, graph_hash, contract_id,
           preamble_event_id, preamble_event_digest, delivery_key,
           delivery_event_id, delivery_status, delivery_reason,
           transport_receipt_json, transport_receipt_digest, transport_target
      FROM ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE}
     WHERE session_id = ? AND source_user_seq = ?
  `).get(input.identity.sessionId, input.identity.sourceUserSeq) as {
    accepted_task_id: string;
    logical_tool_call_id: string;
    plan_argument_digest: string;
    graph_event_id: string;
    graph_id: string;
    graph_hash: string;
    contract_id: string;
    preamble_event_id: string;
    preamble_event_digest: string;
    delivery_key: string;
    delivery_event_id: string;
    delivery_status: string;
    delivery_reason: string | null;
    transport_receipt_json: string;
    transport_receipt_digest: string;
    transport_target: string;
  } | undefined;
  if (
    !normalized
    || normalized.accepted_task_id !== input.identity.acceptedTaskId
    || normalized.logical_tool_call_id !== input.identity.logicalToolCallId
    || normalized.plan_argument_digest !== input.logical.argument_digest
    || normalized.graph_event_id !== topology.graphEvent.id
    || normalized.graph_id !== topology.graphId
    || normalized.graph_hash !== topology.graphHash
    || normalized.contract_id !== topology.contractId
    || normalized.preamble_event_id !== input.preamble.event.id
    || normalized.preamble_event_digest !== input.preamble.eventDigest
    || normalized.delivery_key !== input.preamble.deliveryKey
    || normalized.delivery_event_id !== event.id
    || normalized.delivery_status !== data.deliveryStatus
    || normalized.delivery_reason !== (data.deliveryReason ?? null)
    || normalized.transport_receipt_json !== closedCanonicalJson(data.transportReceipt)
    || normalized.transport_receipt_digest !== data.transportReceiptDigest
    || normalized.transport_target !== data.transportReceipt.target
    || checkpoint.logical_tool_call_id !== normalized.logical_tool_call_id
    || checkpoint.plan_argument_digest !== normalized.plan_argument_digest
    || checkpoint.graph_event_id !== normalized.graph_event_id
    || checkpoint.graph_id !== normalized.graph_id
    || checkpoint.graph_hash !== normalized.graph_hash
    || checkpoint.contract_id !== normalized.contract_id
    || checkpoint.preamble_event_id !== normalized.preamble_event_id
    || checkpoint.preamble_event_digest !== normalized.preamble_event_digest
    || checkpoint.delivery_key !== normalized.delivery_key
  ) return null;
  return event;
}

/** Record the exact awaited transport acknowledgement while this plan call is
 * still open. The same call may replay the write byte-for-byte; another call,
 * preamble, digest, or transport acknowledgement cannot borrow it. */
export function recordPlanTaskPreambleDelivery(input: {
  identity: PlanTaskActivationIdentity;
  preamble: EventRow;
  delivery: Exclude<ConversationPreambleDeliveryResult, { status: 'failed' }>;
}): { event: EventRow; inserted: boolean } {
  if (!validIdentity(input.identity)) throw new Error('plan_task delivery identity is invalid');
  const preamble = exactPreamble(input.identity);
  if (!preamble || preamble.event.id !== input.preamble.id) {
    throw new Error('plan_task delivery requires its exact durable preamble');
  }
  const delivery = validatedDelivery({ delivery: input.delivery, preamble });

  const db = openEventLog();
  let inserted: EventRow | null = null;
  const result = db.transaction((): { event: EventRow; inserted: boolean } => {
    const logical = planLogicalRow(db, input.identity);
    if (!logical || (logical.state !== 'open' && logical.state !== 'settled')) {
      throw new Error('plan_task delivery requires its exact open or settled logical call');
    }
    const checkpoint = exactPreparationCheckpoint(input.identity);
    if (!checkpoint) {
      throw new Error('plan_task delivery requires its exact immutable preparation checkpoint');
    }
    if (
      (checkpoint.delivery_owner === 'durable_conversation'
        && delivery.transportReceipt.target !== 'durable_conversation')
      || (checkpoint.delivery_owner !== 'durable_conversation'
        && delivery.transportReceipt.target === 'durable_conversation')
    ) {
      throw new Error('plan_task delivery receipt conflicts with its durable presentation owner');
    }
    const existing = exactDeliveryReceipt({ identity: input.identity, logical, preamble });
    if (existing) {
      const prior = receiptData(existing)!;
      if (
        prior.deliveryStatus !== delivery.deliveryStatus
        || prior.deliveryReason !== delivery.deliveryReason
        || prior.transportReceiptDigest !== delivery.transportReceiptDigest
      ) throw new Error('plan_task delivery receipt conflicts with its exact replay');
      return { event: existing, inserted: false };
    }
    const competing = listEvents(input.identity.sessionId, { types: [DELIVERY_EVENT] })
      .some((event) => event.data.sourceUserSeq === input.identity.sourceUserSeq
        && event.data.logicalToolCallId === input.identity.logicalToolCallId);
    if (competing) throw new Error('plan_task delivery receipt conflicts with its exact call');
    inserted = insertInternalEventInTransaction(db, {
      sessionId: input.identity.sessionId,
      turn: preamble.event.turn,
      role: 'system',
      type: DELIVERY_EVENT,
      parentEventId: preamble.event.id,
      data: {
        version: 1,
        sourceUserSeq: input.identity.sourceUserSeq,
        acceptedTaskId: input.identity.acceptedTaskId,
        logicalToolCallId: input.identity.logicalToolCallId,
        planArgumentDigest: logical.argument_digest,
        preambleEventId: preamble.event.id,
        preambleEventDigest: preamble.eventDigest,
        deliveryKey: preamble.deliveryKey,
        ...delivery,
      } satisfies DeliveryReceiptData,
    });
    const topology = exactPlanTopology(input.identity);
    if (!topology) throw new Error('plan_task delivery lost its exact structured-model topology');
    db.prepare(`
      INSERT INTO ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE}
        (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
         receipt_version, plan_argument_digest, graph_event_id, graph_id,
         graph_hash, contract_id, preamble_event_id, preamble_event_digest,
         delivery_key, delivery_event_id, delivery_status, delivery_reason,
         transport_receipt_json, transport_receipt_digest, transport_target,
         recorded_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.identity.sessionId,
      input.identity.sourceUserSeq,
      input.identity.acceptedTaskId,
      input.identity.logicalToolCallId,
      logical.argument_digest,
      topology.graphEvent.id,
      topology.graphId,
      topology.graphHash,
      topology.contractId,
      preamble.event.id,
      preamble.eventDigest,
      preamble.deliveryKey,
      inserted.id,
      delivery.deliveryStatus,
      delivery.deliveryReason ?? null,
      closedCanonicalJson(delivery.transportReceipt),
      delivery.transportReceiptDigest,
      delivery.transportReceipt.target,
      inserted.createdAt,
    );
    return { event: inserted, inserted: true };
  }).immediate();
  if (inserted) publishCommittedInternalEvent(inserted);
  return result;
}

function exactPlanTopology(input: PlanTaskActivationIdentity): ExactPlanTopology | null {
  const graphEvent = getTurnGraphEventForSource(input.sessionId, input.sourceUserSeq);
  const graph = turnGraphFromShadowEvent(graphEvent);
  const contract = loadExpectedWorkContract(input.sessionId, input.sourceUserSeq);
  if (
    !graphEvent
    || !graph
    || graph.classification.route !== 'act'
    || contract.status !== 'ok'
    || contract.contract.plannerSource !== 'structured_model'
  ) return null;
  const db = openEventLog();
  const authority = db.prepare(`
    SELECT accepted_task_id, graph_event_id, graph_id, graph_hash,
           work_contract_id, state
      FROM accepted_task_authority
     WHERE session_id = ? AND source_user_seq = ?
  `).get(input.sessionId, input.sourceUserSeq) as {
    accepted_task_id: string;
    graph_event_id: string;
    graph_id: string;
    graph_hash: string;
    work_contract_id: string | null;
    state: string;
  } | undefined;
  if (
    !authority
    || authority.accepted_task_id !== input.acceptedTaskId
    || authority.graph_event_id !== graphEvent.id
    || authority.graph_id !== graph.graphId
    || authority.graph_hash !== graph.compiler.graphHash
    || authority.work_contract_id !== contract.contract.contractId
    || contract.contract.acceptedTaskId !== input.acceptedTaskId
    || contract.contract.graphEventId !== graphEvent.id
    || contract.contract.graphId !== graph.graphId
    || contract.contract.graphHash !== graph.compiler.graphHash
    || authority.state === 'conflict'
  ) return null;
  return {
    graphEvent,
    graphId: graph.graphId,
    graphHash: graph.compiler.graphHash,
    contractId: contract.contract.contractId,
  };
}

function exactPreparationCheckpoint(
  input: PlanTaskActivationIdentity,
): PlanTaskPreparationCheckpointRow | null {
  const row = openEventLog().prepare(`
    SELECT accepted_task_id, logical_tool_call_id, checkpoint_version,
           plan_argument_digest, graph_event_id, graph_id, graph_hash,
           contract_id, preamble_event_id, preamble_event_digest,
           delivery_key, delivery_owner, recorded_at
      FROM ${PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE}
     WHERE session_id = ? AND source_user_seq = ?
  `).get(input.sessionId, input.sourceUserSeq) as PlanTaskPreparationCheckpointRow | undefined;
  if (
    !row
    || row.accepted_task_id !== input.acceptedTaskId
    || row.logical_tool_call_id !== input.logicalToolCallId
    || row.checkpoint_version !== 1
    || !/^[a-f0-9]{64}$/.test(row.plan_argument_digest)
    || !/^[a-f0-9]{64}$/.test(row.graph_hash)
    || !/^[a-f0-9]{64}$/.test(row.preamble_event_digest)
    || !row.delivery_key.startsWith('preamble-delivery:v1:')
  ) return null;
  const logical = planLogicalRow(openEventLog(), input);
  const topology = exactPlanTopology(input);
  const preamble = exactPreamble(input);
  const intent = rawPlanTaskBindingSealIntent(openEventLog(), input);
  if (
    !logical
    || !topology
    || !preamble
    || !intent
    || row.plan_argument_digest !== logical.argument_digest
    || row.graph_event_id !== topology.graphEvent.id
    || row.graph_id !== topology.graphId
    || row.graph_hash !== topology.graphHash
    || row.contract_id !== topology.contractId
    || row.preamble_event_id !== preamble.event.id
    || row.preamble_event_digest !== preamble.eventDigest
    || row.delivery_key !== preamble.deliveryKey
    || intent.accepted_task_id !== row.accepted_task_id
    || intent.logical_tool_call_id !== row.logical_tool_call_id
    || intent.plan_argument_digest !== row.plan_argument_digest
    || intent.graph_event_id !== row.graph_event_id
    || intent.graph_id !== row.graph_id
    || intent.graph_hash !== row.graph_hash
    || intent.contract_id !== row.contract_id
    || intent.preamble_text !== preamble.event.data.text
    || intent.delivery_owner !== row.delivery_owner
  ) return null;
  return row;
}

function settledInterruptedHostPlanControl(
  db: Database.Database,
  identity: PlanTaskActivationIdentity,
): boolean {
  const row = db.prepare(`
    SELECT settlement.execution_kind, settlement.outcome_kind,
           settlement.business_call, settlement.mutating,
           settlement.physical_crossing_count, settlement.host_crossing_count
      FROM logical_tool_calls call
      JOIN logical_call_settlements settlement
        ON settlement.session_id = call.session_id
       AND settlement.source_user_seq = call.source_user_seq
       AND settlement.logical_tool_call_id = call.logical_tool_call_id
       AND settlement.settlement_event_id = call.settlement_event_id
     WHERE call.session_id = ? AND call.source_user_seq = ?
       AND call.accepted_task_id = ? AND call.logical_tool_call_id = ?
       AND call.tool_name = 'plan_task' AND call.state = 'settled'
       AND call.outcome_kind = settlement.outcome_kind
  `).get(
    identity.sessionId,
    identity.sourceUserSeq,
    identity.acceptedTaskId,
    identity.logicalToolCallId,
  ) as {
    execution_kind: string;
    outcome_kind: string;
    business_call: number;
    mutating: number;
    physical_crossing_count: number;
    host_crossing_count: number | null;
  } | undefined;
  return Boolean(
    row
    && row.execution_kind === 'local_execution'
    && row.outcome_kind !== 'succeeded'
    && row.outcome_kind !== 'uncertain_write'
    && row.business_call === 0
    && row.mutating === 0
    && row.physical_crossing_count === 0
    && row.host_crossing_count === 1,
  );
}

/**
 * Freeze the last effect-free plan_task checkpoint before presentation I/O.
 * This row is the restart owner for both adjacent crash windows: a missing
 * transport receipt and a committed receipt whose host settlement was later
 * interrupted. It grants no business authority by itself.
 */
export function recordPlanTaskPreparationCheckpoint(input: {
  identity: PlanTaskActivationIdentity;
  preamble: EventRow;
  deliveryOwner: 'durable_conversation' | 'carrier_owned';
}): { inserted: boolean } {
  if (!validIdentity(input.identity)) throw new Error('plan_task checkpoint identity is invalid');
  if (input.deliveryOwner !== 'durable_conversation' && input.deliveryOwner !== 'carrier_owned') {
    throw new Error('plan_task checkpoint delivery owner is invalid');
  }
  const preamble = exactPreamble(input.identity);
  const topology = exactPlanTopology(input.identity);
  const intent = exactPlanTaskBindingSealIntent(input.identity);
  if (
    !preamble
    || preamble.event.id !== input.preamble.id
    || !topology
    || !intent
    || intent.contractId !== topology.contractId
    || intent.preamble !== preamble.event.data.text
    || intent.deliveryOwner !== input.deliveryOwner
  ) {
    throw new Error('plan_task checkpoint requires its exact durable topology and preamble');
  }
  const db = openEventLog();
  return db.transaction((): { inserted: boolean } => {
    // Once this exact immutable checkpoint exists, later success settlement of
    // the owning host-control call is expected. Recovery may re-enter here
    // after an unrelated sibling/result-projection crash, so validate and
    // replay the frozen row before applying the first-insert call-state gate.
    const existing = exactPreparationCheckpoint(input.identity);
    if (existing) {
      if (existing.delivery_owner !== input.deliveryOwner) {
        throw new Error('plan_task checkpoint delivery owner conflicts with its exact replay');
      }
      return { inserted: false };
    }
    const logical = planLogicalRow(db, input.identity);
    if (
      !logical
      || (logical.state !== 'open' && !settledInterruptedHostPlanControl(db, input.identity))
    ) {
      throw new Error('plan_task checkpoint requires its exact open or interrupted host-only logical call');
    }
    const competing = db.prepare(`
      SELECT logical_tool_call_id
        FROM ${PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE}
       WHERE session_id = ? AND source_user_seq = ?
    `).get(input.identity.sessionId, input.identity.sourceUserSeq) as {
      logical_tool_call_id: string;
    } | undefined;
    if (competing) {
      throw new Error('plan_task checkpoint is already owned by another exact logical call');
    }
    db.prepare(`
      INSERT INTO ${PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE}
        (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
         checkpoint_version, plan_argument_digest, graph_event_id, graph_id,
         graph_hash, contract_id, preamble_event_id, preamble_event_digest,
         delivery_key, delivery_owner, recorded_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.identity.sessionId,
      input.identity.sourceUserSeq,
      input.identity.acceptedTaskId,
      input.identity.logicalToolCallId,
      logical.argument_digest,
      topology.graphEvent.id,
      topology.graphId,
      topology.graphHash,
      topology.contractId,
      preamble.event.id,
      preamble.eventDigest,
      preamble.deliveryKey,
      input.deliveryOwner,
      new Date().toISOString(),
    );
    if (!exactPreparationCheckpoint(input.identity)) {
      throw new Error('plan_task checkpoint did not replay exactly after insertion');
    }
    return { inserted: true };
  }).immediate();
}

function successfulPlanResult(input: {
  identity: PlanTaskActivationIdentity;
  topology: ExactPlanTopology;
}): boolean {
  const redeemed = redeemSuccessfulSettlementResultForHost(input.identity);
  if (
    redeemed.status !== 'ok'
    || redeemed.value.toolName !== 'plan_task'
    || redeemed.value.executionSite !== 'host'
    || redeemed.value.outcomeKind !== 'succeeded'
  ) return false;
  let payload: unknown = redeemed.value.rawPayload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload) as unknown; } catch { return false; }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const result = payload as Record<string, unknown>;
  return result.ok === true
    && result.acceptedTaskId === input.identity.acceptedTaskId
    && result.graphId === input.topology.graphId
    && result.graphHash === input.topology.graphHash
    && result.contractId === input.topology.contractId;
}

function checkpointBackedSettledPlanTask(
  input: PlanTaskActivationIdentity,
): SuccessfulPlanTaskEvidence | null {
  if (!validIdentity(input)) return null;
  const db = openEventLog();
  const logical = planLogicalRow(db, input);
  if (!logical || logical.state !== 'settled') return null;
  const settlement = db.prepare(`
    SELECT execution_kind, outcome_kind, business_call, mutating,
           physical_crossing_count, host_crossing_count
      FROM logical_call_settlements
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as {
    execution_kind: string;
    outcome_kind: string;
    business_call: number;
    mutating: number;
    physical_crossing_count: number;
    host_crossing_count: number | null;
  } | undefined;
  if (
    !settlement
    || settlement.execution_kind !== 'local_execution'
    || settlement.outcome_kind === 'uncertain_write'
    || logical.outcome_kind !== settlement.outcome_kind
    || settlement.business_call !== 0
    || settlement.mutating !== 0
    || settlement.physical_crossing_count !== 0
    || settlement.host_crossing_count !== 1
  ) return null;
  const topology = exactPlanTopology(input);
  const preamble = exactPreamble(input);
  const checkpoint = exactPreparationCheckpoint(input);
  if (!topology || !preamble || !checkpoint) return null;
  // Normal completion keeps the original redeemed ok:true result invariant.
  // Interrupted/transport-failed completion is never rewritten to success;
  // its immutable pre-delivery checkpoint and later exact receipt are the
  // distinct recovery proof.
  if (
    settlement.outcome_kind === 'succeeded'
    && !successfulPlanResult({ identity: input, topology })
  ) return null;
  return {
    identity: input,
    logical,
    preamble: preamble.event,
    deliveryOwner: checkpoint.delivery_owner,
    ...topology,
  };
}

function checkpointPlanTaskIdentity(input: {
  sessionId: string;
  sourceUserSeq: number;
}): PlanTaskActivationIdentity | null {
  const acceptedTaskId = acceptedTaskIdFor(input.sessionId, input.sourceUserSeq);
  const row = openEventLog().prepare(`
    SELECT logical_tool_call_id
      FROM ${PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE}
     WHERE session_id = ? AND source_user_seq = ? AND accepted_task_id = ?
  `).get(input.sessionId, input.sourceUserSeq, acceptedTaskId) as {
    logical_tool_call_id: string;
  } | undefined;
  if (!row) return null;
  const identity = {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId,
    logicalToolCallId: row.logical_tool_call_id,
  };
  return exactPreparationCheckpoint(identity) ? identity : null;
}

/** A v70 store can contain graph/contract/preamble truth with no immutable
 * checkpoint naming the winning logical call or presentation owner. Never
 * guess between overlapping calls or silently substitute the durable lane;
 * surface a held owner until an exact migration/reconciliation can bind it. */
function hasLegacyPreparedPlanOrphan(input: {
  sessionId: string;
  sourceUserSeq: number;
}): boolean {
  const row = openEventLog().prepare(`
    SELECT 1
      FROM accepted_turn_call_authorities root
      JOIN accepted_task_authority task
        ON task.session_id = root.session_id
       AND task.source_user_seq = root.source_user_seq
       AND task.accepted_task_id = root.accepted_task_id
      JOIN accepted_task_work_contracts contract
        ON contract.session_id = task.session_id
       AND contract.source_user_seq = task.source_user_seq
       AND contract.accepted_task_id = task.accepted_task_id
       AND contract.contract_id = task.work_contract_id
      JOIN events source
        ON source.session_id = root.session_id
       AND source.seq = root.source_user_seq
       AND source.id = root.source_event_id
      JOIN events preamble
        ON preamble.session_id = source.session_id
       AND preamble.parent_event_id = source.id
       AND preamble.turn = source.turn
       AND preamble.role = 'Clem'
       AND preamble.type = 'conversation_preamble'
      JOIN logical_tool_calls call
        ON call.session_id = root.session_id
       AND call.source_user_seq = root.source_user_seq
       AND call.accepted_task_id = root.accepted_task_id
       AND call.tool_name = 'plan_task'
     WHERE root.session_id = ?
       AND root.source_user_seq = ?
       AND root.authority_kind = 'host_v1'
       AND root.engine_version = 'host_v1'
       AND task.expected_work_required = 0
       AND task.state != 'conflict'
       AND contract.contract_version = 1
       AND contract.planner_source = 'structured_model'
       AND json_extract(preamble.data_json, '$.version') = 1
       AND json_extract(preamble.data_json, '$.kind') = 'pre_execution'
       AND json_extract(preamble.data_json, '$.sourceUserSeq') = root.source_user_seq
       AND NOT EXISTS (
         SELECT 1 FROM ${PLAN_TASK_PREPARATION_CHECKPOINTS_TABLE} checkpoint
          WHERE checkpoint.session_id = root.session_id
            AND checkpoint.source_user_seq = root.source_user_seq
       )
     LIMIT 1
  `).get(input.sessionId, input.sourceUserSeq);
  return Boolean(row);
}

/** Return the one exact checkpoint-owned plan completion. A normal plan keeps
 * its redeemed ok:true result; a post-checkpoint host interruption remains a
 * non-success settlement and can advance only after the same preamble obtains
 * its exact immutable transport receipt. */
export function settledPlanTaskActivationWinner(input: {
  sessionId: string;
  sourceUserSeq: number;
}): { status: 'missing' | 'held' | 'delivery_required' | 'ok'; evidence?: SuccessfulPlanTaskEvidence } {
  const identity = checkpointPlanTaskIdentity(input);
  if (!identity) return { status: hasLegacyPreparedPlanOrphan(input) ? 'held' : 'missing' };
  const evidence = checkpointBackedSettledPlanTask(identity);
  if (!evidence) return { status: 'missing' };
  const preamble = exactPreamble(evidence.identity);
  if (!preamble) throw new Error('checkpoint-backed plan_task lost its exact preamble');
  const receipt = exactDeliveryReceipt({
    identity: evidence.identity,
    logical: evidence.logical,
    preamble,
  });
  return receipt ? { status: 'ok', evidence } : { status: 'delivery_required', evidence };
}

/** Reusable read-only predicate for downstream policy/evidence consumers. It
 * proves that the structured-model plan won *and* that its exact work contract
 * has crossed the durable activation CAS. */
export function exactActivatedPlanTaskAuthority(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  graphEventId: string;
  graphId: string;
  graphHash: string;
  contractId: string;
}): boolean {
  const winner = settledPlanTaskActivationWinner(input);
  if (winner.status !== 'ok' || !winner.evidence) return false;
  const evidence = winner.evidence;
  if (
    evidence.identity.acceptedTaskId !== input.acceptedTaskId
    || evidence.graphEvent.id !== input.graphEventId
    || evidence.graphId !== input.graphId
    || evidence.graphHash !== input.graphHash
    || evidence.contractId !== input.contractId
  ) return false;
  const authority = openEventLog().prepare(`
    SELECT accepted_task_id, graph_event_id, graph_id, graph_hash,
           work_contract_id, expected_work_required, state
      FROM accepted_task_authority
     WHERE session_id = ? AND source_user_seq = ?
  `).get(input.sessionId, input.sourceUserSeq) as {
    accepted_task_id: string;
    graph_event_id: string;
    graph_id: string;
    graph_hash: string;
    work_contract_id: string | null;
    expected_work_required: number;
    state: string;
  } | undefined;
  return Boolean(
    authority
    && authority.accepted_task_id === input.acceptedTaskId
    && authority.graph_event_id === input.graphEventId
    && authority.graph_id === input.graphId
    && authority.graph_hash === input.graphHash
    && authority.work_contract_id === input.contractId
    && authority.expected_work_required === 1
    && authority.state !== 'conflict',
  );
}

/** Immediate post-settlement edge. Receipt, graph, or settlement evidence alone
 * never activates; the complete durable winner is required. */
export function activateSettledPlanTaskAfterLogicalSettlement(
  input: PlanTaskActivationIdentity,
): { status: 'not_ready' | 'activated' | 'replayed' } {
  const winner = settledPlanTaskActivationWinner(input);
  if (
    winner.status !== 'ok'
    || !winner.evidence
    || winner.evidence.identity.logicalToolCallId !== input.logicalToolCallId
  ) return { status: 'not_ready' };
  const activated = activateActionExpectedWork(input);
  if (activated.status === 'activated' || activated.status === 'replayed') {
    return { status: activated.status };
  }
  return { status: 'not_ready' };
}

interface PlanTaskActivationRecoveryPorts<Evidence> {
  winner(): { status: 'missing' | 'held' | 'delivery_required' | 'ok'; evidence?: Evidence };
  delivery?: ConversationPreambleDeliveryCallback;
  deliveryRequest(evidence: Evidence): ReturnType<typeof conversationPreambleDeliveryRequest>;
  recordDelivery(
    evidence: Evidence,
    delivery: Exclude<ConversationPreambleDeliveryResult, { status: 'failed' }>,
  ): void;
  activate(evidence: Evidence): { status: 'not_ready' | 'activated' | 'replayed' };
}

/** Complete the presentation-to-activation edge from restart-safe ports. The
 * transport owns idempotent editing of its already-created placeholder. A
 * send-before-receipt failure therefore leaves the same request replayable;
 * no model, provider, or business authority is consulted in this sequence. */
async function recoverPlanTaskActivationFromPorts<Evidence>(
  ports: PlanTaskActivationRecoveryPorts<Evidence>,
): Promise<{ status: 'not_pending' | 'delivery_required' | 'activated' | 'replayed' }> {
  let winner = ports.winner();
  if (winner.status === 'missing') return { status: 'not_pending' };
  if (winner.status === 'held') return { status: 'delivery_required' };
  if (!winner.evidence) throw new Error('plan_task recovery winner lost its durable evidence');

  if (winner.status === 'delivery_required') {
    if (!ports.delivery) return { status: 'delivery_required' };
    let delivered: ConversationPreambleDeliveryResult;
    try {
      delivered = await ports.delivery(ports.deliveryRequest(winner.evidence));
    } catch {
      return { status: 'delivery_required' };
    }
    if (delivered.status === 'failed') return { status: 'delivery_required' };
    try {
      ports.recordDelivery(winner.evidence, delivered);
    } catch {
      // The edit may already be visible, and the durable insert may have won
      // before a post-commit publisher threw. Re-read truth: an exact receipt
      // may continue; otherwise leave the same content-addressed request
      // recoverable for the next attempt.
      winner = ports.winner();
      if (winner.status !== 'ok' || !winner.evidence) {
        return { status: 'delivery_required' };
      }
    }
    winner = ports.winner();
    if (winner.status !== 'ok' || !winner.evidence) {
      return { status: 'delivery_required' };
    }
  }

  const activation = ports.activate(winner.evidence);
  if (activation.status === 'not_ready') return { status: 'not_pending' };
  return { status: activation.status };
}

function restartDeliveryForOwner(
  owner: SuccessfulPlanTaskEvidence['deliveryOwner'] | undefined,
  supplied: ConversationPreambleDeliveryCallback | undefined,
): ConversationPreambleDeliveryCallback | undefined {
  if (supplied) return supplied;
  return owner === 'durable_conversation'
    ? hostDurableConversationPreambleDelivery()
    : undefined;
}

/** Restart seam used before another foreground model step. It consumes only
 * durable plan evidence and reissues the exact content-addressed presentation
 * request when its receipt is missing. The callback may only acknowledge its
 * owned placeholder; activation still requires the receipt to be validated
 * and persisted against the already-settled logical plan. */
export async function recoverSettledPlanTaskActivation(input: {
  sessionId: string;
  sourceUserSeq: number;
  onConversationPreamble?: ConversationPreambleDeliveryCallback;
}): Promise<{ status: 'not_pending' | 'delivery_required' | 'activated' | 'replayed' }> {
  const durableWinner = settledPlanTaskActivationWinner(input);
  const recoveryDelivery = restartDeliveryForOwner(
    durableWinner.evidence?.deliveryOwner,
    input.onConversationPreamble,
  );
  return recoverPlanTaskActivationFromPorts<SuccessfulPlanTaskEvidence>({
    winner: () => settledPlanTaskActivationWinner(input),
    ...(recoveryDelivery ? { delivery: recoveryDelivery } : {}),
    deliveryRequest: (evidence) => conversationPreambleDeliveryRequest(evidence.preamble),
    recordDelivery: (evidence, delivery) => {
      recordPlanTaskPreambleDelivery({
        identity: evidence.identity,
        preamble: evidence.preamble,
        delivery,
      });
    },
    activate: (evidence) => activateSettledPlanTaskAfterLogicalSettlement(evidence.identity),
  });
}

export const __test__ = {
  recoverPlanTaskActivationFromPorts,
  restartDeliveryForOwner,
};
