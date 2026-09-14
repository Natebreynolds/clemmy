import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUp, ExternalLink, RefreshCw, Trash2 } from 'lucide-react';
import { getSpace, latestRefreshFailures, refreshSpace } from '@/lib/spaces';
import { usePoll } from '@/lib/poll';
import { useChangeHomeLayout, type HomeLayout, type HomeTile } from '@/lib/home-layout';
import { WorkspaceFrame } from '@/components/workspaces/WorkspaceFrame';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { agoLabel } from './home-model';

export function SpaceTile({ tile, layout }: { tile: HomeTile; layout: HomeLayout }) {
  const detail = usePoll(['home-space', tile.spaceId], () => getSpace(tile.spaceId), 8000);
  const mutation = useChangeHomeLayout();
  const navigate = useNavigate();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const space = detail.data?.space;
  const failures = detail.data ? latestRefreshFailures(detail.data.audit) : [];
  const change = (patch: Partial<HomeTile> & { operation?: 'update' | 'remove'; position?: 'start' }) => {
    setError(null);
    mutation.mutate({ operation: patch.operation ?? 'update', space_id: tile.spaceId, expected_revision: layout.revision,
      width: patch.width, zone: patch.zone, position: patch.position },
    { onError: e => setError(e.message) });
  };
  const refresh = async () => {
    setRefreshing(true);setError(null);
    try { await refreshSpace(tile.spaceId); }
    catch (e) { setError(e instanceof Error ? e.message : 'Refresh failed'); }
    finally { await detail.refetch();setRefreshing(false); }
  };
  const status = detail.isError ? 'Could not check for updates'
    : failures.length ? 'Refresh failed · showing last saved data'
    : space?.status === 'paused' ? 'Paused'
    : space?.status === 'archived' ? 'Archived'
    : space?.health?.freshness.state === 'stale' ? 'Saved data is stale'
    : space?.lastRefreshedAt ? `Refreshed ${agoLabel(space.lastRefreshedAt)}`
    : space?.dataSources.length ? 'Waiting for first refresh' : 'Saved snapshot';
  return (
    <section className="flex min-w-0 flex-col gap-2.5" aria-label={space?.title ?? tile.spaceId}>
      <div className="flex min-w-0 items-center gap-2">
        <Link className="min-w-0 flex-1 truncate text-small font-semibold text-muted hover:text-primary" to={`/workspaces/${encodeURIComponent(tile.spaceId)}`}>
          {space?.title ?? tile.spaceId}
        </Link>
        <details className="relative">
          <summary className="cursor-pointer rounded-sm px-2 py-1 text-small text-muted" aria-label={`Tile settings for ${space?.title ?? tile.spaceId}`}>Tune</summary>
          <div className="absolute right-0 z-30 mt-1 flex w-56 flex-col gap-3 rounded-md border border-border bg-surface p-3 shadow-popover">
            <label className="text-small">Width<select aria-label="Tile width" className="mt-1 w-full rounded-sm border border-border bg-canvas p-2" value={tile.width} disabled={mutation.isPending} onChange={e => change({ width: e.target.value as HomeTile['width'] })}>
              <option value="small">Small</option><option value="medium">Medium</option><option value="wide">Wide</option>
            </select></label>
            <label className="text-small">Section<select aria-label="Tile section" className="mt-1 w-full rounded-sm border border-border bg-canvas p-2" value={tile.zone} disabled={mutation.isPending} onChange={e => change({ zone: e.target.value as HomeTile['zone'] })}>
              <option value="now">Now</option><option value="watching">Watching</option>
            </select></label>
            <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => change({ position: 'start' })}><ArrowUp className="h-4 w-4" /> Move to first</Button>
            <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => change({ operation: 'remove' })}><Trash2 className="h-4 w-4" /> Remove from Home</Button>
          </div>
        </details>
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-surface">
        {space ? <WorkspaceFrame key={`${tile.spaceId}:${detail.data?.viewMtimeMs}:${detail.data?.dataMtimeMs}`}
          id={tile.spaceId} title={`${space.title} preview`} readOnly className="h-[300px] w-full border-0" />
          : detail.isLoading ? <Skeleton className="h-[300px] w-full" />
          : <p role="status" className="px-4 py-8 text-small text-muted">This Space could not be loaded. Its Home placement is kept.</p>}
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
          <span className="min-w-0 flex-1 text-caption text-muted">{status}</span>
          {space && space.dataSources.length > 0 && <Button size="sm" variant="ghost" disabled={refreshing} onClick={() => { void refresh(); }}><RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Refresh</Button>}
          <Link className="inline-flex items-center gap-1 text-small font-semibold text-primary" to={`/workspaces/${encodeURIComponent(tile.spaceId)}`}>Open Space <ExternalLink className="h-3.5 w-3.5" /></Link>
        </div>
        <div className="flex items-center justify-between border-t border-border px-3 py-2 text-caption text-faint">
          <span>Saved view · open Space to interact</span>
          <button className="cursor-pointer text-primary hover:underline" onClick={() => navigate(`/chat?prompt=${encodeURIComponent(`Help me refine the Space ${JSON.stringify(tile.spaceId)} shown on my Home. Read its current content and ask what I want to change.`)}`)}>Ask Clem</button>
        </div>
        {error && <p role="alert" className="border-t border-border px-3 py-2 text-small text-danger">{error}</p>}
      </div>
    </section>
  );
}
