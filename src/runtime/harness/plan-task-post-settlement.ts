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
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { activateActionExpectedWork } from './expected-work-admission.js';
import { turnGraphFromShadowEvent } from '../graph/turn-graph-shadow.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { PLAN_TASK_ACTIVATION_RECEIPTS_TABLE } from './host-planned-resolution-coexistence.js';

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

interface SuccessfulPlanTaskEvidence extends ExactPlanTopology {
  identity: PlanTaskActivationIdentity;
  logical: PlanLogicalRow;
  preamble: EventRow;
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
    SELECT accepted_task_id, logical_tool_call_id, tool_name, argument_digest, state
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
  if (!topology) return null;
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

function successfulSettledPlanTask(
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
    || settlement.outcome_kind !== 'succeeded'
    || settlement.business_call !== 0
    || settlement.mutating !== 0
    || settlement.physical_crossing_count !== 0
    || settlement.host_crossing_count !== 1
  ) return null;
  const topology = exactPlanTopology(input);
  const preamble = exactPreamble(input);
  if (!topology || !preamble || !successfulPlanResult({ identity: input, topology })) return null;
  return { identity: input, logical, preamble: preamble.event, ...topology };
}

function candidatePlanTaskIdentities(input: {
  sessionId: string;
  sourceUserSeq: number;
}): PlanTaskActivationIdentity[] {
  const acceptedTaskId = acceptedTaskIdFor(input.sessionId, input.sourceUserSeq);
  const rows = openEventLog().prepare(`
    SELECT logical_tool_call_id
      FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
       AND accepted_task_id = ? AND tool_name = 'plan_task' AND state = 'settled'
     ORDER BY opened_at, logical_tool_call_id
  `).all(input.sessionId, input.sourceUserSeq, acceptedTaskId) as Array<{
    logical_tool_call_id: string;
  }>;
  return rows.map((row) => ({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId,
    logicalToolCallId: row.logical_tool_call_id,
  }));
}

/** Return the one exact receipt-linked, redeemed ok:true plan winner. Earlier
 * normally-settled `{ok:false}` repair attempts are intentionally ignored. */
export function settledPlanTaskActivationWinner(input: {
  sessionId: string;
  sourceUserSeq: number;
}): { status: 'missing' | 'delivery_required' | 'ok'; evidence?: SuccessfulPlanTaskEvidence } {
  const successful = candidatePlanTaskIdentities(input)
    .map(successfulSettledPlanTask)
    .filter((candidate): candidate is SuccessfulPlanTaskEvidence => candidate !== null);
  if (successful.length === 0) return { status: 'missing' };
  if (successful.length !== 1) throw new Error('plan_task activation found competing ok:true plan controls');
  const evidence = successful[0]!;
  const preamble = exactPreamble(evidence.identity);
  if (!preamble) throw new Error('successful plan_task lost its exact preamble');
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
  winner(): { status: 'missing' | 'delivery_required' | 'ok'; evidence?: Evidence };
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
  return recoverPlanTaskActivationFromPorts<SuccessfulPlanTaskEvidence>({
    winner: () => settledPlanTaskActivationWinner(input),
    ...(input.onConversationPreamble ? { delivery: input.onConversationPreamble } : {}),
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
};
