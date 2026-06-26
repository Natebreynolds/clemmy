const DEFAULT_SUPPRESSION_MS = 12 * 60 * 60 * 1000;

export type ComposioConnectionSuppressionReason = 'expired' | 'entity-mismatch';

export interface ComposioConnectionSuppression {
  reason: ComposioConnectionSuppressionReason;
  suppressUntil: string;
  lastErrorAt: string;
  failures: number;
}

export interface ComposioConnectionSuppressionState {
  suppressedConnections?: Record<string, ComposioConnectionSuppression>;
}

export function isConnectionSuppressed(
  state: ComposioConnectionSuppressionState,
  connectionId: string,
  nowMs: number,
): boolean {
  const rec = state.suppressedConnections?.[connectionId];
  if (!rec) return false;
  const until = Date.parse(rec.suppressUntil);
  return Number.isFinite(until) && until > nowMs;
}

export function clearConnectionSuppression(
  state: ComposioConnectionSuppressionState,
  connectionId: string,
): void {
  if (!state.suppressedConnections?.[connectionId]) return;
  delete state.suppressedConnections[connectionId];
  if (Object.keys(state.suppressedConnections).length === 0) delete state.suppressedConnections;
}

export function pruneConnectionSuppressions(
  state: ComposioConnectionSuppressionState,
  nowMs: number,
): Record<string, ComposioConnectionSuppression> | undefined {
  const next: Record<string, ComposioConnectionSuppression> = {};
  for (const [connectionId, rec] of Object.entries(state.suppressedConnections ?? {})) {
    const until = Date.parse(rec.suppressUntil);
    if (Number.isFinite(until) && until > nowMs) next[connectionId] = rec;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export function suppressConnectionAfterHardAuthFailure(
  state: ComposioConnectionSuppressionState,
  connectionId: string,
  err: unknown,
  nowMs: number,
  suppressionMs = DEFAULT_SUPPRESSION_MS,
): ComposioConnectionSuppression | undefined {
  const reason = classifyHardAuthFailure(err);
  if (!reason) return undefined;

  const previous = state.suppressedConnections?.[connectionId];
  const rec: ComposioConnectionSuppression = {
    reason,
    suppressUntil: new Date(nowMs + suppressionMs).toISOString(),
    lastErrorAt: new Date(nowMs).toISOString(),
    failures: (previous?.failures ?? 0) + 1,
  };
  state.suppressedConnections = { ...(state.suppressedConnections ?? {}), [connectionId]: rec };
  return rec;
}

function classifyHardAuthFailure(err: unknown): ComposioConnectionSuppressionReason | undefined {
  const text = errorText(err);
  if (!text) return undefined;
  if (/ConnectedAccountEntityIdMismatch|connected account user id does not match|user id does not match the provided user id|code['"]?\s*:?\s*1812/i.test(text)) {
    return 'entity-mismatch';
  }
  if (/ConnectedAccountExpired|connected account .* in EXPIRED state|code['"]?\s*:?\s*1820/i.test(text)) {
    return 'expired';
  }
  return undefined;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}\n${err.message}\n${err.stack ?? ''}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
