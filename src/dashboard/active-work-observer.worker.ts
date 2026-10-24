/** Whole active-work observation. This entry must never import application initialization. */
import { parentPort, workerData } from 'node:worker_threads';
import { lstatSync, opendirSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readInstallQuiescenceRead, unverifiedInstallQuiescence } from './install-quiescence-read.js';
import { acceptedSourceSettlementEventWindow, readAcceptedSourceSettlementEvents, auditAcceptedSourceSettlementTruthRead } from '../runtime/harness/accepted-source-settlement-audit-read.js';
import { readPendingUnacknowledgedWritesForSourceRead } from '../runtime/harness/pending-unacknowledged-writes-read.js';
import { readRecoveryActivationRead } from '../runtime/harness/recovery-activation-read.js';
import { parseCurrentManifestRecoverySemantics } from '../runtime/harness/current-manifest-recovery-data.js';
import { resolveWriteEvidence } from '../runtime/harness/write-evidence.js';
import { rowToEvent, rowToSession, type RawEventRow, type RawSessionRow } from '../runtime/harness/eventlog-row-data.js';
import { rowToPublic, approvalGroupMembersRead, isApprovalGroup, isFormalApprovalSurface, type ApprovalSqlRow } from '../runtime/harness/approval-registry-read.js';
import { isIgnorableActiveWorkSessionRead } from '../runtime/harness/session-active-work-read.js';
import { presentationEventFromCompletionData } from '../runtime/harness/turn-outcome.js';
import { slimWorkflowRunRecord } from '../execution/workflow-run-inventory-data.js';
import { isTerminalWorkflowRunStatus } from '../execution/workflow-run-terminal-status.js';
import { ACTIVE_WORK_OBSERVER_LIMITS as limits, ObservationBoundError, observationFailureIssue,
  policyInput, policyMapDigest, observationDigest, observationIdentityDigest,
  type ObservationIdentity, type MainToObserver, type PolicyInput, type PolicyKind, type ObserverToMain,
  type ActiveWorkSnapshot } from './active-work-observer-protocol.js';
import type { AcceptedSourceSettlementAuditReader } from '../runtime/harness/accepted-source-settlement-audit-read.js';
import type { BackgroundTaskRecord } from '../execution/background-tasks.js';
import type { EventRow, ListEventsOptions } from '../runtime/harness/eventlog.js';
import type { PendingApprovalRow } from '../runtime/harness/approval-registry.js';
import type { WorkflowRunInventoryEntry, WorkflowRunInventoryFileResult } from '../execution/workflow-run-inventory.js';

const { nonce, epoch, build, baseDir, workflowDir, schema, requestedAt, deadline, artifacts } = workerData as ObservationIdentity;
const identity: ObservationIdentity = { nonce, epoch, build, baseDir, workflowDir, schema, requestedAt, deadline, artifacts };
const port = parentPort;
const fences = new Map<string, string | null>();
const directoryFiles = new Map<string, string[]>();
let usedRows = 0, usedBytes = 0, failed = false;
let firstFailure: unknown;
function failObservation(error: unknown): never {
  // Canonical readers may catch a read failure. A later check must retain its
  // original reason, including an unknown error that must remain generic.
  if (!failed) { failed = true; firstFailure = error; }
  throw firstFailure;
}
function check(): void {
  if (failed) throw firstFailure;
  if (Date.now() > identity.deadline) failObservation(new ObservationBoundError('deadline'));
}
function measure(value: unknown): void {
  check();
  if (++usedRows > limits.rows) failObservation(new ObservationBoundError('rows'));
  if ((usedBytes += Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')) > limits.totalBytes)
    failObservation(new ObservationBoundError('total_bytes'));
}
function generation(file: string): string | null {
  try {
    const stat = lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('symbolic_observation_path');
    return [stat.dev, stat.ino, stat.ctimeNs, stat.mtimeNs, stat.size].join(':');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function fence(file: string): void {
  check();
  const current = generation(file);
  if (fences.has(file) && fences.get(file) !== current) throw new Error('observation_drift');
  fences.set(file, current);
}
function readText(file: string, maximum: number = limits.fileBytes): string | undefined {
  fence(file);
  if (!fences.get(file)) return undefined;
  const stat = lstatSync(file);
  if (!stat.isFile()) throw new Error('observation_bound');
  if (stat.size > maximum) failObservation(new ObservationBoundError('file_bytes'));
  const descriptor = openSync(file, 'r');
  let bytes: string;
  try {
    const buffer = Buffer.alloc(stat.size + 1);
    const count = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (count !== stat.size) throw new Error('observation_drift');
    bytes = buffer.subarray(0, count).toString('utf8');
  } finally { closeSync(descriptor); }
  measure(bytes); fence(file);
  return bytes;
}
function readJSON(file: string): unknown { const bytes = readText(file); return bytes === undefined ? undefined : JSON.parse(bytes); }
function files(directory: string): string[] {
  fence(directory);
  if (!fences.get(directory)) { directoryFiles.set(directory, []); return []; }
  const entries: string[] = []; const handle = opendirSync(directory);
  try {
    for (let count = 0; ; count++) {
      const entry = handle.readSync(); if (!entry) break;
      if (count >= limits.files) failObservation(new ObservationBoundError('files'));
      entries.push(entry.name);
    }
  } finally { handle.closeSync(); }
  directoryFiles.set(directory, entries);
  return entries.filter(name => name.endsWith('.json')).sort();
}
function boundedDatabase(raw: Database.Database): Database.Database {
  return new Proxy(raw, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      check();
      if (!/^\s*(SELECT|WITH|EXPLAIN)\b/i.test(sql)) throw new Error('non_read_statement');
      let statement: Database.Statement;
      try { statement = target.prepare(sql); } catch (error) { failObservation(error); }
      return new Proxy(statement, { get(stmt, field) {
        if (field === 'all') return (...params: unknown[]) => {
          const result: unknown[] = [];
          try {
            for (const row of Reflect.apply(stmt.iterate, stmt, params) as Iterable<unknown>) { measure(row); result.push(row); }
          } catch (error) { failObservation(error); }
          return result;
        };
        if (field === 'get') return (...params: unknown[]) => {
          try { const row = Reflect.apply(stmt.get, stmt, params); if (row !== undefined) measure(row); return row; }
          catch (error) { failObservation(error); }
        };
        const value = Reflect.get(stmt, field); return typeof value === 'function' ? value.bind(stmt) : value;
      } });
    };
    if (key === 'exec' || key === 'transaction') return () => { throw new Error('non_read_statement'); };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
function same(value: unknown): boolean { return observationIdentityDigest(value as ObservationIdentity) === observationIdentityDigest(identity); }
function message(type: MainToObserver['type']): Promise<MainToObserver> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { port?.off('message', listener); reject(new ObservationBoundError('deadline')); }, Math.max(1, identity.deadline - Date.now()));
    const listener = (value: MainToObserver) => {
      if (value?.type !== type || !same(value.identity)) { clearTimeout(timer); port?.off('message', listener); reject(new Error('observation_identity')); return; }
      clearTimeout(timer); port?.off('message', listener); resolve(value);
    };
    port?.on('message', listener);
  });
}
function post(value: ObserverToMain): void { port?.postMessage(value); }

async function observe(): Promise<void> {
  if (!port || !identity || typeof identity.baseDir !== 'string' || !path.isAbsolute(identity.baseDir)
    || typeof identity.workflowDir !== 'string' || !path.isAbsolute(identity.workflowDir)
    || !Number.isSafeInteger(identity.schema) || !identity.nonce || !identity.epoch || !identity.build) throw new Error('observation_identity');
  if (!Array.isArray(identity.artifacts) || identity.artifacts.length > 2) throw new Error('observation_identity');
  for (const artifact of identity.artifacts) {
    if (!path.isAbsolute(artifact.file)) throw new Error('observation_identity');
    fence(artifact.file);
    if (fences.get(artifact.file) !== artifact.generation || lstatSync(artifact.file).size > limits.fileBytes
      || observationDigest(readText(artifact.file)) !== artifact.digest) throw new Error('artifact_drift');
    fence(artifact.file);
  }
  fence(identity.baseDir); if (realpathSync(identity.baseDir) !== path.resolve(identity.baseDir)) throw new Error('observation_home');
  const dbPath = path.join(identity.baseDir, 'state', 'harness.db'); fence(dbPath); fence(dbPath + '-wal');
  const raw = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 250 });
  try {
    raw.pragma('query_only = ON');
    const versionBefore = raw.pragma('data_version', { simple: true });
    raw.exec('BEGIN');
    const db = boundedDatabase(raw);
    const schema = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>;
    if (schema.length !== identity.schema || schema.some((row, i) => row.version !== i + 1)) throw new Error('observation_schema');
    const workflow = new Map<string, WorkflowRunInventoryFileResult>();
    for (const file of files(identity.workflowDir)) {
      const value = readJSON(path.join(identity.workflowDir, file));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workflow_record_unreadable');
      const stat = lstatSync(path.join(identity.workflowDir, file));
      workflow.set(file, { kind: 'record', entry: { file, mtimeMs: stat.mtimeMs, size: stat.size, record: slimWorkflowRunRecord(value as Record<string, unknown>) } });
    }
    const backgroundDir = path.join(identity.baseDir, 'state', 'background-tasks');
    const background = new Map<string, BackgroundTaskRecord>();
    for (const file of files(backgroundDir)) {
      const value = readJSON(path.join(backgroundDir, file));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('background_record_unreadable');
      background.set(file.slice(0, -5), value as BackgroundTaskRecord);
    }
    // The coding reader keeps its own exact read-only connection; fencing its
    // files before and after prevents mixed generations across the two stores.
    const codingBase = path.join(identity.baseDir, 'state', 'coding-runs'); fence(codingBase);
    const machineFile = path.join(identity.baseDir, 'state', 'machine-id'); fence(machineFile);
    let machineText: string | undefined;
    if (fences.get(machineFile)) {
      if (lstatSync(machineFile).size > 1_024) failObservation(new ObservationBoundError('file_bytes'));
      machineText = readText(machineFile, 1_024);
      const machine = machineText?.trim() ?? '';
      if (/^[A-Za-z0-9._-]+$/.test(machine) && machine !== '.' && machine !== '..') {
        const coding = path.join(codingBase, machine, 'coding-runs.db'); fence(coding); fence(coding + '-wal');
      }
    }
    const eventCache = new Map<string, EventRow[]>();
    const listEvents = (sessionId: string, options: ListEventsOptions = {}): EventRow[] => {
      const cacheKey = JSON.stringify([sessionId, options]);
      let events = eventCache.get(cacheKey);
      if (!events) {
        const clauses = ['session_id = ?']; const params: unknown[] = [sessionId];
        if (options.sinceSeq !== undefined) { clauses.push('seq > ?'); params.push(options.sinceSeq); }
        if (options.throughSeq !== undefined) { clauses.push('seq <= ?'); params.push(options.throughSeq); }
        if (options.sinceAt !== undefined) { clauses.push('created_at >= ?'); params.push(options.sinceAt); }
        if (options.types?.length) { clauses.push(`type IN (${options.types.map(() => '?').join(',')})`); params.push(...options.types); }
        const limit = Math.min(options.limit ?? limits.events + 1, limits.events + 1);
        params.push(limit);
        const rows = db.prepare(`SELECT * FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq ${options.desc ? 'DESC' : 'ASC'} LIMIT ?`).all(...params) as RawEventRow[];
        if (rows.length > limits.events) failObservation(new ObservationBoundError('events'));
        events = rows.map(rowToEvent); if (options.desc) events.reverse(); eventCache.set(cacheKey, events);
      }
      return events;
    };
    const sources = db.prepare(`SELECT session_id, source_user_seq FROM physical_dispatches WHERE state IN ('started','unknown')
      UNION SELECT session_id, source_user_seq FROM logical_call_settlements WHERE requires_reconciliation = 1
      UNION SELECT l.session_id,l.source_user_seq FROM logical_tool_calls l WHERE l.state IN ('open','conflict') AND EXISTS
        (SELECT 1 FROM physical_dispatches p WHERE p.session_id=l.session_id AND p.source_user_seq=l.source_user_seq AND p.logical_tool_call_id=l.logical_tool_call_id)`).all() as Array<{ session_id: string; source_user_seq: number }>;
    const inputs = new Map<string, PolicyInput>();
    const add = (kind: PolicyKind, value: unknown) => {
      const input = policyInput(kind, value);
      if (Buffer.byteLength(JSON.stringify(input)) > limits.policyItemBytes) failObservation(new ObservationBoundError('policy_item_bytes'));
      inputs.set(input.key, input); if (inputs.size > limits.policyInputs) failObservation(new ObservationBoundError('policy_inputs'));
    };
    for (const source of sources) {
      const calls = db.prepare('SELECT tool_name FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ?').all(source.session_id, source.source_user_seq) as Array<{ tool_name: string }>;
      for (const call of calls) add('effect', [call.tool_name, {}]);
      const window = listEvents(source.session_id, acceptedSourceSettlementEventWindow(source.source_user_seq));
      // Non-user sources retain the conservative preflight; the inventory's
      // workflow-owner branch must preserve their typed hold, not a chat error.
      const selected = window.some(event => event.sessionId === source.session_id
        && event.seq === source.source_user_seq && event.type === 'user_input_received')
        ? readAcceptedSourceSettlementEvents(source.session_id, source.source_user_seq, { database: () => db, listEvents })
        : window;
      for (const event of selected) if (event.type === 'tool_called') {
        let args = event.data.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* canonical model-visible bytes */ } }
        const tool = typeof event.data.tool === 'string' ? event.data.tool : undefined;
        // Every possible fallback row name is included, so no branch of the
        // canonical audit needs an unprepared classifier input.
        if (tool !== undefined) add('shape', [tool, args]);
        else for (const call of calls) add('shape', [call.tool_name, args]);
        add('targets', args);
      }
      const sealed = db.prepare('SELECT sealed_json FROM physical_dispatch_authority_sealed WHERE session_id = ? AND source_user_seq = ?').all(source.session_id, source.source_user_seq) as Array<{ sealed_json: string }>;
      for (const row of sealed) add('sealed', row.sealed_json);
    }
    const prepared = [...inputs.values()].sort((a, b) => a.key.localeCompare(b.key));
    if (Buffer.byteLength(JSON.stringify(prepared)) > limits.policyBytes) failObservation(new ObservationBoundError('policy_bytes'));
    const waiting = message('policy'); post({ type: 'policy', identity, inputs: prepared });
    const response = await waiting;
    if (response.type !== 'policy' || response.values.length !== prepared.length || policyMapDigest(prepared, response.values) !== response.policyDigest) throw new Error('policy_mismatch');
    const values = new Map(response.values.map(value => [value.key, value.output]));
    if (values.size !== prepared.length || prepared.some(input => !values.has(input.key))) throw new Error('policy_incomplete');
    const policy = (kind: PolicyKind, value: unknown): unknown => {
      const key = policyInput(kind, value).key;
      if (!inputs.has(key) || !values.has(key)) failObservation(new Error('policy_unprepared'));
      return values.get(key);
    };
    const auditReader: AcceptedSourceSettlementAuditReader = {
      database: () => db, listEvents,
      classifyRuntimeToolEffect: (tool, args) => policy('effect', [tool, args]) as ReturnType<AcceptedSourceSettlementAuditReader['classifyRuntimeToolEffect']>,
      classifyExternalWrite: (tool, args) => policy('shape', [tool, args]) as ReturnType<AcceptedSourceSettlementAuditReader['classifyExternalWrite']>,
      extractExternalWriteIdentityKeys: args => policy('targets', args) as string[],
      parseCurrentManifestRecoverySemantics, resolveWriteEvidence,
      readPendingUnacknowledgedWritesForSource: input => readPendingUnacknowledgedWritesForSourceRead(input, () => db,
        { parseResolvedCallAuthority: bytes => policy('sealed', bytes) as ReturnType<typeof import('../runtime/harness/resolved-call-authority.js').parseResolvedCallAuthority> }),
    };
    const audit = (input: Parameters<typeof auditAcceptedSourceSettlementTruthRead>[0]) => auditAcceptedSourceSettlementTruthRead(input, auditReader);
    // Exact raw bytes from this BEGIN snapshot, never shared across observations.
    // An absent row is distinct from an existing row with null/empty metadata.
    const sessionMetadata = new Map<string, { metadata_json: string | null } | undefined>();
    const getSessionMetadata = (sessionId: string) => {
      if (!sessionMetadata.has(sessionId)) sessionMetadata.set(sessionId,
        db.prepare('SELECT metadata_json FROM sessions WHERE id = ?').get(sessionId) as { metadata_json: string | null } | undefined);
      const row = sessionMetadata.get(sessionId);
      return row ? row.metadata_json ? JSON.parse(row.metadata_json) : {} : undefined;
    };
    const getApproval = (id: string) => {
      const row = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?').get(id) as ApprovalSqlRow | undefined;
      return row ? rowToPublic(row) : undefined;
    };
    const inventory = readInstallQuiescenceRead({ nowMs: identity.requestedAt }, {
      BASE_DIR: identity.baseDir, WORKFLOW_RUNS_DIR: identity.workflowDir, database: () => db,
      openCodingDatabase: file => boundedDatabase(new Database(file, { readonly: true, fileMustExist: true, timeout: 250 })),
      readCodingMachineId: () => {
        if (machineText === undefined) throw Object.assign(new Error('coding_machine_identity_unavailable'), { code: 'ENOENT' });
        return machineText;
      },
      listDirectoryFiles: directory => {
        const names = directoryFiles.get(directory);
        if (!names) failObservation(new Error('directory_unprepared'));
        return names;
      },
      observeSessionMetadata: (sessionId, metadataJson) => sessionMetadata.set(sessionId, { metadata_json: metadataJson }),
      getUserInputEventAtSequence: (sessionId, seq) => {
        const row = db.prepare("SELECT * FROM events WHERE seq = ? AND session_id = ? AND type = 'user_input_received'").get(seq, sessionId) as RawEventRow | undefined;
        return row ? rowToEvent(row) : undefined;
      },
      getBackgroundTask: id => background.get(id) ?? null,
      readWorkflowRunInventoryFile: file => workflow.get(file) ?? { kind: 'failed' },
      auditAcceptedSourceSettlementTruth: audit,
      readRecoveryActivation: sessionId => readRecoveryActivationRead(sessionId, { database: () => db, metadata: getSessionMetadata }),
      presentationEventFromCompletionData, getApproval, isTerminalWorkflowRunStatus,
    });
    const publicApprovals = (db.prepare("SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY requested_at DESC").all() as ApprovalSqlRow[]).map(rowToPublic);
    const grouped = new Set(publicApprovals.filter(isApprovalGroup).flatMap(row => {
      const members = approvalGroupMembersRead(row, getApproval);
      return members?.every(member => member.status === row.status) ? members.map(member => member.approvalId) : [];
    }));
    const approvals = publicApprovals.filter(row => !grouped.has(row.approvalId)).filter(isFormalApprovalSurface);
    const sessionReader = { database: () => db, listEvents,
      listEventsAtSequences: (sessionId: string, sequences: readonly number[]) => sequences.length === 0 ? []
        : (db.prepare(`SELECT * FROM events WHERE session_id = ? AND seq IN (${sequences.map(() => '?').join(',')}) ORDER BY seq`).all(sessionId, ...sequences) as RawEventRow[]).map(rowToEvent),
      workflowRunInventoryEntry: (id: string): WorkflowRunInventoryEntry | null => { const value = workflow.get(id + '.json'); return value?.kind === 'record' ? value.entry : null; },
      auditAcceptedSourceSettlementTruth: audit };
    const pendingSessionIds = new Set(approvals.map(row => row.sessionId));
    const retainedMetadataIds = [...sessionMetadata].filter(([, row]) => row !== undefined).map(([id]) => id);
    const metadataProjection = retainedMetadataIds.length
      ? `CASE WHEN id IN (${retainedMetadataIds.map(() => '?').join(',')}) THEN NULL ELSE metadata_json END`
      : 'metadata_json';
    // Keep every RawSessionRow field and the exact display membership/order.
    // Previously selected metadata is hydrated from its unchanged raw bytes.
    const sessions = (db.prepare(`SELECT id, kind, channel, user_id, created_at, updated_at, status, title, objective,
      token_budget, tokens_used, current_plan_id, ${metadataProjection} AS metadata_json FROM sessions
      WHERE kind IN ('workflow','execution','agent') AND status IN ('active','paused') ORDER BY updated_at DESC,id DESC`)
      .all(...retainedMetadataIds) as RawSessionRow[]).map(row => {
        const retained = sessionMetadata.has(row.id) ? sessionMetadata.get(row.id) : undefined;
        return rowToSession(retained === undefined ? row : { ...row, metadata_json: retained.metadata_json });
      }).filter(session => !isIgnorableActiveWorkSessionRead(session, { pendingSessionIds, nowMs: identity.requestedAt }, sessionReader));
    const tasks = [...background.values()].filter(task => !task.archived).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .filter(task => task.status === 'running' || task.status === 'pending' || task.status === 'awaiting_approval');
    const items = [
      ...sessions.map(session => ({ type: 'session', id: session.id, kind: session.kind, status: session.status,
        title: session.title || session.objective || session.id, updatedAt: session.updatedAt })),
      ...approvals.map(approval => ({ type: 'approval', id: approval.approvalId, kind: 'harness-approval', status: approval.status,
        title: approval.subject || approval.tool || approval.approvalId, sessionId: approval.sessionId, tool: approval.tool, updatedAt: approval.requestedAt })),
      ...tasks.map(task => ({ type: 'background-task', id: task.id, kind: task.source, status: task.status,
        title: task.title, updatedAt: task.updatedAt, pendingApprovalId: task.pendingApprovalId })),
    ];
    const summaries = [];
    if (sessions.length) summaries.push(`${sessions.length} tracked run${sessions.length === 1 ? '' : 's'} active or paused`);
    if (approvals.length) summaries.push(`${approvals.length} pending approval${approvals.length === 1 ? '' : 's'}`);
    if (tasks.length) summaries.push(`${tasks.length} background task${tasks.length === 1 ? '' : 's'}`);
    const snapshot: ActiveWorkSnapshot = { ...inventory, activeSessions: sessions.length, pendingApprovals: approvals.length,
      activeBackgroundTasks: tasks.length, items, trackedActivitySummary: summaries.join(', ') || 'no tracked activity' };
    check(); if (Buffer.byteLength(JSON.stringify(snapshot)) > limits.dtoBytes) failObservation(new ObservationBoundError('dto_bytes'));
    raw.exec('COMMIT');
    const validating = message('validate'); post({ type: 'candidate', identity, policyDigest: response.policyDigest, snapshot });
    const accepted = await validating;
    if (accepted.type !== 'validate' || accepted.policyDigest !== response.policyDigest) throw new Error('policy_mismatch');
    check();
    if (raw.pragma('data_version', { simple: true }) !== versionBefore) throw new Error('observation_drift');
    for (const [file, expected] of fences) if (generation(file) !== expected) throw new Error('observation_drift');
    post({ type: 'result', identity, policyDigest: response.policyDigest, snapshot });
  } finally { if (raw.inTransaction) raw.exec('ROLLBACK'); raw.close(); }
}

void observe().catch(error => {
  const issueCode = observationFailureIssue(failed ? firstFailure : error);
  const snapshot: ActiveWorkSnapshot = { ...unverifiedInstallQuiescence(issueCode),
    activeSessions: 0, pendingApprovals: 0, activeBackgroundTasks: 0, items: [], activityAvailable: false };
  post({ type: 'result', identity, policyDigest: '', snapshot, issueCode });
}).finally(() => port?.close());
