import { createHash } from 'node:crypto';

export const WORKFLOW_TRIGGER_SCHEMA_VERSION = 1;

export const WORKFLOW_TRIGGER_TABLES = [
  'workflow_triggers',
  'workflow_trigger_events',
] as const;

export type WorkflowTriggerTableName = (typeof WORKFLOW_TRIGGER_TABLES)[number];

export type WorkflowTriggerKind = 'manual' | 'schedule' | 'webhook' | 'system_event';

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
  id             TEXT PRIMARY KEY,
  trigger_id     TEXT NOT NULL REFERENCES workflow_triggers(id) ON DELETE CASCADE,
  fired_at       TEXT NOT NULL,
  dedupe_key     TEXT NOT NULL,
  payload_hash   TEXT NOT NULL,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  run_id         TEXT,
  deduped        INTEGER NOT NULL DEFAULT 0 CHECK (deduped IN (0,1)),
  UNIQUE(trigger_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_workflow_trigger_events_fired
  ON workflow_trigger_events(fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_trigger_events_run
  ON workflow_trigger_events(run_id) WHERE run_id IS NOT NULL;
`;

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
