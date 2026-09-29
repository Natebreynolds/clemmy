/**
 * One delegated task, the same card wherever it shows: in the conversation
 * that handed it over, on its project, on the agent that owns it.
 *
 * It says who owns the work, which project it is for and where it stands,
 * from the task's own record (lib/projects). A control is drawn only when
 * the record allows it, and after each one the card shows the record the
 * server answered with. Nothing here counts steps or guesses at progress.
 *
 * Work still open is steered. Work that has ended is corrected: the
 * correction becomes a new task, drawn under the ended one and saying which
 * task it follows. The ended task stays ended.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ChevronRight, CornerDownRight, Play, Square } from 'lucide-react';
import {
  delegatedTaskCard, delegatedTaskChosenBy, delegatedTaskCorrections, delegatedTaskFollowUps, delegatedTaskFollowsLine,
  type DelegatedTaskTone,
} from '@clem/chat-engine';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Field';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/inbox';
import {
  answerTask, refusalText, resumeTask, steerTask, stopTask, taskFromRefusal, taskRunPath, type DelegatedTask,
} from '@/lib/projects';

const PILL_TONE: Record<DelegatedTaskTone, Tone> = {
  live: 'live', warning: 'warning', success: 'success', danger: 'danger', neutral: 'neutral',
};

type Action = 'steer' | 'stop' | 'resume' | 'answer';
type Panel = 'steer' | 'stop' | null;

function moment(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  return Number.isFinite(at.getTime())
    ? at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';
}

export function DelegatedTaskCard({
  task,
  onChanged,
  hideProject,
  liveWork,
  hideResult,
  hideQuestion,
  hideOwner,
  compact,
  beside,
  className,
}: {
  task: DelegatedTask;
  /** The tasks drawn in the same list, this one included: a task that
   *  follows another names it, and one already listed is not drawn twice. */
  beside?: readonly DelegatedTask[];
  /** The task's record after a control, so lists that hold it can re-read. */
  onChanged?: (task: DelegatedTask) => void;
  /** On the project's own page the project is the page. */
  hideProject?: boolean;
  /** The work as it happens, shown with the details (a conversation has it). */
  liveWork?: ReactNode;
  /** Where the full result is already on screen beside the card. */
  hideResult?: boolean;
  /** Where the question is asked, and answered, elsewhere on the same page. */
  hideQuestion?: boolean;
  /** On the owning agent's own page the agent is the page. */
  hideOwner?: boolean;
  /** A narrow column: the title gets a line of its own. */
  compact?: boolean;
  className?: string;
}) {
  // The answer to the last control stands until the list catches up with it.
  const [answered, setAnswered] = useState<DelegatedTask | null>(null);
  const shown = answered && answered.taskId === task.taskId && answered.updatedAt >= task.updatedAt ? answered : task;
  const card = delegatedTaskCard(shown);
  // The task a correction to ended work became, until the list holds it.
  const [followUp, setFollowUp] = useState<DelegatedTask | null>(null);
  const listed = beside ?? [];
  const followUps = delegatedTaskFollowUps(shown, listed);
  const followUpHere = followUp && !listed.some((row) => row.taskId === followUp.taskId) ? followUp : null;
  const followsLine = delegatedTaskFollowsLine(shown, listed);

  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState('');
  const [instruction, setInstruction] = useState('');
  const [answer, setAnswer] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const steerRef = useRef<HTMLTextAreaElement>(null);
  const detailsId = useId();
  const steerId = useId();
  const answerId = useId();

  useEffect(() => { if (panel === 'steer') steerRef.current?.focus(); }, [panel]);
  // A control the record no longer allows takes its open panel with it.
  useEffect(() => {
    if ((panel === 'steer' && !card.controls.steer) || (panel === 'stop' && !card.controls.stop)) setPanel(null);
  }, [panel, card.controls.steer, card.controls.stop]);

  const run = async (action: Action, call: () => Promise<DelegatedTask>): Promise<boolean> => {
    if (busy) return false;
    setBusy(action);
    setError('');
    try {
      const next = await call();
      setAnswered(next);
      onChanged?.(next);
      return true;
    } catch (failure) {
      // A refusal carries the record as it stands now; the card follows it.
      const current = taskFromRefusal(failure);
      if (current) { setAnswered(current); onChanged?.(current); }
      setError(refusalText(failure));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const sendCorrection = async () => {
    const text = instruction.trim();
    if (!text) return;
    const sent = await run('steer', async () => {
      const correction = await steerTask(shown.taskId, text);
      if (correction.applied === 'revised') return correction.task;
      // The ended task is answered with itself, still ended; the correction
      // is the new task.
      setFollowUp(correction.task);
      onChanged?.(correction.task);
      return correction.follows ?? shown;
    });
    if (sent) { setInstruction(''); setPanel(null); }
  };
  const sendAnswer = async (text: string) => {
    const value = text.trim();
    if (!value) return;
    if (await run('answer', () => answerTask(shown.taskId, value))) setAnswer('');
  };
  const stop = async () => { if (await run('stop', () => stopTask(shown.taskId))) setPanel(null); };

  const corrections = delegatedTaskCorrections(shown);
  const chosenBy = delegatedTaskChosenBy(shown);
  const changed = relativeTime(shown.updatedAt);
  const byline = [
    hideOwner ? null : card.owner,
    !hideProject && card.project ? card.project : null,
    card.request,
    changed ? (changed === 'now' ? 'just now' : `${changed} ago`) : null,
  ].filter(Boolean) as string[];
  const hasDetails = Boolean(liveWork) || corrections.length > 0 || Boolean(chosenBy)
    || Boolean(shown.artifactDestination) || Boolean(shown.startedAt) || Boolean(shown.resultPath);

  return (
    <>
    <article
      aria-label={`${card.owner}: ${card.title}. ${card.phase.label}.`}
      className={cn('rounded-md border border-border bg-surface px-4 py-3', (card.question || card.approvalId) && !hideQuestion && 'border-warning/50', className)}
    >
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <div className={cn('flex gap-x-2 gap-y-1', compact ? 'flex-col items-start' : 'flex-wrap items-center')}>
            <StatusPill tone={PILL_TONE[card.phase.tone]}>{busy === 'stop' ? 'Stopping' : card.phase.label}</StatusPill>
            <h4
              className={cn('min-w-0 font-semibold text-fg', compact ? 'line-clamp-2 text-small' : 'flex-1 truncate text-body')}
              title={card.title}
            >
              {card.title}
            </h4>
          </div>
          {byline.length > 0 && (
            <p className="mt-1 text-caption text-muted">
              {byline.map((part, index) => (
                <span key={`${index}-${part}`}>
                  {index > 0 && ' · '}
                  {index === 0 && !hideOwner ? <span className="font-semibold text-fg">{part}</span> : part}
                </span>
              ))}
            </p>
          )}
        </div>
        <Link
          to={taskRunPath(shown.taskId)}
          className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-caption font-semibold text-primary transition-colors hover:bg-primary-tint"
          aria-label={`Open the full run of ${card.title}`}
        >
          Open <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      {followsLine && card.followsTaskId && (
        <p className="mt-2 flex items-start gap-1.5 text-small text-muted">
          <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
          <span>
            {followsLine}.{' '}
            <Link to={taskRunPath(card.followsTaskId)} className="font-semibold text-primary hover:underline">Open that task</Link>
          </span>
        </p>
      )}

      {card.correction && (
        <p className="mt-2 flex items-start gap-1.5 text-small text-muted" role="status">
          <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
          {card.correction}
        </p>
      )}

      {(followUpHere || followUps.length > 0) && (
        <p className="mt-2 flex items-start gap-1.5 text-small text-muted" role="status">
          <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
          {followUpHere
            ? 'Your correction started a new task, shown below. This one stays as it ended.'
            : `Your correction is carried by a new task: “${followUps[0].title}”.`}
        </p>
      )}

      {card.question && !hideQuestion && (
        <div className="mt-2.5 rounded-md bg-warning-tint px-3 py-2.5">
          <p className="whitespace-pre-wrap text-body text-fg">{card.question.text}</p>
          {card.controls.answer && (
            <form
              className="mt-2 flex flex-col gap-2"
              onSubmit={(event) => { event.preventDefault(); void sendAnswer(answer); }}
            >
              {card.question.options.length > 0 && (
                <div role="group" aria-label="Suggested answers" className="flex flex-wrap gap-1.5">
                  {card.question.options.map((option) => (
                    <button
                      key={option}
                      type="button"
                      disabled={busy !== null}
                      onClick={() => { void sendAnswer(option); }}
                      className="rounded-md border border-border-strong bg-surface px-3 py-1.5 text-left text-small font-semibold text-fg transition-colors duration-fast hover:border-primary hover:bg-primary-tint active:scale-press disabled:opacity-50 motion-reduce:active:scale-100 cursor-pointer"
                    >
                      {option}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <label htmlFor={answerId} className="sr-only">Your answer to {card.owner}</label>
                <Input
                  id={answerId}
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  placeholder={card.question.options.length > 0 ? 'Or type your answer…' : 'Type your answer…'}
                  disabled={busy !== null}
                  className="h-9 min-w-40 flex-1 bg-surface text-small"
                />
                <Button type="submit" size="sm" disabled={busy !== null || !answer.trim()}>
                  {busy === 'answer' ? 'Sending…' : 'Answer'}
                </Button>
              </div>
            </form>
          )}
        </div>
      )}

      {card.approvalId && !card.question && !hideQuestion && (
        <p className="mt-2.5 rounded-md bg-warning-tint px-3 py-2 text-small text-fg">
          Waiting on your approval before it goes on.{' '}
          <Link to={`/inbox?tab=needs&select=${encodeURIComponent(card.approvalId)}`} className="font-semibold text-primary hover:underline">
            Review it
          </Link>
        </p>
      )}

      {card.result && !hideResult && (
        <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-small text-muted">{card.result}</p>
      )}
      {card.problem && <p className="mt-2 whitespace-pre-wrap text-small text-danger">{card.problem}</p>}

      {(card.controls.steer || card.controls.stop || card.controls.resume || hasDetails) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {card.controls.resume && (
            <Button size="sm" variant="secondary" className="h-8" disabled={busy !== null} onClick={() => { void run('resume', () => resumeTask(shown.taskId)); }}>
              <Play className="h-3.5 w-3.5" aria-hidden /> {busy === 'resume' ? 'Resuming…' : 'Resume'}
            </Button>
          )}
          {card.controls.steer && (
            <Button
              size="sm" variant="secondary" className="h-8" disabled={busy !== null}
              aria-expanded={panel === 'steer'} aria-controls={steerId}
              onClick={() => setPanel((open) => (open === 'steer' ? null : 'steer'))}
            >
              <CornerDownRight className="h-3.5 w-3.5" aria-hidden /> {card.steer.control}
            </Button>
          )}
          {card.controls.stop && (
            <Button
              size="sm" variant="ghost" className="h-8" disabled={busy !== null}
              aria-expanded={panel === 'stop'}
              onClick={() => setPanel((open) => (open === 'stop' ? null : 'stop'))}
            >
              <Square className="h-3.5 w-3.5" aria-hidden /> Stop
            </Button>
          )}
          {hasDetails && (
            <button
              type="button"
              onClick={() => setDetailsOpen((open) => !open)}
              aria-expanded={detailsOpen}
              aria-controls={detailsId}
              className="ml-auto inline-flex h-8 items-center gap-1 rounded-sm px-1.5 text-caption font-semibold text-muted transition-colors hover:bg-hover hover:text-fg cursor-pointer"
            >
              <ChevronRight className={cn('h-3.5 w-3.5 transition-transform duration-fast motion-reduce:transition-none', detailsOpen && 'rotate-90')} aria-hidden />
              Details
            </button>
          )}
        </div>
      )}

      {panel === 'steer' && card.controls.steer && (
        <form
          id={steerId}
          className="mt-2 flex flex-col gap-2"
          onSubmit={(event) => { event.preventDefault(); void sendCorrection(); }}
        >
          <label htmlFor={`${steerId}-text`} className="text-caption font-semibold text-muted">
            What should {card.owner} do differently?
          </label>
          <Textarea
            id={`${steerId}-text`}
            ref={steerRef}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.stopPropagation(); setPanel(null); }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void sendCorrection(); }
            }}
            rows={2}
            disabled={busy !== null}
            placeholder="Focus on this week and leave out unqualified leads."
            className="min-h-[64px] bg-surface text-small"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={busy !== null || instruction.trim().length < 4}>
              {busy === 'steer' ? 'Sending…' : card.steer.startsNewTask ? 'Start the corrected task' : 'Send correction'}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setPanel(null)}>Cancel</Button>
            <span className="text-caption text-faint">{card.steer.note}</span>
          </div>
        </form>
      )}

      {panel === 'stop' && card.controls.stop && (
        <div className="mt-2 rounded-md border border-border bg-subtle px-3 py-2.5" role="group" aria-label="Confirm stopping this task">
          <p className="text-small text-fg">Stop this task? What {card.owner} has done so far is kept.</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => { void stop(); }}>
              {busy === 'stop' ? 'Stopping…' : 'Stop task'}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => setPanel(null)}>Keep going</Button>
          </div>
        </div>
      )}

      {error && <p role="alert" className="mt-2 text-caption text-danger">{error}</p>}

      {hasDetails && detailsOpen && (
        <div id={detailsId} className="mt-2.5 space-y-2.5 border-t border-border pt-2.5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
            {chosenBy && (<><dt className="text-faint">Owner</dt><dd className="text-muted">{card.owner}. {chosenBy}.</dd></>)}
            {shown.startedAt && (<><dt className="text-faint">Started</dt><dd className="text-muted">{moment(shown.startedAt)}</dd></>)}
            {shown.completedAt && (<><dt className="text-faint">Ended</dt><dd className="text-muted">{moment(shown.completedAt)}</dd></>)}
            {shown.artifactDestination && (<><dt className="text-faint">Result goes to</dt><dd className="break-words text-muted">{shown.artifactDestination}</dd></>)}
            {shown.resultPath && (<><dt className="text-faint">Saved as</dt><dd className="break-all text-muted">{shown.resultPath}</dd></>)}
          </dl>
          {corrections.length > 0 && (
            <div>
              <div className="text-caption font-semibold text-faint">Your corrections</div>
              <ul className="mt-1 space-y-1">
                {corrections.map((correction) => (
                  <li key={correction.label} className="text-caption text-muted">
                    <span className="font-semibold text-fg">{correction.label}</span>
                    <span className="text-faint"> · {correction.applied ? 'applied' : 'waiting for its next step'}</span>
                    <span className="mt-0.5 block whitespace-pre-wrap">{correction.instruction}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {liveWork}
        </div>
      )}
    </article>
    {followUpHere && (
      <div className="mt-2 border-l-2 border-border pl-3">
        <DelegatedTaskCard
          task={followUpHere}
          beside={[shown, followUpHere]}
          onChanged={onChanged}
          hideProject={hideProject}
          hideOwner={hideOwner}
          compact={compact}
        />
      </div>
    )}
    </>
  );
}

/** A short list of task cards with its own empty line. */
export function DelegatedTaskList({
  tasks,
  onChanged,
  hideProject,
  empty,
}: {
  tasks: readonly DelegatedTask[];
  onChanged?: (task: DelegatedTask) => void;
  hideProject?: boolean;
  empty: string;
}) {
  if (tasks.length === 0) return <p className="text-small text-faint">{empty}</p>;
  return (
    <ul className="space-y-2">
      {tasks.map((task) => (
        <li key={task.taskId}>
          <DelegatedTaskCard task={task} beside={tasks} onChanged={onChanged} hideProject={hideProject} />
        </li>
      ))}
    </ul>
  );
}
