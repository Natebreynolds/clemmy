import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export const WORKFLOW_TRIGGER_SCHEMA_VERSION = 4;

export const WORKFLOW_TRIGGER_TABLES = [
  'workflow_triggers',
  'workflow_trigger_events',
] as const;

export type WorkflowTriggerTableName = (typeof WORKFLOW_TRIGGER_TABLES)[number];

export type WorkflowTriggerKind = 'manual' | 'schedule' | 'webhook' | 'system_event';

/**
 * Durable ingestion state for one trigger delivery.
 *
 * `pending` is intentionally retryable: the receipt exists, but the run queue
 * has not accepted it yet (or the process crashed before recording acceptance).
 * `enqueued` is terminal for dedupe purposes, including when the shared queue
 * reports that an equivalent run was already queued/running. Transient
 * readiness and queue failures must never transition there.
 */
export type WorkflowTriggerEventState = 'pending' | 'enqueued' | 'cancelled' | 'needs_verification';

export interface WorkflowTriggerDescriptor {
  workflowName: string;
  kind: WorkflowTriggerKind;
  schedule?: string;
  timezone?: string;
  webhookPath?: string;
  eventType?: string;
  filter?: Record<string, unknown>;
  dedupeKeyTemplate?: string;
  enabled?: boolean;
}

/**
 * Trigger registry for the DAG runner.
 *
 * Existing schedule/webhook/manual paths can compile into this schema first,
 * then the runner can use one enqueue path with deterministic dedupe.
 */
export const WORKFLOW_TRIGGER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflow_triggers (
  id                   TEXT PRIMARY KEY,
  workflow_name        TEXT NOT NULL,
  graph_id             TEXT,
  kind                 TEXT NOT NULL CHECK (kind IN ('manual','schedule','webhook','system_event')),
  schedule             TEXT,
  timezone             TEXT,
  webhook_path         TEXT,
  event_type           TEXT,
  filter_json          TEXT NOT NULL DEFAULT '{}',
  dedupe_key_template  TEXT,
  enabled              INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  generation           INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (
    (kind = 'manual')
    OR (kind = 'schedule' AND schedule IS NOT NULL)
    OR (kind = 'webhook' AND webhook_path IS NOT NULL)
    OR (kind = 'system_event' AND event_type IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_workflow_triggers_workflow
  ON workflow_triggers(workflow_name, enabled);
CREATE INDEX IF NOT EXISTS idx_workflow_triggers_schedule
  ON workflow_triggers(schedule, timezone, enabled) WHERE kind = 'schedule';
CREATE INDEX IF NOT EXISTS idx_workflow_triggers_webhook
  ON workflow_triggers(webhook_path, enabled) WHERE kind = 'webhook';
CREATE INDEX IF NOT EXISTS idx_workflow_triggers_system_event
  ON workflow_triggers(event_type, enabled) WHERE kind = 'system_event';

CREATE TABLE IF NOT EXISTS workflow_trigger_events (
  id                TEXT PRIMARY KEY,
  trigger_id        TEXT NOT NULL REFERENCES workflow_triggers(id) ON DELETE CASCADE,
  fired_at          TEXT NOT NULL,
  dedupe_key        TEXT NOT NULL,
  payload_hash      TEXT NOT NULL,
  payload_json      TEXT NOT NULL DEFAULT '{}',
  run_id            TEXT,
  deduped           INTEGER NOT NULL DEFAULT 0 CHECK (deduped IN (0,1)),
  state             TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','enqueued','cancelled','needs_verification')),
  attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at   TEXT,
  next_attempt_at   TEXT,
  last_error        TEXT,
  claim_token       TEXT,
  claim_expires_at  TEXT,
  trigger_generation INTEGER NOT NULL DEFAULT 1 CHECK (trigger_generation >= 1),
  enqueued_at       TEXT,
  updated_at        TEXT,
  UNIQUE(trigger_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_workflow_trigger_events_fired
  ON workflow_trigger_events(fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_trigger_events_run
  ON workflow_trigger_events(run_id) WHERE run_id IS NOT NULL;
`;

/**
 * Apply the current schema and upgrade a v1 trigger database in place.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot add columns to an existing SQLite
 * table, so the engine must use this helper rather than executing the schema
 * string alone. Historical rows with a run id were accepted by the old queue
 * path and remain terminally deduped. Historical rows without one are exactly
 * the ambiguous readiness/error/crash window this migration repairs, so they
 * become retryable pending receipts. A legacy non-null run_id is not durable
 * proof that its old, non-fsynced run file survived; those rows require
 * verification rather than being silently declared accepted.
 */
export function ensureWorkflowTriggerSchema(database: Database.Database): void {
  database.exec(WORKFLOW_TRIGGER_SCHEMA_SQL);
  const triggerAdditions: Array<[name: string, sql: string]> = [
    ['generation', 'INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1)'],
  ];
  const additions: Array<[name: string, sql: string]> = [
    ['state', "TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','enqueued','cancelled','needs_verification'))"],
    ['attempt_count', 'INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)'],
    ['last_attempt_at', 'TEXT'],
    ['next_attempt_at', 'TEXT'],
    ['last_error', 'TEXT'],
    ['claim_token', 'TEXT'],
    ['claim_expires_at', 'TEXT'],
    ['trigger_generation', 'INTEGER NOT NULL DEFAULT 1 CHECK (trigger_generation >= 1)'],
    ['enqueued_at', 'TEXT'],
    ['updated_at', 'TEXT'],
  ];

  const migrate = database.transaction(() => {
    // Introspect only after acquiring the write lock. A standalone webhook and
    // daemon may open the same v1 database concurrently; caching this snapshot
    // before BEGIN IMMEDIATE lets both attempt the same ALTER TABLE.
    const existingTriggerColumns = new Set(
      (database.prepare('PRAGMA table_info(workflow_triggers)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    for (const [name, definition] of triggerAdditions) {
      if (existingTriggerColumns.has(name)) continue;
      database.exec(`ALTER TABLE workflow_triggers ADD COLUMN ${name} ${definition}`);
    }

    const existingColumns = new Set(
      (database.prepare('PRAGMA table_info(workflow_trigger_events)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    const hadState = existingColumns.has('state');
    for (const [name, definition] of additions) {
      if (existingColumns.has(name)) continue;
      database.exec(`ALTER TABLE workflow_trigger_events ADD COLUMN ${name} ${definition}`);
    }
    if (!hadState) {
      database.prepare(`
        UPDATE workflow_trigger_events
        SET state = CASE WHEN run_id IS NOT NULL THEN 'needs_verification' ELSE 'pending' END,
            enqueued_at = NULL,
            updated_at = fired_at
      `).run();
    }

    // V2's table-level CHECK allowed only pending/enqueued. SQLite cannot
    // widen a CHECK in place, so rebuild once to add explicit terminal states
    // for obsolete configuration and unverifiable legacy acceptance.
    const tableSql = (database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_trigger_events'",
    ).get() as { sql?: string } | undefined)?.sql ?? '';
    if (!tableSql.includes("'cancelled'") || !tableSql.includes("'needs_verification'")) {
      database.exec(`
        CREATE TABLE workflow_trigger_events_v3 (
          id                TEXT PRIMARY KEY,
          trigger_id        TEXT NOT NULL REFERENCES workflow_triggers(id) ON DELETE CASCADE,
          fired_at          TEXT NOT NULL,
          dedupe_key        TEXT NOT NULL,
          payload_hash      TEXT NOT NULL,
          payload_json      TEXT NOT NULL DEFAULT '{}',
          run_id            TEXT,
          deduped           INTEGER NOT NULL DEFAULT 0 CHECK (deduped IN (0,1)),
          state             TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','enqueued','cancelled','needs_verification')),
          attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          last_attempt_at   TEXT,
          next_attempt_at   TEXT,
          last_error        TEXT,
          claim_token       TEXT,
          claim_expires_at  TEXT,
          trigger_generation INTEGER NOT NULL DEFAULT 1 CHECK (trigger_generation >= 1),
          enqueued_at       TEXT,
          updated_at        TEXT,
          UNIQUE(trigger_id, dedupe_key)
        );
        INSERT INTO workflow_trigger_events_v3 (
          id, trigger_id, fired_at, dedupe_key, payload_hash, payload_json,
          run_id, deduped, state, attempt_count, last_attempt_at,
          next_attempt_at, last_error, claim_token, claim_expires_at,
          trigger_generation, enqueued_at, updated_at
        )
        SELECT
          id, trigger_id, fired_at, dedupe_key, payload_hash, payload_json,
          run_id, deduped,
          CASE WHEN state IN ('pending','enqueued') THEN state ELSE 'needs_verification' END,
          attempt_count, last_attempt_at, next_attempt_at, last_error,
          claim_token, claim_expires_at, trigger_generation, enqueued_at, updated_at
        FROM workflow_trigger_events;
        DROP TABLE workflow_trigger_events;
        ALTER TABLE workflow_trigger_events_v3 RENAME TO workflow_trigger_events;
      `);
    }
  });
  migrate.immediate();

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflow_trigger_events_fired
      ON workflow_trigger_events(fired_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_trigger_events_run
      ON workflow_trigger_events(run_id) WHERE run_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_workflow_trigger_events_pending
      ON workflow_trigger_events(state, next_attempt_at, claim_expires_at)
      WHERE state = 'pending';
  `);
}

export function validateWorkflowTriggerDescriptor(trigger: WorkflowTriggerDescriptor): string[] {
  const errors: string[] = [];
  if (!trigger.workflowName.trim()) errors.push('workflowName is required.');
  if (trigger.kind === 'schedule' && !trigger.schedule?.trim()) {
    errors.push('schedule trigger requires schedule.');
  }
  if (trigger.kind === 'webhook' && !trigger.webhookPath?.trim()) {
    errors.push('webhook trigger requires webhookPath.');
  }
  if (trigger.kind === 'system_event' && !trigger.eventType?.trim()) {
    errors.push('system_event trigger requires eventType.');
  }
  return errors;
}

export function workflowTriggerPayloadHash(payload: unknown): string {
  return sha256(stableStringify(payload));
}

export function workflowTriggerDedupeKey(
  trigger: Pick<WorkflowTriggerDescriptor, 'workflowName' | 'kind' | 'dedupeKeyTemplate'>,
  payload: unknown,
): string {
  const template = trigger.dedupeKeyTemplate?.trim();
  if (template) {
    return renderDedupeTemplate(template, payload);
  }
  return `${trigger.kind}:${trigger.workflowName}:${workflowTriggerPayloadHash(payload)}`;
}

export function renderDedupeTemplate(template: string, payload: unknown): string {
  return template.replace(/\{\{\s*payload\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, path: string) => {
    const value = readPath(payload, path);
    return value == null ? '' : String(value);
  });
}

function readPath(value: unknown, dottedPath: string): unknown {
  let current = value;
  for (const segment of dottedPath.split('.')) {
    if (!segment) return undefined;
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
