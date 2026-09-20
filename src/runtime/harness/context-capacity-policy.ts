import type { InFlightCompactionThresholds } from './compaction.js';

/** Capacity is the complete outgoing request, not just completed tool results.
 * Keep normal cache-aware policy until the request consumes its output headroom.
 * This can only retire older recallable pairs; it is not a lossy task handoff. */
export function capacityAwareCompactionThresholds(
  normal: InFlightCompactionThresholds,
  contextWindowTokens: number,
  outgoingInputTokens: number,
): { thresholds: InFlightCompactionThresholds; capacityPressure: boolean } {
  const capacityPressure = Number.isFinite(contextWindowTokens) && contextWindowTokens > 0
    && Number.isFinite(outgoingInputTokens)
    && outgoingInputTokens > Math.floor(contextWindowTokens * 0.9);
  return {
    capacityPressure,
    thresholds: capacityPressure ? {
      ...normal,
      resultTriggerTokens: 1,
      retainedResultBudgetTokens: Math.max(1, Math.floor(contextWindowTokens * 0.05)),
      minRetainPairs: 1,
      maxRetainPairs: 1,
    } : normal,
  };
}
