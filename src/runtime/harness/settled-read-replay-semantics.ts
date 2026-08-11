/**
 * Cross-cutting accounting semantics for a settled read replay.
 *
 * The execution guard owns creation of these rows. Consumers must require both
 * the exact runtime marker and an explicit providerDispatched:false before they
 * describe a tool return as reused. A model-authored `reused` field alone never
 * earns that meaning.
 *
 * This module deliberately has no runtime imports. eventlog imports its
 * operational mirror, so keeping these predicates dependency-free avoids a
 * mirror -> eventlog cycle.
 */
export const SETTLED_READ_REPLAY_KIND = 'same_source_settled_read_replay';
export const SETTLED_READ_REUSE_LABEL = 'Reused earlier result';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The durable guardrail-shaped row is an advisory accounting marker. */
export function isSettledReadReplayMarkerData(value: unknown): boolean {
  return record(value)?.kind === SETTLED_READ_REPLAY_KIND;
}

/** A logical tool attempt settled from prior bytes without provider I/O. */
export function isSettledReadReplayReturnData(value: unknown): boolean {
  const data = record(value);
  return data?.replayKind === SETTLED_READ_REPLAY_KIND
    && data.providerDispatched === false;
}

/** Private correlation only. Never project this identifier as public reuse data. */
export function settledReadReplayCallId(value: unknown): string | null {
  if (!isSettledReadReplayReturnData(value)) return null;
  const data = record(value)!;
  for (const candidate of [data.canonicalCallId, data.callId, data.call_id]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}
