/**
 * Prospective intention control plane.
 *
 * A language model is stateless between calls. Clementine becomes reliably
 * proactive by storing future commitments outside the prompt, matching their
 * cues in deterministic code, and loading only the relevant slice when a model
 * actually needs to reason.
 *
 * This database is a rebuildable MATERIALIZED INDEX over the proven execution
 * authorities (timers, goals, workflow schedules/events, and monitors). It does
 * not execute actions and it never grants approval. Source-specific engines
 * remain authoritative for queueing, retries, dedupe, and side-effect gates.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE_DIR, getRuntimeEnv } from '../config.js';

export type ProspectiveSourceKind =
  | 'timer'
  | 'goal'
  | 'workflow_schedule'
  | 'workflow_event'
  | 'workflow_webhook'
  | 'monitor'
  | 'check_in'
  | 'background';

export type ProspectiveStatus =
  | 'active'
  | 'due'
  | 'claimed'
  | 'blocked'
  | 'completed'
  | 'cancelled';

export type ProspectiveRisk = 'read' | 'write' | 'send' | 'inherits';
export type ProspectiveApprovalMode = 'none' | 'enforce_at_action';

export type ProspectiveTrigger =
  | { kind: 'time'; at: string; timezone?: string }
  | { kind: 'cron'; expression: string; timezone?: string }
  | {
      kind: 'event';
      eventType: string;
      filter?: Record<string, string | number | boolean>;
      dedupeKeyTemplate?: string;
    }
  | { kind: 'webhook'; path: string }
  | { kind: 'state'; channel: string; intervalMs?: number }
  | { kind: 'completion'; resourceType: string; resourceId: string }
  | { kind: 'manual' };

export type ProspectiveAction =
  | { kind: 'notify'; ref?: string; summary?: string }
  | { kind: 'resume_goal'; ref: string; summary?: string }
  | { kind: 'run_workflow'; ref: string; summary?: string }
  | { kind: 'observe'; ref: string; summary?: string }
  | { kind: 'surface_check_in'; ref: string; summary?: string }
  | { kind: 'report_back'; ref: string; summary?: string };

export interface ProspectiveIntentionDefinition {
  /** Stable source identity. Usually produced by prospectiveIntentionId(). */
  id: string;
  sourceKind: ProspectiveSourceKind;
  sourceId: string;
  objective: string;
  trigger: ProspectiveTrigger;
  action: ProspectiveAction;
  sessionId?: string;
  goalId?: string;
  workflowName?: string;
  risk?: ProspectiveRisk;
  approvalMode?: ProspectiveApprovalMode;
  /** Recurring subscriptions re-arm after each accepted occurrence. */
  recurring?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ProspectiveIntention {
  id: string;
  sourceKind: ProspectiveSourceKind;
  sourceId: string;
  generation: number;
  definitionHash: string;
  objective: string;
  trigger: ProspectiveTrigger;
  action: ProspectiveAction;
  sessionId?: string;
  goalId?: string;
  workflowName?: string;
  risk: ProspectiveRisk;
  approvalMode: ProspectiveApprovalMode;
  recurring: boolean;
  status: ProspectiveStatus;
  dueAt?: string;
  lastCueAt?: string;
  lastCueKey?: string;
  lastOutcomeAt?: string;
  evidence?: Record<string, unknown>;
  cancellationReason?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ProspectiveOutcome = 'completed' | 'rearmed' | 'blocked' | 'failed' | 'cancelled';

export interface ProspectiveCueResult {
  intention: ProspectiveIntention | null;
  accepted: boolean;
  deduped: boolean;
}

export interface ProspectiveContextProjection {
  text: string;
  count: number;
  ids: string[];
  bytes: number;
}

export interface ProspectiveIntentionCounts {
  total: number;
  active: number;
  due: number;
  claimed: number;
  blocked: number;
  completed: number;
  cancelled: number;
}

interface IntentionRow {
  id: string;
  source_kind: ProspectiveSourceKind;
  source_id: string;
  generation: number;
  definition_hash: string;
  objective: string;
  trigger_json: string;
  action_json: string;
  session_id: string | null;
  goal_id: string | null;
  workflow_name: string | null;
  risk: ProspectiveRisk;
  approval_mode: ProspectiveApprovalMode;
  recurring: number;
  status: ProspectiveStatus;
  due_at: string | null;
  last_cue_at: string | null;
  last_cue_key: string | null;
  last_outcome_at: string | null;
  evidence_json: string | null;
  cancellation_reason: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEMA_VERSION = 1;
const MAX_EVENT_PAYLOAD_CHARS = 32_000;
const DEFAULT_CONTEXT_MAX_CHARS = 1_400;
const DEFAULT_CONTEXT_MAX_ITEMS = 6;
const ACTIVE_STATUSES: ReadonlySet<ProspectiveStatus> = new Set(['active', 'due', 'claimed', 'blocked']);
const TERMINAL_STATUSES: ReadonlySet<ProspectiveStatus> = new Set(['completed', 'cancelled']);
const CONTEXT_STOPWORDS: ReadonlySet<string> = new Set([
  'about', 'after', 'again', 'all', 'also', 'and', 'are', 'back', 'before', 'but', 'call',
  'calls', 'can', 'could', 'do', 'each', 'every', 'exactly', 'file', 'files',
  'for', 'from', 'give', 'have', 'into', 'item', 'items', 'later', 'me', 'my',
  'no', 'not', 'of', 'on', 'one', 'only', 'or', 'output', 'outputs', 'please',
  'real', 'return', 'run', 'running', 'task', 'tasks', 'test', 'tests', 'that',
  'the', 'then', 'this', 'to', 'tool', 'tools', 'use', 'using', 'what', 'when',
  'with', 'worker', 'workers', 'write', 'writes', 'you', 'your',
]);

let db: Database.Database | null = null;
let dbPath: string | null = null;

function databasePath(): string {
  return path.join(BASE_DIR, 'state', 'prospective-intentions.db');
}

export function prospectiveIntentionsEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_PROSPECTIVE_MEMORY', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

export function prospectiveIntentionId(sourceKind: ProspectiveSourceKind, sourceId: string): string {
  return `${sourceKind}:${sourceId.trim()}`;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`,
  ).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedJson(value: unknown, maxChars = MAX_EVENT_PAYLOAD_CHARS): string {
  let rendered: string;
  try {
    rendered = stableStringify(value);
  } catch {
    rendered = JSON.stringify({ unavailable: true });
  }
  if (rendered.length <= maxChars) return rendered;
  return JSON.stringify({
    clipped: true,
    sha256: sha256(rendered),
    preview: rendered.slice(0, Math.max(0, maxChars - 160)),
  });
}

function cuePayloadSummary(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  let rendered: string;
  try {
    rendered = stableStringify(value);
  } catch {
    rendered = JSON.stringify({ unavailable: true });
  }
  const kind = value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value;
  const keys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort().slice(0, 32)
    : undefined;
  return {
    sha256: sha256(rendered),
    bytes: Buffer.byteLength(rendered, 'utf-8'),
    kind,
    ...(keys && keys.length > 0 ? { keys } : {}),
  };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function openDb(): Database.Database {
  const wanted = databasePath();
  if (db && dbPath === wanted) return db;
  db?.close();
  mkdirSync(path.dirname(wanted), { recursive: true });
  db = new Database(wanted);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS prospective_intentions (
      id                   TEXT PRIMARY KEY,
      source_kind          TEXT NOT NULL,
      source_id            TEXT NOT NULL,
      generation           INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
      definition_hash      TEXT NOT NULL,
      objective            TEXT NOT NULL,
      trigger_json         TEXT NOT NULL,
      action_json          TEXT NOT NULL,
      session_id           TEXT,
      goal_id              TEXT,
      workflow_name        TEXT,
      risk                 TEXT NOT NULL DEFAULT 'inherits',
      approval_mode        TEXT NOT NULL DEFAULT 'enforce_at_action',
      recurring            INTEGER NOT NULL DEFAULT 0 CHECK (recurring IN (0,1)),
      status               TEXT NOT NULL DEFAULT 'active',
      due_at               TEXT,
      last_cue_at          TEXT,
      last_cue_key         TEXT,
      last_outcome_at      TEXT,
      evidence_json        TEXT,
      cancellation_reason  TEXT,
      metadata_json        TEXT,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      UNIQUE(source_kind, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_prospective_intentions_status_due
      ON prospective_intentions(status, due_at);
    CREATE INDEX IF NOT EXISTS idx_prospective_intentions_session
      ON prospective_intentions(session_id, status);
    CREATE INDEX IF NOT EXISTS idx_prospective_intentions_workflow
      ON prospective_intentions(workflow_name, status);

    CREATE TABLE IF NOT EXISTS prospective_intention_events (
      id            TEXT PRIMARY KEY,
      intention_id  TEXT NOT NULL REFERENCES prospective_intentions(id) ON DELETE CASCADE,
      generation    INTEGER NOT NULL,
      event_type    TEXT NOT NULL,
      cue_key       TEXT,
      payload_json  TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prospective_events_intention
      ON prospective_intention_events(intention_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS prospective_schema_meta (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO prospective_schema_meta (key, value) VALUES ('version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(SCHEMA_VERSION));
  dbPath = wanted;
  return db;
}

/** Test seam and environment-switch seam. */
export function closeProspectiveIntentionsDbForTest(): void {
  db?.close();
  db = null;
  dbPath = null;
}

function rowToIntention(row: IntentionRow): ProspectiveIntention {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    generation: row.generation,
    definitionHash: row.definition_hash,
    objective: row.objective,
    trigger: parseJson<ProspectiveTrigger>(row.trigger_json, { kind: 'manual' }),
    action: parseJson<ProspectiveAction>(row.action_json, { kind: 'notify' }),
    sessionId: row.session_id ?? undefined,
    goalId: row.goal_id ?? undefined,
    workflowName: row.workflow_name ?? undefined,
    risk: row.risk,
    approvalMode: row.approval_mode,
    recurring: row.recurring === 1,
    status: row.status,
    dueAt: row.due_at ?? undefined,
    lastCueAt: row.last_cue_at ?? undefined,
    lastCueKey: row.last_cue_key ?? undefined,
    lastOutcomeAt: row.last_outcome_at ?? undefined,
    evidence: parseJson<Record<string, unknown> | undefined>(row.evidence_json, undefined),
    cancellationReason: row.cancellation_reason ?? undefined,
    metadata: parseJson<Record<string, unknown> | undefined>(row.metadata_json, undefined),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function dueAtFor(trigger: ProspectiveTrigger): string | null {
  if (trigger.kind !== 'time') return null;
  const parsed = Date.parse(trigger.at);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeDefinition(input: ProspectiveIntentionDefinition): ProspectiveIntentionDefinition {
  const id = input.id.trim();
  const sourceId = input.sourceId.trim();
  const objective = input.objective.replace(/\s+/g, ' ').trim();
  if (!id) throw new Error('Prospective intention id is required.');
  if (!sourceId) throw new Error('Prospective intention sourceId is required.');
  if (!objective) throw new Error('Prospective intention objective is required.');
  return {
    ...input,
    id,
    sourceId,
    objective,
    sessionId: input.sessionId?.trim() || undefined,
    goalId: input.goalId?.trim() || undefined,
    workflowName: input.workflowName?.trim() || undefined,
    risk: input.risk ?? 'inherits',
    approvalMode: input.approvalMode ?? (input.risk === 'read' ? 'none' : 'enforce_at_action'),
    recurring: input.recurring === true,
  };
}

function definitionHash(input: ProspectiveIntentionDefinition): string {
  return sha256(stableStringify({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    objective: input.objective,
    trigger: input.trigger,
    action: input.action,
    sessionId: input.sessionId ?? null,
    goalId: input.goalId ?? null,
    workflowName: input.workflowName ?? null,
    risk: input.risk ?? 'inherits',
    approvalMode: input.approvalMode ?? 'enforce_at_action',
    recurring: input.recurring === true,
    metadata: input.metadata ?? null,
  }));
}

function appendEvent(
  database: Database.Database,
  input: {
    intentionId: string;
    generation: number;
    eventType: string;
    cueKey?: string;
    payload?: unknown;
    at: string;
    dedupe?: boolean;
  },
): boolean {
  const id = input.dedupe
    ? `pie-${sha256(`${input.intentionId}|${input.generation}|${input.eventType}|${input.cueKey ?? ''}`).slice(0, 32)}`
    : `pie-${randomUUID()}`;
  const inserted = database.prepare(`
    INSERT OR IGNORE INTO prospective_intention_events (
      id, intention_id, generation, event_type, cue_key, payload_json, created_at
    ) VALUES (@id, @intentionId, @generation, @eventType, @cueKey, @payloadJson, @at)
  `).run({
    id,
    intentionId: input.intentionId,
    generation: input.generation,
    eventType: input.eventType,
    cueKey: input.cueKey ?? null,
    payloadJson: input.payload === undefined ? null : boundedJson(input.payload),
    at: input.at,
  });
  return inserted.changes > 0;
}

export function upsertProspectiveIntention(
  raw: ProspectiveIntentionDefinition,
  now = new Date(),
): ProspectiveIntention | null {
  if (!prospectiveIntentionsEnabled()) return null;
  const input = normalizeDefinition(raw);
  const database = openDb();
  const nowIso = now.toISOString();
  const hash = definitionHash(input);
  // Hot-path fast no-op: daemon reconciliation and background progress writes
  // frequently present the same definition. Avoid even BEGIN IMMEDIATE so the
  // materialized index cannot introduce write-lock contention into execution.
  const snapshot = database.prepare('SELECT * FROM prospective_intentions WHERE id = ?')
    .get(input.id) as IntentionRow | undefined;
  if (
    snapshot
    && snapshot.definition_hash === hash
    && !TERMINAL_STATUSES.has(snapshot.status)
  ) {
    return rowToIntention(snapshot);
  }
  const transaction = database.transaction(() => {
    const existing = database.prepare('SELECT * FROM prospective_intentions WHERE id = ?')
      .get(input.id) as IntentionRow | undefined;
    if (!existing) {
      database.prepare(`
        INSERT INTO prospective_intentions (
          id, source_kind, source_id, generation, definition_hash, objective,
          trigger_json, action_json, session_id, goal_id, workflow_name,
          risk, approval_mode, recurring, status, due_at, metadata_json,
          created_at, updated_at
        ) VALUES (
          @id, @sourceKind, @sourceId, 1, @definitionHash, @objective,
          @triggerJson, @actionJson, @sessionId, @goalId, @workflowName,
          @risk, @approvalMode, @recurring, 'active', @dueAt, @metadataJson,
          @now, @now
        )
      `).run({
        id: input.id,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        definitionHash: hash,
        objective: input.objective,
        triggerJson: stableStringify(input.trigger),
        actionJson: stableStringify(input.action),
        sessionId: input.sessionId ?? null,
        goalId: input.goalId ?? null,
        workflowName: input.workflowName ?? null,
        risk: input.risk,
        approvalMode: input.approvalMode,
        recurring: input.recurring ? 1 : 0,
        dueAt: dueAtFor(input.trigger),
        metadataJson: input.metadata ? boundedJson(input.metadata) : null,
        now: nowIso,
      });
      appendEvent(database, {
        intentionId: input.id,
        generation: 1,
        eventType: 'created',
        payload: { definitionHash: hash },
        at: nowIso,
      });
    } else {
      const terminal = TERMINAL_STATUSES.has(existing.status);
      const revised = existing.definition_hash !== hash || terminal;
      // The daemon reconciles on a short cadence. An unchanged source snapshot
      // must be a true no-op (no WAL churn, no timestamp churn, no prompt-cache
      // invalidation).
      if (!revised) return rowToIntention(existing);
      const generation = revised ? existing.generation + 1 : existing.generation;
      database.prepare(`
        UPDATE prospective_intentions
        SET source_kind = @sourceKind,
            source_id = @sourceId,
            generation = @generation,
            definition_hash = @definitionHash,
            objective = @objective,
            trigger_json = @triggerJson,
            action_json = @actionJson,
            session_id = @sessionId,
            goal_id = @goalId,
            workflow_name = @workflowName,
            risk = @risk,
            approval_mode = @approvalMode,
            recurring = @recurring,
            status = CASE WHEN @revised = 1 THEN 'active' ELSE status END,
            due_at = @dueAt,
            last_cue_at = CASE WHEN @revised = 1 THEN NULL ELSE last_cue_at END,
            last_cue_key = CASE WHEN @revised = 1 THEN NULL ELSE last_cue_key END,
            cancellation_reason = CASE WHEN @revised = 1 THEN NULL ELSE cancellation_reason END,
            metadata_json = @metadataJson,
            updated_at = @now
        WHERE id = @id
      `).run({
        id: input.id,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        generation,
        definitionHash: hash,
        objective: input.objective,
        triggerJson: stableStringify(input.trigger),
        actionJson: stableStringify(input.action),
        sessionId: input.sessionId ?? null,
        goalId: input.goalId ?? null,
        workflowName: input.workflowName ?? null,
        risk: input.risk,
        approvalMode: input.approvalMode,
        recurring: input.recurring ? 1 : 0,
        revised: revised ? 1 : 0,
        dueAt: dueAtFor(input.trigger),
        metadataJson: input.metadata ? boundedJson(input.metadata) : null,
        now: nowIso,
      });
      if (revised) {
        appendEvent(database, {
          intentionId: input.id,
          generation,
          eventType: terminal ? 'reactivated' : 'revised',
          payload: { previousGeneration: existing.generation, definitionHash: hash },
          at: nowIso,
        });
      }
    }
    return rowToIntention(
      database.prepare('SELECT * FROM prospective_intentions WHERE id = ?').get(input.id) as IntentionRow,
    );
  });
  return transaction.immediate();
}

export function getProspectiveIntention(id: string): ProspectiveIntention | null {
  if (!prospectiveIntentionsEnabled() || !existsSync(databasePath())) return null;
  const row = openDb().prepare('SELECT * FROM prospective_intentions WHERE id = ?')
    .get(id) as IntentionRow | undefined;
  return row ? rowToIntention(row) : null;
}

export function listProspectiveIntentions(options: {
  statuses?: ProspectiveStatus[];
  sourceKind?: ProspectiveSourceKind;
  sessionId?: string;
  limit?: number;
} = {}): ProspectiveIntention[] {
  if (!prospectiveIntentionsEnabled() || !existsSync(databasePath())) return [];
  const statuses = options.statuses ? [...new Set(options.statuses)] : null;
  if (statuses?.length === 0) return [];
  const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 250)));
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (statuses) {
    clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  if (options.sourceKind) {
    clauses.push('source_kind = ?');
    params.push(options.sourceKind);
  }
  if (options.sessionId) {
    clauses.push('session_id = ?');
    params.push(options.sessionId);
  }
  params.push(limit);
  const rows = openDb().prepare(`
    SELECT * FROM prospective_intentions
    ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY
      CASE status WHEN 'due' THEN 0 WHEN 'blocked' THEN 1 WHEN 'claimed' THEN 2 ELSE 3 END,
      COALESCE(due_at, updated_at) ASC,
      updated_at DESC
    LIMIT ?
  `).all(...params) as IntentionRow[];
  return rows.map(rowToIntention);
}

export function countProspectiveIntentions(
  options: { sourceKind?: ProspectiveSourceKind } = {},
): ProspectiveIntentionCounts {
  const empty: ProspectiveIntentionCounts = {
    total: 0,
    active: 0,
    due: 0,
    claimed: 0,
    blocked: 0,
    completed: 0,
    cancelled: 0,
  };
  if (!prospectiveIntentionsEnabled() || !existsSync(databasePath())) return empty;
  const where = options.sourceKind ? 'WHERE source_kind = ?' : '';
  const params = options.sourceKind ? [options.sourceKind] : [];
  const row = openDb().prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'due' THEN 1 ELSE 0 END) AS due,
      SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
      SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
    FROM prospective_intentions
    ${where}
  `).get(...params) as Partial<ProspectiveIntentionCounts> | undefined;
  return {
    total: Number(row?.total ?? 0),
    active: Number(row?.active ?? 0),
    due: Number(row?.due ?? 0),
    claimed: Number(row?.claimed ?? 0),
    blocked: Number(row?.blocked ?? 0),
    completed: Number(row?.completed ?? 0),
    cancelled: Number(row?.cancelled ?? 0),
  };
}

export function cancelProspectiveIntention(
  id: string,
  reason: string,
  now = new Date(),
): ProspectiveIntention | null {
  if (!prospectiveIntentionsEnabled() || !existsSync(databasePath())) return null;
  const database = openDb();
  const nowIso = now.toISOString();
  const transaction = database.transaction(() => {
    const row = database.prepare('SELECT * FROM prospective_intentions WHERE id = ?')
      .get(id) as IntentionRow | undefined;
    if (!row) return null;
    if (row.status === 'cancelled') return rowToIntention(row);
    if (row.status === 'completed') return rowToIntention(row);
    database.prepare(`
      UPDATE prospective_intentions
      SET status = 'cancelled', cancellation_reason = ?, updated_at = ?, last_outcome_at = ?
      WHERE id = ?
    `).run(reason.trim() || 'cancelled', nowIso, nowIso, id);
    appendEvent(database, {
      intentionId: id,
      generation: row.generation,
      eventType: 'cancelled',
      payload: { reason: reason.trim() || 'cancelled' },
      at: nowIso,
    });
    return rowToIntention(
      database.prepare('SELECT * FROM prospective_intentions WHERE id = ?').get(id) as IntentionRow,
    );
  });
  return transaction.immediate();
}

export function reconcileProspectiveIntentions(
  sourceKind: ProspectiveSourceKind,
  definitions: ProspectiveIntentionDefinition[],
  now = new Date(),
): { upserted: number; cancelled: number } {
  if (!prospectiveIntentionsEnabled()) return { upserted: 0, cancelled: 0 };
  const wanted = new Set<string>();
  let upserted = 0;
  for (const definition of definitions) {
    if (definition.sourceKind !== sourceKind) {
      throw new Error(`Prospective reconciliation source mismatch: expected ${sourceKind}, got ${definition.sourceKind}.`);
    }
    wanted.add(definition.id);
    if (upsertProspectiveIntention(definition, now)) upserted += 1;
  }
  if (!existsSync(databasePath())) return { upserted, cancelled: 0 };
  let cancelled = 0;
  const current = listProspectiveIntentions({
    sourceKind,
    statuses: [...ACTIVE_STATUSES],
    limit: 1_000,
  });
  for (const intention of current) {
    if (!ACTIVE_STATUSES.has(intention.status) || wanted.has(intention.id)) continue;
    if (cancelProspectiveIntention(intention.id, 'source_removed_or_disabled', now)) cancelled += 1;
  }
  return { upserted, cancelled };
}

export function recordProspectiveCue(
  id: string,
  cueKey: string,
  payload?: unknown,
  now = new Date(),
): ProspectiveCueResult {
  if (!prospectiveIntentionsEnabled() || !existsSync(databasePath())) {
    return { intention: null, accepted: false, deduped: false };
  }
  const database = openDb();
  const nowIso = now.toISOString();
  const normalizedCueKey = cueKey.trim();
  if (!normalizedCueKey) return { intention: getProspectiveIntention(id), accepted: false, deduped: false };
  const transaction = database.transaction((): ProspectiveCueResult => {
    const row = database.prepare('SELECT * FROM prospective_intentions WHERE id = ?')
      .get(id) as IntentionRow | undefined;
    if (!row || TERMINAL_STATUSES.has(row.status)) {
      return { intention: row ? rowToIntention(row) : null, accepted: false, deduped: false };
    }
    const accepted = appendEvent(database, {
      intentionId: id,
      generation: row.generation,
      eventType: 'cue',
      cueKey: normalizedCueKey,
      // The authoritative event/trigger store owns raw payloads. The
      // prospective index needs only a replay-safe fingerprint and shape;
      // duplicating webhook bodies here would retain PII and waste disk.
      payload: cuePayloadSummary(payload),
      at: nowIso,
      dedupe: true,
    });
    if (!accepted) {
      return { intention: rowToIntention(row), accepted: false, deduped: true };
    }
    database.prepare(`
      UPDATE prospective_intentions
      SET status = 'due', last_cue_at = ?, last_cue_key = ?, updated_at = ?
      WHERE id = ?
    `).run(nowIso, normalizedCueKey, nowIso, id);
    const updated = database.prepare('SELECT * FROM prospective_intentions WHERE id = ?')
      .get(id) as IntentionRow;
    return { intention: rowToIntention(updated), accepted: true, deduped: false };
  });
  return transaction.immediate();
}

export function claimProspectiveIntention(
  id: string,
  cueKey: string,
  owner: string,
  now = new Date(),
): ProspectiveIntention | null {
  if (!prospectiveIntentionsEnabled() || !existsSync(databasePath())) return null;
  const database = openDb();
  const nowIso = now.toISOString();
  const transaction = database.transaction(() => {
    const row = database.prepare('SELECT * FROM prospective_intentions WHERE id = ?')
      .get(id) as IntentionRow | undefined;
    if (!row || row.status !== 'due' || row.last_cue_key !== cueKey) return null;
    const changed = database.prepare(`
      UPDATE prospective_intentions SET status = 'claimed', updated_at = ?
      WHERE id = ? AND generation = ? AND status = 'due' AND last_cue_key = ?
    `).run(nowIso, id, row.generation, cueKey);
    if (changed.changes === 0) return null;
    appendEvent(database, {
      intentionId: id,
      generation: row.generation,
      eventType: 'claimed',
      cueKey,
      payload: { owner },
      at: nowIso,
      dedupe: true,
    });
    return rowToIntention(
      database.prepare('SELECT * FROM prospective_intentions WHERE id = ?').get(id) as IntentionRow,
    );
  });
  return transaction.immediate();
}

export function recordProspectiveOutcome(
  id: string,
  outcome: ProspectiveOutcome,
  evidence: Record<string, unknown> = {},
  now = new Date(),
): ProspectiveIntention | null {
  if (!prospectiveIntentionsEnabled() || !existsSync(databasePath())) return null;
  const database = openDb();
  const nowIso = now.toISOString();
  const transaction = database.transaction(() => {
    const row = database.prepare('SELECT * FROM prospective_intentions WHERE id = ?')
      .get(id) as IntentionRow | undefined;
    if (!row) return null;
    if (TERMINAL_STATUSES.has(row.status) && outcome !== 'rearmed') return rowToIntention(row);
    const nextStatus: ProspectiveStatus =
      outcome === 'cancelled'
        ? 'cancelled'
        : outcome === 'blocked' || outcome === 'failed'
          ? 'blocked'
          : outcome === 'rearmed' || row.recurring
            ? 'active'
            : 'completed';
    database.prepare(`
      UPDATE prospective_intentions
      SET status = @status,
          last_outcome_at = @now,
          evidence_json = @evidence,
          cancellation_reason = CASE WHEN @status = 'cancelled' THEN COALESCE(@reason, 'cancelled') ELSE NULL END,
          updated_at = @now
      WHERE id = @id
    `).run({
      id,
      status: nextStatus,
      now: nowIso,
      evidence: boundedJson(evidence),
      reason: typeof evidence.reason === 'string' ? evidence.reason : null,
    });
    appendEvent(database, {
      intentionId: id,
      generation: row.generation,
      eventType: outcome,
      cueKey: row.last_cue_key ?? undefined,
      payload: evidence,
      at: nowIso,
    });
    return rowToIntention(
      database.prepare('SELECT * FROM prospective_intentions WHERE id = ?').get(id) as IntentionRow,
    );
  });
  return transaction.immediate();
}

export function prospectiveFilterMatches(
  filter: Record<string, string | number | boolean> | undefined,
  payload: unknown,
): boolean {
  for (const [key, expected] of Object.entries(filter ?? {})) {
    let cursor: unknown = payload;
    for (const segment of key.split('.')) {
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    if (cursor !== expected) return false;
  }
  return true;
}

/**
 * Record an external/system event against matching subscriptions. This is an
 * observability/control-plane operation only; source engines still own dispatch.
 */
export function recordProspectiveEvent(
  eventType: string,
  payload: unknown,
  options: { cueKey?: string; now?: Date } = {},
): ProspectiveCueResult[] {
  const type = eventType.trim();
  if (!type) return [];
  const now = options.now ?? new Date();
  const payloadHash = sha256(stableStringify(payload));
  const results: ProspectiveCueResult[] = [];
  for (const intention of listProspectiveIntentions({
    statuses: ['active', 'due', 'claimed', 'blocked'],
    limit: 1_000,
  })) {
    if (intention.trigger.kind !== 'event') continue;
    if (intention.trigger.eventType !== type) continue;
    if (!prospectiveFilterMatches(intention.trigger.filter, payload)) continue;
    results.push(recordProspectiveCue(
      intention.id,
      options.cueKey ?? `event:${type}:${payloadHash}`,
      payload,
      now,
    ));
  }
  return results;
}

export function activateDueProspectiveIntentions(now = new Date()): ProspectiveCueResult[] {
  const nowMs = now.getTime();
  const results: ProspectiveCueResult[] = [];
  for (const intention of listProspectiveIntentions({
    statuses: ['active'],
    limit: 1_000,
  })) {
    if (!intention.dueAt) continue;
    const dueMs = Date.parse(intention.dueAt);
    if (!Number.isFinite(dueMs) || dueMs > nowMs) continue;
    results.push(recordProspectiveCue(
      intention.id,
      `time:${intention.dueAt}`,
      { dueAt: intention.dueAt },
      now,
    ));
  }
  return results;
}

function words(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])
      .filter((word) => !CONTEXT_STOPWORDS.has(word)),
  );
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const word of a) if (b.has(word)) count += 1;
  return count;
}

function overviewQuery(query: string): boolean {
  const explicitCollection =
    /\b(?:future intentions?|my reminders?|all reminders?|upcoming commitments?|scheduled commitments?|pending commitments?)\b/i.test(query);
  const genericStatus =
    /\bwhat (?:am i|are you) (?:waiting|watching|doing)\s*[?.!]*$/i.test(query)
    || /\bwhat(?:'s| is) next\s*[?.!]*$/i.test(query);
  return explicitCollection || genericStatus;
}

function followUpQuery(query: string): boolean {
  return /\b(?:status|progress|update|continue|resume|how(?:'s| is) it going|what happened)\b/i.test(query);
}

function renderTrigger(trigger: ProspectiveTrigger): string {
  if (trigger.kind === 'time') return `at ${trigger.at}${trigger.timezone ? ` (${trigger.timezone})` : ''}`;
  if (trigger.kind === 'cron') return `cron ${trigger.expression}${trigger.timezone ? ` (${trigger.timezone})` : ''}`;
  if (trigger.kind === 'event') return `when ${trigger.eventType}${Object.keys(trigger.filter ?? {}).length ? ' matches its filter' : ''}`;
  if (trigger.kind === 'webhook') return `when webhook /${trigger.path.replace(/^\/+/, '')} arrives`;
  if (trigger.kind === 'state') return `while watching ${trigger.channel}`;
  if (trigger.kind === 'completion') return `when ${trigger.resourceType}:${trigger.resourceId} completes`;
  return 'when manually resumed';
}

/**
 * Bounded model-facing projection. It is empty for ordinary unrelated turns:
 * global future commitments never become another every-turn prompt tax.
 */
export function buildProspectiveIntentionContext(input: {
  query: string;
  sessionId?: string;
  now?: Date;
  maxChars?: number;
  maxItems?: number;
}): ProspectiveContextProjection {
  const empty: ProspectiveContextProjection = { text: '', count: 0, ids: [], bytes: 0 };
  if (!prospectiveIntentionsEnabled() || !existsSync(databasePath())) return empty;
  const query = input.query.replace(/\s+/g, ' ').trim();
  if (!query) return empty;
  const queryWords = words(query);
  const overview = overviewQuery(query);
  const followUp = followUpQuery(query);
  const prospectiveLanguage = Boolean(prospectiveCaptureDirective(query));
  const nowMs = (input.now ?? new Date()).getTime();

  const ranked = listProspectiveIntentions({
    statuses: ['active', 'due', 'claimed', 'blocked'],
    limit: 500,
  }).map((intention) => {
    const haystack = [
      intention.objective,
      intention.workflowName,
      intention.goalId,
      intention.action.ref,
      intention.trigger.kind === 'event' ? intention.trigger.eventType : '',
    ].filter(Boolean).join(' ');
    const overlap = overlapCount(queryWords, words(haystack));
    const sameSession = Boolean(input.sessionId && intention.sessionId === input.sessionId);
    const due = intention.status === 'due'
      || (intention.dueAt ? Date.parse(intention.dueAt) <= nowMs : false);
    const blocked = intention.status === 'blocked';
    // Ambient standing monitors are implementation detail unless the user asks
    // for their proactive/watch state explicitly.
    const monitorRelevant = intention.sourceKind !== 'monitor'
      || overview
      || /\b(?:monitor|watch|inbox|calendar)\b/i.test(query);
    const sessionRelevant = sameSession && (
      overview
      || followUp
      || overlap >= 1
      || due
      || blocked
    );
    const eligible = monitorRelevant && (
      sessionRelevant
      || overview
      || overlap >= 2
      || (prospectiveLanguage && overlap >= 1)
      || ((due || blocked) && overlap >= 1)
    );
    const score = (sameSession ? 20 : 0)
      + (overview ? 8 : 0)
      + overlap * 4
      + (due ? 3 : 0)
      + (blocked ? 2 : 0);
    return { intention, eligible, score };
  }).filter((item) => item.eligible)
    .sort((a, b) => b.score - a.score || a.intention.updatedAt.localeCompare(b.intention.updatedAt))
    .slice(0, Math.max(1, Math.min(12, input.maxItems ?? DEFAULT_CONTEXT_MAX_ITEMS)));

  if (ranked.length === 0) return empty;
  const maxChars = Math.max(500, Math.min(4_000, input.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS));
  const lines = [
    '[RELEVANT FUTURE INTENTIONS — durable, versioned state]',
    'Use these only when relevant. A cue is not permission: current approval and external-write gates still apply. Updates/cancellations supersede older generations.',
  ];
  const ids: string[] = [];
  let chars = lines.join('\n').length;
  for (const { intention } of ranked) {
    const state = intention.status.toUpperCase();
    const line = `- [${state}] ${intention.objective} — ${renderTrigger(intention.trigger)}; action: ${intention.action.kind}${intention.action.ref ? ` ${intention.action.ref}` : ''}; ref ${intention.id}@${intention.generation}`;
    if (chars + line.length + 1 > maxChars) continue;
    lines.push(line);
    ids.push(intention.id);
    chars += line.length + 1;
  }
  if (ids.length === 0) return empty;
  const text = lines.join('\n');
  return { text, count: ids.length, ids, bytes: Buffer.byteLength(text, 'utf-8') };
}

/**
 * Conditional capture steer. It appears only when the user's own words contain
 * a concrete future cue, so prospective reliability does not become another
 * permanent rubric paragraph.
 */
export function prospectiveCaptureDirective(input: string): string | null {
  const text = input.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const explicitReminder =
    /\b(?:remind me|don't let me forget|do not let me forget|set (?:a )?(?:timer|reminder)|follow up with me)\b/i.test(text);
  const standingWatch =
    /\b(?:keep (?:an eye on|watching|checking|monitoring)|watch for|notify me (?:when|if)|tell me (?:when|if))\b/i.test(text);
  const eventAction =
    /\b(?:when|whenever|once|as soon as)\b.{2,140}\b(?:notify|remind|tell|send|run|start|create|update|follow up|check)\b/i.test(text);
  const scheduledAction =
    /\b(?:schedule|automate|run)\b.{0,100}\b(?:daily|weekly|monthly|every\s+\d+|tomorrow|next\s+(?:week|month)|at\s+\d{1,2}(?::\d{2})?)\b/i.test(text);
  const explanationOnly =
    /^(?:how\b|what\b|why\b|when\s+(?:should|do|does|can|would)\b|explain\b|tell me how\b|show me how\b)/i.test(text);
  if (explanationOnly && !explicitReminder && !standingWatch) return null;
  if (!explicitReminder && !standingWatch && !eventAction && !scheduledAction) return null;
  return (
    'Prospective-intention signal: this request contains a future cue. Do not rely on chat memory or merely promise it. '
    + 'Persist it through the matching existing capability (one-shot timer, self-driving goal, or scheduled/event workflow). '
    + 'An update or cancellation must revise the existing commitment, not create a competing duplicate.'
  );
}
