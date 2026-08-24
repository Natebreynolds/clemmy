/**
 * Cycle-free durable proof for the one host_v1/post-plan graph coexistence.
 *
 * host_v1 remains the sole call/lease/settlement root. A resolution admitted
 * by this predicate is only the topology/evidence ledger for the exact graph
 * selected by the settled foreground plan control; it never creates or
 * replaces an accepted-turn call authority.
 */
import type Database from 'better-sqlite3';

export const PLAN_TASK_ACTIVATION_RECEIPTS_TABLE = 'plan_task_activation_receipts' as const;

export type HostPlannedResolutionProofPhase = 'insert' | 'existing';

/** One SQL predicate is embedded by the schema trigger and queried by every
 * runtime verifier. `resolutionRef` is an internal SQL alias (`NEW` or `r`),
 * never caller/user input. */
export function hostPlannedResolutionProofSql(
  resolutionRef: 'NEW' | 'r',
  phase: HostPlannedResolutionProofPhase,
): string {
  const rootPhase = phase === 'insert'
    ? "root.state = 'open'"
    : "root.state IN ('open','closed','conflict')";
  const taskPhase = phase === 'insert'
    ? "task.state != 'conflict'"
    : "task.state IN ('armed','manifested_verifying','terminal','conflict')";
  return `EXISTS (
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
       AND contract.graph_event_id = task.graph_event_id
       AND contract.graph_id = task.graph_id
       AND contract.graph_hash = task.graph_hash
      JOIN ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE} receipt
        ON receipt.session_id = task.session_id
       AND receipt.source_user_seq = task.source_user_seq
       AND receipt.accepted_task_id = task.accepted_task_id
       AND receipt.graph_event_id = task.graph_event_id
       AND receipt.graph_id = task.graph_id
       AND receipt.graph_hash = task.graph_hash
       AND receipt.contract_id = contract.contract_id
      JOIN events source
        ON source.session_id = root.session_id
       AND source.seq = root.source_user_seq
       AND source.id = root.source_event_id
      JOIN events graph
        ON graph.session_id = root.session_id
       AND graph.id = task.graph_event_id
      JOIN events preamble
        ON preamble.session_id = root.session_id
       AND preamble.id = receipt.preamble_event_id
      JOIN events delivery
        ON delivery.session_id = root.session_id
       AND delivery.id = receipt.delivery_event_id
      JOIN logical_tool_calls call
        ON call.session_id = root.session_id
       AND call.source_user_seq = root.source_user_seq
       AND call.accepted_task_id = root.accepted_task_id
       AND call.logical_tool_call_id = receipt.logical_tool_call_id
       AND call.argument_digest = receipt.plan_argument_digest
      JOIN logical_call_settlements settlement
        ON settlement.session_id = call.session_id
       AND settlement.source_user_seq = call.source_user_seq
       AND settlement.logical_tool_call_id = call.logical_tool_call_id
      JOIN durable_result_handles result
        ON result.handle_id = settlement.result_handle_id
       AND result.session_id = call.session_id
       AND result.source_user_seq = call.source_user_seq
       AND result.accepted_task_id = call.accepted_task_id
       AND result.logical_tool_call_id = call.logical_tool_call_id
       AND result.tool_name = call.tool_name
       AND result.argument_digest = call.argument_digest
      JOIN physical_dispatches physical
        ON physical.session_id = result.session_id
       AND physical.source_user_seq = result.source_user_seq
       AND physical.logical_tool_call_id = result.logical_tool_call_id
       AND physical.physical_dispatch_id = result.physical_dispatch_id
      JOIN logical_call_settlement_crossings crossing
        ON crossing.session_id = result.session_id
       AND crossing.source_user_seq = result.source_user_seq
       AND crossing.logical_tool_call_id = result.logical_tool_call_id
       AND crossing.physical_dispatch_id = result.physical_dispatch_id
     WHERE root.session_id = ${resolutionRef}.session_id
       AND root.source_user_seq = ${resolutionRef}.source_user_seq
       AND root.accepted_task_id = ${resolutionRef}.accepted_task_id
       AND root.authority_protocol = 1
       AND root.authority_kind = 'host_v1'
       AND root.engine_version = 'host_v1'
       AND root.surface_version = 'configured_harness_capability_surface_v1'
       AND root.effect_ceiling = 'admin'
       AND root.effect_bounds_json = '["admin","compute","external_write","host_only","local_write","read"]'
       AND root.graph_event_id IS NULL
       AND root.graph_hash IS NULL
       AND ${rootPhase}
       AND task.authority_protocol = 1
       AND task.expected_work_required = 1
       AND ${taskPhase}
       AND task.graph_event_id = ${resolutionRef}.graph_event_id
       AND task.graph_id = ${resolutionRef}.graph_id
       AND task.graph_hash = ${resolutionRef}.graph_hash
       AND contract.contract_version = 1
       AND contract.planner_source = 'structured_model'
       AND contract.graph_event_id = ${resolutionRef}.graph_event_id
       AND contract.graph_id = ${resolutionRef}.graph_id
       AND contract.graph_hash = ${resolutionRef}.graph_hash
       AND source.role = 'user'
       AND source.type = 'user_input_received'
       AND source.turn = root.source_turn
       AND graph.role = 'system'
       AND graph.type = 'turn_graph_compiled'
       AND graph.parent_event_id = source.id
       AND graph.turn = source.turn
       AND json_extract(graph.data_json, '$.sourceUserSeq') = root.source_user_seq
       AND json_extract(graph.data_json, '$.graphId') = ${resolutionRef}.graph_id
       AND json_extract(graph.data_json, '$.graphHash') = ${resolutionRef}.graph_hash
       AND json_extract(graph.data_json, '$.compilerVersion') = ${resolutionRef}.compiler_version
       AND json_extract(graph.data_json, '$.route') = 'act'
       AND json_extract(graph.data_json, '$.effectCeiling') = ${resolutionRef}.effect_ceiling
       AND json_extract(graph.data_json, '$.graph.classification.route') = 'act'
       AND json_extract(graph.data_json, '$.graph.graphId') = ${resolutionRef}.graph_id
       AND json_extract(graph.data_json, '$.graph.compiler.graphHash') = ${resolutionRef}.graph_hash
       AND ${resolutionRef}.route = 'act'
       AND ${resolutionRef}.state IN ('open','finalized')
       AND receipt.receipt_version = 1
       AND receipt.accepted_task_id = ${resolutionRef}.accepted_task_id
       AND receipt.delivery_status IN ('delivered','not_applicable')
       AND ((receipt.delivery_status = 'delivered'
             AND receipt.delivery_reason IS NULL)
         OR (receipt.delivery_status = 'not_applicable'
             AND receipt.delivery_reason IN ('quiet_presentation','non_user_surface')))
       AND preamble.role = 'Clem'
       AND preamble.type = 'conversation_preamble'
       AND preamble.parent_event_id = source.id
       AND preamble.turn = source.turn
       AND json_extract(preamble.data_json, '$.version') = 1
       AND json_extract(preamble.data_json, '$.kind') = 'pre_execution'
       AND json_extract(preamble.data_json, '$.sourceUserSeq') = root.source_user_seq
       AND json_type(preamble.data_json, '$.text') = 'text'
       AND length(trim(json_extract(preamble.data_json, '$.text'))) > 0
       AND delivery.role = 'system'
       AND delivery.type = 'conversation_preamble_delivered'
       AND delivery.parent_event_id = preamble.id
       AND delivery.turn = preamble.turn
       AND json_extract(delivery.data_json, '$.version') = 1
       AND json_extract(delivery.data_json, '$.sourceUserSeq') = root.source_user_seq
       AND json_extract(delivery.data_json, '$.acceptedTaskId') = root.accepted_task_id
       AND json_extract(delivery.data_json, '$.logicalToolCallId') = call.logical_tool_call_id
       AND json_extract(delivery.data_json, '$.planArgumentDigest') = call.argument_digest
       AND json_extract(delivery.data_json, '$.preambleEventId') = preamble.id
       AND json_extract(delivery.data_json, '$.preambleEventDigest') = receipt.preamble_event_digest
       AND json_extract(delivery.data_json, '$.deliveryKey') = receipt.delivery_key
       AND json_extract(delivery.data_json, '$.deliveryStatus') = receipt.delivery_status
       AND json_extract(delivery.data_json, '$.deliveryReason') IS receipt.delivery_reason
       AND json_extract(delivery.data_json, '$.transportReceiptDigest') = receipt.transport_receipt_digest
       AND json_extract(delivery.data_json, '$.transportReceipt.version') = 1
       AND json_extract(delivery.data_json, '$.transportReceipt.deliveryKey') = receipt.delivery_key
       AND json_extract(delivery.data_json, '$.transportReceipt.eventId') = preamble.id
       AND json_extract(delivery.data_json, '$.transportReceipt.eventDigest') = receipt.preamble_event_digest
       AND json_extract(delivery.data_json, '$.transportReceipt.surface') =
           CASE receipt.delivery_status WHEN 'delivered' THEN 'channel_message' ELSE 'not_applicable' END
       AND json_extract(delivery.data_json, '$.transportReceipt.target') = receipt.transport_target
       AND json_type(delivery.data_json, '$.transportReceipt') = 'object'
       AND (SELECT COUNT(*) FROM json_each(delivery.data_json, '$.transportReceipt')) = 6
       AND NOT EXISTS (
             SELECT 1 FROM json_each(delivery.data_json, '$.transportReceipt') transport_field
              WHERE transport_field.key NOT IN ('version','deliveryKey','eventId','eventDigest','surface','target')
           )
       AND call.tool_name = 'plan_task'
       AND call.state = 'settled'
       AND call.outcome_kind = 'succeeded'
       AND call.settlement_event_id = settlement.settlement_event_id
       AND settlement.protocol_version = 1
       AND settlement.execution_kind = 'local_execution'
       AND settlement.outcome_kind = 'succeeded'
       AND settlement.business_call = 0
       AND settlement.mutating = 0
       AND settlement.requirement_id IS NULL
       AND settlement.physical_crossing_count = 0
       AND settlement.host_crossing_count = 1
       AND settlement.crossing_authority_version = 2
       AND result.scope_kind = 'authoritative'
       AND result.success = 1
       AND result.rejection_reason IS NULL
       AND result.raw_payload_json IS NOT NULL
       AND result.raw_payload_sha256 IS NOT NULL
       AND json_valid(result.raw_payload_json)
       AND json_type(result.raw_payload_json, '$') = 'text'
       AND json_valid(json_extract(result.raw_payload_json, '$'))
       AND json_extract(json_extract(result.raw_payload_json, '$'), '$.ok') = 1
       AND json_extract(json_extract(result.raw_payload_json, '$'), '$.acceptedTaskId') = root.accepted_task_id
       AND json_extract(json_extract(result.raw_payload_json, '$'), '$.graphId') = task.graph_id
       AND json_extract(json_extract(result.raw_payload_json, '$'), '$.graphHash') = task.graph_hash
       AND json_extract(json_extract(result.raw_payload_json, '$'), '$.contractId') = contract.contract_id
       AND physical.accepted_task_id = root.accepted_task_id
       AND physical.tool_name = 'plan_task'
       AND physical.argument_digest = call.argument_digest
       AND physical.state = 'returned'
       AND physical.execution_site = 'host'
       AND crossing.ordinal = physical.ordinal
       AND crossing.tool_name = physical.tool_name
       AND crossing.argument_digest = physical.argument_digest
       AND crossing.terminal_state = 'returned'
       AND crossing.execution_site = 'host'
       AND (SELECT COUNT(*)
              FROM ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE} receipt_count
             WHERE receipt_count.session_id = root.session_id
               AND receipt_count.source_user_seq = root.source_user_seq) = 1
       AND (SELECT COUNT(*)
              FROM logical_call_settlement_crossings crossing_count
             WHERE crossing_count.session_id = call.session_id
               AND crossing_count.source_user_seq = call.source_user_seq
               AND crossing_count.logical_tool_call_id = call.logical_tool_call_id) = 1
  )`;
}

export const PLAN_TASK_ACTIVATION_RECEIPT_INSERT_TRIGGER =
  'trg_plan_task_activation_receipt_exact_insert' as const;

/** A delivery receipt is normally recorded while plan_task is still open. A
 * restart may instead find the exact local control already settled. That
 * exceptional branch redeems the one immutable host crossing/result and the
 * complete ok:true plan identity; a merely successful-looking call row or an
 * earlier ok:false repair cannot qualify. */
function planTaskReceiptCallStateProofSql(): string {
  return `(call.state = 'open' OR (
    call.state = 'settled'
    AND call.outcome_kind = 'succeeded'
    AND EXISTS (
      SELECT 1
        FROM logical_call_settlements settlement
        JOIN durable_result_handles result
          ON result.handle_id = settlement.result_handle_id
         AND result.session_id = call.session_id
         AND result.source_user_seq = call.source_user_seq
         AND result.accepted_task_id = call.accepted_task_id
         AND result.logical_tool_call_id = call.logical_tool_call_id
         AND result.tool_name = call.tool_name
         AND result.argument_digest = call.argument_digest
        JOIN physical_dispatches physical
          ON physical.session_id = result.session_id
         AND physical.source_user_seq = result.source_user_seq
         AND physical.logical_tool_call_id = result.logical_tool_call_id
         AND physical.physical_dispatch_id = result.physical_dispatch_id
        JOIN logical_call_settlement_crossings crossing
          ON crossing.session_id = result.session_id
         AND crossing.source_user_seq = result.source_user_seq
         AND crossing.logical_tool_call_id = result.logical_tool_call_id
         AND crossing.physical_dispatch_id = result.physical_dispatch_id
       WHERE settlement.session_id = call.session_id
         AND settlement.source_user_seq = call.source_user_seq
         AND settlement.logical_tool_call_id = call.logical_tool_call_id
         AND call.settlement_event_id = settlement.settlement_event_id
         AND settlement.protocol_version = 1
         AND settlement.execution_kind = 'local_execution'
         AND settlement.outcome_kind = 'succeeded'
         AND settlement.business_call = 0
         AND settlement.mutating = 0
         AND settlement.requirement_id IS NULL
         AND settlement.physical_crossing_count = 0
         AND settlement.host_crossing_count = 1
         AND settlement.crossing_authority_version = 2
         AND result.scope_kind = 'authoritative'
         AND result.success = 1
         AND result.rejection_reason IS NULL
         AND result.raw_payload_json IS NOT NULL
         AND result.raw_payload_sha256 IS NOT NULL
         AND json_valid(result.raw_payload_json)
         AND json_type(result.raw_payload_json, '$') = 'text'
         AND json_valid(json_extract(result.raw_payload_json, '$'))
         AND json_type(json_extract(result.raw_payload_json, '$'), '$') = 'object'
         AND json_extract(json_extract(result.raw_payload_json, '$'), '$.ok') = 1
         AND json_extract(json_extract(result.raw_payload_json, '$'), '$.acceptedTaskId') = root.accepted_task_id
         AND json_extract(json_extract(result.raw_payload_json, '$'), '$.graphId') = task.graph_id
         AND json_extract(json_extract(result.raw_payload_json, '$'), '$.graphHash') = task.graph_hash
         AND json_extract(json_extract(result.raw_payload_json, '$'), '$.contractId') = contract.contract_id
         AND physical.accepted_task_id = root.accepted_task_id
         AND physical.tool_name = 'plan_task'
         AND physical.argument_digest = call.argument_digest
         AND physical.state = 'returned'
         AND physical.execution_site = 'host'
         AND crossing.ordinal = physical.ordinal
         AND crossing.tool_name = physical.tool_name
         AND crossing.argument_digest = physical.argument_digest
         AND crossing.terminal_state = 'returned'
         AND crossing.execution_site = 'host'
         AND (SELECT COUNT(*)
                FROM logical_call_settlements settlement_count
               WHERE settlement_count.session_id = call.session_id
                 AND settlement_count.source_user_seq = call.source_user_seq
                 AND settlement_count.logical_tool_call_id = call.logical_tool_call_id) = 1
         AND (SELECT COUNT(*)
                FROM logical_call_settlement_crossings crossing_count
               WHERE crossing_count.session_id = call.session_id
                 AND crossing_count.source_user_seq = call.source_user_seq
                 AND crossing_count.logical_tool_call_id = call.logical_tool_call_id) = 1
         AND (SELECT COUNT(*)
                FROM physical_dispatches physical_count
               WHERE physical_count.session_id = call.session_id
                 AND physical_count.source_user_seq = call.source_user_seq
                 AND physical_count.logical_tool_call_id = call.logical_tool_call_id) = 1
         AND (SELECT COUNT(*)
                FROM durable_result_handles result_count
               WHERE result_count.scope_kind = 'authoritative'
                 AND result_count.session_id = call.session_id
                 AND result_count.source_user_seq = call.source_user_seq
                 AND result_count.logical_tool_call_id = call.logical_tool_call_id) = 1
    )
  ))`;
}

function planTaskActivationReceiptInsertTriggerSql(ifNotExists: boolean): string {
  return `CREATE TRIGGER ${ifNotExists ? 'IF NOT EXISTS ' : ''}${PLAN_TASK_ACTIVATION_RECEIPT_INSERT_TRIGGER}
    BEFORE INSERT ON ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE}
    WHEN NOT EXISTS (
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
        JOIN logical_tool_calls call
          ON call.session_id = root.session_id
         AND call.source_user_seq = root.source_user_seq
         AND call.accepted_task_id = root.accepted_task_id
         AND call.logical_tool_call_id = NEW.logical_tool_call_id
        JOIN events source
          ON source.session_id = root.session_id
         AND source.seq = root.source_user_seq
         AND source.id = root.source_event_id
        JOIN events graph
          ON graph.session_id = root.session_id
         AND graph.id = task.graph_event_id
        JOIN events preamble
          ON preamble.session_id = root.session_id
         AND preamble.id = NEW.preamble_event_id
        JOIN events delivery
          ON delivery.session_id = root.session_id
         AND delivery.id = NEW.delivery_event_id
       WHERE root.session_id = NEW.session_id
         AND root.source_user_seq = NEW.source_user_seq
         AND root.accepted_task_id = NEW.accepted_task_id
         AND root.authority_kind = 'host_v1'
         AND root.engine_version = 'host_v1'
         AND root.state = 'open'
         AND root.graph_event_id IS NULL
         AND root.graph_hash IS NULL
         AND task.authority_protocol = 1
         AND task.state != 'conflict'
         AND task.expected_work_required = 0
         AND task.graph_event_id = NEW.graph_event_id
         AND task.graph_id = NEW.graph_id
         AND task.graph_hash = NEW.graph_hash
         AND task.work_contract_id = NEW.contract_id
         AND contract.contract_version = 1
         AND contract.planner_source = 'structured_model'
         AND contract.graph_event_id = NEW.graph_event_id
         AND contract.graph_id = NEW.graph_id
         AND contract.graph_hash = NEW.graph_hash
         AND call.tool_name = 'plan_task'
         AND call.argument_digest = NEW.plan_argument_digest
         AND ${planTaskReceiptCallStateProofSql()}
         AND source.role = 'user'
         AND source.type = 'user_input_received'
         AND source.turn = root.source_turn
         AND graph.role = 'system'
         AND graph.type = 'turn_graph_compiled'
         AND graph.parent_event_id = source.id
         AND graph.turn = source.turn
         AND json_extract(graph.data_json, '$.route') = 'act'
         AND json_extract(graph.data_json, '$.sourceUserSeq') = root.source_user_seq
         AND json_extract(graph.data_json, '$.graphId') = NEW.graph_id
         AND json_extract(graph.data_json, '$.graphHash') = NEW.graph_hash
         AND preamble.role = 'Clem'
         AND preamble.type = 'conversation_preamble'
         AND preamble.parent_event_id = source.id
         AND preamble.turn = source.turn
         AND json_extract(preamble.data_json, '$.version') = 1
         AND json_extract(preamble.data_json, '$.kind') = 'pre_execution'
         AND json_extract(preamble.data_json, '$.sourceUserSeq') = root.source_user_seq
         AND json_type(preamble.data_json, '$.text') = 'text'
         AND delivery.role = 'system'
         AND delivery.type = 'conversation_preamble_delivered'
         AND delivery.parent_event_id = preamble.id
         AND delivery.turn = preamble.turn
         AND json_extract(delivery.data_json, '$.version') = 1
         AND json_extract(delivery.data_json, '$.sourceUserSeq') = root.source_user_seq
         AND json_extract(delivery.data_json, '$.acceptedTaskId') = root.accepted_task_id
         AND json_extract(delivery.data_json, '$.logicalToolCallId') = call.logical_tool_call_id
         AND json_extract(delivery.data_json, '$.planArgumentDigest') = call.argument_digest
         AND json_extract(delivery.data_json, '$.preambleEventId') = preamble.id
         AND json_extract(delivery.data_json, '$.preambleEventDigest') = NEW.preamble_event_digest
         AND json_extract(delivery.data_json, '$.deliveryKey') = NEW.delivery_key
         AND json_extract(delivery.data_json, '$.deliveryStatus') = NEW.delivery_status
         AND json_extract(delivery.data_json, '$.deliveryReason') IS NEW.delivery_reason
         AND json_extract(delivery.data_json, '$.transportReceiptDigest') = NEW.transport_receipt_digest
         AND json_extract(delivery.data_json, '$.transportReceipt.version') = 1
         AND json_extract(delivery.data_json, '$.transportReceipt.deliveryKey') = NEW.delivery_key
         AND json_extract(delivery.data_json, '$.transportReceipt.eventId') = preamble.id
         AND json_extract(delivery.data_json, '$.transportReceipt.eventDigest') = NEW.preamble_event_digest
         AND json_extract(delivery.data_json, '$.transportReceipt.surface') =
             CASE NEW.delivery_status WHEN 'delivered' THEN 'channel_message' ELSE 'not_applicable' END
         AND json_extract(delivery.data_json, '$.transportReceipt.target') = NEW.transport_target
         AND json_type(delivery.data_json, '$.transportReceipt') = 'object'
         AND (SELECT COUNT(*) FROM json_each(delivery.data_json, '$.transportReceipt')) = 6
         AND NOT EXISTS (
               SELECT 1 FROM json_each(delivery.data_json, '$.transportReceipt') transport_field
                WHERE transport_field.key NOT IN ('version','deliveryKey','eventId','eventDigest','surface','target')
             )
         AND json_type(NEW.transport_receipt_json, '$') = 'object'
         AND (SELECT COUNT(*) FROM json_each(NEW.transport_receipt_json)) = 6
         AND NOT EXISTS (
               SELECT 1 FROM json_each(NEW.transport_receipt_json) transport_field
                WHERE transport_field.key NOT IN ('version','deliveryKey','eventId','eventDigest','surface','target')
             )
         AND json_extract(NEW.transport_receipt_json, '$.version') = 1
         AND json_extract(NEW.transport_receipt_json, '$.deliveryKey') = NEW.delivery_key
         AND json_extract(NEW.transport_receipt_json, '$.eventId') = preamble.id
         AND json_extract(NEW.transport_receipt_json, '$.eventDigest') = NEW.preamble_event_digest
         AND json_extract(NEW.transport_receipt_json, '$.surface') =
             CASE NEW.delivery_status WHEN 'delivered' THEN 'channel_message' ELSE 'not_applicable' END
         AND json_extract(NEW.transport_receipt_json, '$.target') = NEW.transport_target
    )
    BEGIN
      SELECT RAISE(ABORT, 'plan_task receipt requires exact host, graph, contract, call, preamble, and delivery authority');
    END;`;
}

/** Refresh an already-installed v56 wall without weakening any row. v57 calls
 * this in its migration transaction so existing homes get the settled-plan
 * recovery branch; fresh schema creation uses the same single SQL author. */
export function refreshPlanTaskActivationReceiptInsertTrigger(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS ${PLAN_TASK_ACTIVATION_RECEIPT_INSERT_TRIGGER};
    ${planTaskActivationReceiptInsertTriggerSql(false)}
  `);
}

/** Create the normalized immutable receipt and its insertion-time integrity
 * wall. The preamble delivery event remains the public/audit mirror; this row
 * is the compact relational evidence consumed by later DB-only predicates. */
export function createHostPlannedResolutionCoexistenceSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE} (
      session_id               TEXT NOT NULL,
      source_user_seq          INTEGER NOT NULL CHECK (source_user_seq > 0),
      accepted_task_id         TEXT NOT NULL,
      logical_tool_call_id     TEXT NOT NULL,
      receipt_version          INTEGER NOT NULL CHECK (receipt_version = 1),
      plan_argument_digest     TEXT NOT NULL CHECK (length(plan_argument_digest) = 64),
      graph_event_id           TEXT NOT NULL,
      graph_id                 TEXT NOT NULL,
      graph_hash               TEXT NOT NULL CHECK (length(graph_hash) = 64),
      contract_id              TEXT NOT NULL,
      preamble_event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
      preamble_event_digest    TEXT NOT NULL CHECK (length(preamble_event_digest) = 64),
      delivery_key             TEXT NOT NULL UNIQUE,
      delivery_event_id        TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
      delivery_status          TEXT NOT NULL CHECK (delivery_status IN ('delivered','not_applicable')),
      delivery_reason          TEXT CHECK (delivery_reason IN ('quiet_presentation','non_user_surface')),
      transport_receipt_json   TEXT NOT NULL CHECK (json_valid(transport_receipt_json)),
      transport_receipt_digest TEXT NOT NULL CHECK (length(transport_receipt_digest) = 64),
      transport_target         TEXT NOT NULL CHECK (length(transport_target) BETWEEN 1 AND 512),
      recorded_at              TEXT NOT NULL,
      PRIMARY KEY (session_id, source_user_seq),
      UNIQUE (session_id, source_user_seq, logical_tool_call_id),
      FOREIGN KEY (session_id, source_user_seq, logical_tool_call_id)
        REFERENCES logical_tool_calls(session_id, source_user_seq, logical_tool_call_id)
        ON DELETE CASCADE,
      FOREIGN KEY (session_id, source_user_seq)
        REFERENCES accepted_task_work_contracts(session_id, source_user_seq)
        ON DELETE CASCADE,
      FOREIGN KEY (contract_id)
        REFERENCES accepted_task_work_contracts(contract_id)
        ON DELETE RESTRICT,
      CHECK ((delivery_status = 'delivered' AND delivery_reason IS NULL)
          OR (delivery_status = 'not_applicable' AND delivery_reason IS NOT NULL))
    );

    CREATE TRIGGER IF NOT EXISTS trg_plan_task_activation_receipt_update_immutable
    BEFORE UPDATE ON ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE}
    BEGIN
      SELECT RAISE(ABORT, 'plan_task activation receipts are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_plan_task_activation_receipt_delete_immutable
    BEFORE DELETE ON ${PLAN_TASK_ACTIVATION_RECEIPTS_TABLE}
    WHEN EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
    BEGIN
      SELECT RAISE(ABORT, 'plan_task activation receipts are immutable');
    END;
  `);
  refreshPlanTaskActivationReceiptInsertTrigger(db);
}

export function proveHostPlannedResolutionCoexistenceInTransaction(input: {
  db: Database.Database;
  sessionId: string;
  sourceUserSeq: number;
  phase: HostPlannedResolutionProofPhase;
}): boolean {
  const row = input.db.prepare(`
    SELECT 1
      FROM accepted_task_resolutions r
     WHERE r.session_id = ? AND r.source_user_seq = ?
       AND ${hostPlannedResolutionProofSql('r', input.phase)}
     LIMIT 1
  `).get(input.sessionId, input.sourceUserSeq);
  return Boolean(row);
}
