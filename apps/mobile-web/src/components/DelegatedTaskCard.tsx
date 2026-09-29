/**
 * One delegated task, the same card in a conversation, in a project and on an
 * agent.
 *
 * It reads in the order a glance needs: where the task stands, what it is,
 * who owns it. Everything on it comes from the task view the Mac returned:
 * no progress bar, no invented steps, and "Finished" only when the record
 * says so. A control is drawn only when the view allows it, calls the task's
 * own route, and settles to the task the Mac answers with.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { delegatedTaskCard, delegatedTaskCorrection, delegatedTaskFollowsLine, type DelegatedTask } from '@clem/chat-engine';
import { answerDelegatedTask, refusedTask, steerDelegatedTask } from '../lib/project-api';
import { refusalIsStale, refusalWords } from '../lib/project-words';
import { haptic } from '../lib/native-bridge';
import { relativeTime } from './Approvals';
import { RunControl } from './RunControl';

interface Props {
  task: DelegatedTask;
  /** Something about the task changed: the host reads its view again. */
  onChanged: () => void;
  /** Opens the run view that already exists for the task's work. */
  onOpenRun?: (runSessionId: string) => void;
  /** Where an approval is decided, when the task waits on one. */
  onOpenNeedsYou?: () => void;
  /** A project's own screen already says which project this is. */
  hideProject?: boolean;
  /** An agent's own screen already says who owns it. */
  hideOwner?: boolean;
  /** For a follow-up: what it says about the finished task it follows. */
  follows?: string | null;
  /** The tasks the host already lists, so a follow-up is never drawn twice. */
  listed?: ReadonlySet<string>;
}

/** The newer of what the host passed and what a control was answered with. */
function newest(given: DelegatedTask, settled: DelegatedTask | null): DelegatedTask {
  if (!settled || settled.taskId !== given.taskId) return given;
  return settled.updatedAt.localeCompare(given.updatedAt) > 0 ? settled : given;
}

export function DelegatedTaskCard({ task: given, onChanged, onOpenRun, onOpenNeedsYou, hideProject, hideOwner, follows, listed }: Props) {
  const [settled, setSettled] = useState<DelegatedTask | null>(null);
  // The task a correction started, shown in place until the host lists it.
  const [followUp, setFollowUp] = useState<DelegatedTask | null>(null);
  const [mode, setMode] = useState<'idle' | 'steer'>('idle');
  const [steer, setSteer] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<'steer' | 'answer' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What a control just did, kept only while the task is as that control left it.
  const [receipt, setReceipt] = useState<{ text: string; at: string } | null>(null);
  const lock = useRef(false);
  const steerRef = useRef<HTMLTextAreaElement | null>(null);

  const task = newest(given, settled);
  const view = delegatedTaskCard(task, { resultChars: 280 });
  // The words are the shared engine's, so the desktop card says the same.
  const request = view.request;
  const who = [hideOwner ? '' : view.owner, hideProject ? '' : view.project ?? ''].filter(Boolean).join(' · ');
  const followsEarlier = follows ?? delegatedTaskFollowsLine(task);

  useEffect(() => {
    if (mode === 'steer') steerRef.current?.focus();
  }, [mode]);

  async function act(
    kind: 'steer' | 'answer',
    work: () => Promise<{ task: DelegatedTask; applied?: 'revised' | 'followed'; follows?: DelegatedTask | null }>,
    done: string,
  ) {
    if (lock.current) return;
    lock.current = true;
    setBusy(kind);
    setError(null);
    haptic('medium');
    try {
      const result = delegatedTaskCorrection(await work());
      // A correction to a task that had ended starts a task that follows it.
      // This card stays the task it was, ended; the new one is drawn after it.
      const followed = result.applied === 'followed';
      const mine = result.applied === 'followed' ? result.follows : result.task;
      if (mine) setSettled(mine);
      if (followed) setFollowUp(result.task);
      setReceipt({
        text: followed ? `Sent. ${view.owner} started a new task with your correction.` : done,
        at: (mine ?? task).updatedAt,
      });
      setMode('idle');
      setSteer('');
      setAnswer('');
      haptic('success');
      onChanged();
    } catch (err) {
      const now = refusedTask(err);
      if (now) setSettled(now);
      if (refusalIsStale(err)) {
        // The task moved on somewhere else. Show where it stands; nothing was sent twice.
        haptic('light');
        setMode('idle');
        setReceipt({ text: refusalWords(err), at: (now ?? task).updatedAt });
        onChanged();
      } else {
        haptic('error');
        setError(refusalWords(err));
      }
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  const sendSteer = () => {
    const instruction = steer.trim();
    if (instruction.length < 4) { setError('Say a little more about what should change.'); return; }
    void act('steer', () => steerDelegatedTask(task.taskId, instruction), 'Correction sent.');
  };
  const sendAnswer = (value: string) => {
    const text = value.trim().slice(0, 4_000);
    if (!text) return;
    void act('answer', () => answerDelegatedTask(task.taskId, text), 'Answer sent.');
  };

  const waiting = view.phase.tone === 'warning' && task.phase === 'needs_you';
  const hasControls = Boolean(onOpenRun) || view.controls.steer || view.controls.stop || view.controls.resume;

  const card = (
    <article class={`task-card task-${view.phase.tone}${waiting ? ' task-waiting' : ''}`} aria-busy={busy !== null}>
      <header class="task-head">
        <span class="task-phase">
          <i class="task-dot" aria-hidden="true" />
          {view.phase.label}
        </span>
        <time class="task-when" dateTime={task.updatedAt}>{relativeTime(task.updatedAt)}</time>
      </header>
      <h3 class="task-title">{view.title}</h3>
      {who ? <p class="task-who">{who}</p> : null}
      {followsEarlier ? <p class="task-follows">{followsEarlier}</p> : null}
      {request || view.correction ? (
        <p class="task-request">
          {request ? <span class="task-request-mark">{request}</span> : null}
          {view.correction ? <span>{view.correction}</span> : null}
        </p>
      ) : null}

      {view.question ? (
        <div class="task-question">
          <p class="task-question-text">{view.question.text}</p>
          {view.controls.answer ? (
            <>
              {view.question.options.length > 0 ? (
                <div class="inbox-option-grid" role="group" aria-label="Suggested answers">
                  {view.question.options.map((option) => (
                    <button key={option} type="button" disabled={busy !== null} onClick={() => sendAnswer(option)}>{option}</button>
                  ))}
                </div>
              ) : null}
              <form class="inbox-reply" onSubmit={(event) => { event.preventDefault(); sendAnswer(answer); }}>
                <textarea
                  rows={2}
                  maxLength={4000}
                  value={answer}
                  disabled={busy !== null}
                  aria-label={`Answer ${view.owner}`}
                  placeholder={`Answer ${view.owner}…`}
                  onInput={(event) => setAnswer(event.currentTarget.value)}
                />
                <button class="btn-approve task-send" type="submit" disabled={busy !== null || !answer.trim()}>
                  {busy === 'answer' ? 'Sending…' : 'Send answer'}
                </button>
              </form>
            </>
          ) : null}
        </div>
      ) : view.approvalId ? (
        <div class="task-question">
          <p class="task-question-text">{view.owner} is waiting for your approval before going on.</p>
          {onOpenNeedsYou ? (
            <button type="button" class="link-btn" onClick={() => { haptic('light'); onOpenNeedsYou(); }}>Review in Needs you</button>
          ) : null}
        </div>
      ) : null}

      {view.result ? <p class="task-result">{view.result}</p> : null}
      {view.problem ? <p class="task-problem">{view.problem}</p> : null}

      {mode === 'steer' ? (
        <form class="inbox-reply task-steer" onSubmit={(event) => { event.preventDefault(); sendSteer(); }}>
          <label for={`steer-${task.taskId}`}>{view.steer.startsNewTask ? 'What should be corrected?' : 'What should change?'}</label>
          <textarea
            id={`steer-${task.taskId}`}
            ref={steerRef}
            rows={2}
            maxLength={2000}
            value={steer}
            disabled={busy !== null}
            placeholder="Use last quarter's numbers instead…"
            onInput={(event) => setSteer(event.currentTarget.value)}
          />
          <p class="task-fine">{view.steer.note}</p>
          <div class="task-actions">
            <button class="btn-approve task-send" type="submit" disabled={busy !== null || steer.trim().length < 4}>
              {busy === 'steer' ? 'Sending…' : 'Send correction'}
            </button>
            <button type="button" class="btn-quiet" disabled={busy !== null} onClick={() => { setMode('idle'); setError(null); }}>Cancel</button>
          </div>
        </form>
      ) : hasControls ? (
        <div class="task-actions">
          {onOpenRun ? (
            <button type="button" class="btn-quiet" onClick={() => { haptic('light'); onOpenRun(task.runSessionId); }}>Open</button>
          ) : null}
          {view.controls.steer ? (
            <button type="button" class="btn-quiet" onClick={() => { haptic('light'); setError(null); setMode('steer'); }}>
              {view.steer.control}
            </button>
          ) : null}
          {view.controls.resume ? (
            <RunControl target={{ kind: 'delegated-task', taskId: task.taskId }} resumable onChanged={onChanged} />
          ) : null}
          {view.controls.stop ? (
            <RunControl target={{ kind: 'delegated-task', taskId: task.taskId }} onChanged={onChanged} />
          ) : null}
        </div>
      ) : null}

      {error ? <p class="inbox-inline-error" role="alert">{error}</p> : null}
      {receipt && !error && receipt.at === task.updatedAt ? <p class="task-receipt" role="status">{receipt.text}</p> : null}
    </article>
  );

  // The new task appears where the correction was made, at once. When the
  // host's own list carries it, the host draws it and this copy steps aside.
  if (!followUp || listed?.has(followUp.taskId)) return card;
  return (
    <>
      {card}
      <DelegatedTaskCard
        task={followUp}
        follows={delegatedTaskFollowsLine(followUp, [task])}
        onChanged={onChanged}
        onOpenRun={onOpenRun}
        onOpenNeedsYou={onOpenNeedsYou}
        hideProject={hideProject}
        hideOwner={hideOwner}
        listed={listed}
      />
    </>
  );
}

/** The cards of one list, with the quiet line a list with nothing in it says. */
export function DelegatedTaskList({ tasks, empty, known, listed, ...card }: Omit<Props, 'task' | 'follows'> & {
  tasks: readonly DelegatedTask[];
  empty?: string;
  /** Every task on the screen, when this list shows only some of them. */
  known?: readonly DelegatedTask[];
}) {
  if (tasks.length === 0) return empty ? <p class="section-empty">{empty}</p> : null;
  const all = known ?? tasks;
  const onScreen = listed ?? new Set(all.map((task) => task.taskId));
  return (
    <div class="task-list">
      {tasks.map((task) => (
        <DelegatedTaskCard key={task.taskId} task={task} {...card} listed={onScreen} follows={delegatedTaskFollowsLine(task, all)} />
      ))}
    </div>
  );
}
