/**
 * What a turn is told about work that was delegated from its conversation,
 * or that belongs to the project the conversation works in: which task, who
 * owns it, where it stands, and where its result is.
 *
 * Read from the task records each turn. It is what lets a correction reach
 * the owner of the work instead of being redone by whoever is in the
 * conversation, and what lets a later question find the result without
 * searching for it.
 */
import { listBackgroundTasks, type BackgroundTaskRecord } from '../execution/background-tasks.js';
import { getSession } from '../runtime/harness/eventlog.js';
import { sessionProjectState } from './session-project-state.js';
import { RETAINED_WORK_TERMINAL_HEADER } from '../runtime/harness/retained-work-checkpoint.js';

const SHOWN = 4;
const RECENT_MS = 14 * 24 * 60 * 60 * 1000;

function standing(task: BackgroundTaskRecord): string {
  switch (task.status) {
    case 'done': return 'finished';
    case 'pending': return 'waiting to start';
    case 'running': return 'working';
    case 'cancelling': return 'stopping';
    case 'awaiting_input': return 'waiting on the owner\'s answer';
    case 'awaiting_approval': return 'waiting on the owner\'s approval';
    case 'aborted': return 'stopped before it finished';
    case 'interrupted': return 'cut off before it finished';
    case 'failed': return 'did not finish';
    default: return 'paused';
  }
}

const STOPPED: ReadonlySet<string> = new Set(['blocked', 'failed', 'aborted', 'interrupted']);

/** Why it stopped, without the saved-work handles that follow the reason. */
function stopReason(text: string): string {
  const cut = text.indexOf(RETAINED_WORK_TERMINAL_HEADER);
  return (cut >= 0 ? text.slice(0, cut) : text).replace(/\s+/g, ' ').trim().slice(0, 200);
}

function line(task: BackgroundTaskRecord): string {
  const delegation = task.delegation!;
  const owner = delegation.agentName ?? 'Clem';
  const where = delegation.projectName ? ` in ${delegation.projectName}` : '';
  const version = (task.contractVersion ?? 1) > 1 ? `, request v${task.contractVersion}` : '';
  const follows = delegation.followsTaskId ? `, follows ${delegation.followsTaskId}` : '';
  // Where the work lands is known from the start, so a question or a change
  // about it can name the output even while the task is paused or stopped.
  const result = task.status === 'done'
    ? [delegation.artifactDestination ? `result at: ${delegation.artifactDestination}` : '',
      task.resultPath ? `full report: ${task.resultPath}` : '',
      task.result ? `report began: ${task.result.replace(/\s+/g, ' ').trim().slice(0, 240)}` : ''].filter(Boolean).join('; ')
    : [delegation.artifactDestination ? `Its output goes to: ${delegation.artifactDestination} (may be partial)` : '',
      STOPPED.has(task.status) && task.error && stopReason(task.error) ? `stopped because: ${stopReason(task.error)}` : ''].filter(Boolean).join('; ');
  return `- ${task.id} "${task.title.slice(0, 100)}": ${owner}${where}, ${standing(task)}${version}${follows}${result ? `. ${result}` : ''}`;
}

export function delegatedWorkPointers(sessionId: string | null | undefined, now = Date.now()): string {
  if (!sessionId) return '';
  try {
    const row = getSession(sessionId);
    if (!row || row.kind !== 'chat') return '';
    const projectId = sessionProjectState(row.metadata ?? {}).projectId;
    const tasks = listBackgroundTasks({ includeArchived: false })
      .filter((task) => task.delegation && !task.internal
        && (task.originSessionId === sessionId || (projectId !== null && task.delegation.projectId === projectId))
        && now - Date.parse(task.updatedAt) < RECENT_MS)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, SHOWN);
    if (tasks.length === 0) return '';
    return [
      '[DELEGATED WORK: each task below has an owner. When the owner of this conversation changes or corrects one, hand the change to the task: delegated_task_correct with id (the task id below) and instruction (the change). Its owner applies it, starting from what is already done. Do not redo a task\'s work in the conversation unless the owner asks you to do it here yourself; then do it here. A question about a result is answered from the result.]',
      ...tasks.map(line),
    ].join('\n');
  } catch {
    return '';
  }
}
