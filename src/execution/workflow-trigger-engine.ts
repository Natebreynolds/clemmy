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
 *   1. workflow_trigger_events UNIQUE(trigger_id, dedupe_key) — one durable
 *      receipt per rendered key. Pending receipts retry; accepted receipts
 *      terminally dedupe across restarts.
 *   2. queueWorkflowRun's same-inputs queue dedupe — identical queued/running
 *      runs are not duplicated.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { listWorkflows, type WorkflowDefinition } from '../memory/workflow-store.js';
import { queueWorkflowRun, readWorkflowTriggerReceiptAcceptance } from '../tools/workflow-run-queue.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import {
  ensureWorkflowTriggerSchema,
  workflowTriggerDedupeKey,
  workflowTriggerPayloadHash,
  type WorkflowTriggerKind,
  type WorkflowTriggerEventState,
} from './workflow-trigger-registry.js';

const logger = pino({ name: 'clementine-next.workflow-trigger-engine' });

let db: Database.Database | null = null;
let dbPath: string | null = null;

const TRIGGER_CLAIM_LEASE_MS = 5 * 60_000;
const TRIGGER_RETRY_BASE_MS = 5_000;
const TRIGGER_RETRY_MAX_MS = 5 * 60_000;

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
  db.pragma('foreign_keys = ON');
  ensureWorkflowTriggerSchema(db);
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
  generation: number;
}

interface TriggerEventRow {
  id: string;
  trigger_id: string;
  fired_at: string;
  dedupe_key: string;
  payload_hash: string;
  payload_json: string;
  run_id: string | null;
  state: WorkflowTriggerEventState;
  attempt_count: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  claim_token: string | null;
  claim_expires_at: string | null;
  trigger_generation: number;
}

function waitAtTriggerTestBoundary(readyEnv: string, releaseEnv: string): void {
  const ready = process.env[readyEnv];
  const release = process.env[releaseEnv];
  if (!ready || !release) return;
  writeFileSync(ready, 'ready', 'utf-8');
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(release)) Atomics.wait(waitCell, 0, 0, 5);
}

/**
 * Compile every enabled workflow's declared event/webhook triggers into the
 * registry. Idempotent and cheap: rows are keyed deterministically, upserts
 * only touch changed rows, and rows whose workflow/trigger disappeared are
 * disabled. Soft deletion is correctness-critical: deleting a trigger would
 * cascade-delete its pending inbox receipts. Called from the daemon tick
 * (best-effort) and after workflow writes.
 */
export function syncWorkflowTriggerRegistry(): { synced: number; removed: number } {
  const database = openTriggerDb();
  const now = new Date().toISOString();
  const buildWanted = (): Map<string, { workflowName: string; kind: WorkflowTriggerKind; webhookPath?: string; eventType?: string; filter: Record<string, unknown>; dedupeKeyTemplate?: string }> => {
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
    return wanted;
  };

  const upsert = database.prepare(`
    INSERT INTO workflow_triggers (id, workflow_name, kind, webhook_path, event_type, filter_json, dedupe_key_template, enabled, generation, created_at, updated_at)
    VALUES (@id, @workflowName, @kind, @webhookPath, @eventType, @filterJson, @dedupeKeyTemplate, 1, 1, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      webhook_path = excluded.webhook_path,
      event_type = excluded.event_type,
      filter_json = excluded.filter_json,
      dedupe_key_template = excluded.dedupe_key_template,
      enabled = 1,
      generation = workflow_triggers.generation + 1,
      updated_at = excluded.updated_at
  `);
  const disable = database.prepare(`
    UPDATE workflow_triggers
    SET enabled = 0, generation = generation + 1, updated_at = ?
    WHERE id = ? AND enabled <> 0
  `);
  const cancelPending = database.prepare(`
    UPDATE workflow_trigger_events
    SET state = 'cancelled',
        last_error = 'Trigger configuration was disabled or replaced before queue acceptance.',
        next_attempt_at = NULL,
        claim_token = NULL,
        claim_expires_at = NULL,
        updated_at = ?
    WHERE trigger_id = ? AND state = 'pending'
  `);
  const cancelStaleGeneration = database.prepare(`
    UPDATE workflow_trigger_events
    SET state = 'cancelled',
        last_error = 'Trigger configuration changed before queue acceptance.',
        next_attempt_at = NULL,
        claim_token = NULL,
        claim_expires_at = NULL,
        updated_at = @now
    WHERE trigger_id = @triggerId
      AND state = 'pending'
      AND trigger_generation <> @generation
  `);
  const pendingReceiptsForTrigger = database.prepare(`
    SELECT id
    FROM workflow_trigger_events
    WHERE trigger_id = ? AND state = 'pending'
  `);
  const promoteDurablyAcceptedReceipt = database.prepare(`
    UPDATE workflow_trigger_events
    SET state = 'enqueued',
        run_id = @runId,
        enqueued_at = @now,
        last_error = NULL,
        next_attempt_at = NULL,
        claim_token = NULL,
        claim_expires_at = NULL,
        updated_at = @now
    WHERE id = @eventId AND state = 'pending'
  `);
  const quarantineUnverifiableReceipt = database.prepare(`
    UPDATE workflow_trigger_events
    SET state = 'needs_verification',
        last_error = @message,
        next_attempt_at = NULL,
        claim_token = NULL,
        claim_expires_at = NULL,
        updated_at = @now
    WHERE id = @eventId AND state = 'pending'
  `);
  const reconcileDurableQueueAcceptance = (triggerId: string): void => {
    const receipts = pendingReceiptsForTrigger.all(triggerId) as Array<{ id: string }>;
    for (const receipt of receipts) {
      try {
        const runId = findRunAcceptedForTriggerReceipt(receipt.id);
        if (!runId) continue;
        promoteDurablyAcceptedReceipt.run({ eventId: receipt.id, runId, now });
      } catch (err) {
        const message = `Trigger receipt acceptance could not be verified during configuration replacement: ${err instanceof Error ? err.message : String(err)}`;
        quarantineUnverifiableReceipt.run({ eventId: receipt.id, message, now });
      }
    }
  };

  const replaceGeneration = database.transaction(() => {
    // Read the filesystem snapshot only after BEGIN IMMEDIATE owns the registry
    // generation. A waiter can no longer commit a snapshot it built before a
    // newer workflow edit became visible.
    const wanted = buildWanted();
    const existing = database.prepare(
      `SELECT id, workflow_name, kind, webhook_path, event_type, filter_json, dedupe_key_template, enabled, generation FROM workflow_triggers WHERE kind IN ('webhook','system_event')`,
    ).all() as TriggerRow[];
    const existingById = new Map(existing.map((row) => [row.id, row]));
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
      const current = database.prepare('SELECT generation FROM workflow_triggers WHERE id = ?')
        .get(id) as { generation: number };
      // A claimant may have died after the filesystem queue accepted its run
      // but before this SQLite acceptance transaction committed. Queue proof
      // is the linearization point: promote it before cancelling stale rows.
      reconcileDurableQueueAcceptance(id);
      cancelStaleGeneration.run({ triggerId: id, generation: current.generation, now });
      synced++;
    }
    let removed = 0;
    for (const row of existing) {
      if (wanted.has(row.id)) continue;
      removed += disable.run(now, row.id).changes;
      reconcileDurableQueueAcceptance(row.id);
      cancelPending.run(now, row.id);
    }
    return { synced, removed };
  });
  // One registry generation becomes visible atomically. A filter/dedupe edit
  // changes row identity, so exposing the new row before disabling the old one
  // can otherwise fire the same delivery twice in another process.
  const { synced, removed } = replaceGeneration.immediate();
  if (synced > 0 || removed > 0) {
    logger.info({ synced, removed }, 'workflow trigger registry synced');
  }
  return { synced, removed };
}

export interface WorkflowTriggerFireResult {
  workflowName: string;
  triggerId: string;
  status: 'queued' | 'duplicate_run' | 'readiness_blocked' | 'deduped_event' | 'pending_retry' | 'filtered' | 'error';
  runId?: string;
  message?: string;
}

/** Honest HTTP summary for webhook ingestion. Queue errors return a retryable
 * non-2xx response; durably-pending readiness/lease states return 202 instead
 * of claiming the workflow was queued. */
export function workflowWebhookResponseDisposition(results: WorkflowTriggerFireResult[]): {
  httpStatus: 200 | 202 | 503;
  ok: boolean;
  pending: boolean;
} {
  if (results.some((result) => result.status === 'error')) {
    return { httpStatus: 503, ok: false, pending: true };
  }
  if (results.some((result) => result.status === 'readiness_blocked' || result.status === 'pending_retry')) {
    return { httpStatus: 202, ok: false, pending: true };
  }
  return { httpStatus: 200, ok: true, pending: false };
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

function triggerRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(8, attemptCount - 1));
  return Math.min(TRIGGER_RETRY_MAX_MS, TRIGGER_RETRY_BASE_MS * (2 ** exponent));
}

function claimPendingTriggerEvent(
  database: Database.Database,
  eventId: string,
  trigger: Pick<TriggerRow, 'id' | 'generation'>,
  triggerGeneration: number,
  now: Date,
): { token: string; attemptCount: number; triggerGeneration: number } | null {
  const nowIso = now.toISOString();
  const token = randomUUID();
  const claimExpiresAt = new Date(now.getTime() + TRIGGER_CLAIM_LEASE_MS).toISOString();
  const claimed = database.prepare(`
    UPDATE workflow_trigger_events
    SET claim_token = @token,
        claim_expires_at = @claimExpiresAt,
        attempt_count = attempt_count + 1,
        last_attempt_at = @now,
        updated_at = @now
    WHERE id = @eventId
      AND state = 'pending'
      AND trigger_id = @triggerId
      AND trigger_generation = @triggerGeneration
      AND EXISTS (
        SELECT 1 FROM workflow_triggers t
        WHERE t.id = workflow_trigger_events.trigger_id
          AND t.enabled = 1
          AND t.generation = workflow_trigger_events.trigger_generation
      )
      AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= @now)
  `).run({ token, claimExpiresAt, now: nowIso, eventId, triggerId: trigger.id, triggerGeneration });
  if (claimed.changes === 0) return null;
  const row = database.prepare('SELECT attempt_count FROM workflow_trigger_events WHERE id = ?')
    .get(eventId) as { attempt_count: number } | undefined;
  return { token, attemptCount: row?.attempt_count ?? 1, triggerGeneration };
}

function deferPendingTriggerEvent(
  database: Database.Database,
  eventId: string,
  claim: { token: string; attemptCount: number; triggerGeneration: number },
  message: string,
  now: Date,
): void {
  const nowIso = now.toISOString();
  const nextAttemptAt = new Date(now.getTime() + triggerRetryDelayMs(claim.attemptCount)).toISOString();
  const deferred = database.prepare(`
    UPDATE workflow_trigger_events
    SET state = 'pending',
        last_error = @message,
        next_attempt_at = @nextAttemptAt,
        claim_token = NULL,
        claim_expires_at = NULL,
        updated_at = @now
    WHERE id = @eventId
      AND state = 'pending'
      AND claim_token = @token
      AND trigger_generation = @triggerGeneration
  `).run({ message, nextAttemptAt, now: nowIso, eventId, token: claim.token, triggerGeneration: claim.triggerGeneration });
  if (deferred.changes === 0) {
    // A lost claim while backing off is a benign race: another worker or a
    // registry replacement already re-owned or terminated this receipt. defer is
    // called from a catch handler, so throwing here would abort the caller's
    // whole batch (a webhook fire or a recovery tick) over one already-handled
    // receipt. Log and return; the durable state stands and recovery re-reads it.
    logger.info(
      { eventId, triggerGeneration: claim.triggerGeneration },
      'trigger receipt claim was lost during defer; leaving durable state for re-read',
    );
  }
}

function acceptTriggerEvent(
  database: Database.Database,
  eventId: string,
  claim: { token: string; triggerGeneration: number },
  runId: string | undefined,
  now: Date,
): void {
  const nowIso = now.toISOString();
  const accepted = database.prepare(`
    UPDATE workflow_trigger_events
    SET state = 'enqueued',
        run_id = @runId,
        enqueued_at = @now,
        last_error = NULL,
        next_attempt_at = NULL,
        claim_token = NULL,
        claim_expires_at = NULL,
        updated_at = @now
    WHERE id = @eventId
      AND state = 'pending'
      AND claim_token = @claimToken
      AND trigger_generation = @triggerGeneration
      AND EXISTS (
        SELECT 1 FROM workflow_triggers t
        WHERE t.id = workflow_trigger_events.trigger_id
          AND t.enabled = 1
          AND t.generation = workflow_trigger_events.trigger_generation
      )
  `).run({
    runId: runId ?? null,
    now: nowIso,
    eventId,
    claimToken: claim.token,
    triggerGeneration: claim.triggerGeneration,
  });
  if (accepted.changes > 0) return;

  // Another worker may have recovered the same receipt after our lease expired.
  // Accept that terminal state; every other lost-claim shape must be surfaced.
  const current = database.prepare('SELECT state, run_id FROM workflow_trigger_events WHERE id = ?')
    .get(eventId) as { state: WorkflowTriggerEventState; run_id: string | null } | undefined;
  if (current?.state === 'enqueued') return;
  throw new Error(`Lost the trigger receipt claim while accepting ${eventId}; queue acceptance was not recorded.`);
}

function findRunAcceptedForTriggerReceipt(receiptId: string): string | null {
  // New receipts use an immutable sidecar so runner-owned full-record updates
  // cannot erase trigger acceptance. The inline scan remains as a migration
  // fallback for receipts written by the earlier schema-v2 implementation.
  const acceptedRunId = readWorkflowTriggerReceiptAcceptance(receiptId);
  if (acceptedRunId) return acceptedRunId;
  if (!existsSync(WORKFLOW_RUNS_DIR)) return null;
  let files: string[];
  try {
    files = readdirSync(WORKFLOW_RUNS_DIR).filter((file) => file.endsWith('.json')).sort().reverse();
  } catch {
    return null;
  }
  for (const file of files) {
    try {
      const run = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as {
        id?: unknown;
        triggerReceiptId?: unknown;
        triggerReceiptIds?: unknown;
      };
      const matches = run.triggerReceiptId === receiptId
        || (Array.isArray(run.triggerReceiptIds) && run.triggerReceiptIds.includes(receiptId));
      if (!matches) continue;
      return typeof run.id === 'string' && run.id.trim() ? run.id : path.basename(file, '.json');
    } catch {
      continue;
    }
  }
  return null;
}

function attemptPendingTriggerEventLocked(
  database: Database.Database,
  trigger: TriggerRow,
  event: TriggerEventRow,
  def: WorkflowDefinition,
  now = new Date(),
): WorkflowTriggerFireResult {
  const claim = claimPendingTriggerEvent(database, event.id, trigger, event.trigger_generation, now);
  if (!claim) {
    return {
      workflowName: trigger.workflow_name,
      triggerId: trigger.id,
      status: 'pending_retry',
      message: 'This trigger receipt is already being dispatched and remains retryable until the run queue accepts it.',
    };
  }
  waitAtTriggerTestBoundary(
    'CLEMENTINE_TEST_TRIGGER_AFTER_CLAIM_READY',
    'CLEMENTINE_TEST_TRIGGER_AFTER_CLAIM_RELEASE',
  );

  let payload: unknown;
  try {
    payload = JSON.parse(event.payload_json);
  } catch (err) {
    const message = `Stored trigger payload could not be decoded: ${err instanceof Error ? err.message : String(err)}`;
    deferPendingTriggerEvent(database, event.id, claim, message, now);
    return { workflowName: trigger.workflow_name, triggerId: trigger.id, status: 'error', message };
  }

  try {
    // queueWorkflowRun writes this receipt marker in the same run-file write
    // that constitutes acceptance. It survives queued/running/terminal status,
    // so a crash before the SQLite commit cannot cause a second run later.
    const alreadyAcceptedRunId = event.attempt_count > 0
      ? findRunAcceptedForTriggerReceipt(event.id)
      : null;
    if (alreadyAcceptedRunId) {
      acceptTriggerEvent(database, event.id, claim, alreadyAcceptedRunId, now);
      return {
        workflowName: trigger.workflow_name,
        triggerId: trigger.id,
        status: 'duplicate_run',
        runId: alreadyAcceptedRunId,
        message: 'Recovered trigger receipt from its already-accepted workflow run.',
      };
    }

    const queued = queueWorkflowRun(trigger.workflow_name, workflowInputsFromTriggerPayload(def, payload), {
      source: trigger.kind === 'webhook' ? 'webhook' : 'system_event',
      triggerReceiptId: event.id,
    });
    if (queued.status === 'blocked_readiness') {
      deferPendingTriggerEvent(database, event.id, claim, queued.message, now);
      logger.info(
        { workflow: trigger.workflow_name, triggerId: trigger.id, attempt: claim.attemptCount },
        'workflow trigger queue attempt blocked by readiness; receipt remains pending',
      );
      return {
        workflowName: trigger.workflow_name,
        triggerId: trigger.id,
        status: 'readiness_blocked',
        message: queued.message,
      };
    }

    waitAtTriggerTestBoundary(
      'CLEMENTINE_TEST_TRIGGER_AFTER_QUEUE_READY',
      'CLEMENTINE_TEST_TRIGGER_AFTER_QUEUE_RELEASE',
    );

    acceptTriggerEvent(database, event.id, claim, queued.id, now);
    const status = queued.status === 'queued' ? 'queued' : 'duplicate_run';
    logger.info(
      { workflow: trigger.workflow_name, triggerId: trigger.id, runId: queued.id, status: queued.status, attempt: claim.attemptCount },
      'workflow trigger accepted by run queue',
    );
    return {
      workflowName: trigger.workflow_name,
      triggerId: trigger.id,
      status,
      runId: queued.id,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deferPendingTriggerEvent(database, event.id, claim, message, now);
    logger.warn(
      { workflow: trigger.workflow_name, triggerId: trigger.id, attempt: claim.attemptCount, err: message },
      'workflow trigger queue attempt failed; receipt remains pending',
    );
    return { workflowName: trigger.workflow_name, triggerId: trigger.id, status: 'error', message };
  }
}

function attemptPendingTriggerEvent(
  database: Database.Database,
  trigger: TriggerRow,
  event: TriggerEventRow,
  def: WorkflowDefinition,
  now = new Date(),
): WorkflowTriggerFireResult {
  // Keep the active receipt claim, configuration generation check, durable run
  // installation, and SQLite acceptance in one BEGIN IMMEDIATE generation.
  // Registry replacement/disable therefore linearizes either before the claim
  // (claim refused, no run) or after acceptance (the accepted occurrence wins);
  // it can never clear a claim while its owner is outside SQLite queueing work.
  const attempt = database.transaction(() => attemptPendingTriggerEventLocked(database, trigger, event, def, now));
  return attempt.immediate();
}

function fireTriggers(kind: 'webhook' | 'system_event', key: string, payload: unknown): WorkflowTriggerFireResult[] {
  const database = openTriggerDb();
  const column = kind === 'webhook' ? 'webhook_path' : 'event_type';
  const rows = database.prepare(
    `SELECT id, workflow_name, kind, webhook_path, event_type, filter_json, dedupe_key_template, enabled, generation FROM workflow_triggers WHERE kind = ? AND ${column} = ? AND enabled = 1`,
  ).all(kind, key) as TriggerRow[];
  if (rows.length === 0) return [];

  const defsByName = new Map(listWorkflows().map((e) => [e.name, e.data]));
  const insertEvent = database.prepare(`
    INSERT INTO workflow_trigger_events (
      id, trigger_id, fired_at, dedupe_key, payload_hash, payload_json,
      run_id, deduped, state, attempt_count, trigger_generation, updated_at
    )
    SELECT
      @id, @triggerId, @firedAt, @dedupeKey, @payloadHash, @payloadJson,
      NULL, 0, 'pending', 0, @triggerGeneration, @firedAt
    FROM workflow_triggers
    WHERE id = @triggerId AND enabled = 1 AND generation = @triggerGeneration
    ON CONFLICT(trigger_id, dedupe_key) DO NOTHING
  `);
  const readEvent = database.prepare(`
    SELECT id, trigger_id, fired_at, dedupe_key, payload_hash, payload_json, run_id,
           state, attempt_count, last_attempt_at, next_attempt_at, last_error,
           claim_token, claim_expires_at, trigger_generation
    FROM workflow_trigger_events
    WHERE trigger_id = ? AND dedupe_key = ?
  `);
  // A cancelled receipt permanently occupies its UNIQUE(trigger_id, dedupe_key)
  // slot. After a disable/re-enable or trigger-replace cycle, a legitimate new
  // delivery with the same dedupe key would otherwise ON CONFLICT DO NOTHING
  // onto the cancelled row and be rejected forever. Reviving it back to a fresh
  // pending receipt under the current generation restores durable delivery
  // while leaving every other state (enqueued/pending/needs_verification)
  // deduped exactly as before.
  const reviveCancelledEvent = database.prepare(`
    UPDATE workflow_trigger_events
    SET state = 'pending',
        fired_at = @firedAt,
        payload_hash = @payloadHash,
        payload_json = @payloadJson,
        trigger_generation = @triggerGeneration,
        run_id = NULL,
        deduped = 0,
        attempt_count = 0,
        last_attempt_at = NULL,
        next_attempt_at = NULL,
        last_error = NULL,
        claim_token = NULL,
        claim_expires_at = NULL,
        enqueued_at = NULL,
        updated_at = @firedAt
    WHERE id = @eventId AND state = 'cancelled'
  `);

  const results: WorkflowTriggerFireResult[] = [];
  for (const row of rows) {
    const def = defsByName.get(row.workflow_name);
    if (!def || !def.enabled) continue; // registry lag — the sync will remove it
    let filter: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.filter_json || '{}') as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('filter must be an object');
      filter = parsed as Record<string, unknown>;
    } catch {
      results.push({
        workflowName: row.workflow_name,
        triggerId: row.id,
        status: 'error',
        message: 'Trigger filter is unreadable; ingestion failed closed and no run was queued.',
      });
      continue;
    }
    if (!workflowTriggerFilterMatches(filter, payload)) {
      results.push({ workflowName: row.workflow_name, triggerId: row.id, status: 'filtered' });
      continue;
    }
    const dedupeKey = workflowTriggerDedupeKey(
      { workflowName: row.workflow_name, kind: kind as WorkflowTriggerKind, dedupeKeyTemplate: row.dedupe_key_template ?? undefined },
      payload,
    );
    waitAtTriggerTestBoundary(
      'CLEMENTINE_TEST_TRIGGER_BEFORE_RECEIPT_READY',
      'CLEMENTINE_TEST_TRIGGER_BEFORE_RECEIPT_RELEASE',
    );
    const inserted = insertEvent.run({
      id: `evt-${randomUUID()}`,
      triggerId: row.id,
      firedAt: new Date().toISOString(),
      dedupeKey,
      payloadHash: workflowTriggerPayloadHash(payload),
      payloadJson: JSON.stringify(payload ?? null),
      triggerGeneration: row.generation,
    });
    let event = readEvent.get(row.id, dedupeKey) as TriggerEventRow | undefined;
    if (!event) {
      results.push({ workflowName: row.workflow_name, triggerId: row.id, status: 'error', message: 'Trigger receipt could not be read after ingestion.' });
      continue;
    }
    if (inserted.changes === 0) {
      if (event.state === 'enqueued') {
        database.prepare('UPDATE workflow_trigger_events SET deduped = 1 WHERE id = ?').run(event.id);
        results.push({ workflowName: row.workflow_name, triggerId: row.id, status: 'deduped_event' });
        continue;
      }
      if (event.state === 'cancelled') {
        const revived = reviveCancelledEvent.run({
          eventId: event.id,
          firedAt: new Date().toISOString(),
          payloadHash: workflowTriggerPayloadHash(payload),
          payloadJson: JSON.stringify(payload ?? null),
          triggerGeneration: row.generation,
        });
        if (revived.changes === 0) {
          // Another delivery revived or re-terminated it first; re-read and let
          // the state checks below decide honestly.
          event = readEvent.get(row.id, dedupeKey) as TriggerEventRow | undefined;
          if (!event) {
            results.push({ workflowName: row.workflow_name, triggerId: row.id, status: 'error', message: 'Trigger receipt could not be read after ingestion.' });
            continue;
          }
        } else {
          event = readEvent.get(row.id, dedupeKey) as TriggerEventRow;
        }
      }
      if (event.state === 'needs_verification') {
        results.push({
          workflowName: row.workflow_name,
          triggerId: row.id,
          status: 'error',
          message: 'This legacy delivery has an unverifiable run binding and requires operator review before any retry.',
        });
        continue;
      }
      if (event.state === 'enqueued') {
        database.prepare('UPDATE workflow_trigger_events SET deduped = 1 WHERE id = ?').run(event.id);
        results.push({ workflowName: row.workflow_name, triggerId: row.id, status: 'deduped_event' });
        continue;
      }
    }
    if (event.trigger_generation !== row.generation) {
      results.push({
        workflowName: row.workflow_name,
        triggerId: row.id,
        status: 'error',
        message: 'This durable delivery belongs to an obsolete trigger configuration and will not be executed.',
      });
      continue;
    }
    // If the first process crashed after queueing but before marking accepted,
    // this retry sees the shared queue's duplicate result and safely closes the
    // durable receipt as enqueued.
    results.push(attemptPendingTriggerEvent(database, row, event, def));
  }
  return results;
}

export interface RecoverPendingWorkflowTriggerOptions {
  /** Maximum receipts to attempt in one tick. */
  limit?: number;
  /** Ignore retry backoff. Intended for explicit operator recovery and tests. */
  force?: boolean;
  /** Deterministic clock hook for tests. */
  now?: Date;
}

/**
 * Re-dispatch durable receipts that have not yet been accepted by the run
 * queue. Safe on boot and on every daemon tick: due-time backoff bounds failed
 * attempts, a lease prevents concurrent dispatch, and queue-level dedupe closes
 * the crash window after a run file was written but before `state=enqueued`.
 */
export function recoverPendingWorkflowTriggerEvents(
  options: RecoverPendingWorkflowTriggerOptions = {},
): WorkflowTriggerFireResult[] {
  const database = openTriggerDb();
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  const dueClause = options.force ? '' : 'AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= @now)';
  const rows = database.prepare(`
    SELECT
      e.id AS event_id, e.trigger_id, e.fired_at, e.dedupe_key, e.payload_hash,
      e.payload_json, e.run_id, e.state, e.attempt_count, e.last_attempt_at,
      e.next_attempt_at, e.last_error, e.claim_token, e.claim_expires_at,
      e.trigger_generation,
      t.id, t.workflow_name, t.kind, t.webhook_path, t.event_type,
      t.filter_json, t.dedupe_key_template, t.enabled, t.generation
    FROM workflow_trigger_events e
    JOIN workflow_triggers t ON t.id = e.trigger_id
    WHERE e.state = 'pending'
      AND t.enabled = 1
      AND e.trigger_generation = t.generation
      AND (e.claim_token IS NULL OR e.claim_expires_at IS NULL OR e.claim_expires_at <= @now)
      ${dueClause}
    ORDER BY e.fired_at ASC
    LIMIT @limit
  `).all({ now: nowIso, limit }) as Array<TriggerRow & Omit<TriggerEventRow, 'id'> & { event_id: string }>;
  if (rows.length === 0) return [];

  const defsByName = new Map(listWorkflows().map((entry) => [entry.name, entry.data]));
  const results: WorkflowTriggerFireResult[] = [];
  for (const row of rows) {
    const def = defsByName.get(row.workflow_name);
    if (!def || !def.enabled) continue;
    const trigger: TriggerRow = {
      id: row.id,
      workflow_name: row.workflow_name,
      kind: row.kind,
      webhook_path: row.webhook_path,
      event_type: row.event_type,
      filter_json: row.filter_json,
      dedupe_key_template: row.dedupe_key_template,
      enabled: row.enabled,
      generation: row.generation,
    };
    const event: TriggerEventRow = {
      id: row.event_id,
      trigger_id: row.trigger_id,
      fired_at: row.fired_at,
      dedupe_key: row.dedupe_key,
      payload_hash: row.payload_hash,
      payload_json: row.payload_json,
      run_id: row.run_id,
      state: row.state,
      attempt_count: row.attempt_count,
      last_attempt_at: row.last_attempt_at,
      next_attempt_at: row.next_attempt_at,
      last_error: row.last_error,
      claim_token: row.claim_token,
      claim_expires_at: row.claim_expires_at,
      trigger_generation: row.trigger_generation,
    };
    results.push(attemptPendingTriggerEvent(database, trigger, event, def, now));
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
    const message = `Trigger ingestion failed before a durable receipt could be confirmed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn({ eventType: type, err: message }, 'fireWorkflowSystemEvent failed');
    return [{
      workflowName: '(trigger-registry)',
      triggerId: `system_event:${type}`,
      status: 'error',
      message,
    }];
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
    const message = `Trigger ingestion failed before a durable receipt could be confirmed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn({ hookPath: key, err: message }, 'fireWorkflowWebhook failed');
    return [{
      workflowName: '(trigger-registry)',
      triggerId: `webhook:${key}`,
      status: 'error',
      message,
    }];
  }
}
