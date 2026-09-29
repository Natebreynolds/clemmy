/**
 * Tools for projects: the durable bodies of work the owner organises, and the
 * agents assigned to them.
 *
 * These write records. They start no work and grant nothing: a task still
 * goes through dispatch, a write still goes through its own consent.
 *
 * "Project" here is never a code folder. Local code folders are the workspace
 * roster (`workspace_list`, `project_run`).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createAgentRecord, findAgentRecord, getAgentRecord } from '../agents/agent-record.js';
import { listBackgroundTasks } from '../execution/background-tasks.js';
import { loadSkill } from '../memory/skill-store.js';
import { chooseConnectedAccount } from '../projects/connected-accounts.js';
import {
  createProject, findProject, listAssignments, listAssignmentsForAgent, listProjects, listResources,
  removeAssignment, saveAssignment, saveResource, updateProject,
  type ProjectAssignment, type ProjectRecord, type ProjectResource,
} from '../projects/project-record.js';
import { setSessionProject } from '../projects/session-project.js';
import { correctDelegatedTask } from '../projects/task-follow-up.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { getSession } from '../runtime/harness/eventlog.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { textResult } from './shared.js';

/** True when the session is one the owner is talking in. */
function isConversation(sessionId: string): boolean {
  try {
    const row = getSession(sessionId);
    if (!row) return true; // no record of it: not a run the host started
    return row.kind === 'chat' && typeof row.metadata?.delegatedTaskId !== 'string';
  } catch {
    return false;
  }
}

function json(value: unknown): ReturnType<typeof textResult> {
  return textResult(JSON.stringify(value, null, 1), { maxChars: 12_000 });
}

function describeAssignment(row: ProjectAssignment): Record<string, unknown> {
  return {
    agent: getAgentRecord(row.agentId)?.name ?? row.agentId,
    responsibility: row.responsibility || null,
    ...(row.context ? { context: row.context } : {}),
    ...(row.skills.length > 0 ? { skills: row.skills } : {}),
    sharesMethodsAcrossProjects: row.shareMethods,
  };
}

function describeResource(row: ProjectResource): Record<string, unknown> {
  return row.kind === 'account'
    ? { kind: 'account', toolkit: row.toolkit, account: row.label || row.accountId, accountId: row.accountId, verified: Boolean(row.verifiedAt) }
    : { kind: row.kind, ref: row.ref, ...(row.label ? { label: row.label } : {}) };
}

/** Tasks delegated into a project, newest first, as the owner would read them. */
export function projectTaskSummaries(projectId: string, limit = 8): Array<Record<string, unknown>> {
  return listBackgroundTasks({ includeArchived: false })
    .filter((task) => task.delegation?.projectId === projectId && !task.internal)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map((task) => ({
      task: task.id, title: task.title, status: task.status,
      owner: task.delegation?.agentName ?? 'Clem',
      requestVersion: task.contractVersion ?? 1,
      updatedAt: task.updatedAt,
    }));
}

function describeProject(project: ProjectRecord): Record<string, unknown> {
  return {
    project: project.name,
    id: project.id,
    status: project.status,
    purpose: project.purpose || null,
    goals: project.goals,
    ...(project.context ? { context: project.context } : {}),
    agents: listAssignments(project.id).map(describeAssignment),
    resources: listResources(project.id).map(describeResource),
    tasks: projectTaskSummaries(project.id),
  };
}

export function registerProjectRecordTools(server: McpServer): void {
  server.tool(
    'project_list',
    'List the owner\'s projects: the ongoing bodies of work they organise, with who is assigned to each. Not code folders.',
    {},
    async () => {
      const rows = listProjects().map((project) => ({
        project: project.name, id: project.id, purpose: project.purpose || null,
        agents: listAssignments(project.id).map((row) => getAgentRecord(row.agentId)?.name ?? row.agentId),
      }));
      return rows.length > 0 ? json(rows) : textResult('No projects yet. Create one with project_save.');
    },
  );

  server.tool(
    'project_get',
    'Read one project: its purpose, goals, standing context, the agents assigned and what each answers for, the accounts and resources it uses, and the tasks delegated into it.',
    {
      project: z.string().min(1).describe('The project\'s name or id.'),
    },
    async ({ project }) => {
      const found = findProject(project);
      if (!found) {
        return json({ ok: false, code: 'project_not_found', detail: `"${project.slice(0, 80)}" is not one of the owner's active projects.`,
          projects: listProjects().slice(0, 20).map((row) => row.name) });
      }
      return json(describeProject(found));
    },
  );

  server.tool(
    'project_save',
    [
      'Create a project, or change one: its purpose, goals and standing context, the agents assigned to it, and the accounts and resources it uses.',
      'Use when the owner asks to organise ongoing work into a project, to put an agent on one, or to change what a project is for.',
      'Assigning an agent records what it answers for in THIS project and the context that applies only here; the same agent may be assigned to other projects with different context.',
      'An account is bound only if it is connected right now. When the owner did not say which account and more than one is connected, this returns the choices: ask the owner once, then call again with their answer. Never pick for them.',
      'This writes records only. It starts no work: delegate with dispatch_background_task afterwards.',
    ].join(' '),
    {
      project: z.string().nullable().describe('Name or id of the project to change. Null creates a new one from `name`.'),
      name: z.string().nullable().describe('The project\'s name. Required to create; on a change, renames it.'),
      purpose: z.string().nullable().optional().describe('What the work is for, in the owner\'s words.'),
      goals: z.array(z.string()).nullable().optional().describe('What done looks like. Replaces the list when given.'),
      context: z.string().nullable().optional().describe('Standing context all work in the project shares: its terms, what has been decided, its current state. Replaces the text when given.'),
      agents: z.array(z.object({
        agent: z.string().min(1).describe('The saved agent\'s name.'),
        responsibility: z.string().nullable().optional().describe('What this agent answers for in this project.'),
        context: z.string().nullable().optional().describe('Context that applies to this agent in this project only.'),
        skills: z.array(z.string()).nullable().optional().describe('Installed skills it should reach for in this project.'),
        share_methods: z.boolean().nullable().optional().describe('True only if the owner said what this agent learns here may be used in its other projects.'),
        remove: z.boolean().nullable().optional().describe('True to take the agent off the project.'),
        create_if_missing: z.object({
          handles: z.string().min(1).describe('One line: what the new agent handles.'),
          instructions: z.string().nullable().optional().describe('Its standing instructions.'),
        }).nullable().optional().describe('Only when the owner asked for a new agent that is not saved yet.'),
      })).nullable().optional(),
      accounts: z.array(z.object({
        toolkit: z.string().min(1).describe('The connected app the account belongs to, as the tool catalog names it.'),
        account: z.string().nullable().describe('Which account, as the owner named it (its address, label or id). Null when they did not say.'),
        replace: z.boolean().nullable().optional().describe('True only after the owner confirmed replacing the account already bound for this app.'),
      })).nullable().optional(),
      resources: z.array(z.object({
        kind: z.enum(['space', 'workflow', 'folder', 'link']),
        ref: z.string().min(1).describe('The Space\'s id, the workflow\'s name, the folder\'s path or the address.'),
        label: z.string().nullable().optional(),
      })).nullable().optional(),
      attach_conversation: z.boolean().nullable().optional().describe('Whether this conversation should work in the project from its next turn. Defaults to true when the project is created here.'),
    },
    async ({ project, name, purpose, goals, context, agents, accounts, resources, attach_conversation }) => {
      const sessionId = getToolOutputContext()?.sessionId;
      // A project is organised with the owner, in a conversation. Work that
      // runs unattended does not rewrite the project it was given.
      if (sessionId && !isConversation(sessionId)) {
        return json({ ok: false, code: 'not_in_conversation',
          detail: 'Projects are changed only in a conversation with the owner. Nothing was changed. Report what you think should change and why.' });
      }
      const wanted = String(project ?? '').trim();
      let record: ProjectRecord;
      let created = false;
      if (wanted) {
        const found = findProject(wanted);
        if (!found) {
          return json({ ok: false, code: 'project_not_found', detail: `"${wanted.slice(0, 80)}" is not one of the owner's active projects, so nothing was changed.`,
            projects: listProjects().slice(0, 20).map((row) => row.name),
            repair: 'Call project_save again with one of these, or with project: null and a name to create a new one.' });
        }
        const patch = {
          ...(typeof name === 'string' && name.trim() ? { name } : {}),
          ...(typeof purpose === 'string' ? { purpose } : {}),
          ...(Array.isArray(goals) ? { goals } : {}),
          ...(typeof context === 'string' ? { context } : {}),
        };
        const saved = Object.keys(patch).length > 0 ? updateProject(found.id, patch) : { ok: true as const, project: found, created: false };
        if (!saved.ok) return json({ ok: false, code: saved.reason, detail: 'The project was not changed.' });
        record = saved.project;
      } else {
        const saved = createProject({
          name: String(name ?? ''), purpose: purpose ?? undefined, goals: goals ?? undefined, context: context ?? undefined,
          createdFrom: 'chat', originSessionId: sessionId ?? null,
        });
        if (!saved.ok) {
          return json({ ok: false, code: saved.reason,
            detail: saved.reason === 'name_taken'
              ? `A project named "${String(name).trim().slice(0, 80)}" already exists. Pass it as \`project\` to change it, or choose another name.`
              : 'A new project needs a name.' });
        }
        record = saved.project;
        created = true;
      }

      const notes: string[] = [];
      const questions: Array<Record<string, unknown>> = [];

      for (const entry of agents ?? []) {
        let agent = findAgentRecord(entry.agent);
        if (!agent && entry.create_if_missing && !entry.remove) {
          const made = createAgentRecord({ name: entry.agent, handles: entry.create_if_missing.handles,
            instructions: entry.create_if_missing.instructions ?? '', createdFrom: 'chat' });
          if (made.ok) { agent = made.agent; notes.push(`Created the agent ${agent.name}.`); }
        }
        if (!agent) {
          notes.push(`"${entry.agent.slice(0, 80)}" is not a saved agent, so it was not assigned.`);
          continue;
        }
        if (entry.remove) {
          notes.push(removeAssignment(record.id, agent.id) ? `${agent.name} was taken off the project.` : `${agent.name} was not assigned to it.`);
          continue;
        }
        const missing = (entry.skills ?? []).filter((skill) => !loadSkill(skill));
        const saved = saveAssignment(record.id, {
          agentId: agent.id, agentCreatedAt: agent.createdAt, agentName: agent.name,
          ...(typeof entry.responsibility === 'string' ? { responsibility: entry.responsibility } : {}),
          ...(typeof entry.context === 'string' ? { context: entry.context } : {}),
          ...(Array.isArray(entry.skills) ? { skills: entry.skills.filter((skill) => !missing.includes(skill)) } : {}),
          ...(typeof entry.share_methods === 'boolean' ? { shareMethods: entry.share_methods } : {}),
        });
        if (!saved.ok) { notes.push(`${agent.name} was not assigned: ${saved.reason}.`); continue; }
        notes.push(saved.created ? `${agent.name} is assigned.` : `${agent.name}'s assignment was updated.`);
        if (missing.length > 0) notes.push(`Not installed, so not pinned for ${agent.name}: ${missing.join(', ')}.`);
        const elsewhere = listAssignmentsForAgent(agent.id).filter((row) => row.projectId !== record.id).length;
        if (elsewhere > 0) notes.push(`${agent.name} is also assigned to ${elsewhere} other project${elsewhere === 1 ? '' : 's'}; their context stays separate.`);
      }

      for (const entry of accounts ?? []) {
        let choice: Awaited<ReturnType<typeof chooseConnectedAccount>>;
        try {
          choice = await chooseConnectedAccount(entry.toolkit, entry.account);
        } catch {
          notes.push(`The connected accounts for ${entry.toolkit} could not be read, so no account was bound for it.`);
          continue;
        }
        if (choice.kind === 'not_connected') {
          notes.push(`No account is connected for ${choice.toolkit}, so none was bound.`);
          continue;
        }
        if (choice.kind === 'choose') {
          questions.push({ about: 'which_account', toolkit: choice.toolkit,
            ...(choice.named ? { named: choice.named, problem: 'that does not identify exactly one connected account' } : {}),
            choices: choice.choices.map((account) => account.label) });
          continue;
        }
        const saved = saveResource(record.id, {
          kind: 'account', toolkit: choice.account.toolkit, accountId: choice.account.accountId, label: choice.account.label,
          verifiedAt: new Date().toISOString(), verification: { against: 'live_connections', status: 'active' },
        }, { replace: entry.replace === true });
        if (saved.ok) {
          notes.push(`${choice.account.toolkit}: ${choice.account.label} is bound.`);
        } else if (saved.reason === 'conflicting_account') {
          questions.push({ about: 'replace_account', toolkit: choice.account.toolkit,
            bound: saved.conflict?.label || saved.conflict?.accountId, asked: choice.account.label });
        } else {
          notes.push(`${choice.account.toolkit} was not bound: ${saved.reason}.`);
        }
      }

      for (const entry of resources ?? []) {
        const saved = saveResource(record.id, { kind: entry.kind, ref: entry.ref, label: entry.label ?? undefined });
        notes.push(saved.ok ? `${entry.kind} ${entry.ref} is ${saved.created ? 'attached' : 'already attached'}.` : `${entry.kind} ${entry.ref} was not attached: ${saved.reason}.`);
      }

      const attach = attach_conversation ?? created;
      if (attach && sessionId) {
        const pointed = setSessionProject(sessionId, record.id, { by: 'clem' });
        if (pointed.ok && pointed.changed) notes.push('This conversation works in the project from its next turn.');
      }

      const current = findProject(record.id) ?? record;
      return json({
        ok: true,
        ...(created ? { created: true } : {}),
        ...describeProject(current),
        ...(notes.length > 0 ? { notes } : {}),
        ...(questions.length > 0
          ? { askTheOwner: questions,
              next: 'Ask the owner these in ONE message, then call project_save again with their answers. Bind nothing they did not choose.' }
          : {}),
      });
    },
  );

  server.tool(
    'delegated_task_correct',
    [
      'Give the owner\'s change or correction to a delegated task, by its id. The task\'s own agent applies it, in the task\'s project, starting from what the task already did.',
      'A task that is still open takes it as the next version of its request. A task that has finished is followed by a new task for the same agent. A task that stopped before it finished is resumed only by the owner, from its card.',
      'Use this whenever the owner changes or corrects work that was delegated. Do not redo that work in the conversation.',
    ].join(' '),
    {
      id: z.string().min(1).describe('The delegated task\'s id, as listed under Delegated Work or returned when it was started.'),
      instruction: z.string().min(4).describe('The owner\'s change, in their terms, complete enough to act on without this conversation.'),
      evidence_policy: z.enum(['preserve', 'revalidate', 'invalidate']).nullable().optional()
        .describe('How what the task already found should be treated. Omit to have it checked again.'),
    },
    async ({ id, instruction, evidence_policy }) => {
      const sessionId = getToolOutputContext()?.sessionId;
      if (sessionId && !isConversation(sessionId)) {
        return json({ ok: false, code: 'not_in_conversation',
          detail: 'Delegated work is corrected from a conversation with the owner. Nothing was changed.' });
      }
      const sourceUserSeq = harnessRunContextStorage.getStore()?.sourceUserSeq;
      const corrected = correctDelegatedTask(id, {
        instruction, evidencePolicy: evidence_policy ?? 'revalidate', by: 'clem',
        ...(typeof sourceUserSeq === 'number' ? { sourceUserSeq } : {}),
      });
      if (corrected.kind === 'refused') {
        const detail: Record<typeof corrected.reason, string> = {
          task_not_found: 'No task has that id. Use an id listed under Delegated Work.',
          not_delegated: 'That task was not delegated to anyone, so there is no owner to correct it.',
          instruction_required: 'Say what should change.',
          stopping: 'The task is being stopped. It can be corrected once it has stopped.',
          owner_unavailable: 'The agent that did this work is no longer saved, so the correction was handed to nobody. Ask the owner who should take it.',
          resume_first: 'The task stopped before it finished, and only the owner resumes stopped work. Nothing was changed and nothing was started. Tell the owner it did not finish, and that correcting it from its card resumes it in place with the correction.',
          not_resumable: 'The task stopped before it finished and cannot be resumed. Nothing was changed.',
        };
        return json({ ok: false, code: corrected.reason, detail: detail[corrected.reason],
          next: 'Tell the owner this. Do not do the task\'s work yourself.' });
      }
      const owner = corrected.task.delegation?.agentName ?? 'Clem';
      const project = corrected.task.delegation?.projectName ?? null;
      return json({
        ok: true,
        applied: corrected.kind,
        task: corrected.task.id,
        ...(corrected.kind === 'followed' ? { follows: corrected.follows.id } : {}),
        owner,
        ...(project ? { project } : {}),
        requestVersion: corrected.task.contractVersion ?? 1,
        next: corrected.kind === 'followed'
          ? `${owner} has the correction as task ${corrected.task.id}, which follows the finished one and starts from what it produced. It reports back here when it is done. Tell the owner that in one or two sentences and stop: do not do the corrected work yourself.`
          : `${owner} applies the correction at its next step, on the same task. Tell the owner that in one or two sentences and stop: do not do the corrected work yourself.`,
      });
    },
  );
}
