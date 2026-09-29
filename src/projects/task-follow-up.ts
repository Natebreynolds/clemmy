/**
 * Correcting delegated work.
 *
 * While a task is open, a correction revises that task: the same record, the
 * same run, the next version of the request, applied at the agent's next
 * model boundary. Nothing it already did is repeated.
 *
 * When the task has already ended there is nothing to revise. The correction
 * becomes a task of its own that follows the finished one: the same owner,
 * the same project, starting from what the first produced. It is never done
 * by whoever happens to be in the conversation, and the finished task's
 * record is not rewritten.
 */
import {
  createBackgroundTask, getBackgroundTask, requestBackgroundDrain, reviseBackgroundTaskContract,
  type BackgroundTaskContractRevision, type BackgroundTaskRecord,
} from '../execution/background-tasks.js';
import { getAgentRecord } from '../agents/agent-record.js';
import { agentModelIsRole } from '../agents/agent-binding.js';
import { resolveRoleModel, type ModelRole } from '../runtime/harness/model-roles.js';

export type CorrectionResult =
  | { kind: 'revised'; task: BackgroundTaskRecord }
  | { kind: 'followed'; task: BackgroundTaskRecord; follows: BackgroundTaskRecord }
  | { kind: 'refused'; reason: 'task_not_found' | 'not_delegated' | 'instruction_required' | 'stopping' | 'owner_unavailable' };

const ENDED: ReadonlySet<string> = new Set(['done', 'failed', 'aborted', 'interrupted']);

function modelFor(task: BackgroundTaskRecord): string | undefined {
  const agentId = task.delegation?.agentId;
  const agent = agentId ? getAgentRecord(agentId) : null;
  if (!agent) return task.model;
  if (!agent.model) return resolveRoleModel('worker').modelId;
  return agentModelIsRole(agent.model)
    ? resolveRoleModel(agent.model.trim().toLowerCase() as ModelRole).modelId
    : agent.model;
}

export function correctDelegatedTask(
  taskId: string,
  input: { instruction: string; evidencePolicy?: BackgroundTaskContractRevision['evidencePolicy']; sourceUserSeq?: number },
): CorrectionResult {
  const instruction = input.instruction.replace(/\s+/g, ' ').trim();
  if (instruction.length < 4) return { kind: 'refused', reason: 'instruction_required' };
  const task = getBackgroundTask(taskId);
  if (!task || task.internal) return { kind: 'refused', reason: 'task_not_found' };
  if (!task.delegation) return { kind: 'refused', reason: 'not_delegated' };
  if (task.status === 'cancelling') return { kind: 'refused', reason: 'stopping' };

  if (!ENDED.has(task.status) && !task.archived) {
    const revised = reviseBackgroundTaskContract(taskId, { instruction, evidencePolicy: input.evidencePolicy ?? 'revalidate' });
    if (revised) return { kind: 'revised', task: revised };
  }
  const latest = getBackgroundTask(taskId) ?? task;
  if (!ENDED.has(latest.status)) return { kind: 'refused', reason: 'stopping' };

  // The owner of the finished work must still be there to take the correction.
  const delegation = latest.delegation!;
  if (delegation.agentId) {
    const agent = getAgentRecord(delegation.agentId);
    if (!agent || (delegation.agentCreatedAt && agent.createdAt && delegation.agentCreatedAt !== agent.createdAt)) {
      return { kind: 'refused', reason: 'owner_unavailable' };
    }
  }
  const prior = [
    `Earlier request (task ${latest.id}, request v${latest.contractVersion ?? 1}):`,
    latest.prompt,
    ...(latest.contractRevisions ?? []).map((revision) => `Correction v${revision.version}: ${revision.instruction}`),
    latest.resultPath ? `Its full report is saved at: ${latest.resultPath}` : '',
    latest.result ? `Its report began:\n${latest.result.slice(0, 1_500)}` : '',
  ].filter(Boolean).join('\n');
  const follow = createBackgroundTask({
    title: `${latest.title} (corrected)`,
    prompt: [`Objective: apply the owner's correction to work you finished.`, '', `Correction: ${instruction}`, '', prior].join('\n'),
    originSessionId: latest.originSessionId,
    userId: latest.userId,
    channel: latest.channel,
    reportBackTarget: latest.reportBackTarget,
    source: latest.source,
    maxMinutes: latest.maxMinutes,
    model: modelFor(latest),
    delegation: {
      ...delegation,
      followsTaskId: latest.id,
      assignedBy: 'owner',
      ...(typeof input.sourceUserSeq === 'number' && input.sourceUserSeq > 0 ? { originSourceUserSeq: input.sourceUserSeq } : {}),
    },
  });
  requestBackgroundDrain(1);
  return { kind: 'followed', task: follow, follows: latest };
}
