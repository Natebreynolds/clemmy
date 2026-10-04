/**
 * Correcting delegated work.
 *
 * While a task is open, a correction revises that task: the same record, the
 * same run, the next version of the request, applied at the agent's next
 * model boundary. Nothing it already did is repeated.
 *
 * A task that stopped before it finished (it failed, was stopped, or was cut
 * off by a restart) is still that task. Its run holds the receipts of what it
 * already wrote, so the correction is recorded on it and it resumes in place.
 * Resuming is the owner's act: a correction relayed by the model does not
 * restart stopped work.
 *
 * Only finished work is followed. The correction becomes a task of its own:
 * the same owner, the same project, starting from what the first produced.
 * It is never done by whoever happens to be in the conversation, and the
 * finished task's record is not rewritten. A correction to work whose
 * follow-up is still open goes to that follow-up.
 */
import {
  createBackgroundTask, getBackgroundTask, listBackgroundTasks, requestBackgroundDrain, resumeBackgroundTask,
  reviseBackgroundTaskContract,
  type BackgroundTaskContractRevision, type BackgroundTaskRecord,
} from '../execution/background-tasks.js';
import { bindBackgroundRunGoal } from '../agents/plan-proposals.js';
import { getAgentRecord } from '../agents/agent-record.js';
import { agentModelIsRole } from '../agents/agent-binding.js';
import { resolveRoleModel, type ModelRole } from '../runtime/harness/model-roles.js';

export type CorrectionRefusal =
  | 'task_not_found' | 'not_delegated' | 'instruction_required' | 'stopping' | 'owner_unavailable'
  /** The task stopped before it finished and only the owner resumes it. */
  | 'resume_first'
  /** The task stopped before it finished and cannot be resumed. */
  | 'not_resumable';

export type CorrectionResult =
  | { kind: 'revised'; task: BackgroundTaskRecord; resumed: boolean }
  | { kind: 'followed'; task: BackgroundTaskRecord; follows: BackgroundTaskRecord }
  | { kind: 'refused'; reason: CorrectionRefusal };

const UNFINISHED: ReadonlySet<string> = new Set(['failed', 'aborted', 'interrupted']);

function modelFor(task: BackgroundTaskRecord): string | undefined {
  const agentId = task.delegation?.agentId;
  const agent = agentId ? getAgentRecord(agentId) : null;
  if (!agent) return task.model;
  if (!agent.model) return task.model ?? resolveRoleModel('worker').modelId;
  return agentModelIsRole(agent.model)
    ? resolveRoleModel(agent.model.trim().toLowerCase() as ModelRole).modelId
    : agent.model;
}

/** The newest task that follows this one, and the one that follows that. */
function lastInChain(task: BackgroundTaskRecord): BackgroundTaskRecord {
  let current = task;
  const seen = new Set<string>([task.id]);
  for (let hop = 0; hop < 64; hop += 1) {
    const next = listBackgroundTasks({ includeArchived: false })
      .filter((row) => row.delegation?.followsTaskId === current.id && !row.internal && !seen.has(row.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!next) return current;
    seen.add(next.id);
    current = next;
  }
  return current;
}

export function correctDelegatedTask(
  taskId: string,
  input: {
    instruction: string;
    evidencePolicy?: BackgroundTaskContractRevision['evidencePolicy'];
    sourceUserSeq?: number;
    /** Who is making the correction: the owner from a card, or the model relaying it. */
    by: 'owner' | 'clem';
  },
): CorrectionResult {
  const instruction = input.instruction.replace(/\s+/g, ' ').trim();
  if (instruction.length < 4) return { kind: 'refused', reason: 'instruction_required' };
  const named = getBackgroundTask(taskId);
  if (!named || named.internal) return { kind: 'refused', reason: 'task_not_found' };
  if (!named.delegation) return { kind: 'refused', reason: 'not_delegated' };
  const evidencePolicy = input.evidencePolicy ?? 'revalidate';

  // Finished work that was already corrected: the correction belongs to the
  // work that carries the earlier one.
  const target = named.status === 'done' ? lastInChain(named) : named;
  if (target.status === 'cancelling') return { kind: 'refused', reason: 'stopping' };
  if (target.archived && target.status !== 'done') return { kind: 'refused', reason: 'task_not_found' };

  if (UNFINISHED.has(target.status)) {
    if (input.by !== 'owner') return { kind: 'refused', reason: 'resume_first' };
    if (!resumeBackgroundTask(target.id)) return { kind: 'refused', reason: 'not_resumable' };
    const revised = reviseBackgroundTaskContract(target.id, { instruction, evidencePolicy,
      ...(typeof input.sourceUserSeq === 'number' ? { sourceUserSeq: input.sourceUserSeq } : {}),
      ...(input.by === 'owner' ? { ownerWords: instruction } : {}) });
    if (!revised) return { kind: 'refused', reason: 'not_resumable' };
    return target.id === named.id
      ? { kind: 'revised', task: revised, resumed: true }
      : { kind: 'followed', task: revised, follows: named };
  }

  if (target.status !== 'done') {
    const revised = reviseBackgroundTaskContract(target.id, { instruction, evidencePolicy,
      ...(typeof input.sourceUserSeq === 'number' ? { sourceUserSeq: input.sourceUserSeq } : {}),
      ...(input.by === 'owner' ? { ownerWords: instruction } : {}) });
    if (!revised) return { kind: 'refused', reason: 'stopping' };
    return target.id === named.id
      ? { kind: 'revised', task: revised, resumed: false }
      : { kind: 'followed', task: revised, follows: named };
  }

  // The owner of the finished work must still be there to take the correction.
  const delegation = target.delegation!;
  if (delegation.agentId) {
    const agent = getAgentRecord(delegation.agentId);
    if (!agent || (delegation.agentCreatedAt && agent.createdAt && delegation.agentCreatedAt !== agent.createdAt)) {
      return { kind: 'refused', reason: 'owner_unavailable' };
    }
  }
  const prior = [
    `Earlier request (task ${target.id}, request v${target.contractVersion ?? 1}):`,
    target.prompt,
    ...(target.contractRevisions ?? []).map((revision) => `Correction v${revision.version}: ${revision.instruction}`),
    target.resultPath ? `Its full report is saved at: ${target.resultPath}` : '',
    target.result ? `Its report began:\n${target.result.slice(0, 1_500)}` : '',
  ].filter(Boolean).join('\n');
  const title = `${target.title.replace(/ \(corrected\)$/, '')} (corrected)`;
  const follow = createBackgroundTask({
    title,
    prompt: [`Objective: apply the owner's correction to work you finished.`, '', `Correction: ${instruction}`, '', prior].join('\n'),
    originSessionId: target.originSessionId,
    userId: target.userId,
    channel: target.channel,
    reportBackTarget: target.reportBackTarget,
    source: target.source,
    maxMinutes: target.maxMinutes,
    model: modelFor(target),
    delegation: {
      ...delegation,
      followsTaskId: target.id,
      assignedBy: input.by,
      ...(typeof input.sourceUserSeq === 'number' && input.sourceUserSeq > 0 ? { originSourceUserSeq: input.sourceUserSeq } : {}),
    },
  });
  // The same goal binding every task started from a conversation gets, so the
  // follow-up's result is checked against what was asked.
  try {
    bindBackgroundRunGoal(follow.runSessionId, {
      objective: `${title}: ${instruction}`.slice(0, 600),
      originatingRequest: instruction,
      channel: target.channel,
    });
  } catch { /* the prompt carries the request; the task is never blocked on this */ }
  requestBackgroundDrain(1);
  return { kind: 'followed', task: follow, follows: named };
}
