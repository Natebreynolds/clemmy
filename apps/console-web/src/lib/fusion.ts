/**
 * Fusion (second-opinion) observability client. The server has shipped
 * /api/console/debate-traces since the fusion work landed — this is its first
 * consumer. Truthful by construction: the UI only ever describes a
 * verification that actually ran and was recorded in the durable trace.
 */
import { apiGet } from './api';

export interface FusionTrace {
  ts?: string;
  sessionId?: string;
  outcome?: string;
  judge?: string;
  durationMs?: number;
}

export const getRecentFusionTraces = (limit = 5) =>
  apiGet<{ traces: FusionTrace[] }>(`/api/console/debate-traces?limit=${limit}`).then((r) => r.traces ?? []);

/** Trace outcomes → user language. Unknown outcomes fall back to neutral
 *  wording — never a raw token, and never a claim stronger than the trace. */
export function fusionOutcomeLabel(outcome?: string): string {
  const key = (outcome ?? '').toLowerCase();
  if (key === 'checker-accepted-draft') return 'accepted the draft unchanged';
  if (key.includes('correction')) return 'returned one bounded correction';
  if (key.includes('ship-draft')) return 'kept Clementine’s draft (the checker could not complete)';
  return key ? 'recorded a verification' : 'ran';
}
