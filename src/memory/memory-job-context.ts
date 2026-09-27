/**
 * Memory-job wiring: what each call site hands the journal.
 *
 * `runMemoryModelJob` wraps `runMemoryJob` (memory-work-journal.ts) with a
 * small per-run note, so a job's own code can say which model its route asked
 * for (`memoryJobRoute`) and which model error it caught and handled
 * (`noteMemoryModelFailure`) without returning either through its callers.
 * The note is scoped to the innermost run: a reconcile inside a learning run
 * notes into its own run, never its parent's.
 *
 * A job started inside an accepted turn (a save the turn made, a check after
 * the owner's message) runs in its own usage scope, so its calls are never
 * charged to the turn. Its model is still SELECTED as that turn would select
 * it (`inMemoryJobTurn`): a session's pinned brain decides the automatic
 * checker family exactly as it did before memory work had its own scope.
 *
 * The source helpers name where a job's work came from — a conversation, a
 * workflow, the owner, the schedule — from the harness session row (a system
 * id, never user text). Titles are read at display time by the Memory tab.
 *
 * Nothing here throws into a job; reading a session row is guarded.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { MemoryJobId } from './memory-jobs.js';
import type { MemoryModelProblem, MemoryWorkSource } from './memory-work-types.js';
import {
  memoryModelProblemFromError,
  runMemoryJob,
  type MemoryJobOutcome,
  type MemoryJobRunOptions,
} from './memory-work-journal.js';
import { memoryModelAvailability, resolveMemoryModelRoute, type MemoryModelRoute } from './memory-model-route.js';
import { modelUsageAttributionStorage, type ModelUsageAttributionContext } from '../runtime/usage-log.js';
import { openEventLog } from '../runtime/harness/eventlog.js';

export interface MemoryJobNote {
  /** The model the job's route asked for; unset when no route was resolved. */
  requestedModelId?: string | null;
  /** The model error the job's own code caught and handled (the job then
   *  finished without it). A thrown error needs no note: the journal sees it. */
  error?: unknown;
  /** The accepted turn the job started in, for model selection only. */
  turnScope?: ModelUsageAttributionContext;
}

const jobNotes = new AsyncLocalStorage<MemoryJobNote>();

/**
 * Run one memory job through the journal with a note the job's code can
 * write. `summarize` reads the note, so a job that swallowed a model error can
 * still report the problem. The requested model id reaches the journal
 * through the run's options, which it reads when it records (after `work`).
 */
export async function runMemoryModelJob<T>(
  job: MemoryJobId,
  opts: MemoryJobRunOptions,
  work: () => Promise<T>,
  summarize: (value: T, note: MemoryJobNote) => MemoryJobOutcome,
): Promise<T> {
  // A job nested in another job selects as the job around it does.
  const turn = acceptedTurnScope() ?? jobNotes.getStore()?.turnScope ?? null;
  const note: MemoryJobNote = turn ? { turnScope: turn } : {};
  const runOpts: MemoryJobRunOptions = { ...opts };
  return runMemoryJob(job, runOpts, async () => {
    try {
      return await jobNotes.run(note, work);
    } finally {
      if (note.requestedModelId !== undefined) runOpts.requestedModelId = note.requestedModelId;
    }
  }, (value) => summarize(value, note));
}

/** The usage scope of the accepted turn in scope right now, or null. */
function acceptedTurnScope(): ModelUsageAttributionContext | null {
  const scope = modelUsageAttributionStorage.getStore();
  return scope && Number.isSafeInteger(scope.sourceUserSeq) && scope.sourceUserSeq > 0 && scope.sessionId ? scope : null;
}

/**
 * Select a model as the turn this job started in would have (a session's
 * pinned brain decides the automatic checker family). Only the selection runs
 * in the turn's scope; the job's model calls run later in its own. Outside a
 * turn this is just `select()`.
 */
export function inMemoryJobTurn<T>(select: () => T): T {
  const turn = jobNotes.getStore()?.turnScope;
  return turn ? modelUsageAttributionStorage.run(turn, select) : select();
}

/** Resolve a governed job's route and note the model it asks for. */
export function memoryJobRoute(job: MemoryJobId): MemoryModelRoute | null {
  const route = inMemoryJobTurn(() => resolveMemoryModelRoute(job));
  const note = jobNotes.getStore();
  if (note) note.requestedModelId = route?.modelId ?? null;
  return route;
}

/** A job's code caught a model error and carried on: keep it for the event. */
export function noteMemoryModelFailure(error: unknown): void {
  const note = jobNotes.getStore();
  if (note) note.error = error;
}

/** The problem class of the noted model error, or null (none, or not the
 *  model's fault). */
export function notedMemoryModelProblem(note: MemoryJobNote): MemoryModelProblem | null {
  return note.error === undefined ? null : memoryModelProblemFromError(note.error);
}

/** Why a governed job's model cannot be served right now, or null. */
export function memoryJobUnavailableProblem(job: MemoryJobId): MemoryModelProblem | null {
  const availability = memoryModelAvailability(job);
  return availability.ok ? null : availability.problem ?? null;
}

/** A run that did not finish, naming the model's problem when one is known. */
export function memoryJobFailed(
  note: MemoryJobNote,
  rest: Omit<MemoryJobOutcome, 'outcome' | 'failure'> = {},
  problem: MemoryModelProblem | null = notedMemoryModelProblem(note),
): MemoryJobOutcome {
  return { ...rest, outcome: 'failed', failure: problem ? { problem } : null };
}

// ───────────────────────────── sources ─────────────────────────────

export type HarnessSessionKind = 'chat' | 'execution' | 'workflow' | 'agent';

/** The harness session row's kind, or null when there is no such session (a
 *  pseudo-session like a Settings door) or it cannot be read. */
export function harnessSessionKind(sessionId: string | null | undefined): HarnessSessionKind | null {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return null;
  try {
    const row = openEventLog().prepare('SELECT kind FROM sessions WHERE id = ?').get(id) as { kind?: string } | undefined;
    const kind = row?.kind;
    return kind === 'chat' || kind === 'execution' || kind === 'workflow' || kind === 'agent' ? kind : null;
  } catch {
    return null;
  }
}

/** Workflow step sessions are minted `workflow:<run>:<step>`; the row says so too. */
function isWorkflowSession(sessionId: string, kind: HarnessSessionKind | null): boolean {
  return kind === 'workflow' || sessionId.startsWith('workflow:');
}

/**
 * The source for work that came from a harness session: a workflow or a
 * conversation, with the session id (the Memory tab reads its title). A
 * session the harness does not know gets `fallback`.
 */
export function memoryWorkSourceForSession(
  sessionId: string | null | undefined,
  fallback: MemoryWorkSource | null = null,
): MemoryWorkSource | null {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return fallback;
  const kind = harnessSessionKind(id);
  if (isWorkflowSession(id, kind)) return { kind: 'workflow', sessionId: id };
  if (kind) return { kind: 'conversation', sessionId: id };
  return fallback;
}

/**
 * The source for work started inside an accepted turn (a microtask or tool
 * the turn launched): that conversation. Outside a turn, `fallback`. Reads the
 * usage scope only to name the source; the job never charges the turn.
 */
export function memoryWorkSourceFromTurn(fallback: MemoryWorkSource | null): MemoryWorkSource | null {
  const turn = acceptedTurnScope();
  return turn ? memoryWorkSourceForSession(turn.sessionId, fallback) : fallback;
}

/**
 * A tidy run's record: the memories it let fade (by id, so the Memory tab can
 * bring them back) and, apart from them, the records of finished work it
 * cleared once they aged out (a count; they are not memories, so they never
 * count as faded). Recorded only when something changed; otherwise the run
 * just refreshes "last checked".
 */
export function memoryTidyOutcome(fadedFactIds: Iterable<number>, agedOut = 0): MemoryJobOutcome {
  const faded = [...new Set(factIdStrings(fadedFactIds))];
  const aged = Number.isFinite(agedOut) ? Math.max(0, Math.floor(agedOut)) : 0;
  if (faded.length === 0 && aged === 0) return { outcome: 'nothing_new' };
  return {
    outcome: 'ok',
    produced: { ...(faded.length > 0 ? { faded: faded.length } : {}), ...(aged > 0 ? { agedOut: aged } : {}) },
    ...(faded.length > 0 ? { facts: { faded } } : {}),
    record: true,
  };
}

/** A verify run's record (a second model checking a memory repair or a
 *  correction): approved, vetoed, or — when the check's model failed — did
 *  not finish. A check that made no call (no independent model is bound)
 *  only refreshes "last checked". */
export function memoryVerifyOutcome(result: { verdict: string }, note: MemoryJobNote): MemoryJobOutcome {
  if (result.verdict === 'approve') return { outcome: 'ok', produced: { approved: 1 } };
  if (result.verdict === 'unavailable' && note.error !== undefined) return memoryJobFailed(note);
  if (result.verdict === 'unavailable') return { outcome: 'nothing_new' };
  return { outcome: 'ok', produced: { declined: 1 } };
}

/** An index run's record: recorded only when it indexed something. */
export function memoryIndexOutcome(embedded: number): MemoryJobOutcome {
  const count = Number.isFinite(embedded) ? Math.max(0, Math.floor(embedded)) : 0;
  return count > 0 ? { outcome: 'ok', produced: { embedded: count } } : { outcome: 'nothing_new' };
}

/** Fact ids as the journal stores them: strings, positive integers only. */
export function factIdStrings(ids: Iterable<number | null | undefined>): string[] {
  const out: string[] = [];
  for (const id of ids) if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) out.push(String(id));
  return out;
}
