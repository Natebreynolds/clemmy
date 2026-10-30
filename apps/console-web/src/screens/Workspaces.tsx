import { useEffect, useRef, useState, type RefObject } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Clock, Search } from 'lucide-react';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/Button';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { usePoll } from '@/lib/poll';
import { feedTime, listSpaces, type SpaceRecord } from '@/lib/spaces';
import { humanizeCron } from '@/lib/cron';
import { CreateWorkspaceModal } from '@/components/workspaces/CreateWorkspaceModal';
import { SpacesIntro } from '@/components/workspaces/SpacesIntro';
import { buildingSpaceSlugs, listWorkingNowSnapshot } from '@/lib/activity';
import { filterWorkspaceGallery } from '@/lib/workspace-gallery';
import { WorkspaceFrame } from '@/components/workspaces/WorkspaceFrame';

function statusTone(status: SpaceRecord['status']): Tone {
  if (status === 'active') return 'success';
  if (status === 'paused') return 'warning';
  return 'neutral';
}

function scheduleHint(space: SpaceRecord): string | null {
  const scheduled = space.dataSources.find((d) => d.schedule);
  if (!scheduled?.schedule) return null;
  try { return humanizeCron(scheduled.schedule); } catch { return scheduled.schedule; }
}

function healthLabel(space: SpaceRecord): { tone: Tone; text: string } {
  const health = space.health;
  if (!health) return { tone: 'neutral', text: 'Checking' };
  if (health.issues.length > 0) return { tone: 'warning', text: health.issues.length === 1 ? 'Needs a look' : `${health.issues.length} things to check` };
  if (health.freshness.state === 'fresh') return { tone: 'success', text: 'Up to date' };
  if (health.freshness.state === 'no_sources') return { tone: 'neutral', text: 'Saved page' };
  if (health.freshness.state === 'never_refreshed') return { tone: 'warning', text: 'Not refreshed yet' };
  return { tone: 'warning', text: 'Out of date' };
}

/** True once the element has come within a screen of the viewport; stays true. */
function useNearViewport(enabled: boolean): [RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(() => enabled && typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (!enabled || near || !ref.current) return;
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setNear(true); observer.disconnect(); }
    }, { rootMargin: '100% 0px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [enabled, near]);
  return [ref, near];
}

export function WorkspaceCard({ space, onOpen, building, previews = false }: { space: SpaceRecord; onOpen: () => void; building?: boolean; previews?: boolean }) {
  const [previewRef, previewVisible] = useNearViewport(previews);
  const sched = scheduleHint(space);
  const health = space.health;
  const healthStatus = healthLabel(space);
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-border-raised bg-raised text-left transition-colors duration-base hover:border-border-strong hover:bg-hover">
      {/* A real link: it opens in place, and can be opened elsewhere or copied. */}
      <Link
        to={`/workspaces/${encodeURIComponent(space.id)}`}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          onOpen();
        }}
        aria-label={`Open the ${space.title} Space`}
        className="absolute inset-0 z-20 rounded-2xl cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      >
        <span className="sr-only">Open the {space.title} Space</span>
      </Link>
      {/* Live preview — a scaled, non-interactive snapshot of the actual view,
          started only once the card is near the screen. */}
      {previews && <div ref={previewRef} className="relative h-40 w-full overflow-hidden border-b border-border bg-subtle">
        {previewVisible && (
          <WorkspaceFrame
            id={space.id}
            title={`${space.title} preview`}
            tabIndex={-1}
            ariaHidden
            readOnly
            className="pointer-events-none absolute left-0 top-0 origin-top-left"
            style={{ width: '250%', height: '250%', transform: 'scale(0.4)', border: 0 }}
          />
        )}
        {space.status !== 'active' && (
          <div className="absolute inset-0 flex items-center justify-center bg-canvas/55">
            <StatusPill tone={statusTone(space.status)}>{space.status}</StatusPill>
          </div>
        )}
      </div>}
      <div className="flex flex-1 flex-col gap-1 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="line-clamp-2 min-w-0 text-h3 text-fg" title={space.title}>{space.title}</h3>
          {building
            ? <StatusPill tone="live" className="shrink-0 whitespace-nowrap">Clementine is building</StatusPill>
            : (
              <StatusPill
                tone={healthStatus.tone}
                className="shrink-0 whitespace-nowrap"
                title={health && health.issues.length > 0 ? health.issues.join('\n') : undefined}
              >
                {healthStatus.text}
              </StatusPill>
            )}
        </div>
        {space.contract?.objective && <p className="line-clamp-2 text-small text-muted">{space.contract.objective}</p>}
        <div className="flex flex-wrap items-center gap-2 text-caption text-faint">
          <span>Updated {feedTime(space.updatedAt)}</span>
          {!previews && space.status !== 'active' && <StatusPill tone={statusTone(space.status)}>{space.status}</StatusPill>}
        </div>
        {health && (health.counts.dataSources > 0 || health.counts.actions > 0) && (
          <p className="mt-1 text-small text-muted">
            {[
              health.counts.dataSources > 0 ? `${health.counts.dataSources} source${health.counts.dataSources === 1 ? '' : 's'}` : '',
              health.counts.actions > 0 ? `${health.counts.actions} action${health.counts.actions === 1 ? '' : 's'}` : '',
            ].filter(Boolean).join(' · ')}
          </p>
        )}
        {sched && (
          <p className="mt-1 inline-flex items-center gap-1.5 text-small text-muted">
            <Clock className="h-3.5 w-3.5" aria-hidden /> {sched}
          </p>
        )}

      </div>
    </article>
  );
}

export function Workspaces() {
  const navigate = useNavigate();
  const spaces = usePoll(['spaces'], listSpaces, 8000);
  // Which Spaces she is building right now — from the live activity projection.
  const working = usePoll(['working-now-spaces'], listWorkingNowSnapshot, 4000);
  const building = buildingSpaceSlugs(working.data?.entries ?? []);
  const [prefill, setPrefill] = useState<string | undefined>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [previews, setPreviews] = useState(false);
  // Home's 'New project' lands here with ?new=1: open the create dialog once,
  // then drop the flag so a refresh does not reopen it.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    setModalOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // On create, carry the build request to the view as route state so the dock
  // seeds Clem with it immediately (no cold context-switch to chat).
  const openCreated = (id: string, build?: string) => {
    setModalOpen(false);
    navigate(`/workspaces/${encodeURIComponent(id)}`, build ? { state: { build } } : undefined);
  };

  const items = spaces.data ?? [];
  const search = searchParams.get('q') ?? '';
  const visible = filterWorkspaceGallery(items, search);
  const setSearch = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value.trim()) next.set('q', value); else next.delete('q');
    setSearchParams(next, { replace: true });
  };

  return (
    <Page
      title="Spaces"
      subtitle="Live, interactive surfaces Clementine builds for you — reports, trackers, planners"
      actions={
        <Button data-clem-guide="create-space" onClick={() => setModalOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden /> New Space
        </Button>
      }
    >
      {spaces.isError && spaces.data && <p role="status" className="mb-4 text-small text-warning">Spaces couldn’t refresh. Showing the last loaded collection. <button type="button" className="font-semibold underline" onClick={() => void spaces.refetch()}>Retry</button></p>}
      {spaces.isLoading && !spaces.data ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-label="Loading Spaces">
          {[0, 1, 2].map(i => <div key={i} className="h-36 animate-pulse rounded-2xl border border-border bg-subtle" />)}
        </div>
      ) : spaces.isError && !spaces.data ? (
        <QueryUnavailable title="Spaces are unavailable" description="Clementine couldn’t load your Spaces. No Space has been removed." onRetry={() => { void spaces.refetch(); }} />
      ) : items.length === 0 ? (
        <SpacesIntro force onBuild={buildPrompt => { setPrefill(buildPrompt); setModalOpen(true); }} />
      ) : <>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label className="flex min-h-10 min-w-[15rem] flex-1 items-center gap-2 rounded-md border border-border bg-surface px-3 text-muted">
            <Search className="h-4 w-4 shrink-0" aria-hidden />
            <input type="search" value={search} onChange={event => setSearch(event.target.value)} aria-label="Search Spaces" placeholder="Search Spaces" className="min-w-0 flex-1 bg-transparent py-2 text-body text-fg placeholder:text-muted" />
          </label>
          <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 text-small text-muted">
            <input type="checkbox" checked={previews} onChange={event => setPreviews(event.target.checked)} className="accent-primary" /> Live previews
          </label>
          {search && <Button size="sm" variant="ghost" onClick={() => setSearch('')}>Clear search</Button>}
        </div>
        <p role="status" className="mb-4 text-small text-muted">{search.trim() ? `${visible.length} of ${items.length} Spaces` : `${items.length} ${items.length === 1 ? 'Space' : 'Spaces'}`}</p>
        {visible.length === 0 ? <div className="rounded-lg border border-dashed border-border px-5 py-8">
          <p className="text-body font-semibold text-fg">No Spaces match your search</p>
          <p className="mt-1 text-small text-muted">Search checks every loaded Space’s title, purpose and ID.</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => setSearch('')}>Clear search</Button>
        </div> : <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map(space => <WorkspaceCard key={space.id} space={space} previews={previews} building={building.has(space.id)} onOpen={() => navigate(`/workspaces/${encodeURIComponent(space.id)}`)} />)}
        </div>}
      </>}
      <CreateWorkspaceModal key={prefill ?? ''} open={modalOpen} initialDescription={prefill} onClose={() => { setModalOpen(false); setPrefill(undefined); }} onCreated={openCreated} />
    </Page>
  );
}
