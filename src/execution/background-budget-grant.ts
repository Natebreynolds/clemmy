/** A task grant survives automatic retry/restart; only an owner continuation
 * grants a new window. Lifetime token counters are never reset. */
export interface BackgroundBudgetGrant {
  version: 1;
  runSessionId: string;
  grantedAtMs: number;
  wallClockDeadlineMs: number;
  runTokenBaseline: number;
  runTokenCeiling: number;
}

export function resolveBackgroundBudgetGrant(input: {
  retained: unknown;
  runSessionId: string;
  requiresRetainedGrant: boolean;
  nowMs: number;
  maxMinutes: number;
  tokensUsed: number;
  tokenCeiling: number;
}): { grant: BackgroundBudgetGrant } | { reason: string } {
  if (input.retained !== undefined) {
    const g = input.retained as Partial<BackgroundBudgetGrant> | null;
    if (!g || g.version !== 1 || g.runSessionId !== input.runSessionId
      || !Number.isFinite(g.grantedAtMs) || !Number.isFinite(g.wallClockDeadlineMs)
      || g.wallClockDeadlineMs! <= g.grantedAtMs!
      || !Number.isSafeInteger(g.runTokenBaseline) || g.runTokenBaseline! < 0
      || g.runTokenBaseline! > input.tokensUsed
      || !Number.isSafeInteger(g.runTokenCeiling) || g.runTokenCeiling! < 0) {
      return { reason: 'The retained task budget cannot be verified. Progress is saved; choose Continue to grant a new window.' };
    }
    return { grant: g as BackgroundBudgetGrant };
  }
  if (input.requiresRetainedGrant) {
    return { reason: 'This continuation has no retained task budget. Progress is saved; choose Continue to grant a new window.' };
  }
  return { grant: { version: 1, runSessionId: input.runSessionId, grantedAtMs: input.nowMs,
    wallClockDeadlineMs: input.nowMs + input.maxMinutes * 60_000,
    runTokenBaseline: input.tokensUsed, runTokenCeiling: input.tokenCeiling } };
}
