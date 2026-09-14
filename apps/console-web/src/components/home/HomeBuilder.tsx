import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { listStarterRecipes, type SpaceRecord } from '@/lib/spaces';
import { usePoll } from '@/lib/poll';
import { useChangeHomeLayout, type HomeLayout } from '@/lib/home-layout';

export function HomeBuilder({ layout, spaces, spacesUnavailable, spacesLoading, onClose, onBuild }: {
  layout: HomeLayout; spaces: SpaceRecord[]; spacesUnavailable?: boolean; spacesLoading?: boolean; onClose: () => void; onBuild: (prompt: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [prompt, setPrompt] = useState('');
  const mutation = useChangeHomeLayout();
  const recipes = usePoll(['space-starters'], listStarterRecipes, 60_000);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const build = (text: string) => {
    onClose();onBuild(`${text.trim()}\nCreate or update an appropriate Space and add it to my Home. Read my current Home layout and preserve its other tiles. Use my relevant preferences and connected tools; ask only for missing decisions.`);
  };
  return (
    <dialog ref={dialog} onCancel={onClose} onClick={e => { if (e.target === dialog.current) onClose(); }}
      aria-labelledby="build-home-title" className="fixed inset-0 m-auto max-h-[85vh] w-[calc(100%_-_2rem)] max-w-[720px] overflow-y-auto rounded-lg border border-border bg-surface p-0 text-fg shadow-popover backdrop:bg-black/30">
      <div className="flex flex-col gap-6 p-5 sm:p-7">
        <div className="flex items-start justify-between gap-4"><div><h2 id="build-home-title" className="text-h2">Build your Home</h2><p className="mt-1 text-small text-muted">Bring a Space here, or tell Clem what you want to keep in view.</p></div>
          <Button variant="ghost" size="sm" aria-label="Close Home builder" onClick={onClose}><X className="h-4 w-4" /></Button></div>
        <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault();if(prompt.trim())build(prompt); }}>
          <label htmlFor="home-build-request" className="text-small font-semibold">What should Clem build?</label>
          <textarea id="home-build-request" rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="A morning view of my meetings and the accounts I need to follow up with…" className="w-full resize-y rounded-md border border-border bg-canvas p-3 text-body" />
          <Button type="submit" disabled={!prompt.trim()} className="self-start">Build with Clem</Button>
        </form>
        <section className="flex flex-col gap-3" aria-label="Your Spaces"><h3 className="text-small font-semibold text-muted">Your Spaces</h3>
          {spaces.filter(space => space.status !== 'archived').map(space => {
            const pinned = layout.tiles.some(tile => tile.spaceId === space.id);
            return <div key={space.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-3"><div className="min-w-0 flex-1"><p className="text-body font-semibold">{space.title}</p><p className="truncate text-small text-muted">{space.contract?.objective ?? 'A saved Space'}</p></div>
              <Button size="sm" variant="secondary" disabled={pinned || mutation.isPending} onClick={() => mutation.mutate({ operation: 'pin', space_id: space.id, expected_revision: layout.revision })}>{pinned ? 'On Home' : <><Plus className="h-3.5 w-3.5" /> Add</>}</Button></div>;
          })}
          {spacesUnavailable ? <p role="status" className="text-small text-muted">Couldn’t load your Spaces. You can still describe what you need above.</p> : spacesLoading ? <p className="text-small text-muted">Loading your Spaces…</p> : !spaces.some(space => space.status !== 'archived') && <p className="text-small text-muted">Your first Space can start with the request above.</p>}
          {mutation.error && <p role="alert" className="text-small text-danger">{mutation.error.message}</p>}
        </section>
        <section className="flex flex-col gap-3" aria-label="Starting points"><h3 className="text-small font-semibold text-muted">Starting points</h3>
          <div className="grid gap-3 sm:grid-cols-2">{recipes.data?.filter(recipe => recipe.connected).map(recipe => <button key={recipe.id} onClick={() => build(recipe.buildPrompt)} className="cursor-pointer rounded-md border border-border p-3 text-left hover:bg-hover"><p className="text-body font-semibold">{recipe.title}</p><p className="mt-1 text-small text-muted">{recipe.pitch}</p></button>)}</div>
          {!recipes.isLoading && !recipes.isError && !recipes.data?.some(recipe => recipe.connected) && <p className="text-small text-muted">Describe what you need above. Connecting your tools will add more starting points.</p>}
          {recipes.isError && <p className="text-small text-muted">Starting points are unavailable. You can still describe what you need above.</p>}
        </section>
      </div>
    </dialog>
  );
}
