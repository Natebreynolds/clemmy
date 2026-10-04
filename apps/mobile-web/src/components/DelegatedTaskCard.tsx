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
import { delegatedTaskCard, delegatedTaskCorrection, delegatedTaskFollowsLine, renderMarkdown, type DelegatedTask } from '@clem/chat-engine';
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
  /** In a conversation the report arrives as Clem's own message; the card
   *  does not say it twice. */
  hideReport?: boolean;
}

const ITEM_WORDS: Record<'done' | 'working' | 'failed' | 'waiting', string> = {
  done: 'Done',
  working: 'Working',
  failed: 'Not done',
  waiting: 'Waiting',
};

/** The newer of what the host passed and what a control was answered with. */
function newest(given: DelegatedTask, settled: DelegatedTask | null): DelegatedTask {
  if (!settled || settled.taskId !== given.taskId) return given;
  return settled.updatedAt.localeCompare(given.updatedAt) > 0 ? settled : given;
}

export function DelegatedTaskCard({ task: given, onChanged, onOpenRun, onOpenNeedsYou, hideProject, hideOwner, follows, listed, hideReport }: Props) {
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
  // The direction's own controls are not drawn twice below it.
  const steerInRow = view.controls.steer && !view.next;
  const resumeInRow = view.controls.resume && view.next?.action !== 'resume';
  const hasControls = Boolean(onOpenRun) || steerInRow || view.controls.stop || resumeInRow;

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

      {/* Where it stands first: how much is done, then the one thing that
          moves it on when it is not working. */}
      {view.progress ? (
        <div class="task-progress">
          <div class="task-progress-bar" aria-hidden="true">
            {view.progress.items.length > 0 && view.progress.items.length <= 12
              ? view.progress.items.map((item) => <i key={item.id} class={`task-seg task-seg-${item.state}`} />)
              : <i class="task-seg task-seg-done" style={{ flex: `0 0 ${Math.round((view.progress.done / Math.max(1, view.progress.total)) * 100)}%` }} />}
          </div>
          <span class="task-progress-label">{view.progress.label}</span>
        </div>
      ) : null}

      {view.next ? (
        <div class="task-next">
          <p class="task-next-text">{view.next.text}</p>
          <div class="task-actions">
            {view.next.action === 'resume' && view.controls.resume ? (
              <RunControl target={{ kind: 'delegated-task', taskId: task.taskId }} resumable onChanged={onChanged} />
            ) : null}
            {view.next.action === 'approve' && onOpenNeedsYou ? (
              <button type="button" class="btn-approve task-send" onClick={() => { haptic('light'); onOpenNeedsYou(); }}>Review</button>
            ) : null}
            {view.controls.steer && mode !== 'steer' ? (
              <button type="button" class={view.next.action === 'correct' ? 'btn-approve task-send' : 'btn-quiet'} onClick={() => { haptic('light'); setError(null); setMode('steer'); }}>
                {view.next.action === 'correct' ? view.steer.control : 'Correct it first'}
              </button>
            ) : null}
          </div>
        </div>
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

      {view.now ? <p class="task-now">{view.now}</p> : null}

      {view.latest ? (
        <div class="task-latest">
          <p class="task-checkin-note">{view.latest.note}</p>
          <span class="task-checkin-when">{view.owner} · <time dateTime={view.latest.at}>{relativeTime(view.latest.at)}</time></span>
          {view.latest.earlier > 0 ? (
            <details class="task-earlier">
              <summary>Earlier updates ({view.latest.earlier})</summary>
              <ol class="task-checkins">
                {(task.checkIns ?? []).slice(0, -1).reverse().map((entry) => (
                  <li key={`${entry.at}-${entry.note.slice(0, 24)}`}>
                    <time class="task-checkin-when" dateTime={entry.at}>{relativeTime(entry.at)}</time>
                    <p class="task-checkin-note">{entry.note}</p>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>
      ) : null}

      {view.progress && view.progress.items.length > 0 ? (
        <ul class="task-items" aria-label={view.progress.label}>
          {view.progress.items.slice(0, 6).map((item) => (
            <li key={item.id} class={`task-item task-item-${item.state}`}>
              <i class="task-item-mark" aria-hidden="true" />
              <span class="task-item-label">{item.label}</span>
              <span class="task-item-state">{ITEM_WORDS[item.state]}{item.note ? ` · ${item.note}` : ''}</span>
            </li>
          ))}
          {view.progress.items.length > 6 ? (
            <li class="task-item task-item-more">and {view.progress.items.length - 6} more</li>
          ) : null}
        </ul>
      ) : null}

      {view.report && !hideReport ? (
        <div class="task-report">
          {/* The report is markdown, like a chat reply. */}
          <div class="bubble-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(view.report) }} />
          {onOpenRun ? (
            <button type="button" class="link-btn" onClick={() => { haptic('light'); onOpenRun(task.runSessionId); }}>Full report</button>
          ) : null}
        </div>
      ) : null}

      {view.files.length > 0 ? (
        <div class="task-files" aria-label="Files it saved">
          {view.files.map((file) => <span key={`${file.dir ?? ''}/${file.name}`} class="task-file" title={file.dir ?? undefined}>{file.name}</span>)}
        </div>
      ) : null}

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
          {steerInRow ? (
            <button type="button" class="btn-quiet" onClick={() => { haptic('light'); setError(null); setMode('steer'); }}>
              {view.steer.control}
            </button>
          ) : null}
          {resumeInRow ? (
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
