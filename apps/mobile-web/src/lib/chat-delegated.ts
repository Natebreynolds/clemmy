/**
 * Delegated tasks inside a conversation.
 *
 * The task view the Mac returns is the truth; the stream only says that
 * something about a task changed. The shared engine folds each
 * `delegated_task_state` event into one activity row per task, so this module
 * reads those rows for two things and nothing else:
 *   - a signature that changes whenever any task's row changed, which is the
 *     nudge to fetch the task views again;
 *   - where in the thread a task was handed over, so its card sits there and
 *     does not move as the task progresses.
 */
import { delegatedTaskOpen, delegatedTaskRowId, type DelegatedTaskPhase } from '@clem/chat-engine';

interface RowLike { id: string; status?: string; detail?: string; label?: string }
interface MessageLike { id: string; role: 'user' | 'assistant'; activity?: readonly RowLike[] }

const ROW_PREFIX = 'delegated-';

function delegatedRows(message: MessageLike): RowLike[] {
  return (message.activity ?? []).filter((row) => typeof row.id === 'string' && row.id.startsWith(ROW_PREFIX));
}

/**
 * Empty when the conversation never delegated anything, so an ordinary chat
 * asks the Mac for nothing extra. Otherwise it changes exactly when a task's
 * row did.
 */
export function delegatedRowsSignature(messages: readonly MessageLike[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    for (const row of delegatedRows(message)) {
      parts.push(`${message.id}/${row.id}/${row.status ?? ''}/${row.detail ?? ''}`);
    }
  }
  return parts.join('|');
}

export interface PlacedTasks<T> {
  /** Message id to the tasks handed over in that reply, in the order given. */
  byMessage: Map<string, T[]>;
  /** Tasks of this conversation with no reply on screen that names them. */
  unplaced: T[];
}

/**
 * Each task once, under the FIRST reply that names it. A later reply can name
 * the same task again (it finished during another exchange); the card stays
 * where the work was handed over and shows where the task stands now.
 *
 * A task that corrects a finished one sits directly after the task it
 * follows, wherever that is, so a correction and its result read together.
 */
export function placeDelegatedTasks<T extends { taskId: string; followsTaskId?: string | null }>(
  messages: readonly MessageLike[],
  tasks: readonly T[],
): PlacedTasks<T> {
  const firstMention = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const row of delegatedRows(message)) {
      if (!firstMention.has(row.id)) firstMention.set(row.id, message.id);
    }
  }
  const unique: T[] = [];
  const byId = new Map<string, T>();
  for (const task of tasks) {
    if (!task.taskId || byId.has(task.taskId)) continue;
    byId.set(task.taskId, task);
    unique.push(task);
  }
  // A follow-up is drawn with the task it follows, when that task is here.
  const followers = new Map<string, T[]>();
  const leads: T[] = [];
  for (const task of unique) {
    const parent = typeof task.followsTaskId === 'string' ? task.followsTaskId : '';
    if (parent && parent !== task.taskId && byId.has(parent)) {
      followers.set(parent, [...(followers.get(parent) ?? []), task]);
    } else {
      leads.push(task);
    }
  }
  const chain = (task: T, seen = new Set<string>()): T[] => {
    if (seen.has(task.taskId)) return [];
    seen.add(task.taskId);
    return [task, ...(followers.get(task.taskId) ?? []).flatMap((next) => chain(next, seen))];
  };
  const byMessage = new Map<string, T[]>();
  const unplaced: T[] = [];
  const drawn = new Set<string>();
  for (const lead of leads) {
    const rowId = delegatedTaskRowId(lead.taskId);
    const messageId = rowId ? firstMention.get(rowId) : undefined;
    const group = chain(lead);
    for (const task of group) drawn.add(task.taskId);
    if (!messageId) unplaced.push(...group);
    else byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), ...group]);
  }
  // Two tasks that each claim to follow the other still get drawn.
  for (const task of unique) if (!drawn.has(task.taskId)) unplaced.push(task);
  return { byMessage, unplaced };
}

/**
 * True while any task can still change on its own: waiting to start, working,
 * stopping, paused, or waiting on the owner (who may answer it on the Mac).
 */
export function anyTaskCanMove(tasks: ReadonlyArray<{ phase: DelegatedTaskPhase }>): boolean {
  return tasks.some((task) => delegatedTaskOpen(task));
}

/** How often the task views are read while a conversation is on screen. */
export const CONVERSATION_TASKS_POLL_MS = 8_000;

/**
 * The stream is closed between turns, so it cannot be what tells a
 * conversation that a task moved. While one can, the views are read on a
 * timer; once every task has ended there is nothing to wait for and the
 * timer stops (0). A wake or a new delegated row still reads again.
 */
export function conversationTasksPollMs(anyCanMove: boolean): number {
  return anyCanMove ? CONVERSATION_TASKS_POLL_MS : 0;
}
