/** Canonical observational installation inventory. All application reads are
 * supplied explicitly; importing this module initializes no application stores.
 * This reader never grants execution, replay, cancellation or repair authority. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { HostInterruptState, HostRecoveryState } from '../runtime/harness/host-checkpoint-state.js';
import { hostApprovalCheckpointSource, sourceApprovalSnapshotFromMetadata } from '../runtime/harness/source-approval-checkpoint-data.js';

/** Callbacks must observe the same selected paths and read snapshot. Their
 * canonical runtime implementations remain in the public application adapter. */
export interface InstallQuiescenceReader {
  BASE_DIR: string;
  WORKFLOW_RUNS_DIR: string;
  database: () => Database.Database;
  /** The worker applies the same read-only open with bounded row decoding. */
  openCodingDatabase?: (file: string) => Database.Database;
  /** Reuse bounded machine-id bytes captured in the same observer generation. */
  readCodingMachineId?: () => string;
  /** Allows one already-fenced, bounded directory snapshot in the observer. */
  listDirectoryFiles?: (directory: string) => string[];
  getUserInputEventAtSequence: typeof import('../runtime/harness/eventlog.js').getUserInputEventAtSequence;
  getBackgroundTask: typeof import('../execution/background-tasks.js').getBackgroundTask;
  readWorkflowRunInventoryFile: typeof import('../execution/workflow-run-inventory.js').readWorkflowRunInventoryFile;
  auditAcceptedSourceSettlementTruth: typeof import('../runtime/harness/accepted-source-settlement-audit.js').auditAcceptedSourceSettlementTruth;
  readRecoveryActivation: typeof import('../runtime/harness/recovery-activation.js').readRecoveryActivation;
  presentationEventFromCompletionData: typeof import('../runtime/harness/turn-outcome.js').presentationEventFromCompletionData;
  getApproval: typeof import('../runtime/harness/approval-registry.js').get;
  isTerminalWorkflowRunStatus: typeof import('../execution/workflow-run-cancellation.js').isTerminalWorkflowRunStatus;
}

export interface InstallWorkOwner {
  key: string;
  kind: 'execution' | 'workflow' | 'background' | 'coding' | 'approval' | 'checkpoint' | 'effect' | 'projection';
  state: 'running' | 'queued' | 'waiting' | 'unfinished' | 'uncertain';
  sessionIds: string[];
  approvalIds: string[];
}
export interface InstallQuiescenceSnapshot {
  /** Compatibility with the shipped native updater. An unknown snapshot warns. */
  total: number;
  summary: string;
  currentWork: { total: number; items: InstallWorkOwner[] };
  quiescence: {
    state: 'quiescent' | 'work_pending' | 'unverified';
    observedAt: string;
    issues: string[];
  };
}

const LIMIT = 2_000;
const WORKFLOW_PENDING = new Set(['pending', 'queued', 'running', 'parked', 'paused', 'awaiting_input',
  'awaiting_approval', 'interrupted', 'resuming', 'blocked_readiness', 'awaiting_catchup_decision', 'blocked_mutation']);
const BACKGROUND_TERMINAL = new Set(['done', 'failed', 'aborted', 'blocked']);
const BACKGROUND_PENDING = new Set(['pending', 'running', 'cancelling', 'awaiting_approval', 'awaiting_input', 'awaiting_continue', 'interrupted']);
const OWNER_KEYS = ['__host_recovery_state', '__interrupt_state', '__source_approval_checkpoints', '__continuation_owner', '__host_recovery_owner', '__run_in_flight_owner', '__run_in_flight'];
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
function decoded(value: unknown): Record<string, unknown> | null {
  try { return object(typeof value === 'string' ? JSON.parse(value) : value); } catch { return null; }
}

export function unverifiedInstallQuiescence(issue: string, prior?: InstallQuiescenceSnapshot): InstallQuiescenceSnapshot {
  const items = prior?.currentWork.items ?? [];
  const issues = [...new Set([...(prior?.quiescence.issues ?? []), issue])];
  return {
    total: Math.max(1, items.length),
    summary: `${items.length ? `${items.length} unfinished work item${items.length === 1 ? '' : 's'}; ` : ''}other work could not be fully verified`,
    currentWork: { total: items.length, items },
    quiescence: { state: 'unverified', observedAt: prior?.quiescence.observedAt ?? new Date().toISOString(), issues },
  };
}

export function readInstallQuiescenceRead(options: { nowMs?: number; maxEntries?: number }, reader: InstallQuiescenceReader): InstallQuiescenceSnapshot {
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(new Date(nowMs).getTime())) return unverifiedInstallQuiescence('clock_unavailable');
  const observedAt = new Date(nowMs).toISOString();
  const limit = Math.max(1, Math.min(LIMIT, Math.trunc(options.maxEntries ?? LIMIT)));
  if (!Number.isFinite(limit)) return unverifiedInstallQuiescence('inventory_bound_invalid');
  const issues = new Set<string>();
  const owners = new Map<string, InstallWorkOwner>();
  const sessionOwners = new Map<string, string>();
  const workflowOwners = new Set<string>();
  const add = (key: string, kind: InstallWorkOwner['kind'], state: InstallWorkOwner['state'], sessionId?: string, approvalId?: string) => {
    const owner = owners.get(key) ?? { key, kind, state, sessionIds: [], approvalIds: [] };
    if (state === 'uncertain' || (owner.state !== 'uncertain' && state === 'running')) owner.state = state;
    if (sessionId && !owner.sessionIds.includes(sessionId)) owner.sessionIds.push(sessionId);
    if (approvalId && !owner.approvalIds.includes(approvalId)) owner.approvalIds.push(approvalId);
    owners.set(key, owner);
  };
  const workKey = (sessionId: string, source: unknown, fallback: string) => sessionOwners.get(sessionId)
    ?? (Number.isSafeInteger(source) && Number(source) > 0 ? `source:${sessionId}#${source}` : fallback);
  const bounded = <T>(rows: T[], category: string): T[] => {
    if (rows.length > limit) issues.add(`${category}_inventory_partial`);
    return rows.slice(0, limit);
  };
  const files = (directory: string, category: string): string[] => {
    try { return bounded((reader.listDirectoryFiles ? reader.listDirectoryFiles(directory) : readdirSync(directory))
      .filter(file => file.endsWith('.json')).sort(), category); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.add(`${category}_inventory_unreadable`);
      return [];
    }
  };

  // The canonical cache verifies each selected file generation. Unlike its
  // best-effort history list, a failed/empty record cannot silently mean idle.
  for (const file of files(reader.WORKFLOW_RUNS_DIR, 'workflow')) {
    const selected = reader.readWorkflowRunInventoryFile(file);
    if (selected.kind !== 'record') { issues.add('workflow_record_unreadable'); continue; }
    const record = selected.entry.record;
    if (!text(record.id) || `${record.id}.json` !== file || !text(record.status) || !text(record.workflow)) {
      issues.add('workflow_record_invalid'); continue;
    }
    if (reader.isTerminalWorkflowRunStatus(record.status)
      && (!['dry_run', 'creation_test'].includes(record.status) || text(record.finishedAt))) continue;
    if (!WORKFLOW_PENDING.has(record.status)) { issues.add('workflow_status_unknown'); continue; }
    const key = `workflow:${record.id}`;
    workflowOwners.add(record.id);
    add(key, 'workflow', record.status === 'running' ? 'running' : record.status === 'queued' ? 'queued' : 'waiting');
  }
  for (const file of files(path.join(reader.BASE_DIR, 'state', 'background-tasks'), 'background')) {
    const id = file.slice(0, -5);
    if (!/^[A-Za-z0-9._:-]+$/.test(id)) { issues.add('background_record_invalid'); continue; }
    const task = reader.getBackgroundTask(id);
    if (!task || task.id !== id || !text(task.status)) {
      issues.add('background_record_unreadable'); continue;
    }
    if (task.archived !== undefined && typeof task.archived !== 'boolean') { issues.add('background_record_invalid'); continue; }
    if (task.archived === true || BACKGROUND_TERMINAL.has(task.status)) continue;
    if (!BACKGROUND_PENDING.has(task.status)) { issues.add('background_status_unknown'); continue; }
    if (!text(task.runSessionId)) { issues.add('background_owner_unverified'); continue; }
    const key = `background:${task.id}`;
    sessionOwners.set(task.runSessionId, key);
    add(key, 'background', task.status === 'running' || task.status === 'cancelling' ? 'running'
      : task.status === 'pending' ? 'queued' : 'waiting', task.runSessionId, task.pendingApprovalId);
  }

  // Coding agents can outlive their chat/harness process. Read the existing
  // machine-scoped coding-run store in place; its regular API initializes the
  // schema and machine id, so it is intentionally not used for this probe.
  const codingBase = path.join(reader.BASE_DIR, 'state', 'coding-runs');
  let coding: Database.Database | undefined;
  try {
    statSync(codingBase);
    const machineId = (reader.readCodingMachineId ? reader.readCodingMachineId()
      : readFileSync(path.join(reader.BASE_DIR, 'state', 'machine-id'), 'utf8')).trim();
    if (!/^[A-Za-z0-9._-]+$/.test(machineId) || machineId === '.' || machineId === '..') {
      issues.add('coding_machine_identity_unverified');
    } else {
      const file = path.join(codingBase, machineId, 'coding-runs.db');
      let present = true;
      try { statSync(file); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') present = false; else throw error;
      }
      if (present) {
        coding = reader.openCodingDatabase ? reader.openCodingDatabase(file)
          : new Database(file, { readonly: true, fileMustExist: true });
        coding.pragma('query_only = ON');
        const runs = bounded(coding.prepare(`SELECT run_id, session_id, state, lease_owner, lease_expires_at_ms
          FROM coding_runs WHERE state IS NULL OR state != 'settled' LIMIT ?`).all(limit + 1) as Array<{
            run_id: string; session_id: string; state: string; lease_owner: string | null; lease_expires_at_ms: number | null;
          }>, 'coding');
        for (const run of runs) {
          if (!text(run.run_id) || !text(run.session_id)
            || !['admitted', 'running', 'detached', 'resuming', 'settling'].includes(run.state)) {
            issues.add('coding_owner_unverified'); continue;
          }
          const key = sessionOwners.get(run.session_id) ?? `coding:${run.run_id}`;
          sessionOwners.set(run.session_id, key);
          add(key, 'coding', run.lease_owner && Number.isFinite(run.lease_expires_at_ms)
            && Number(run.lease_expires_at_ms) > nowMs ? 'running' : 'unfinished', run.session_id);
        }
      }
    }
  } catch (error) {
    // No coding directory is a normal uninitialized feature. Once that store
    // exists, an unreadable/missing machine id is unknown, never proof of idle.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
      || (() => { try { statSync(codingBase); return true; } catch { return false; } })()) {
      issues.add('coding_inventory_unreadable');
    }
  } finally {
    try { coding?.close(); } catch { issues.add('coding_inventory_unreadable'); }
  }

  try {
    const db = reader.database();
    const rows = <T>(sql: string, category: string, ...params: unknown[]): T[] =>
      bounded(db.prepare(sql).all(...params, limit + 1) as T[], category);
    // Optional display work owns no business effect, but a live/uncertain
    // paid request must remain visible to cutover. Queued wording can wait.
    const projections = rows<{ projection_id: string; session_id: string; status: string; claim_id: string | null;
      started_at: string | null; finished_at: string | null }>(`SELECT projection_id,session_id,status,claim_id,started_at,finished_at
      FROM approved_action_result_projection_jobs_v1 WHERE status='started'
        OR (status='unknown' AND transport_closed_at IS NULL) LIMIT ?`, 'projection');
    for (const job of projections) {
      if (!text(job.projection_id) || !text(job.session_id) || !text(job.claim_id) || !text(job.started_at)
        || !Number.isFinite(Date.parse(job.started_at))) issues.add('projection_owner_unverified');
      if (job.status === 'unknown') issues.add('projection_transport_unverified');
      add(`projection:${job.projection_id}`, 'projection', job.status === 'started' ? 'running' : 'uncertain', job.session_id);
    }
    type Session = { id: string; metadata_json: string };
    const exactTerminal = (sessionId: string, sourceSeq: unknown, notBefore?: string): 'absent' | 'terminal' | 'retained' | 'unverified' => {
      if (!Number.isSafeInteger(sourceSeq) || Number(sourceSeq) <= 0) return 'unverified';
      const source = reader.getUserInputEventAtSequence(sessionId, Number(sourceSeq));
      if (!source || source.role !== 'user') return 'unverified';
      const terminal = db.prepare(`SELECT session_id, turn, created_at, data_json FROM events
        WHERE session_id = ? AND type = 'conversation_completed' AND
          (json_extract(data_json, '$.sourceUserSeq') = ? OR json_extract(data_json, '$.terminalKey') = ?
            OR json_extract(data_json, '$.presentation.identity.sourceUserSeq') = ?)
        ORDER BY seq DESC LIMIT 1`).get(sessionId, sourceSeq, `turn:${sourceSeq}`, sourceSeq) as
        { session_id: string; turn: number; created_at: string; data_json: string } | undefined;
      if (!terminal) return 'absent';
      try {
        const presentation = reader.presentationEventFromCompletionData(JSON.parse(terminal.data_json));
        if (!presentation || terminal.session_id !== source.sessionId || terminal.turn !== source.turn
          || presentation.identity.sessionId !== sessionId || presentation.identity.turn !== source.turn
          || presentation.identity.sourceUserSeq !== sourceSeq) return 'unverified';
        if (notBefore !== undefined && (!Number.isFinite(Date.parse(notBefore))
          || !Number.isFinite(Date.parse(terminal.created_at))
          || Date.parse(terminal.created_at) < Date.parse(notBefore))) return 'unverified';
        return presentation.resumable ? 'retained' : 'terminal';
      } catch { return 'unverified'; }
    };
    // Only explicit parent links/owner metadata are selected. active/paused
    // by itself is session history and contributes nothing to this snapshot.
    const workflowIds = [...workflowOwners];
    const workflowLink = workflowIds.length ? `json_extract(metadata_json, '$.workflowRunId') IN (${workflowIds.map(() => '?').join(',')})` : '0';
    const sessions = rows<Session>(`SELECT id, metadata_json FROM sessions WHERE
      CASE WHEN metadata_json IS NULL OR metadata_json = '' THEN 0 WHEN json_valid(metadata_json) THEN (
        json_type(metadata_json) != 'object' OR ${workflowLink} OR
        ${OWNER_KEYS.map(key => `json_type(metadata_json, '$.${key}') IS NOT NULL`).join(' OR ')}
      ) ELSE 1 END LIMIT ?`, 'session_owner', ...workflowIds);
    for (const session of sessions) {
      const metadata = decoded(session.metadata_json);
      if (!metadata) { issues.add('session_owner_metadata_unreadable'); continue; }
      if (text(metadata.workflowRunId) && workflowOwners.has(metadata.workflowRunId)) {
        const key = `workflow:${metadata.workflowRunId}`;
        sessionOwners.set(session.id, key);
        add(key, 'workflow', 'waiting', session.id);
      }
    }
    type Attempt = { session_id: string; attempt_id: string; source_user_seq: number | null;
      status: string; lease_owner: string | null; lease_expires_at: string | null };
    const attempts = rows<Attempt>(`SELECT session_id, attempt_id, source_user_seq, status, lease_owner, lease_expires_at
      FROM run_attempts WHERE finished_at IS NULL LIMIT ?`, 'attempt');
    for (const attempt of attempts) {
      const live = attempt.status === 'active' && Boolean(attempt.lease_owner)
        && Number.isFinite(Date.parse(attempt.lease_expires_at ?? '')) && Date.parse(attempt.lease_expires_at!) > nowMs;
      add(workKey(attempt.session_id, attempt.source_user_seq, `attempt:${attempt.attempt_id}`),
        'execution', live ? 'running' : 'unfinished', attempt.session_id);
    }
    // A lease matching a finished attempt is stale history, not current work.
    const leases = rows<{ session_id: string; lease_id: string; attempt_id: string | null;
      source_user_seq: number | null; attempt_source_user_seq: number | null; activated_at: string }>(
      `SELECT lease.session_id, lease.lease_id, attempt.attempt_id, lease.source_user_seq,
        attempt.source_user_seq AS attempt_source_user_seq, lease.activated_at
      FROM run_dispatch_leases lease LEFT JOIN run_attempts attempt
        ON attempt.attempt_id = lease.run_attempt_id AND attempt.session_id = lease.session_id
      WHERE lease.revoked_at IS NULL AND (attempt.attempt_id IS NULL OR attempt.finished_at IS NULL) LIMIT ?`, 'dispatch_lease');
    for (const lease of leases) {
      if (!lease.attempt_id && exactTerminal(lease.session_id, lease.source_user_seq, lease.activated_at) === 'terminal') continue;
      add(workKey(lease.session_id, lease.attempt_source_user_seq ?? lease.source_user_seq,
        lease.attempt_id ? `attempt:${lease.attempt_id}` : `lease:${lease.lease_id}`), 'execution', 'unfinished', lease.session_id);
      if (!lease.attempt_id) issues.add('dispatch_lease_owner_unverified');
    }
    if (db.prepare('SELECT 1 FROM graph_node_leases WHERE released = 0 AND expires_at > ? LIMIT 1').get(nowMs)) {
      // This opaque lease family has no session column. Its presence is real,
      // but it cannot be safely assigned/deduplicated by guessing its key.
      issues.add('graph_execution_owner_unverified');
    }
    const approvals = rows<{ approval_id: string; session_id: string; args_json: string | null; presentation_json: string | null }>(
      `SELECT approval_id, session_id, args_json, presentation_json FROM pending_approvals WHERE status = 'pending' LIMIT ?`, 'approval');
    for (const approval of approvals) {
      if (approval.args_json !== null && !decoded(approval.args_json)) issues.add('approval_payload_unreadable');
      // Expiry is not permission to erase a parked dependency; its reaper owns
      // that transition. Report the exact durable waiting owner conservatively.
      const presentation = approval.presentation_json !== null ? reader.getApproval(approval.approval_id)?.presentation : null;
      if (approval.presentation_json !== null && !presentation) issues.add('approval_presentation_unreadable');
      add(workKey(approval.session_id, presentation?.sourceUserSeq, `approval:${approval.approval_id}`),
        'approval', 'waiting', approval.session_id, approval.approval_id);
    }
    for (const session of sessions) {
      const metadata = decoded(session.metadata_json);
      if (!metadata) continue;
      const hasCheckpoint = OWNER_KEYS.some(key => metadata[key] !== undefined && metadata[key] !== null);
      if (!hasCheckpoint) continue;
      try {
        const noteSource = (source: unknown, allowCheckpoint: boolean) => {
          const terminal = exactTerminal(session.id, source);
          if (terminal === 'terminal') return;
          if (terminal === 'unverified' || !allowCheckpoint) { issues.add('checkpoint_owner_unverified'); return; }
          add(workKey(session.id, source, `checkpoint:${session.id}`), 'checkpoint', 'waiting', session.id);
        };
        const interrupt = (blob: unknown, expectedSource?: number) => {
          if (typeof blob !== 'string' || !HostInterruptState.isHostState(blob)) throw new Error('Unknown checkpoint type');
          const state = HostInterruptState.fromString(blob);
          const source = hostApprovalCheckpointSource(blob, session.id);
          if (!source || (expectedSource !== undefined && source !== expectedSource)
            || state.pending.length === 0) throw new Error('Unbound checkpoint');
          noteSource(source, true);
        };
        if (metadata.__host_recovery_state != null) {
          const blob = metadata.__host_recovery_state;
          if (typeof blob !== 'string' || !HostRecoveryState.isHostState(blob)) throw new Error('Unknown recovery type');
          const state = HostRecoveryState.fromString(blob);
          if (state.sessionId !== session.id) throw new Error('Foreign recovery');
          const activation = reader.readRecoveryActivation(session.id);
          const owner = activation ?? decoded(metadata.__host_recovery_owner) ?? decoded(metadata.__continuation_owner);
          const ownerSource = owner?.sourceUserSeq;
          const requestSource = activation?.approvalContinuation?.requestSourceUserSeq
            ?? activation?.connectionContinuation?.requestSourceUserSeq ?? ownerSource;
          if (!owner || requestSource !== state.sourceUserSeq) throw new Error('Unbound recovery');
          if (owner.attemptId != null && (!text(owner.attemptId) || !db.prepare(`SELECT 1 FROM run_attempts
            WHERE attempt_id = ? AND session_id = ? AND source_user_seq = ?`).get(owner.attemptId, session.id, ownerSource))) {
            throw new Error('Foreign recovery attempt');
          }
          noteSource(ownerSource, true);
        }
        if (metadata.__interrupt_state != null) interrupt(metadata.__interrupt_state);
        if (metadata.__source_approval_checkpoints != null) {
          const checkpoints = object(metadata.__source_approval_checkpoints);
          if (!checkpoints) throw new Error('Unknown checkpoint index');
          for (const key of bounded(Object.keys(checkpoints), 'checkpoint')) {
            const source = Number(key);
            const entry = object(checkpoints[key]);
            if (!/^[1-9][0-9]*$/.test(key) || !Number.isSafeInteger(source) || String(source) !== key
              || !entry || !text(entry.revision) || !Object.hasOwn(entry, 'checkpoint')
              || Object.keys(entry).some(field => field !== 'revision' && field !== 'checkpoint')
              || (entry.checkpoint !== null && (!object(entry.checkpoint)
                || !text(object(entry.checkpoint)?.serialized)))) throw new Error('Malformed indexed checkpoint');
            const snapshot = sourceApprovalSnapshotFromMetadata(metadata, source);
            if (snapshot.checkpoint) interrupt(snapshot.checkpoint.serialized, source);
          }
        }
        if (metadata.__host_recovery_state == null && metadata.__interrupt_state == null) {
          const owner = decoded(metadata.__continuation_owner) ?? decoded(metadata.__host_recovery_owner)
            ?? decoded(metadata.__run_in_flight_owner);
          if (owner) {
            const exactAttempt = text(owner.attemptId) && db.prepare(`SELECT 1 FROM run_attempts
              WHERE attempt_id = ? AND session_id = ? AND source_user_seq = ? AND finished_at IS NULL`)
              .get(owner.attemptId, session.id, owner.sourceUserSeq);
            noteSource(owner.sourceUserSeq, Boolean(exactAttempt));
          } else if ((metadata.__run_in_flight != null && metadata.__run_in_flight !== false)
            || ['__continuation_owner', '__host_recovery_owner', '__run_in_flight_owner']
            .some(key => metadata[key] != null)) issues.add('checkpoint_owner_unverified');
        }
      } catch { issues.add('checkpoint_owner_unverified'); }
    }
    const effects = rows<{ session_id: string; source_user_seq: number }>(`SELECT session_id, source_user_seq
      FROM physical_dispatches WHERE state IN ('started', 'unknown') GROUP BY session_id, source_user_seq LIMIT ?`, 'effect');
    const openCrossedCalls = rows<{ session_id: string; source_user_seq: number }>(`SELECT l.session_id, l.source_user_seq
      FROM logical_tool_calls l WHERE l.state IN ('open', 'conflict') AND EXISTS (
        SELECT 1 FROM physical_dispatches p WHERE p.session_id = l.session_id
          AND p.source_user_seq = l.source_user_seq AND p.logical_tool_call_id = l.logical_tool_call_id)
      GROUP BY l.session_id, l.source_user_seq LIMIT ?`, 'open_call');
    const uncertain = rows<{ session_id: string; source_user_seq: number }>(`SELECT session_id, source_user_seq
      FROM logical_call_settlements WHERE requires_reconciliation = 1 GROUP BY session_id, source_user_seq LIMIT ?`, 'reconciliation');
    const audited = new Set<string>();
    const physicalPending = new Set([...effects, ...openCrossedCalls].map(effect => `${effect.session_id}:${effect.source_user_seq}`));
    for (const effect of [...effects, ...openCrossedCalls, ...uncertain]) {
      const identity = `${effect.session_id}:${effect.source_user_seq}`;
      if (audited.has(identity)) continue;
      audited.add(identity);
      const source = db.prepare('SELECT role, type FROM events WHERE session_id = ? AND seq = ?')
        .get(effect.session_id, effect.source_user_seq) as { role: string; type: string } | undefined;
      if (source?.role === 'system' && source.type === 'workflow_node_invocation_activated') {
        // The chat audit requires a human-input source. A readable workflow
        // activation needs its own exact audit; it is not a storage failure.
        // This observation verifies no workflow outcome and releases no hold.
        issues.add('workflow_effect_owner_unverified');
        add(workKey(effect.session_id, effect.source_user_seq, `effect:${identity}`), 'effect', 'uncertain', effect.session_id);
        continue;
      }
      const audit = reader.auditAcceptedSourceSettlementTruth({ sessionId: effect.session_id, sourceUserSeq: effect.source_user_seq });
      // The terminal audit deliberately permits some reversible/answered
      // effects. It does not change a still-open physical/call owner into a
      // settled one, and an unqualified source cannot hide that owner.
      if (audit.status === 'clean' && !physicalPending.has(identity)) continue;
      if (audit.status === 'storage_error') issues.add('effect_evidence_unreadable');
      if (physicalPending.has(identity) && ['clean', 'no_business_evidence', 'unrecovered_failure'].includes(audit.status)) {
        issues.add('effect_owner_unverified');
      }
      if (physicalPending.has(identity)
        || ['storage_error', 'in_flight', 'uncertain_write', 'write_projection_missing'].includes(audit.status)) {
        add(workKey(effect.session_id, effect.source_user_seq, `effect:${identity}`), 'effect', 'uncertain', effect.session_id);
      }
    }
  } catch { issues.add('execution_inventory_unreadable'); }

  const items = [...owners.values()].sort((a, b) => a.key.localeCompare(b.key));
  const snapshot: InstallQuiescenceSnapshot = {
    total: items.length,
    summary: items.length ? `${items.length} unfinished work item${items.length === 1 ? '' : 's'}` : 'no active work',
    currentWork: { total: items.length, items },
    quiescence: { state: items.length ? 'work_pending' : 'quiescent', observedAt, issues: [] },
  };
  for (const issue of issues) {
    const unverified = unverifiedInstallQuiescence(issue, snapshot);
    Object.assign(snapshot, unverified);
  }
  return snapshot;
}
