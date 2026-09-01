import type { AgentInputItem } from '@openai/agents';

import { ASYNC_READ_REFINEMENT_RECOVERY_CURSOR_TABLE } from './async-read-refinement-schema.js';
import { HostRecoveryState } from './host-turn-runner.js';
import { openEventLog } from './eventlog.js';

interface PendingAsyncReadRecoveryRow {
  intent_recorded_at: string;
  session_id: string;
  source_user_seq: number;
  accepted_task_id: string;
  start_logical_tool_call_id: string;
  batch_ordinal: number;
  batch_id: string;
  authority_digest: string;
  previous_response_id: string | null;
  provider_response_id: string | null;
  pre_history_json: string;
  frame_history_json: string;
}

interface AsyncReadRecoveryCursor {
  recordedAt: string;
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
}

export interface AsyncReadRefinementRecoveryClaim {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  ownerLogicalToolCallId: string;
}

export interface AsyncReadRefinementRecoverySweep {
  scanned: number;
  claimed: number;
  replayed: number;
  held: number;
  claims: AsyncReadRefinementRecoveryClaim[];
}

function pendingRows(
  db: ReturnType<typeof openEventLog>,
  input: { limit: number; after: AsyncReadRecoveryCursor | null },
): PendingAsyncReadRecoveryRow[] {
  const afterWhere = input.after
    ? `AND (
         intent.recorded_at > ?
         OR (intent.recorded_at = ? AND intent.session_id > ?)
         OR (intent.recorded_at = ? AND intent.session_id = ? AND intent.source_user_seq > ?)
         OR (intent.recorded_at = ? AND intent.session_id = ? AND intent.source_user_seq = ?
             AND intent.start_logical_tool_call_id > ?)
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
        input.after.recordedAt,
        input.after.sessionId,
        input.after.sourceUserSeq,
        input.after.logicalToolCallId,
        input.limit,
      ]
    : [input.limit];
  return db.prepare(`
      SELECT intent.recorded_at AS intent_recorded_at,
             intent.session_id, intent.source_user_seq, intent.accepted_task_id,
             intent.start_logical_tool_call_id,
             batch.batch_ordinal, batch.batch_id, batch.authority_digest,
             batch.previous_response_id, batch.provider_response_id,
             batch.pre_history_json, batch.frame_history_json
        FROM async_read_refinement_intents intent
        JOIN logical_tool_calls call
          ON call.session_id = intent.session_id
         AND call.source_user_seq = intent.source_user_seq
         AND call.logical_tool_call_id = intent.start_logical_tool_call_id
         AND call.accepted_task_id = intent.accepted_task_id
        JOIN expected_work_call_bindings binding
          ON binding.session_id = intent.session_id
         AND binding.source_user_seq = intent.source_user_seq
         AND binding.logical_tool_call_id = intent.start_logical_tool_call_id
         AND binding.accepted_task_id = intent.accepted_task_id
         AND binding.requirement_id = intent.requirement_id
         AND binding.argument_digest = intent.start_argument_digest
        JOIN accepted_turn_call_authorities authority
          ON authority.session_id = intent.session_id
         AND authority.source_user_seq = intent.source_user_seq
         AND authority.accepted_task_id = intent.accepted_task_id
         AND authority.authority_kind = 'host_v1'
         AND authority.state = 'open'
        JOIN accepted_model_batch_admissions batch
          ON batch.session_id = intent.session_id
         AND batch.source_user_seq = intent.source_user_seq
         AND batch.accepted_task_id = intent.accepted_task_id
         AND batch.work_contract_id = binding.contract_id
         AND batch.authority_digest = authority.authority_digest
         AND batch.call_count = 1
         AND json_extract(batch.call_ids_json, '$[0]') = intent.start_logical_tool_call_id
        JOIN sessions session ON session.id = intent.session_id
       WHERE call.state = 'open'
         AND NOT EXISTS (
           SELECT 1 FROM accepted_model_batch_checkpoints checkpoint
            WHERE checkpoint.session_id = batch.session_id
              AND checkpoint.source_user_seq = batch.source_user_seq
              AND checkpoint.batch_ordinal = batch.batch_ordinal
         )
         AND EXISTS (
           SELECT 1 FROM run_dispatch_leases lease
            WHERE lease.session_id = intent.session_id
              AND lease.source_user_seq = intent.source_user_seq
              AND lease.accepted_task_id = intent.accepted_task_id
              AND lease.logical_tool_call_id = intent.start_logical_tool_call_id
              AND lease.revoked_at IS NOT NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM run_dispatch_leases lease
            WHERE lease.session_id = intent.session_id
              AND lease.source_user_seq = intent.source_user_seq
              AND lease.accepted_task_id = intent.accepted_task_id
              AND lease.logical_tool_call_id = intent.start_logical_tool_call_id
              AND lease.revoked_at IS NULL
         )
         AND json_type(session.metadata_json, '$.__host_recovery_state') IS NULL
         ${afterWhere}
       ORDER BY intent.recorded_at, intent.session_id, intent.source_user_seq,
                intent.start_logical_tool_call_id
       LIMIT ?
    `).all(...args) as PendingAsyncReadRecoveryRow[];
}

/** Reserve a bounded durable page before touching any row. A dead process can
 * lose at most its claimed page; the next process advances, then wraps at the
 * tail, so held/corrupt prefixes cannot starve later exact owners forever. */
function claimRows(
  db: ReturnType<typeof openEventLog>,
  limit: number,
): PendingAsyncReadRecoveryRow[] {
  return db.transaction(() => {
    const cursor = db.prepare(`
      SELECT cursor_recorded_at AS recordedAt,
             cursor_session_id AS sessionId,
             cursor_source_user_seq AS sourceUserSeq,
             cursor_logical_tool_call_id AS logicalToolCallId
        FROM ${ASYNC_READ_REFINEMENT_RECOVERY_CURSOR_TABLE}
       WHERE cursor_key = 1
    `).get() as AsyncReadRecoveryCursor | undefined;
    let rows = pendingRows(db, { limit, after: cursor ?? null });
    if (rows.length === 0 && cursor) rows = pendingRows(db, { limit, after: null });
    if (rows.length === 0) {
      db.prepare(`DELETE FROM ${ASYNC_READ_REFINEMENT_RECOVERY_CURSOR_TABLE} WHERE cursor_key = 1`).run();
      return [];
    }
    const last = rows[rows.length - 1]!;
    db.prepare(`
      INSERT INTO ${ASYNC_READ_REFINEMENT_RECOVERY_CURSOR_TABLE}
        (cursor_key, cursor_recorded_at, cursor_session_id,
         cursor_source_user_seq, cursor_logical_tool_call_id, updated_at)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(cursor_key) DO UPDATE SET
        cursor_recorded_at = excluded.cursor_recorded_at,
        cursor_session_id = excluded.cursor_session_id,
        cursor_source_user_seq = excluded.cursor_source_user_seq,
        cursor_logical_tool_call_id = excluded.cursor_logical_tool_call_id,
        updated_at = excluded.updated_at
    `).run(
      last.intent_recorded_at,
      last.session_id,
      last.source_user_seq,
      last.start_logical_tool_call_id,
      new Date().toISOString(),
    );
    return rows;
  })();
}

function parsedHistory(value: string): AgentInputItem[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as AgentInputItem[] : null;
  } catch {
    return null;
  }
}

/**
 * Claim crash-orphaned async R owners before generic revoked-call recovery.
 *
 * This performs no provider/model/business work. It reconstructs only the
 * already-accepted sole-call model frame and atomically installs the same
 * private HostRecoveryState the live runner would have saved after receiving
 * HostDurableContinuationPendingError. A later ordinary chat-resume owner then
 * reopens that exact frame and runs only the next missing deterministic child.
 */
export function claimPendingAsyncReadRefinementRecoveries(
  options: { limit?: number } = {},
): AsyncReadRefinementRecoverySweep {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 8)));
  const db = openEventLog();
  const rows = claimRows(db, limit);

  const claims: AsyncReadRefinementRecoveryClaim[] = [];
  let replayed = 0;
  let held = 0;
  for (const row of rows) {
    const history = parsedHistory(row.pre_history_json);
    const frameHistory = parsedHistory(row.frame_history_json);
    if (!history || !frameHistory) {
      held += 1;
      continue;
    }
    let blob: string;
    try {
      blob = new HostRecoveryState(
        row.session_id,
        row.source_user_seq,
        'admit',
        history,
        frameHistory,
        [],
        row.previous_response_id ?? undefined,
        row.provider_response_id ?? undefined,
        'host_v1',
        undefined,
        row.batch_ordinal,
      ).toString();
      // The parser is the same exact structural boundary used on ordinary
      // restart; an unreadable synthesized frame never reaches session state.
      HostRecoveryState.fromString(blob);
    } catch {
      held += 1;
      continue;
    }
    const updated = db.prepare(`
        UPDATE sessions
           SET metadata_json = json_set(metadata_json, '$.__host_recovery_state', ?),
               updated_at = ?
         WHERE id = ?
           AND json_type(metadata_json, '$.__host_recovery_state') IS NULL
           AND EXISTS (
             SELECT 1 FROM logical_tool_calls call
              WHERE call.session_id = ? AND call.source_user_seq = ?
                AND call.logical_tool_call_id = ?
                AND call.accepted_task_id = ? AND call.state = 'open'
           )
           AND EXISTS (
             SELECT 1 FROM expected_work_call_bindings binding
              WHERE binding.session_id = ? AND binding.source_user_seq = ?
                AND binding.logical_tool_call_id = ?
                AND binding.accepted_task_id = ?
                AND EXISTS (
                  SELECT 1 FROM async_read_refinement_intents intent
                   WHERE intent.session_id = binding.session_id
                     AND intent.source_user_seq = binding.source_user_seq
                     AND intent.start_logical_tool_call_id = binding.logical_tool_call_id
                     AND intent.requirement_id = binding.requirement_id
                     AND intent.start_argument_digest = binding.argument_digest
                )
           )
           AND EXISTS (
             SELECT 1 FROM accepted_turn_call_authorities authority
              WHERE authority.session_id = ? AND authority.source_user_seq = ?
                AND authority.accepted_task_id = ?
                AND authority.authority_kind = 'host_v1'
                AND authority.state = 'open'
                AND authority.authority_digest = ?
           )
           AND EXISTS (
             SELECT 1 FROM accepted_model_batch_admissions batch
              WHERE batch.session_id = ? AND batch.source_user_seq = ?
                AND batch.accepted_task_id = ? AND batch.batch_id = ?
                AND batch.batch_ordinal = ? AND batch.authority_digest = ?
                AND batch.call_count = 1
                AND json_extract(batch.call_ids_json, '$[0]') = ?
                AND NOT EXISTS (
                  SELECT 1 FROM accepted_model_batch_checkpoints checkpoint
                   WHERE checkpoint.session_id = batch.session_id
                     AND checkpoint.source_user_seq = batch.source_user_seq
                     AND checkpoint.batch_ordinal = batch.batch_ordinal
                )
           )
           AND EXISTS (
             SELECT 1 FROM run_dispatch_leases lease
              WHERE lease.session_id = ? AND lease.source_user_seq = ?
                AND lease.accepted_task_id = ? AND lease.logical_tool_call_id = ?
                AND lease.revoked_at IS NOT NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM run_dispatch_leases lease
              WHERE lease.session_id = ? AND lease.source_user_seq = ?
                AND lease.accepted_task_id = ? AND lease.logical_tool_call_id = ?
                AND lease.revoked_at IS NULL
           )
      `).run(
        blob,
        new Date().toISOString(),
        row.session_id,
        row.session_id,
        row.source_user_seq,
        row.start_logical_tool_call_id,
        row.accepted_task_id,
        row.session_id,
        row.source_user_seq,
        row.start_logical_tool_call_id,
        row.accepted_task_id,
        row.session_id,
        row.source_user_seq,
        row.accepted_task_id,
        row.authority_digest,
        row.session_id,
        row.source_user_seq,
        row.accepted_task_id,
        row.batch_id,
        row.batch_ordinal,
        row.authority_digest,
        row.start_logical_tool_call_id,
        row.session_id,
        row.source_user_seq,
        row.accepted_task_id,
        row.start_logical_tool_call_id,
        row.session_id,
        row.source_user_seq,
        row.accepted_task_id,
        row.start_logical_tool_call_id,
      );
    if (updated.changes !== 1) {
      replayed += 1;
      continue;
    }
    claims.push({
      sessionId: row.session_id,
      sourceUserSeq: row.source_user_seq,
      acceptedTaskId: row.accepted_task_id,
      ownerLogicalToolCallId: row.start_logical_tool_call_id,
    });
  }
  return {
    scanned: rows.length,
    claimed: claims.length,
    replayed,
    held,
    claims,
  };
}
