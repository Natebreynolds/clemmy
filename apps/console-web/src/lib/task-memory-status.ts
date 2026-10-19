/** Small, exact-source reads for asynchronous memory work. Never executes or
 * resumes a task, saves a fact, or changes a destination. */
import type { TaskMemoryStatus, TerminalFacts } from '@clem/chat-engine';
import { api } from './api';
import { memoryFactHref } from './memory-fact-links';

export type { TaskMemoryStatus } from '@clem/chat-engine';
export type MemoryWork = NonNullable<TaskMemoryStatus['memory']>;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const oneOf = (value: unknown, choices: readonly string[]) => typeof value === 'string' && choices.includes(value);
const STATES = ['pending', 'saved', 'refused', 'needs_choice', 'unavailable'] as const;

export function validMemoryWork(value: unknown): value is TaskMemoryStatus['memory'] {
  if (value === null) return true;
  if (!record(value) || !oneOf(value.state, [...STATES, 'mixed']) || !record(value.counts)
    || !Array.isArray(value.candidates) || !value.candidates.every((row) => record(row) && positive(row.candidateId)
      && oneOf(row.state, STATES) && (row.factId === undefined || positive(row.factId))
      && (row.reason === undefined || oneOf(row.reason, ['inactive', 'superseded', 'unverified', 'retry_exhausted', 'destination_unresolved'])))
    || !oneOf(value.nextStep, ['wait', 'review_memory', 'clarify_destination', 'check_again', 'none'])
    || !(value.pollAfterMs === null || (positive(value.pollAfterMs) && value.pollAfterMs <= 60_000))) return false;
  const counts = value.counts;
  if (!['pending', 'saved', 'refused', 'needsChoice', 'unavailable'].every((key) => count(counts[key]))) return false;
  if (value.candidates.length === 0) return value.state === 'unavailable' && counts.unavailable === 1
    && ['pending', 'saved', 'refused', 'needsChoice'].every((key) => counts[key] === 0) && value.pollAfterMs === null;
  // Counts describe the returned candidates, not a guess from reply text. A
  // malformed green/pending combination must not become an optimistic badge.
  const actual = { pending: 0, saved: 0, refused: 0, needsChoice: 0, unavailable: 0 };
  const candidateIds = new Set<number>();
  for (const row of value.candidates) {
    if (candidateIds.has(row.candidateId) || (row.state === 'saved' && (!positive(row.factId) || row.reason !== undefined))) return false;
    candidateIds.add(row.candidateId);
  }
  for (const row of value.candidates) actual[row.state === 'needs_choice' ? 'needsChoice' : row.state as keyof typeof actual] += 1;
  if (!Object.entries(actual).every(([key, amount]) => counts[key] === amount)) return false;
  const states = new Set(value.candidates.map((row) => row.state));
  if (states.size > 1 ? value.state !== 'mixed' : states.size === 1 && !states.has(value.state)) return false;
  if (value.pollAfterMs !== null && actual.pending === 0) return false;
  return true;
}

export function taskMemoryStatusPath(sessionId: string, sourceUserSeq: number): string {
  if (!sessionId.trim() || !positive(sourceUserSeq)) throw new Error('This reply does not have an exact request identity.');
  return `/api/console/sessions/${encodeURIComponent(sessionId)}/memory-status?sourceUserSeq=${sourceUserSeq}`;
}

type Read = (path: string, options?: RequestInit) => Promise<unknown>;
export async function getTaskMemoryStatus(sessionId: string, sourceUserSeq: number, signal?: AbortSignal,
  request: Read = (path, options) => api<unknown>(path, options)): Promise<TaskMemoryStatus> {
  const value = await request(taskMemoryStatusPath(sessionId, sourceUserSeq), { signal });
  if (!record(value) || value.version !== 1 || value.sessionId !== sessionId || value.sourceUserSeq !== sourceUserSeq
    || typeof value.observedAt !== 'string' || !value.observedAt.trim() || !validMemoryWork(value.memory)) {
    throw new Error('This request’s current memory status could not be read.');
  }
  return value as unknown as TaskMemoryStatus;
}

/** The host hint and the accepted request must agree. Missing identities and
 * adjacent/check-in turns never expand into a session-wide memory lookup. */
export function hasExactMemoryWork(terminal: TerminalFacts | undefined, source: { sourceUserSeq: number } | null): boolean {
  return Boolean(source && positive(source.sourceUserSeq) && terminal?.memoryWork?.sourceUserSeq === source.sourceUserSeq
    && (terminal.memoryWork.reason === 'memory_consolidation_pending' || terminal.memoryWork.reason === 'memory_work_unverified'));
}

export function memoryWorkPresentation(work: TaskMemoryStatus['memory']): { title: string; detail: string } {
  if (!work) return { title: 'Memory status isn’t available', detail: 'No current memory result could be verified for this request.' };
  switch (work.state) {
    case 'pending': return { title: 'Memory update is still pending', detail: 'Clem is checking this memory request. It hasn’t been confirmed saved.' };
    case 'saved': return { title: 'Memory saved', detail: 'The saved memory is confirmed by the current record.' };
    case 'needs_choice': return { title: 'Choose where this memory belongs', detail: 'Tell Clem which existing project this is for, or explicitly ask to save it for all your projects. Nothing was saved without a clear destination.' };
    case 'refused': return { title: 'This memory wasn’t saved', detail: 'The memory request was declined. You can clarify what should be remembered and where it belongs in a new message.' };
    case 'unavailable': return { title: 'Memory result can’t be confirmed', detail: work.candidates.some((row) => row.reason === 'superseded')
      ? 'A saved memory from this request has since been replaced. Open its record to see the update.'
      : work.candidates.some((row) => row.reason === 'inactive')
        ? 'A saved memory from this request is no longer active. Open its record to review its current state.'
        : 'The current records don’t establish that this memory was saved.' };
    case 'mixed': {
      const { saved, pending, needsChoice, refused, unavailable } = work.counts;
      const parts = [saved && `${saved} saved`, pending && `${pending} still pending`, needsChoice && `${needsChoice} need a destination`, refused && `${refused} declined`, unavailable && `${unavailable} unconfirmed`].filter(Boolean);
      return { title: 'Memory work has separate results', detail: `${parts.join(' · ')}. Not every memory request is confirmed saved.${needsChoice ? ' Tell Clem which existing project the unresolved memory is for, or explicitly ask to save it for all your projects.' : ''}` };
    }
  }
}

export function memoryWorkLinks(work: TaskMemoryStatus['memory']): Array<{ id: number; href: string }> {
  const links = new Map<number, string>();
  for (const row of work?.candidates ?? []) {
    const href = memoryFactHref(row.factId);
    if (href && row.factId && !links.has(row.factId)) links.set(row.factId, href);
    if (links.size >= 8) break;
  }
  return [...links].map(([id, href]) => ({ id, href }));
}

export type MemoryReadState = { phase: 'loading' | 'ready' | 'error'; value?: TaskMemoryStatus; paused: boolean };
type Timer = ReturnType<typeof setTimeout>;

/** Only pending work polls. Timers, aborts and stale completions are owned by
 * this reader, which is disposed when the exact reply leaves the viewport. */
export function watchTaskMemoryStatus(options: {
  read: (signal: AbortSignal) => Promise<TaskMemoryStatus>;
  onState: (state: MemoryReadState) => void;
  deadline: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => Timer;
  cancel?: (timer: Timer) => void;
  timeoutMs?: number;
}) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  let disposed = false;
  let timer: Timer | undefined;
  let pending: { abort: AbortController; timeout: Timer } | null = null;
  let value: TaskMemoryStatus | undefined;
  const clearTimer = () => { if (timer !== undefined) cancel(timer); timer = undefined; };
  const check = () => {
    if (disposed || pending) return;
    clearTimer();
    const abort = new AbortController();
    const timeout = schedule(() => {
      if (disposed || pending?.abort !== abort) return;
      pending = null;
      abort.abort();
      options.onState({ phase: 'error', value, paused: true });
    }, options.timeoutMs ?? 20_000);
    pending = { abort, timeout };
    options.onState({ phase: 'loading', value, paused: false });
    void options.read(abort.signal).then((result) => {
      if (disposed || abort.signal.aborted || pending?.abort !== abort) return;
      cancel(timeout); pending = null; value = result;
      const delay = result.memory?.pollAfterMs;
      const hasPending = (result.memory?.counts.pending ?? 0) > 0;
      const wait = delay ? Math.max(1000, Math.min(delay, 15_000)) : null;
      const canPoll = hasPending && wait !== null && now() + wait < options.deadline;
      options.onState({ phase: 'ready', value, paused: hasPending && !canPoll });
      if (canPoll) timer = schedule(check, wait!);
    }).catch(() => {
      if (disposed || abort.signal.aborted || pending?.abort !== abort) return;
      cancel(timeout); pending = null;
      options.onState({ phase: 'error', value, paused: true });
    });
  };
  check();
  return {
    check,
    dispose() { disposed = true; clearTimer(); if (pending) { cancel(pending.timeout); pending.abort.abort(); pending = null; } },
  };
}
