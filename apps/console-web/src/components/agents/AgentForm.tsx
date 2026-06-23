/**
 * Create / edit a team agent (multi-agent workspace, slice 2). A centered
 * modal over the agent stores. canMessage is edited as checkboxes of the
 * other agents; persona/role/model/cadence are plain fields. On save it
 * POSTs (create) or PATCHes (edit) and invalidates the agents queries.
 */
import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { Switch } from '@/components/ui/Switch';
import { createAgent, updateAgent, type AgentInput, type AgentSummary, type AgentCatalog } from '@/lib/agents';

export function AgentForm({
  mode,
  agent,
  allAgents,
  catalog,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  agent?: AgentSummary;
  allAgents: AgentSummary[];
  catalog?: AgentCatalog;
  onClose: () => void;
  onSaved: (saved: AgentSummary) => void;
}) {
  const [name, setName] = useState(agent?.name ?? '');
  const [role, setRole] = useState(agent?.role ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [personality, setPersonality] = useState(agent?.personality ?? '');
  const [model, setModel] = useState(agent?.model ?? '');
  const [canMessage, setCanMessage] = useState<Set<string>>(new Set(agent?.canMessage ?? []));
  const [skills, setSkills] = useState<Set<string>>(new Set(agent?.skills ?? []));
  const [workflows, setWorkflows] = useState<Set<string>>(new Set(agent?.workflows ?? []));
  const [proactive, setProactive] = useState(agent?.proactive ?? true);
  const [cadence, setCadence] = useState(String(agent?.cadenceMinutes ?? 30));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edit can't message itself; create can target any existing agent.
  const targets = allAgents.filter((a) => a.slug !== agent?.slug);

  const toggleIn = (setter: typeof setCanMessage) => (value: string) =>
    setter((prev) => {
      const next = new Set(prev);
      next.has(value) ? next.delete(value) : next.add(value);
      return next;
    });
  const toggleTarget = toggleIn(setCanMessage);

  const submit = async () => {
    if (!name.trim()) { setError('Name is required.'); return; }
    setSaving(true); setError(null);
    const input: AgentInput = {
      name: name.trim(),
      description: description.trim(),
      role: role.trim() || undefined,
      personality: personality.trim() || undefined,
      model: model.trim() || undefined,
      canMessage: Array.from(canMessage),
      skills: Array.from(skills),
      workflows: Array.from(workflows),
      proactive,
      cadenceMinutes: Math.max(5, Number(cadence) || 30),
    };
    try {
      const saved = mode === 'create' ? await createAgent(input) : await updateAgent(agent!.slug, input);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`${mode === 'create' ? 'New' : 'Edit'} agent`}>
      <div className="absolute inset-0 bg-black/30 animate-fade-in" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-lg animate-fade-in">
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h3 className="text-h3 text-fg">{mode === 'create' ? 'New agent' : `Edit ${agent?.name}`}</h3>
          <button onClick={onClose} className="rounded-sm p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <Field label="Name">
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Researcher" autoFocus />}
          </Field>
          <Field label="Role" hint="Short label, e.g. research, writing, analysis.">
            {(id) => <Input id={id} value={role} onChange={(e) => setRole(e.target.value)} placeholder="research" />}
          </Field>
          <Field label="Mission" hint="One line: what this agent is for.">
            {(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Gathers facts before decisions" />}
          </Field>
          <Field label="Persona & guidance" hint="How the agent should behave — its system instructions.">
            {(id) => <Textarea id={id} value={personality} onChange={(e) => setPersonality(e.target.value)} placeholder="You are a meticulous researcher…" />}
          </Field>
          <Field label="Model" hint="Optional model override (blank = follows the brain).">
            {(id) => <Input id={id} value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-sonnet-4-6" />}
          </Field>

          <div className="mb-4">
            <div className="mb-1.5 text-label text-fg">Can message</div>
            {targets.length === 0 ? (
              <p className="text-caption text-muted">No other agents to message yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {targets.map((t) => {
                  const on = canMessage.has(t.slug);
                  return (
                    <button
                      key={t.slug}
                      type="button"
                      onClick={() => toggleTarget(t.slug)}
                      className={
                        'rounded-full border px-2.5 py-1 text-caption transition-colors cursor-pointer ' +
                        (on ? 'border-primary bg-primary-tint text-primary' : 'border-border bg-surface text-muted hover:border-border-strong')
                      }
                    >
                      {t.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <ChipPicker
            label="Skills"
            hint="Their SKILL.md is injected into this agent's instructions so it boots knowing the craft."
            options={catalog?.skills ?? []}
            selected={skills}
            onToggle={toggleIn(setSkills)}
            empty="No skills installed yet."
          />
          <ChipPicker
            label="Workflows"
            hint="Workflows this agent owns — it prefers running these over redoing the work ad-hoc."
            options={catalog?.workflows ?? []}
            selected={workflows}
            onToggle={toggleIn(setWorkflows)}
            empty="No workflows saved yet."
          />

          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <div className="text-label text-fg">Proactive</div>
              <p className="text-caption text-muted">Wake on a cadence and take initiative.</p>
            </div>
            <Switch checked={proactive} onChange={setProactive} label="Proactive" />
          </div>
          {proactive && (
            <Field label="Cadence (minutes)" hint="How often it wakes. Minimum 5.">
              {(id) => <Input id={id} type="number" min={5} value={cadence} onChange={(e) => setCadence(e.target.value)} />}
            </Field>
          )}

          {error && <p className="text-body text-danger">{error}</p>}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={saving}>{saving ? 'Saving…' : mode === 'create' ? 'Create agent' : 'Save changes'}</Button>
        </footer>
      </div>
    </div>
  );
}

/** A labeled wrap of toggle chips backed by a Set — used for skills +
 *  workflows. Each option shows its name; the description is a tooltip. */
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
