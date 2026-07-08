/**
 * Cross-family JUDGE primitives — the leaf home for "the judge should be a
 * different LLM family than the brain whenever possible" (never self-grade).
 *
 * Extracted from debate-model.ts so BOTH debate-model (the model-building judge
 * paths) and model-roles (the judge-role DEFAULT) can share one canonical copy
 * WITHOUT a circular import and WITHOUT pulling debate-model's heavy provider /
 * agents-SDK graph into model-roles. This module depends only on config + the
 * OAuth token stores + a type — it builds no models itself.
 *
 * The decision is split from the model BUILD on purpose: `chooseBoundaryJudgeFamily`
 * is a pure function (deterministically testable); debate-model owns the
 * provider-heavy `buildJudgeForRole` / `resolveBoundaryJudge` that turn the
 * decision into a live Model.
 */
import { getRuntimeEnv } from '../../config.js';
import { getStoredCodexOAuthTokens } from '../auth-store.js';
import { getStoredClaudeTokens } from '../claude-oauth.js';
import type { ModelProviderClass } from './model-wire-registry.js';

/** Subscription OAuth access tokens start with this prefix; an api03 API key is
 *  never treated as "available" (preserves the billing guard). */
const CLAUDE_OAT_PREFIX = 'sk-ant-oat01';

/** Is the Claude (Anthropic) subscription brain logged in + usable right now? */
export function claudeAvailable(): boolean {
  try {
    const t = getStoredClaudeTokens();
    if (!t?.accessToken?.startsWith(CLAUDE_OAT_PREFIX)) return false;
    if (t.refreshToken) return true; // refreshable → the request path will renew it
    return !t.expiresAt || t.expiresAt > Date.now() + 60_000; // non-refreshable → must be unexpired
  } catch {
    return false;
  }
}

/** Is the Codex (OpenAI) OAuth brain logged in? */
export function codexAvailable(): boolean {
  try {
    return Boolean(getStoredCodexOAuthTokens()?.accessToken);
  } catch {
    return false;
  }
}

/** Diagnostic: which flagships are logged in. Debate needs BOTH. */
export function debateBrainsAvailable(): { claude: boolean; codex: boolean } {
  return { claude: claudeAvailable(), codex: codexAvailable() };
}

/** off ⇒ boundary judges keep MODELS.fast exactly as before (byte-identical). */
export function judgeCrossFamilyEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_JUDGE_CROSS_FAMILY', 'on') || 'on').trim().toLowerCase() !== 'off';
}

/** Wall-clock cap for hot-path judge calls. Judges are advisory or fail-open at
 *  their call sites, so a slow checker should degrade to "not judged" instead
 *  of adding unbounded latency to chat or irreversible-write gates. */
export function boundaryJudgeTimeoutMs(): number {
  // Default raised 12s -> 25s (2026-07-08): live metrics showed 7 of 9 boundary
  // judge calls timing out with avg 14.7s / max 18.7s on gpt-5.4-mini during a
  // degraded-network evening — the verdicts were VALID (invalid: 0), the judge
  // was simply hung up on right before answering, silently downgrading
  // completion/grounding checks to advisory 78% of the time. 25s covers the
  // observed p100 with margin while still bounding a truly hung call.
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_BOUNDARY_JUDGE_TIMEOUT_MS', '25000') ?? '25000', 10);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 25000;
}

export async function withJudgeTimeout<T>(work: Promise<T>, timeoutMs = boundaryJudgeTimeoutMs()): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type JudgeMetricLane = 'completion' | 'grounding' | 'goal_fidelity' | 'output_grounding';
export type JudgeMetricOutcome = 'passed' | 'blocked' | 'advisory' | 'timeout' | 'invalid' | 'error';

export interface JudgeMetricRecord {
  lane: JudgeMetricLane;
  outcome: JudgeMetricOutcome;
  durationMs: number;
  modelId?: string;
  judgeFamily?: ModelProviderClass;
  brainFamily?: ModelProviderClass;
  selfJudge?: boolean;
}

export interface JudgeMetricLaneSnapshot {
  lane: JudgeMetricLane;
  calls: number;
  passed: number;
  blocked: number;
  advisory: number;
  timeouts: number;
  invalid: number;
  errors: number;
  avgMs: number;
  maxMs: number;
  lastOutcome?: JudgeMetricOutcome;
  lastDurationMs?: number;
  lastModelId?: string;
  lastJudgeFamily?: ModelProviderClass;
  lastBrainFamily?: ModelProviderClass;
  lastSelfJudge?: boolean;
  updatedAt?: string;
}

export interface JudgeMetricsSnapshot {
  timeoutMs: number;
  total: Omit<JudgeMetricLaneSnapshot, 'lane'>;
  lanes: JudgeMetricLaneSnapshot[];
  updatedAt?: string;
}

interface JudgeMetricAggregate extends JudgeMetricLaneSnapshot {
  totalMs: number;
}

const JUDGE_METRIC_LANES: JudgeMetricLane[] = ['completion', 'grounding', 'goal_fidelity', 'output_grounding'];
const judgeMetrics = new Map<JudgeMetricLane, JudgeMetricAggregate>();

function emptyJudgeMetricAggregate(lane: JudgeMetricLane): JudgeMetricAggregate {
  return {
    lane,
    calls: 0,
    passed: 0,
    blocked: 0,
    advisory: 0,
    timeouts: 0,
    invalid: 0,
    errors: 0,
    avgMs: 0,
    maxMs: 0,
    totalMs: 0,
  };
}

function publicLaneSnapshot(agg: JudgeMetricAggregate): JudgeMetricLaneSnapshot {
  const snapshot: JudgeMetricLaneSnapshot = {
    lane: agg.lane,
    calls: agg.calls,
    passed: agg.passed,
    blocked: agg.blocked,
    advisory: agg.advisory,
    timeouts: agg.timeouts,
    invalid: agg.invalid,
    errors: agg.errors,
    avgMs: agg.avgMs,
    maxMs: agg.maxMs,
  };
  if (agg.lastOutcome !== undefined) snapshot.lastOutcome = agg.lastOutcome;
  if (agg.lastDurationMs !== undefined) snapshot.lastDurationMs = agg.lastDurationMs;
  if (agg.lastModelId !== undefined) snapshot.lastModelId = agg.lastModelId;
  if (agg.lastJudgeFamily !== undefined) snapshot.lastJudgeFamily = agg.lastJudgeFamily;
  if (agg.lastBrainFamily !== undefined) snapshot.lastBrainFamily = agg.lastBrainFamily;
  if (agg.lastSelfJudge !== undefined) snapshot.lastSelfJudge = agg.lastSelfJudge;
  if (agg.updatedAt !== undefined) snapshot.updatedAt = agg.updatedAt;
  return snapshot;
}

function publicTotalSnapshot(snapshot: JudgeMetricLaneSnapshot): Omit<JudgeMetricLaneSnapshot, 'lane'> {
  const total: Omit<JudgeMetricLaneSnapshot, 'lane'> = {
    calls: snapshot.calls,
    passed: snapshot.passed,
    blocked: snapshot.blocked,
    advisory: snapshot.advisory,
    timeouts: snapshot.timeouts,
    invalid: snapshot.invalid,
    errors: snapshot.errors,
    avgMs: snapshot.avgMs,
    maxMs: snapshot.maxMs,
  };
  if (snapshot.lastOutcome !== undefined) total.lastOutcome = snapshot.lastOutcome;
  if (snapshot.lastDurationMs !== undefined) total.lastDurationMs = snapshot.lastDurationMs;
  if (snapshot.lastModelId !== undefined) total.lastModelId = snapshot.lastModelId;
  if (snapshot.lastJudgeFamily !== undefined) total.lastJudgeFamily = snapshot.lastJudgeFamily;
  if (snapshot.lastBrainFamily !== undefined) total.lastBrainFamily = snapshot.lastBrainFamily;
  if (snapshot.lastSelfJudge !== undefined) total.lastSelfJudge = snapshot.lastSelfJudge;
  if (snapshot.updatedAt !== undefined) total.updatedAt = snapshot.updatedAt;
  return total;
}

export function recordJudgeMetric(record: JudgeMetricRecord): void {
  const durationMs = Math.max(0, Math.round(record.durationMs));
  const agg = judgeMetrics.get(record.lane) ?? emptyJudgeMetricAggregate(record.lane);
  agg.calls += 1;
  agg.totalMs += durationMs;
  agg.avgMs = Math.round(agg.totalMs / agg.calls);
  agg.maxMs = Math.max(agg.maxMs, durationMs);
  if (record.outcome === 'passed') agg.passed += 1;
  else if (record.outcome === 'blocked') agg.blocked += 1;
  else if (record.outcome === 'advisory') agg.advisory += 1;
  else if (record.outcome === 'timeout') agg.timeouts += 1;
  else if (record.outcome === 'invalid') agg.invalid += 1;
  else agg.errors += 1;
  agg.lastOutcome = record.outcome;
  agg.lastDurationMs = durationMs;
  delete agg.lastModelId;
  delete agg.lastJudgeFamily;
  delete agg.lastBrainFamily;
  delete agg.lastSelfJudge;
  if (record.modelId !== undefined) agg.lastModelId = record.modelId;
  if (record.judgeFamily !== undefined) agg.lastJudgeFamily = record.judgeFamily;
  if (record.brainFamily !== undefined) agg.lastBrainFamily = record.brainFamily;
  if (record.selfJudge !== undefined) agg.lastSelfJudge = record.selfJudge;
  agg.updatedAt = new Date().toISOString();
  judgeMetrics.set(record.lane, agg);
}

export function getJudgeMetricsSnapshot(): JudgeMetricsSnapshot {
  const aggregates = JUDGE_METRIC_LANES.map((lane) => judgeMetrics.get(lane) ?? emptyJudgeMetricAggregate(lane));
  const lanes = aggregates.map(publicLaneSnapshot);
  const totalInternal = emptyJudgeMetricAggregate('completion');
  for (const agg of aggregates) {
    totalInternal.calls += agg.calls;
    totalInternal.passed += agg.passed;
    totalInternal.blocked += agg.blocked;
    totalInternal.advisory += agg.advisory;
    totalInternal.timeouts += agg.timeouts;
    totalInternal.invalid += agg.invalid;
    totalInternal.errors += agg.errors;
    totalInternal.totalMs += agg.totalMs;
    totalInternal.maxMs = Math.max(totalInternal.maxMs, agg.maxMs);
    if (agg.lastOutcome && (!totalInternal.updatedAt || (agg.updatedAt ?? '') > totalInternal.updatedAt)) {
      totalInternal.lastOutcome = agg.lastOutcome;
      totalInternal.lastDurationMs = agg.lastDurationMs;
      totalInternal.lastModelId = agg.lastModelId;
      totalInternal.lastJudgeFamily = agg.lastJudgeFamily;
      totalInternal.lastBrainFamily = agg.lastBrainFamily;
      totalInternal.lastSelfJudge = agg.lastSelfJudge;
      totalInternal.updatedAt = agg.updatedAt;
    }
  }
  totalInternal.avgMs = totalInternal.calls > 0 ? Math.round(totalInternal.totalMs / totalInternal.calls) : 0;
  const totalSnapshot = publicLaneSnapshot(totalInternal);
  const total = publicTotalSnapshot(totalSnapshot);
  const snapshot: JudgeMetricsSnapshot = { timeoutMs: boundaryJudgeTimeoutMs(), total, lanes };
  if (total.updatedAt !== undefined) snapshot.updatedAt = total.updatedAt;
  return snapshot;
}

export function resetJudgeMetricsForTests(): void {
  judgeMetrics.clear();
}

/** The cheap Claude id for a cross-family boundary judge — the lightest pass,
 *  since these run on most action turns. Tunable; defaults to Haiku. */
export function boundaryClaudeJudgeModel(): string {
  return (getRuntimeEnv('CLEMMY_BOUNDARY_JUDGE_CLAUDE_MODEL', '') || '').trim() || 'claude-haiku-4-5';
}

/** The cheap Codex (gpt) id for a cross-family boundary judge. A code-level
 *  family DEFAULT, NOT MODELS.fast — the "fast" tier can be env-overridden to a
 *  BYO/GLM model (e.g. glm-5.2), which would mis-route a "codex" judge onto the
 *  wrong provider. Tunable; defaults to the canonical cheap gpt id. */
export function boundaryCodexJudgeModel(): string {
  return (getRuntimeEnv('CLEMMY_BOUNDARY_JUDGE_CODEX_MODEL', '') || '').trim() || 'gpt-5.4-mini';
}

/** PURE family decision: the cheapest model+provider from a family DIFFERENT than
 *  the brain, or null when none is available (caller fails open same-family).
 *  Separated from the provider-heavy build so it is deterministically testable. */
export function chooseBoundaryJudgeFamily(
  brainFamily: ModelProviderClass,
  haveClaude: boolean,
  haveCodex: boolean,
): { provider: ModelProviderClass; modelId: string } | null {
  if (brainFamily !== 'claude' && haveClaude) return { provider: 'claude', modelId: boundaryClaudeJudgeModel() };
  if (brainFamily !== 'codex' && haveCodex) return { provider: 'codex', modelId: boundaryCodexJudgeModel() };
  return null;
}
