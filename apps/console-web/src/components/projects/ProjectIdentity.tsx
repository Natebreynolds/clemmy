/**
 * What the project is: its name, what it is for, what it should achieve and
 * the standing context work inside it shares. Read first, edited in place;
 * a save shows the record the server answered with.
 */
import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import {
  goalsFromText, goalsToText, refusalText, updateProject, type ProjectInput, type ProjectOverview,
} from '@/lib/projects';
import { ProjectSection } from './ProjectSection';

const CONTEXT_FOLD = 420;

export function ProjectIdentity({ overview, onSaved }: {
  overview: ProjectOverview;
  onSaved: (overview: ProjectOverview) => void;
}) {
  const { project } = overview;
  const archived = project.status === 'archived';
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [name, setName] = useState(project.name);
  const [purpose, setPurpose] = useState(project.purpose);
  const [goals, setGoals] = useState(goalsToText(project.goals));
  const [context, setContext] = useState(project.context);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const open = () => {
    setName(project.name);
    setPurpose(project.purpose);
    setGoals(goalsToText(project.goals));
    setContext(project.context);
    setError('');
    setEditing(true);
  };

  const save = async () => {
    if (!name.trim()) { setError('Give the project a name.'); return; }
    // Only what changed is sent, so an edit made elsewhere to another field
    // is not written over by what this form happened to be showing.
    const goalList = goalsFromText(goals);
    const patch: ProjectInput = {
      ...(name.trim() !== project.name ? { name: name.trim() } : {}),
      ...(purpose.trim() !== project.purpose ? { purpose: purpose.trim() } : {}),
      ...(goalList.join('\n') !== project.goals.join('\n') ? { goals: goalList } : {}),
      ...(context.trim() !== project.context ? { context: context.trim() } : {}),
    };
    if (Object.keys(patch).length === 0) { setEditing(false); return; }
    setSaving(true);
    setError('');
    try {
      onSaved(await updateProject(project.id, patch));
      setEditing(false);
    } catch (failure) {
      setError(refusalText(failure, 'Your changes were not saved. Try again.'));
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <ProjectSection title="What it is">
        <form
          className="rounded-lg border border-border bg-surface px-5 py-4"
          onSubmit={(event) => { event.preventDefault(); void save(); }}
          onKeyDown={(event) => { if (event.key === 'Escape' && !saving) { event.stopPropagation(); setEditing(false); } }}
        >
          <Field label="Name">
            {(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus />}
          </Field>
          <Field label="What it is for">
            {(id) => <Textarea id={id} value={purpose} onChange={(event) => setPurpose(event.target.value)} maxLength={2000} />}
          </Field>
          <Field label="Goals" hint="One to a line.">
            {(id) => <Textarea id={id} value={goals} onChange={(event) => setGoals(event.target.value)} />}
          </Field>
          <Field
            label="Standing context"
            hint="What everyone working in this project should already know: its terms, where things stand, what has been decided."
          >
            {(id) => <Textarea id={id} value={context} onChange={(event) => setContext(event.target.value)} maxLength={8000} className="min-h-[140px]" />}
          </Field>
          {error && <p role="alert" className="mb-3 text-small text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => setEditing(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={saving || !name.trim()}>{saving ? 'Saving…' : 'Save'}</Button>
          </div>
        </form>
      </ProjectSection>
    );
  }

  const longContext = project.context.length > CONTEXT_FOLD;
  return (
    <ProjectSection
      title="What it is"
      action={!archived && (
        <Button variant="ghost" size="sm" onClick={open} aria-label={`Edit what ${project.name} is`}>
          <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
        </Button>
      )}
    >
      <div className="rounded-lg border border-border bg-surface px-5 py-4">
        {project.purpose
          ? <p className="reading whitespace-pre-wrap text-body-lg text-fg">{project.purpose}</p>
          : <p className="text-body text-faint">No purpose written yet.{!archived && ' Say what this project is for, so everyone working in it starts from the same place.'}</p>}

        {project.goals.length > 0 && (
          <div className="mt-4">
            <div className="text-label text-faint">Goals</div>
            <ul className="mt-1.5 space-y-1">
              {project.goals.map((goal) => (
                <li key={goal} className="flex gap-2 text-body text-fg">
                  <span className="mt-[0.6em] h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                  <span className="min-w-0">{goal}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {project.context && (
          <div className="mt-4">
            <div className="text-label text-faint">Standing context</div>
            <p className={`reading mt-1.5 whitespace-pre-wrap text-body text-muted ${longContext && !showAll ? 'line-clamp-5' : ''}`}>
              {project.context}
            </p>
            {longContext && (
              <button
                type="button"
                onClick={() => setShowAll((value) => !value)}
                aria-expanded={showAll}
                className="mt-1 text-caption font-semibold text-primary hover:underline cursor-pointer"
              >
                {showAll ? 'Show less' : 'Show all'}
              </button>
            )}
          </div>
        )}
      </div>
    </ProjectSection>
  );
}
