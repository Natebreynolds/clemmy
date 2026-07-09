import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE_DIR } from '../config.js';
import { actionBus } from './action-bus.js';
import { redactSensitiveValue } from './security.js';

export type OperationalEventSource =
  | 'workflow'
  | 'model'
  | 'workspace'
  | 'memory'
  | 'safety'
  | 'tool'
  | 'harness'
  | 'scheduler';

export type OperationalEventSeverity = 'debug' | 'info' | 'warn' | 'error';

export const WORKFLOW_OPERATIONAL_EVENT_TYPES = [
  'workflow_graph_created',
  'workflow_node_ready',
  'workflow_node_started',
  'workflow_node_completed',
  'workflow_node_blocked',
  'workflow_node_failed',
  'workflow_branch_evaluated',
  'workflow_graph_patch_proposed',
  'workflow_graph_patch_applied',
  'workflow_graph_patch_rejected',
  'workflow_checkpoint_created',
  'workflow_rollback_started',
  'workflow_rollback_completed',
  'workflow_trigger_fired',
  'workflow_trigger_deduped',
  'workflow_resume_replayed',
  // A workflow step / forEach item failed transiently and is being retried
  // after backoff (mirrored from the runner's step_retry / item_retry events).
  'workflow_node_retried',
] as const;

export const MODEL_OPERATIONAL_EVENT_TYPES = [
  'model_route_decided',
  'model_call_started',
  'model_call_completed',
  'model_call_failed',
  'model_fallover',
  'brain_auth_dead',
  'brain_silent_cooldown',
  'route_policy_updated',
] as const;

export const WORKSPACE_OPERATIONAL_EVENT_TYPES = [
  'workspace_created',
  'workspace_file_changed',
  'workspace_data_refresh_started',
  'workspace_data_refresh_completed',
  'workspace_data_refresh_failed',
  'workspace_action_requested',
  'workspace_action_approved',
  'workspace_action_executed',
  'workspace_action_failed',
  'workspace_memory_consolidated',
] as const;

export const MEMORY_OPERATIONAL_EVENT_TYPES = [
  'episodic_event_recorded',
  'semantic_candidate_extracted',
  'semantic_fact_upserted',
  'memory_consolidation_started',
  'memory_consolidation_completed',
  'memory_conflict_detected',
  'memory_conflict_resolved',
] as const;

export const SAFETY_OPERATIONAL_EVENT_TYPES = [
  'approval_required',
  'approval_resolved',
  'side_effect_planned',
  'side_effect_executed',
  'side_effect_compensated',
  // A MUTATING external call timed out — the harness stopped waiting (and, when
  // abort-on-timeout is on, cancelled the socket) but the write MAY have landed
  // server-side. Mirrored from harness external_write_orphaned so maybe-landed
  // writes are dashboard-visible, not just in the session ledger.
  'side_effect_orphaned',
  'transaction_guard_opened',
  'transaction_guard_committed',
  'transaction_guard_rolled_back',
  'specular_simulation_started',
  'specular_simulation_completed',
  'specular_simulation_failed',
  // A tool-boundary gate (guardrail) reached a verdict on an action —
  // allowed-with-warning / blocked. Mirrored from harness guardrail_tripped.
  'gate_verdict',
  // An LLM judge reached a verdict on a deliverable / irreversible write
  // (goal-alignment, output-grounding, or a fusion debate/verify checker).
  'judge_verdict',
] as const;

export const TOOL_OPERATIONAL_EVENT_TYPES = [
  'tool_call_started',
  'tool_call_completed',
  'tool_call_failed',
  'tool_approval_pending',
  // A successful Composio call was SHAPE-classified as a queued async receipt by the
  // family-agnostic generic detector (not a known family). Emitted so the heuristic's
  // precision is watchable in prod — payload carries slug/toolkit/jobId + the outcome
  // (parked | banner). A spike of these on normal completes is the false-positive signal.
  'composio_async_generic_detected',
] as const;

// Harness run-lifecycle + swarm + background-task telemetry. Most of these are
// mirrored from the harness eventlog (eventlog-operational-mirror.ts); the
// worker_spawned/queued + background_task_* rows are direct emits from the
// tool/execution layer where the eventlog is dark.
export const HARNESS_OPERATIONAL_EVENT_TYPES = [
  'harness_turn_started',
  'harness_turn_completed',
  'harness_run_completed',
  'harness_run_failed',
  'worker_spawned',
  'worker_queued',
  'worker_completed',
  'worker_failed',
  'worker_capped',
  // A configured non-Claude WORKER model was ignored because the SDK-brain
  // cross-provider lane is off (CLEMMY_SDK_BRAIN_CROSS_WORKER=off) — a visible
  // warning instead of a silent fallback to the Claude brain model.
  'worker_model_ignored',
  'auto_continue',
  'background_task_created',
  'background_task_started',
  'background_task_finished',
  'background_task_parked',
] as const;

// Scheduler (cron) run lifecycle — direct emits from the daemon runner.
export const SCHEDULER_OPERATIONAL_EVENT_TYPES = [
  'cron_job_started',
  'cron_job_completed',
  'cron_job_failed',
] as const;

export const OPERATIONAL_EVENT_TYPES = [
  ...WORKFLOW_OPERATIONAL_EVENT_TYPES,
  ...MODEL_OPERATIONAL_EVENT_TYPES,
  ...WORKSPACE_OPERATIONAL_EVENT_TYPES,
  ...MEMORY_OPERATIONAL_EVENT_TYPES,
  ...SAFETY_OPERATIONAL_EVENT_TYPES,
  ...TOOL_OPERATIONAL_EVENT_TYPES,
  ...HARNESS_OPERATIONAL_EVENT_TYPES,
  ...SCHEDULER_OPERATIONAL_EVENT_TYPES,
] as const;

export type WorkflowOperationalEventType = (typeof WORKFLOW_OPERATIONAL_EVENT_TYPES)[number];
export type ModelOperationalEventType = (typeof MODEL_OPERATIONAL_EVENT_TYPES)[number];
export type WorkspaceOperationalEventType = (typeof WORKSPACE_OPERATIONAL_EVENT_TYPES)[number];
export type MemoryOperationalEventType = (typeof MEMORY_OPERATIONAL_EVENT_TYPES)[number];
export type SafetyOperationalEventType = (typeof SAFETY_OPERATIONAL_EVENT_TYPES)[number];
export type ToolOperationalEventType = (typeof TOOL_OPERATIONAL_EVENT_TYPES)[number];
export type HarnessOperationalEventType = (typeof HARNESS_OPERATIONAL_EVENT_TYPES)[number];
export type SchedulerOperationalEventType = (typeof SCHEDULER_OPERATIONAL_EVENT_TYPES)[number];
export type OperationalEventType = (typeof OPERATIONAL_EVENT_TYPES)[number];

const OPERATIONAL_EVENT_TYPE_SET: ReadonlySet<string> = new Set(OPERATIONAL_EVENT_TYPES);

export interface OperationalEventEnvelope {
  eventId: string;
  ts: string;
  source: OperationalEventSource;
  type: OperationalEventType;
  severity: OperationalEventSeverity;
  workspaceId?: string;
  workflowRunId?: string;
  workflowNodeRunId?: string;
  sessionId?: string;
  modelCallId?: string;
  toolCallId?: string;
  actor?: string;
  payload: Record<string, unknown>;
}

export interface CreateOperationalEventInput {
  source: OperationalEventSource;
  type: OperationalEventType;
  severity?: OperationalEventSeverity;
  workspaceId?: string;
  workflowRunId?: string;
  workflowNodeRunId?: string;
  sessionId?: string;
  modelCallId?: string;
  toolCallId?: string;
  actor?: string;
  payload?: Record<string, unknown>;
  now?: Date;
  eventId?: string;
}

export const OPERATIONAL_TELEMETRY_STATE_DIR = path.join(BASE_DIR, 'state');
export const OPERATIONAL_TELEMETRY_DB_PATH = path.join(OPERATIONAL_TELEMETRY_STATE_DIR, 'operational-telemetry.db');

export const OPERATIONAL_TELEMETRY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS operational_events (
  event_id             TEXT PRIMARY KEY,
  ts                   TEXT NOT NULL,
  source               TEXT NOT NULL,
  type                 TEXT NOT NULL,
  severity             TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
  workspace_id         TEXT,
  workflow_run_id      TEXT,
  workflow_node_run_id TEXT,
  session_id           TEXT,
  model_call_id        TEXT,
  tool_call_id         TEXT,
  actor                TEXT,
  payload_json         TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_operational_events_ts
  ON operational_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_operational_events_source_type_ts
  ON operational_events(source, type, ts DESC);
CREATE INDEX IF NOT EXISTS idx_operational_events_workspace_ts
  ON operational_events(workspace_id, ts DESC) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operational_events_workflow_ts
  ON operational_events(workflow_run_id, ts DESC) WHERE workflow_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operational_events_session_ts
  ON operational_events(session_id, ts DESC) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operational_events_model_call
  ON operational_events(model_call_id) WHERE model_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operational_events_tool_call
  ON operational_events(tool_call_id) WHERE tool_call_id IS NOT NULL;
`;

export interface ListOperationalEventsOptions {
  source?: OperationalEventSource;
  type?: OperationalEventType;
  severity?: OperationalEventSeverity;
  workspaceId?: string;
  workflowRunId?: string;
  sessionId?: string;
  since?: string;
  limit?: number;
}

let cachedDb: Database.Database | null = null;

export function isOperationalEventType(value: string): value is OperationalEventType {
  return OPERATIONAL_EVENT_TYPE_SET.has(value);
}

export function createOperationalEvent(input: CreateOperationalEventInput): OperationalEventEnvelope {
  return {
    eventId: input.eventId ?? randomUUID(),
    ts: (input.now ?? new Date()).toISOString(),
    source: input.source,
    type: input.type,
    severity: input.severity ?? 'info',
    workspaceId: input.workspaceId,
    workflowRunId: input.workflowRunId,
    workflowNodeRunId: input.workflowNodeRunId,
    sessionId: input.sessionId,
    modelCallId: input.modelCallId,
    toolCallId: input.toolCallId,
    actor: input.actor,
    payload: input.payload ?? {},
  };
}

export function openOperationalTelemetryDb(): Database.Database {
  if (cachedDb) return cachedDb;
  ensureStateDir();
  const db = new Database(OPERATIONAL_TELEMETRY_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(OPERATIONAL_TELEMETRY_SCHEMA_SQL);
  cachedDb = db;
  return db;
}

export function closeOperationalTelemetryDb(): void {
  if (!cachedDb) return;
  cachedDb.close();
  cachedDb = null;
}

/** Test-only reset. Production callers should treat the log as append-only. */
export function resetOperationalTelemetryForTest(): void {
  closeOperationalTelemetryDb();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = OPERATIONAL_TELEMETRY_DB_PATH + suffix;
    if (existsSync(file)) unlinkSync(file);
  }
}

/**
 * Best-effort canonical event writer. It returns the envelope even if the DB is
 * temporarily unavailable so callers can still correlate what they attempted to
 * emit, but it never lets observability fail a live run.
 */
export function recordOperationalEvent(
  input: CreateOperationalEventInput,
  db?: Database.Database,
): OperationalEventEnvelope {
  const event = createOperationalEvent(input);
  const externalDb = !!db;
  try {
    writeOperationalEvent(db ?? openOperationalTelemetryDb(), event);
  } catch {
    // Observability must not break workflow/model/tool execution.
  }
  if (!externalDb) {
    try {
      actionBus.emit({ kind: 'operational.event', event });
    } catch {
      // actionBus is already guarded; keep this writer fail-closed anyway.
    }
  }
  return event;
}

export function listOperationalEvents(
  options: ListOperationalEventsOptions = {},
  db: Database.Database = openOperationalTelemetryDb(),
): OperationalEventEnvelope[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (options.source) {
    clauses.push('source = @source');
    params.source = options.source;
  }
  if (options.type) {
    clauses.push('type = @type');
    params.type = options.type;
  }
  if (options.severity) {
    clauses.push('severity = @severity');
    params.severity = options.severity;
  }
  if (options.workspaceId) {
    clauses.push('workspace_id = @workspaceId');
    params.workspaceId = options.workspaceId;
  }
  if (options.workflowRunId) {
    clauses.push('workflow_run_id = @workflowRunId');
    params.workflowRunId = options.workflowRunId;
  }
  if (options.sessionId) {
    clauses.push('session_id = @sessionId');
    params.sessionId = options.sessionId;
  }
  if (options.since) {
    clauses.push('ts >= @since');
    params.since = options.since;
  }
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
  params.limit = limit;
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT * FROM operational_events
    ${where}
    ORDER BY ts DESC
    LIMIT @limit
  `).all(params) as OperationalEventRow[];
  return rows.map(rowToOperationalEvent);
}

interface OperationalEventRow {
  event_id: string;
  ts: string;
  source: OperationalEventSource;
  type: OperationalEventType;
  severity: OperationalEventSeverity;
  workspace_id: string | null;
  workflow_run_id: string | null;
  workflow_node_run_id: string | null;
  session_id: string | null;
  model_call_id: string | null;
  tool_call_id: string | null;
  actor: string | null;
  payload_json: string | null;
}

function writeOperationalEvent(db: Database.Database, event: OperationalEventEnvelope): void {
  db.prepare(`
    INSERT OR REPLACE INTO operational_events (
      event_id, ts, source, type, severity, workspace_id, workflow_run_id,
      workflow_node_run_id, session_id, model_call_id, tool_call_id, actor,
      payload_json
    ) VALUES (
      @eventId, @ts, @source, @type, @severity, @workspaceId, @workflowRunId,
      @workflowNodeRunId, @sessionId, @modelCallId, @toolCallId, @actor,
      @payloadJson
    )
  `).run({
    eventId: event.eventId,
    ts: event.ts,
    source: event.source,
    type: event.type,
    severity: event.severity,
    workspaceId: event.workspaceId ?? null,
    workflowRunId: event.workflowRunId ?? null,
    workflowNodeRunId: event.workflowNodeRunId ?? null,
    sessionId: event.sessionId ?? null,
    modelCallId: event.modelCallId ?? null,
    toolCallId: event.toolCallId ?? null,
    actor: event.actor ?? null,
    payloadJson: JSON.stringify(redactPayload(event.payload)),
  });
}

function rowToOperationalEvent(row: OperationalEventRow): OperationalEventEnvelope {
  return {
    eventId: row.event_id,
    ts: row.ts,
    source: row.source,
    type: row.type,
    severity: row.severity,
    workspaceId: row.workspace_id ?? undefined,
    workflowRunId: row.workflow_run_id ?? undefined,
    workflowNodeRunId: row.workflow_node_run_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    modelCallId: row.model_call_id ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    actor: row.actor ?? undefined,
    payload: parsePayload(row.payload_json),
  };
}

function ensureStateDir(): void {
  if (!existsSync(OPERATIONAL_TELEMETRY_STATE_DIR)) mkdirSync(OPERATIONAL_TELEMETRY_STATE_DIR, { recursive: true });
}

function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactSensitiveValue(payload);
  if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>;
  }
  return { value: redacted };
}

function parsePayload(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return {};
  }
}
