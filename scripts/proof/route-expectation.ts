import type { ScenarioDef, ScenarioOutcome, ScenarioRouteSession } from './types.js';

/** Resolve how many model-route markers exact-brain scoring should require.
 * Most scenarios make one model call per timed turn; scenarios containing
 * deterministic fast paths can declare the smaller model-routed subset. */
export function expectedModelTurnsForRouteCheck(
  scenario: Pick<ScenarioDef, 'expectedModelTurns'>,
  latencySampleCount: number,
): number {
  const configuredCount = scenario.expectedModelTurns;
  if (configuredCount === undefined) return latencySampleCount;
  if (!Number.isSafeInteger(configuredCount) || configuredCount < 0) {
    throw new Error('Scenario expectedModelTurns must be a non-negative safe integer');
  }
  return configuredCount;
}

export function routeSessionsForRouteCheck(
  scenario: Pick<ScenarioDef, 'expectedModelTurns'>,
  result: {
    sessionId?: string;
    routeSessions?: ScenarioRouteSession[];
    latencySampleCount: number;
  },
): ScenarioRouteSession[] {
  if (result.routeSessions !== undefined) {
    if (result.routeSessions.length === 0) {
      throw new Error('Scenario routeSessions cannot be empty when provided');
    }
    const seen = new Set<string>();
    let total = 0;
    const routes = result.routeSessions.map((entry) => {
      const sessionId = entry.sessionId.trim();
      if (!sessionId) throw new Error('Scenario routeSessions requires non-empty session ids');
      if (seen.has(sessionId)) throw new Error(`Scenario routeSessions repeats session ${sessionId}`);
      if (!Number.isSafeInteger(entry.expectedModelTurns) || entry.expectedModelTurns < 0) {
        throw new Error('Scenario routeSessions model turns must be non-negative safe integers');
      }
      seen.add(sessionId);
      total += entry.expectedModelTurns;
      return { sessionId, expectedModelTurns: entry.expectedModelTurns };
    });
    const declaredTotal = expectedModelTurnsForRouteCheck(scenario, result.latencySampleCount);
    if (total !== declaredTotal) {
      throw new Error(`Scenario routeSessions total ${total} does not match expectedModelTurns ${declaredTotal}`);
    }
    return routes;
  }
  const sessionId = result.sessionId?.trim();
  if (!sessionId) return [];
  return [{
    sessionId,
    expectedModelTurns: expectedModelTurnsForRouteCheck(scenario, result.latencySampleCount),
  }];
}

/** Collect every durable scenario session that can carry completed brain usage.
 * A multi-session outcome keeps its display/summary session in `sessionId` and
 * declares the other model-routed legs in `routeSessions`; served-model proof
 * must include both surfaces instead of silently dropping the cold leg. */
export function servedModelSessionIdsForOutcomes(
  outcomes: Iterable<Pick<ScenarioOutcome, 'sessionId' | 'routeSessions'>>,
): string[] {
  const sessionIds = new Set<string>();
  for (const outcome of outcomes) {
    for (const rawSessionId of [
      outcome.sessionId,
      ...(outcome.routeSessions ?? []).map((route) => route.sessionId),
    ]) {
      const sessionId = rawSessionId?.trim();
      if (sessionId) sessionIds.add(sessionId);
    }
  }
  return [...sessionIds];
}
