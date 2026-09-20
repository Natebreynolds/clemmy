import { getSession, getToolOutput, listEvents, openEventLog, type ToolOutputRecord } from './eventlog.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { readSharedWorkerResult } from './worker-retained-results.js';

/** Read-only reference resolution. A receipt is redeemed under its own exact
 * durable identity in this session; a recall call points to its original
 * result through the host's recorded arguments, never its prose preamble. */
export function resolveRetainedOutputRead(sessionId: string, requestedId: string): {
  callId: string;
  receipt?: ToolOutputRecord;
} {
  const local = resolveLocalRetainedOutputRead(sessionId, requestedId);
  if (local.receipt || getToolOutput(sessionId, local.callId)) return local;
  const session = getSession(sessionId);
  if (session?.kind !== 'agent' || session.metadata.source !== 'delegated_worker') return local;
  const receipt = readSharedWorkerResult(requestedId, session.metadata.parentSessionId,
    session.metadata.retainedResultShares, (parentId, id) => {
      // No recursive ancestry search: a share names an immediate parent's own result.
      const parent = resolveLocalRetainedOutputRead(parentId, id);
      return parent.receipt ?? getToolOutput(parentId, parent.callId);
    });
  return receipt ? { callId: requestedId, receipt } : local;
}

export function resolveLocalRetainedOutputRead(sessionId: string, requestedId: string): {
  callId: string;
  receipt?: ToolOutputRecord;
} {
  if (requestedId.startsWith('rh_')) {
    const matches = openEventLog().prepare(`
      SELECT s.source_user_seq, l.accepted_task_id, s.logical_tool_call_id, s.settled_at
        FROM logical_call_settlements s JOIN logical_tool_calls l
          ON l.session_id = s.session_id AND l.source_user_seq = s.source_user_seq
         AND l.logical_tool_call_id = s.logical_tool_call_id
       WHERE s.session_id = ? AND s.result_handle_id = ?
    `).all(sessionId, requestedId) as Array<{ source_user_seq: number; accepted_task_id: string;
      logical_tool_call_id: string; settled_at: string }>;
    if (matches.length !== 1) return { callId: requestedId };
    const row = matches[0]!;
    const result = redeemSuccessfulSettlementResultForHost({ sessionId, sourceUserSeq: row.source_user_seq,
      acceptedTaskId: row.accepted_task_id, logicalToolCallId: row.logical_tool_call_id });
    if (result.status !== 'ok' || result.value.resultHandleId !== requestedId) return { callId: requestedId };
    return { callId: requestedId, receipt: {
      output: result.value.rawPayloadJson,
      contentBytes: result.value.rawByteCount,
      truncatedAtWrite: false,
      tool: result.value.toolName,
      createdAt: row.settled_at,
    } };
  }

  const calls = listEvents(sessionId, { types: ['tool_called'] });
  let callId = requestedId;
  const visited = new Set<string>();
  while (!visited.has(callId)) {
    visited.add(callId);
    const matches = calls.filter(event => event.data.callId === callId && event.data.accounting !== 'transport_mirror');
    if (matches.length !== 1 || matches[0]!.data.tool !== 'recall_tool_result') break;
    let args: unknown = matches[0]!.data.arguments ?? matches[0]!.data.args;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { break; }
    }
    const sourceId = args && typeof args === 'object' ? (args as Record<string, unknown>).call_id : null;
    if (typeof sourceId !== 'string' || !sourceId.trim() || visited.has(sourceId)) break;
    callId = sourceId;
  }
  return callId.startsWith('rh_') ? resolveLocalRetainedOutputRead(sessionId, callId) : { callId };
}
