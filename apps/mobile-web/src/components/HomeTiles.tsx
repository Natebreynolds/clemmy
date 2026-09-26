/**
 * What you keep in view, as a row of chips. Each chip is a pinned Space with
 * a freshness dot; tapping opens the Space. The paragraph-tall tiles this
 * replaced were the tallest thing on the phone (09-26) and said less than a
 * chip. Adding a Space, or asking Clem to build one, sits behind the "+".
 */
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
  if (!layout && !state.error) return null;
  return (
    <section class="today-watching" aria-label="Watching">
      <div class="today-chips">
        {tiles.map((tile) => {
          const space = byId.get(tile.spaceId);
          const tone = space?.status === 'paused' || space?.status === 'archived' ? 'quiet' : space?.freshness === 'stale' ? 'stale' : 'live';
          return (
            <button key={tile.spaceId} type="button" class="today-chip" onClick={() => { haptic('light'); onOpenWorkspace(tile.spaceId); }}>
              <span class={`today-chip-dot ${tone}`} aria-hidden="true" />
              <span class="truncate">{space?.title ?? tile.spaceId}</span>
            </button>
          );
        })}
        <button type="button" class="today-chip today-chip-add" aria-expanded={adding} aria-label="Keep a Space in view" onClick={() => { haptic('light'); setAdding(!adding); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          {tiles.length === 0 ? <span>Keep a Space in view</span> : null}
        </button>
      </div>
      {adding ? (
        <div class="home-card rise" style={{ '--i': 1 }}>
          <button type="button" class="home-row home-row-tap" onClick={() => onAsk('Help me build a Home tile using my connected tools and relevant preferences. Find out what I want to keep in view, create or update a Space, then add it to my Home. Preserve my existing Home tiles.')}>
            <span>Ask Clem to build one</span><span aria-hidden="true">↗</span>
          </button>
          {(spaces.data?.workspaces ?? []).filter((space) => space.status !== 'archived').map((space) => {
            const on = tiles.some((tile) => tile.spaceId === space.id);
            return (
              <button key={space.id} type="button" class="home-row home-row-tap" disabled={saving || on} onClick={() => { void pin(space.id); }}>
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
