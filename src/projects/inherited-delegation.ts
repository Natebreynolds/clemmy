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
import { getAgentRecord } from '../agents/agent-record.js';
import { sessionAgentState } from '../agents/session-agent-state.js';
import type { BackgroundTaskDelegation, BackgroundTaskRecord } from '../execution/background-tasks.js';
import { getSession } from '../runtime/harness/eventlog.js';
import { resolveDelegatedAgentModel } from './task-delegation.js';
import { getAssignment, getProject, listAssignments } from './project-record.js';
import { sessionProjectState } from './session-project-state.js';

export class InheritedAgentModelUnavailableError extends Error {}

export function inheritedTaskDelegation(
  sessionId: string | null | undefined,
  sourceUserSeq?: number,
  preserveAcceptedModel = false,
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
    // A genuine foreground handoff already carries accepted checkpoint
    // authority. Fresh inherited work freezes the saved specialist here.
    const selected = agent && !preserveAcceptedModel ? resolveDelegatedAgentModel(agent, true) : null;
    if (selected?.kind === 'refuse') throw new InheritedAgentModelUnavailableError(selected.reason);
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
      ...(selected?.kind === 'bound' && selected.executionModelPin ? { executionModelPin: selected.executionModelPin } : {}),
      ...(typeof sourceUserSeq === 'number' && Number.isSafeInteger(sourceUserSeq) && sourceUserSeq > 0
        ? { originSourceUserSeq: sourceUserSeq } : {}),
      ...(choiceIsOpen ? { agentChoice: 'open' as const } : {}),
    };
  } catch (error) {
    if (error instanceof InheritedAgentModelUnavailableError) throw error;
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
  task: Pick<BackgroundTaskRecord, 'delegation' | 'prompt' | 'originSessionId' | 'foregroundHandoff' | 'model'>,
): Promise<{ delegation: BackgroundTaskDelegation; model?: string; refusal?: string }> {
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
  const delegation = { ...decided, agentId: agent.id, agentName: agent.name, agentCreatedAt: agent.createdAt, assignedBy: 'router' as const };
  // An accepted foreground handoff retains its already-authorized model. A
  // fresh router choice must use the same saved-pin decision as named work.
  if (task.foregroundHandoff && task.model) return { delegation };
  const selected = resolveDelegatedAgentModel(agent);
  if (selected.kind === 'refuse') {
    const refusal = `The chosen agent "${agent.name}" requires its saved ${agent.model} model${selected.executionModelPin ? ` "${selected.executionModelPin.modelId}"` : ''}, which is unavailable or could not be verified. This task keeps that choice and its saved progress. Reconnect the model or change the saved agent choice, then start a new task to confirm its model authority.`;
    return { delegation: { ...delegation,
      ...(selected.executionModelPin ? { executionModelPin: selected.executionModelPin } : {}), modelBindingRefusal: refusal }, refusal };
  }
  return {
    delegation: { ...delegation, ...(selected.executionModelPin ? { executionModelPin: selected.executionModelPin } : {}) },
    model: selected.model,
  };
}
