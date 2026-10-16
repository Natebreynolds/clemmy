import type { HarnessEvent } from './types.js';

/** Presentation scope supplied by the server for an exact synthetic outcome.
 * It never grants execution, approval, Stop, or human-request ownership. */
export interface BackgroundOutcomeReport {
  version: 1;
  sourceUserSeq: number;
  sourceLabel: string;
  sourceId: string;
  phase: 'passive' | 'report';
}

const MARKER_KEYS = ['phase', 'sourceId', 'sourceLabel', 'sourceUserSeq', 'version'];
const TERMINAL_STATUSES = new Set(['done', 'needs_input', 'blocked', 'failed', 'cancelled', 'transferred', 'uncertain']);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function identifier(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

/** A malformed/copied marker keeps the event on its ordinary ownership path.
 * The server alone proves the source was an outcome; this reader additionally
 * checks its closed public shape and its own exact event/terminal binding. */
export function readBackgroundOutcomeReport(
  event: HarnessEvent,
  sessionId?: string | null,
): BackgroundOutcomeReport | null {
  if (event.type !== 'user_input_received' && event.type !== 'conversation_completed') return null;
  if (!Number.isSafeInteger(event.seq) || event.seq <= 0
    || (sessionId && event.sessionId && sessionId !== event.sessionId)) return null;
  const data = event.data ?? {};
  const marker = record(data.backgroundOutcomeReport);
  if (!marker || Object.keys(marker).sort().join(',') !== MARKER_KEYS.join(',')
    || marker.version !== 1 || !Number.isSafeInteger(marker.sourceUserSeq)
    || Number(marker.sourceUserSeq) <= 0
    || !identifier(marker.sourceLabel, 256) || !identifier(marker.sourceId, 4096)
    || (marker.phase !== 'passive' && marker.phase !== 'report')) return null;
  if (event.type === 'user_input_received') {
    if ((event.role !== undefined && event.role !== 'user') || data.synthetic !== true
      || data.source !== 'outcome' || data.deliveryPhase !== marker.phase
      || marker.sourceUserSeq !== event.seq) return null;
  } else {
    const presentation = record(data.presentation);
    const identity = record(presentation?.identity);
    const outcome = record(data.turnOutcome);
    if (marker.phase !== 'report' || Number(marker.sourceUserSeq) >= event.seq
      || data.sourceUserSeq !== marker.sourceUserSeq
      || presentation?.version !== 1 || presentation.audience !== 'user' || presentation.phase !== 'final'
      || !identity || !identifier(identity.sessionId, 4096)
      || identity.sourceUserSeq !== marker.sourceUserSeq
      || (sessionId && identity.sessionId !== sessionId)
      || (event.sessionId && identity.sessionId !== event.sessionId)
      || !TERMINAL_STATUSES.has(String(presentation.status))
      || (outcome && outcome.status !== presentation.status)) return null;
  }
  return marker as unknown as BackgroundOutcomeReport;
}
