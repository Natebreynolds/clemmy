import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { estimateTokens } from './harness/budget.js';
import { providerReportedModel } from './harness/traceless-step-model.js';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import { BASE_DIR } from '../config.js';
import { recordOperationalEvent } from './operational-telemetry.js';
import {
  FallbackModel,
  fallbackRouteResolution,
  type FallbackTarget,
  type FallbackRouteResolution,
} from './harness/fallback-model.js';
import {
  observePromptCacheRequest,
  parseProviderPromptCacheUsage,
  type PromptCacheRequestObservationV1,
  type ProviderPromptCacheUsageV1,
} from './harness/prompt-cache-observation.js';
import { harnessRunContextStorage } from './harness/brackets.js';
import { modelUsageAttributionStorage, type ModelUsageAttributionContext, type UsageRequestRole } from './usage-log.js';
import { appendEvent } from './harness/eventlog.js';

export const MODEL_ROUTE_METRICS_SCHEMA_VERSION = 1;

export const MODEL_ROUTE_METRICS_TABLES = [
  'model_route_decisions',
  'model_route_outcomes',
  'model_route_policy',
] as const;

export type ModelRouteMetricsTableName = (typeof MODEL_ROUTE_METRICS_TABLES)[number];

export type ModelRouteRole = 'brain' | 'worker' | 'judge' | 'writer' | 'memory';

/** Every route role the decision and policy tables admit. A role missing here
 *  is dropped silently by `INSERT OR IGNORE` (the writer never had a row). */
export const MODEL_ROUTE_ROLES: readonly ModelRouteRole[] = ['brain', 'worker', 'judge', 'writer', 'memory'];
const ROUTE_ROLE_CHECK = `CHECK (role IN (${MODEL_ROUTE_ROLES.map((role) => `'${role}'`).join(',')}))`;
export type ModelRouteOutcomeStatus = 'success' | 'failed' | 'fallback' | 'cancelled';
export type ModelRouteDecisionSource = 'default' | 'binding' | 'intent_binding' | 'explicit' | 'fallback' | 'policy';
export type ModelRouteProvider = 'codex' | 'claude' | 'byo' | 'openai' | 'unknown';

export interface ModelRouteOutcomeSample {
  status: ModelRouteOutcomeStatus;
  latencyMs?: number;
  totalTokens?: number;
  costUsd?: number;
  objectiveMet?: boolean;
  toolSuccess?: boolean;
}

export interface ModelRouteSummary {
  sampleCount: number;
  successCount: number;
  failureCount: number;
  fallbackCount: number;
  objectiveMetCount: number;
  toolSuccessCount: number;
  avgLatencyMs: number | null;
  avgTokens: number | null;
  avgCostUsd: number | null;
  successRate: number;
  objectiveRate: number;
  toolSuccessRate: number;
}

export interface RouteScoreWeights {
  success: number;
  objective: number;
  toolSuccess: number;
  latency: number;
  cost: number;
  token: number;
  fallbackPenalty: number;
}

export interface ModelRouteCandidate {
  role: ModelRouteRole;
  intent?: string;
  provider: ModelRouteProvider;
  model: string;
  summary: ModelRouteSummary;
  disabledReason?: string | null;
}

export interface ScoredModelRouteCandidate extends ModelRouteCandidate {
  score: number;
}

export const DEFAULT_ROUTE_SCORE_WEIGHTS: RouteScoreWeights = {
  success: 0.45,
  objective: 0.25,
  toolSuccess: 0.15,
  latency: 0.06,
  cost: 0.05,
  token: 0.02,
  fallbackPenalty: 0.02,
};

function decisionsTableSql(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id                 TEXT PRIMARY KEY,
  created_at         TEXT NOT NULL,
  session_id         TEXT,
  workflow_run_id    TEXT,
  workflow_node_id   TEXT,
  workspace_id       TEXT,
  role               TEXT NOT NULL ${ROUTE_ROLE_CHECK},
  intent             TEXT,
  requested_model    TEXT,
  resolved_model     TEXT NOT NULL,
  provider           TEXT NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('default','binding','intent_binding','explicit','fallback','policy')),
  reason_json        TEXT NOT NULL DEFAULT '{}',
  policy_version     INTEGER
);`;
}

function policyTableSql(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id                  TEXT PRIMARY KEY,
  role                TEXT NOT NULL ${ROUTE_ROLE_CHECK},
  intent              TEXT,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  score               REAL NOT NULL,
  sample_count        INTEGER NOT NULL DEFAULT 0,
  success_count       INTEGER NOT NULL DEFAULT 0,
  objective_met_count INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms      REAL,
  avg_cost_usd        REAL,
  disabled_reason     TEXT,
  policy_version      INTEGER NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(role, intent, provider, model)
);`;
}

/**
 * Local-first metrics schema for future route policy updates.
 *
 * The router can append one decision before dispatch and one outcome after the
 * call. A periodic policy job can then update model_route_policy without making
 * the hot path depend on online learning.
 */
export const MODEL_ROUTE_METRICS_SCHEMA_SQL = `
${decisionsTableSql('model_route_decisions')}

CREATE INDEX IF NOT EXISTS idx_model_route_decisions_created
  ON model_route_decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_route_decisions_role_intent
  ON model_route_decisions(role, intent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_route_decisions_workspace
  ON model_route_decisions(workspace_id, created_at DESC) WHERE workspace_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS model_route_outcomes (
  decision_id        TEXT PRIMARY KEY REFERENCES model_route_decisions(id) ON DELETE CASCADE,
  completed_at       TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('success','failed','fallback','cancelled')),
  latency_ms         INTEGER,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cached_tokens      INTEGER,
  total_tokens       INTEGER,
  cost_usd           REAL,
  error_class        TEXT,
  fallover_to_model  TEXT,
  tool_calls         INTEGER,
  tool_success       INTEGER CHECK (tool_success IN (0,1)),
  objective_met      INTEGER CHECK (objective_met IN (0,1)),
  metadata_json      TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_model_route_outcomes_status_completed
  ON model_route_outcomes(status, completed_at DESC);

${policyTableSql('model_route_policy')}

CREATE INDEX IF NOT EXISTS idx_model_route_policy_lookup
  ON model_route_policy(role, intent, disabled_reason, score DESC);
`;

export const MODEL_ROUTE_METRICS_STATE_DIR = path.join(BASE_DIR, 'state');
export const MODEL_ROUTE_METRICS_DB_PATH = path.join(MODEL_ROUTE_METRICS_STATE_DIR, 'model-route-metrics.db');

export interface RecordModelRouteDecisionInput {
  id?: string;
  sessionId?: string;
  workflowRunId?: string;
  workflowNodeId?: string;
  workspaceId?: string;
  role: ModelRouteRole;
  intent?: string;
  requestedModel?: string;
  resolvedModel: string;
  provider: ModelRouteProvider | string;
  source: ModelRouteDecisionSource;
  reason?: Record<string, unknown>;
  policyVersion?: number;
  now?: Date;
}

export interface RecordModelRouteOutcomeInput {
  decisionId: string;
  status: ModelRouteOutcomeStatus;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  errorClass?: string;
  falloverToModel?: string;
  toolCalls?: number;
  toolSuccess?: boolean;
  objectiveMet?: boolean;
  metadata?: Record<string, unknown>;
  now?: Date;
}

/**
 * Content-free accounting projected from one provider adapter response.
 * `costUsd` is present only when the adapter returned an explicit billed cost;
 * callers must never synthesize it from model names or token counts.
 */
export interface ModelRouteCallUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  promptCacheUsage?: ProviderPromptCacheUsageV1;
}

export interface ModelRouteMetricsContext extends Omit<RecordModelRouteDecisionInput, 'id' | 'now'> {
  modelCallIdPrefix?: string;
}

let cachedDb: Database.Database | null = null;

export function openModelRouteMetricsDb(): Database.Database {
  if (cachedDb) return cachedDb;
  ensureStateDir();
  const db = new Database(MODEL_ROUTE_METRICS_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(MODEL_ROUTE_METRICS_SCHEMA_SQL);
  try {
    widenModelRouteRoleChecks(db);
  } catch {
    // A database the rebuild cannot touch keeps its old CHECK: rows for a role
    // it does not admit are dropped, exactly as before. Metrics never block.
  }
  cachedDb = db;
  return db;
}

/** The role CHECK a table was created with admits every current route role. */
function tableAdmitsEveryRouteRole(db: Database.Database, table: string): boolean {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql?: string } | undefined;
  if (!row?.sql) return true; // nothing to widen; CREATE IF NOT EXISTS made it current
  return MODEL_ROUTE_ROLES.every((role) => row.sql!.includes(`'${role}'`));
}

/**
 * Rebuild `model_route_decisions` and `model_route_policy` in place when their
 * role CHECK predates a route role (the first build admitted only brain,
 * worker and judge, so writer and memory rows were silently dropped). The
 * metrics DB has no version ledger: the table's own `CREATE` text is the
 * version, which also keeps an older build working on the rebuilt table.
 *
 * One immediate transaction per open: copy every row into a table with the
 * current CHECK, verify the counts match, drop the old table, rename, and
 * recreate the indexes. Foreign keys are off for the swap, or dropping the
 * decisions table would cascade-delete every outcome. Idempotent: a current
 * table is left untouched. Returns the tables it rebuilt.
 */
export function widenModelRouteRoleChecks(db: Database.Database): string[] {
  const stale = ['model_route_decisions', 'model_route_policy']
    .filter((table) => !tableAdmitsEveryRouteRole(db, table));
  if (stale.length === 0) return [];
  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  if (foreignKeys) db.pragma('foreign_keys = OFF');
  try {
    return db.transaction((): string[] => {
      const rebuilt: string[] = [];
      for (const table of ['model_route_decisions', 'model_route_policy']) {
        // Re-read inside the write lock: another process may have just done it.
        if (tableAdmitsEveryRouteRole(db, table)) continue;
        const next = `${table}__widened`;
        db.exec(`DROP TABLE IF EXISTS ${next}`);
        db.exec(table === 'model_route_decisions' ? decisionsTableSql(next) : policyTableSql(next));
        const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .map((column) => column.name).join(', ');
        db.exec(`INSERT INTO ${next} (${columns}) SELECT ${columns} FROM ${table}`);
        const count = (name: string): number =>
          (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n;
        const before = count(table);
        const after = count(next);
        if (before !== after) throw new Error(`route metrics rebuild of ${table} copied ${after} of ${before} rows`);
        db.exec(`DROP TABLE ${table}`);
        db.exec(`ALTER TABLE ${next} RENAME TO ${table}`);
        rebuilt.push(table);
      }
      // The drops took the tables' indexes with them.
      db.exec(MODEL_ROUTE_METRICS_SCHEMA_SQL);
      return rebuilt;
    }).immediate();
  } finally {
    if (foreignKeys) db.pragma('foreign_keys = ON');
  }
}

export function closeModelRouteMetricsDb(): void {
  if (!cachedDb) return;
  cachedDb.close();
  cachedDb = null;
}

/** Test-only reset. The production metrics DB is append-only. */
export function resetModelRouteMetricsForTest(): void {
  closeModelRouteMetricsDb();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = MODEL_ROUTE_METRICS_DB_PATH + suffix;
    if (existsSync(file)) unlinkSync(file);
  }
}

export function recordModelRouteDecision(
  input: RecordModelRouteDecisionInput,
  db?: Database.Database,
): string {
  const id = input.id ?? randomUUID();
  const createdAt = (input.now ?? new Date()).toISOString();
  try {
    (db ?? openModelRouteMetricsDb()).prepare(`
      INSERT OR IGNORE INTO model_route_decisions (
        id, created_at, session_id, workflow_run_id, workflow_node_id,
        workspace_id, role, intent, requested_model, resolved_model, provider,
        source, reason_json, policy_version
      ) VALUES (
        @id, @createdAt, @sessionId, @workflowRunId, @workflowNodeId,
        @workspaceId, @role, @intent, @requestedModel, @resolvedModel, @provider,
        @source, @reasonJson, @policyVersion
      )
    `).run({
      id,
      createdAt,
      sessionId: input.sessionId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      workflowNodeId: input.workflowNodeId ?? null,
      workspaceId: input.workspaceId ?? null,
      role: input.role,
      intent: input.intent ?? null,
      requestedModel: input.requestedModel ?? null,
      resolvedModel: input.resolvedModel,
      provider: input.provider,
      source: input.source,
      reasonJson: JSON.stringify(input.reason ?? {}),
      policyVersion: input.policyVersion ?? null,
    });
  } catch {
    // Metrics must never fail a model call.
  }
  if (!db) {
    recordOperationalEvent({
      source: 'model',
      type: 'model_route_decided',
      severity: 'info',
      sessionId: input.sessionId,
      workflowRunId: input.workflowRunId,
      workflowNodeRunId: input.workflowNodeId,
      workspaceId: input.workspaceId,
      modelCallId: id,
      actor: 'model-route-metrics',
      now: new Date(createdAt),
      payload: {
        role: input.role,
        intent: input.intent,
        requestedModel: input.requestedModel,
        resolvedModel: input.resolvedModel,
        provider: input.provider,
        source: input.source,
        reason: input.reason,
        policyVersion: input.policyVersion,
      },
    });
  }
  return id;
}

export function recordModelRouteOutcome(
  input: RecordModelRouteOutcomeInput,
  db?: Database.Database,
): boolean {
  const completedAt = (input.now ?? new Date()).toISOString();
  try {
    const result = (db ?? openModelRouteMetricsDb()).prepare(`
      INSERT OR IGNORE INTO model_route_outcomes (
        decision_id, completed_at, status, latency_ms, input_tokens,
        output_tokens, cached_tokens, total_tokens, cost_usd, error_class,
        fallover_to_model, tool_calls, tool_success, objective_met, metadata_json
      ) VALUES (
        @decisionId, @completedAt, @status, @latencyMs, @inputTokens,
        @outputTokens, @cachedTokens, @totalTokens, @costUsd, @errorClass,
        @falloverToModel, @toolCalls, @toolSuccess, @objectiveMet, @metadataJson
      )
    `).run({
      decisionId: input.decisionId,
      completedAt,
      status: input.status,
      latencyMs: input.latencyMs ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cachedTokens: input.cachedTokens ?? null,
      totalTokens: input.totalTokens ?? null,
      costUsd: input.costUsd ?? null,
      errorClass: input.errorClass ?? null,
      falloverToModel: input.falloverToModel ?? null,
      toolCalls: input.toolCalls ?? null,
      toolSuccess: boolToInt(input.toolSuccess),
      objectiveMet: boolToInt(input.objectiveMet),
      metadataJson: JSON.stringify(input.metadata ?? {}),
    });
    return result.changes === 1;
  } catch {
    // Metrics must never fail a model call.
    return false;
  }
}

/**
 * Retention sweep (2026-07-22 legacy audit): decisions/outcomes grew unbounded
 * — one row per routing call, never deleted. Rows older than the policy
 * window are dead weight once the nightly policy rebuild has consumed them.
 * Outcomes cascade off decisions.
 */
export function reapStaleModelRouteMetrics(maxAgeDays = 30): number {
  try {
    const db = openModelRouteMetricsDb();
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    return db.prepare('DELETE FROM model_route_decisions WHERE created_at < ?').run(cutoff).changes;
  } catch {
    return 0; // retention is best-effort hygiene
  }
}

/** One routed model call as its route recorded it, handed to the job that
 *  made it. Identifiers and model ids only, never content. */
export interface ObservedModelRoute {
  decisionId: string;
  role: ModelRouteRole;
  /** What the route asked for (an owner's pick or the automatic default). */
  requestedModel?: string;
  /** What this route lane dispatched to. */
  resolvedModel: string;
  /** The model the provider reported serving, when it reported one. */
  servedModel?: string;
  provider: string;
  /** `fallback` = this lane is a later fallback target, not the first choice. */
  source: ModelRouteDecisionSource;
  status: ModelRouteOutcomeStatus;
  /** Set when the call fell over inside the lane (outcome `fallback`). */
  falloverToModel?: string;
  reason?: Record<string, unknown>;
}

const modelRouteObservers = new AsyncLocalStorage<ObservedModelRoute[]>();

/** Collect every routed model call finished inside `work` into `sink`, which
 *  the caller owns (the route twin of usage-log's withModelUsageObserver). The
 *  innermost observer wins, so a nested job's routes are its own. */
export function withModelRouteObserver<T>(sink: ObservedModelRoute[], work: () => T): T {
  return modelRouteObservers.run(sink, work);
}

/**
 * Which route served a job, and whether it was a stand-in, from the route's
 * own evidence — never by comparing model spellings. A stand-in is a call
 * that fell over inside its lane (outcome `fallback`) or a lane that is itself
 * a fallback target (decision source `fallback`). The serving route is the
 * last call that returned an answer; null when none did.
 */
export function readRouteStandIn(routes: readonly ObservedModelRoute[]): {
  route: ObservedModelRoute;
  standIn: boolean;
} | null {
  for (let i = routes.length - 1; i >= 0; i -= 1) {
    const route = routes[i]!;
    if (route.status !== 'success' && route.status !== 'fallback') continue;
    return { route, standIn: route.status === 'fallback' || route.source === 'fallback' };
  }
  return null;
}

export function withModelRouteMetrics(
  model: Model,
  context: ModelRouteMetricsContext,
  db?: Database.Database,
): Model {
  if (model instanceof FallbackModel) {
    const mapped = model.mapAttemptTargets((target, index) => instrumentFallbackTarget(target, index, context, db));
    // Keep the pre-existing context introspection surface while deliberately
    // avoiding an aggregate recording wrapper around the fallback graph.
    Object.defineProperty(mapped, 'context', {
      value: context,
      enumerable: false,
      configurable: true,
    });
    return mapped;
  }
  return new ModelRouteMetricsModel(model, context, db);
}

function instrumentFallbackTarget(
  target: FallbackTarget,
  index: number,
  context: ModelRouteMetricsContext,
  db?: Database.Database,
): FallbackTarget {
  return {
    ...target,
    getModel: () => withModelRouteMetrics(target.getModel(), {
      ...context,
      resolvedModel: target.model ?? target.label,
      provider: modelRouteProvider(target.provider) ?? context.provider,
      source: index === 0 ? context.source : 'fallback',
      reason: {
        ...(context.reason ?? {}),
        routeTargetIndex: index,
        initialResolvedModel: context.resolvedModel,
      },
    }, db),
  };
}

function modelRouteProvider(value: string | undefined): ModelRouteProvider | undefined {
  return value === 'codex' || value === 'claude' || value === 'byo' || value === 'openai' || value === 'unknown'
    ? value
    : undefined;
}

export function successfulRouteOutcome(
  resolution: FallbackRouteResolution | undefined,
  metadata: Record<string, unknown>,
): {
  status: Extract<ModelRouteOutcomeStatus, 'success' | 'fallback'>;
  falloverToModel?: string;
  metadata: Record<string, unknown>;
} {
  return {
    status: resolution?.fellOver ? 'fallback' : 'success',
    ...(resolution?.fellOver
      ? { falloverToModel: resolution.model ?? resolution.resolvedLabel }
      : {}),
    metadata: resolution
      ? {
          ...metadata,
          actualResolvedLabel: resolution.resolvedLabel,
          ...(resolution.provider ? { actualProvider: resolution.provider } : {}),
          ...(resolution.model ? { actualModel: resolution.model } : {}),
          ...(resolution.reason ? { falloverReason: resolution.reason } : {}),
        }
      : metadata,
  };
}

/** The routing role IS the explicit request role: brain, worker, judge
 *  (accounted as reviewer), writer or memory. A judge or worker route inside a
 *  brain turn overrides the turn's scope; a brain route never overrides an
 *  explicit outer worker/reviewer scope; an unscoped call (a post-turn
 *  reflection judge) gets a role-only scope so its rows are never "unset". */
function usageRoleForRoute(role: ModelRouteRole): UsageRequestRole {
  return role === 'judge' ? 'reviewer' : role;
}

/** This request's own prompt shape, never the parent turn's measurements. */
function requestPromptComponents(request: ModelRequest): Record<string, number> {
  try {
    return {
      instructions: estimateTokens(request.systemInstructions ?? ''),
      history: estimateTokens(typeof request.input === 'string' ? request.input : JSON.stringify(request.input ?? [])),
      toolSchemas: estimateTokens(JSON.stringify(request.tools ?? [])),
      ...(request.outputType ? { outputSchema: estimateTokens(JSON.stringify(request.outputType)) } : {}),
    };
  } catch {
    return {}; // Missing telemetry must not inherit a different request's measurements.
  }
}

function routeAttributionContext(role: ModelRouteRole, request: ModelRequest): ModelUsageAttributionContext | null {
  const routeRole = usageRoleForRoute(role);
  const inherited = modelUsageAttributionStorage.getStore();
  // Nested reviews own a different request from the brain's ambient context.
  // Estimate this request once, including each evidence lookup/repair frame.
  // Never label the parent's tool catalog or history as reviewer input.
  if (routeRole === 'reviewer' || (routeRole === 'brain' && inherited?.role === 'reviewer')) {
    return { sessionId: 'unknown', sourceUserSeq: 0, ...inherited, role: 'reviewer', promptComponents: requestPromptComponents(request) };
  }
  // Memory work is its own request too. The job's scope keeps its channel
  // (`memory:<job>`) and source; only the role and the prompt shape are the
  // route's own.
  if (routeRole === 'memory') {
    return { sessionId: 'unknown', sourceUserSeq: 0, ...inherited, role: 'memory', promptComponents: requestPromptComponents(request) };
  }
  if (!inherited) return { sessionId: 'unknown', sourceUserSeq: 0, role: routeRole };
  if (inherited.role === routeRole) return null;
  if (routeRole === 'brain' && inherited.role) return null;
  return { ...inherited, role: routeRole, promptComponents: undefined };
}

class ModelRouteMetricsModel implements Model {
  constructor(
    private readonly inner: Model,
    private readonly context: ModelRouteMetricsContext,
    private readonly db?: Database.Database,
  ) {}

  private inRouteRole<T>(context: ModelUsageAttributionContext | null, work: () => T): T {
    return context ? modelUsageAttributionStorage.run(context, work) : work();
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const startedAt = Date.now();
    const usageContext = routeAttributionContext(this.context.role, request);
    const promptCacheRequest = observePromptCacheRequest(request);
    const decisionId = this.startCall('getResponse', promptCacheRequest);
    try {
      const response = await this.inRouteRole(usageContext, () => this.inner.getResponse(request));
      const usage = modelRouteUsageFromResponse(response);
      const resolution = fallbackRouteResolution(response);
      const outcome = successfulRouteOutcome(resolution, { path: 'getResponse', responseCompleted: true });
      const servedModel = providerReportedModel(response);
      if (servedModel) Object.assign(outcome.metadata, { actualModel: servedModel, providerReportedModel: servedModel });
      this.finishCall(
        decisionId,
        outcome.status,
        startedAt,
        usage,
        outcome.metadata,
        undefined,
        outcome.falloverToModel,
      );
      return response;
    } catch (err) {
      this.finishCall(decisionId, 'failed', startedAt, {}, {
        path: 'getResponse',
      }, errorClass(err));
      throw err;
    }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const startedAt = Date.now();
    const usageContext = routeAttributionContext(this.context.role, request);
    const promptCacheRequest = observePromptCacheRequest(request);
    const decisionId = this.startCall('getStreamedResponse', promptCacheRequest);
    let usage: ModelRouteCallUsage = {};
    let completed = false;
    let responseCompleted = false;
    let servedModel: string | undefined;
    let failed = false;
    let resolution: FallbackRouteResolution | undefined;
    try {
      // Each pull of the inner stream runs inside the route's attribution scope,
      // so the wire's usage row (written when the stream settles) carries the role.
      const innerStream = this.inRouteRole(usageContext, () => this.inner.getStreamedResponse(request));
      const iterator = innerStream[Symbol.asyncIterator]();
      const scoped: AsyncIterable<StreamEvent> = {
        [Symbol.asyncIterator]: () => ({
          next: () => this.inRouteRole(usageContext, () => iterator.next()),
          return: (value?: unknown) => this.inRouteRole(usageContext, () => iterator.return?.(value) ?? Promise.resolve({ done: true as const, value: undefined })),
          throw: (error?: unknown) => this.inRouteRole(usageContext, () => iterator.throw?.(error) ?? Promise.reject(error)),
        }),
      };
      for await (const event of scoped) {
        servedModel = providerReportedModel(event) ?? servedModel;
        const doneUsage = usageFromStreamEvent(event);
        if (doneUsage) { usage = doneUsage; responseCompleted = true; }
        resolution = fallbackRouteResolution(event) ?? resolution;
        yield event;
      }
      completed = true;
      const outcome = successfulRouteOutcome(resolution, { path: 'getStreamedResponse', responseCompleted });
      if (responseCompleted && servedModel) Object.assign(outcome.metadata, { actualModel: servedModel, providerReportedModel: servedModel });
      this.finishCall(
        decisionId,
        outcome.status,
        startedAt,
        usage,
        outcome.metadata,
        undefined,
        outcome.falloverToModel,
      );
    } catch (err) {
      failed = true;
      this.finishCall(decisionId, 'failed', startedAt, usage, {
        path: 'getStreamedResponse',
      }, errorClass(err));
      throw err;
    } finally {
      if (!completed && !failed) {
        this.finishCall(decisionId, 'cancelled', startedAt, usage, { path: 'getStreamedResponse' });
      }
    }
  }

  private startCall(
    pathName: 'getResponse' | 'getStreamedResponse',
    promptCacheRequest: PromptCacheRequestObservationV1,
  ): string {
    const activeContext = harnessMetricsContext(this.context);
    const decisionId = recordModelRouteDecision({
      ...activeContext,
      id: this.context.modelCallIdPrefix ? `${this.context.modelCallIdPrefix}:${randomUUID()}` : undefined,
      reason: {
        ...(this.context.reason ?? {}),
        path: pathName,
        promptCacheRequest,
      },
    }, this.db);
    if (!this.db) recordOperationalEvent({
      source: 'model',
      type: 'model_call_started',
      severity: 'info',
      sessionId: activeContext.sessionId,
      workflowRunId: activeContext.workflowRunId,
      workflowNodeRunId: activeContext.workflowNodeId,
      workspaceId: activeContext.workspaceId,
      modelCallId: decisionId,
      actor: 'model-route-metrics',
      payload: {
        path: pathName,
        role: this.context.role,
        intent: this.context.intent,
        requestedModel: this.context.requestedModel,
        resolvedModel: this.context.resolvedModel,
        provider: this.context.provider,
        source: this.context.source,
      },
    });
    return decisionId;
  }

  private finishCall(
    decisionId: string,
    status: ModelRouteOutcomeStatus,
    startedAt: number,
    usage: ModelRouteCallUsage,
    metadata: Record<string, unknown>,
    errorClassName?: string,
    falloverToModel?: string,
  ): void {
    try {
      modelRouteObservers.getStore()?.push({
        decisionId,
        role: this.context.role,
        ...(this.context.requestedModel ? { requestedModel: this.context.requestedModel } : {}),
        resolvedModel: this.context.resolvedModel,
        ...(typeof metadata.actualModel === 'string' ? { servedModel: metadata.actualModel } : {}),
        provider: String(this.context.provider),
        source: this.context.source,
        status,
        ...(falloverToModel ? { falloverToModel } : {}),
        ...(this.context.reason ? { reason: { ...this.context.reason } } : {}),
      });
    } catch { /* an observer must never break the model-call path */ }
    recordModelRouteOutcome({
      decisionId,
      status,
      latencyMs: Math.max(0, Date.now() - startedAt),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      totalTokens: usage.totalTokens,
      costUsd: usage.costUsd,
      errorClass: errorClassName,
      falloverToModel,
      metadata: {
        ...metadata,
        ...(usage.promptCacheUsage ? { promptCacheUsage: usage.promptCacheUsage } : {}),
      },
    }, this.db);
    // A routing decision is intent, not execution. Only a completed provider
    // response can attest a host worker's actual route; bind it to its attempt.
    const active = harnessRunContextStorage.getStore();
    if (!this.db && this.context.role === 'worker' && active?.workerScope === true && active.sessionId
      && Number.isInteger(active.sourceUserSeq) && active.runAttemptId
      && (status === 'success' || status === 'fallback') && metadata.responseCompleted === true) {
      try {
        appendEvent({ sessionId: active.sessionId, turn: active.turn ?? 0, role: 'system', type: 'worker_model_response_completed', data: {
          sourceUserSeq: active.sourceUserSeq, runAttemptId: active.runAttemptId, modelCallId: decisionId,
          model: typeof metadata.actualModel === 'string' ? metadata.actualModel : this.context.resolvedModel,
          requestedModel: this.context.resolvedModel,
          ...(typeof metadata.providerReportedModel === 'string' ? { providerReportedModel: metadata.providerReportedModel } : {}),
          provider: typeof metadata.actualProvider === 'string' ? metadata.actualProvider : this.context.provider,
          fallover: status === 'fallback' || this.context.source === 'fallback',
        } });
      } catch { /* Missing telemetry remains unknown; it must not fail the worker. */ }
    }
    // A cancelled call is journaled too: the host stall watchdog retires an
    // attempt by aborting it, and that was invisible — a turn that sat 600s
    // and died recorded no failure anywhere (live 2026-09-02).
    if ((status === 'failed' || status === 'cancelled') && !this.db) {
      recordOperationalEvent({
        source: 'model',
        type: 'model_call_failed',
        severity: status === 'cancelled' ? 'warn' : 'error',
        sessionId: this.context.sessionId,
        workflowRunId: this.context.workflowRunId,
        workflowNodeRunId: this.context.workflowNodeId,
        workspaceId: this.context.workspaceId,
        modelCallId: decisionId,
        actor: 'model-route-metrics',
        payload: {
          ...metadata,
          status,
          role: this.context.role,
          intent: this.context.intent,
          resolvedModel: this.context.resolvedModel,
          provider: this.context.provider,
          latencyMs: Math.max(0, Date.now() - startedAt),
          errorClass: errorClassName,
        },
      });
    }
    // NOTE: success/cancelled latency + token breakdown is already emitted as a
    // `model_call_completed` operational event by usage-log.ts (with durationMs,
    // firstByteMs, cachedInputTokens, contextWindowTokens, promptComponents) —
    // richer than a duplicate here would be. Query THAT for latency analysis.
  }
}

export function summarizeRouteOutcomes(samples: ModelRouteOutcomeSample[]): ModelRouteSummary {
  const sampleCount = samples.length;
  const successCount = samples.filter((sample) => sample.status === 'success').length;
  const failureCount = samples.filter((sample) => sample.status === 'failed').length;
  const fallbackCount = samples.filter((sample) => sample.status === 'fallback').length;
  const objectiveMetCount = samples.filter((sample) => sample.objectiveMet === true).length;
  const toolSuccessCount = samples.filter((sample) => sample.toolSuccess === true).length;

  return {
    sampleCount,
    successCount,
    failureCount,
    fallbackCount,
    objectiveMetCount,
    toolSuccessCount,
    avgLatencyMs: average(samples.map((sample) => sample.latencyMs)),
    avgTokens: average(samples.map((sample) => sample.totalTokens)),
    avgCostUsd: average(samples.map((sample) => sample.costUsd)),
    successRate: ratio(successCount, sampleCount),
    objectiveRate: ratio(objectiveMetCount, sampleCount),
    toolSuccessRate: ratio(toolSuccessCount, sampleCount),
  };
}

export function scoreModelRouteCandidate(
  summary: ModelRouteSummary,
  weights: RouteScoreWeights = DEFAULT_ROUTE_SCORE_WEIGHTS,
): number {
  if (summary.sampleCount === 0) return 0;
  const latencyPenalty = normalizePenalty(summary.avgLatencyMs, 30_000);
  const costPenalty = normalizePenalty(summary.avgCostUsd, 0.25);
  const tokenPenalty = normalizePenalty(summary.avgTokens, 64_000);
  const fallbackRate = ratio(summary.fallbackCount, summary.sampleCount);

  const raw =
    weights.success * summary.successRate
    + weights.objective * summary.objectiveRate
    + weights.toolSuccess * summary.toolSuccessRate
    - weights.latency * latencyPenalty
    - weights.cost * costPenalty
    - weights.token * tokenPenalty
    - weights.fallbackPenalty * fallbackRate;

  return roundScore(clamp(raw, 0, 1));
}

export function selectBestRouteCandidate(
  candidates: ModelRouteCandidate[],
  weights: RouteScoreWeights = DEFAULT_ROUTE_SCORE_WEIGHTS,
): ScoredModelRouteCandidate | null {
  const scored = candidates
    .filter((candidate) => !candidate.disabledReason)
    .map((candidate) => ({
      ...candidate,
      score: scoreModelRouteCandidate(candidate.summary, weights),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.summary.sampleCount !== a.summary.sampleCount) return b.summary.sampleCount - a.summary.sampleCount;
      return a.model.localeCompare(b.model);
    });
  return scored[0] ?? null;
}

function average(values: Array<number | undefined>): number | null {
  const nums = values.filter((value): value is number => Number.isFinite(value));
  if (nums.length === 0) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function ratio(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : numerator / denominator;
}

function normalizePenalty(value: number | null, highWater: number): number {
  if (value == null || !Number.isFinite(value) || highWater <= 0) return 0;
  return clamp(value / highWater, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function ensureStateDir(): void {
  if (!existsSync(MODEL_ROUTE_METRICS_STATE_DIR)) mkdirSync(MODEL_ROUTE_METRICS_STATE_DIR, { recursive: true });
}

function boolToInt(value: boolean | undefined): 0 | 1 | null {
  if (value === undefined) return null;
  return value ? 1 : 0;
}

export function modelRouteUsageFromResponse(response: ModelResponse): ModelRouteCallUsage {
  const usage = (response as { usage?: unknown }).usage;
  const fields = usageFromUnknown(usage);
  const costUsd = explicitProviderCostUsd(
    (response as { providerData?: unknown }).providerData,
  );
  const receipt = parseProviderPromptCacheUsage(
    (response as { providerData?: { promptCacheUsage?: unknown } }).providerData?.promptCacheUsage,
  );
  return bindProviderPromptCacheUsage(
    costUsd === undefined ? fields : { ...fields, costUsd },
    receipt,
  );
}

function usageFromStreamEvent(event: StreamEvent): ModelRouteCallUsage | null {
  const candidate = event as {
    type?: string;
    response?: { usage?: unknown; providerData?: { promptCacheUsage?: unknown } };
  };
  if (candidate.type !== 'response_done') return null;
  return modelRouteUsageFromResponse((candidate.response ?? {}) as ModelResponse);
}

function bindProviderPromptCacheUsage(
  fields: ModelRouteCallUsage,
  receipt: ProviderPromptCacheUsageV1 | null,
): ModelRouteCallUsage {
  if (!receipt) return fields;
  // The adapter-owned receipt and the generic Agents response must describe the
  // same call. A detached/mismatched receipt is discarded rather than allowed
  // to manufacture a favorable cache number.
  if (fields.inputTokens !== undefined && fields.inputTokens !== receipt.inputTokens) return fields;
  if (fields.cachedTokens !== undefined && fields.cachedTokens !== receipt.cachedInputTokens) return fields;
  return {
    ...fields,
    inputTokens: receipt.inputTokens,
    cachedTokens: receipt.cachedInputTokens,
    promptCacheUsage: receipt,
  };
}

function usageFromUnknown(value: unknown): ModelRouteCallUsage {
  if (!value || typeof value !== 'object') return {};
  const usage = value as Record<string, unknown>;
  const inputTokens = readNumber(usage, 'inputTokens', 'input_tokens', 'prompt_tokens');
  const outputTokens = readNumber(usage, 'outputTokens', 'output_tokens', 'completion_tokens');
  const totalTokens = readNumber(usage, 'totalTokens', 'total_tokens')
    ?? (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
  const inputDetails = readObjects(usage, 'inputTokensDetails', 'input_tokens_details', 'prompt_tokens_details');
  const cachedTokens = readNumber(usage, 'cachedInputTokens', 'cached_input_tokens', 'cache_read_input_tokens')
    ?? (inputDetails.length > 0
      ? inputDetails.reduce((sum, detail) => sum + (
          readNumber(detail, 'cachedTokens', 'cached_tokens', 'cacheReadInputTokens', 'cache_read_input_tokens') ?? 0
        ), 0)
      : undefined);
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens,
  };
}

/** Only adapter-owned explicit billed cost is accepted. Token-derived estimates
 * and provider/model price tables deliberately do not exist in this ledger. */
function explicitProviderCostUsd(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const providerData = value as Record<string, unknown>;
  const raw = providerData.totalCostUsd ?? providerData.total_cost_usd;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

function harnessMetricsContext(context: ModelRouteMetricsContext): ModelRouteMetricsContext {
  if (context.sessionId && context.workflowRunId) return context;
  const active = harnessRunContextStorage.getStore();
  const sessionId = context.sessionId ?? active?.sessionId;
  const workflowRunId = context.workflowRunId ?? workflowRunIdFromSessionId(sessionId);
  return {
    ...context,
    ...(sessionId ? { sessionId } : {}),
    ...(workflowRunId ? { workflowRunId } : {}),
  };
}

function workflowRunIdFromSessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId?.startsWith('workflow:')) return undefined;
  const [, runId] = sessionId.split(':');
  return runId || undefined;
}

function readObjects(record: Record<string, unknown>, ...keys: string[]): Array<Record<string, unknown>> {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
    }
    if (value && typeof value === 'object') return [value as Record<string, unknown>];
  }
  return [];
}

function readNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function errorClass(err: unknown): string {
  if (err && typeof err === 'object') {
    const named = err as { name?: unknown; constructor?: { name?: string } };
    if (typeof named.name === 'string' && named.name.length > 0) return named.name;
    if (typeof named.constructor?.name === 'string' && named.constructor.name.length > 0) return named.constructor.name;
  }
  return typeof err;
}
