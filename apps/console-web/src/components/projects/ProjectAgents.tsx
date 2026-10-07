/**
 * The agents assigned to a project, each with what it answers for here.
 *
 * An assignment is one agent in one project: its responsibility, context
 * that applies only in this project, the skills it reaches for here, and
 * whether what it learns here may be used in its other projects. The agent
 * itself (its name, standing instructions, model) is edited on its own page.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Select, Textarea } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';
import { Switch } from '@/components/ui/Switch';
import { getAgentCatalog, listAgents, type AgentRecord, type CatalogEntry } from '@/lib/agents';
import { usePoll } from '@/lib/poll';
import { usePendingCommit } from '@/lib/pending-commit';
import {
  refusalText, removeAssignment, saveAssignment,
  type AssignmentInput, type ProjectAssignmentView, type ProjectOverview,
} from '@/lib/projects';
import { ProjectSection, QuietNote } from './ProjectSection';

const SHARE_LABEL = 'Let it reuse what it learns here in its other projects';
const SHARE_HINT_OFF = 'Off: what it learns in this project stays in this project.';
const SHARE_HINT_ON = 'On: ways of working it picks up here can help it elsewhere. Facts about this project still stay here.';

function AssignmentFields({
  agentName,
  skillOptions,
  initial,
  saving,
  error,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  agentName: string;
  skillOptions: CatalogEntry[];
  initial: Required<AssignmentInput>;
  saving: boolean;
  error: string;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (input: Required<AssignmentInput>) => void;
}) {
  const [responsibility, setResponsibility] = useState(initial.responsibility);
  const [context, setContext] = useState(initial.context);
  const [skills, setSkills] = useState<Set<string>>(new Set(initial.skills));
  const [shareMethods, setShareMethods] = useState(initial.shareMethods);
  const skillsId = useId();
  // A skill the assignment names but the catalog no longer lists still
  // shows, so saving something else does not silently drop it.
  const options = [
    ...skillOptions,
    ...initial.skills.filter((name) => !skillOptions.some((option) => option.name === name)).map((name) => ({ name, description: 'No longer installed' })),
  ];
  const toggle = (name: string) => setSkills((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  return (
    <form
      className="mt-3 border-t border-border pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (saving) return;
        onSubmit({ responsibility: responsibility.trim(), context: context.trim(), skills: Array.from(skills), shareMethods });
      }}
      onKeyDown={(event) => { if (event.key === 'Escape' && !saving) { event.stopPropagation(); onCancel(); } }}
    >
      <fieldset disabled={saving} aria-busy={saving} className="m-0 min-w-0 border-0 p-0">
      <Field label={`What ${agentName} answers for here`} hint="One or two sentences. Clem uses this to decide who a task in this project goes to.">
        {(id) => (
          <Textarea
            id={id}
            value={responsibility}
            onChange={(event) => setResponsibility(event.target.value)}
            maxLength={1000}
            placeholder="The weekly briefing and every follow-up it calls for."
            className="min-h-[72px]"
            autoFocus
          />
        )}
      </Field>
      <Field label="Context for this project only" hint={`What ${agentName} should know here and nowhere else.`}>
        {(id) => (
          <Textarea id={id} value={context} onChange={(event) => setContext(event.target.value)} maxLength={8000} className="min-h-[72px]" />
        )}
      </Field>
      {options.length > 0 && (
        <div className="mb-4">
          <div className="mb-1.5 text-label text-fg" id={skillsId}>Skills it reaches for here</div>
          <div role="group" aria-labelledby={skillsId} className="flex flex-wrap gap-1.5">
            {options.map((option) => {
              const on = skills.has(option.name);
              return (
                <button
                  key={option.name}
                  type="button"
                  title={option.description}
                  aria-pressed={on}
                  onClick={() => toggle(option.name)}
                  className={
                    'rounded-full border px-2.5 py-1 text-caption transition-colors cursor-pointer '
                    + (on ? 'border-primary bg-primary-tint text-primary' : 'border-border bg-surface text-muted hover:border-border-strong')
                  }
                >
                  {option.name}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-caption text-muted">Beside the skills it always has.</p>
        </div>
      )}
      <div className="mb-4 flex items-start gap-3">
        <Switch checked={shareMethods} onChange={setShareMethods} label={SHARE_LABEL} disabled={saving} />
        <div className="min-w-0">
          <div className="text-small font-semibold text-fg">{SHARE_LABEL}</div>
          <p className="text-caption text-muted">{shareMethods ? SHARE_HINT_ON : SHARE_HINT_OFF}</p>
        </div>
      </div>
      </fieldset>
      {error && <p role="alert" className="mb-3 text-small text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : submitLabel}</Button>
      </div>
    </form>
  );
}

function AssignmentRow({ projectId, assignment, skillOptions, readOnly, onSaved }: {
  projectId: string;
  assignment: ProjectAssignmentView;
  skillOptions: CatalogEntry[];
  readOnly: boolean;
  onSaved: (overview: ProjectOverview) => void;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'remove'>('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const commit = usePendingCommit(`${projectId}:${assignment.agentId}`);

  const run = async (call: () => Promise<ProjectOverview>, fallback: string) => {
    const token = commit.begin();
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      const saved = await call();
      if (!commit.owns(token)) return;
      onSaved(saved);
      setMode('view');
    } catch (failure) {
      if (commit.owns(token)) setError(refusalText(failure, fallback));
    } finally {
      if (commit.finish(token)) setBusy(false);
    }
  };

  return (
    <li className="border-t border-border px-5 py-4 first:border-t-0">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {assignment.available ? (
              <Link to={`/agents/${encodeURIComponent(assignment.agentId)}`} className="truncate text-body font-semibold text-fg hover:text-primary hover:underline">
                {assignment.agentName}
              </Link>
            ) : (
              <span className="truncate text-body font-semibold text-muted">{assignment.agentName}</span>
            )}
            {!assignment.available && <StatusPill tone="warning">No longer available</StatusPill>}
          </div>
          {assignment.available ? (
            <p className="mt-0.5 text-body text-muted">
              {assignment.responsibility || <span className="text-faint">Nothing written yet about what it answers for here.</span>}
            </p>
          ) : (
            <p className="mt-0.5 text-small text-muted">This agent was deleted or replaced, so it takes no work here. Remove it, or assign the agent you want instead.</p>
          )}
          {assignment.available && mode === 'view' && (
            <p className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 text-caption text-faint">
              {assignment.skills.length > 0 && <span>Skills here: {assignment.skills.join(', ')}</span>}
              {assignment.context && <span>Has context for this project only</span>}
              <span>{assignment.shareMethods ? 'May reuse what it learns here elsewhere' : 'What it learns here stays here'}</span>
            </p>
          )}
        </div>
        {!readOnly && mode === 'view' && (
          <div className="flex shrink-0 items-center gap-1">
            {assignment.available && (
              <Button variant="ghost" size="sm" onClick={() => { setError(''); setMode('edit'); }} aria-label={`Edit what ${assignment.agentName} does here`}>
                <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => { setError(''); setMode('remove'); }} aria-label={`Remove ${assignment.agentName} from this project`}>
              Remove
            </Button>
          </div>
        )}
      </div>

      {mode === 'edit' && (
        <AssignmentFields
          agentName={assignment.agentName}
          skillOptions={skillOptions}
          initial={{
            responsibility: assignment.responsibility,
            context: assignment.context,
            skills: assignment.skills,
            shareMethods: assignment.shareMethods,
          }}
          saving={busy}
          error={error}
          submitLabel="Save"
          onCancel={() => { if (!commit.pending) setMode('view'); }}
          onSubmit={(input) => { void run(() => saveAssignment(projectId, assignment.agentId, input), 'Your changes were not saved. Try again.'); }}
        />
      )}

      {mode === 'remove' && (
        <div className="mt-3 rounded-md border border-border bg-subtle px-3 py-2.5" role="group" aria-label={`Confirm removing ${assignment.agentName}`}>
          <p className="text-small text-fg">
            Remove {assignment.agentName} from this project? The agent itself is kept, and so is the work it already did here.
          </p>
          {error && <p role="alert" className="mt-1 text-caption text-danger">{error}</p>}
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="danger" disabled={busy} onClick={() => { void run(() => removeAssignment(projectId, assignment.agentId), 'It could not be removed. Try again.'); }}>
              {busy ? 'Removing…' : 'Remove'}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setMode('view')}>Keep</Button>
          </div>
        </div>
      )}
    </li>
  );
}

function AssignAgent({ projectId, candidates, skillOptions, onSaved, onClose }: {
  projectId: string;
  candidates: AgentRecord[];
  skillOptions: CatalogEntry[];
  onSaved: (overview: ProjectOverview) => void;
  onClose: () => void;
}) {
  const [agentId, setAgentId] = useState(candidates[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const commit = usePendingCommit(`${projectId}:${agentId}`);
  const agent = candidates.find((candidate) => candidate.id === agentId);

  const assign = async (input: Required<AssignmentInput>) => {
    if (!agent) { setError('Choose an agent first.'); return; }
    const token = commit.begin();
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      const saved = await saveAssignment(projectId, agent.id, input);
      if (!commit.owns(token)) return;
      onSaved(saved);
      onClose();
    } catch (failure) {
      if (commit.owns(token)) setError(refusalText(failure, 'The agent could not be assigned. Try again.'));
    } finally {
      if (commit.finish(token)) setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-surface px-5 py-4">
      <Field label="Agent">
        {(id) => (
          <Select id={id} value={agentId} onChange={(event) => setAgentId(event.target.value)} disabled={busy}>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}{candidate.handles ? ` — ${candidate.handles}` : ''}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {agent && (
        <AssignmentFields
          // A different agent starts from a clean form.
          key={agent.id}
          agentName={agent.name}
          skillOptions={skillOptions}
          initial={{ responsibility: '', context: '', skills: [], shareMethods: false }}
          saving={busy}
          error={error}
          submitLabel="Assign"
          onCancel={() => { if (!commit.pending) onClose(); }}
          onSubmit={(input) => { void assign(input); }}
        />
      )}
    </div>
  );
}

export function ProjectAgents({ overview, onSaved }: {
  overview: ProjectOverview;
  onSaved: (overview: ProjectOverview) => void;
}) {
  const archived = overview.project.status === 'archived';
  const [assigning, setAssigning] = useState(false);
  const roster = usePoll(['agents'], listAgents, 30_000);
  const catalog = usePoll(['agents', 'catalog'], getAgentCatalog, 60_000);
  const skillOptions = catalog.data?.skills ?? [];
  // An agent whose assignment went stale can be assigned again: it is the
  // record under that name now.
  const taken = new Set(overview.agents.filter((row) => row.available).map((row) => row.agentId));
  const candidates = (roster.data ?? []).filter((agent) => !taken.has(agent.id));

  return (
    <ProjectSection
      title="Agents"
      hint="Who works on this project, and what each one answers for in it."
      action={!archived && !assigning && candidates.length > 0 && (
        <Button variant="secondary" size="sm" onClick={() => setAssigning(true)}>
          <Plus className="h-4 w-4" aria-hidden /> Assign an agent
        </Button>
      )}
    >
      {overview.agents.length === 0 && !assigning ? (
        <QuietNote>
          {roster.data && roster.data.length === 0
            ? <>No agents yet. <Link to="/agents" className="font-semibold text-primary hover:underline">Create one</Link>, then assign it here. Until then Clem does the work herself.</>
            : 'No agents assigned. Clem does the work in this project herself.'}
        </QuietNote>
      ) : overview.agents.length > 0 ? (
        <ul className="overflow-hidden rounded-lg border border-border bg-surface">
          {overview.agents.map((assignment) => (
            <AssignmentRow
              key={assignment.agentId}
              projectId={overview.project.id}
              assignment={assignment}
              skillOptions={skillOptions}
              readOnly={archived}
              onSaved={onSaved}
            />
          ))}
        </ul>
      ) : null}

      {assigning && (
        <AssignAgent
          projectId={overview.project.id}
          candidates={candidates}
          skillOptions={skillOptions}
          onSaved={onSaved}
          onClose={() => setAssigning(false)}
        />
      )}
    </ProjectSection>
  );
}
