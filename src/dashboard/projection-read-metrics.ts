import { performance } from 'node:perf_hooks';

/** Presentation diagnostics only. Names are fixed; no query, row, account or
 * result data crosses this boundary. Durations are inclusive and may overlap. */
export const PROJECTION_READ_PHASES = [
  'catalog_callback', 'catalog_build', 'catalog_serialize', 'catalog_collect',
  'catalog_pages', 'catalog_lineage', 'catalog_lineage_rows', 'catalog_lineage_proofs',
  'catalog_desktop', 'catalog_search', 'catalog_status', 'catalog_status_records',
  'catalog_preview', 'catalog_sort',
] as const;
export type ProjectionReadPhase = typeof PROJECTION_READ_PHASES[number];

export interface ProjectionReadObservation {
  durationMs: number;
  failed: boolean;
  items?: number;
}
export type ProjectionReadObserver = (phase: ProjectionReadPhase, observation: ProjectionReadObservation) => void;

/** An observer must never change a returned value or replace an operation's
 * exception. No observer means the original operation executes directly. */
export function measureProjectionRead<T>(
  observer: ProjectionReadObserver | undefined,
  phase: ProjectionReadPhase,
  operation: () => T,
  items?: (result: T) => number,
): T {
  if (!observer) return operation();
  const started = performance.now();
  let failed = true;
  let count: number | undefined;
  try {
    const result = operation();
    failed = false;
    try { count = items?.(result); } catch { /* diagnostics cannot change the result */ }
    return result;
  } finally {
    try { observer(phase, { durationMs: performance.now() - started, failed, items: count }); }
    catch { /* diagnostics cannot replace the operation's error */ }
  }
}

interface PhaseTotal { durationMs: number; calls: number; failures: number; items?: number }

/** One recorder per opted-in request; no persisted/global measurements. */
export class ProjectionReadMetrics {
  private readonly phases = new Map<ProjectionReadPhase, PhaseTotal>();
  readonly observe: ProjectionReadObserver = (phase, observation) => {
    if (!PROJECTION_READ_PHASES.includes(phase)
      || !Number.isFinite(observation.durationMs) || observation.durationMs < 0) return;
    const total = this.phases.get(phase) ?? { durationMs: 0, calls: 0, failures: 0 };
    total.durationMs += observation.durationMs;
    total.calls++;
    if (observation.failed) total.failures++;
    if (Number.isSafeInteger(observation.items) && observation.items! >= 0) {
      total.items = (total.items ?? 0) + observation.items!;
    }
    this.phases.set(phase, total);
  };

  /** Inclusive phases are deliberately not summed into a latency claim.
   * Unobserved phases and attribution we cannot establish have no fake zero. */
  headers(): Record<string, string> {
    const timings = PROJECTION_READ_PHASES.map((phase) => {
      const total = this.phases.get(phase);
      return total ? `${phase};dur=${total.durationMs.toFixed(3)};desc="inclusive"`
        : `${phase};desc="unobserved"`;
    });
    timings.push('catalog_queue;desc="unknown"', 'catalog_sql;desc="unknown"', 'catalog_store_parse;desc="unknown"');
    const counts = [...this.phases].flatMap(([phase, total]) => [
      `${phase}_calls=${total.calls}`, `${phase}_failures=${total.failures}`,
      ...(total.items === undefined ? [] : [`${phase}_items=${total.items}`]),
    ]);
    return { 'Server-Timing': timings.join(', '), 'X-Clementine-Projection-Counts': counts.join(', ') };
  }
}

/** Authenticate first and trust the actual peer, never forwarded headers. */
export function catalogProjectionMetricsForRequest(input: {
  authorized: boolean; peerAddress: string | undefined; optIn: unknown;
}): ProjectionReadMetrics | undefined {
  if (!input.authorized || input.optIn !== '1'
    || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(input.peerAddress ?? '')) return undefined;
  return new ProjectionReadMetrics();
}

/** res.json still owns Express's exact replacer/spacing/escaping and response
 * behavior. Its send boundary lets us measure serialization before headers
 * leave, without serializing twice or substituting a second JSON encoder.
 * callback measures the post-authentication handler portion through
 * serialization to this send boundary;
 * it does not assert socket/queue latency or include response transmission. */
export function sendCatalogProjectionJson<T extends {
  send: (body?: unknown) => unknown; json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => unknown;
}>(response: T, body: unknown, metrics: ProjectionReadMetrics | undefined, callbackStarted: number, callbackFailed = false): void {
  if (!metrics) { response.json(body); return; }
  const originalSend = response.send;
  const serializationStarted = performance.now();
  let sent = false;
  response.send = function (this: T, payload?: unknown): unknown {
    if (!sent) {
      sent = true;
      const boundary = performance.now();
      metrics.observe('catalog_serialize', { durationMs: boundary - serializationStarted, failed: false });
      metrics.observe('catalog_callback', { durationMs: boundary - callbackStarted, failed: callbackFailed });
      try {
        for (const [name, value] of Object.entries(metrics.headers())) response.setHeader(name, value);
      } catch { /* metrics must not prevent the original response */ }
    }
    return originalSend.call(this, payload);
  };
  try { response.json(body); }
  catch (error) {
    if (!sent) metrics.observe('catalog_serialize', { durationMs: performance.now() - serializationStarted, failed: true });
    throw error;
  } finally { response.send = originalSend; }
}
