/**
 * T2.1 — the CONSUMER for the workflow trigger registry.
 *
 * `workflow-trigger-registry.ts` shipped the schema + dedupe helpers with zero
 * runtime consumers ("designed but dark"); only cron fired workflows. This
 * module is the missing engine: it compiles each enabled workflow's declared
 * `trigger.events` / `trigger.webhookPath` into registry rows, and fires
 * matching workflows when a system event is emitted or a webhook lands —
 * through the SAME queueWorkflowRun path (and dedupe) every other enqueue
 * source uses.
 *
 * "When a new lead arrives, run X" becomes engine machinery instead of an LLM
 * prompt pattern. Producers call fireWorkflowSystemEvent() — composio trigger
 * listeners, watchers, other workflows — and the HTTP route in
 * channels/webhook.ts calls fireWorkflowWebhook().
 *
 * Dedupe is two-layer, both deterministic code:
 *   1. workflow_trigger_events UNIQUE(trigger_id, dedupe_key) — the same
 *      rendered dedupe key never fires twice, ever (cross-restart, SQLite).
 *   2. queueWorkflowRun's same-inputs queue dedupe — identical queued/running
 *      runs are not duplicated.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { listWorkflows, type WorkflowDefinition } from '../memory/workflow-store.js';
import { queueWorkflowRun } from '../tools/workflow-run-queue.js';
import {
  WORKFLOW_TRIGGER_SCHEMA_SQL,
  workflowTriggerDedupeKey,
  workflowTriggerPayloadHash,
  type WorkflowTriggerKind,
} from './workflow-trigger-registry.js';

const logger = pino({ name: 'clementine-next.workflow-trigger-engine' });

let db: Database.Database | null = null;
let dbPath: string | null = null;

function triggerDbPath(): string {
  return path.join(BASE_DIR, 'state', 'workflow-triggers.db');
}

function openTriggerDb(): Database.Database {
  const wanted = triggerDbPath();
  if (db && dbPath === wanted) return db;
  db?.close();
  mkdirSync(path.dirname(wanted), { recursive: true });
  db = new Database(wanted);
  db.pragma('journal_mode = WAL');
  db.exec(WORKFLOW_TRIGGER_SCHEMA_SQL);
  dbPath = wanted;
  return db;
}

/** Test hook: close the handle so a new CLEMENTINE_HOME takes effect. */
export function closeWorkflowTriggerDbForTest(): void {
  db?.close();
  db = null;
  dbPath = null;
}

function triggerRowId(workflowName: string, kind: WorkflowTriggerKind, key: string): string {
  return `${kind}:${workflowName}:${key}`;
}

function eventTriggerRowKey(type: string, filter: Record<string, unknown>, dedupeKeyTemplate?: string): string {
  const signature = workflowTriggerPayloadHash({
    type,
    filter,
    dedupeKeyTemplate: dedupeKeyTemplate ?? null,
  }).slice(0, 16);
  return `${type}:${signature}`;
}

interface TriggerRow {
  id: string;
  workflow_name: string;
  kind: string;
  webhook_path: string | null;
  event_type: string | null;
  filter_json: string;
  dedupe_key_template: string | null;
  enabled: number;
}

/**
 * Compile every enabled workflow's declared event/webhook triggers into the
 * registry. Idempotent and cheap: rows are keyed deterministically, upserts
 * only touch changed rows, and rows whose workflow/trigger disappeared are
 * deleted. Called from the daemon tick (best-effort) and after workflow writes.
 */
export function syncWorkflowTriggerRegistry(): { synced: number; removed: number } {
  const database = openTriggerDb();
  const now = new Date().toISOString();
  const wanted = new Map<string, { workflowName: string; kind: WorkflowTriggerKind; webhookPath?: string; eventType?: string; filter: Record<string, unknown>; dedupeKeyTemplate?: string }>();

  for (const entry of listWorkflows()) {
    const def = entry.data;
    if (!def.enabled) continue;
    const trigger = def.trigger ?? {};
    const webhookPath = typeof trigger.webhookPath === 'string' ? trigger.webhookPath.trim() : '';
    if (webhookPath) {
      const id = triggerRowId(entry.name, 'webhook', webhookPath);
      wanted.set(id, { workflowName: entry.name, kind: 'webhook', webhookPath, filter: {} });
    }
    for (const ev of trigger.events ?? []) {
      const type = typeof ev?.type === 'string' ? ev.type.trim() : '';
      if (!type) continue;
      const filter = ev.filter ?? {};
      const dedupeKeyTemplate = typeof ev.dedupeKey === 'string' && ev.dedupeKey.trim() ? ev.dedupeKey.trim() : undefined;
      const id = triggerRowId(entry.name, 'system_event', eventTriggerRowKey(type, filter, dedupeKeyTemplate));
      wanted.set(id, {
        workflowName: entry.name,
        kind: 'system_event',
        eventType: type,
        filter,
        dedupeKeyTemplate,
      });
    }
  }

  const existing = database.prepare(
    `SELECT id, workflow_name, kind, webhook_path, event_type, filter_json, dedupe_key_template, enabled FROM workflow_triggers WHERE kind IN ('webhook','system_event')`,
  ).all() as TriggerRow[];
  const existingById = new Map(existing.map((r) => [r.id, r]));

  const upsert = database.prepare(`
    INSERT INTO workflow_triggers (id, workflow_name, kind, webhook_path, event_type, filter_json, dedupe_key_template, enabled, created_at, updated_at)
    VALUES (@id, @workflowName, @kind, @webhookPath, @eventType, @filterJson, @dedupeKeyTemplate, 1, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      webhook_path = excluded.webhook_path,
      event_type = excluded.event_type,
      filter_json = excluded.filter_json,
      dedupe_key_template = excluded.dedupe_key_template,
      enabled = 1,
      updated_at = excluded.updated_at
  `);
  const remove = database.prepare('DELETE FROM workflow_triggers WHERE id = ?');

  let synced = 0;
  for (const [id, t] of wanted) {
    const filterJson = JSON.stringify(t.filter ?? {});
    const prior = existingById.get(id);
    const unchanged = prior
      && prior.filter_json === filterJson
      && (prior.dedupe_key_template ?? null) === (t.dedupeKeyTemplate ?? null)
      && prior.enabled === 1;
    if (unchanged) continue;
    upsert.run({
      id,
      workflowName: t.workflowName,
      kind: t.kind,
      webhookPath: t.webhookPath ?? null,
      eventType: t.eventType ?? null,
      filterJson,
      dedupeKeyTemplate: t.dedupeKeyTemplate ?? null,
      now,
    });
    synced++;
  }
  let removed = 0;
  for (const row of existing) {
    if (wanted.has(row.id)) continue;
    remove.run(row.id);
    removed++;
  }
  if (synced > 0 || removed > 0) {
    logger.info({ synced, removed }, 'workflow trigger registry synced');
  }
  return { synced, removed };
}

export interface WorkflowTriggerFireResult {
  workflowName: string;
  triggerId: string;
  status: 'queued' | 'duplicate_run' | 'deduped_event' | 'filtered' | 'error';
  runId?: string;
  message?: string;
}

/** Shallow filter match: every filter entry must equal payload.<key> (dot paths ok). */
export function workflowTriggerFilterMatches(filter: Record<string, unknown>, payload: unknown): boolean {
  for (const [key, expected] of Object.entries(filter ?? {})) {
    let cursor: unknown = payload;
    for (const segment of key.split('.')) {
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) { cursor = undefined; break; }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    if (cursor !== expected) return false;
  }
  return true;
}

/** Bind an event payload to a workflow's DECLARED inputs — code-level, no LLM:
 *  a declared input named `payload` gets the whole JSON; any other declared
 *  input whose name matches a primitive top-level payload key gets that value. */
export function workflowInputsFromTriggerPayload(def: WorkflowDefinition, payload: unknown): Record<string, string> {
  const declared = Object.keys(def.inputs ?? {});
  if (declared.length === 0) return {};
  const inputs: Record<string, string> = {};
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : undefined;
  for (const name of declared) {
    if (name === 'payload') {
      inputs.payload = JSON.stringify(payload ?? null);
      continue;
    }
    const value = record?.[name];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      inputs[name] = String(value);
    }
  }
  return inputs;
}

function fireTriggers(kind: 'webhook' | 'system_event', key: string, payload: unknown): WorkflowTriggerFireResult[] {
  const database = openTriggerDb();
  const column = kind === 'webhook' ? 'webhook_path' : 'event_type';
  const rows = database.prepare(
    `SELECT id, workflow_name, kind, webhook_path, event_type, filter_json, dedupe_key_template, enabled FROM workflow_triggers WHERE kind = ? AND ${column} = ? AND enabled = 1`,
  ).all(kind, key) as TriggerRow[];
  if (rows.length === 0) return [];

  const defsByName = new Map(listWorkflows().map((e) => [e.name, e.data]));
  const insertEvent = database.prepare(`
    INSERT INTO workflow_trigger_events (id, trigger_id, fired_at, dedupe_key, payload_hash, payload_json, run_id, deduped)
    VALUES (@id, @triggerId, @firedAt, @dedupeKey, @payloadHash, @payloadJson, NULL, 0)
    ON CONFLICT(trigger_id, dedupe_key) DO NOTHING
  `);
  const setRunId = database.prepare('UPDATE workflow_trigger_events SET run_id = ? WHERE trigger_id = ? AND dedupe_key = ?');

  const results: WorkflowTriggerFireResult[] = [];
  for (const row of rows) {
    const def = defsByName.get(row.workflow_name);
    if (!def || !def.enabled) continue; // registry lag — the sync will remove it
    let filter: Record<string, unknown> = {};
    try { filter = JSON.parse(row.filter_json || '{}'); } catch { /* treat as no filter */ }
    if (!workflowTriggerFilterMatches(filter, payload)) {
      results.push({ workflowName: row.workflow_name, triggerId: row.id, status: 'filtered' });
      continue;
    }
    const dedupeKey = workflowTriggerDedupeKey(
      { workflowName: row.workflow_name, kind: kind as WorkflowTriggerKind, dedupeKeyTemplate: row.dedupe_key_template ?? undefined },
      payload,
    );
    const inserted = insertEvent.run({
      id: `evt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      triggerId: row.id,
      firedAt: new Date().toISOString(),
      dedupeKey,
      payloadHash: workflowTriggerPayloadHash(payload),
      payloadJson: JSON.stringify(payload ?? null),
    });
    if (inserted.changes === 0) {
      results.push({ workflowName: row.workflow_name, triggerId: row.id, status: 'deduped_event' });
      continue;
    }
    try {
      const queued = queueWorkflowRun(row.workflow_name, workflowInputsFromTriggerPayload(def, payload));
      if (queued.id) setRunId.run(queued.id, row.id, dedupeKey);
      results.push({
        workflowName: row.workflow_name,
        triggerId: row.id,
        status: queued.status === 'queued' ? 'queued' : 'duplicate_run',
        runId: queued.id,
      });
      logger.info({ workflow: row.workflow_name, kind, key, runId: queued.id, status: queued.status }, 'workflow trigger fired');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ workflowName: row.workflow_name, triggerId: row.id, status: 'error', message });
      logger.warn({ workflow: row.workflow_name, kind, key, err: message }, 'workflow trigger fire failed');
    }
  }
  return results;
}

/** Emit an internal system event. Any enabled workflow whose trigger.events
 *  subscribes to `eventType` (and whose filter matches) is queued to run —
 *  once per dedupe key, through the standard run queue. Producers: composio
 *  trigger listeners, watchers, other workflows, tools. */
export function fireWorkflowSystemEvent(eventType: string, payload: unknown): WorkflowTriggerFireResult[] {
  const type = eventType?.trim();
  if (!type) return [];
  try {
    return fireTriggers('system_event', type, payload);
  } catch (err) {
    logger.warn({ eventType: type, err: err instanceof Error ? err.message : String(err) }, 'fireWorkflowSystemEvent failed');
    return [];
  }
}

/** Fire webhook-kind triggers for an HTTP POST that landed on
 *  /api/hooks/workflows/<hookPath>. Caller owns auth. */
export function fireWorkflowWebhook(hookPath: string, payload: unknown): WorkflowTriggerFireResult[] {
  const key = hookPath?.trim();
  if (!key) return [];
  try {
    return fireTriggers('webhook', key, payload);
  } catch (err) {
    logger.warn({ hookPath: key, err: err instanceof Error ? err.message : String(err) }, 'fireWorkflowWebhook failed');
    return [];
  }
}
