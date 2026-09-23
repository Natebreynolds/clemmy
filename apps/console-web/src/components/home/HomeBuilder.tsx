import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Plus, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { getStarterRecipes, type SpaceRecord } from '@/lib/spaces';
import { usePoll } from '@/lib/poll';
import { useChangeHomeLayout, type HomeLayout } from '@/lib/home-layout';
import type { HomeBuild } from '@/lib/home-builds';

/**
 * Build your Home: describe something for Clem to build, or bring a Space
 * you already have. A build is only handed back once the daemon accepted
 * it; its progress and result then live on the Home itself (BuildCard), and
 * the words typed here survive any failure to send them.
 */
export function HomeBuilder({ layout, spaces, spacesUnavailable, spacesLoading, onClose, startBuild, submitting }: {
  layout: HomeLayout;
  spaces: SpaceRecord[];
  spacesUnavailable?: boolean;
  spacesLoading?: boolean;
  onClose: () => void;
  startBuild: (prompt: string) => Promise<{ build: HomeBuild; duplicate: boolean }>;
  submitting: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [prompt, setPrompt] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [query, setQuery] = useState('');
  const [addingId, setAddingId] = useState<string | null>(null);
  const mutation = useChangeHomeLayout();
  const starters = usePoll(['space-starters'], getStarterRecipes, 60_000);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { dialog.current?.showModal(); promptRef.current?.focus(); }, []);

  const submit = async () => {
    const text = prompt.trim();
    if (!text || submitting) return;
    setSendError(null);
    setDuplicate(false);
    try {
      const result = await startBuild(text);
      if (result.duplicate) { setDuplicate(true); return; }
      onClose();
    } catch (err) {
      setSendError(err instanceof Error && err.message ? err.message : 'That didn’t reach Clem. Try again.');
    }
  };

  const onHome = useMemo(() => new Set(layout.tiles.map((t) => t.spaceId)), [layout.tiles]);
  const live = spaces.filter((s) => s.status !== 'archived');
  const needle = query.trim().toLowerCase();
  const listed = live
    .filter((s) => !needle || s.title.toLowerCase().includes(needle) || (s.contract?.objective ?? '').toLowerCase().includes(needle))
    // What can still be added first, most recently changed first.
    .sort((a, b) => Number(onHome.has(a.id)) - Number(onHome.has(b.id)) || b.updatedAt.localeCompare(a.updatedAt));
  const connected = (starters.data?.starters ?? []).filter((r) => r.connected);

  const add = (space: SpaceRecord) => {
    setAddingId(space.id);
    mutation.mutate(
      { operation: 'pin', space_id: space.id, expected_revision: layout.revision },
      { onSettled: () => setAddingId(null) },
    );
  };

  return (
    <dialog ref={dialog} onCancel={onClose} onClick={e => { if (e.target === dialog.current) onClose(); }}
      aria-labelledby="build-home-title" className="fixed inset-0 m-auto max-h-[85vh] w-[calc(100%_-_2rem)] max-w-[680px] overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface p-0 text-fg shadow-popover backdrop:bg-black/30">
      <div className="flex flex-col gap-7 p-5 sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="build-home-title" className="text-h2 text-balance">Build your Home</h2>
            <p className="mt-1 text-body text-muted">Describe something for Clem to build, or bring a Space you already have.</p>
          </div>
          <Button variant="ghost" size="sm" aria-label="Close" onClick={onClose}><X className="h-4 w-4" aria-hidden /></Button>
        </div>

        <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); void submit(); }}>
          <label htmlFor="home-build-request" className="text-body font-semibold">What should Clem build?</label>
          <textarea
            id="home-build-request"
            ref={promptRef}
            rows={3}
            value={prompt}
            onChange={e => { setPrompt(e.target.value); setDuplicate(false); setSendError(null); }}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}
            placeholder="A morning view of my meetings and the accounts I need to follow up with…"
            className="w-full resize-y rounded-md border border-border bg-canvas p-3 text-body placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          {connected.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-small text-muted">Or start from one that fits what you’ve connected:</p>
              <div className="flex flex-wrap gap-2">
                {connected.map((recipe) => (
                  <button
                    key={recipe.id}
                    type="button"
                    title={recipe.pitch}
                    onClick={() => { setPrompt(recipe.buildPrompt); setDuplicate(false); promptRef.current?.focus(); }}
                    className="inline-flex h-8 items-center rounded-full border border-border bg-surface px-3 text-small text-fg transition-colors hover:border-border-strong hover:bg-hover cursor-pointer"
                  >
                    {recipe.title}
                  </button>
                ))}
              </div>
            </div>
          )}
          {starters.data && !starters.data.connectionsKnown && (
            <p className="text-small text-muted">Couldn’t check what you’ve connected, so only starting points that need nothing are shown.</p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={!prompt.trim() || submitting}>
              {submitting ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Sending…</> : 'Build it'}
            </Button>
            <span className="text-small text-faint">Clem builds it as a Space and adds it to your Home. You can watch it happen there.</span>
          </div>
          {duplicate && <p role="status" className="text-small text-muted">Clem is already building this — it’s on your Home.</p>}
          {sendError && <p role="alert" className="text-small text-danger">{sendError} Your request is still here.</p>}
        </form>

        <section className="flex flex-col gap-3" aria-labelledby="home-add-space">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id="home-add-space" className="text-body font-semibold">Add a Space you already have</h3>
            {live.length > 6 && (
              <label className="relative">
                <span className="sr-only">Find a Space</span>
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" aria-hidden />
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Find a Space"
                  className="h-8 w-52 rounded-md border border-border bg-canvas pl-8 pr-2.5 text-small placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
              </label>
            )}
          </div>
          {spacesUnavailable ? (
            <p role="status" className="text-small text-muted">Couldn’t load your Spaces. You can still describe what you need above.</p>
          ) : spacesLoading ? (
            <p className="text-small text-muted">Loading your Spaces…</p>
          ) : live.length === 0 ? (
            <p className="text-small text-muted">You don’t have a Space yet — the first one can start with the request above.</p>
          ) : listed.length === 0 ? (
            <p className="text-small text-muted">No Space matches “{query}”.</p>
          ) : (
            <ul className="flex max-h-72 flex-col overflow-y-auto overscroll-contain rounded-md border border-border">
              {listed.map((space) => {
                const pinned = onHome.has(space.id);
                return (
                  <li key={space.id} className="flex items-center gap-3 border-t border-border px-3 py-2.5 first:border-t-0">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body font-medium text-fg">{space.title}</p>
                      {space.contract?.objective && <p className="truncate text-small text-muted">{space.contract.objective}</p>}
                    </div>
                    {pinned ? (
                      <span className="inline-flex shrink-0 items-center gap-1 text-small text-muted"><Check className="h-3.5 w-3.5" aria-hidden /> On Home</span>
                    ) : (
                      <Button size="sm" variant="secondary" disabled={addingId !== null} onClick={() => add(space)} aria-label={`Add ${space.title} to Home`}>
                        {addingId === space.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />} Add
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {mutation.error && <p role="alert" className="text-small text-danger">{mutation.error.message}</p>}
        </section>
      </div>
    </dialog>
  );
}
