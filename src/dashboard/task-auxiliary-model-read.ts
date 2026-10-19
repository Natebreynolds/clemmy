/** Passive, bounded SystemOne observations. A parsed response is not an
 * independent review verdict, billed account proof or a complete call census. */
import type { TaskAuxiliaryModel } from '../types/task-handling.js';
import { modelCallPurpose } from '../runtime/model-call-purpose.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { redactSensitiveText } from '../runtime/security.js';

const CALL_CAP = 100;
const ROW_CAP = 2000;
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const roles = new Set(['brain', 'worker', 'reviewer', 'router', 'writer', 'memory']);
const fields = ['version', 'sourceUserSeq', 'logicalTurnId', 'ownerKind', 'usageJobId', 'runAttemptId', 'modelCallId', 'physicalAttempt',
  'purpose', 'callPurpose', 'phase', 'dispatchId', 'wireSubattempt', 'transport', 'requestedModel', 'status', 'ok', 'durationMs',
  'late', 'journalFailed', 'outcome', 'resultScope', 'dispatchIds', 'hostResultReceiptId', 'providerReportedModel', 'remoteSettlement', 'usage', 'at', 'clock'];
type Row = { seq: number; data_json: string; call_first: number; call_count: number };
type Observation = { seq: number; data: Record<string, unknown> };
export interface ExactRouteCallObservation { callId: string; attemptId: string; physicalAttempt: number }

export function readTaskAuxiliaryModels(owner: { sessionId: string; sourceUserSeq: number }, mainCalls: readonly ExactRouteCallObservation[] = []) {
  const empty = { models: [] as TaskAuxiliaryModel[], truncated: false, limitations: [] as string[] };
  if (!identity(owner.sessionId) || !positive(owner.sourceUserSeq)) return empty;
  const db = openEventLog();
  if (!db.prepare("SELECT 1 FROM events WHERE session_id = ? AND seq = ? AND type = 'user_input_received' AND role = 'user'")
    .get(owner.sessionId, owner.sourceUserSeq)) return empty;
  const projection = fields.flatMap(field => [`'${field}'`, `json_extract(own.data_json, '$.${field}')`]).join(', ');
  // The existing session/sequence index bounds the read to this accepted
  // request's retained tail. Exact ownership, not the tail/time, elects rows.
  // Limit groups before their lifecycle rows; a chatty call cannot multiply
  // into 100 apparent calls or hide later calls behind transport mirrors.
  const rows = db.prepare(`WITH own AS MATERIALIZED (
    SELECT e.seq, e.data_json FROM events e INDEXED BY idx_events_session_seq
    WHERE e.session_id = ? AND e.seq > ? AND e.type = 'model_transport_observed' AND e.role = 'system'
      AND json_valid(e.data_json) AND json_extract(e.data_json, '$.sourceUserSeq') = ?
      AND EXISTS (SELECT 1 FROM run_attempts a WHERE a.attempt_id = json_extract(e.data_json, '$.runAttemptId')
        AND a.session_id = e.session_id AND a.source_user_seq = ?)
  ), calls AS (
    SELECT json_extract(data_json, '$.runAttemptId') AS attempt, json_extract(data_json, '$.modelCallId') AS call,
      json_extract(data_json, '$.physicalAttempt') AS physical, MIN(seq) AS first_seq
    FROM own WHERE (json_extract(data_json, '$.transport') = 'typesafe_systemone'
      OR json_extract(data_json, '$.resultScope') = 'owned_systemone_parser')
      AND typeof(json_extract(data_json, '$.modelCallId')) = 'text'
      AND length(json_extract(data_json, '$.modelCallId')) BETWEEN 1 AND 240
      AND typeof(json_extract(data_json, '$.physicalAttempt')) = 'integer'
      AND json_extract(data_json, '$.physicalAttempt') > 0
    GROUP BY attempt,call,physical ORDER BY first_seq LIMIT 101
  ) SELECT own.seq,json_object(${projection}) AS data_json,calls.first_seq AS call_first,(SELECT COUNT(*) FROM calls) AS call_count
    FROM own JOIN calls ON json_extract(own.data_json, '$.runAttemptId') = calls.attempt
      AND json_extract(own.data_json, '$.modelCallId') = calls.call
      AND json_extract(own.data_json, '$.physicalAttempt') = calls.physical
    ORDER BY calls.first_seq,own.seq LIMIT ?`)
    .all(owner.sessionId, owner.sourceUserSeq, owner.sourceUserSeq, owner.sourceUserSeq, ROW_CAP + 1) as Row[];
  const groups = new Map<string, Observation[]>();
  for (const row of rows.slice(0, ROW_CAP)) {
    const data = JSON.parse(row.data_json) as Record<string, unknown>;
    if (!identity(data.modelCallId) || !identity(data.runAttemptId) || !positive(data.physicalAttempt)) continue;
    const key = JSON.stringify([data.runAttemptId, data.modelCallId, data.physicalAttempt]);
    const group = groups.get(key) ?? [];
    if (!group.some(prior => JSON.stringify(prior.data) === row.data_json)) group.push({ seq: row.seq, data });
    groups.set(key, group);
  }
  const truncated = (rows[0]?.call_count ?? 0) > CALL_CAP || rows.length > ROW_CAP;
  const owners = new Map<string, Set<string>>(), receipts = new Map<string, Set<string>>();
  for (const [key, rows] of groups) for (const row of rows) {
    const ownerSet = owners.get(String(row.data.modelCallId)) ?? new Set<string>();
    ownerSet.add(JSON.stringify([row.data.runAttemptId, row.data.ownerKind, row.data.usageJobId ?? null]));
    owners.set(String(row.data.modelCallId), ownerSet);
    if (row.data.phase === 'model_result_completed' && identity(row.data.hostResultReceiptId)) {
      const receiptSet = receipts.get(row.data.hostResultReceiptId) ?? new Set<string>();
      receiptSet.add(key); receipts.set(row.data.hostResultReceiptId, receiptSet);
    }
  }
  const models: TaskAuxiliaryModel[] = [];
  for (const group of [...groups.values()].slice(0, CALL_CAP)) {
    const first = group[0]!.data;
    if (mainCalls.some(row => row.callId === first.modelCallId && row.attemptId === first.runAttemptId && row.physicalAttempt === first.physicalAttempt)) continue;
    const sharedReceipt = group.some(row => identity(row.data.hostResultReceiptId) && (receipts.get(row.data.hostResultReceiptId)?.size ?? 0) > 1);
    models.push(projectCall(group, owner.sourceUserSeq, truncated, (owners.get(String(first.modelCallId))?.size ?? 0) > 1 || sharedReceipt));
  }
  return { models, truncated, limitations: [
    ...(truncated ? ['Some auxiliary model observations are outside this bounded view; their outcomes remain unconfirmed.'] : []),
    ...(models.length ? ['Auxiliary observations show recorded requests and parsed responses, not a passed review, complete model inventory or billed charges.'] : []),
  ] };
}

function projectCall(rows: Observation[], sourceUserSeq: number, truncated: boolean, ownerConflict: boolean): TaskAuxiliaryModel {
  const first = rows[0]!.data;
  const starts = rows.filter(row => row.data.phase === 'adapter_attempt_created');
  const dispatches = rows.filter(row => row.data.phase === 'dispatch_started');
  const finishes = rows.filter(row => row.data.phase === 'adapter_attempt_finished');
  const completed = rows.filter(row => row.data.phase === 'model_result_completed');
  const retired = rows.filter(row => row.data.phase === 'model_attempt_retired');
  const values = (key: string) => new Set(rows.map(row => row.data[key]).filter(value => value !== null && value !== undefined));
  const requested = new Set(dispatches.map(row => row.data.requestedModel).filter(identity));
  const reported = values('providerReportedModel');
  const purposes = values('callPurpose');
  const roleValues = values('purpose');
  const dispatchIds = new Set(dispatches.map(row => row.data.dispatchId).filter(identity));
  const idsMatch = (row: Observation) => Array.isArray(row.data.dispatchIds) && row.data.dispatchIds.length === dispatchIds.size
    && row.data.dispatchIds.every(value => identity(value) && dispatchIds.has(value))
    && new Set(row.data.dispatchIds).size === dispatchIds.size;
  let conflicting = ownerConflict || roleValues.size > 1 || requested.size > 1 || reported.size > 1 || purposes.size > 1
    || values('ownerKind').size > 1
    || new Set(rows.map(row => row.data.usageJobId ?? null)).size > 1
    || starts.length > 1 || finishes.length > 1 || completed.length > 1 || retired.length > 1
    || dispatchIds.size !== dispatches.length;
  const validBase = rows.every(row => row.data.version === 1 && row.data.sourceUserSeq === sourceUserSeq
    // An accounting parent's retained tuple is not a durable job-parent
    // proof. Keep it visible, but do not upgrade it into a confirmed source.
    && row.data.logicalTurnId === `turn:${sourceUserSeq}` && row.data.ownerKind === 'accepted_source_scope'
    && (row.data.usageJobId === null || identity(row.data.usageJobId))
    && row.data.clock === 'host_epoch_ms' && typeof row.data.at === 'number' && Number.isFinite(row.data.at)
    && row.data.journalFailed === 0 && row.data.late !== 1);
  if (new Set([...finishes, ...completed, ...retired].map(row => row.data.outcome).filter(value => value !== null)).size > 1) conflicting = true;
  const headerReceipts = rows.filter(row => row.data.phase === 'headers_received');
  const failedDispatches = rows.filter(row => row.data.phase === 'dispatch_failed');
  let settledDispatches = dispatches.length > 0 && dispatchIds.size === dispatches.length;
  for (const dispatch of dispatches) {
    const terminals = [...headerReceipts, ...failedDispatches].filter(row => row.data.dispatchId === dispatch.data.dispatchId);
    if (terminals.length > 1) conflicting = true;
    if (dispatch.data.transport !== 'typesafe_systemone' || !positive(dispatch.data.wireSubattempt) || terminals.length !== 1
      || terminals[0]!.seq <= dispatch.seq || terminals[0]!.data.transport !== 'typesafe_systemone'
      || terminals[0]!.data.wireSubattempt !== dispatch.data.wireSubattempt) settledDispatches = false;
  }
  if ([...headerReceipts, ...failedDispatches].some(row => !dispatchIds.has(String(row.data.dispatchId)))) conflicting = true;
  const ending = finishes[0], result = completed[0];
  const responseCompleted = !truncated && !conflicting && validBase && starts.length === 1 && finishes.length === 1 && completed.length === 1 && retired.length === 0
    && starts[0]!.data.resultScope === 'local_adapter_attempt' && identity(result!.data.hostResultReceiptId)
    && settledDispatches && requested.size === 1 && starts[0]!.seq < dispatches[0]!.seq && ending!.seq > Math.max(...headerReceipts.map(row => row.seq), ...failedDispatches.map(row => row.seq))
    && result!.seq > ending!.seq && [ending!, result!].every(row => row.data.outcome === 'returned'
      && row.data.resultScope === 'owned_systemone_parser' && row.data.remoteSettlement === 'parsed_response' && idsMatch(row))
    && headerReceipts.some(row => row.data.ok === 1 && typeof row.data.status === 'number' && row.data.status >= 200 && row.data.status < 300);
  const role = roleValues.size === 1 && roles.has(String(first.purpose)) ? first.purpose as TaskAuxiliaryModel['role'] : 'unknown';
  const callPurpose = !conflicting && purposes.size === 1 ? modelCallPurpose([...purposes][0]) : undefined;
  const knownFailure = validBase && !truncated && !conflicting && starts.length === 1 && finishes.length === 1
    && ['failed', 'cancelled'].includes(String(ending!.data.outcome)) && idsMatch(ending!);
  const duration = starts.length === 1 && ending && typeof starts[0]!.data.at === 'number' && typeof ending.data.at === 'number'
    ? ending.data.at - starts[0]!.data.at : undefined;
  return { callId: String(first.modelCallId), attemptId: String(first.runAttemptId), physicalAttempt: Number(first.physicalAttempt),
    transport: 'typesafe_systemone', role, ...(callPurpose ? { callPurpose } : {}),
    ...(requested.size === 1 ? { requestedModel: redactSensitiveText([...requested][0]!).slice(0, 240) } : {}),
    ...(responseCompleted && reported.size === 1 && identity(ending!.data.providerReportedModel)
      && ending!.data.providerReportedModel === result!.data.providerReportedModel
      ? { providerReportedModel: redactSensitiveText(String([...reported][0])).slice(0, 240) } : {}),
    responseCompleted, status: responseCompleted ? 'returned' : knownFailure ? ending!.data.outcome as 'failed' | 'cancelled'
      : conflicting || truncated || !validBase || finishes.length || completed.length || retired.length ? 'unconfirmed' : 'started',
    dispatchCount: dispatchIds.size, usage: responseCompleted && ending!.data.usage === 'reported' && result!.data.usage === 'reported' ? 'reported' : 'unknown',
    evidence: conflicting ? 'conflicting' : responseCompleted ? 'parsed_response' : 'incomplete',
    ...(!conflicting && !truncated && validBase && typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? { durationMs: duration } : {}) };
}
