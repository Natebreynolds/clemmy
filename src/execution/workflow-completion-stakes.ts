import { createHash } from 'node:crypto';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { acceptedTurnCallAuthorityFor } from '../runtime/harness/accepted-turn-call-authority.js';
import { redeemDurableLogicalCallSettlementForHost } from '../runtime/harness/logical-call-settlement-store.js';
import { undoableLocalArtifactWrite } from '../runtime/harness/host-completion-work.js';

export function workflowEvidenceCallKey(sessionId: string, sourceUserSeq: number, callId: string): string {
  return JSON.stringify([sessionId, sourceUserSeq, callId]);
}

export interface WorkflowCompletionStakesProof {
  reviewStakes: 'read' | 'write';
  /** Private exact frontier; never evidence of completion or execution authority. */
  reviewStakesDigest: string;
}

/** Effect classification uses current durable authority, not a step's authored
 * sideEffect or its output. Unknown work takes the full reviewer. This shares
 * the host turn's reversible-local-artifact exemption, with authenticated result
 * and current-content proof supplied by the existing run-evidence reader. */
export function readWorkflowCompletionStakes(input: {
  runId: string;
  available: boolean;
  definitionVerified: boolean;
  verifiedCalls: ReadonlySet<string>;
  recoverableCalls: ReadonlySet<string>;
  verifiedTransforms: readonly string[];
}): WorkflowCompletionStakesProof {
  const frontier: unknown[] = [input.runId, input.available, input.definitionVerified,
    [...input.verifiedCalls].sort(), [...input.recoverableCalls].sort(), [...input.verifiedTransforms].sort()];
  let lean = input.available && input.definitionVerified
    && (input.verifiedCalls.size > 0 || input.verifiedTransforms.length > 0);
  const finish = (): WorkflowCompletionStakesProof => ({ reviewStakes: lean ? 'read' : 'write',
    reviewStakesDigest: createHash('sha256').update(JSON.stringify(frontier)).digest('hex') });
  try {
    const db = openEventLog();
    const prefix = `workflow:${input.runId}:`;
    // A parked model step may use a UUID, and a deterministic partition has
    // its own session. A prefix alone is not the run's inventory or authority.
    const sessions = db.prepare(`SELECT id, kind, metadata_json FROM sessions
      WHERE (id >= ? AND id < ?)
         OR (json_valid(metadata_json) AND json_extract(metadata_json, '$.workflowRunId') = ?)
         OR id IN (SELECT session_id FROM accepted_turn_call_authorities WHERE run_id = ?)
      ORDER BY id LIMIT 513`).all(prefix, `${prefix.slice(0, -1)};`, input.runId, input.runId) as Array<{
        id: string; kind: string; metadata_json: string;
      }>;
    if (sessions.length > 512) { lean = false; frontier.push('session_limit'); return finish(); }
    const ids = sessions.map(row => row.id);
    if (ids.length === 0) {
      if (input.verifiedCalls.size > 0) lean = false;
      return finish(); // Exact host transforms need no tool session.
    }
    const placeholders = ids.map(() => '?').join(',');
    const tables = ['logical_tool_calls', 'logical_call_settlements', 'physical_dispatches', 'accepted_model_batch_admissions'] as const;
    const columns = [
      'session_id, source_user_seq, accepted_task_id, logical_tool_call_id, tool_name, argument_digest, state, settlement_event_id',
      'session_id, source_user_seq, logical_tool_call_id, semantic_digest, execution_kind, outcome_kind, mutating, requirement_id, observer_call_id, settlement_event_id, physical_crossings_digest',
      'session_id, source_user_seq, accepted_task_id, logical_tool_call_id, physical_dispatch_id, state, argument_digest, start_event_id, settle_event_id',
      'session_id, source_user_seq, accepted_task_id, batch_id, batch_ordinal, authority_digest, source_event_digest, call_ids_json, call_count',
    ];
    const rows = tables.map((table, index) => db.prepare(`SELECT ${columns[index]} FROM ${table} WHERE session_id IN (${placeholders})
      ORDER BY session_id, source_user_seq${table === 'accepted_model_batch_admissions' ? ', batch_ordinal' : table === 'physical_dispatches' ? ', physical_dispatch_id' : ', logical_tool_call_id'} LIMIT 4097`)
      .all(...ids) as Array<Record<string, unknown>>);
    const [calls, settlements, dispatches, admissions] = rows;
    // Hash identities/digests/states only; encrypted history/request payloads
    // are neither reopened nor retained by this classification.
    frontier.push(rows.map(table => table.slice(0, 4_096).map(row => Object.fromEntries(Object.entries(row)
      .filter(([key]) => !key.endsWith('_json') && !['outcome_detail', 'provider_status'].includes(key))))));
    if (rows.some(table => table.length > 4_096)) { lean = false; frontier.push('row_limit'); return finish(); }
    const sessionById = new Map(sessions.map(row => [row.id, row]));
    const sources = new Map<string, { taskId: string; authorityDigest: string; sourceDigest: string } | null>();
    for (const row of rows.flat()) {
      const sessionId = String(row.session_id), seq = Number(row.source_user_seq);
      const key = JSON.stringify([sessionId, seq]);
      if (sources.has(key)) continue;
      const root = acceptedTurnCallAuthorityFor(sessionId, seq);
      const session = sessionById.get(sessionId);
      let owned = root.status === 'ok' && session?.kind === 'workflow'
        && (root.authority.workflow?.runId === input.runId || root.authority.paginatedWorkflow?.runId === input.runId);
      if (!owned && root.status === 'ok' && session?.kind === 'workflow') {
        const event = db.prepare('SELECT id, role, type, data_json FROM events WHERE session_id = ? AND seq = ?')
          .get(sessionId, seq) as { id: string; role: string; type: string; data_json: string } | undefined;
        const metadata = JSON.parse(session.metadata_json) as Record<string, unknown>;
        const data = event ? JSON.parse(event.data_json) as Record<string, unknown> : {};
        // These are the host-persisted workflow source and session owner,
        // authenticated by the accepted-source digest. Rendered prose is not used.
        owned = event?.id === root.authority.sourceEventId && event.role === 'user'
          && event.type === 'user_input_received' && metadata.workflowRunId === input.runId
          && data.workflowRunId === input.runId && typeof metadata.stepId === 'string'
          && data.stepId === metadata.stepId;
      }
      const value = owned && root.status === 'ok' ? { taskId: root.authority.identity.acceptedTaskId,
        authorityDigest: root.authority.authorityDigest, sourceDigest: root.authority.sourceEventDigest } : null;
      sources.set(key, value);
      frontier.push([key, root.status, root.status === 'ok' ? root.authority.sourceEventDigest : null, Boolean(value)]);
      if (!value) lean = false;
    }
    const callKey = (row: Record<string, unknown>) => workflowEvidenceCallKey(String(row.session_id), Number(row.source_user_seq), String(row.logical_tool_call_id));
    const callsByKey = new Map(calls.map(row => [callKey(row), row]));
    const settlementsByKey = new Map(settlements.map(row => [callKey(row), row]));
    const dispatchSet = new Set(dispatches);
    for (const row of [...calls, ...settlements, ...dispatches]) {
      const key = callKey(row), call = callsByKey.get(key), settlement = settlementsByKey.get(key);
      if (!call || !settlement || call.state !== 'settled' || !input.verifiedCalls.has(key)) lean = false;
      if (dispatchSet.has(row)) {
        const owner = sources.get(JSON.stringify([row.session_id, row.source_user_seq]));
        if (row.state !== 'returned' || !owner || row.accepted_task_id !== owner.taskId) lean = false;
      }
    }
    for (const row of settlements) {
      const key = callKey(row);
      const owner = sources.get(JSON.stringify([row.session_id, row.source_user_seq]));
      const call = callsByKey.get(key);
      if (!owner || !call || call.accepted_task_id !== owner.taskId) { lean = false; continue; }
      const proof = redeemDurableLogicalCallSettlementForHost({ sessionId: String(row.session_id),
        sourceUserSeq: Number(row.source_user_seq), acceptedTaskId: owner.taskId,
        logicalToolCallId: String(row.logical_tool_call_id) });
      if (proof.status !== 'ok') { lean = false; frontier.push([key, proof.status]); continue; }
      const settlement = proof.settlement;
      if (!['succeeded', 'empty_result'].includes(settlement.outcome.kind)
        || settlement.executionKind === 'refused_pre_dispatch') lean = false;
      if (settlement.recovery.mutating && !(settlement.executionKind === 'local_execution'
        && settlement.outcome.kind === 'succeeded'
        && undoableLocalArtifactWrite(settlement.toolName, settlement.recovery.requirementId ?? null)
        && input.recoverableCalls.has(key))) lean = false;
    }
    const aliases = new Map<string, Set<string>>();
    for (const row of settlements) {
      for (const id of [row.logical_tool_call_id, row.observer_call_id]) {
        if (typeof id !== 'string') continue;
        const alias = JSON.stringify([row.session_id, row.source_user_seq, id]);
        const keys = aliases.get(alias) ?? new Set<string>();
        keys.add(callKey(row)); aliases.set(alias, keys);
      }
    }
    for (const row of admissions) {
      const owner = sources.get(JSON.stringify([row.session_id, row.source_user_seq]));
      const callIds = JSON.parse(String(row.call_ids_json)) as unknown;
      frontier.push([row.batch_id, callIds]);
      if (!owner || row.accepted_task_id !== owner.taskId || row.authority_digest !== owner.authorityDigest
        || row.source_event_digest !== owner.sourceDigest
        || !Array.isArray(callIds) || callIds.length !== row.call_count || new Set(callIds).size !== callIds.length
        || callIds.some(id => typeof id !== 'string'
          || aliases.get(JSON.stringify([row.session_id, row.source_user_seq, id]))?.size !== 1)) lean = false;
    }
    return finish();
  } catch { lean = false; frontier.push('unavailable'); return finish(); }
}
