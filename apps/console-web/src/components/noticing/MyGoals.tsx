/**
 * Your goals — the persistent goals Clementine works toward, with progress,
 * next actions, blockers, and what she has proposed for each. Edited here or
 * in chat (goal_upsert); both write the same records. Rides at the top of
 * the Goals screen, above the runs' own objectives.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Target } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Field';
import { StatusPill, Tag, type Tone } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import { DECISION_WORDS, listMyGoals, progressWords, upsertMyGoal, type MyGoal, type MyGoalPatch } from '@/lib/noticing';

const STATUS: Record<MyGoal['status'], { tone: Tone; label: string }> = {
  active: { tone: 'live', label: 'Active' },
  blocked: { tone: 'warning', label: 'Blocked' },
  paused: { tone: 'neutral', label: 'Paused' },
  completed: { tone: 'success', label: 'Done' },
};

function ago(iso?: string): string {
  if (!iso) return '';
  const d = Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(d)) return '';
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}

function GoalCard({ goal, onSaved }: { goal: MyGoal; onSaved: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState<'next' | 'blockers' | null>(null);
  const [draft, setDraft] = useState('');
  const save = async (what: string, patch: MyGoalPatch) => {
    setBusy(what); setError(null);
    try { await upsertMyGoal({ id: goal.id, ...patch }); onSaved(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const status = STATUS[goal.status];
  return (
    <Card className="min-w-0 p-4" data-testid={`my-goal-${goal.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-h3 text-fg">{goal.title}</h3>
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
            <Tag>{goal.priority}</Tag>
            {goal.targetDate ? <Tag>by {goal.targetDate}</Tag> : null}
          </div>
          <p className="mt-1 text-small text-muted">{goal.description}</p>
          <p className="mt-1 text-caption text-faint">{progressWords(goal)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <select
            aria-label={`${goal.title} status`}
            className="rounded-md border border-border bg-canvas px-2 py-1 text-small text-fg"
            value={goal.status}
            disabled={busy !== null}
            onChange={(e) => { void save('status', { status: e.target.value as MyGoal['status'] }); }}
          >
            <option value="active">Active</option>
            <option value="blocked">Blocked</option>
            <option value="paused">Paused</option>
            <option value="completed">Done</option>
          </select>
          <select
            aria-label={`${goal.title} priority`}
            className="rounded-md border border-border bg-canvas px-2 py-1 text-small text-fg"
            value={goal.priority}
            disabled={busy !== null}
            onChange={(e) => { void save('priority', { priority: e.target.value as MyGoal['priority'] }); }}
          >
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>

      <div className="mt-3 grid gap-4 md:grid-cols-3">
        <section>
          <div className="mb-1 flex items-center justify-between text-label text-fg">
            Next actions
            <button type="button" className="text-caption text-primary cursor-pointer" onClick={() => { setEditing(editing === 'next' ? null : 'next'); setDraft(goal.nextActions.join('\n')); }}>{editing === 'next' ? 'Cancel' : 'Edit'}</button>
          </div>
          {editing === 'next' ? (
            <div className="space-y-1">
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} aria-label={`${goal.title} next actions`} placeholder="One per line" />
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => { void save('next', { nextActions: draft.split('\n').map((l) => l.trim()).filter(Boolean) }).then(() => setEditing(null)); }}>Save</Button>
            </div>
          ) : goal.nextActions.length === 0 ? <p className="text-small text-muted">None listed.</p> : (
            <ul className="space-y-1 text-small text-fg">{goal.nextActions.map((a, i) => <li key={i}>• {a}</li>)}</ul>
          )}
        </section>
        <section>
          <div className="mb-1 flex items-center justify-between text-label text-fg">
            Blockers
            <button type="button" className="text-caption text-primary cursor-pointer" onClick={() => { setEditing(editing === 'blockers' ? null : 'blockers'); setDraft(goal.blockers.join('\n')); }}>{editing === 'blockers' ? 'Cancel' : 'Edit'}</button>
          </div>
          {editing === 'blockers' ? (
            <div className="space-y-1">
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} aria-label={`${goal.title} blockers`} placeholder="One per line" />
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => { void save('blockers', { blockers: draft.split('\n').map((l) => l.trim()).filter(Boolean) }).then(() => setEditing(null)); }}>Save</Button>
            </div>
          ) : goal.blockers.length === 0 ? <p className="text-small text-muted">None.</p> : (
            <ul className="space-y-1 text-small text-fg">{goal.blockers.map((b, i) => <li key={i}>• {b}</li>)}</ul>
          )}
        </section>
        <section>
          <div className="mb-1 text-label text-fg">Progress</div>
          {goal.progressNotes.length === 0 ? <p className="text-small text-muted">No notes yet.</p> : (
            <ul className="space-y-1 text-small text-fg">{goal.progressNotes.slice(-3).reverse().map((n, i) => <li key={i} className="text-muted">{n}</li>)}</ul>
          )}
          <div className="mt-2 flex items-center gap-2">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a progress note" aria-label={`${goal.title} progress note`} disabled={busy !== null}
              onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) { e.preventDefault(); void save('note', { progressNote: note.trim() }).then(() => setNote('')); } }} />
            <Button size="sm" variant="secondary" disabled={busy !== null || !note.trim()} onClick={() => { void save('note', { progressNote: note.trim() }).then(() => setNote('')); }} aria-label="Add note">
              {busy === 'note' ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Plus size={16} aria-hidden />}
            </Button>
          </div>
        </section>
      </div>

      <section className="mt-3">
        <div className="mb-1 text-label text-fg">What Clementine proposed for this</div>
        {goal.proposals.length === 0 ? <p className="text-small text-muted">Nothing yet — Noticing proposes against your goals on its cadence.</p> : (
          <ul className="space-y-1.5">
            {goal.proposals.slice(0, 5).map((p) => (
              <li key={p.id} className="rounded-md border border-border bg-surface px-3 py-2 text-small">
                <span className="font-medium text-fg">{p.title}</span>
                <span className="block text-caption text-faint">{ago(p.createdAt)} · {p.answer ? `${DECISION_WORDS[p.answer.decision]}${p.answer.text ? ` — “${p.answer.text}”` : ''}` : p.status === 'open' ? 'Waiting for your answer in Needs You' : p.status}</span>
                <p className="mt-0.5 text-caption text-muted">{p.why}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      {error ? <p className="mt-2 text-caption text-danger">{error}</p> : null}
    </Card>
  );
}

export function MyGoals() {
  const qc = useQueryClient();
  const q = usePoll(['my-goals'], listMyGoals, 30_000);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['my-goals'] }); void qc.invalidateQueries({ queryKey: ['noticing'] }); };
  const goals = q.data?.goals ?? [];
  const create = async () => {
    setBusy(true); setError(null);
    try { await upsertMyGoal({ title: title.trim(), description: description.trim() }); setTitle(''); setDescription(''); setAdding(false); refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <section className="min-w-0" data-testid="my-goals">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Target className="h-5 w-5 text-primary" aria-hidden />
            <h3 className="text-title-sm font-semibold text-fg">Your goals</h3>
          </div>
          <p className="mt-1 text-small text-muted">Clem reads these when she notices things and proposes against them. Tell her in chat or edit here; both write the same goal.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setAdding((v) => !v)}><Plus size={16} aria-hidden /> {adding ? 'Cancel' : 'Add a goal'}</Button>
      </div>
      {adding ? (
        <Card className="mt-3 p-4">
          <div className="grid gap-2">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The goal, in one line — e.g. My team books 10 appointments a week" aria-label="New goal title" />
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="What done looks like, how you will know, and anything Clem should know" aria-label="New goal description" />
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={busy || !title.trim() || !description.trim()} onClick={() => { void create(); }}>{busy ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null} Save goal</Button>
              {error ? <span className="text-caption text-danger">{error}</span> : null}
            </div>
          </div>
        </Card>
      ) : null}
      <div className="mt-3 grid gap-3">
        {q.isLoading && goals.length === 0 ? <p className="text-small text-muted">Loading…</p>
          : goals.length === 0 ? <p className="text-small text-muted">No goals yet. A goal is what Clem anchors her work to and reports against: one line with a number in it reads best, such as “My team books 10 appointments a week.” Add one here, or tell Clem in chat.</p>
          : goals.map((g) => <GoalCard key={g.id} goal={g} onSaved={refresh} />)}
      </div>
    </section>
  );
}
