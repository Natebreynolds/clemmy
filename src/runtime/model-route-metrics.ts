import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import { BASE_DIR } from '../config.js';
import { recordOperationalEvent } from './operational-telemetry.js';

export const MODEL_ROUTE_METRICS_SCHEMA_VERSION = 1;

export const MODEL_ROUTE_METRICS_TABLES = [
  'model_route_decisions',
  'model_route_outcomes',
  'model_route_policy',
] as const;

export type ModelRouteMetricsTableName = (typeof MODEL_ROUTE_METRICS_TABLES)[number];

export type ModelRouteRole = 'brain' | 'worker' | 'judge';
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

/**
 * Local-first metrics schema for future route policy updates.
 *
 * The router can append one decision before dispatch and one outcome after the
 * call. A periodic policy job can then update model_route_policy without making
 * the hot path depend on online learning.
 */
export const MODEL_ROUTE_METRICS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS model_route_decisions (
  id                 TEXT PRIMARY KEY,
  created_at         TEXT NOT NULL,
  session_id         TEXT,
  workflow_run_id    TEXT,
  workflow_node_id   TEXT,
  workspace_id       TEXT,
  role               TEXT NOT NULL CHECK (role IN ('brain','worker','judge')),
  intent             TEXT,
  requested_model    TEXT,
  resolved_model     TEXT NOT NULL,
  provider           TEXT NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('default','binding','intent_binding','explicit','fallback','policy')),
  reason_json        TEXT NOT NULL DEFAULT '{}',
  policy_version     INTEGER
);

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

CREATE TABLE IF NOT EXISTS model_route_policy (
  id                  TEXT PRIMARY KEY,
  role                TEXT NOT NULL CHECK (role IN ('brain','worker','judge')),
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
);

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
  cachedDb = db;
  return db;
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
      INSERT OR REPLACE INTO model_route_decisions (
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
): void {
  const completedAt = (input.now ?? new Date()).toISOString();
  try {
    (db ?? openModelRouteMetricsDb()).prepare(`
      INSERT OR REPLACE INTO model_route_outcomes (
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
  } catch {
    // Metrics must never fail a model call.
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

export function withModelRouteMetrics(model: Model, context: ModelRouteMetricsContext): Model {
  return new ModelRouteMetricsModel(model, context);
}

class ModelRouteMetricsModel implements Model {
  constructor(private readonly inner: Model, private readonly context: ModelRouteMetricsContext) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const startedAt = Date.now();
    const decisionId = this.startCall('getResponse');
    try {
      const response = await this.inner.getResponse(request);
      const usage = usageFromResponse(response);
      this.finishCall(decisionId, 'success', startedAt, usage, { path: 'getResponse' });
      return response;
    } catch (err) {
      this.finishCall(decisionId, 'failed', startedAt, {}, {
        path: 'getResponse',
        error: errorMessage(err),
      }, errorClass(err));
      throw err;
    }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const startedAt = Date.now();
    const decisionId = this.startCall('getStreamedResponse');
    let usage: UsageFields = {};
    let completed = false;
    let failed = false;
    try {
      for await (const event of this.inner.getStreamedResponse(request)) {
        const doneUsage = usageFromStreamEvent(event);
        if (doneUsage) usage = doneUsage;
        yield event;
      }
      completed = true;
      this.finishCall(decisionId, 'success', startedAt, usage, { path: 'getStreamedResponse' });
    } catch (err) {
      failed = true;
      this.finishCall(decisionId, 'failed', startedAt, usage, {
        path: 'getStreamedResponse',
        error: errorMessage(err),
      }, errorClass(err));
      throw err;
    } finally {
      if (!completed && !failed) {
        this.finishCall(decisionId, 'cancelled', startedAt, usage, { path: 'getStreamedResponse' });
      }
    }
  }

  private startCall(pathName: 'getResponse' | 'getStreamedResponse'): string {
    const decisionId = recordModelRouteDecision({
      ...this.context,
      id: this.context.modelCallIdPrefix ? `${this.context.modelCallIdPrefix}:${randomUUID()}` : undefined,
      reason: {
        ...(this.context.reason ?? {}),
        path: pathName,
      },
    });
    recordOperationalEvent({
      source: 'model',
      type: 'model_call_started',
      severity: 'info',
      sessionId: this.context.sessionId,
      workflowRunId: this.context.workflowRunId,
      workflowNodeRunId: this.context.workflowNodeId,
      workspaceId: this.context.workspaceId,
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
    usage: UsageFields,
    metadata: Record<string, unknown>,
    errorClassName?: string,
  ): void {
    recordModelRouteOutcome({
      decisionId,
      status,
      latencyMs: Math.max(0, Date.now() - startedAt),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      totalTokens: usage.totalTokens,
      errorClass: errorClassName,
      metadata,
    });
    if (status === 'failed') {
      recordOperationalEvent({
        source: 'model',
        type: 'model_call_failed',
        severity: 'error',
        sessionId: this.context.sessionId,
        workflowRunId: this.context.workflowRunId,
        workflowNodeRunId: this.context.workflowNodeId,
        workspaceId: this.context.workspaceId,
        modelCallId: decisionId,
        actor: 'model-route-metrics',
        payload: {
          ...metadata,
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

interface UsageFields {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
}

function ensureStateDir(): void {
  if (!existsSync(MODEL_ROUTE_METRICS_STATE_DIR)) mkdirSync(MODEL_ROUTE_METRICS_STATE_DIR, { recursive: true });
}

function boolToInt(value: boolean | undefined): 0 | 1 | null {
  if (value === undefined) return null;
  return value ? 1 : 0;
}

function usageFromResponse(response: ModelResponse): UsageFields {
  const usage = (response as { usage?: unknown }).usage;
  return usageFromUnknown(usage);
}

function usageFromStreamEvent(event: StreamEvent): UsageFields | null {
  const candidate = event as { type?: string; response?: { usage?: unknown } };
  if (candidate.type !== 'response_done') return null;
  return usageFromUnknown(candidate.response?.usage);
}

function usageFromUnknown(value: unknown): UsageFields {
  if (!value || typeof value !== 'object') return {};
  const usage = value as Record<string, unknown>;
  const inputTokens = readNumber(usage, 'inputTokens', 'input_tokens', 'prompt_tokens');
  const outputTokens = readNumber(usage, 'outputTokens', 'output_tokens', 'completion_tokens');
  const totalTokens = readNumber(usage, 'totalTokens', 'total_tokens')
    ?? (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
  const inputDetails = readObject(usage, 'inputTokensDetails', 'input_tokens_details', 'prompt_tokens_details');
  const cachedTokens = readNumber(usage, 'cachedInputTokens', 'cached_input_tokens', 'cache_read_input_tokens')
    ?? (inputDetails ? readNumber(inputDetails, 'cachedTokens', 'cached_tokens', 'cache_read_input_tokens') : undefined);
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens,
  };
}

function readObject(record: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return undefined;
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

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
