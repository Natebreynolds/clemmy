/**
 * Adaptive route policy — the learning layer over model-route-metrics.
 *
 * Two halves, deliberately split so the hot path never depends on online
 * learning (the schema was designed for exactly this):
 *
 *   1. runRoutePolicyJob() — a PERIODIC OFFLINE job (daemon tick) that groups
 *      recent route outcomes by (role, intent, provider, model), scores each
 *      group with the existing scorer, and rebuilds the model_route_policy
 *      table. Deterministic, cheap, observable (route_policy_updated).
 *
 *   2. pickRoutePolicyModel() — the BOUNDED hot-path read consulted by
 *      resolveRoleModel AFTER explicit user bindings (those always win) and
 *      BEFORE the static default. Guards, in order:
 *        - kill-switch CLEMMY_ROUTE_POLICY (off ⇒ never consulted)
 *        - an UNMEASURED default is never switched away from (it accumulates
 *          evidence first)
 *        - quality floor (a MEASURED low scorer is never routed to, however
 *          fast)
 *        - live validation (the candidate's provider must actually be
 *          connected right now).
 *      Reads are TTL-cached so the resolver costs no DB hit per call.
 *
 * The pick itself is THOMPSON SAMPLING over Beta posteriors derived from the
 * policy table's own success/sample counts: each eligible candidate (and the
 * default) draws from Beta(1+successes, 1+failures) and the highest draw wins,
 * ties to the default. Under-sampled candidates stay eligible with wide
 * posteriors — that IS the exploration; a model's draws tighten as evidence
 * accumulates, and a model that once scored badly can still earn its way back.
 * The draw is memoized for the read-cache window so consecutive resolves in
 * one conversation never flip models. Kill-switch
 * CLEMMY_ROUTE_POLICY_THOMPSON=off restores the previous greedy
 * score+hysteresis pick.
 *
 * Two fences keep the bandit from burning money: CLEMMY_ROUTE_POLICY_DENY
 * lists models it may never pick, and the cost guard only lets it switch to
 * candidates measurably NOT pricier than the default (tolerance
 * CLEMMY_ROUTE_POLICY_COST_TOLERANCE, default 1.25×) — the policy drifts
 * toward the cheapest model that gets the job done; routing UP to premium
 * models is only ever an explicit user binding.
 *
 * With an empty policy table (or the flag off) resolution is byte-identical
 * to the static behavior — characterization-tested.
 */
import { randomUUID } from 'node:crypto';
import { getRuntimeEnv } from '../../config.js';
import { recordOperationalEvent } from '../operational-telemetry.js';
import {
  openModelRouteMetricsDb,
  summarizeRouteOutcomes,
  scoreModelRouteCandidate,
  DEFAULT_ROUTE_SCORE_WEIGHTS,
  type RouteScoreWeights,
  type ModelRouteRole,
  type ModelRouteOutcomeSample,
  type ModelRouteOutcomeStatus,
} from '../model-route-metrics.js';

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

export interface RoutePolicyRow {
  role: ModelRouteRole;
  intent: string | null;
  provider: string;
  model: string;
  score: number;
  sampleCount: number;
  successCount: number;
  objectiveMetCount: number;
  avgLatencyMs: number | null;
  avgCostUsd: number | null;
  disabledReason: string | null;
  policyVersion: number;
}

export interface RoutePolicyPick {
  modelId: string;
  provider: string;
  score: number;
  defaultScore: number;
  sampleCount: number;
  policyVersion: number;
}

/** Kill-switch for the HOT-PATH READ. The offline job always runs (observe-only
 *  rows power the dashboard either way); only routing BEHAVIOR is gated. */
export function routePolicyEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test((getRuntimeEnv('CLEMMY_ROUTE_POLICY', 'off') ?? 'off').trim());
}

/** Below this many samples a candidate is evidence, not policy. */
export function routePolicyMinSamples(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_ROUTE_POLICY_MIN_SAMPLES', '8') ?? '8', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 8;
}

/** Quality floor — never route to a model scoring below this, however cheap/fast. */
export function routePolicyFloor(): number {
  const raw = Number.parseFloat(getRuntimeEnv('CLEMMY_ROUTE_POLICY_FLOOR', '0.55') ?? '0.55');
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.55;
}

/** Hysteresis margin — the candidate must beat the measured default by this much
 *  (greedy branch only; Thompson replaces the margin with posterior draws). */
export function routePolicyMargin(): number {
  const raw = Number.parseFloat(getRuntimeEnv('CLEMMY_ROUTE_POLICY_MARGIN', '0.08') ?? '0.08');
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.08;
}

/** Kill-switch for the Thompson-sampling pick (default ON; off ⇒ the previous
 *  greedy score+hysteresis pick). A kill-switch, not a rollout flag. */
export function routePolicyThompsonEnabled(): boolean {
  return !/^(0|false|off|no)$/i.test((getRuntimeEnv('CLEMMY_ROUTE_POLICY_THOMPSON', 'on') ?? 'on').trim());
}

/** Models the learned policy must NEVER route to (comma-separated ids or
 *  prefixes, e.g. "claude-fable"). Explicit user bindings still work — this
 *  only fences the bandit's own picks. */
export function routePolicyDeniedModels(): string[] {
  return (getRuntimeEnv('CLEMMY_ROUTE_POLICY_DENY', '') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Cost tolerance: the policy may pick a candidate costing up to this multiple
 *  of the measured default's avg cost. The bandit explores sideways/DOWN in
 *  cost — routing UP to premium models is the user's call (explicit binding),
 *  never the bandit's. */
export function routePolicyCostTolerance(): number {
  const raw = Number.parseFloat(getRuntimeEnv('CLEMMY_ROUTE_POLICY_COST_TOLERANCE', '1.25') ?? '1.25');
  return Number.isFinite(raw) && raw >= 1 ? raw : 1.25;
}

/** How far back the job looks for outcomes. */
function routePolicyWindowDays(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_ROUTE_POLICY_WINDOW_DAYS', '14') ?? '14', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 14;
}

// ─── The offline policy job ────────────────────────────────────────────────

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

export interface RoutePolicyJobResult {
  policyVersion: number;
  rowsWritten: number;
  groupsScored: number;
  windowDays: number;
}

/**
 * Rebuild model_route_policy from the recent outcome window. Full rewrite in a
 * transaction — the table is derived data; a rebuild is always consistent with
 * the evidence. Never throws (returns null on failure); must be safe to call
 * from a daemon tick.
 */
export function runRoutePolicyJob(opts: { now?: Date } = {}): RoutePolicyJobResult | null {
  try {
    const db = openModelRouteMetricsDb();
    const now = opts.now ?? new Date();
    const windowDays = routePolicyWindowDays();
    const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const rows = db.prepare(`
      SELECT d.role, d.intent, d.provider, d.resolved_model,
             o.status, o.latency_ms, o.total_tokens, o.cost_usd,
             o.objective_met, o.tool_success
      FROM model_route_outcomes o
      JOIN model_route_decisions d ON d.id = o.decision_id
      WHERE o.completed_at >= ?
    `).all(cutoff) as OutcomeJoinRow[];

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

    const prevVersion = (db.prepare(`SELECT MAX(policy_version) AS v FROM model_route_policy`).get() as { v: number | null }).v ?? 0;
    const policyVersion = prevVersion + 1;
    const minSamples = routePolicyMinSamples();
    const floor = routePolicyFloor();
    const updatedAt = now.toISOString();

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
    const rebuild = db.transaction(() => {
      db.prepare(`DELETE FROM model_route_policy`).run();
      for (const group of groups.values()) {
        const summary = summarizeRouteOutcomes(group.samples);
        const score = scoreModelRouteCandidate(summary, weightsForSamples(group.samples));
        const disabledReason = summary.sampleCount < minSamples
          ? 'insufficient_samples'
          : score < floor
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
          updatedAt,
        });
      }
    });
    rebuild();
    clearRoutePolicyCache();

    const result: RoutePolicyJobResult = {
      policyVersion,
      rowsWritten: groups.size,
      groupsScored: groups.size,
      windowDays,
    };
    try {
      recordOperationalEvent({
        source: 'model',
        type: 'route_policy_updated',
        severity: 'info',
        actor: 'route-policy-job',
        now,
        payload: { ...result, minSamples, floor, readEnabled: routePolicyEnabled() },
      });
    } catch { /* telemetry is best-effort */ }
    return result;
  } catch {
    return null; // the policy job must never take down a daemon tick
  }
}

// ─── The bounded hot-path read ─────────────────────────────────────────────

const READ_CACHE_TTL_MS = 60_000;
const readCache = new Map<string, { at: number; rows: RoutePolicyRow[] }>();
const pickCache = new Map<string, { at: number; pick: RoutePolicyPick | null }>();

export function clearRoutePolicyCache(): void {
  readCache.clear();
  pickCache.clear();
}

// ─── Thompson sampling ─────────────────────────────────────────────────────

type BetaSampler = (alpha: number, beta: number) => number;

let samplerOverride: BetaSampler | null = null;

/** Inject a deterministic posterior sampler (e.g. the mean α/(α+β)) so pick
 *  tests need no real randomness. Pass null to restore the default. */
export function setRoutePolicySamplerForTest(sampler: BetaSampler | null): void {
  samplerOverride = sampler;
  pickCache.clear();
}

/** Marsaglia–Tsang gamma draw. Only called with shape ≥ 1 (Beta(1+s, 1+f)). */
function sampleGamma(shape: number, rng: () => number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      // Box–Muller; clamp the uniform away from 0 so the log stays finite.
      const u1 = Math.max(rng(), Number.EPSILON);
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = (1 + c * x) ** 3;
    } while (v <= 0);
    const u = Math.max(rng(), Number.EPSILON);
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Draw from Beta(alpha, beta). Deterministic under a seeded rng. */
export function sampleBeta(alpha: number, beta: number, rng: () => number = Math.random): number {
  const a = sampleGamma(alpha, rng);
  const b = sampleGamma(beta, rng);
  return a / (a + b);
}

/** Posterior draw for a policy row: Beta(1+successes, 1+failures). Cancelled
 *  outcomes count against the model — consistent with successRate in the score. */
function drawPosterior(row: RoutePolicyRow): number {
  const successes = Math.max(0, Math.min(row.successCount, row.sampleCount));
  const failures = Math.max(0, row.sampleCount - successes);
  const sampler = samplerOverride ?? ((a: number, b: number) => sampleBeta(a, b));
  return sampler(1 + successes, 1 + failures);
}

function mapRow(raw: Record<string, unknown>): RoutePolicyRow {
  return {
    role: raw.role as ModelRouteRole,
    intent: (raw.intent as string | null) ?? null,
    provider: String(raw.provider),
    model: String(raw.model),
    score: Number(raw.score),
    sampleCount: Number(raw.sample_count),
    successCount: Number(raw.success_count),
    objectiveMetCount: Number(raw.objective_met_count),
    avgLatencyMs: raw.avg_latency_ms === null ? null : Number(raw.avg_latency_ms),
    avgCostUsd: raw.avg_cost_usd === null ? null : Number(raw.avg_cost_usd),
    disabledReason: (raw.disabled_reason as string | null) ?? null,
    policyVersion: Number(raw.policy_version),
  };
}

/** All rows for a (role, intent-or-null) scope — cached so the resolver never
 *  pays a per-call DB read. Includes disabled rows (the caller reasons about
 *  the default's evidence even when it's below the floor). */
function readScopeRows(role: ModelRouteRole, intent: string | null): RoutePolicyRow[] {
  const key = `${role}\u0000${intent ?? ''}`;
  const hit = readCache.get(key);
  const nowMs = Date.now();
  if (hit && nowMs - hit.at < READ_CACHE_TTL_MS) return hit.rows;
  let rows: RoutePolicyRow[] = [];
  try {
    const db = openModelRouteMetricsDb();
    rows = (db.prepare(`
      SELECT * FROM model_route_policy
      WHERE role = ? AND ${intent === null ? 'intent IS NULL' : 'intent = ?'}
      ORDER BY score DESC
    `).all(...(intent === null ? [role] : [role, intent])) as Record<string, unknown>[]).map(mapRow);
  } catch {
    rows = [];
  }
  readCache.set(key, { at: nowMs, rows });
  return rows;
}

/**
 * The bounded policy pick for resolveRoleModel. Returns null (⇒ static default)
 * unless every guard passes. `validate` is injected by the caller so this
 * module stays free of the model-wire registry (no import cycle) and the
 * guard chain is deterministically testable.
 */
export function pickRoutePolicyModel(
  role: ModelRouteRole,
  intent: string | undefined,
  defaultModelId: string,
  validate: (modelId: string) => boolean,
): RoutePolicyPick | null {
  if (!routePolicyEnabled()) return null;
  // Memory is the owner's visible choice or today's automatic route; the
  // policy never moves it (its rows are recorded for the dashboard only).
  if (role === 'memory') return null;

  // Exact-intent scope first, then the role-wide (NULL-intent) scope — mirrors
  // the binding tiers. A scope only counts if it has any usable evidence.
  const scopes: Array<string | null> = intent ? [intent, null] : [null];
  for (const scope of scopes) {
    const rows = readScopeRows(role, scope);
    if (rows.length === 0) continue;

    // Anchor: the default's OWN measured row in this scope. An unmeasured
    // default is never switched away from — it earns evidence first.
    const defaultRow = rows.find((r) => r.model === defaultModelId);
    if (!defaultRow || defaultRow.sampleCount < routePolicyMinSamples()) continue;

    // The default is measured in the most specific scope with evidence —
    // resolve here; never fall through to a broader scope past it.
    return routePolicyThompsonEnabled()
      ? pickThompson(role, scope, rows, defaultRow, defaultModelId, validate)
      : pickGreedy(rows, defaultRow, defaultModelId, validate);
  }
  return null;
}

/** The pre-Thompson pick: best scorer that beats the default by the hysteresis
 *  margin. Kept verbatim behind CLEMMY_ROUTE_POLICY_THOMPSON=off. */
function pickGreedy(
  rows: RoutePolicyRow[],
  defaultRow: RoutePolicyRow,
  defaultModelId: string,
  validate: (modelId: string) => boolean,
): RoutePolicyPick | null {
  const margin = routePolicyMargin();
  for (const candidate of rows) {
    if (candidate.model === defaultModelId) break; // rows are score-DESC: nothing beats the default
    if (candidate.disabledReason) continue;
    if (candidate.sampleCount < routePolicyMinSamples()) continue;
    if (candidate.score < routePolicyFloor()) continue;
    if (candidate.score < defaultRow.score + margin) continue;
    if (!validate(candidate.model)) continue;
    return {
      modelId: candidate.model,
      provider: candidate.provider,
      score: candidate.score,
      defaultScore: defaultRow.score,
      sampleCount: candidate.sampleCount,
      policyVersion: candidate.policyVersion,
    };
  }
  return null;
}

/** Thompson pick: highest posterior draw among the default + eligible
 *  candidates, ties to the default (⇒ null ⇒ static fall-through). */
function pickThompson(
  role: ModelRouteRole,
  scope: string | null,
  rows: RoutePolicyRow[],
  defaultRow: RoutePolicyRow,
  defaultModelId: string,
  validate: (modelId: string) => boolean,
): RoutePolicyPick | null {
  // Memoize the draw for the cache window so consecutive resolves in one
  // conversation never flip models mid-turn.
  const key = `${role}\u0000${scope ?? ''}\u0000${defaultModelId}`;
  const hit = pickCache.get(key);
  const nowMs = Date.now();
  if (hit && nowMs - hit.at < READ_CACHE_TTL_MS) {
    if (hit.pick === null || validate(hit.pick.modelId)) return hit.pick;
    pickCache.delete(key); // the memoized winner went offline — redraw
  }

  const minSamples = routePolicyMinSamples();
  const floor = routePolicyFloor();
  const denied = routePolicyDeniedModels();
  const costCeiling = defaultRow.avgCostUsd !== null ? defaultRow.avgCostUsd * routePolicyCostTolerance() : null;
  const eligible = rows.filter((r) => {
    if (r.model === defaultModelId) return false;
    // Hard fence: user-denied models never enter the draw (id or prefix match).
    const modelLc = r.model.toLowerCase();
    if (denied.some((d) => modelLc === d || modelLc.startsWith(d))) return false;
    // Cost guard: with a measured default cost, a candidate must prove it is
    // not meaningfully pricier — unmeasured cost is NOT a free pass upward.
    if (costCeiling !== null && (r.avgCostUsd === null || r.avgCostUsd > costCeiling)) return false;
    // Measured candidates: the quality floor stays a hard exclusion.
    if (r.sampleCount >= minSamples && (r.disabledReason || r.score < floor)) return false;
    // Under-sampled candidates stay in with wide posteriors — that IS the
    // exploration; their draws tighten as evidence accumulates.
    return validate(r.model);
  });

  let pick: RoutePolicyPick | null = null;
  if (eligible.length > 0) {
    let bestDraw = drawPosterior(defaultRow); // the default competes and wins ties
    let best: RoutePolicyRow | null = null;
    for (const candidate of eligible) {
      const draw = drawPosterior(candidate);
      if (draw > bestDraw) {
        best = candidate;
        bestDraw = draw;
      }
    }
    if (best) {
      pick = {
        modelId: best.model,
        provider: best.provider,
        score: best.score,
        defaultScore: defaultRow.score,
        sampleCount: best.sampleCount,
        policyVersion: best.policyVersion,
      };
    }
  }
  pickCache.set(key, { at: nowMs, pick });
  return pick;
}
