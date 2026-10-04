/**
 * A delegated task, as both apps show it: who owns it, which project it is
 * for, where it stands, and what the owner may do about it.
 *
 * The task view the server returns is the truth. Everything here is words
 * for that view; nothing is inferred from what an agent said, and no step or
 * percentage is invented. A control is offered only when the view allows it.
 */

export type DelegatedTaskPhase =
  | 'waiting_to_start' | 'working' | 'stopping' | 'needs_you' | 'paused' | 'finished' | 'stopped' | 'failed';

export interface DelegatedTaskRevision {
  version: number;
  instruction: string;
  evidencePolicy: string;
  queuedAt: string;
  applied: boolean;
}

export interface DelegatedTask {
  taskId: string;
  title: string;
  /** The task record's own status. */
  status: string;
  phase: DelegatedTaskPhase;
  /** Who owns the work. A null agent is Clem herself. */
  owner: { agentId: string | null; agentName: string | null; chosenBy: 'owner' | 'clem' | 'router' | null };
  project: { id: string; name: string | null } | null;
  /** The version of the request the task works to; 1 is the original. */
  requestVersion: number;
  revisions: DelegatedTaskRevision[];
  /** A correction that has not reached the agent yet. */
  correctionPending: boolean;
  artifactDestination: string | null;
  question: { id: string; text: string; options: string[] } | null;
  approvalId: string | null;
  resultPreview: string | null;
  resultPath: string | null;
  error: string | null;
  /** What the agent said as it worked, newest last. Absent from older Macs. */
  checkIns?: Array<{ at: string; note: string }>;
  /** The job's work list, each item and where it stands. Absent from older Macs. */
  work?: DelegatedTaskWork | null;
  /** The files it saved, by name, newest last. Absent from older Macs. */
  files?: Array<{ name: string; dir: string | null }>;
  originSessionId: string | null;
  runSessionId: string;
  /** The ended task this one carries a correction to; null when it follows none. */
  followsTaskId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  controls: { canSteer: boolean; canStop: boolean; canResume: boolean; canAnswer: boolean };
}

export interface DelegatedTaskWork {
  done: number;
  total: number;
  items: Array<{ id: string; label: string; state: 'done' | 'working' | 'failed' | 'waiting'; note?: string }>;
  /** What its workers were given rather than a declared list: maybe not the whole job. */
  partial?: true;
}

export type DelegatedTaskTone = 'live' | 'warning' | 'success' | 'danger' | 'neutral';

const PHASE_WORDS: Record<DelegatedTaskPhase, { label: string; tone: DelegatedTaskTone; settled: boolean }> = {
  waiting_to_start: { label: 'Waiting to start', tone: 'neutral', settled: false },
  working: { label: 'Working', tone: 'live', settled: false },
  stopping: { label: 'Stopping', tone: 'neutral', settled: false },
  needs_you: { label: 'Waiting on you', tone: 'warning', settled: false },
  paused: { label: 'Paused', tone: 'warning', settled: false },
  finished: { label: 'Finished', tone: 'success', settled: true },
  stopped: { label: 'Stopped', tone: 'neutral', settled: true },
  failed: { label: 'Did not finish', tone: 'danger', settled: true },
};

/** A phase this build does not know is shown as paused: it is not running
 *  as far as this surface can say, and it is not claimed finished. */
function phaseWords(phase: string): { label: string; tone: DelegatedTaskTone; settled: boolean } {
  return PHASE_WORDS[phase as DelegatedTaskPhase] ?? PHASE_WORDS.paused;
}

/** The owner's name: the agent, or Clem when nobody was assigned. */
export function delegatedTaskOwner(task: Pick<DelegatedTask, 'owner'>): string {
  return task.owner?.agentName?.trim() || 'Clem';
}

/** True while the task can still move: not finished, stopped or failed. */
export function delegatedTaskOpen(task: Pick<DelegatedTask, 'phase'>): boolean {
  return !phaseWords(task.phase).settled;
}

/** How the owner was decided, for the details. Null when the record does not say. */
export function delegatedTaskChosenBy(task: Pick<DelegatedTask, 'owner'>): string | null {
  switch (task.owner?.chosenBy) {
    case 'owner': return 'You chose who does this';
    case 'clem': return 'Clem chose who does this';
    case 'router': return 'Matched to the agent responsible in this project';
    default: return null;
  }
}

function opening(text: string | null | undefined, max: number): string {
  const clean = (text ?? '').replace(/\r\n/g, '\n').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const stop = cut.lastIndexOf(' ');
  return `${(stop > max * 0.6 ? cut.slice(0, stop) : cut).trimEnd()}…`;
}

export interface DelegatedTaskCardView {
  taskId: string;
  title: string;
  /** "Sales Assistant", or "Clem". */
  owner: string;
  /** The project's name; null when the task belongs to none. */
  project: string | null;
  phase: { label: string; tone: DelegatedTaskTone; settled: boolean };
  /** "Request v2" once the request was corrected; null on the original. */
  request: string | null;
  /** Said while a correction has not reached the agent yet. */
  correction: string | null;
  /** The question it is waiting on the owner for. */
  question: { text: string; options: string[] } | null;
  /** It waits on an approval, which is decided where approvals are. */
  approvalId: string | null;
  /** The opening of the result, once finished. */
  result: string | null;
  /** Why it did not finish. */
  problem: string | null;
  /** The finished task this one carries a correction to; null when it follows none. */
  followsTaskId: string | null;
  controls: { steer: boolean; stop: boolean; resume: boolean; answer: boolean };
  /** "3 of 4 done", with each item and where it stands; null without a work list. */
  progress: (DelegatedTaskWork & { label: string }) | null;
  /** What it is doing right now, while it works. */
  now: string | null;
  /** The newest thing it said as it worked, and how many came before. */
  latest: { at: string; note: string; earlier: number } | null;
  /** Its report, in markdown: what it found or why it stopped short. */
  report: string | null;
  /** The files it saved, by name. */
  files: Array<{ name: string; dir: string | null }>;
  /**
   * A job never ends without a clear direction: when it stopped short, or
   * finished with items missing, this says what is missing and the one thing
   * that moves it on. Null while it works, when it finished everything, and
   * when its question already asks.
   */
  next: { text: string; action: 'resume' | 'correct' | 'approve' } | null;
  /**
   * The words for correcting it. Work still open is steered: the same task
   * takes the change at its next step. Work that finished is corrected: the
   * change becomes a new task for the same owner, and the finished one stays
   * finished. Work that stopped before finishing resumes with the change.
   */
  steer: { control: string; note: string; startsNewTask: boolean };
}

/**
 * The one direction a job that is not working gives: what is missing and the
 * single thing that moves it on. A question or an approval it waits on is its
 * own direction; a job that finished everything needs none.
 */
function nextDirection(task: DelegatedTask, input: { missingWords: string; owner: string }): DelegatedTaskCardView['next'] {
  switch (task.phase) {
    case 'needs_you':
      return task.question?.text?.trim() ? null : { text: `${input.owner} is waiting for your approval before going on.`, action: 'approve' };
    case 'paused':
      return {
        text: `${input.missingWords ? `${input.missingWords} ` : ''}It stopped before finishing. Resume it to go on, or correct it first.`,
        action: 'resume',
      };
    case 'failed':
      return {
        text: `${input.missingWords ? `${input.missingWords} ` : ''}It did not finish. Resume it to try again, or correct it first.`,
        action: task.controls?.canResume ? 'resume' : 'correct',
      };
    case 'stopped':
      return { text: 'You stopped this. Correct it to start it again with your changes.', action: 'correct' };
    case 'finished':
      return input.missingWords ? { text: `${input.missingWords} Correct this to finish them.`, action: 'correct' } : null;
    default:
      return null;
  }
}

/** The card's words, from one task view. */
export function delegatedTaskCard(task: DelegatedTask, options: { resultChars?: number } = {}): DelegatedTaskCardView {
  const phase = phaseWords(task.phase);
  const version = Number.isFinite(task.requestVersion) ? Math.floor(task.requestVersion) : 1;
  const question = task.phase === 'needs_you' && task.question?.text?.trim()
    ? { text: task.question.text.trim(), options: (task.question.options ?? []).filter((option) => typeof option === 'string' && option.trim().length > 0) }
    : null;
  const work = task.work && task.work.total > 0 ? task.work : null;
  // Only a declared work list knows what is missing; its workers' items may not be the whole job.
  const missing = work && !work.partial ? work.items.filter((item) => item.state !== 'done') : [];
  const missingWords = missing.length > 0
    ? `${missing.length} of ${work!.total} not done: ${missing.slice(0, 3).map((item) => item.label).join(', ')}${missing.length > 3 ? `, and ${missing.length - 3} more` : ''}.`
    : '';
  const working = work ? work.items.filter((item) => item.state === 'working').map((item) => item.label) : [];
  const checkIns = task.checkIns ?? [];
  const last = checkIns.at(-1);
  const report = task.resultPreview?.trim()
    || (task.phase === 'failed' || task.phase === 'paused' || task.phase === 'stopped' ? task.error?.trim() : '')
    || null;
  const owner = delegatedTaskOwner(task);
  return {
    taskId: task.taskId,
    title: task.title?.trim() || 'Untitled task',
    owner,
    progress: work ? { ...work, label: work.partial ? `${work.done} done so far` : `${work.done} of ${work.total} done` } : null,
    now: task.phase === 'working'
      ? (working.length > 0 ? `Working on ${working.slice(0, 3).join(', ')}${working.length > 3 ? ` and ${working.length - 3} more` : ''}.` : null)
      : null,
    latest: last ? { at: last.at, note: last.note, earlier: checkIns.length - 1 } : null,
    report: report ? opening(report, options.resultChars ?? 360) : null,
    files: (task.files ?? []).slice(-8),
    next: nextDirection(task, { missingWords, owner }),
    project: task.project ? (task.project.name?.trim() || null) : null,
    phase,
    request: version > 1 ? `Request v${version}` : null,
    correction: task.correctionPending && !phase.settled ? 'Your correction will be applied at its next step.' : null,
    question,
    approvalId: task.phase === 'needs_you' ? task.approvalId ?? null : null,
    result: task.phase === 'finished' && task.resultPreview?.trim() ? opening(task.resultPreview, options.resultChars ?? 360) : null,
    // A task that stopped short, failed or paused, says why.
    problem: (task.phase === 'failed' || task.phase === 'paused') && task.error?.trim() ? opening(task.error, 360) : null,
    followsTaskId: task.followsTaskId?.trim() || null,
    steer: task.phase === 'finished'
      ? {
        control: 'Correct this',
        note: `This task has finished, so your correction starts a new task for ${delegatedTaskOwner(task)} that follows it.`,
        startsNewTask: true,
      }
      : phase.settled
        // Stopped or failed before it finished: still this task. It holds the
        // record of what it already did, so it takes the correction itself.
        ? {
          control: 'Correct and resume',
          note: 'This task stopped before it finished. It resumes where it was with your correction, and repeats nothing it already did.',
          startsNewTask: false,
        }
        : { control: 'Steer', note: 'The same task continues with your change; nothing starts over.', startsNewTask: false },
    controls: {
      steer: task.controls?.canSteer === true,
      stop: task.controls?.canStop === true,
      resume: task.controls?.canResume === true,
      answer: task.controls?.canAnswer === true && question !== null,
    },
  };
}

/** What a correction came to: the same task revised, or a new one that follows an ended one. */
export type DelegatedTaskCorrection =
  | { applied: 'revised'; task: DelegatedTask }
  | { applied: 'followed'; task: DelegatedTask; follows: DelegatedTask | null };

/**
 * Read a steer answer. A service from before corrections could follow an
 * ended task answers with the task alone; that is a revision.
 */
export function delegatedTaskCorrection(answer: { task: DelegatedTask; applied?: unknown; follows?: DelegatedTask | null }): DelegatedTaskCorrection {
  return answer.applied === 'followed'
    ? { applied: 'followed', task: answer.task, follows: answer.follows ?? null }
    : { applied: 'revised', task: answer.task };
}

/** "Follows “Draft the weekly briefing”", from the tasks shown beside it when one of them is the task followed. */
export function delegatedTaskFollowsLine(
  task: Pick<DelegatedTask, 'followsTaskId'>,
  beside: readonly Pick<DelegatedTask, 'taskId' | 'title'>[] = [],
): string | null {
  const id = task.followsTaskId?.trim();
  if (!id) return null;
  const title = beside.find((row) => row.taskId === id)?.title?.trim();
  return title ? `Follows “${title}” with your correction` : 'Follows a finished task with your correction';
}

/** The tasks that carry a correction to this one, newest first. */
export function delegatedTaskFollowUps<T extends Pick<DelegatedTask, 'taskId' | 'followsTaskId' | 'updatedAt'>>(
  task: Pick<DelegatedTask, 'taskId'>,
  beside: readonly T[],
): T[] {
  return beside.filter((row) => row.followsTaskId === task.taskId && row.taskId !== task.taskId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The corrections made to a request, newest first, for the details. */
export function delegatedTaskCorrections(task: Pick<DelegatedTask, 'revisions'>): Array<{ label: string; instruction: string; applied: boolean }> {
  return [...(task.revisions ?? [])]
    .sort((a, b) => b.version - a.version)
    .map((revision) => ({
      label: `Request v${revision.version}`,
      instruction: revision.instruction,
      applied: revision.applied,
    }));
}

/**
 * Tasks in the order the owner needs them: what waits on them first, then
 * what is moving, then what ended; newest first inside each.
 */
export function orderDelegatedTasks<T extends Pick<DelegatedTask, 'phase' | 'updatedAt'>>(tasks: readonly T[]): T[] {
  const rank = (task: T): number => (task.phase === 'needs_you' ? 0 : delegatedTaskOpen(task) ? 1 : 2);
  return [...tasks].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
}

/** The check-ins a card shows: the newest few, oldest first. */
export function delegatedTaskCheckIns(task: Pick<DelegatedTask, 'checkIns'>, limit = 6): Array<{ at: string; note: string }> {
  return (task.checkIns ?? []).filter((entry) => typeof entry?.note === 'string' && entry.note.trim()).slice(-limit);
}
