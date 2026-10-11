import { createHash } from 'node:crypto';
import {
  getSession,
  getToolOutput,
  listToolCalledEventsForCallId,
  openEventLog,
  toolOutputStoredIdentity,
  type EventRow,
  type ToolOutputRecord,
} from './eventlog.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { isPlainOrClementineLocalTool } from './runtime-tool-identity.js';
import { unwrapRuntimeEffectiveToolIdentity } from './tool-effect.js';
import { readSharedWorkerResult } from './worker-retained-results.js';
import { readCancelledSuccessorResultEvidence } from './cancelled-successor-retained-read.js';

export interface RetainedProjectionProducer {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  physicalDispatchId: string;
  resultHandleId: string;
  rawPayloadSha256: string;
  rawByteCount: number;
  retainedTextDigest: string;
  retainedTextChars: number;
}
export interface RetainedOutputReadResolution {
  callId: string;
  receipt?: ToolOutputRecord;
  producer?: Readonly<RetainedProjectionProducer>;
}
const authenticatedResolutions = new WeakSet<object>();
function authenticatedResolution(input: { callId: string; receipt?: ToolOutputRecord;
  producer?: Omit<RetainedProjectionProducer, 'retainedTextDigest' | 'retainedTextChars'> }): RetainedOutputReadResolution {
  const p = input.producer, receipt = input.receipt;
  const producer = p && receipt && !receipt.truncatedAtWrite ? Object.freeze({
    sessionId: p.sessionId, sourceUserSeq: p.sourceUserSeq, acceptedTaskId: p.acceptedTaskId,
    logicalToolCallId: p.logicalToolCallId, physicalDispatchId: p.physicalDispatchId,
    resultHandleId: p.resultHandleId, rawPayloadSha256: p.rawPayloadSha256, rawByteCount: p.rawByteCount,
    retainedTextDigest: createHash('sha256').update(receipt.output).digest('hex'), retainedTextChars: receipt.output.length,
  }) : undefined;
  const result = Object.freeze({ callId: input.callId, ...(receipt ? { receipt: Object.freeze({ ...receipt }) } : {}),
    ...(producer ? { producer } : {}) });
  if (producer) authenticatedResolutions.add(result);
  return result;
}
export function isAuthenticatedRetainedOutputResolution(value: RetainedOutputReadResolution): boolean {
  return authenticatedResolutions.has(value);
}

/** Read-only reference resolution. A receipt is redeemed under its own exact
 * durable identity in this session; a recall call points to its original
 * result through the host's recorded arguments, never its prose preamble.
 *
 * A delegated worker reads a parent result only through the parent's share of
 * that exact id. The id may be the one the worker named or the producer its
 * own recall resolves to; either way the share, not the lineage, grants the
 * read, so an unshared parent id stays unreadable. */
export function resolveRetainedOutputRead(sessionId: string, requestedId: string,
  request?: { sourceUserSeq: number; attemptId?: string }, verificationOnly = false): RetainedOutputReadResolution {
  const local = resolveLocalRetainedOutputRead(sessionId, requestedId);
  // Whether the id is stored here is a metadata question; the bytes are for
  // the reader that reads them.
  if (local.receipt || toolOutputStoredIdentity(sessionId, local.callId)) return local;
  if (request) {
    const shared = readCancelledSuccessorResultEvidence({ sessionId, ...request, resultHandleId: local.callId, verificationOnly });
    if (shared) return authenticatedResolution({ callId: local.callId, ...shared });
  }
  const session = getSession(sessionId);
  if (session?.kind !== 'agent' || session.metadata.source !== 'delegated_worker') return local;
  const readParent = (parentId: string, id: string): (ToolOutputRecord & { producer?: RetainedProjectionProducer }) | null => {
    // No recursive ancestry search: a share names an immediate parent's own result.
    const parent = resolveLocalRetainedOutputRead(parentId, id);
    const receipt = parent.receipt ?? getToolOutput(parentId, parent.callId);
    return receipt ? { ...receipt, ...(parent.producer ? { producer: parent.producer } : {}) } : null;
  };
  for (const id of new Set([local.callId, requestedId])) {
    const receipt = readSharedWorkerResult(id, session.metadata.parentSessionId,
      session.metadata.retainedResultShares, readParent);
    if (receipt) return authenticatedResolution({ callId: id, receipt,
      ...(receipt.producer ? { producer: receipt.producer } : {}) });
  }
  return local;
}

export function resolveLocalRetainedOutputRead(sessionId: string, requestedId: string): RetainedOutputReadResolution {
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
    return authenticatedResolution({ callId: requestedId, receipt: {
      output: result.value.rawPayloadJson,
      contentBytes: result.value.rawByteCount,
      truncatedAtWrite: false,
      tool: result.value.toolName,
      createdAt: row.settled_at,
    }, producer: { sessionId, sourceUserSeq: row.source_user_seq, ...result.value } });
  }

  let callId = requestedId;
  const visited = new Set<string>();
  while (!visited.has(callId)) {
    visited.add(callId);
    const occurrences = listToolCalledEventsForCallId(sessionId, callId);
    // The top-level row is the invocation the model made. A transport mirror
    // is a second view of the same invocation, used only when it is the sole
    // observation.
    const topLevel = occurrences.filter(event => event.data.accounting !== 'transport_mirror');
    const matches = topLevel.length > 0 ? topLevel : occurrences;
    if (matches.length !== 1) break;
    const sourceId = recallSourceCallId(matches[0]!);
    if (!sourceId || visited.has(sourceId)) break;
    callId = sourceId;
  }
  if (callId.startsWith('rh_')) return resolveLocalRetainedOutputRead(sessionId, callId);
  // Legacy retained text remains readable, but projection authority requires
  // the exact immutable successful producer, not a guessed argument string.
  const matches = openEventLog().prepare(`SELECT s.source_user_seq, l.accepted_task_id
    FROM logical_call_settlements s JOIN logical_tool_calls l
      ON l.session_id=s.session_id AND l.source_user_seq=s.source_user_seq
      AND l.logical_tool_call_id=s.logical_tool_call_id
    WHERE s.session_id=? AND s.logical_tool_call_id=?`).all(sessionId, callId) as Array<{
      source_user_seq: number; accepted_task_id: string;
    }>;
  if (matches.length === 1) {
    const row = matches[0]!;
    const result = redeemSuccessfulSettlementResultForHost({ sessionId, sourceUserSeq: row.source_user_seq,
      acceptedTaskId: row.accepted_task_id, logicalToolCallId: callId });
    const receipt = getToolOutput(sessionId, callId);
    if (result.status === 'ok' && receipt && !receipt.truncatedAtWrite
      && (receipt.output === result.value.rawPayloadJson
        || (typeof result.value.rawPayload === 'string' && receipt.output === result.value.rawPayload))) {
      return authenticatedResolution({ callId, receipt,
        producer: { sessionId, sourceUserSeq: row.source_user_seq, ...result.value } });
    }
  }
  return { callId };
}

/**
 * The call id a recorded recall read from, whichever way the recall was
 * invoked. A carrier (call_tool / work_call) records its own name as `tool`,
 * the inner reader as `effectiveTool`, and the reader's arguments inside its
 * envelope; the canonical carrier unwrapper peels that envelope, so a recall
 * of a recall reaches the original producer instead of the recall's copy.
 * When the durable effective identity is present it must agree with the
 * unwrapped arguments; any disagreement or unreadable envelope ends the walk.
 */
function recallSourceCallId(event: EventRow): string | null {
  const recorded = typeof event.data.tool === 'string' ? event.data.tool.trim() : '';
  if (!recorded) return null;
  const identity = unwrapRuntimeEffectiveToolIdentity(recorded, event.data.arguments ?? event.data.args);
  if (!identity.toolName || !isPlainOrClementineLocalTool(identity.toolName, 'recall_tool_result')) return null;
  const durable = typeof event.data.effectiveTool === 'string' ? event.data.effectiveTool.trim() : '';
  if (durable && !isPlainOrClementineLocalTool(durable, 'recall_tool_result')) return null;
  const args = identity.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const sourceId = (args as Record<string, unknown>).call_id;
  return typeof sourceId === 'string' && sourceId.trim() ? sourceId.trim() : null;
}
