/**
 * TURN PROGRESS — the honest progress bar.
 *
 * A turn has no known step count, so a percent bar over "steps" would be a
 * guess dressed as a measurement. What every turn DOES pass through is a short
 * ordered set of phases, each of which the client can see start and end from
 * events it already holds: the model thinks, it works with tools and helpers,
 * it writes the answer, and a reviewer checks it. A rail of those phases is a
 * real progress bar on the one axis that is true for every request, whatever
 * tools it uses. Inside the working phase, the only determinate fill is a
 * count the harness declared itself (a batch or work manifest); everything
 * else stays indeterminate on purpose.
 *
 * The same module gives each step its place on the turn's timeline, so the
 * step list reads as where the time went rather than a checklist of names.
 *
 * Pure: no clock of its own (the caller passes `now`), no I/O, no mutation.
 * Both shells render from this, so the desktop and the phone agree about
 * where a turn is.
 */
import type { ActivityItem, LiveAnswerDraft } from './types.js';

export type TurnPhaseId = 'think' | 'work' | 'write' | 'check';
export type TurnPhaseState = 'done' | 'current' | 'pending' | 'skipped';

export interface TurnPhase {
  id: TurnPhaseId;
  /** "Thinking" · "Working" · "Writing" · "Checking". */
  label: string;
  state: TurnPhaseState;
  /** A short truthful caption for the segment ("6 steps · 1 running",
   *  "3 of 10", "correcting", "found issues"). */
  caption?: string;
  /** 0..1 fill when the harness declared the denominator (batch or manifest
   *  meters). Undefined means indeterminate: the segment sweeps while current. */
  fraction?: number;
}

export interface TurnProgress {
  phases: TurnPhase[];
  /** The phase in flight, or null once the turn has settled. */
  current: TurnPhaseId | null;
}

/** The slice of an activity row this module reads. Structural, so the desktop's
 *  own ActivityItem (a superset) fits without conversion. */
export type ProgressRow = Pick<
  ActivityItem,
  'id' | 'kind' | 'status' | 'startedAt' | 'finishedAt' | 'batch' | 'variant' | 'tone' | 'verdict'
>;

export interface TurnProgressInput {
  /** The narrated activity view (discovery hidden, repeats folded). */
  activity: readonly ProgressRow[];
  live: boolean;
  /** The provisional answer, while it streams or is checked. */
  draft?: LiveAnswerDraft;
  /** The message already shows reply text (legacy token streaming or delivered). */
  hasText: boolean;
}

const PHASE_LABEL: Record<TurnPhaseId, string> = {
  think: 'Thinking',
  work: 'Working',
  write: 'Writing',
  check: 'Checking',
};

const ORDER: readonly TurnPhaseId[] = ['think', 'work', 'write', 'check'];

/** A row that IS work: a tool, a helper, a batch, or a real effect. Lifecycle
 *  beats (the model-phase row, the discovery stand-in) and trust checks are
 *  not work. */
export function isWorkRow(row: Pick<ProgressRow, 'kind' | 'variant'>): boolean {
  if (row.kind === 'tool' || row.kind === 'agent' || row.kind === 'batch') return true;
  return row.kind === 'event' && row.variant !== 'lifecycle';
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Sum the declared meters. Only rows whose denominator the harness stated
 *  count; a meter with no total is not a fraction. */
function declaredMeter(rows: readonly ProgressRow[]): { done: number; total: number } | null {
  let done = 0;
  let total = 0;
  for (const row of rows) {
    if (row.kind !== 'batch' || !row.batch || row.batch.total <= 0) continue;
    done += Math.min(row.batch.done + row.batch.failed, row.batch.total);
    total += row.batch.total;
  }
  return total > 0 ? { done, total } : null;
}

export function turnProgress(input: TurnProgressInput): TurnProgress {
  const { activity, live, draft, hasText } = input;
  const work = activity.filter(isWorkRow);
  const checks = activity.filter((row) => row.kind === 'check');
  const workRunning = work.filter((row) => row.status === 'running').length;
  const phase = draft?.phase;
  const writing = phase === 'writing' || (live && hasText && !draft);
  const checking = phase === 'checking';
  const correcting = phase === 'withdrawn' && draft?.withdrawn === 'review';

  const current: TurnPhaseId | null = !live
    ? null
    : checking
      ? 'check'
      : writing
        ? 'write'
        : workRunning > 0
          ? 'work'
          : correcting
            ? 'write'
            : work.length > 0
              ? 'work'
              : 'think';

  const started: Record<TurnPhaseId, boolean> = {
    think: true,
    work: work.length > 0,
    write: Boolean(draft) || hasText,
    check: checks.length > 0 || checking || correcting,
  };

  const meter = declaredMeter(work);
  const lastCheck = checks[checks.length - 1];
  const currentIndex = current ? ORDER.indexOf(current) : ORDER.length;

  const phases = ORDER.map((id, index): TurnPhase => {
    const state: TurnPhaseState = index === currentIndex
      ? 'current'
      : index < currentIndex
        ? (started[id] ? 'done' : 'skipped')
        : live
          ? 'pending'
          : (started[id] ? 'done' : 'skipped');
    const out: TurnPhase = { id, label: PHASE_LABEL[id], state };
    if (id === 'work') {
      if (meter) {
        out.fraction = Math.min(1, meter.done / meter.total);
        out.caption = `${meter.done} of ${meter.total}`;
      } else if (work.length > 0) {
        out.caption = state === 'current' && workRunning > 0
          ? `${plural(work.length, 'step')} · ${workRunning} running`
          : plural(work.length, 'step');
      }
    } else if (id === 'write') {
      if (correcting && state === 'current') out.caption = 'correcting';
    } else if (id === 'check') {
      if (lastCheck?.verdict === 'rejected' || correcting) out.caption = 'found issues';
      else if (lastCheck?.verdict === 'passed' && state === 'done') out.caption = 'passed';
      else if (lastCheck?.verdict === 'unreviewed' && !live) { out.state = 'skipped'; out.caption = 'not checked'; }
    }
    return out;
  });

  return { phases, current };
}

// ── Where the time went ─────────────────────────────────────────────────────

export interface TimelineBounds {
  start: number;
  end: number;
}

/** The turn's time window: the earliest step start to now (live) or the last
 *  known settle. Null when no row carries a clock. */
export function timelineBounds(rows: readonly ProgressRow[], live: boolean, now: number): TimelineBounds | null {
  let start = Infinity;
  let end = -Infinity;
  for (const row of rows) {
    if (typeof row.startedAt === 'number' && Number.isFinite(row.startedAt)) {
      start = Math.min(start, row.startedAt);
      end = Math.max(end, row.startedAt);
    }
    if (typeof row.finishedAt === 'number' && Number.isFinite(row.finishedAt)) end = Math.max(end, row.finishedAt);
  }
  if (!Number.isFinite(start)) return null;
  if (live) end = Math.max(end, now);
  return { start, end: Math.max(end, start + 1) };
}

export interface TimelineSpan {
  /** Percent offset from the window's start. */
  left: number;
  /** Percent of the window this step occupied (0 for an instant step). */
  width: number;
}

/** One step's place in the window, as percentages a bar can use directly. A
 *  running step reaches `now` while live; a settled step without a recorded
 *  finish reaches the window's end, which is the most it can truthfully claim. */
export function timelineSpan(
  row: Pick<ProgressRow, 'startedAt' | 'finishedAt' | 'status'>,
  bounds: TimelineBounds,
  live: boolean,
  now: number,
): TimelineSpan | null {
  if (typeof row.startedAt !== 'number' || !Number.isFinite(row.startedAt)) return null;
  const total = bounds.end - bounds.start;
  if (total <= 0) return null;
  const end = row.status === 'running'
    ? (live ? now : bounds.end)
    : (typeof row.finishedAt === 'number' && Number.isFinite(row.finishedAt) ? row.finishedAt : bounds.end);
  const clamp = (value: number): number => Math.max(0, Math.min(100, value));
  const left = clamp(((row.startedAt - bounds.start) / total) * 100);
  const width = clamp(((Math.max(end, row.startedAt) - row.startedAt) / total) * 100);
  return { left, width: Math.min(width, 100 - left) };
}
