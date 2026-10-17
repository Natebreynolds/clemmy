import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';

// This is an explicit-home accounting reader. Runtime readers import the
// migrating eventlog/config singletons, so keep the retained v1 wire decoder
// local and exercise it against the actual producer in the companion test.
const text = z.string();
const packetSchema = z.object({
  version: z.literal(1),
  proposal: z.object({ id: text, checkInId: text, title: text, action: text,
    why: text, evidence: z.array(text), goalId: text.nullable(), createdAt: text }).strict(),
  checkIn: z.object({ id: text, question: text, contextSummary: text.optional(),
    answer: text, answeredAt: text }).strict(),
  decision: z.object({ kind: z.literal('do_it'), instruction: text.optional(), modelIdentity: text.optional() }).strict(),
  constraints: z.object({ rules: z.array(text), standingAnswers: z.array(z.object({
    about: text, text, at: text,
  }).strict()) }).strict(),
  goal: z.record(z.string(), z.unknown()).nullable(),
}).strict();
type Packet = z.infer<typeof packetSchema>;
type Operation = 'noticing_proposal' | 'noticing_answer';
type Row = Record<string, unknown>;
interface JobTuple { usageJobId: string; operation: Operation; operationId: string; revisionDigest: string }
interface JournalRow { actor: unknown; model_call_id: unknown; session_id: unknown;
  workflow_run_id: unknown; workflow_node_run_id: unknown; tool_call_id: unknown; payload_json: string }
interface JournalEvent { row: JournalRow; payload: Row }
interface OperationReceipt { tuple: Omit<JobTuple, 'usageJobId'>; usageJobId: string; digest: string; parent: string }
export interface AcceptedTaskNoticingParticipants {
  jobs: Array<JobTuple & { parentAcceptedSources: string[]; responseBindings: Array<{
    modelCallId: string; physicalAttempt: number; providerResponseIdDigest: string;
  }>; startedAt: number | null; finishedAt: number | null }>;
  claimedJobIds: string[];
  issues: string[];
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value);
const sessionIdentity = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const jobId = (value: unknown): value is string => typeof value === 'string'
  && /^noticing-job:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const seq = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const finiteTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function json(value: unknown): Row | undefined {
  if (typeof value !== 'string') return undefined;
  try { const parsed: unknown = JSON.parse(value); return object(parsed) ? parsed : undefined; } catch { return undefined; }
}
function tuple(value: Row): JobTuple | undefined {
  return value.version === 1 && value.ownerKind === 'accounting_job' && jobId(value.usageJobId)
    && (value.operation === 'noticing_proposal' || value.operation === 'noticing_answer')
    && identity(value.operationId) && hash(value.revisionDigest)
    ? { usageJobId: value.usageJobId, operation: value.operation, operationId: value.operationId, revisionDigest: value.revisionDigest }
    : undefined;
}
const tupleKey = (value: Omit<JobTuple, 'usageJobId'>): string => JSON.stringify([value.operation, value.operationId, value.revisionDigest]);
const ownKey = (value: JobTuple): string => JSON.stringify([value.usageJobId, tupleKey(value)]);
function parentless(event: JournalEvent): boolean {
  return [event.row.session_id, event.row.workflow_run_id, event.row.workflow_node_run_id, event.row.tool_call_id]
    .every(value => value === null)
    && ['sourceUserSeq', 'logicalTurnId', 'runAttemptId', 'acceptedSource', 'attemptId', 'usageParentTurn']
      .every(key => !Object.hasOwn(event.payload, key));
}
function eventTime(event: JournalEvent): number | null {
  return event.payload.clock === 'host_epoch_ms' && finiteTime(event.payload.at) ? event.payload.at : null;
}
function openReadOnly(file: string): Database.Database {
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try { db.pragma('query_only = ON'); return db; }
  catch (error) { db.close(); throw error; }
}

/** The result inventories accounting participants only. It grants no task,
 * tool, account or effect authority, and absence never certifies zero usage.
 * Missing/rotated cross-store receipts remain explicit unknowns. */
export function readAcceptedTaskNoticingParticipants(home: string,
  acceptedSources: readonly { sessionId: string; sourceUserSeq: number }[],
): AcceptedTaskNoticingParticipants {
  const result: AcceptedTaskNoticingParticipants = { jobs: [], claimedJobIds: [], issues: [] };
  const issues = new Set<string>();
  const claimed = new Set<string>();
  const receipts: OperationReceipt[] = [];
  const operations = new Map<string, Omit<JobTuple, 'usageJobId'>>();
  const snapshots = new Map<string, string>();
  const issue = (code: string): void => { issues.add(code); };
  const finish = (): AcceptedTaskNoticingParticipants => {
    result.jobs.sort((a, b) => a.usageJobId.localeCompare(b.usageJobId));
    result.claimedJobIds = [...claimed].sort(); result.issues = [...issues].sort(); return result;
  };
  if (!path.isAbsolute(home)) { issue('noticing_explicit_home_invalid'); return finish(); }
  if (acceptedSources.length === 0) return finish();
  if (acceptedSources.length > 256) { issue('noticing_source_inventory_limit'); return finish(); }
  const readSnapshot = (file: string): Row | undefined => {
    try {
      const bytes = readFileSync(file, 'utf8');
      if (snapshots.has(file) && snapshots.get(file) !== bytes) issue('noticing_retained_receipts_changed');
      else snapshots.set(file, bytes);
      const parsed = json(bytes); if (!parsed) issue('noticing_retained_json_invalid'); return parsed;
    } catch { issue('noticing_retained_receipt_unavailable'); return undefined; }
  };
  let harness: Database.Database;
  try {
    harness = openReadOnly(path.join(home, 'state', 'harness.db'));
  } catch { issue('noticing_source_store_unavailable'); return finish(); }
  try {
    harness.transaction(() => {
      let state: Row | undefined;
      const seenSources = new Set<string>();
      for (const source of acceptedSources) {
        if (!sessionIdentity(source.sessionId) || !seq(source.sourceUserSeq)) { issue('noticing_source_identity_invalid'); continue; }
        const parent = `${source.sessionId}:${source.sourceUserSeq}`;
        if (seenSources.has(parent)) continue;
        seenSources.add(parent);
        let sourceRow: { seq: number; role: string; type: string; data_json: string } | undefined;
        try { sourceRow = harness.prepare('SELECT seq, role, type, data_json FROM events WHERE session_id = ? AND seq = ?')
          .get(source.sessionId, source.sourceUserSeq) as typeof sourceRow; }
        catch { issue('noticing_source_schema_unavailable'); continue; }
        if (!sourceRow) { issue('noticing_named_source_unavailable'); continue; }
        const data = json(sourceRow.data_json);
        if (!data) { issue('noticing_source_payload_invalid'); continue; }
        if (data.noticingApprovedTask === undefined) continue;
        const binding = object(data.noticingApprovedTask) ? data.noticingApprovedTask : undefined;
        const parsed = packetSchema.safeParse(binding?.packet);
        if (sourceRow.role !== 'user' || sourceRow.type !== 'user_input_received' || data.source !== 'noticing_answer'
          || data.synthetic === true || !binding || !parsed.success || !identity(binding.requestId) || !hash(binding.digest)) {
          issue('noticing_accepted_packet_invalid'); continue;
        }
        const packet = parsed.data;
        let request: { session_id: string; run_id: string; input_hash: string; since_seq: number } | undefined;
        let first: { seq: number } | undefined;
        try {
          request = harness.prepare('SELECT session_id, run_id, input_hash, since_seq FROM harness_chat_requests WHERE request_id = ?')
            .get(binding.requestId) as typeof request;
          if (request) first = harness.prepare(`SELECT seq FROM events WHERE session_id = ? AND type = 'user_input_received'
            AND seq > ? ORDER BY seq LIMIT 1`).get(source.sessionId, request.since_seq) as typeof first;
        } catch { issue('noticing_acceptance_receipt_unavailable'); continue; }
        if (digest(packet) !== binding.digest || !request || request.input_hash !== binding.digest
          || request.session_id !== source.sessionId || request.run_id !== data.runId
          || !Number.isSafeInteger(request.since_seq) || request.since_seq < 0 || request.since_seq >= source.sourceUserSeq
          || first?.seq !== source.sourceUserSeq || packet.proposal.checkInId !== packet.checkIn.id
          || data.text !== packet.checkIn.answer || (data.displayText !== undefined && data.displayText !== packet.checkIn.answer)) {
          issue('noticing_acceptance_binding_invalid'); continue;
        }
        const answerDigest = digest({ proposalId: packet.proposal.id, checkInId: packet.checkIn.id,
          answer: packet.checkIn.answer, answeredAt: packet.checkIn.answeredAt });
        const answerOperation = { operation: 'noticing_answer' as const, operationId: packet.checkIn.id, revisionDigest: answerDigest };
        operations.set(tupleKey(answerOperation), answerOperation);
        state ??= readSnapshot(path.join(home, 'state', 'noticing.json'));
        if (!state || state.version !== 1 || !object(state.proposals) || !Array.isArray(state.thinking)) {
          issue('noticing_operation_state_unavailable'); continue;
        }
        const proposal = state.proposals[packet.proposal.id];
        if (!exactProposal(proposal, packet) || !object(proposal.answer) || !object(proposal.handoff)
          || proposal.answer.decision !== 'do_it' || proposal.answer.text !== packet.checkIn.answer
          || proposal.answer.at !== packet.checkIn.answeredAt || proposal.answer.instruction !== packet.decision.instruction
          || proposal.handoff.version !== 1 || proposal.handoff.answerDigest !== answerDigest
          || proposal.handoff.sessionId !== source.sessionId || proposal.handoff.sourceUserSeq !== source.sourceUserSeq
          || proposal.handoff.requestId !== binding.requestId) {
          issue('noticing_saved_answer_binding_unavailable'); continue;
        }
        if (!/^chk-[A-Za-z0-9_-]{1,80}$/.test(packet.checkIn.id)) { issue('noticing_check_in_identity_invalid'); continue; }
        const checkIn = readSnapshot(path.join(home, 'check-ins', `${packet.checkIn.id}.json`));
        if (!checkIn || checkIn.id !== packet.checkIn.id || checkIn.agentSlug !== 'clementine'
          || checkIn.status !== 'answered' || checkIn.contextSummary !== `noticing:${packet.proposal.id}`
          || checkIn.question !== packet.checkIn.question || checkIn.answer !== packet.checkIn.answer
          || checkIn.answeredAt !== packet.checkIn.answeredAt || packet.checkIn.contextSummary !== checkIn.contextSummary) {
          issue('noticing_check_in_binding_unavailable'); continue;
        }
        if (jobId(proposal.answer.modelAccountingJobId)) {
          claimed.add(proposal.answer.modelAccountingJobId);
          receipts.push({ tuple: answerOperation, usageJobId: proposal.answer.modelAccountingJobId, digest: digest(proposal.answer), parent });
        } else issue('noticing_answer_job_unknown');
        const thinking = state.thinking.filter(row => object(row) && row.proposalId === packet.proposal.id);
        if (thinking.length !== 1 || !object(thinking[0]) || !identity(thinking[0].tickId) || !jobId(thinking[0].modelAccountingJobId)) {
          issue('noticing_proposal_job_receipt_unavailable'); continue;
        }
        // The proposal evidence digest is not retained in the thinking row.
        // It is accepted only from one exact receipt-hash-matching journal tuple.
        claimed.add(thinking[0].modelAccountingJobId);
        receipts.push({ tuple: { operation: 'noticing_proposal', operationId: thinking[0].tickId, revisionDigest: '' },
          usageJobId: thinking[0].modelAccountingJobId, digest: digest(thinking[0]), parent });
      }
    })();
  } catch { receipts.length = 0; issue('noticing_source_read_unavailable'); }
  finally { harness.close(); }
  if (!operations.size && !receipts.length) return finish();
  let operational: Database.Database;
  try {
    operational = openReadOnly(path.join(home, 'state', 'operational-telemetry.db'));
  } catch { issue('noticing_accounting_store_unavailable'); return finish(); }
  try {
    operational.transaction(() => {
      const select = `SELECT actor, model_call_id, session_id, workflow_run_id, workflow_node_run_id, tool_call_id, payload_json
        FROM operational_events WHERE source = 'model' AND type = 'model_accounting_observed' AND json_valid(payload_json)`;
      const readEvents = (sql: string, ...values: unknown[]): JournalEvent[] => {
        const rows = operational.prepare(`${select} AND ${sql} LIMIT 20001`).all(...values) as JournalRow[];
        if (rows.length > 20_000) { issue('noticing_accounting_inventory_limit'); return []; }
        return rows.flatMap(row => { const payload = json(row.payload_json); return payload ? [{ row, payload }] : []; });
      };
      for (const operation of operations.values()) {
        for (const event of readEvents(`json_extract(payload_json, '$.operation') = ? AND json_extract(payload_json, '$.operationId') = ?
          AND json_extract(payload_json, '$.revisionDigest') = ?`, operation.operation, operation.operationId, operation.revisionDigest)) {
          const own = tuple(event.payload); if (own) claimed.add(own.usageJobId);
        }
      }
      for (const id of claimed) {
        const events = readEvents(`json_extract(payload_json, '$.usageJobId') = ?`, id);
        const candidates = receipts.filter(receipt => receipt.usageJobId === id);
        if (!candidates.length) { issue('noticing_unproved_job_claim'); continue; }
        const tuples = new Map(events.flatMap(event => { const own = tuple(event.payload); return own ? [[ownKey(own), own] as const] : []; }));
        if (tuples.size !== 1) { issue('noticing_job_tuple_ambiguous'); continue; }
        const own = [...tuples.values()][0]!;
        const proof = candidates.filter(receipt => receipt.tuple.operation === own.operation && receipt.tuple.operationId === own.operationId
          && (!receipt.tuple.revisionDigest || receipt.tuple.revisionDigest === own.revisionDigest));
        const allReceiptEvents = events.filter(event => event.payload.phase === 'operation_receipt');
        const receiptEvents = allReceiptEvents.filter(event => event.row.actor === 'noticing' && parentless(event)
          && event.row.model_call_id === null && event.payload.phase === 'operation_receipt' && tuple(event.payload)
          && eventTime(event) !== null && proof.some(receipt => event.payload.receiptDigest === receipt.digest));
        if (proof.length !== candidates.length || new Set(candidates.map(receipt => receipt.digest)).size !== 1
          || allReceiptEvents.length !== 1 || receiptEvents.length !== 1
          || events.some(event => !tuple(event.payload) || !parentless(event))) {
          issue('noticing_operation_receipt_unproved'); continue;
        }
        const allStarted = events.filter(event => event.payload.phase === 'job_started');
        const allFinished = events.filter(event => event.payload.phase === 'job_finished');
        const started = allStarted.filter(event => event.row.actor === 'noticing' && event.row.model_call_id === null);
        const finished = allFinished.filter(event => event.row.actor === 'noticing' && event.row.model_call_id === null
          && ['returned', 'failed'].includes(String(event.payload.outcome)) && event.payload.usage === 'unknown');
        const startedAt = allStarted.length === 1 && started.length === 1 ? eventTime(started[0]!) : null;
        const finishedAt = allFinished.length === 1 && finished.length === 1 ? eventTime(finished[0]!) : null;
        const lifecycleKnown = startedAt !== null && finishedAt !== null && finishedAt >= startedAt;
        if (!lifecycleKnown) issue('noticing_job_lifecycle_unknown');
        const bindings = new Map<string, { modelCallId: string; physicalAttempt: number; providerResponseIdDigest: string }>();
        for (const event of lifecycleKnown ? events : []) {
          const value = event.payload;
          if (event.row.actor !== 'model-transport-observation' || value.phase !== 'model_result_completed' || value.journalFailed !== false
            || value.resultScope !== 'original_sdk_response' || !identity(value.modelCallId)
            || event.row.model_call_id !== value.modelCallId || !seq(value.physicalAttempt) || !hash(value.providerResponseIdDigest)
            || !identity(value.hostResultReceiptId) || !Array.isArray(value.dispatchIds) || value.dispatchIds.length === 0
            || !value.dispatchIds.every(identity)) continue;
          const attemptEvents = events.filter(row => row.row.actor === 'model-transport-observation'
            && row.row.model_call_id === value.modelCallId && row.payload.modelCallId === value.modelCallId
            && row.payload.physicalAttempt === value.physicalAttempt);
          const created = attemptEvents.filter(row => row.payload.phase === 'adapter_attempt_created');
          const closed = attemptEvents.filter(row => row.payload.phase === 'adapter_attempt_finished');
          if (created.length !== 1 || created[0]?.payload.journalFailed !== false
            || attemptEvents.filter(row => row.payload.phase === 'model_result_completed').length !== 1
            || closed.length !== 1 || closed[0]?.payload.journalFailed !== false
            || closed[0]?.payload.resultScope !== 'original_sdk_response'
            || closed[0]?.payload.providerResponseIdDigest !== value.providerResponseIdDigest) {
            issue('noticing_original_response_binding_unproved'); continue;
          }
          const binding = { modelCallId: value.modelCallId, physicalAttempt: value.physicalAttempt,
            providerResponseIdDigest: value.providerResponseIdDigest };
          bindings.set(JSON.stringify(binding), binding);
        }
        if (!bindings.size) issue('noticing_original_response_unknown');
        result.jobs.push({ ...own, parentAcceptedSources: [...new Set(proof.map(receipt => receipt.parent))].sort(),
          responseBindings: [...bindings.values()].sort((a, b) => a.modelCallId.localeCompare(b.modelCallId) || a.physicalAttempt - b.physicalAttempt),
          startedAt, finishedAt: finishedAt !== null && startedAt !== null && finishedAt >= startedAt ? finishedAt : null });
      }
    })();
  } catch { result.jobs = []; issue('noticing_accounting_schema_unavailable'); }
  finally { operational.close(); }
  for (const [file, bytes] of snapshots) {
    try { if (readFileSync(file, 'utf8') === bytes) continue; } catch { /* Unknown after a cross-store race. */ }
    result.jobs = []; issue('noticing_retained_receipts_changed'); break;
  }
  if (issues.has('noticing_retained_receipts_changed')) result.jobs = [];
  return finish();
}

function exactProposal(value: unknown, packet: Packet): value is Row {
  if (!object(value)) return false;
  return digest({ id: value.id, checkInId: value.checkInId, title: value.title, action: value.action,
    why: value.why, evidence: value.evidence, goalId: value.goalId, createdAt: value.createdAt }) === digest(packet.proposal);
}
