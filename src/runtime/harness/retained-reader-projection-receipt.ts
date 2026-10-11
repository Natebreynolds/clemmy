import { createHash } from 'node:crypto';
import { currentLogicalCall, currentPhysicalDispatch } from './attempt-identity.js';
import { appendEvent, openEventLog } from './eventlog.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import { isAuthenticatedRetainedOutputResolution, resolveRetainedOutputRead,
  type RetainedOutputReadResolution } from './retained-output-read.js';

const KIND = 'retained_reader_projection_v1';
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
type Range = { start: number; end: number; total: number };
function validRange(range: Range, total: number): boolean {
  return [range.start, range.end, range.total].every(Number.isSafeInteger)
    && range.start >= 0 && range.end >= range.start && range.total >= range.end && range.total === total;
}
function requestNarrowsSource(args: Record<string, unknown>): boolean {
  if (typeof args.path === 'string') return true;
  if (typeof args.offset === 'number' && args.offset > 0) return true;
  return ['fields', 'filter_field', 'filter_contains', 'filter_equals', 'where', 'sort_by', 'aggregate', 'value_field', 'group_by']
    .some(key => { const value = args[key]; return value !== null && value !== undefined
      && (typeof value !== 'string' || value.trim() !== '') && (!Array.isArray(value) || value.length > 0); });
}
function consumerAttempt(sessionId: string, sourceUserSeq: number) {
  const rows = openEventLog().prepare('SELECT attempt_id,run_id FROM run_attempts WHERE session_id=? AND source_user_seq=?')
    .all(sessionId, sourceUserSeq) as Array<{ attempt_id: string; run_id: string }>;
  return rows.length === 0 ? null : rows.length === 1 ? rows[0] : undefined;
}

/** A private host observation of successfully returned source bytes. Request
 * arguments nominate a source; they cannot mint producer/range authority. */
export function recordRetainedReaderProjection(input: {
  toolName: string; args: unknown; resolved: RetainedOutputReadResolution;
  scope: { sessionId: string; sourceUserSeq?: number; runAttemptId?: string; turn?: number };
  body: string; range?: Range; selectionComplete?: boolean; selection?: Record<string, unknown>;
}): void {
  const logical = currentLogicalCall(), producer = input.resolved.producer;
  if (!logical || !producer || !input.scope.sourceUserSeq
    || !isAuthenticatedRetainedOutputResolution(input.resolved)) return;
  try {
    const db = openEventLog();
    const row = db.prepare(`SELECT accepted_task_id,state,COALESCE(effective_argument_digest,argument_digest) argument_digest
      FROM logical_tool_calls WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?`)
      .get(input.scope.sessionId, input.scope.sourceUserSeq, logical.logicalToolCallId) as {
        accepted_task_id: string; state: string; argument_digest: string;
      } | undefined;
    const contract = durableLogicalCallContract(logical.acceptedTaskId, input.toolName, input.args);
    const attempt = consumerAttempt(input.scope.sessionId, input.scope.sourceUserSeq);
    if (!row || row.accepted_task_id !== logical.acceptedTaskId || row.state === 'settled' || !contract
      || attempt === undefined || (input.scope.runAttemptId && input.scope.runAttemptId !== attempt?.attempt_id)) return;
    const physical = currentPhysicalDispatch();
    const crossings = db.prepare(`SELECT physical_dispatch_id FROM physical_dispatches
      WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=? AND state='started'`)
      .all(input.scope.sessionId, input.scope.sourceUserSeq, logical.logicalToolCallId) as Array<{ physical_dispatch_id: string }>;
    const crossing = physical ? crossings.find(r => r.physical_dispatch_id === physical.physicalDispatchId)
      : crossings.length === 1 ? crossings[0] : undefined;
    if (!crossing) return;
    const range = input.range;
    if (range && (!validRange(range, producer.retainedTextChars)
      || !input.resolved.receipt || !input.body.endsWith(input.resolved.receipt.output.slice(range.start, range.end)))) return;
    appendEvent({ sessionId: input.scope.sessionId, turn: input.scope.turn ?? 1, role: 'system', type: 'evidence_receipt', data: {
      kind: KIND, sourceUserSeq: input.scope.sourceUserSeq, acceptedTaskId: logical.acceptedTaskId,
      logicalToolCallId: logical.logicalToolCallId, physicalDispatchId: crossing.physical_dispatch_id,
      toolName: contract.toolName, consumerArgumentDigest: row.argument_digest, readerArgumentDigest: contract.argumentDigest,
      attemptId: attempt?.attempt_id ?? null, runId: attempt?.run_id ?? null,
      returnedTextDigest: sha(input.body), resolvedCallId: input.resolved.callId,
      source: { sessionId: producer.sessionId, sourceUserSeq: producer.sourceUserSeq,
        acceptedTaskId: producer.acceptedTaskId, logicalToolCallId: producer.logicalToolCallId,
        physicalDispatchId: producer.physicalDispatchId, resultHandleId: producer.resultHandleId,
        contentDigest: producer.rawPayloadSha256, rawByteCount: producer.rawByteCount,
        retainedTextDigest: producer.retainedTextDigest, retainedTextChars: producer.retainedTextChars },
      ...(range ? { range, selectedTextDigest: sha(input.resolved.receipt!.output.slice(range.start, range.end)) } : {}), ...(input.selection ? { selection: input.selection } : {}),
      sourceSelectionComplete: range ? range.start === 0 && range.end === range.total : input.selectionComplete === true,
    } });
  } catch { /* Missing proof cannot become guessed source coverage. */ }
}

function returnedText(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (record.isError === true || !Array.isArray(record.content) || record.content.length !== 1) return undefined;
  const item = record.content[0];
  return item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string' ? item.text : undefined;
}

/** Verify the actual consumer crossing and re-open its exact authorized
 * current/shared producer. Finished-consumer inspection grants no tool read. */
export function loadRetainedReaderProjection(input: {
  sessionId: string; sourceUserSeq: number; acceptedTaskId: string; logicalToolCallId: string;
  physicalDispatchId: string; toolName: string; args: unknown; consumerArgumentDigest?: string | null; payload: unknown;
}) {
  try {
    const contract = durableLogicalCallContract(input.acceptedTaskId, input.toolName, input.args), text = returnedText(input.payload);
    if (!contract || text === undefined || !input.consumerArgumentDigest) return undefined;
    const rows = openEventLog().prepare(`SELECT data_json FROM events WHERE session_id=? AND type='evidence_receipt' AND role='system'
      AND json_extract(data_json,'$.kind')=? AND json_extract(data_json,'$.sourceUserSeq')=?
      AND json_extract(data_json,'$.logicalToolCallId')=? ORDER BY seq`)
      .all(input.sessionId, KIND, input.sourceUserSeq, input.logicalToolCallId) as Array<{ data_json: string }>;
    if (rows.length !== 1) return undefined;
    const proof = JSON.parse(rows[0]!.data_json), attempt = consumerAttempt(input.sessionId, input.sourceUserSeq);
    if (attempt === undefined || proof.attemptId !== (attempt?.attempt_id ?? null) || proof.runId !== (attempt?.run_id ?? null)
      || proof.physicalDispatchId !== input.physicalDispatchId || proof.acceptedTaskId !== input.acceptedTaskId
      || proof.toolName !== contract.toolName || proof.consumerArgumentDigest !== input.consumerArgumentDigest
      || proof.readerArgumentDigest !== contract.argumentDigest || proof.returnedTextDigest !== sha(text)
      || typeof proof.sourceSelectionComplete !== 'boolean') return undefined;
    const requestedId = input.args && typeof input.args === 'object' && !Array.isArray(input.args)
      ? (input.args as Record<string, unknown>).call_id : undefined;
    if (typeof requestedId !== 'string') return undefined;
    const resolved = resolveRetainedOutputRead(input.sessionId, requestedId,
      { sourceUserSeq: input.sourceUserSeq, ...(attempt ? { attemptId: attempt.attempt_id } : {}) }, true);
    const p = resolved.producer, source = proof.source;
    if (!p || !source || !isAuthenticatedRetainedOutputResolution(resolved) || proof.resolvedCallId !== resolved.callId
      || source.sessionId !== p.sessionId || source.sourceUserSeq !== p.sourceUserSeq
      || source.acceptedTaskId !== p.acceptedTaskId || source.logicalToolCallId !== p.logicalToolCallId
      || source.physicalDispatchId !== p.physicalDispatchId || source.resultHandleId !== p.resultHandleId
      || source.contentDigest !== p.rawPayloadSha256 || source.rawByteCount !== p.rawByteCount
      || source.retainedTextDigest !== p.retainedTextDigest || source.retainedTextChars !== p.retainedTextChars) return undefined;
    if (proof.range && (!validRange(proof.range, p.retainedTextChars) || !resolved.receipt
      || proof.selectedTextDigest !== sha(resolved.receipt.output.slice(proof.range.start, proof.range.end))
      || !text.endsWith(resolved.receipt.output.slice(proof.range.start, proof.range.end))
      || proof.sourceSelectionComplete !== (proof.range.start === 0 && proof.range.end === proof.range.total))) return undefined;
    const args = input.args as Record<string, unknown>;
    if (proof.range) {
      const offset = contract.toolName === 'recall_tool_result' && typeof args.offset === 'number' && Number.isFinite(args.offset)
        ? Math.max(0, Math.trunc(args.offset)) : 0;
      if (proof.range.start !== Math.min(offset, p.retainedTextChars)) return undefined;
      if (contract.toolName === 'recall_tool_result' && typeof args.max_chars === 'number' && Number.isFinite(args.max_chars)
        && proof.range.end - proof.range.start > Math.max(100, Math.trunc(args.max_chars))) return undefined;
    } else if (proof.sourceSelectionComplete) {
      const selection = proof.selection;
      if (requestNarrowsSource(args) || !selection || selection.clipped === true
        || (selection.kind === 'records' && (selection.offset !== 0 || selection.count !== selection.totalRecords
          || selection.count !== selection.matchingRecords))
        || !['records', 'object', 'scalar'].includes(selection.kind)) return undefined;
    }
    return { sourceLogicalToolCallId: p.logicalToolCallId, sourceResultHandleId: p.resultHandleId,
      sourcePhysicalDispatchId: p.physicalDispatchId, sourceSessionId: p.sessionId, sourceUserSeq: p.sourceUserSeq,
      sourceSelectionComplete: proof.sourceSelectionComplete as boolean,
      ...(proof.range ? { sourceReadRange: proof.range as Range } : {}),
      ...(proof.selection ? { sourceReadSelection: proof.selection as Record<string, unknown> } : {}) };
  } catch { return undefined; }
}
