/**
 * The tasks a conversation handed off, as the thread shows them.
 *
 * The task's record is the truth (lib/projects). A `delegated_task_state`
 * event on the conversation's stream is only a nudge to read the record
 * again; while a task is still open the record is also re-read on a slow
 * timer, so a missed event cannot leave a card stale.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { delegatedTaskOpen, delegatedTaskOwner, orderDelegatedTasks } from '@clem/chat-engine';
import { listConversationTasks, projectKeys, type DelegatedTask } from './projects';

/** What a thread needs from one of its messages to place a task beside it. */
export interface TaskBearingMessage {
  id: string;
  /** The live strip over a background run carries the run's task id. */
  delegated?: { taskId?: string };
  /** A report-back names the task it reports on. */
  taskRef?: { id: string };
}

/**
 * The cards a thread draws under its messages: every task still open, and
 * any that ended while this view was open (`watched`), so the owner sees
 * where it landed. A task that ended before the conversation was opened is
 * already in the thread as its report.
 */
export function threadTaskCards(tasks: readonly DelegatedTask[], watched: ReadonlySet<string>): DelegatedTask[] {
  return orderDelegatedTasks(tasks.filter((task) => delegatedTaskOpen(task) || watched.has(task.taskId)));
}

/** The ids of the tasks this conversation delegated: the live strip over
 *  any of them is replaced by that task's card. */
export function delegatedTaskIds(tasks: readonly DelegatedTask[]): Set<string> {
  return new Set(tasks.map((task) => task.taskId));
}

/** Who a report-back is from: the agent that owned the task, when one did.
 *  Undefined leaves the thread's own speaker in place. */
export function reportOwner(message: TaskBearingMessage, tasks: readonly DelegatedTask[]): string | undefined {
  const id = message.taskRef?.id;
  if (!id) return undefined;
  const task = tasks.find((row) => row.taskId === id);
  return task?.owner.agentId ? delegatedTaskOwner(task) : undefined;
}

/** True when the thread already holds the task's report, so a card beside it
 *  does not repeat the result. */
export function reportInThread(taskId: string, messages: readonly TaskBearingMessage[]): boolean {
  return messages.some((message) => message.taskRef?.id === taskId);
}

export function useConversationTasks(sessionId: string | null | undefined, tick: number) {
  const qc = useQueryClient();
  const key = projectKeys.sessionTasks(sessionId ?? 'none');
  const query = useQuery({
    queryKey: key,
    queryFn: () => listConversationTasks(sessionId as string),
    enabled: Boolean(sessionId),
    staleTime: 0,
    retry: 1,
    refetchInterval: (current) => ((current.state.data ?? []).some(delegatedTaskOpen) ? 15_000 : false),
  });
  // Each change of state on the stream re-reads the records.
  useEffect(() => {
    if (sessionId && tick > 0) void qc.invalidateQueries({ queryKey: projectKeys.sessionTasks(sessionId) });
  }, [qc, sessionId, tick]);

  const tasks = useMemo(() => query.data ?? [], [query.data]);
  // Tasks seen open in this view stay on screen after they end.
  const watchedRef = useRef(new Set<string>());
  for (const task of tasks) if (delegatedTaskOpen(task)) watchedRef.current.add(task.taskId);

  const refresh = () => { if (sessionId) void qc.invalidateQueries({ queryKey: projectKeys.sessionTasks(sessionId) }); };
  return {
    tasks,
    cards: threadTaskCards(tasks, watchedRef.current),
    ownedIds: useMemo(() => delegatedTaskIds(tasks), [tasks]),
    refresh,
  };
}
