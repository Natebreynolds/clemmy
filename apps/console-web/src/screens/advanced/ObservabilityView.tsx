import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Pause, Play } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { StatusPill } from '@/components/ui/StatusPill';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/cn';
import {
  subscribeTelemetry,
  OPERATIONAL_SOURCES,
  type OperationalEvent,
  type OperationalSeverity,
} from '@/lib/telemetry';

const BUFFER_MAX = 400;

const SEVERITY_DOT: Record<OperationalSeverity, string> = {
  debug: 'bg-faint',
  info: 'bg-accent',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
};

const SOURCE_LABEL: Record<string, string> = {
  workflow: 'Workflow',
  model: 'Model',
  workspace: 'Workspace',
  memory: 'Memory',
  safety: 'Safety',
  tool: 'Tool',
};

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
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const push = (incoming: OperationalEvent[]): void => {
      if (pausedRef.current) return;
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
  }, []);

  const filtered = useMemo(
    () => (source === 'all' ? events : events.filter((e) => e.source === source)),
    [events, source],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of events) c[e.source] = (c[e.source] ?? 0) + 1;
    return c;
  }, [events]);

  const statusPill = status === 'open'
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
            onClick={() => setPaused((v) => !v)}
            className="flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-small text-fg hover:bg-surface-2"
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterChip label="All" active={source === 'all'} count={events.length} onClick={() => setSource('all')} />
        {OPERATIONAL_SOURCES.map((s) => (
          <FilterChip key={s} label={SOURCE_LABEL[s] ?? s} active={source === s} count={counts[s] ?? 0} onClick={() => setSource(s)} />
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No telemetry yet"
          description="Operational events appear here the moment Clementine runs a workflow node, calls a tool, routes a model, or writes to memory."
        />
      ) : (
        <Card className="divide-y divide-border p-0">
          {filtered.map((ev) => (
            <div key={ev.eventId} className="flex items-center gap-3 px-4 py-2.5">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', SEVERITY_DOT[ev.severity] ?? 'bg-faint')} aria-hidden />
              <span className="w-20 shrink-0 text-caption uppercase tracking-wide text-faint">{SOURCE_LABEL[ev.source] ?? ev.source}</span>
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
