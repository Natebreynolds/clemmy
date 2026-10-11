/** Pinned Spaces stay in their saved order, with every pin reachable. */
import type { HomeLayout } from '@clem/chat-engine';
import { useState } from 'preact/hooks';
import { api, listWorkspaces } from '../lib/api';
import { useScreenData } from '../lib/use-screen-data';
import { haptic } from '../lib/native-bridge';

const readLayout = () => api<{ layout: HomeLayout }>('/m/api/home/layout');

export function HomeTiles({ onOpenWorkspace, onAsk }: { onOpenWorkspace: (id: string) => void; onAsk: (prompt: string) => void }) {
  const state = useScreenData(readLayout, { intervalMs: 30_000, resourceKey: 'home-layout' });
  const spaces = useScreenData(listWorkspaces, { intervalMs: 30_000, resourceKey: 'home-tile-spaces' });
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const layout = state.data?.layout;
  const byId = new Map((spaces.data?.workspaces ?? []).map((space) => [space.id, space]));
  const pin = async (id: string) => {
    if (!layout) return;
    setSaving(true); setError(null);
    try {
      await api('/m/api/home/layout', { method: 'PATCH', body: JSON.stringify({ operation: 'pin', space_id: id, expected_revision: layout.revision }) });
      await state.refresh();
      setAdding(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update Today'); await state.refresh(); }
    finally { setSaving(false); }
  };
  const tiles = layout?.tiles ?? [];
  return (
    <section class="home-pinned-spaces" aria-labelledby="home-pinned-spaces-title">
      <div class="home-pinned-head">
        <h2 id="home-pinned-spaces-title" class="section-head">Pinned Spaces</h2>
        <button type="button" class="btn-quiet" aria-expanded={adding} aria-controls="home-add-space" onClick={() => { haptic('light'); setAdding(!adding); }}>
          {adding ? 'Done' : 'Add Space'}
        </button>
      </div>
      <ul class="home-pinned-list" id="home-pinned-spaces-list">
        {(expanded ? tiles : tiles.slice(0, 3)).map((tile) => {
          const space = byId.get(tile.spaceId);
          const tone = !space || space.status === 'paused' || space.status === 'archived' ? 'quiet' : space.freshness === 'stale' ? 'stale' : 'live';
          return (
            <li key={tile.spaceId}><button type="button" class="home-pinned-row" onClick={() => { haptic('light'); onOpenWorkspace(tile.spaceId); }}>
              <span class={`today-chip-dot ${tone}`} aria-hidden="true" />
              <span class="home-pinned-name">{space?.title ?? tile.spaceId}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            </button></li>
          );
        })}
      </ul>
      {tiles.length > 3 ? <button type="button" class="home-pinned-more" aria-expanded={expanded} aria-controls="home-pinned-spaces-list" onClick={() => { haptic('light'); setExpanded(!expanded); }}>{expanded ? 'Show fewer Spaces' : `Show all ${tiles.length} Spaces`}</button> : null}
      {!layout && !state.error ? <p class="section-empty" role="status">Loading pinned Spaces…</p> : null}
      {tiles.length === 0 && layout ? <p class="section-empty">Keep the Spaces you use often here.</p> : null}
      {state.error ? <p class="home-row-error" role="alert">Pinned Spaces could not be loaded. <button type="button" class="link-btn" onClick={() => void state.refresh()}>Retry</button></p> : null}
      {adding ? (
        <div id="home-add-space" class="home-pin-picker">
          <button type="button" class="home-row home-row-tap" onClick={() => onAsk('Help me build a Home tile using my connected tools and relevant preferences. Find out what I want to keep in view, create or update a Space, then add it to my Home. Preserve my existing Home tiles.')}>
            <span>Ask Clem to build one</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" /></svg>
          </button>
          {(spaces.data?.workspaces ?? []).filter((space) => space.status !== 'archived').map((space) => {
            const on = tiles.some((tile) => tile.spaceId === space.id);
            return (
              <button key={space.id} type="button" class="home-row home-row-tap" disabled={saving || on || !layout} onClick={() => { void pin(space.id); }}>
                <span class="truncate">{space.title}</span><span class="home-row-note">{on ? 'In view' : 'Add'}</span>
              </button>
            );
          })}
          {error || spaces.error ? <p role="alert" class="home-row-note" style={{ padding: '10px 14px' }}>{error ?? 'Could not load Spaces.'}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
