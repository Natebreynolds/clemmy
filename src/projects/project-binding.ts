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
import { describeLocalProjectOffers, localProjectOffers } from './local-project-offers.js';
import {
  getAssignment, getProject, listAssignments, listResources,
  type ProjectAssignment, type ProjectRecord, type ProjectResource,
} from './project-record.js';
import { sessionProjectState } from './session-project-state.js';
import { getSession } from '../runtime/harness/eventlog.js';

/** Bytes of skill text an assignment may pin into a prompt in total. */
export const ASSIGNMENT_SKILL_CONTEXT_MAX_CHARS = 12_000;

export interface ProjectBinding {
  project: ProjectRecord;
  /** The assignment of the agent the work runs as, when it has one here. */
  assignment: ProjectAssignment | null;
  resources: ProjectResource[];
  /** Standing context text for the system prefix. Stable until the project,
   * its resources, the assignment, or what a linked local project offers
   * change. */
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
  if (resource.kind === 'folder') {
    // Where this project's work on files and code happens.
    return [
      `- local project: ${resource.label ? `${resource.label} at ${resource.ref}` : resource.ref}`,
      ...describeLocalProjectOffers(localProjectOffers(resource.ref)),
    ].join('\n');
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

export function bindProject(project: ProjectRecord, options: { agentId?: string | null; role?: 'worker' } = {}): ProjectBinding {
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

  const lead = assigned.find((row) => row.lead);
  const leadName = lead ? getAgentRecord(lead.agentId)?.name : undefined;
  if (options.role === 'worker') {
    lines.push('', 'You are doing one item of a job in this project. Use its folder, procedures and accounts above; '
      + 'return your item to the run that started you.');
  } else if (lead && leadName && lead.agentId === assignment?.agentId) {
    lines.push('', '### You lead this project',
      'Whole jobs here are yours to run. Plan the job, split it into pieces that each fit one worker, and run workers for '
        + 'them with run_worker (several items at once where they are independent); give each worker the project files and '
        + 'procedures it needs. Gathering is worker work too: searches, data pulls and scrapes run in workers, so the raw data '
        + 'stays out of your context and your own calls go to planning, checking what comes back and the final write-up. '
        + 'Check in at real decisions and when a wave finishes, then deliver the finished work.');
  } else if (lead && leadName) {
    lines.push('', `### ${leadName} leads this project`,
      'Do quick work yourself: answer, look something up, or make a small change to a file. '
        + `Hand a whole job in this project to ${leadName} with dispatch_background_task (agent ${leadName}, this project): `
        + `${leadName} plans it, runs its own workers, and checks in here. A change to work ${leadName} is doing or did goes to that task.`);
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

/**
 * The project a worker's parent works in, as the worker's own context. A
 * worker started by a project's lead, or by Clem inside a project, works with
 * the same folder, procedures and accounts. Empty when the parent is in none.
 */
export function projectContextForWorker(parentSessionId: string | null | undefined, agentId: string | null | undefined): string {
  if (!parentSessionId) return '';
  try {
    const { projectId } = sessionProjectState(getSession(parentSessionId)?.metadata ?? null);
    const project = projectId ? getProject(projectId) : null;
    if (!project || project.status !== 'active') return '';
    return bindProject(project, { agentId: agentId ?? null, role: 'worker' }).context;
  } catch { return ''; }
}
