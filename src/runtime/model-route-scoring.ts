/**
 * Route outcome scoring, and the policy table rebuilt from it, against any
 * connection. The daemon's hourly policy job runs the rebuild in a worker on
 * its own connection, so the loop never waits behind the window's rows.
 *
 * This module never imports config, telemetry or the event log: the worker
 * loads it.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type ModelRouteRole = 'brain' | 'worker' | 'judge' | 'writer' | 'memory' | 'quick';
export type ModelRouteOutcomeStatus = 'success' | 'failed' | 'fallback' | 'cancelled';

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

export const DEFAULT_ROUTE_SCORE_WEIGHTS: RouteScoreWeights = {
  success: 0.45,
  objective: 0.25,
  toolSuccess: 0.15,
  latency: 0.06,
  cost: 0.05,
  token: 0.02,
  fallbackPenalty: 0.02,
};

export function average(values: Array<number | undefined>): number | null {
  const nums = values.filter((value): value is number => Number.isFinite(value));
  if (nums.length === 0) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

export function ratio(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : numerator / denominator;
}

export function normalizePenalty(value: number | null, highWater: number): number {
  if (value == null || !Number.isFinite(value) || highWater <= 0) return 0;
  return clamp(value / highWater, 0, 1);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function summarizeRouteOutcomes(samples: ModelRouteOutcomeSample[]): ModelRouteSummary {
  const sampleCount = samples.length;
  const successCount = samples.filter((sample) => sample.status === 'success').length;
  const failureCount = samples.filter((sample) => sample.status === 'failed').length;
  const fallbackCount = samples.filter((sample) => sample.status === 'fallback').length;
  const objectiveMetCount = samples.filter((sample) => sample.objectiveMet === true).length;
  const toolSuccessCount = samples.filter((sample) => sample.toolSuccess === true).length;
  // A turn's verdict lands on the one request that wrote its reply, and only
  // when something reviewed it; every other request carries no verdict. The
  // rates are over the samples that carry the signal, so "not reviewed" never
  // reads as "failed review".
  const objectiveSamples = samples.filter((sample) => sample.objectiveMet !== undefined).length;
  const toolSamples = samples.filter((sample) => sample.toolSuccess !== undefined).length;

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
    objectiveRate: ratio(objectiveMetCount, objectiveSamples),
    toolSuccessRate: ratio(toolSuccessCount, toolSamples),
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

/**
 * Weights adapted to the signals a group ACTUALLY carries. Not every capture
 * seam can attribute every signal (judge passes have no toolSuccess/objective;
 * some lanes omit objectiveMet) — scoring an ABSENT signal as zero would
 * permanently pin those groups below the quality floor ("no data" is not
 * "objective never met"). Redistribute missing positive weights onto the
 * success rate so a signal-poor group competes on the evidence it has, and a
 * signal-rich group is scored exactly as before.
 */
export function weightsForSamples(samples: ModelRouteOutcomeSample[]): RouteScoreWeights {
  const w = { ...DEFAULT_ROUTE_SCORE_WEIGHTS };
  if (samples.every((s) => s.objectiveMet === undefined)) {
    w.success += w.objective;
    w.objective = 0;
  }
  if (samples.every((s) => s.toolSuccess === undefined)) {
    w.success += w.toolSuccess;
    w.toolSuccess = 0;
  }
  return w;
}

interface OutcomeJoinRow {
  role: ModelRouteRole;
  intent: string | null;
  provider: string;
  resolved_model: string;
  status: ModelRouteOutcomeStatus;
  latency_ms: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  objective_met: number | null;
  tool_success: number | null;
}

export interface RoutePolicyRebuild {
  policyVersion: number;
  rowsWritten: number;
  groupsScored: number;
}

/**
 * Rebuild model_route_policy from the outcomes completed since `cutoff`. Full
 * rewrite in one transaction — the table is derived data; a rebuild is
 * always consistent with the evidence.
 */
export function rebuildRoutePolicyTable(db: Database.Database, input: {
  cutoff: string;
  minSamples: number;
  floor: number;
  updatedAt: string;
}): RoutePolicyRebuild {
  const rows = db.prepare(`
    SELECT d.role, d.intent, d.provider, d.resolved_model,
           o.status, o.latency_ms, o.total_tokens, o.cost_usd,
           o.objective_met, o.tool_success
    FROM model_route_outcomes o
    JOIN model_route_decisions d ON d.id = o.decision_id
    WHERE o.completed_at >= ?
  `).all(input.cutoff) as OutcomeJoinRow[];

  const groups = new Map<string, { role: ModelRouteRole; intent: string | null; provider: string; model: string; samples: ModelRouteOutcomeSample[] }>();
  for (const row of rows) {
    const key = `${row.role}\u0000${row.intent ?? ''}\u0000${row.provider}\u0000${row.resolved_model}`;
    let group = groups.get(key);
    if (!group) {
      group = { role: row.role, intent: row.intent, provider: row.provider, model: row.resolved_model, samples: [] };
      groups.set(key, group);
    }
    group.samples.push({
      status: row.status,
      latencyMs: row.latency_ms ?? undefined,
      totalTokens: row.total_tokens ?? undefined,
      costUsd: row.cost_usd ?? undefined,
      objectiveMet: row.objective_met === null ? undefined : row.objective_met === 1,
      toolSuccess: row.tool_success === null ? undefined : row.tool_success === 1,
    });
  }

  const insert = db.prepare(`
    INSERT INTO model_route_policy (
      id, role, intent, provider, model, score, sample_count, success_count,
      objective_met_count, avg_latency_ms, avg_cost_usd, disabled_reason,
      policy_version, updated_at
    ) VALUES (
      @id, @role, @intent, @provider, @model, @score, @sampleCount, @successCount,
      @objectiveMetCount, @avgLatencyMs, @avgCostUsd, @disabledReason,
      @policyVersion, @updatedAt
    )
  `);
  return db.transaction((): RoutePolicyRebuild => {
    const prevVersion = (db.prepare(`SELECT MAX(policy_version) AS v FROM model_route_policy`).get() as { v: number | null }).v ?? 0;
    const policyVersion = prevVersion + 1;
    db.prepare(`DELETE FROM model_route_policy`).run();
    for (const group of groups.values()) {
      const summary = summarizeRouteOutcomes(group.samples);
      const score = scoreModelRouteCandidate(summary, weightsForSamples(group.samples));
      const disabledReason = summary.sampleCount < input.minSamples
        ? 'insufficient_samples'
        : score < input.floor
          ? 'below_floor'
          : null;
      insert.run({
        id: randomUUID(),
        role: group.role,
        intent: group.intent,
        provider: group.provider,
        model: group.model,
        score,
        sampleCount: summary.sampleCount,
        successCount: summary.successCount,
        objectiveMetCount: summary.objectiveMetCount,
        avgLatencyMs: summary.avgLatencyMs,
        avgCostUsd: summary.avgCostUsd,
        disabledReason,
        policyVersion,
        updatedAt: input.updatedAt,
      });
    }
    return { policyVersion, rowsWritten: groups.size, groupsScored: groups.size };
  }).immediate();
}
