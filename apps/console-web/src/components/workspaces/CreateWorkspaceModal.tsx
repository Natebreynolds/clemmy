import { useEffect, useRef, useState } from 'react';
import { Plus, Sparkles, AlertCircle, Plug } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { createSpace, listStarterRecipes, type StarterRecipe } from '@/lib/spaces';

/**
 * Seed-prompt creation modal. Instead of dropping the user on an EMPTY
 * placeholder and making them context-switch to chat, we capture "what do you
 * want to build?" up front, create the workspace, and hand the description back
 * so the view can seed Clem's dock with the build request immediately.
 *
 * Starter recipes: the chips are LIVE — fetched from /spaces/starters and
 * matched against the user's actually-connected apps (a Deal Board chip only
 * shows "ready" when a CRM is connected). One click seeds the full build
 * prompt; the static examples below are the offline fallback.
 */

const EXAMPLES: { label: string; prompt: string }[] = [
  { label: 'Pipeline cockpit', prompt: 'A live dashboard of my sales pipeline by stage and close date — each deal scored for risk, with a one-click follow-up email button.' },
  { label: 'Prospect outreach', prompt: 'A list of target accounts where each row surfaces its biggest SEO gap and drafts a personalized cold email I can review and send.' },
  { label: 'Daily plan', prompt: "A daily planner that pulls today's calendar and my open tasks and lets me check things off." },
];

function deriveTitle(title: string, description: string): string {
  const t = title.trim();
  if (t) return t;
  const fromDesc = description.trim().split(/\s+/).slice(0, 6).join(' ');
  return fromDesc || 'New workspace';
}

export function CreateWorkspaceModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after the workspace is created; `build` is the description to seed
   *  Clem with (undefined when the user left it blank → a plain blank surface). */
  onCreated: (spaceId: string, build?: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starters, setStarters] = useState<StarterRecipe[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setError(null);
    setCreating(false);
    listStarterRecipes().then(setStarters).catch(() => setStarters([]));
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const space = await createSpace(deriveTitle(title, description));
      onCreated(space.id, description.trim() || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a workspace.');
      setCreating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/30 p-4 pt-[12vh] animate-fade-in"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="New workspace"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-h3 text-fg">New workspace</h2>
          <p className="mt-0.5 text-small text-muted">Tell Clem what you want and she’ll build it — a live surface that refreshes itself and can act on one click.</p>
        </div>

        <div className="flex flex-col gap-4 p-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-small font-medium text-fg">What do you want to build?</span>
            <textarea
              ref={textareaRef}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
              rows={4}
              placeholder="e.g. A live dashboard of my pipeline by stage, with a follow-up email button on each stalled deal."
              className="w-full resize-y rounded-lg border border-border bg-canvas px-3 py-2 text-body text-fg outline-none placeholder:text-faint focus:border-border-strong"
            />
          </label>

          {starters.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className="inline-flex items-center gap-1 text-caption text-faint">
                <Sparkles className="h-3.5 w-3.5" aria-hidden /> Start from a recipe — matched to what you have connected:
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {[...starters].sort((a, b) => Number(b.connected) - Number(a.connected)).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    title={r.connected ? r.pitch : `${r.pitch}\n(Connect ${r.connects.join(' / ')} first — or pick it anyway and Clem will walk you through connecting.)`}
                    onClick={() => { setDescription(r.buildPrompt); setTitle(r.title); textareaRef.current?.focus(); }}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-caption transition-colors cursor-pointer',
                      r.connected
                        ? 'border-border text-fg hover:border-border-strong'
                        : 'border-border/60 text-faint hover:text-muted',
                    )}
                  >
                    {r.connected ? null : <Plug className="h-3 w-3" aria-hidden />}
                    {r.title}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-caption text-faint"><Sparkles className="h-3.5 w-3.5" aria-hidden /> Try:</span>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  onClick={() => { setDescription(ex.prompt); textareaRef.current?.focus(); }}
                  className="rounded-full border border-border px-2.5 py-1 text-caption text-muted transition-colors hover:border-border-strong hover:text-fg cursor-pointer"
                >
                  {ex.label}
                </button>
              ))}
            </div>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-small font-medium text-fg">Name <span className="text-faint">(optional)</span></span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Derived from your description if left blank"
              className="w-full rounded-lg border border-border bg-canvas px-3 py-2 text-body text-fg outline-none placeholder:text-faint focus:border-border-strong"
            />
          </label>

          {error && (
            <p className="inline-flex items-center gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-small text-danger">
              <AlertCircle className="h-4 w-4" aria-hidden /> {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={() => { void submit(); }}
            disabled={creating}
            className={cn('text-small text-muted hover:text-fg cursor-pointer', creating && 'pointer-events-none opacity-50')}
          >
            Start blank instead
          </button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={creating}>Cancel</Button>
            <Button onClick={() => { void submit(); }} disabled={creating}>
              <Plus className="h-4 w-4" aria-hidden /> {creating ? 'Creating…' : description.trim() ? 'Build it' : 'Create'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
