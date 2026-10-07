/**
 * Create / edit an agent: a name, what it handles, the standing instructions
 * every thread starts from, and what it reaches for first. A centered modal;
 * on save it POSTs (create) or PATCHes (edit) and hands the record back.
 */
import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { createAgent, updateAgent, type AgentInput, type AgentRecord, type AgentCatalog } from '@/lib/agents';
import { usePendingCommit } from '@/lib/pending-commit';

/** The select value that means "no model of its own — follow the brain". */
const FOLLOW_BRAIN = '__follow__';

export function AgentForm({
  mode,
  agent,
  catalog,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  agent?: AgentRecord;
  catalog?: AgentCatalog;
  onClose: () => void;
  onSaved: (saved: AgentRecord) => void;
}) {
  const [name, setName] = useState(agent?.name ?? '');
  const [handles, setHandles] = useState(agent?.handles ?? '');
  const [instructions, setInstructions] = useState(agent?.instructions ?? '');
  const [model, setModel] = useState(agent?.model ?? FOLLOW_BRAIN);
  const [skills, setSkills] = useState<Set<string>>(new Set(agent?.skills ?? []));
  const [workflows, setWorkflows] = useState<Set<string>>(new Set(agent?.workflows ?? []));
  const [tools, setTools] = useState<Set<string>>(new Set(agent?.tools ?? []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commit = usePendingCommit(`${mode}:${agent?.id ?? 'new'}`);
  const close = () => { if (!commit.pending) onClose(); };

  const toggleIn = (setter: typeof setSkills) => (value: string) =>
    setter((prev) => {
      const next = new Set(prev);
      next.has(value) ? next.delete(value) : next.add(value);
      return next;
    });

  const models = catalog?.models;
  // A model the record names but the catalog no longer offers still shows,
  // so editing something else does not silently drop it.
  const staleModel = agent?.model && models && !models.some((m) => m.id === agent.model) ? agent.model : null;

  const submit = async () => {
    if (!name.trim()) { setError('Give the agent a name.'); return; }
    const token = commit.begin();
    if (!token) return;
    setSaving(true); setError(null);
    const input: AgentInput = {
      name: name.trim(),
      handles: handles.trim(),
      instructions: instructions.trim(),
      skills: Array.from(skills),
      workflows: Array.from(workflows),
      tools: Array.from(tools),
      // No model picker offered: leave the record's model alone.
      ...(models ? { model: model === FOLLOW_BRAIN ? null : model } : {}),
    };
    try {
      const saved = mode === 'create' ? await createAgent(input) : await updateAgent(agent!.id, input);
      if (commit.owns(token)) onSaved(saved);
    } catch (e) {
      // The server answers with one plain sentence; show it as is.
      if (commit.owns(token)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (commit.finish(token)) setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`${mode === 'create' ? 'New' : 'Edit'} agent`}>
      <div className="absolute inset-0 bg-black/30 animate-fade-in" onClick={close} />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-modal animate-fade-in">
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h3 className="text-h3 text-fg">{mode === 'create' ? 'New agent' : `Edit ${agent?.name}`}</h3>
          <button onClick={close} disabled={saving} className="rounded-sm p-1.5 text-muted hover:bg-hover hover:text-fg disabled:opacity-50" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>

        <fieldset disabled={saving} aria-busy={saving} className="m-0 min-h-0 min-w-0 flex-1 overflow-y-auto border-0 px-5 py-4">
          <Field label="Name">
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sales" autoFocus />}
          </Field>
          <Field label="What it handles" hint="One line, in your words.">
            {(id) => <Input id={id} value={handles} onChange={(e) => setHandles(e.target.value)} placeholder="Follow-ups, proposals and pipeline questions" />}
          </Field>
          <Field label="Standing instructions" hint="Every thread in this agent starts from these.">
            {(id) => (
              <Textarea
                id={id}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Keep replies short. Check the CRM before answering a pipeline question. Draft, never send."
                className="min-h-[160px]"
              />
            )}
          </Field>

          <ChipPicker
            label="Skills"
            hint="What it reaches for first."
            options={catalog?.skills ?? []}
            selected={skills}
            onToggle={toggleIn(setSkills)}
            empty="No skills installed yet."
          />
          <ChipPicker
            label="Workflows"
            hint="Saved workflows it prefers over working things out from scratch."
            options={catalog?.workflows ?? []}
            selected={workflows}
            onToggle={toggleIn(setWorkflows)}
            empty="No workflows saved yet."
          />
          {catalog?.tools && (
            <ChipPicker
              label="Tools"
              hint="Tools it should keep close."
              options={catalog.tools}
              selected={tools}
              onToggle={toggleIn(setTools)}
              empty="No tools to pick from yet."
            />
          )}
          {models && (
            <Field label="Model" hint="Leave on the brain unless this agent needs a particular model.">
              {(id) => (
                <Select id={id} value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value={FOLLOW_BRAIN}>Follow the brain</option>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  {staleModel && <option value={staleModel}>{staleModel} (no longer offered)</option>}
                </Select>
              )}
            </Field>
          )}

          {error && <p className="text-body text-danger" role="alert">{error}</p>}
        </fieldset>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="secondary" size="sm" onClick={close} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={saving}>{saving ? 'Saving…' : mode === 'create' ? 'Create agent' : 'Save changes'}</Button>
        </footer>
      </div>
    </div>
  );
}

/** A labeled wrap of toggle chips backed by a Set. Each option shows its
 *  name; the description is a tooltip. */
function ChipPicker({
  label,
  hint,
  options,
  selected,
  onToggle,
  empty,
}: {
  label: string;
  hint: string;
  options: Array<{ name: string; description: string }>;
  selected: Set<string>;
  onToggle: (name: string) => void;
  empty: string;
}) {
  return (
    <div className="mb-4">
      <div className="mb-1 text-label text-fg">{label}</div>
      {options.length === 0 ? (
        <p className="text-caption text-muted">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {options.map((opt) => {
            const on = selected.has(opt.name);
            return (
              <button
                key={opt.name}
                type="button"
                title={opt.description}
                aria-pressed={on}
                onClick={() => onToggle(opt.name)}
                className={
                  'rounded-full border px-2.5 py-1 text-caption transition-colors cursor-pointer ' +
                  (on ? 'border-primary bg-primary-tint text-primary' : 'border-border bg-surface text-muted hover:border-border-strong')
                }
              >
                {opt.name}
              </button>
            );
          })}
        </div>
      )}
      <p className="mt-1 text-caption text-muted">{hint}</p>
    </div>
  );
}
