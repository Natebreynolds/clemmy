import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { closedCanonicalJson } from '../../src/shared/closed-canonical-json.js';
import { exactOriginDeliveryTargetDigest, normalizeExactOriginDeliveryTarget, sameExactOriginDeliveryTarget } from '../../src/runtime/exact-origin-delivery.js';
import { readActiveWorkflowOriginGroupAtDirectory, type WorkflowOriginGroupProofOptions } from '../../src/execution/workflow-origin-group-proof.js';
import type { ActiveWorkflowOriginGroup } from '../../src/execution/workflow-origin-group.js';
import { readAcceptedTaskWorkflowCandidates } from './accepted-task-workflow-candidates.js';

type Row = Record<string, unknown>;
interface SourceRow { id: string; seq: number; session_id: string; turn: number; role: string; type: string;
  parent_event_id: string | null; data_json: string; created_at: string }
interface AttemptRow { attempt_id: string; session_id: string; run_id: string | null; source_user_seq: number | null }
interface ReceiptRow extends SourceRow {}
export interface AcceptedTaskWorkflowParticipant {
  sourceGroupId: string;
  sourceGroupDigest: string;
  runId: string;
  parentAcceptedSources: string[];
  stepId: string;
  sessionId: string;
  sourceUserSeq: number;
  attemptIds: string[];
  sourceReceiptDigest: string;
}
export interface AcceptedTaskWorkflowParticipants {
  participants: AcceptedTaskWorkflowParticipant[];
  claimedRunIds: string[];
  claimedSources: Array<{ sessionId: string; sourceUserSeq: number }>;
  claimedAttemptIds: string[];
  issues: string[];
}
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const safeRun = (value: unknown): value is string => bounded(value) && /^[A-Za-z0-9_.:-]+$/.test(value) && value !== '.' && value !== '..';
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const parse = (value: string): Row | null => {
  try { const parsed: unknown = JSON.parse(value); return object(parsed) ? parsed : null; } catch { return null; }
};
const digest = (value: unknown): string => createHash('sha256').update(closedCanonicalJson(value)).digest('hex');
const sourceKey = (sessionId: string, sourceUserSeq: number): string => JSON.stringify([sessionId, sourceUserSeq]);
// This historical wire digest is identical to eventlog-schema's v1 helper.
// Importing that migration graph is unnecessary for this read-only reader.
function sourceDigest(source: SourceRow): string {
  return createHash('sha256').update(JSON.stringify({ id: source.id, sessionId: source.session_id, seq: source.seq,
    turn: source.turn, role: source.role, type: source.type, parentEventId: source.parent_event_id,
    dataJson: source.data_json, createdAt: source.created_at })).digest('hex');
}
const receiptKeys = ['admissionHash', 'attemptId', 'attemptRunId', 'authorityDigest', 'catalogIdentities', 'definitionHash',
  'planProposalId', 'promptDigest', 'requiresApproval', 'sourceEventDigest', 'sourceEventId', 'sourceUserSeq', 'stepId',
  'stepSideEffect', 'version', 'workflowName', 'workflowRunId', 'workflowSlug'].sort().join('\0');
/** Serialized historical ACCOUNTING proof, not live mutation authority. The
 * current catalog/plan/permissions are deliberately never loaded or granted. */
function receipt(value: Row | null): Row | null {
  if (!value || Object.keys(value).sort().join('\0') !== receiptKeys || value.version !== 1
    || !positive(value.sourceUserSeq) || !['sourceEventId', 'attemptId', 'attemptRunId', 'workflowRunId', 'workflowSlug',
      'workflowName', 'stepId', 'planProposalId'].every(key => bounded(value[key]))
    || !['sourceEventDigest', 'definitionHash', 'admissionHash', 'promptDigest', 'authorityDigest'].every(key => hash(value[key]))
    || !['read', 'write', 'send'].includes(String(value.stepSideEffect)) || typeof value.requiresApproval !== 'boolean'
    || !Array.isArray(value.catalogIdentities) || value.catalogIdentities.length > 32) return null;
  const { authorityDigest, ...body } = value;
  return digest(body) === authorityDigest ? value : null;
}
function admittedStep(run: Row | null, own: Row): boolean {
  const snapshot = run?.workflowDefinitionSnapshot;
  if (!run || run.id !== own.workflowRunId || !object(snapshot) || !object(snapshot.definition)
    || !Array.isArray(snapshot.definition.steps) || snapshot.definition.name !== own.workflowName
    || snapshot.workflowSlug !== own.workflowSlug || !hash(snapshot.definitionHash) || !hash(snapshot.admissionHash)
    || snapshot.definitionHash !== own.definitionHash || snapshot.admissionHash !== own.admissionHash
    || typeof snapshot.admittedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.admittedAt))
    || (snapshot.codeRevision !== 'no-code' && !hash(snapshot.codeRevision))
    || digest(snapshot.definition) !== snapshot.definitionHash) return false;
  const admission = { version: snapshot.version, workflowSlug: snapshot.workflowSlug,
    definitionHash: snapshot.definitionHash, codeRevision: snapshot.codeRevision, admittedAt: snapshot.admittedAt };
  if (snapshot.version === 3) {
    if (snapshot.scope !== 'compiled' || snapshot.compilerId !== 'project_graph_v2' || !hash(snapshot.sourceTurnKeyHash)
      || snapshot.codeRevision !== 'no-code') return false;
    Object.assign(admission, { scope: snapshot.scope, compilerId: snapshot.compilerId, sourceTurnKeyHash: snapshot.sourceTurnKeyHash });
  } else if (snapshot.version !== 1) return false;
  if (digest(admission) !== snapshot.admissionHash) return false;
  const steps = snapshot.definition.steps.filter(step => object(step) && step.id === own.stepId);
  const step = steps.length === 1 ? steps[0] : null;
  return object(step) && typeof step.prompt === 'string' && digest(step.prompt) === own.promptDigest
    && own.requiresApproval === (step.requiresApproval === true)
    && (step.sideEffect === undefined || step.sideEffect === own.stepSideEffect);
}
function openReadOnly(file: string): Database.Database {
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try { db.pragma('query_only = ON'); return db; } catch (error) { db.close(); throw error; }
}

/** Full group proof + an exact authored hosted-step receipt establish only
 * recorded usage parentage. No completion, absence, billing, live account or
 * execution authority is inferred. Run-level namespace rows remain unproved. */
export function readAcceptedTaskWorkflowParticipants(home: string,
  acceptedSources: readonly { sessionId: string; sourceUserSeq: number }[],
  options: WorkflowOriginGroupProofOptions,
): AcceptedTaskWorkflowParticipants {
  const result: AcceptedTaskWorkflowParticipants = { participants: [], claimedRunIds: [], claimedSources: [], claimedAttemptIds: [], issues: [] };
  const issues = new Set<string>(); const runClaims = new Set<string>(); const attemptClaims = new Set<string>();
  const sourceClaims = new Map<string, { sessionId: string; sourceUserSeq: number }>();
  const finish = (): AcceptedTaskWorkflowParticipants => {
    result.claimedRunIds = [...runClaims].sort(); result.claimedAttemptIds = [...attemptClaims].sort();
    result.claimedSources = [...sourceClaims.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.sourceUserSeq - b.sourceUserSeq);
    result.participants.sort((a, b) => a.sourceGroupId.localeCompare(b.sourceGroupId) || a.sessionId.localeCompare(b.sessionId) || a.sourceUserSeq - b.sourceUserSeq);
    result.issues = [...issues].sort(); return result;
  };
  if (!path.isAbsolute(home)) { issues.add('workflow_participant_explicit_home_invalid'); return finish(); }
  const inventory = readAcceptedTaskWorkflowCandidates(home, acceptedSources);
  for (const issue of inventory.issues) if (issue !== 'workflow_candidate_authority_and_usage_unproved') issues.add(issue);
  for (const candidate of inventory.candidates) for (const runId of candidate.runIds) runClaims.add(runId);
  if (!inventory.candidates.length) return finish();
  if (runClaims.size > 128) { issues.add('workflow_participant_run_inventory_limit'); return finish(); }
  if (!options || typeof options.isWorkflowParentTerminalIdentity !== 'function') {
    issues.add('workflow_participant_parent_proof_unavailable'); return finish();
  }
  const runsDir = path.join(home, 'workflows', 'runs');
  const groups = new Map<string, ActiveWorkflowOriginGroup | null>();
  const runGroups = new Map<string, Array<{ group: ActiveWorkflowOriginGroup; parent: string }>>();
  const snapshots = new Map<string, string>();
  const readRun = (runId: string): Row | null => {
    if (!safeRun(runId)) return null;
    const file = path.join(runsDir, `${runId}.json`);
    if (snapshots.has(file)) return parse(snapshots.get(file)!);
    try {
      const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const bytes = readFileSync(file, 'utf8'); snapshots.set(file, bytes); return parse(bytes);
    } catch { return null; }
  };
  let db: Database.Database;
  try { db = openReadOnly(path.join(home, 'state', 'harness.db')); }
  catch { issues.add('workflow_participant_source_store_unavailable'); return finish(); }
  try {
    db.transaction(() => {
      for (const candidate of inventory.candidates) {
        if (!candidate.sourceGroupId) { issues.add('workflow_participant_group_unknown'); continue; }
        let group: ActiveWorkflowOriginGroup | null;
        try {
          if (!groups.has(candidate.sourceGroupId)) groups.set(candidate.sourceGroupId,
            readActiveWorkflowOriginGroupAtDirectory(runsDir, candidate.sourceGroupId, options));
          group = groups.get(candidate.sourceGroupId)!;
        } catch { groups.set(candidate.sourceGroupId, null); group = null; }
        if (!group) { issues.add('workflow_participant_group_unproved'); continue; }
        const dispatch = db.prepare('SELECT * FROM events WHERE seq = ?').get(candidate.dispatchSeq) as SourceRow | undefined;
        const data = dispatch && parse(dispatch.data_json);
        const source = db.prepare('SELECT * FROM events WHERE session_id = ? AND seq = ?').get(
          group.sealed.originSessionId, group.sealed.sourceUserSeq) as SourceRow | undefined;
        const sourceData = source && parse(source.data_json);
        const sourceTarget = normalizeExactOriginDeliveryTarget(sourceData?.originReplyTarget);
        const dispatchTarget = normalizeExactOriginDeliveryTarget(data?.replyTarget);
        if (!source || source.role !== 'user' || source.type !== 'user_input_received' || !data || !dispatch
          || !sourceData || sourceData.synthetic === true || !sourceTarget || !dispatchTarget
          || sourceData.originReplyTargetDigest !== exactOriginDeliveryTargetDigest(sourceTarget)
          || !sameExactOriginDeliveryTarget(sourceTarget, group.sealed.replyTarget)
          || !sameExactOriginDeliveryTarget(dispatchTarget, group.sealed.replyTarget)
          || exactOriginDeliveryTargetDigest(sourceTarget) !== group.sealed.replyTargetDigest
          || dispatch.session_id !== source.session_id
          || dispatch.role !== 'system' || dispatch.type !== 'async_work_dispatched' || dispatch.turn !== source.turn
          || dispatch.parent_event_id !== source.id || dispatch.seq <= source.seq
          || candidate.parentAcceptedSource !== `${source.session_id}:${source.seq}`
          || Object.entries(group.publicDispatch).some(([key, value]) => JSON.stringify(data[key]) !== JSON.stringify(value))
          || JSON.stringify(candidate.runIds) !== JSON.stringify(group.activation.memberRunIds)) {
          issues.add('workflow_participant_dispatch_binding_unproved'); continue;
        }
        for (const member of group.sealed.members) {
          const descriptor = readRun(member.runId);
          if (!descriptor || descriptor.id !== member.runId || descriptor.chatDispatchSourceGroupId !== group.sealed.sourceGroupId
            || descriptor.chatDispatchQueueRequestDigest !== member.queueRequestDigest) {
            issues.add('workflow_participant_run_creation_binding_unproved'); continue;
          }
          const entry = { group, parent: candidate.parentAcceptedSource };
          const previous = runGroups.get(member.runId) ?? [];
          if (!previous.some(row => row.group.sealed.sourceGroupId === group!.sealed.sourceGroupId && row.parent === entry.parent))
            runGroups.set(member.runId, [...previous, entry]);
        }
      }
      const runIds = JSON.stringify([...runClaims]);
      // Explicit source/metadata claims only. A workflow: prefix or a title is
      // not used to discover, prove or silently attach a hosted source.
      const rows = db.prepare(`SELECT e.* FROM events e WHERE e.type = 'user_input_received' AND e.role = 'user'
        AND (CASE WHEN json_valid(e.data_json) THEN json_extract(e.data_json, '$.workflowRunId') IN (SELECT value FROM json_each(?)) ELSE 0 END
          OR e.session_id IN (SELECT id FROM sessions WHERE CASE WHEN json_valid(metadata_json)
            THEN json_extract(metadata_json, '$.workflowRunId') IN (SELECT value FROM json_each(?)) ELSE 0 END))
        ORDER BY e.seq LIMIT 2049`).all(runIds, runIds) as SourceRow[];
      if (rows.length > 2048) { issues.add('workflow_participant_source_inventory_limit'); return; }
      for (const source of rows) {
        if (!bounded(source.session_id) || !positive(source.seq)) { issues.add('workflow_participant_source_identity_invalid'); continue; }
        const key = sourceKey(source.session_id, source.seq);
        sourceClaims.set(key, { sessionId: source.session_id, sourceUserSeq: source.seq });
        const attempts = db.prepare(`SELECT attempt_id, session_id, run_id, source_user_seq FROM run_attempts
          WHERE session_id = ? AND source_user_seq = ? LIMIT 4097`).all(source.session_id, source.seq) as AttemptRow[];
        if (attempts.length > 4096) { issues.add('workflow_participant_attempt_inventory_limit'); continue; }
        for (const attempt of attempts) if (bounded(attempt.attempt_id)) {
          attemptClaims.add(attempt.attempt_id);
          if (attemptClaims.size > 4096) { issues.add('workflow_participant_attempt_inventory_limit'); return; }
        }
        const data = parse(source.data_json);
        // Approval controls are inventory here. The canonical caller owns the
        // full card/resume/ancestry proof; they are not new authored roots.
        if (data && data.workflowRunId === undefined && bounded(data.approvalId)
          && ['approve', 'approve_with_edits', 'reject'].includes(String(data.decision))) continue;
        if (!data || data.synthetic === true || !safeRun(data.workflowRunId) || !bounded(data.stepId) || !bounded(data.attemptId)
          || !runGroups.has(data.workflowRunId)) { issues.add('workflow_participant_hosted_source_unproved'); continue; }
        const scope = db.prepare('SELECT kind, channel, metadata_json FROM sessions WHERE id = ?').get(source.session_id) as
          { kind: string; channel: string; metadata_json: string } | undefined;
        const metadata = scope && parse(scope.metadata_json);
        const exactSourceDigest = sourceDigest(source);
        const expectedReceiptId = `authored-workflow-write:v1:${digest({ version: 1, sessionId: source.session_id,
          sourceUserSeq: source.seq, sourceEventDigest: exactSourceDigest })}`;
        const retained = db.prepare(`SELECT * FROM events WHERE session_id = ? AND type = 'authored_workflow_write_authority'
          AND (id = ? OR parent_event_id = ?) ORDER BY seq LIMIT 2`).all(source.session_id, expectedReceiptId, source.id) as ReceiptRow[];
        const event = retained.length === 1 ? retained[0] : undefined;
        let own: Row | null = null;
        try { own = event ? receipt(parse(event.data_json)) : null; } catch { /* Malformed closed JSON is not historical proof. */ }
        const attempt = own && attempts.find(row => row.attempt_id === own.attemptId);
        if (!event || !own || event.id !== expectedReceiptId || event.role !== 'system' || event.turn !== source.turn
          || event.parent_event_id !== source.id || event.seq <= source.seq || own.sourceUserSeq !== source.seq
          || own.sourceEventId !== source.id || own.sourceEventDigest !== exactSourceDigest
          || own.workflowRunId !== data.workflowRunId || own.stepId !== data.stepId || own.attemptId !== data.attemptId
          || own.workflowName !== data.workflowName || !attempt || attempt.session_id !== source.session_id
          || attempt.source_user_seq !== source.seq || attempt.run_id !== own.attemptRunId
          || (attempt.run_id !== `workflow-step:${own.workflowRunId}:${own.stepId}`
            && !attempt.run_id?.startsWith(`workflow-step:${own.workflowRunId}:${own.stepId}:`))
          || !metadata || scope?.kind !== 'workflow' || scope.channel !== 'workflow' || metadata.source !== 'workflow'
          || metadata.workflowRunId !== own.workflowRunId || metadata.stepId !== own.stepId || metadata.workflowName !== own.workflowName
          || !admittedStep(readRun(data.workflowRunId), own)) {
          issues.add('workflow_participant_authored_receipt_unproved'); continue;
        }
        // Restart attempts can own the same immutable hosted source. Keep the
        // exact durable run correlation; a foreign run cannot borrow it.
        const ownedAttempts = attempts.filter(row => row.session_id === source.session_id
          && row.source_user_seq === source.seq && row.run_id === own!.attemptRunId && bounded(row.attempt_id));
        if (ownedAttempts.length !== attempts.length) issues.add('workflow_participant_foreign_attempt_claim');
        for (const { group, parent } of runGroups.get(data.workflowRunId)!) result.participants.push({
          sourceGroupId: group.sealed.sourceGroupId, sourceGroupDigest: group.sealed.sourceGroupDigest,
          runId: data.workflowRunId, parentAcceptedSources: [parent], stepId: data.stepId,
          sessionId: source.session_id, sourceUserSeq: source.seq, attemptIds: [...new Set(ownedAttempts.map(row => row.attempt_id))].sort(),
          sourceReceiptDigest: own.authorityDigest as string,
        });
      }
    })();
  } catch { result.participants = []; issues.add('workflow_participant_source_schema_unavailable'); }
  finally { db.close(); }
  if (runClaims.size && !result.participants.length) issues.add('workflow_participant_exact_sources_unavailable');
  for (const [file, bytes] of snapshots) {
    try { if (readFileSync(file, 'utf8') === bytes) continue; } catch { /* A reaped/changed descriptor stays unknown. */ }
    result.participants = []; issues.add('workflow_participant_run_descriptors_changed'); break;
  }
  for (const [id, group] of groups) {
    if (!group) continue;
    try {
      if (closedCanonicalJson(readActiveWorkflowOriginGroupAtDirectory(runsDir, id, options)) === closedCanonicalJson(group)) continue;
    } catch { /* Do not publish a positive graph across a group mutation. */ }
    result.participants = result.participants.filter(row => row.sourceGroupId !== id);
    issues.add('workflow_participant_group_changed');
  }
  return finish();
}
