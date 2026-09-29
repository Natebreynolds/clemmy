/**
 * Who a delegated task runs as, and which project it works in.
 *
 * One decision per dispatch, made before any task exists:
 *  - a project named by the caller, otherwise the conversation's own;
 *  - an agent named by the caller, otherwise the agent the conversation is
 *    already in, otherwise the one assigned to the project that the router
 *    is sure is responsible for the task, otherwise none;
 *  - the model that agent asks for, otherwise the helper role.
 *
 * A name that is not saved is refused with the saved names listed, before
 * anything starts. An agent that is not assigned to the project is refused
 * the same way: the association is explicit, never inferred from a request.
 *
 * The result names who does the work and what they know. It grants nothing.
 */
import { resolveAgentBinding, agentModelIsRole, listAgentChoicesForRefusal } from '../agents/agent-binding.js';
import { getAgentRecord } from '../agents/agent-record.js';
import { sessionAgentState } from '../agents/session-agent-state.js';
import type { BackgroundTaskDelegation } from '../execution/background-tasks.js';
import { getSession } from '../runtime/harness/eventlog.js';
import { resolveRoleModel, type ModelRole } from '../runtime/harness/model-roles.js';
import { selectAgentForTaskWithJev, type AgentSelectCandidate } from '../runtime/jev/control-plane.js';
import { findProject, getAssignment, listAssignments, listProjects, type ProjectRecord } from './project-record.js';
import { sessionProjectState } from './session-project-state.js';

export interface TaskDelegationRequest {
  sessionId: string;
  sourceUserSeq?: number;
  objective: string;
  /** A saved agent by name or id; null or absent when the caller named none. */
  agent?: string | null;
  /** A project by id or name; null or absent for the conversation's own. */
  project?: string | null;
  artifactDestination?: string | null;
}

export type TaskDelegationResolution =
  | { kind: 'none' }
  | { kind: 'refuse'; reason: string }
  | { kind: 'bound'; delegation: BackgroundTaskDelegation; model: string | undefined };

export interface TaskDelegationDependencies {
  selectAgent?: (objective: string, candidates: readonly AgentSelectCandidate[], sessionId: string) =>
    Promise<{ id: string } | null>;
}

function projectChoices(limit = 12): string {
  const names = listProjects().slice(0, limit).map((project) => project.name);
  return names.length > 0 ? names.join(', ') : 'none yet';
}

function assignedNames(project: ProjectRecord): string {
  const names = listAssignments(project.id)
    .map((row) => getAgentRecord(row.agentId)?.name)
    .filter((name): name is string => Boolean(name));
  return names.length > 0 ? names.join(', ') : 'nobody yet';
}

export async function resolveTaskDelegation(
  request: TaskDelegationRequest,
  dependencies: TaskDelegationDependencies = {},
): Promise<TaskDelegationResolution> {
  const metadata = (() => {
    try { return getSession(request.sessionId)?.metadata ?? null; } catch { return null; }
  })();

  const namedProject = String(request.project ?? '').trim();
  let project: ProjectRecord | null = null;
  if (namedProject) {
    project = findProject(namedProject);
    if (!project || project.status !== 'active') {
      return { kind: 'refuse', reason: `"${namedProject.slice(0, 80)}" is not one of the owner's active projects, so no task started. `
        + `Active projects: ${projectChoices()}. Dispatch again with one of these, with project: null to use this conversation's own, `
        + 'or create the project first with project_save.' };
    }
  } else {
    const current = sessionProjectState(metadata).projectId;
    const found = current ? findProject(current) : null;
    project = found && found.status === 'active' ? found : null;
  }

  const namedAgent = String(request.agent ?? '').trim();
  let agentId: string | null = null;
  let assignedBy: BackgroundTaskDelegation['assignedBy'] = 'clem';
  // The agent came from the conversation rather than from the request.
  let inherited = false;
  // The conversation's own agent cannot take the task in this project.
  let ownChoiceSetAside = false;
  if (namedAgent) {
    const binding = resolveAgentBinding(namedAgent);
    if (!binding) {
      return { kind: 'refuse', reason: `"${namedAgent.slice(0, 80)}" is not one of the owner's saved agents, so no task started. `
        + `Saved agents: ${listAgentChoicesForRefusal()}. Dispatch again with one of these names, or with agent: null.` };
    }
    agentId = binding.agent.id;
  } else {
    const current = sessionAgentState(metadata);
    if (current.agentId && getAgentRecord(current.agentId)) {
      agentId = current.agentId;
      inherited = true;
      assignedBy = metadata?.agentSetBy === 'clem' ? 'clem' : 'owner';
    }
  }

  if (project && agentId && !getAssignment(project.id, agentId)) {
    const name = getAgentRecord(agentId)?.name ?? agentId;
    // The conversation's own agent was not named for this task: the task
    // goes to the project without it rather than being refused.
    if (!namedAgent) {
      agentId = null;
      inherited = false;
      ownChoiceSetAside = true;
    } else {
      return { kind: 'refuse', reason: `${name} is not assigned to the project ${project.name}, so no task started. `
        + `Assigned to it: ${assignedNames(project)}. Assign ${name} with project_save, delegate to someone assigned, `
        + 'or dispatch with project: null to run it outside the project.' };
    }
  }

  // The router suggests only when nobody was chosen. A conversation already
  // in an agent is a choice, and it is not replaced by a suggestion.
  if (project && !agentId && !ownChoiceSetAside) {
    const candidates = listAssignments(project.id).flatMap((row) => {
      const agent = getAgentRecord(row.agentId);
      if (!agent) return [];
      if (row.agentCreatedAt && agent.createdAt && row.agentCreatedAt !== agent.createdAt) return [];
      return [{ id: agent.id, name: agent.name,
        handles: [row.responsibility, agent.handles].filter(Boolean).join(' · ') }];
    });
    if (candidates.length > 0) {
      try {
        const selected = dependencies.selectAgent
          ? await dependencies.selectAgent(request.objective, candidates, request.sessionId)
          : (await selectAgentForTaskWithJev(request.objective, candidates, { sessionId: request.sessionId })).agent;
        if (selected && candidates.some((candidate) => candidate.id === selected.id)) {
          agentId = selected.id;
          assignedBy = 'router';
        }
      } catch { /* nobody chosen: the task runs in the project without an agent */ }
    }
  }

  if (!project && !agentId) return { kind: 'none' };

  const agent = agentId ? getAgentRecord(agentId) : null;
  let model: string | undefined;
  if (agent) {
    // One bounded piece of work: the model the agent asks for, otherwise the
    // owner's helper role. Both go through the owner's own model settings.
    // A task started from a conversation already in the agent keeps the model
    // such a task has always run on, unless the agent asks for its own.
    model = agent.model
      ? agentModelIsRole(agent.model)
        ? resolveRoleModel(agent.model.trim().toLowerCase() as ModelRole).modelId
        : agent.model
      : inherited ? undefined : resolveRoleModel('worker').modelId;
  }
  const destination = String(request.artifactDestination ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  return {
    kind: 'bound',
    model,
    delegation: {
      agentId: agent?.id ?? null,
      agentName: agent?.name ?? null,
      agentCreatedAt: agent?.createdAt ?? null,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      ...(destination ? { artifactDestination: destination } : {}),
      assignedBy,
      ...(typeof request.sourceUserSeq === 'number' && request.sourceUserSeq > 0
        ? { originSourceUserSeq: request.sourceUserSeq } : {}),
    },
  };
}
