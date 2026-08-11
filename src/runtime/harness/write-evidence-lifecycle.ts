/**
 * Cycle-free SQL helpers for the normalized write lifecycle.
 *
 * Provider lanes do not call these directly. The central physical-dispatch
 * and logical-settlement transactions do, so a process crash can never leave
 * a paid write crossing without its reservation or close a write settlement
 * without its exact terminal lifecycle row.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function reservationId(bindingId: string, physicalDispatchId: string, ordinal: number): string {
  return `write-reservation:v1:${sha256(`${bindingId}\0${physicalDispatchId}\0${ordinal}`)}`;
}

function outcomeId(reservation: string, kind: string, resultHandleId: string | null): string {
  return `write-outcome:v1:${sha256(`${reservation}\0${kind}\0${resultHandleId ?? ''}`)}`;
}

export interface ReserveWriteDispatchInput {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  physicalDispatchId: string;
  ordinal: number;
}

/** Insert before the physical crossing row in the SAME transaction. */
export function reserveWriteEvidenceDispatchInTransaction(
  db: Database.Database,
  input: ReserveWriteDispatchInput,
): void {
  const binding = db.prepare(`
    SELECT binding_id, accepted_task_id, target_digest, write_input_digest
      FROM write_evidence_bindings
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as {
    binding_id: string;
    accepted_task_id: string;
    target_digest: string;
    write_input_digest: string;
  } | undefined;
  if (!binding) return;
  if (binding.accepted_task_id !== input.acceptedTaskId) {
    throw new Error('write reservation accepted-task identity conflicts with its binding');
  }
  const id = reservationId(binding.binding_id, input.physicalDispatchId, input.ordinal);
  const existing = db.prepare(`
    SELECT reservation_id, binding_id, accepted_task_id, logical_tool_call_id,
           physical_dispatch_id, ordinal, target_digest, write_input_digest
      FROM write_evidence_dispatch_reservations
     WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
  `).get(input.sessionId, input.sourceUserSeq, input.physicalDispatchId) as Record<string, unknown> | undefined;
  if (existing) {
    const exact = existing.reservation_id === id
      && existing.binding_id === binding.binding_id
      && existing.accepted_task_id === input.acceptedTaskId
      && existing.logical_tool_call_id === input.logicalToolCallId
      && existing.ordinal === input.ordinal
      && existing.target_digest === binding.target_digest
      && existing.write_input_digest === binding.write_input_digest;
    if (!exact) throw new Error('physical dispatch already owns a conflicting write reservation');
    return;
  }
  db.prepare(`
    INSERT INTO write_evidence_dispatch_reservations
      (reservation_id, binding_id, session_id, source_user_seq,
       accepted_task_id, logical_tool_call_id, physical_dispatch_id, ordinal,
       target_digest, write_input_digest, reserved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    binding.binding_id,
    input.sessionId,
    input.sourceUserSeq,
    input.acceptedTaskId,
    input.logicalToolCallId,
    input.physicalDispatchId,
    input.ordinal,
    binding.target_digest,
    binding.write_input_digest,
    new Date().toISOString(),
  );
}

export interface RecordWriteSettlementOutcomeInput {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  settlementEventId: string;
  executionKind: 'refused_pre_dispatch' | 'local_execution' | 'provider_execution';
  outcomeKind: string;
  resultHandleId?: string;
}

/**
 * Close the normalized lifecycle beside the logical settlement. A successful
 * write can certify only the reservation owning the settlement's exact result
 * handle. Multiple paid crossings therefore remain deliberately ambiguous and
 * require reconciliation rather than being collapsed into a hopeful success.
 */
export function recordWriteEvidenceSettlementOutcomeInTransaction(
  db: Database.Database,
  input: RecordWriteSettlementOutcomeInput,
): void {
  const binding = db.prepare(`
    SELECT binding_id, accepted_task_id, target_digest, write_input_digest
      FROM write_evidence_bindings
     WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
  `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as {
    binding_id: string;
    accepted_task_id: string;
    target_digest: string;
    write_input_digest: string;
  } | undefined;
  if (!binding) return;
  if (binding.accepted_task_id !== input.acceptedTaskId) {
    throw new Error('write outcome accepted-task identity conflicts with its binding');
  }
  const reservations = db.prepare(`
    SELECT r.reservation_id, r.physical_dispatch_id, p.state
      FROM write_evidence_dispatch_reservations r
      JOIN physical_dispatches p
        ON p.session_id = r.session_id
       AND p.source_user_seq = r.source_user_seq
       AND p.logical_tool_call_id = r.logical_tool_call_id
       AND p.physical_dispatch_id = r.physical_dispatch_id
     WHERE r.binding_id = ?
     ORDER BY r.ordinal
  `).all(binding.binding_id) as Array<{
    reservation_id: string;
    physical_dispatch_id: string;
    state: string;
  }>;
  if (input.executionKind !== 'provider_execution') {
    if (reservations.length !== 0) {
      throw new Error('zero-crossing write settlement unexpectedly owns a dispatch reservation');
    }
    return;
  }
  if (reservations.length === 0) {
    throw new Error('settled bound write has no durable dispatch reservation');
  }
  const successful = input.outcomeKind === 'succeeded' || input.outcomeKind === 'empty_result';
  let selected: typeof reservations[number] | undefined;
  if (successful) {
    if (!input.resultHandleId) throw new Error('successful write settlement has no result handle');
    const result = db.prepare(`
      SELECT physical_dispatch_id FROM durable_result_handles WHERE handle_id = ?
    `).get(input.resultHandleId) as { physical_dispatch_id: string | null } | undefined;
    selected = reservations.find((row) => row.physical_dispatch_id === result?.physical_dispatch_id);
    if (!selected || selected.state !== 'returned') {
      throw new Error('successful write result does not belong to a returned reserved crossing');
    }
  } else {
    // A failed logical write with several physical crossings is still one
    // ambiguous lifecycle. Record every terminal reservation so the evaluator
    // sees the ambiguity rather than silently choosing one.
    selected = reservations.at(-1);
  }

  for (const reservation of successful ? [selected!] : reservations) {
    const kind = successful
      ? 'succeeded'
      : input.outcomeKind === 'uncertain_write' || reservation.state === 'unknown'
        ? 'orphaned'
        : 'failed';
    const resultHandleId = kind === 'succeeded' ? input.resultHandleId! : null;
    const id = outcomeId(reservation.reservation_id, kind, resultHandleId);
    const existing = db.prepare(`
      SELECT outcome_id, kind, result_handle_id, settlement_event_id
        FROM write_evidence_dispatch_outcomes WHERE reservation_id = ?
    `).get(reservation.reservation_id) as {
      outcome_id: string;
      kind: string;
      result_handle_id: string | null;
      settlement_event_id: string;
    } | undefined;
    if (existing) {
      if (
        existing.outcome_id !== id
        || existing.kind !== kind
        || existing.result_handle_id !== resultHandleId
        || existing.settlement_event_id !== input.settlementEventId
      ) throw new Error('write reservation already owns a conflicting terminal outcome');
      continue;
    }
    db.prepare(`
      INSERT INTO write_evidence_dispatch_outcomes
        (outcome_id, reservation_id, binding_id, session_id, source_user_seq,
         accepted_task_id, logical_tool_call_id, physical_dispatch_id, kind,
         result_handle_id, settlement_event_id, target_digest,
         write_input_digest, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      reservation.reservation_id,
      binding.binding_id,
      input.sessionId,
      input.sourceUserSeq,
      input.acceptedTaskId,
      input.logicalToolCallId,
      reservation.physical_dispatch_id,
      kind,
      resultHandleId,
      input.settlementEventId,
      binding.target_digest,
      binding.write_input_digest,
      new Date().toISOString(),
    );
  }
}
