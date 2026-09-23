import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowUp, RefreshCw, Trash2 } from 'lucide-react';
import { getSpace, latestRefreshFailures, refreshSpace } from '@/lib/spaces';
import { usePoll } from '@/lib/poll';
import { useChangeHomeLayout, type HomeLayout, type HomeTile } from '@/lib/home-layout';
import type { HomeSpaceSummary } from '@/lib/home-data';
import type { HomeSpaceView } from '@/lib/home-prefs';
import { WorkspaceFrame } from '@/components/workspaces/WorkspaceFrame';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { agoLabel, clockLabel } from './home-model';

const FRAME_HEIGHT: Record<HomeTile['width'], string> = { small: 'h-[260px]', medium: 'h-[320px]', wide: 'h-[400px]' };

/**
 * One Space on Home, shown the way the owner chose for it: its summary (the
 * same projection the phone shows — the Space's own authored summary when it
 * wrote one) or its full page. Either way it says how fresh it is, and a
 * source that failed to refresh is named beside the numbers it left behind.
 */
export function SpaceTile({ tile, layout, view, summary, summaryLoading, onView, variant = 'tile' }: {
  tile: HomeTile;
  layout: HomeLayout;
  view: HomeSpaceView;
  summary?: HomeSpaceSummary;
  summaryLoading?: boolean;
  onView: (view: HomeSpaceView) => void;
  /** A grid tile, or a wide Briefing row (summary beside what it is for). */
  variant?: 'tile' | 'row';
}) {
  const full = view === 'full';
  // The full page needs the Space's own record (view and data versions); a
  // summary already carries its freshness, so it costs no poll of its own.
  const detail = usePoll(['home-space', tile.spaceId], () => getSpace(tile.spaceId), 8000, { enabled: full });
  const mutation = useChangeHomeLayout();
  const navigate = useNavigate();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const space = detail.data?.space;
  const title = summary?.title ?? space?.title ?? tile.spaceId;
  const href = `/workspaces/${encodeURIComponent(tile.spaceId)}`;

  const change = (patch: Partial<HomeTile> & { operation?: 'update' | 'remove'; position?: 'start' }) => {
    setError(null);
    mutation.mutate({ operation: patch.operation ?? 'update', space_id: tile.spaceId, expected_revision: layout.revision,
      width: patch.width, position: patch.position },
    { onError: e => setError(e.message) });
  };
  const refresh = async () => {
    setRefreshing(true); setError(null);
    try { await refreshSpace(tile.spaceId); }
    catch (e) { setError(e instanceof Error ? e.message : 'Refresh failed'); }
    finally { if (full) await detail.refetch(); setRefreshing(false); }
  };

  const failedSource = summary?.sources.find((s) => !s.ok);
  const failures = full && detail.data ? latestRefreshFailures(detail.data.audit) : [];
  const status = full
    ? (detail.isError ? 'Couldn’t check for updates'
      : failures.length ? 'Refresh failed · showing last saved data'
      : space?.status === 'paused' ? 'Paused'
      : space?.health?.freshness.state === 'stale' ? 'Saved data is stale'
      : space?.lastRefreshedAt ? `Refreshed ${agoLabel(space.lastRefreshedAt)}`
      : space?.dataSources.length ? 'Waiting for first refresh' : 'Saved snapshot')
    : (!summary ? '' : summary.freshness === 'stale' ? 'Saved data is stale'
      : latestRefresh(summary) ? `Refreshed ${agoLabel(latestRefresh(summary)!)}` : 'Not refreshed yet');
  const canRefresh = full ? Boolean(space && space.dataSources.length > 0) : Boolean(summary && summary.sources.length > 0);

  const header = (
    <div className="flex min-w-0 items-center gap-2 px-4 pt-3.5">
      <Link className="min-w-0 flex-1 truncate text-body font-semibold text-fg hover:text-primary" to={href} title={title}>{title}</Link>
      <ViewToggle view={view} title={title} onView={onView} />
      <details className="relative">
        <summary className="cursor-pointer list-none rounded-sm px-2 py-1 text-small text-muted hover:bg-hover hover:text-fg" aria-label={`Tile settings for ${title}`}>Tune</summary>
        <div className="absolute right-0 z-30 mt-1 flex w-56 flex-col gap-3 rounded-md border border-border bg-surface p-3 shadow-popover">
          <label className="text-small">Size<select aria-label="Tile size" className="mt-1 w-full rounded-sm border border-border bg-canvas p-2" value={tile.width} disabled={mutation.isPending} onChange={e => change({ width: e.target.value as HomeTile['width'] })}>
            <option value="small">Small</option><option value="medium">Medium</option><option value="wide">Large</option>
          </select></label>
          <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => change({ position: 'start' })}><ArrowUp className="h-4 w-4" aria-hidden /> Move to first</Button>
          <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => navigate(`/chat?prompt=${encodeURIComponent(`Help me refine the Space ${JSON.stringify(tile.spaceId)} shown on my Home. Read its current content and ask what I want to change.`)}`)}>Ask Clem about it</Button>
          <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => change({ operation: 'remove' })}><Trash2 className="h-4 w-4" aria-hidden /> Remove from Home</Button>
        </div>
      </details>
    </div>
  );

  const body = full ? (
    <div className="mx-4 mt-3 overflow-hidden rounded-md border border-border">
      {space ? <WorkspaceFrame key={`${tile.spaceId}:${detail.data?.viewMtimeMs}:${detail.data?.dataMtimeMs}`}
        id={tile.spaceId} title={`${space.title}`} readOnly className={cn('w-full border-0', FRAME_HEIGHT[tile.width])} />
        : detail.isLoading ? <Skeleton className={cn('w-full', FRAME_HEIGHT[tile.width])} />
        : <p role="status" className="px-4 py-8 text-small text-muted">This Space couldn’t be loaded. It stays on your Home.</p>}
    </div>
  ) : summaryLoading && !summary ? (
    <div className="flex flex-col gap-2 px-4 pt-3"><Skeleton className="h-7 w-32" /><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-2/3" /></div>
  ) : !summary ? (
    <p role="status" className="px-4 pt-3 text-small text-muted">This Space couldn’t be read. It stays on your Home.</p>
  ) : (
    <SummaryBody summary={summary} variant={variant} />
  );

  return (
    <section className="flex min-w-0 flex-col rounded-md border border-border bg-surface" aria-label={title}>
      {header}
      {body}
      {failedSource && !full && (
        <p className="mx-4 mt-3 flex items-start gap-1.5 text-small text-warning">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{sourceName(failedSource.id)} didn’t refresh{failedSource.refreshedAt ? ` · last good ${clockLabel(failedSource.refreshedAt) || agoLabel(failedSource.refreshedAt)}` : ''}</span>
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
        <span className="min-w-0 flex-1 text-caption text-muted">{status}</span>
        {canRefresh && <Button size="sm" variant="ghost" disabled={refreshing} onClick={() => { void refresh(); }}><RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} aria-hidden /> Refresh</Button>}
        <Link className="text-small font-semibold text-primary hover:underline" to={href}>Open ›</Link>
      </div>
      {error && <p role="alert" className="border-t border-border px-4 py-2 text-small text-danger">{error}</p>}
    </section>
  );
}

function ViewToggle({ view, title, onView }: { view: HomeSpaceView; title: string; onView: (view: HomeSpaceView) => void }) {
  return (
    <span role="group" aria-label={`Show ${title} as`} className="inline-flex shrink-0 overflow-hidden rounded-sm border border-border">
      {(['summary', 'full'] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          onClick={() => { if (view !== v) onView(v); }}
          className={cn('px-2 py-0.5 text-caption font-semibold transition-colors cursor-pointer', view === v ? 'bg-subtle text-fg' : 'text-faint hover:text-fg')}
        >
          {v === 'summary' ? 'Summary' : 'Full'}
        </button>
      ))}
    </span>
  );
}

function SummaryBody({ summary, variant }: { summary: HomeSpaceSummary; variant: 'tile' | 'row' }) {
  const figures = summary.headline.length > 0 ? summary.headline : [];
  const rows = summary.records;
  const bars = summary.breakdown;
  const empty = figures.length === 0 && rows.length === 0 && !bars;
  if (empty) {
    return (
      <p className="px-4 pt-3 text-small text-muted">
        Nothing to show yet{summary.objective ? ` — ${summary.objective}` : '.'}
      </p>
    );
  }
  const numbers = figures.length > 0 && (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
      {figures.map((f, i) => (
        <div key={`${f.label}-${i}`} className="flex min-w-0 flex-col">
          <span className={cn('font-bold tabular-nums text-fg', i === 0 ? 'text-h1 leading-none' : 'text-h3 leading-tight')}>{f.value}</span>
          <span className="text-caption text-muted">{f.label}</span>
        </div>
      ))}
    </div>
  );
  const detail = bars ? (
    <div className="flex flex-col gap-1.5" aria-label={bars.label}>
      <span className="text-caption font-semibold text-muted">{bars.label}</span>
      {bars.entries.map((e) => (
        <div key={e.label} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2.5 text-small">
          <span className="truncate text-fg">{e.label}</span>
          <span className="h-2 overflow-hidden rounded-full bg-subtle"><span className="block h-full rounded-full bg-primary/80" style={{ width: `${Math.round(e.ratio * 100)}%` }} /></span>
          <span className="tabular-nums text-muted">{e.value}</span>
        </div>
      ))}
    </div>
  ) : rows.length > 0 ? (
    <div className="flex flex-col">
      {rows.map((r) => (
        <div key={r.key} className="flex min-w-0 items-baseline gap-3 border-t border-border py-1.5 text-small first:border-t-0">
          <span className="min-w-0 flex-1 truncate text-fg">{r.primary}</span>
          {r.fields.map((f) => <span key={f.label} className="shrink-0 truncate text-muted" title={`${f.label}: ${f.value}`}>{f.value}</span>)}
        </div>
      ))}
      {summary.total > rows.length && (
        <span className="pt-1 text-caption text-faint">{summary.total - rows.length} more{summary.recordLabel ? ` ${summary.recordLabel.toLowerCase()}` : ''} in the Space</span>
      )}
    </div>
  ) : null;

  if (variant === 'row') {
    return (
      <div className="grid gap-x-6 gap-y-3 px-4 pt-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="flex min-w-0 flex-col gap-2">
          {numbers}
          {summary.objective && <p className="line-clamp-2 text-small text-muted">{summary.objective}</p>}
        </div>
        <div className="min-w-0">{detail}</div>
      </div>
    );
  }
  return <div className="flex flex-col gap-3 px-4 pt-3">{numbers}{detail}</div>;
}

/** The Space's own refresh time, else the newest good source read. */
function latestRefresh(summary: HomeSpaceSummary): string | null {
  if (summary.lastRefreshedAt) return summary.lastRefreshedAt;
  const reads = summary.sources.filter((s) => s.ok && s.refreshedAt).map((s) => s.refreshedAt!).sort();
  return reads.length > 0 ? reads[reads.length - 1]! : null;
}

/** "slack_dms" → "Slack dms": a source's own id, readable. */
function sourceName(id: string): string {
  const words = id.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'A source';
}
