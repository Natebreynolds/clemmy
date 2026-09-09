/**
 * The durable per-run log (`/runs/:runId/events`) as a growing array — the
 * structured step timeline (step_started/completed/blocked, verdicts, reshapes)
 * that `buildWorkflowRunDetail` projects. Polled every 2s while the run is
 * live (the log is a file; there is no push for it), once when it is not.
 * The live tool-by-tool feed comes from the run's activity stream instead.
 */
import { useEffect, useState } from 'react';
import { apiGet } from './api';

export type RunEvent = Record<string, unknown> & { t?: string; kind?: string };

const CAP = 600;

/** Append fresh rows, keep the newest CAP, and hand back the cursor. */
export function mergeRunEvents(prev: RunEvent[], fresh: RunEvent[]): { events: RunEvent[]; since: string } {
  if (fresh.length === 0) return { events: prev, since: String(prev[prev.length - 1]?.t ?? '') };
  const events = [...prev, ...fresh];
  const trimmed = events.length > CAP ? events.slice(events.length - CAP) : events;
  return { events: trimmed, since: String(fresh[fresh.length - 1].t ?? '') };
}

export function useWorkflowRunEvents(workflow: string | null, runId: string | null, live: boolean): RunEvent[] {
  const [events, setEvents] = useState<RunEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    if (!workflow || !runId) return;
    let alive = true;
    let since = '';
    const tick = async () => {
      try {
        const url = `/api/console/workflows/${encodeURIComponent(workflow)}/runs/${encodeURIComponent(runId)}/events${since ? `?since=${encodeURIComponent(since)}` : ''}`;
        const data = await apiGet<{ events?: RunEvent[] }>(url);
        if (!alive) return;
        setEvents((prev) => {
          const merged = mergeRunEvents(prev, data.events ?? []);
          if (merged.since) since = merged.since;
          return merged.events;
        });
      } catch { /* best effort — the next tick retries */ }
    };
    void tick();
    if (!live) return () => { alive = false; };
    const timer = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [workflow, runId, live]);
  return events;
}
