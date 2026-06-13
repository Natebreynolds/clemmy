/**
 * Dynamic reasoning effort (per-turn). gpt-5.x reasoning models "think" before
 * emitting any token, and reasoning depth is the dominant per-turn latency knob.
 *
 * GROUND TRUTH (verified against @openai/agents-core + the user's gpt-5.5 setup):
 * the orchestrator carries NO explicit modelSettings, so the SDK injects its
 * per-model default — for gpt-5.5 that is `reasoning.effort: 'none'`. So simple
 * turns are ALREADY at minimum effort; there is no over-reasoning to cut on a
 * calendar lookup. The real lever is the other direction: let genuinely complex,
 * multi-step agentic turns think HARDER (where depth changes whether a hard task
 * completes) while leaving simple turns exactly as fast as today.
 *
 * Mapping (monotonic ladder; only RAISES effort above the 'none' baseline, and
 * only for non-simple work — so the common fast path is byte-identical to today):
 *   simple   → 'none'    (= today's gpt-5.5 default; fastest; zero regression)
 *   moderate → 'medium'  (real routing/decision depth)
 *   complex  → 'high'    (full depth for multi-domain / read+write / batched work)
 *   active goal (any complexity) → 'high'  (autonomous work, latency tolerable)
 *
 * Complexity is NOT re-derived here — we reuse the harness's existing
 * `classifyComplexity` (context-packet.ts), already computed every turn, so this
 * is one source of truth, not a duplicate classifier.
 *
 * Kill-switch: CLEMMY_DYNAMIC_REASONING=off → caller skips injection entirely
 * (SDK per-model default rides; byte-identical to before this feature).
 */
import { getRuntimeEnv } from '../../config.js';
import type { AgentContextPacket } from './context-packet.js';

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

export function dynamicReasoningEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_DYNAMIC_REASONING', 'on') ?? 'on').toLowerCase() !== 'off';
}

export interface EffortSignals {
  /** True when the session has an active goal/plan — bias toward depth. */
  hasActiveGoal?: boolean;
}

/**
 * Map the turn's complexity (+ signals) to a reasoning effort. Pure + cheap.
 * `complexity` comes from the harness context packet (`classifyComplexity`).
 */
export function selectReasoningEffort(
  complexity: AgentContextPacket['complexity'],
  signals: EffortSignals = {},
): { effort: ReasoningEffort; reason: string } {
  if (signals.hasActiveGoal) return { effort: 'high', reason: 'active-goal' };
  switch (complexity) {
    case 'complex':
      return { effort: 'high', reason: 'complexity:complex' };
    case 'moderate':
      return { effort: 'medium', reason: 'complexity:moderate' };
    case 'simple':
    default:
      return { effort: 'none', reason: 'complexity:simple' };
  }
}
