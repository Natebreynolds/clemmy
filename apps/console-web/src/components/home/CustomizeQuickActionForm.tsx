import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { listWorkflows } from '@/lib/automate';
import type { QuickAction } from '@/lib/home-prefs';

type Kind = QuickAction['kind'];

const KINDS: { value: Kind; label: string }[] = [
  { value: 'prompt', label: 'Prompt' },
  { value: 'workflow', label: 'Workflow' },
];

/**
 * Inline "add a quick action" form that sits at the foot of the Quick
 * actions card: a label, a Prompt / Workflow choice, then either the prompt
 * text or a workflow picked from the user's own list.
 */
export function CustomizeQuickActionForm({
  onAdd,
  onCancel,
}: {
  onAdd: (action: Omit<QuickAction, 'id'>) => void;
  onCancel: () => void;
}) {
  const uid = useId();
  const [label, setLabel] = useState('');
  const [labelTouched, setLabelTouched] = useState(false);
  const [kind, setKind] = useState<Kind>('prompt');
  const [prompt, setPrompt] = useState('');
  const [workflow, setWorkflow] = useState('');

  // Only fetched once the user asks for a workflow.
  const workflows = usePoll(['workflows'], listWorkflows, 0, { enabled: kind === 'workflow' });
  const rows = workflows.data?.workflows ?? [];

  const value = kind === 'prompt' ? prompt.trim() : workflow;
  const valid = label.trim().length > 0 && value.length > 0;

  const pickWorkflow = (name: string) => {
    setWorkflow(name);
    if (!labelTouched && name) setLabel(`Run ${name}`);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onAdd({ kind, label: label.trim(), value });
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
      className="flex flex-col gap-3 bg-canvas px-3 py-3"
      aria-label="New quick action"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${uid}-label`} className="text-label text-fg">Label</label>
        <Input
          id={`${uid}-label`}
          value={label}
          autoFocus
          onChange={(e) => { setLabel(e.target.value); setLabelTouched(true); }}
          placeholder="What it's called on Home"
          maxLength={80}
          className="h-9 bg-surface"
        />
      </div>

      <div role="group" aria-labelledby={`${uid}-kind`} className="flex flex-col gap-1.5">
        <span id={`${uid}-kind`} className="text-label text-fg">Kind</span>
        <div className="inline-flex w-fit rounded-sm border border-border bg-surface p-0.5">
          {KINDS.map((k) => (
            <label key={k.value} className="cursor-pointer">
              <input
                type="radio"
                name={`${uid}-kind-choice`}
                value={k.value}
                checked={kind === k.value}
                onChange={() => setKind(k.value)}
                className="peer sr-only"
              />
              <span className="inline-flex h-7 items-center rounded-[6px] px-2.5 text-caption font-semibold text-muted transition-colors duration-fast hover:text-fg peer-checked:bg-primary-tint peer-checked:text-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                {k.label}
              </span>
            </label>
          ))}
        </div>
      </div>

      {kind === 'prompt' ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-prompt`} className="text-label text-fg">Prompt</label>
          <Textarea
            id={`${uid}-prompt`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Tell Clementine what to do, the way you'd say it in chat"
            className="min-h-[72px] bg-surface"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-workflow`} className="text-label text-fg">Workflow</label>
          {workflows.isLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : workflows.isError ? (
            <p className="text-caption text-danger">
              Couldn't load your workflows.{' '}
              <button
                type="button"
                onClick={() => void workflows.refetch()}
                className="font-semibold underline underline-offset-2 transition-colors hover:text-fg"
              >
                Try again
              </button>
            </p>
          ) : rows.length === 0 ? (
            <p className="text-caption text-muted">No workflows yet — ask Clementine to set one up.</p>
          ) : (
            <Select
              id={`${uid}-workflow`}
              value={workflow}
              onChange={(e) => pickWorkflow(e.target.value)}
              className="h-9 bg-surface"
            >
              <option value="">Choose a workflow…</option>
              {rows.map((w) => (
                <option key={w.name} value={w.name}>{w.name}</option>
              ))}
            </Select>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!valid}>Add to Home</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
