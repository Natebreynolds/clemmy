/**
 * Binding a project into work.
 *
 * One rendering, used wherever a project's context enters a model call: a
 * chat turn inside the project, a task delegated inside it, the reviewer of
 * either. It carries what the work is for, what has been decided, which
 * accounts and resources the project uses, who is assigned, and, when the
 * work runs as an assigned agent, that agent's part in this project.
 *
 * It informs. It never widens what a turn may do: an account named here is
 * still re-checked where it is used, and every gate downstream runs as it
 * would for work outside any project.
 *
 * Only this project's record is read. Another project's purpose, context or
 * assignments never enter the text, whichever agent the work runs as.
 */
import { createHash } from 'node:crypto';
import { loadSkill } from '../memory/skill-store.js';
import { getAgentRecord } from '../agents/agent-record.js';
import {
  getAssignment, getProject, listAssignments, listResources,
  type ProjectAssignment, type ProjectRecord, type ProjectResource,
} from './project-record.js';

/** Bytes of skill text an assignment may pin into a prompt in total. */
export const ASSIGNMENT_SKILL_CONTEXT_MAX_CHARS = 12_000;

export interface ProjectBinding {
  project: ProjectRecord;
  /** The assignment of the agent the work runs as, when it has one here. */
  assignment: ProjectAssignment | null;
  resources: ProjectResource[];
  /** Standing context text for the system prefix. Stable until the project,
   * its resources or the assignment change. */
  context: string;
  /** Skills the assignment pinned in, in order. */
  pinnedSkills: string[];
  missingSkills: string[];
  /** Names the exact context that was rendered. Changes whenever it does. */
  revision: string;
}

function describeResource(resource: ProjectResource): string {
  // No date: this text is part of the stable prefix, and a date would change
  // it every time the same account is confirmed again.
  const verified = resource.verifiedAt ? 'verified' : 'not verified';
  if (resource.kind === 'account') {
    return `- account for ${resource.toolkit}: ${resource.label || resource.accountId} (${resource.accountId}; ${verified})`;
  }
  return `- ${resource.kind}: ${resource.label ? `${resource.label} (${resource.ref})` : resource.ref}`;
}

/** An assignment written for an agent that has since been replaced under the
 * same id belongs to the earlier agent. */
function assignmentOf(projectId: string, agentId: string | null | undefined): ProjectAssignment | null {
  if (!agentId) return null;
  const assignment = getAssignment(projectId, agentId);
  if (!assignment) return null;
  const agent = getAgentRecord(agentId);
  if (!agent) return null;
  if (assignment.agentCreatedAt && agent.createdAt && assignment.agentCreatedAt !== agent.createdAt) return null;
  return assignment;
}

export function bindProject(project: ProjectRecord, options: { agentId?: string | null } = {}): ProjectBinding {
  const resources = listResources(project.id);
  const assignment = assignmentOf(project.id, options.agentId);
  const assigned = listAssignments(project.id);

  const lines: string[] = [`## Project: ${project.name}`];
  if (project.purpose) lines.push(`Purpose: ${project.purpose}`);
  if (project.goals.length > 0) lines.push('Goals:', ...project.goals.map((goal) => `- ${goal}`));
  if (project.context) lines.push('', project.context);
  if (resources.length > 0) {
    lines.push(
      '',
      'Accounts and resources this project uses. When the work needs an account for one of these, use the one named; '
        + 'if the request plainly names a different one, ask which is meant once instead of choosing:',
      ...resources.map(describeResource),
    );
  }
  const others = assigned.filter((row) => row.agentId !== assignment?.agentId);
  if (others.length > 0) {
    lines.push('', assignment ? 'Others assigned to this project:' : 'Agents assigned to this project:');
    for (const row of others) {
      const name = getAgentRecord(row.agentId)?.name;
      if (!name) continue;
      lines.push(`- ${name}${row.responsibility ? `: ${row.responsibility}` : ''}`);
    }
  }

  const pinnedSkills: string[] = [];
  const missingSkills: string[] = [];
  if (assignment) {
    lines.push('', '### Your part in this project');
    if (assignment.responsibility) lines.push(`Responsible for: ${assignment.responsibility}`);
    if (assignment.context) lines.push('', assignment.context);
    const blocks: string[] = [];
    let budget = ASSIGNMENT_SKILL_CONTEXT_MAX_CHARS;
    for (const name of assignment.skills) {
      const skill = loadSkill(name);
      if (!skill) { missingSkills.push(name); continue; }
      const body = skill.body.trim();
      pinnedSkills.push(name);
      if (!body) continue;
      const slice = body.length > budget ? `${body.slice(0, Math.max(0, budget))}\n[skill text cut here; read the rest with skill_read]` : body;
      budget -= slice.length;
      blocks.push(`#### Skill: ${name}\n${slice}`);
      if (budget <= 0) break;
    }
    if (missingSkills.length > 0) {
      lines.push(`\nSkills this assignment names that are not installed: ${missingSkills.join(', ')}. Say so if they were needed.`);
    }
    if (blocks.length > 0) lines.push('', ...blocks);
  }
  lines.push('', 'What is learned in this project is kept for this project. Being in a project changes what you know, not what you may do.');

  const context = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    project, assignment, resources, context, pinnedSkills, missingSkills,
    revision: createHash('sha256').update(context).digest('hex').slice(0, 16),
  };
}

/** Resolve a binding by project id. Null for an unknown or archived project. */
export function resolveProjectBinding(
  projectId: string | null | undefined,
  options: { agentId?: string | null } = {},
): ProjectBinding | null {
  const project = getProject(projectId);
  if (!project || project.status !== 'active') return null;
  return bindProject(project, options);
}
