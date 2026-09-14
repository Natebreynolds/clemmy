import type { HomeLayout, HomeTile } from '@clem/chat-engine';
import { useState } from 'preact/hooks';
import { api, getWorkspace, listWorkspaces } from '../lib/api';
import { useScreenData } from '../lib/use-screen-data';
import { ScreenNotice } from './ScreenNotice';
import { relativeTime } from './Approvals';

const readLayout = () => api<{ layout: HomeLayout }>('/m/api/home/layout');

function PinnedSpace({ tile, onOpen }: { tile: HomeTile; onOpen: (id: string) => void }) {
  const result = useScreenData(() => getWorkspace(tile.spaceId), { intervalMs: 8000, resourceKey: `home-space:${tile.spaceId}` });
  const space = result.data;
  const failed = space?.sources.some(source => !source.ok);
  return <div class="home-card">
    <button type="button" class="home-row home-row-tap" onClick={() => onOpen(tile.spaceId)}>
      <div class="min-w-0"><div class="home-row-title">{space?.title ?? tile.spaceId}</div>
        <div class="home-row-note">{result.error ? 'Could not check for updates' : failed ? 'Refresh failed · showing saved data' : space?.status === 'paused' ? 'Paused' : space?.status === 'archived' ? 'Archived' : space?.freshness === 'stale' ? 'Saved data is stale' : space?.lastRefreshedAt ? `Refreshed ${relativeTime(space.lastRefreshedAt)}` : 'Saved snapshot'}</div>
      </div><span aria-hidden="true">↗</span>
    </button>
    {space ? <div class="home-row" style={{ display: 'block' }}>
      {space.projection.headline.map(field => <div key={field.label} class="home-row-note" style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}><span>{field.label}</span><strong>{field.value}</strong></div>)}
      {!space.projection.headline.length && space.projection.records.slice(0, 3).map(record => <div key={record.key} class="home-row-note">{record.primary}</div>)}
      {space.projection.total > 3 && <div class="home-row-note">Open Space for all {space.projection.total} records</div>}
      {!space.projection.headline.length && !space.projection.records.length && <div class="home-row-note">{space.objective ?? 'Open this Space to see its saved view.'}</div>}
    </div> : <div class="home-row-note" style={{ padding: '12px' }}>{result.loading ? 'Loading saved content…' : 'Content unavailable. This tile is still on Home.'}</div>}
  </div>;
}

export function HomeTiles({ onOpenWorkspace, onAsk }: { onOpenWorkspace: (id: string) => void; onAsk: (prompt: string) => void }) {
  const state = useScreenData(readLayout, { intervalMs: 6000, resourceKey: 'home-layout' });
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = useScreenData(listWorkspaces, { disabled: !adding, resourceKey: 'home-tile-choices' });
  const layout = state.data?.layout;
  const pin = async (id: string) => {
    if (!layout) return;
    setSaving(true);setError(null);
    try {
      await api('/m/api/home/layout', { method: 'PATCH', body: JSON.stringify({ operation: 'pin', space_id: id, expected_revision: layout.revision }) });
      await state.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update Home');await state.refresh(); }
    finally { setSaving(false); }
  };
  return <section class="home-section" aria-label="Your Home tiles">
    <div class="pane-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><h2 class="section-head">Your Home</h2>
      <button type="button" class="home-customize" style={{ width: 'auto' }} disabled={!layout} onClick={() => setAdding(!adding)}>Build home</button>
    </div>
    <ScreenNotice error={state.error ?? error} offline={state.offline} onRetry={() => { void state.refresh(); }} hasData={Boolean(layout)} />
    {layout && ['now', 'watching'].map(zone => {
      const tiles = layout.tiles.filter(tile => tile.zone === zone);
      return tiles.length > 0 ? <div key={zone} class="home-section"><h3 class="section-head">{zone === 'now' ? 'Now' : 'Watching'}</h3>
        {tiles.map(tile => <PinnedSpace key={tile.spaceId} tile={tile} onOpen={onOpenWorkspace} />)}
      </div> : null;
    })}
    {layout?.tiles.length === 0 && <p class="home-row-note">Add a Space, or ask Clem to build something you want to keep in view.</p>}
    {adding && <div class="home-card">
      <button type="button" class="home-row home-row-tap" onClick={() => onAsk('Help me build a Home tile using my connected tools and relevant preferences. Find out what I want to keep in view, create or update a Space, then add it to my Home. Preserve my existing Home tiles.')}><span>Build with Clem</span><span aria-hidden="true">↗</span></button>
      {choices.data?.workspaces.filter(space => space.status !== 'archived').map(space => <button key={space.id} type="button" class="home-row home-row-tap" disabled={saving || layout?.tiles.some(tile => tile.spaceId === space.id)} onClick={() => { void pin(space.id); }}><span>{space.title}</span><span>{layout?.tiles.some(tile => tile.spaceId === space.id) ? 'On Home' : '+ Add'}</span></button>)}
      {choices.error && <p role="alert" class="home-row-note">Could not load Spaces.</p>}
    </div>}
  </section>;
}
