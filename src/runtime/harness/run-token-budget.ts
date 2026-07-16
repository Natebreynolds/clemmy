/**
 * DREAM Stage 4 — the aggregate RUN TOKEN BUDGET (Gap D).
 *
 * Bounds existed for steps/turns/wall-clock/concurrency only, and
 * autoContinueOnLimit lifts the step cap to 1,000,000 — so nothing bounded
 * cumulative SPEND. This module is the soft ceiling: a durable per-session
 * token accumulator (sessions.tokens_used, filled by recordModelUsage via
 * accrueSessionTokens) checked at turn/step boundaries, parking honestly
 * through the existing limit templates — never a hard kill mid-write.
 *
 * Semantics that keep it honest (the Stage-4 design spike's safety lens):
 * - The unit is UNCACHED tokens (totalTokens − cachedInputTokens): cache
 *   reads must not eat a run's ceiling.
 * - The counter is LIFETIME-MONOTONIC; every check is windowed against a
 *   BASELINE captured at the semantic run start (a background drain
 *   iteration, a foreground loop entry). A user continue opens a fresh
 *   window structurally — no re-park loop, no counter resets, and a
 *   week-long chat session can never park on its own history.
 * - Metering is ALWAYS on (pure telemetry). Enforcement is kill-switched:
 *   CLEMMY_RUN_TOKEN_BUDGET=off disables checks, parks, and every
 *   budget-related prompt/heartbeat line (surfaces must describe
 *   kill-switchable behavior conditionally — the Stage-3 lesson).
 */
import { getRuntimeEnv } from '../../config.js';
import { getSessionTokensUsed } from './eventlog.js';
import type { HarnessBudgetRuntime } from './budget-settings.js';

export function runTokenBudgetEnforcementEnabled(): boolean {
  const v = (getRuntimeEnv('CLEMMY_RUN_TOKEN_BUDGET', 'on') ?? 'on').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

/** Ceiling precedence: explicit per-run override → env/preset (via the
 *  already-resolved budget runtime). 0 = no ceiling. The sessions.token_budget
 *  column is informational display only — never authoritative (it can go
 *  stale; options + settings cannot). */
export function resolveRunTokenCeiling(input: {
  override?: number;
  budget: Pick<HarnessBudgetRuntime, 'maxRunTokens'>;
}): number {
  if (typeof input.override === 'number' && Number.isFinite(input.override) && input.override >= 0) {
    return Math.trunc(input.override);
  }
  return input.budget.maxRunTokens > 0 ? input.budget.maxRunTokens : 0;
}

export interface RunTokenWindow {
  sessionId: string;
  /** Lifetime counter value at the semantic run start. */
  baseline: number;
  /** 0 = unlimited (no checks, no threshold events, no budget lines). */
  ceiling: number;
  /** Single-shot 0.5 / 0.8 warn thresholds for this window. */
  warned: Set<number>;
}

export function openRunTokenWindow(input: {
  sessionId: string;
  ceiling: number;
  /** Durable baseline handed across process boundaries (the background drain
   *  passes its own); absent ⇒ self-baseline at the current counter. */
  baseline?: number;
}): RunTokenWindow {
  const baseline = typeof input.baseline === 'number' && Number.isFinite(input.baseline) && input.baseline >= 0
    ? input.baseline
    : getSessionTokensUsed(input.sessionId);
  return { sessionId: input.sessionId, baseline, ceiling: Math.max(0, input.ceiling), warned: new Set() };
}

export interface RunTokenStatus {
  usedWindow: number;
  usedLifetime: number;
  ceiling: number;
  fraction: number;
  exceeded: boolean;
  /** Newly-crossed warn threshold (0.5 | 0.8), at most once each per window. */
  crossedThreshold?: number;
}

const WARN_THRESHOLDS = [0.5, 0.8] as const;

/** One boundary check: cheap point SELECT + window math. Never throws. */
export function checkRunTokenWindow(window: RunTokenWindow): RunTokenStatus {
  const usedLifetime = getSessionTokensUsed(window.sessionId);
  const usedWindow = Math.max(0, usedLifetime - window.baseline);
  if (window.ceiling <= 0) {
    return { usedWindow, usedLifetime, ceiling: 0, fraction: 0, exceeded: false };
  }
  const fraction = usedWindow / window.ceiling;
  let crossedThreshold: number | undefined;
  for (const t of WARN_THRESHOLDS) {
    if (fraction >= t && !window.warned.has(t)) {
      window.warned.add(t);
      crossedThreshold = t; // report the highest newly-crossed below
    }
  }
  return { usedWindow, usedLifetime, ceiling: window.ceiling, fraction, exceeded: usedWindow >= window.ceiling, crossedThreshold };
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** The honest budget line for heartbeats/check-ins — rendered ONLY when
 *  enforcement is on and a ceiling exists (conditional-surface rule). */
export function budgetLine(status: RunTokenStatus): string | null {
  if (!runTokenBudgetEnforcementEnabled() || status.ceiling <= 0) return null;
  return `token budget ${Math.min(999, Math.round(status.fraction * 100))}% used (${formatTokens(status.usedWindow)}/${formatTokens(status.ceiling)})`;
}

/** One-shot budget line from raw (sessionId, baseline, ceiling) — the SINGLE
 *  renderer for callers that hold a window's parts rather than a RunTokenWindow
 *  (the background drain's check-ins). Same gating as budgetLine. */
export function budgetLineFor(sessionId: string, baseline: number, ceiling: number): string | null {
  if (!runTokenBudgetEnforcementEnabled() || ceiling <= 0) return null;
  const usedWindow = Math.max(0, getSessionTokensUsed(sessionId) - baseline);
  return `token budget ${Math.min(999, Math.round((usedWindow / ceiling) * 100))}% used (${formatTokens(usedWindow)}/${formatTokens(ceiling)})`;
}
