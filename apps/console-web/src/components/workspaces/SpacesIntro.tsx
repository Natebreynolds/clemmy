/**
 * What a Space is, in the product's own words — shown once at the top of the
 * Spaces screen until dismissed, and the door to build one with Clementine.
 */
import { useEffect, useState } from 'react';
import { Sparkles, Database, ShieldCheck, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { listStarterRecipes, type StarterRecipe } from '@/lib/spaces';

const DISMISS_KEY = 'clem.spaces.intro.dismissed';

function readDismissed(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}
function writeDismissed(): void {
  try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* per-viewer convenience only */ }
}

export interface SpacesIntroProps {
  onBuild: (buildPrompt?: string) => void;
  /** Always show (e.g. when the user has no Spaces yet). */
  force?: boolean;
}

export function SpacesIntro({ onBuild, force }: SpacesIntroProps) {
  const [dismissed, setDismissed] = useState(() => readDismissed());
  const [starters, setStarters] = useState<StarterRecipe[]>([]);
  useEffect(() => {
    listStarterRecipes().then(setStarters).catch(() => setStarters([]));
  }, []);
  if (dismissed && !force) return null;
  const ready = starters.filter((s) => s.connected).slice(0, 4);
  return (
    <section aria-label="About Spaces" className="relative mb-5 overflow-hidden rounded-2xl border border-border bg-surface">
      {!force && (
        <button type="button" onClick={() => { writeDismissed(); setDismissed(true); }} className="absolute right-3 top-3 cursor-pointer text-muted hover:text-fg" aria-label="Hide this introduction">
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
      <div className="grid gap-5 p-5 md:grid-cols-[1.2fr_1fr]">
        <div className="space-y-3">
          <p className="text-h3 text-fg">A Space is a living page Clementine builds for you and keeps alive.</p>
          <p className="text-small text-muted">
            Describe what you want to see — a pipeline cockpit, a daily brief, a prospect list — and watch her build it here, step by step. A Space is not a one-off answer: it pulls from your connected tools, refreshes on a schedule, and can act, with your approval.
          </p>
          <ul className="grid gap-2 text-small sm:grid-cols-3">
            <li className="flex items-start gap-2"><Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden /><span><span className="text-fg">Built live.</span> <span className="text-muted">You see each step as she reads, writes and refines.</span></span></li>
            <li className="flex items-start gap-2"><Database className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden /><span><span className="text-fg">Kept fresh.</span> <span className="text-muted">Sources from your connected apps, on a schedule you set.</span></span></li>
            <li className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden /><span><span className="text-fg">Acts with approval.</span> <span className="text-muted">Buttons that send or update wait for your yes.</span></span></li>
          </ul>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button onClick={() => onBuild()}><Plus className="h-4 w-4" aria-hidden /> Build a Space with Clementine</Button>
            <span className="text-caption text-faint">Spaces also front your workflows and skills — a page for something Clementine already runs.</span>
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-caption uppercase tracking-wide text-faint">Start from something she can build now</p>
          {ready.length === 0 ? (
            <p className="text-small text-muted">Connect an app under Connect and starter Spaces will appear here.</p>
          ) : (
            <ul className="grid gap-2">
              {ready.map((recipe) => (
                <li key={recipe.id}>
                  <button
                    type="button"
                    onClick={() => onBuild(recipe.buildPrompt)}
                    className="w-full cursor-pointer rounded-xl border border-border bg-subtle px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-primary-tint"
                  >
                    <span className="block text-small text-fg">{recipe.title}</span>
                    <span className="block truncate text-caption text-muted">{recipe.pitch}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
