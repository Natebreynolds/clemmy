const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const EXPIRED_BACKOFF_MS = [DAY_MS, 3 * DAY_MS, 7 * DAY_MS, 30 * DAY_MS] as const;
const ENTITY_MISMATCH_BACKOFF_MS = [7 * DAY_MS, 14 * DAY_MS, 30 * DAY_MS] as const;

export type ComposioConnectionSuppressionReason = 'expired' | 'entity-mismatch';

export interface ComposioConnectionSuppression {
  reason?: string;
  suppressUntil: string;
  lastErrorAt?: string;
  failures?: number;
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
  suppressionMs?: number,
): ComposioConnectionSuppression | undefined {
  const reason = classifyHardAuthFailure(err);
  if (!reason) return undefined;

  const previous = state.suppressedConnections?.[connectionId];
  const failures = (previous?.failures ?? 0) + 1;
  const durationMs = suppressionMs ?? hardAuthSuppressionDurationMs(reason, failures);
  const rec: ComposioConnectionSuppression = {
    reason,
    suppressUntil: new Date(nowMs + durationMs).toISOString(),
    lastErrorAt: new Date(nowMs).toISOString(),
    failures,
  };
  state.suppressedConnections = { ...(state.suppressedConnections ?? {}), [connectionId]: rec };
  return rec;
}

export function hardAuthSuppressionDurationMs(
  reason: ComposioConnectionSuppressionReason,
  failures: number,
): number {
  const schedule = reason === 'entity-mismatch' ? ENTITY_MISMATCH_BACKOFF_MS : EXPIRED_BACKOFF_MS;
  const index = Math.max(0, Math.min(schedule.length - 1, Math.floor(failures) - 1));
  return schedule[index];
}

export function mergeConnectionSuppressions(
  target: ComposioConnectionSuppressionState,
  source: ComposioConnectionSuppressionState,
  nowMs: number,
): void {
  for (const [connectionId, rec] of Object.entries(source.suppressedConnections ?? {})) {
    const until = Date.parse(rec.suppressUntil);
    if (!Number.isFinite(until) || until <= nowMs) continue;
    const existing = target.suppressedConnections?.[connectionId];
    const existingUntil = existing ? Date.parse(existing.suppressUntil) : NaN;
    if (!existing || !Number.isFinite(existingUntil) || until > existingUntil) {
      target.suppressedConnections = { ...(target.suppressedConnections ?? {}), [connectionId]: rec };
    }
  }
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
  const parts: string[] = [];
  const seen = new WeakSet<object>();

  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) parts.push(value);
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(String(value));
  };

  const visit = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > 4) return;
    if (typeof value !== 'object') {
      push(value);
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);

    const record = value as Record<string, unknown>;
    push(record.name);
    push(record.message);
    push(record.stack);
    push(record.code);
    push(record.statusCode);
    push(record.status);
    push(record.errorId);

    for (const key of ['cause', 'error', 'data', 'response', 'body', 'details', 'possibleFixes']) {
      visit(record[key], depth + 1);
    }

    try {
      push(JSON.stringify(value));
    } catch {
      // Ignore circular/non-serializable SDK objects; direct field reads above
      // are the durable path.
    }
  };

  visit(err, 0);
  return parts.join('\n');
}
