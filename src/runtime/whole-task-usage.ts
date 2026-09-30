/**
 * What one request cost, all of it.
 *
 * A request is no longer one model loop. Clem answers, helpers fan out, a
 * task is delegated to an agent that runs on after the reply, the router and
 * the reviewers are asked along the way, and what was learned is settled
 * afterwards. Each of those records its own usage against its own session.
 * This adds them up for one accepted request, says which calls it counted
 * and why, and says plainly what it could not attribute.
 *
 * It reads. It records nothing, changes no usage row, and asks no model.
 * Every source is passed in, so the same arithmetic runs inside the daemon
 * and, read-only, against a home that another process owns.
 */
import type { UsageEvent } from './usage-log.js';

export interface WholeTaskUsageSources {
  /** Usage rows recorded on one calendar day. */
  usageForDate(date: Date): UsageEvent[];
  /** Events of one session, of the given types, in order. */
  events(sessionId: string, types: readonly string[]): Array<{ seq: number; type: string; createdAt: string; data: Record<string, unknown> }>;
  /** Tasks handed to the background runner, as recorded. */
  tasks(): Array<{
    id: string; status: string; title: string; originSessionId?: string; runSessionId: string;
    createdAt: string; startedAt?: string; completedAt?: string; updatedAt: string;
    delegation?: { agentName: string | null; projectName: string | null; originSourceUserSeq?: number };
    foregroundHandoff?: { sessionId: string; sourceUserSeq: number };
  }>;
}

export type TaskParticipantRelation = 'request' | 'helper' | 'delegated_task' | 'delegated_helper';

export interface TaskParticipant {
  relation: TaskParticipantRelation;
  sessionId: string;
  /** The accepted source inside that session, when the relation names one. */
  sourceUserSeq?: number;
  taskId?: string;
  owner?: string | null;
}

export interface UsageTotals {
  calls: number;
  failedCalls: number;
  promptTokens: number;
  cachedReadTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelMs: number;
  /** Calls whose cache accounting the adapter could not certify. */
  uncertifiedCalls: number;
}

export interface WholeTaskUsage {
  sessionId: string;
  sourceUserSeq: number;
  window: { from: string; to: string };
  /** Usage can settle after a reply or after the same source reconnects. */
  usageObservedThrough: string;
  participants: TaskParticipant[];
  totals: UsageTotals;
  byRole: Record<string, UsageTotals>;
  byRelation: Record<TaskParticipantRelation, UsageTotals>;
  timeline: {
    acceptedAt: string | null;
    /** The first model response recorded for the request. */
    firstModelResponseAt: string | null;
    /** The first thing the owner could see happen. */
    firstProgressAt: string | null;
    delegatedAt: string | null;
    /** The reply in the conversation. */
    repliedAt: string | null;
    /** The last delegated task to end, when any were delegated. */
    delegatedWorkEndedAt: string | null;
  };
  /** What could not be attributed, stated instead of guessed. */
  unknown: string[];
}

function blank(): UsageTotals {
  return { calls: 0, failedCalls: 0, promptTokens: 0, cachedReadTokens: 0, uncachedInputTokens: 0,
    outputTokens: 0, totalTokens: 0, modelMs: 0, uncertifiedCalls: 0 };
}

function add(totals: UsageTotals, row: UsageEvent): void {
  totals.calls += 1;
  if (row.ok === false) totals.failedCalls += 1;
  const canonical = row.canonical;
  const prompt = canonical ? canonical.promptTokens : row.inputTokens;
  const cached = canonical ? canonical.cachedReadTokens : 0;
  totals.promptTokens += prompt;
  totals.cachedReadTokens += cached;
  totals.uncachedInputTokens += canonical ? canonical.uncachedInputTokens : Math.max(0, prompt - cached);
  totals.outputTokens += row.outputTokens;
  totals.totalTokens += row.totalTokens;
  totals.modelMs += row.durationMs ?? 0;
  if (!canonical?.certified) totals.uncertifiedCalls += 1;
}

function* daysBetween(from: string, to: string): Generator<Date> {
  const start = new Date(Date.parse(from));
  const end = new Date(Math.max(Date.parse(to), Date.parse(from)));
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() - 1));
  // Current usage logs use UTC days. The extra days also let readers find
  // legacy local-day files across zones. Never silently truncate long work.
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1));
  while (cursor.getTime() <= last.getTime()) {
    yield new Date(cursor);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

const participantKey = (sessionId: string, seq: number | null) => JSON.stringify([sessionId, seq]);

function helpersOf(
  sources: WholeTaskUsageSources,
  sessionId: string,
  sourceUserSeq: number | null,
  relation: 'helper' | 'delegated_helper',
  taskId: string | undefined,
  known: Set<string>,
  unknown: string[],
): TaskParticipant[] {
  const found: TaskParticipant[] = [];
  const queue = [{ sessionId, sourceUserSeq }];
  known.add(participantKey(sessionId, sourceUserSeq));
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index]!;
    for (const event of sources.events(parent.sessionId, ['worker_started'])) {
      const exact = positive(event.data.parentSourceUserSeq);
      const legacy = positive(event.data.sourceUserSeq);
      if (parent.sourceUserSeq !== null && exact !== parent.sourceUserSeq && legacy !== parent.sourceUserSeq) continue;
      if ((event.data.parentSourceUserSeq !== undefined && exact === null)
        || (event.data.sourceUserSeq !== undefined && legacy === null)
        || (exact !== null && legacy !== null && exact !== legacy)
        || (event.data.parentSessionId !== undefined && event.data.parentSessionId !== parent.sessionId)) {
        unknown.push(`A worker link at event ${event.seq} has conflicting or invalid parent identity; its costs were not attributed.`);
        continue;
      }
      if (exact === null && legacy === null) {
        unknown.push(`A worker link at event ${event.seq} names no parent source; its costs were not attributed.`);
        continue;
      }
      const child = typeof event.data.childSessionId === 'string' ? event.data.childSessionId.trim() : '';
      const childSeq = positive(event.data.childSourceUserSeq);
      if (!child || childSeq === null) {
        unknown.push(`A worker link at event ${event.seq} names no exact child source; its costs were not attributed.`);
        continue;
      }
      const key = participantKey(child, childSeq);
      if (known.has(key) || known.has(participantKey(child, null))) continue;
      known.add(key);
      found.push({ relation, sessionId: child, sourceUserSeq: childSeq,
        ...(taskId ? { taskId } : {}), owner: typeof event.data.agent === 'string' ? event.data.agent : null });
      queue.push({ sessionId: child, sourceUserSeq: childSeq });
    }
  }
  return found;
}

function rowBelongs(row: UsageEvent, participant: TaskParticipant): boolean {
  const accepted = row.trace?.acceptedSource ?? '';
  if (participant.sourceUserSeq !== undefined) {
    const exact = `${participant.sessionId}:${participant.sourceUserSeq}`;
    return accepted ? accepted === exact : row.source === exact;
  }
  // A delegated task owns its whole run session.
  if (accepted) return accepted.startsWith(`${participant.sessionId}:`);
  return row.source === participant.sessionId || row.source.startsWith(`${participant.sessionId}:`);
}

export function wholeTaskUsage(
  request: { sessionId: string; sourceUserSeq: number },
  sources: WholeTaskUsageSources,
  now: Date = new Date(),
): WholeTaskUsage {
  const unknown: string[] = [];
  const { sessionId, sourceUserSeq } = request;
  const own = sources.events(sessionId, [
    'user_input_received', 'conversation_completed', 'conversation_preamble', 'conversation_check_in',
    'tool_called', 'delegated_task_state', 'approval_requested',
  ]);
  const accepted = own.find((event) => event.type === 'user_input_received' && event.seq === sourceUserSeq) ?? null;
  if (!accepted) unknown.push('The accepted request was not found in the event log; times are unknown.');
  const after = own.filter((event) => event.seq > sourceUserSeq);
  const nextRequest = after.find((event) => event.type === 'user_input_received' && event.data.synthetic !== true);
  const mine = after.filter((event) => !nextRequest || event.seq < nextRequest.seq);
  const reply = mine.find((event) => event.type === 'conversation_completed'
    && (positive(event.data.sourceUserSeq) === sourceUserSeq || positive(event.data.sourceUserSeq) === null)) ?? null;

  const participants: TaskParticipant[] = [{ relation: 'request', sessionId, sourceUserSeq }];
  const known = new Set([participantKey(sessionId, sourceUserSeq)]);
  participants.push(...helpersOf(sources, sessionId, sourceUserSeq, 'helper', undefined, known, unknown));

  const tasks = sources.tasks().filter((task) => {
    if (task.originSessionId !== sessionId) return false;
    const named = task.delegation?.originSourceUserSeq ?? task.foregroundHandoff?.sourceUserSeq;
    if (named !== undefined) return named === sourceUserSeq;
    // A task that names no request belongs to the request it was started
    // under: the one accepted last before it was created.
    if (!accepted) return false;
    return task.createdAt >= accepted.createdAt && (!nextRequest || task.createdAt < nextRequest.createdAt);
  });
  const unnamed = tasks.filter((task) => task.delegation?.originSourceUserSeq === undefined && task.foregroundHandoff?.sourceUserSeq === undefined);
  if (unnamed.length > 0) {
    unknown.push(`${unnamed.length} task${unnamed.length === 1 ? ' names' : 's name'} no request and ${unnamed.length === 1 ? 'was' : 'were'} given to this one by when ${unnamed.length === 1 ? 'it' : 'they'} started.`);
  }
  for (const task of tasks) {
    participants.push({ relation: 'delegated_task', sessionId: task.runSessionId, taskId: task.id,
      owner: task.delegation?.agentName ?? null });
    participants.push(...helpersOf(sources, task.runSessionId, null, 'delegated_helper', task.id, known, unknown));
  }
  const open = tasks.filter((task) => !task.completedAt && !['done', 'failed', 'aborted', 'interrupted'].includes(task.status));
  if (open.length > 0) {
    unknown.push(`${open.length} delegated task${open.length === 1 ? ' is' : 's are'} still open; the total is what has been spent so far.`);
  }

  const from = accepted?.createdAt ?? tasks[0]?.createdAt ?? now.toISOString();
  const ends = [reply?.createdAt, ...tasks.map((task) => task.completedAt ?? task.updatedAt)]
    .filter((value): value is string => typeof value === 'string');
  const to = open.length > 0 || ends.length === 0 ? now.toISOString() : ends.sort().at(-1)!;

  const totals = blank();
  const byRole: Record<string, UsageTotals> = {};
  const byRelation: Record<TaskParticipantRelation, UsageTotals> = {
    request: blank(), helper: blank(), delegated_task: blank(), delegated_helper: blank(),
  };
  const counted = new Set<string>();
  let firstModelResponseAt: string | null = null;
  let unattributedLearning = 0;
  let unattributedLearningTokens = 0;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to) + 120_000;
  // A waiting reply is not the end of an accepted request's spend. Scan
  // through this observation; exact source/lineage joins exclude other turns.
  const usageObservedThrough = now.toISOString();
  for (const day of daysBetween(from, usageObservedThrough)) {
    for (const row of sources.usageForDate(day)) {
      const at = Date.parse(row.at);
      if (!Number.isFinite(at) || at < fromMs - 1_000 || at > now.getTime()) continue;
      const owner = participants.find((participant) => rowBelongs(row, participant));
      if (!owner) {
        // Learning settled after the fact with no request named on it cannot
        // be given to this one. It is counted apart, never added.
        if (row.role === 'memory' && !row.trace?.acceptedSource && at <= toMs) {
          unattributedLearning += 1;
          unattributedLearningTokens += row.totalTokens;
        }
        continue;
      }
      const key = `${row.at}|${row.source}|${row.model}|${row.responseId ?? ''}|${row.totalTokens}|${row.trace?.modelCallId ?? ''}`;
      if (counted.has(key)) continue;
      counted.add(key);
      add(totals, row);
      add(byRole[row.role ?? 'unset'] ??= blank(), row);
      add(byRelation[owner.relation], row);
      if (owner.relation === 'request' && (!firstModelResponseAt || row.at < firstModelResponseAt)) firstModelResponseAt = row.at;
    }
  }
  if (unattributedLearning > 0) {
    unknown.push(`${unattributedLearning} background learning call${unattributedLearning === 1 ? '' : 's'} `
      + `(${unattributedLearningTokens} tokens) ran in the same window with no request named on them. They are not in the total.`);
  }
  if (totals.uncertifiedCalls > 0) {
    unknown.push(`${totals.uncertifiedCalls} of ${totals.calls} calls did not declare how they count cached tokens; their cached share is unknown and counted as uncached.`);
  }
  if (totals.calls === 0) unknown.push('No usage rows were found for this request.');

  const progress = mine.find((event) => ['conversation_preamble', 'conversation_check_in', 'tool_called',
    'delegated_task_state', 'approval_requested', 'conversation_completed'].includes(event.type));
  const delegated = mine.find((event) => event.type === 'delegated_task_state' && event.data.phase === 'dispatched');
  return {
    sessionId, sourceUserSeq,
    window: { from, to },
    usageObservedThrough,
    participants,
    totals, byRole, byRelation,
    timeline: {
      acceptedAt: accepted?.createdAt ?? null,
      firstModelResponseAt,
      firstProgressAt: progress?.createdAt ?? null,
      delegatedAt: delegated?.createdAt ?? tasks[0]?.createdAt ?? null,
      repliedAt: reply?.createdAt ?? null,
      delegatedWorkEndedAt: tasks.length > 0 && open.length === 0
        ? tasks.map((task) => task.completedAt ?? task.updatedAt).sort().at(-1) ?? null
        : null,
    },
    unknown,
  };
}
