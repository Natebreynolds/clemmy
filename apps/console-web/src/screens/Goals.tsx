import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2, CirclePause, ClipboardCheck, Goal as GoalIcon, Loader2, Pause, Play, RefreshCw,
  RotateCw, SlidersHorizontal, Sparkles, Timer, Trash2, XCircle,
} from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import {
  createGoal, createGoalFromDraft, dismissGoalDraft, draftGoal, expireGoal, listGoalDrafts, listGoals, parkGoal, satisfyGoal, setGoalSelfDrive, unparkGoal,
  type GoalDraftRecord, type GoalFilter, type GoalSummary,
} from '@/lib/goals';

const FILTERS: Array<{ id: GoalFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'self_driving', label: 'Self-driving' },
  { id: 'parked', label: 'Needs you' },
  { id: 'terminal', label: 'Done' },
];

function toneForGoal(goal: GoalSummary): { tone: Tone; label: string } {
  if (goal.status === 'satisfied') return { tone: 'success', label: 'Satisfied' };
  if (goal.status === 'expired') return { tone: 'neutral', label: 'Stopped' };
  if (goal.parked) return { tone: 'warning', label: 'Needs you' };
  if (goal.selfDriving) return { tone: 'live', label: 'Self-driving' };
  return { tone: 'info', label: 'Active' };
}

function shortDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function cadence(ms: number | null): string {
  if (!ms) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: Tone }) {
  return (
    <Card className="min-w-0 p-4">
      <div className="text-caption font-semibold uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-title font-semibold text-fg">{value}</div>
        <StatusPill tone={tone} className="shrink-0">{label}</StatusPill>
      </div>
    </Card>
  );
}

function GoalCard({
  goal,
  busy,
  onAction,
}: {
  goal: GoalSummary;
  busy: boolean;
  onAction: (goal: GoalSummary, action: 'enable' | 'disable' | 'park' | 'unpark' | 'satisfy' | 'expire') => void;
}) {
  const tone = toneForGoal(goal);
  const stagePct = goal.stageProgress ? percent(goal.stageProgress.done, goal.stageProgress.total) : 0;
  const latestLedger = goal.progressLedger.slice(-3);
  const latestEvidence = goal.evidenceSummary.latest.slice(-3);

  return (
    <Card className="min-w-0 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={tone.tone}>{tone.label}</StatusPill>
            {goal.origin?.kind === 'workflow' && <StatusPill tone="neutral">Workflow</StatusPill>}
            {goal.parked && <StatusPill tone="warning">{goal.parked.reason.replace(/_/g, ' ')}</StatusPill>}
          </div>
          <h3 className="mt-3 text-title-sm font-semibold text-fg">{goal.objective}</h3>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted">
            <span>Updated {shortDate(goal.updatedAt)}</span>
            {goal.nextResumeAt && <span>Next resume {shortDate(goal.nextResumeAt)}</span>}
            {goal.resumeEveryMs && <span>Cadence {cadence(goal.resumeEveryMs)}</span>}
            {goal.deadlineAt && <span>Deadline {shortDate(goal.deadlineAt)}</span>}
          </div>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
          {goal.status === 'active' && (
            <>
              {goal.selfDriving ? (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => onAction(goal, 'disable')}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CirclePause className="h-4 w-4" aria-hidden />} Hold
                </Button>
              ) : (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => onAction(goal, 'enable')}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCw className="h-4 w-4" aria-hidden />} Self-drive
                </Button>
              )}
              {goal.parked ? (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => onAction(goal, 'unpark')}>
                  <Play className="h-4 w-4" aria-hidden /> Resume
                </Button>
              ) : (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => onAction(goal, 'park')}>
                  <Pause className="h-4 w-4" aria-hidden /> Pause
                </Button>
              )}
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => onAction(goal, 'satisfy')}>
                <CheckCircle2 className="h-4 w-4" aria-hidden /> Done
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAction(goal, 'expire')}>
                <XCircle className="h-4 w-4" aria-hidden /> Stop
              </Button>
            </>
          )}
        </div>
      </div>

      {goal.stageProgress && (
        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between text-caption text-muted">
            <span>{goal.currentStage ? goal.currentStage.title : 'Stages complete'}</span>
            <span>{goal.stageProgress.done}/{goal.stageProgress.total}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-subtle">
            <div className="h-full rounded-full bg-primary" style={{ width: `${stagePct}%` }} />
          </div>
        </div>
      )}

      <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-3">
        <div className="min-w-0">
          <div className="text-caption font-semibold uppercase tracking-wide text-faint">Criteria</div>
          <ul className="mt-2 space-y-1 break-words text-small text-muted">
            {goal.successCriteria.slice(0, 4).map((item) => <li key={item}>- {item}</li>)}
            {goal.successCriteria.length === 0 && <li>No criteria pinned</li>}
          </ul>
        </div>
        <div className="min-w-0">
          <div className="text-caption font-semibold uppercase tracking-wide text-faint">Progress</div>
          <ul className="mt-2 space-y-1 break-words text-small text-muted">
            {latestLedger.map((item) => <li key={item}>- {item}</li>)}
            {latestLedger.length === 0 && <li>No ledger entries yet</li>}
          </ul>
        </div>
        <div className="min-w-0">
          <div className="text-caption font-semibold uppercase tracking-wide text-faint">Evidence</div>
          <ul className="mt-2 space-y-1 break-words text-small text-muted">
            {latestEvidence.map((item) => (
              <li key={`${item.at}-${item.criterion}`} className={item.pass ? 'text-success' : 'text-warning'}>
                - {item.pass ? 'Pass' : 'Open'}: {item.criterion}
              </li>
            ))}
            {latestEvidence.length === 0 && <li>{goal.evidenceSummary.total} validation records</li>}
          </ul>
        </div>
      </div>

      {goal.parked?.note && (
        <div className="mt-4 rounded-md border border-warning/30 bg-warning-tint px-3 py-2 text-small text-warning">
          {goal.parked.note}
        </div>
      )}
      {goal.doneReason && goal.status !== 'active' && (
        <div className="mt-4 rounded-md border border-border bg-subtle px-3 py-2 text-small text-muted">
          {goal.doneReason}
        </div>
      )}
    </Card>
  );
}

export function Goals() {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const [filter, setFilter] = useState<GoalFilter>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftNotes, setDraftNotes] = useState('');
  const [appliedDraftId, setAppliedDraftId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draftReview, setDraftReview] = useState<{
    confidence: 'low' | 'medium' | 'high';
    missingInputs: string[];
  } | null>(null);
  const [form, setForm] = useState({
    objective: '',
    successCriteria: '',
    nextActions: '',
    risks: '',
    selfDriving: false,
    resumeEveryMinutes: 30,
    maxResumes: 12,
    maxAttempts: 3,
    deadlineAt: '',
  });

  const goalsQ = usePoll(['goals', filter], () => listGoals(filter), 5000);
  const draftsQ = usePoll(['goal-drafts'], () => listGoalDrafts('pending'), 8000);
  const payload = goalsQ.data;
  const goals = useMemo(() => payload?.goals ?? [], [payload]);
  const goalDrafts = useMemo(() => draftsQ.data?.drafts ?? [], [draftsQ.data]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['goals'] });
    void qc.invalidateQueries({ queryKey: ['goal-drafts'] });
  };

  const applyDraft = (record: GoalDraftRecord) => {
    setError(null);
    setAppliedDraftId(record.id);
    setDraftNotes(record.notes);
    setForm((prev) => ({
      ...prev,
      objective: record.draft.objective,
      successCriteria: record.draft.successCriteria.join('\n'),
      nextActions: record.draft.nextActions.join('\n'),
      risks: record.draft.risks.join('\n'),
    }));
    setDraftReview({ confidence: record.draft.confidence, missingInputs: record.draft.missingInputs });
  };

  useEffect(() => {
    const draftId = searchParams.get('draft');
    if (!draftId || appliedDraftId === draftId || goalDrafts.length === 0) return;
    const record = goalDrafts.find((item) => item.id === draftId);
    if (record) applyDraft(record);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, goalDrafts, appliedDraftId]);

  const draftFromNotes = async () => {
    setError(null);
    const notes = draftNotes.trim();
    if (notes.length < 8) {
      setError('Add notes or an outcome first.');
      return;
    }
    try {
      setBusyId('draft');
      const { draft } = await draftGoal({
        notes,
        desiredOutcome: form.objective.trim() || undefined,
      });
      setForm((prev) => ({
        ...prev,
        objective: draft.objective,
        successCriteria: draft.successCriteria.join('\n'),
        nextActions: draft.nextActions.join('\n'),
        risks: draft.risks.join('\n'),
      }));
      setAppliedDraftId(null);
      setDraftReview({ confidence: draft.confidence, missingInputs: draft.missingInputs });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not draft goal.');
    } finally {
      setBusyId(null);
    }
  };

  const submit = async () => {
    setError(null);
    if (!form.objective.trim()) {
      setError('Objective required.');
      return;
    }
    try {
      setBusyId('new');
      await createGoal(form);
      setForm((prev) => ({ ...prev, objective: '', successCriteria: '', nextActions: '', risks: '', deadlineAt: '' }));
      setDraftNotes('');
      setDraftReview(null);
      setAppliedDraftId(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create goal.');
    } finally {
      setBusyId(null);
    }
  };

  const onAction = async (goal: GoalSummary, action: 'enable' | 'disable' | 'park' | 'unpark' | 'satisfy' | 'expire') => {
    setError(null);
    setBusyId(goal.id);
    try {
      if (action === 'enable') await setGoalSelfDrive(goal.id, { enabled: true, resumeEveryMinutes: 30, maxResumes: 12 });
      if (action === 'disable') await setGoalSelfDrive(goal.id, { enabled: false });
      if (action === 'park') await parkGoal(goal.id, 'Paused from Goals.');
      if (action === 'unpark') await unparkGoal(goal.id);
      if (action === 'satisfy') await satisfyGoal(goal.id, 'Marked complete from Goals.');
      if (action === 'expire') await expireGoal(goal.id, 'Stopped from Goals.');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Goal action failed.');
    } finally {
      setBusyId(null);
    }
  };

  const createPendingDraft = async (record: GoalDraftRecord) => {
    setError(null);
    setBusyId(record.id);
    try {
      await createGoalFromDraft(record.id, {
        selfDriving: form.selfDriving,
        resumeEveryMinutes: form.resumeEveryMinutes,
        maxResumes: form.maxResumes,
        maxAttempts: form.maxAttempts,
        deadlineAt: form.deadlineAt,
      });
      if (appliedDraftId === record.id) {
        setForm((prev) => ({ ...prev, objective: '', successCriteria: '', nextActions: '', risks: '', deadlineAt: '' }));
        setDraftNotes('');
        setDraftReview(null);
        setAppliedDraftId(null);
      }
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create goal from draft.');
    } finally {
      setBusyId(null);
    }
  };

  const dismissPendingDraft = async (record: GoalDraftRecord) => {
    setError(null);
    setBusyId(record.id);
    try {
      await dismissGoalDraft(record.id, 'Dismissed from Goals.');
      if (appliedDraftId === record.id) {
        setAppliedDraftId(null);
        setDraftReview(null);
      }
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not dismiss draft.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Page
      title="Goals"
      subtitle="Long-running outcomes Clementine can track, resume, and validate."
      actions={<Button variant="secondary" onClick={() => void goalsQ.refetch()}><RefreshCw className="h-4 w-4" aria-hidden /> Refresh</Button>}
    >
      <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active" value={payload?.counts.active ?? 0} tone="info" />
        <StatCard label="Needs you" value={payload?.counts.parked ?? 0} tone="warning" />
        <StatCard label="Self-driving" value={payload?.counts.selfDriving ?? 0} tone="live" />
        <StatCard label="Done" value={(payload?.counts.satisfied ?? 0) + (payload?.counts.expired ?? 0)} tone="success" />
      </div>

      {goalDrafts.length > 0 && (
        <Card className="mt-5 min-w-0 p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-primary" aria-hidden />
            <h3 className="text-title-sm font-semibold text-fg">Drafts to review</h3>
          </div>
          <div className="space-y-3">
            {goalDrafts.slice(0, 4).map((record) => (
              <div key={record.id} className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border bg-canvas px-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill tone={record.draft.missingInputs.length > 0 ? 'warning' : 'info'}>
                      {record.draft.missingInputs.length > 0 ? 'Needs review' : 'Ready'}
                    </StatusPill>
                    <span className="text-caption text-faint">{shortDate(record.createdAt)}</span>
                  </div>
                  <div className="mt-2 break-words text-body font-semibold text-fg">{record.draft.objective}</div>
                  {record.draft.missingInputs.length > 0 && (
                    // Say WHAT these chips are — bare phrases like "Deadline or
                    // review cadence" read as random tags, not as gaps to fill.
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-caption font-semibold text-warning">Still needs:</span>
                      {record.draft.missingInputs.slice(0, 3).map((item) => (
                        <span key={item} className="rounded-md bg-warning-tint px-2 py-1 text-caption text-warning">{item}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:justify-end">
                  <Button variant="secondary" size="sm" disabled={busyId === record.id} onClick={() => applyDraft(record)}>
                    <ClipboardCheck className="h-4 w-4" aria-hidden /> Apply
                  </Button>
                  <Button size="sm" disabled={busyId === record.id} onClick={() => void createPendingDraft(record)}>
                    {busyId === record.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Timer className="h-4 w-4" aria-hidden />}
                    Create
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busyId === record.id} onClick={() => void dismissPendingDraft(record)}>
                    <Trash2 className="h-4 w-4" aria-hidden /> Dismiss
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="mt-5 min-w-0 p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <GoalIcon className="h-5 w-5 text-primary" aria-hidden />
            <h3 className="text-title-sm font-semibold text-fg">Create goal</h3>
          </div>
          <label className="flex items-center gap-2 text-small font-medium text-fg">
            <input
              type="checkbox"
              checked={form.selfDriving}
              onChange={(e) => setForm((f) => ({ ...f, selfDriving: e.target.checked }))}
            />
            Self-drive after creation
          </label>
        </div>
        <div className="grid min-w-0 gap-4 lg:grid-cols-[1.2fr_1fr]">
          <div className="min-w-0">
            <Field label="Notes or outcome">
              {(id) => (
                <Textarea
                  id={id}
                  className="min-h-[132px]"
                  value={draftNotes}
                  onChange={(e) => setDraftNotes(e.target.value)}
                  placeholder="Paste meeting notes, a transcript excerpt, or a plain outcome Clementine should turn into a goal."
                />
              )}
            </Field>
            <div className="mb-4 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => void draftFromNotes()} disabled={busyId === 'draft'}>
                {busyId === 'draft' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
                Draft goal
              </Button>
              <Button onClick={() => void submit()} disabled={busyId === 'new'}>
                {busyId === 'new' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Timer className="h-4 w-4" aria-hidden />}
                Create goal
              </Button>
            </div>
            {draftReview && (
              <div className="mb-4 rounded-md border border-border bg-subtle px-3 py-2 text-small text-muted">
                <div className="font-semibold text-fg">Review before creating</div>
                {draftReview.missingInputs.length > 0 ? (
                  <ul className="mt-1 space-y-1 break-words">
                    {draftReview.missingInputs.map((item) => <li key={item}>- {item}</li>)}
                  </ul>
                ) : (
                  <div className="mt-1">Ready to review and create.</div>
                )}
              </div>
            )}
            {error && <p className="mb-4 text-small text-danger">{error}</p>}
            <Field label="Objective">
              {(id) => (
                <Textarea
                  id={id}
                  value={form.objective}
                  onChange={(e) => setForm((f) => ({ ...f, objective: e.target.value }))}
                  placeholder="State the measurable outcome."
                />
              )}
            </Field>
            <div className="grid min-w-0 gap-4 md:grid-cols-2">
              <Field label="Success criteria">
                {(id) => (
                  <Textarea
                    id={id}
                    value={form.successCriteria}
                    onChange={(e) => setForm((f) => ({ ...f, successCriteria: e.target.value }))}
                    placeholder={'Baseline is recorded\nTarget is measurable\nEvidence is reviewed'}
                  />
                )}
              </Field>
              <Field label="Next actions">
                {(id) => (
                  <Textarea
                    id={id}
                    value={form.nextActions}
                    onChange={(e) => setForm((f) => ({ ...f, nextActions: e.target.value }))}
                    placeholder={'Clarify constraints\nCapture baseline\nDraft execution plan'}
                  />
                )}
              </Field>
            </div>
          </div>
          <div className="min-w-0">
            <Field label="Risks">
              {(id) => (
                <Textarea
                  id={id}
                  value={form.risks}
                  onChange={(e) => setForm((f) => ({ ...f, risks: e.target.value }))}
                  placeholder={'Missing access\nApproval required\nUnclear baseline'}
                />
              )}
            </Field>
            <Button variant="ghost" size="sm" onClick={() => setAdvancedOpen((open) => !open)}>
              <SlidersHorizontal className="h-4 w-4" aria-hidden /> Advanced
            </Button>
            {advancedOpen && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Cadence minutes">
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      min={5}
                      max={1440}
                      value={form.resumeEveryMinutes}
                      onChange={(e) => setForm((f) => ({ ...f, resumeEveryMinutes: Number(e.target.value) || 30 }))}
                    />
                  )}
                </Field>
                <Field label="Resume limit">
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      min={1}
                      max={100}
                      value={form.maxResumes}
                      onChange={(e) => setForm((f) => ({ ...f, maxResumes: Number(e.target.value) || 12 }))}
                    />
                  )}
                </Field>
                <Field label="Attempt limit">
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      min={1}
                      max={10}
                      value={form.maxAttempts}
                      onChange={(e) => setForm((f) => ({ ...f, maxAttempts: Number(e.target.value) || 3 }))}
                    />
                  )}
                </Field>
                <Field label="Deadline">
                  {(id) => (
                    <Input
                      id={id}
                      type="datetime-local"
                      value={form.deadlineAt}
                      onChange={(e) => setForm((f) => ({ ...f, deadlineAt: e.target.value }))}
                    />
                  )}
                </Field>
              </div>
            )}
          </div>
        </div>
      </Card>

      <div className="mt-5 flex flex-wrap gap-2">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            className={cn(
              'rounded-md border px-3 py-1.5 text-small font-semibold transition-colors',
              filter === item.id ? 'border-primary bg-primary-tint text-primary' : 'border-border bg-surface text-muted hover:text-fg',
            )}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-4">
        {goalsQ.isLoading ? (
          <>
            <Skeleton className="h-56" />
            <Skeleton className="h-56" />
          </>
        ) : goals.length === 0 ? (
          <EmptyState title="No goals here" description="Create a goal or approve a plan from chat to make it visible here." />
        ) : (
          goals.map((goal) => (
            <GoalCard key={goal.id} goal={goal} busy={busyId === goal.id} onAction={onAction} />
          ))
        )}
      </div>
    </Page>
  );
}
