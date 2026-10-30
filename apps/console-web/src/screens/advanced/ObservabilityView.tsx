import { useEffect, useMemo, useState } from 'react';
import { Activity, Pause, Play } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { StatusPill } from '@/components/ui/StatusPill';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { sentence } from '@/lib/sentence-case';
import {
  subscribeTelemetry,
  OPERATIONAL_SOURCES,
  type OperationalEvent,
  type OperationalSeverity,
  type OperationalSource,
} from '@/lib/telemetry';

const BUFFER_MAX = 400;

const SEVERITY_DOT: Record<OperationalSeverity, string> = {
  debug: 'bg-faint',
  info: 'bg-accent',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
};

// Exhaustive by type: adding a source to OPERATIONAL_SOURCES without a label
// here is now a compile error, not two chips silently rendering as raw
// lowercase (which is exactly how 'harness' and 'scheduler' drifted).
const SOURCE_LABEL: Record<OperationalSource, string> = {
  workflow: 'Workflow',
  model: 'Model',
  workspace: 'Workspace',
  memory: 'Memory',
  safety: 'Safety',
  tool: 'Tool',
  harness: 'Harness',
  scheduler: 'Scheduler',
};

/** Label for a source. The map above is exhaustive over the known sources; this
 *  still falls back for a source a newer daemon emits that this build predates. */
function sourceLabel(source: string): string {
  // The fallback used to lean on `uppercase` to look intentional; with the
  // utility gone it must actually be a label.
  return (SOURCE_LABEL as Record<string, string>)[source] ?? sentence(source);
}

function relTime(ts: string): string {
  const then = new Date(ts).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 1) return 'now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** The salient one-liner per event — the bit an operator actually wants to see. */
function eventDetail(ev: OperationalEvent): string {
  const p = ev.payload ?? {};
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = p[k];
      if (typeof v === 'string' && v) return v;
      if (typeof v === 'number') return String(v);
    }
    return undefined;
  };
  const bits: string[] = [];
  const id = pick('stepId', 'resolvedModel', 'model', 'title', 'kind', 'sourceId');
  if (id) bits.push(id);
  if (ev.workspaceId) bits.push(`ws:${ev.workspaceId}`);
  const extra = pick('mutation', 'provider', 'failedCount', 'patternsWritten', 'error');
  if (extra) bits.push(extra);
  return bits.join(' · ');
}

export function ObservabilityView() {
  const [events, setEvents] = useState<OperationalEvent[]>([]);
  const [status, setStatus] = useState<'connecting' | 'open' | 'error'>('connecting');
  const [source, setSource] = useState<string | 'all'>('all');
  const [paused, setPaused] = useState(false);
  const [pausedEvents, setPausedEvents] = useState<OperationalEvent[]>([]);
  const [connectionAttempt, setConnectionAttempt] = useState(0);

  useEffect(() => {
    setStatus('connecting');
    const push = (incoming: OperationalEvent[]): void => {
      setEvents((prev) => {
        // newest-first, deduped by eventId, capped.
        const seen = new Set(incoming.map((e) => e.eventId));
        const merged = [...incoming, ...prev.filter((e) => !seen.has(e.eventId))];
        return merged.slice(0, BUFFER_MAX);
      });
    };
    const unsub = subscribeTelemetry({
      onReplay: (evs) => push([...evs].reverse()), // replay is oldest→newest; show newest first
      onEvent: (ev) => push([ev]),
      onStatus: (s) => setStatus(s === 'open' ? 'open' : 'error'),
    });
    return unsub;
  }, [connectionAttempt]);

  const visibleEvents = paused ? pausedEvents : events;

  const filtered = useMemo(
    () => (source === 'all' ? visibleEvents : visibleEvents.filter((e) => e.source === source)),
    [visibleEvents, source],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of visibleEvents) c[e.source] = (c[e.source] ?? 0) + 1;
    return c;
  }, [visibleEvents]);

  const statusPill = paused ? <StatusPill tone="neutral">View paused</StatusPill> : status === 'open'
    ? <StatusPill tone="live">Live</StatusPill>
    : status === 'connecting'
      ? <StatusPill tone="neutral">Connecting…</StatusPill>
      : <StatusPill tone="warning">Reconnecting…</StatusPill>;

  return (
    <Page
      title="Observability"
      subtitle="Live operational telemetry — every workflow node, tool call, model route, memory write & safety guard"
      actions={
        <div className="flex items-center gap-2">
          {statusPill}
          <button
            type="button"
            aria-pressed={paused}
            onClick={() => { if (!paused) setPausedEvents(events); setPaused(value => !value); }}
            className="flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-small text-fg hover:bg-surface-2"
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? 'Resume view' : 'Pause view'}
          </button>
        </div>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterChip label="All" active={source === 'all'} count={visibleEvents.length} onClick={() => setSource('all')} />
        {OPERATIONAL_SOURCES.map((s) => (
          <FilterChip key={s} label={sourceLabel(s)} active={source === s} count={counts[s] ?? 0} onClick={() => setSource(s)} />
        ))}
      </div>
      {paused && <p role="status" className="mb-3 text-small text-muted">The view is paused. Incoming events continue in a buffer of up to {BUFFER_MAX}; Resume view shows the latest events.</p>}
      {status === 'error' && <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-small text-muted"><span>Telemetry is reconnecting. {events.length ? 'Last received events remain visible.' : 'An empty feed cannot be confirmed yet.'}</span><Button variant="secondary" size="sm" onClick={() => setConnectionAttempt(value => value + 1)}>Retry connection</Button></div>}

      {filtered.length === 0 ? (
        <EmptyState
          title={status !== 'open' && !visibleEvents.length ? status === 'connecting' ? 'Connecting to telemetry' : 'Telemetry unavailable' : source === 'all' ? 'No telemetry yet' : 'No events for this source'}
          description={status !== 'open' && !visibleEvents.length ? 'Events will appear once this connection is available.' : 'Operational events appear here as Clementine works. Choose All to see every source.'}
        />
      ) : (
        <Card className="divide-y divide-border p-0">
          {filtered.map((ev) => (
            <div key={ev.eventId} className="flex items-center gap-3 px-4 py-2.5">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', SEVERITY_DOT[ev.severity] ?? 'bg-faint')} aria-hidden />
              <span className="w-20 shrink-0 text-caption text-faint">{sourceLabel(ev.source)}</span>
              <span className="shrink-0 font-mono text-small font-medium text-fg">{ev.type}</span>
              <span className="min-w-0 flex-1 truncate text-small text-muted">{eventDetail(ev)}</span>
              <span className="shrink-0 text-caption tabular-nums text-faint">{relTime(ev.ts)}</span>
            </div>
          ))}
        </Card>
      )}
    </Page>
  );
}

function FilterChip({ label, active, count, onClick }: { label: string; active: boolean; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-3 py-1 text-small transition-colors',
        active ? 'border-accent bg-accent/10 text-fg' : 'border-border bg-surface text-muted hover:text-fg',
      )}
    >
      {label === 'All' && <Activity className="h-3.5 w-3.5" aria-hidden />}
      {label}
      <span className={cn('rounded-full px-1.5 text-caption tabular-nums', active ? 'bg-accent/20 text-fg' : 'text-faint')}>{count}</span>
    </button>
  );
}
