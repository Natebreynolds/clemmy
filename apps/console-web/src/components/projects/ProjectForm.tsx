/**
 * Start a project: a name, and optionally what it is for and what it should
 * achieve. Everything else (who is on it, which accounts it uses, its
 * standing context) is added on the project's own page once it exists.
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { createProject, goalsFromText, refusalText, type ProjectOverview } from '@/lib/projects';

export function ProjectForm({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (overview: ProjectOverview) => void;
}) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [goals, setGoals] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const submit = async () => {
    if (!name.trim()) { setError('Give the project a name.'); return; }
    setSaving(true);
    setError(null);
    try {
      const goalList = goalsFromText(goals);
      onCreated(await createProject({
        name: name.trim(),
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        ...(goalList.length > 0 ? { goals: goalList } : {}),
      }));
    } catch (failure) {
      setError(refusalText(failure, 'The project could not be created. Try again.'));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="New project">
      <div className="absolute inset-0 bg-black/30 animate-fade-in" onClick={saving ? undefined : onClose} />
      <form
        className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-modal animate-fade-in"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h3 className="text-h3 text-fg">New project</h3>
          <button type="button" onClick={onClose} disabled={saving} className="rounded-sm p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Close">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                value={name}
                onChange={(event) => { setName(event.target.value); setError(null); }}
                placeholder="e.g. Weekly sales review"
                maxLength={80}
                autoFocus
                aria-invalid={Boolean(error) && !name.trim()}
              />
            )}
          </Field>
          <Field label="What it is for" hint="Optional. One or two sentences, in your words.">
            {(id) => (
              <Textarea
                id={id}
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                placeholder="Keep the weekly sales numbers, the briefing and the follow-ups in one place."
                maxLength={2000}
              />
            )}
          </Field>
          <Field label="Goals" hint="Optional. One to a line.">
            {(id) => (
              <Textarea
                id={id}
                value={goals}
                onChange={(event) => setGoals(event.target.value)}
                placeholder={'A briefing every Monday morning\nNo lead left without a follow-up'}
              />
            )}
          </Field>
          {error && <p className="text-body text-danger" role="alert">{error}</p>}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving || !name.trim()}>{saving ? 'Creating…' : 'Create project'}</Button>
        </footer>
      </form>
    </div>
  );
}
