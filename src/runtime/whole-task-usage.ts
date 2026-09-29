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

function daysBetween(from: string, to: string): Date[] {
  const start = new Date(Date.parse(from));
  const end = new Date(Math.max(Date.parse(to), Date.parse(from)));
  const days: Date[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  // One extra day on each side: the log is written in local days and a
  // request can cross midnight.
  cursor.setDate(cursor.getDate() - 1);
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  while (cursor.getTime() <= last.getTime() && days.length < 40) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function helpersOf(
  sources: WholeTaskUsageSources,
  sessionId: string,
  sourceUserSeq: number | null,
  relation: 'helper' | 'delegated_helper',
  taskId?: string,
): TaskParticipant[] {
  const found = new Map<string, TaskParticipant>();
  for (const event of sources.events(sessionId, ['worker_started'])) {
    if (sourceUserSeq !== null && positive(event.data.sourceUserSeq) !== sourceUserSeq) continue;
    const child = typeof event.data.childSessionId === 'string' ? event.data.childSessionId.trim() : '';
    if (!child || child === sessionId) continue;
    const childSeq = positive(event.data.childSourceUserSeq);
    found.set(`${child}:${childSeq ?? ''}`, { relation, sessionId: child, ...(childSeq ? { sourceUserSeq: childSeq } : {}),
      ...(taskId ? { taskId } : {}), owner: typeof event.data.agent === 'string' ? event.data.agent : null });
  }
  return [...found.values()];
}

function rowBelongs(row: UsageEvent, participant: TaskParticipant): boolean {
  const accepted = row.trace?.acceptedSource ?? '';
  if (participant.sourceUserSeq !== undefined) {
    const exact = `${participant.sessionId}:${participant.sourceUserSeq}`;
    return accepted === exact || row.source === exact;
  }
  // A delegated task owns its whole run session.
  return row.source === participant.sessionId || row.source.startsWith(`${participant.sessionId}:`)
    || accepted.startsWith(`${participant.sessionId}:`);
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
  participants.push(...helpersOf(sources, sessionId, sourceUserSeq, 'helper'));

  const tasks = sources.tasks().filter((task) => task.originSessionId === sessionId
    && (task.delegation?.originSourceUserSeq === sourceUserSeq || task.foregroundHandoff?.sourceUserSeq === sourceUserSeq));
  for (const task of tasks) {
    participants.push({ relation: 'delegated_task', sessionId: task.runSessionId, taskId: task.id,
      owner: task.delegation?.agentName ?? null });
    participants.push(...helpersOf(sources, task.runSessionId, null, 'delegated_helper', task.id));
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
  for (const day of daysBetween(from, to)) {
    for (const row of sources.usageForDate(day)) {
      const at = Date.parse(row.at);
      if (!Number.isFinite(at) || at < fromMs - 1_000) continue;
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
