/**
 * What a task takes from the conversation it was started in, when nothing
 * was said about who should do it: the conversation's project, and the
 * conversation's own agent when that agent is assigned to the project (or
 * when there is no project). Nobody is chosen here; the router is asked
 * only where a caller delegates on purpose.
 *
 * Every path that moves a conversation's work into the background comes
 * through one place, and that place asks this. Without it, work the owner
 * started inside a project ran outside it: as Clem, with no project context,
 * and what it learned was kept for everywhere.
 */
import { agentModelIsRole } from '../agents/agent-binding.js';
import { getAgentRecord } from '../agents/agent-record.js';
import { sessionAgentState } from '../agents/session-agent-state.js';
import type { BackgroundTaskDelegation, BackgroundTaskRecord } from '../execution/background-tasks.js';
import { getSession } from '../runtime/harness/eventlog.js';
import { resolveRoleModel, type ModelRole } from '../runtime/harness/model-roles.js';
import { getAssignment, getProject, listAssignments } from './project-record.js';
import { sessionProjectState } from './session-project-state.js';

export function inheritedTaskDelegation(
  sessionId: string | null | undefined,
  sourceUserSeq?: number,
): BackgroundTaskDelegation | null {
  if (!sessionId) return null;
  try {
    const row = getSession(sessionId);
    if (!row || row.kind !== 'chat') return null;
    const metadata = row.metadata ?? {};
    const projectId = sessionProjectState(metadata).projectId;
    const found = projectId ? getProject(projectId) : null;
    const project = found && found.status === 'active' ? found : null;
    const current = sessionAgentState(metadata);
    const saved = current.agentId ? getAgentRecord(current.agentId) : null;
    const agent = saved && (!project || getAssignment(project.id, saved.id)) ? saved : null;
    if (!project && !agent) return null;
    // The conversation is in an agent of its own that cannot take work in
    // this project: that was a choice, and nobody is suggested in its place.
    const choiceIsOpen = Boolean(project) && !saved && assignedAgents(project!.id).length > 0;
    return {
      agentId: agent?.id ?? null,
      agentName: agent?.name ?? null,
      agentCreatedAt: agent?.createdAt ?? null,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      assignedBy: agent && metadata.agentSetBy !== 'clem' ? 'owner' : 'clem',
      ...(typeof sourceUserSeq === 'number' && Number.isSafeInteger(sourceUserSeq) && sourceUserSeq > 0
        ? { originSourceUserSeq: sourceUserSeq } : {}),
      ...(choiceIsOpen ? { agentChoice: 'open' as const } : {}),
    };
  } catch {
    return null;
  }
}

interface Candidate { id: string; name: string; handles: string; createdAt: string | null; model: string | null | undefined }

function assignedAgents(projectId: string): Candidate[] {
  return listAssignments(projectId).flatMap((row) => {
    const agent = getAgentRecord(row.agentId);
    if (!agent) return [];
    if (row.agentCreatedAt && agent.createdAt && row.agentCreatedAt !== agent.createdAt) return [];
    return [{ id: agent.id, name: agent.name, createdAt: agent.createdAt, model: agent.model,
      handles: [row.responsibility, agent.handles].filter(Boolean).join(' · ') }];
  });
}

type AgentChooser = (objective: string, candidates: readonly Candidate[], sessionId: string | undefined) => Promise<{ id: string } | null>;
let chooserForTests: AgentChooser | null = null;

/** Test seam. Null restores the router. */
export function _setOpenAgentChooserForTests(chooser: AgentChooser | null): void {
  chooserForTests = chooser;
}

/**
 * Decide, once, who a task with an open choice belongs to: the agent assigned
 * to its project that the router is sure is responsible for it, or nobody.
 * Either way the choice is closed, so a resumed task is never asked again.
 */
export async function settleOpenAgentChoice(
  task: Pick<BackgroundTaskRecord, 'delegation' | 'prompt' | 'originSessionId'>,
): Promise<{ delegation: BackgroundTaskDelegation; model?: string }> {
  const { agentChoice: _closed, ...decided } = task.delegation!;
  void _closed;
  if (decided.agentId || !decided.projectId) return { delegation: decided };
  const candidates = assignedAgents(decided.projectId);
  if (candidates.length === 0) return { delegation: decided };
  let chosen: { id: string } | null = null;
  try {
    if (chooserForTests) {
      chosen = await chooserForTests(task.prompt, candidates, task.originSessionId);
    } else {
      const { selectAgentForTaskWithJev } = await import('../runtime/jev/control-plane.js');
      chosen = (await selectAgentForTaskWithJev(task.prompt, candidates, { sessionId: task.originSessionId })).agent;
    }
  } catch {
    chosen = null;
  }
  const agent = chosen ? candidates.find((candidate) => candidate.id === chosen!.id) ?? null : null;
  if (!agent) return { delegation: decided };
  // One bounded piece of work: the model the agent asks for, otherwise the
  // owner's helper role, as for work delegated to it by name.
  const model = agent.model
    ? agentModelIsRole(agent.model)
      ? resolveRoleModel(agent.model.trim().toLowerCase() as ModelRole).modelId
      : agent.model
    : resolveRoleModel('worker').modelId;
  return {
    delegation: { ...decided, agentId: agent.id, agentName: agent.name, agentCreatedAt: agent.createdAt, assignedBy: 'router' },
    model,
  };
}
