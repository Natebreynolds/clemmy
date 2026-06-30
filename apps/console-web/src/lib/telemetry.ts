/**
 * Operational telemetry client — the dashboard's real-time observability feed.
 * Reads the canonical operational_events the daemon records across every
 * subsystem (workflow / model / workspace / memory / safety / tool) via
 * GET /api/console/telemetry, and streams new ones over the SSE endpoint
 * GET /api/console/telemetry/stream (action-bus `operational.event`).
 */
import { apiGet } from './api';
import { getAuthToken } from './bootstrap';

export type OperationalSeverity = 'debug' | 'info' | 'warn' | 'error';

export interface OperationalEvent {
  eventId: string;
  ts: string;
  source: string;
  type: string;
  severity: OperationalSeverity;
  workspaceId?: string;
  workflowRunId?: string;
  workflowNodeRunId?: string;
  sessionId?: string;
  modelCallId?: string;
  toolCallId?: string;
  actor?: string;
  payload: Record<string, unknown>;
}

export const OPERATIONAL_SOURCES = ['workflow', 'model', 'workspace', 'memory', 'safety', 'tool'] as const;
export type OperationalSource = (typeof OPERATIONAL_SOURCES)[number];

export interface TelemetryQuery {
  source?: string;
  type?: string;
  workflowRunId?: string;
  sessionId?: string;
  since?: string;
  limit?: number;
}

export function getTelemetry(opts: TelemetryQuery = {}): Promise<{ events: OperationalEvent[] }> {
  const p = new URLSearchParams();
  if (opts.source) p.set('source', opts.source);
  if (opts.type) p.set('type', opts.type);
  if (opts.workflowRunId) p.set('workflowRunId', opts.workflowRunId);
  if (opts.sessionId) p.set('sessionId', opts.sessionId);
  if (opts.since) p.set('since', opts.since);
  if (opts.limit) p.set('limit', String(opts.limit));
  const qs = p.toString();
  return apiGet<{ events: OperationalEvent[] }>(`/api/console/telemetry${qs ? `?${qs}` : ''}`);
}

function withToken(path: string): string {
  const token = getAuthToken();
  if (!token) return path;
  return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

export interface TelemetryStreamHandlers {
  /** The initial buffer of recent events on connect (oldest→newest). */
  onReplay?: (events: OperationalEvent[]) => void;
  /** Each new event as it happens. */
  onEvent?: (event: OperationalEvent) => void;
  /** Connection status — 'open' on connect, 'error' on drop (EventSource auto-reconnects). */
  onStatus?: (status: 'open' | 'error') => void;
}

/** Subscribe to the live operational-event stream. Returns an unsubscribe fn. */
export function subscribeTelemetry(handlers: TelemetryStreamHandlers): () => void {
  const es = new EventSource(withToken('/api/console/telemetry/stream'));
  es.addEventListener('replay', (e) => {
    try {
      const events = JSON.parse((e as MessageEvent).data) as OperationalEvent[];
      if (Array.isArray(events)) handlers.onReplay?.(events);
    } catch { /* ignore malformed frame */ }
  });
  es.addEventListener('operational.event', (e) => {
    try {
      // The SSE forwards the action-bus envelope: { kind, event }.
      const frame = JSON.parse((e as MessageEvent).data) as { event?: OperationalEvent };
      if (frame?.event) handlers.onEvent?.(frame.event);
    } catch { /* ignore malformed frame */ }
  });
  es.onopen = () => handlers.onStatus?.('open');
  es.onerror = () => handlers.onStatus?.('error');
  return () => es.close();
}
