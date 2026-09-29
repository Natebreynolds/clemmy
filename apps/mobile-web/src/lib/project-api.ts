/**
 * Projects, the agents assigned to them and the tasks delegated into them.
 *
 * The phone and the desktop mount the SAME handlers (src/projects/
 * project-routes.ts), so every shape here is the one the desktop reads. A
 * project is a durable body of work, never a code folder: the path is
 * `project-records` because `projects` already serves local folders.
 *
 * Every change is a POST that answers with the record as it now stands, so a
 * screen settles to what the Mac says rather than to what the phone hoped.
 */
import type {
  AgentAssignments,
  DelegatedTask,
  ProjectAccountChoice,
  ProjectOverview,
  ProjectResourceKind,
  ProjectSummary,
} from '@clem/chat-engine';
import { api, type ApiError } from './api';
import type { ProjectLabel } from './inbox-projects';

// The shapes are the shared engine's, so the phone and the desktop read one
// definition of a project, an assignment and a task.
export type {
  AgentAssignments,
  DelegatedTask,
  ProjectAccountChoice,
  ProjectOverview,
  ProjectResourceKind,
  ProjectSummary,
};
export type {
  ProjectAssignmentView,
  ProjectConversationView,
  ProjectDecisionView,
  ProjectResourceView,
} from '@clem/chat-engine';

const PROJECTS = '/m/api/project-records';
const TASKS = '/m/api/delegated-tasks';
const id = encodeURIComponent;

function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

// ─── projects ─

export async function listProjects(opts: { archived?: boolean } = {}): Promise<{ projects: ProjectSummary[] }> {
  return api(`${PROJECTS}${opts.archived ? '?archived=1' : ''}`);
}

export async function getProject(projectId: string): Promise<{ overview: ProjectOverview }> {
  return api(`${PROJECTS}/${id(projectId)}`);
}

export async function createProject(input: {
  name: string;
  purpose?: string;
  goals?: string[];
  context?: string;
}): Promise<{ overview: ProjectOverview }> {
  return post(PROJECTS, input);
}

export async function changeProject(projectId: string, patch: {
  name?: string;
  purpose?: string;
  goals?: string[];
  context?: string;
}): Promise<{ overview: ProjectOverview }> {
  return post(`${PROJECTS}/${id(projectId)}`, patch);
}

export async function archiveProject(projectId: string): Promise<{ overview: ProjectOverview }> {
  return post(`${PROJECTS}/${id(projectId)}/archive`);
}

export async function restoreProject(projectId: string): Promise<{ overview: ProjectOverview }> {
  return post(`${PROJECTS}/${id(projectId)}/restore`);
}

/** Assign an agent, or change what an assigned agent answers for here. */
export async function saveProjectAgent(projectId: string, agentId: string, assignment: {
  responsibility?: string;
  context?: string;
  skills?: string[];
  shareMethods?: boolean;
}): Promise<{ overview: ProjectOverview }> {
  return post(`${PROJECTS}/${id(projectId)}/agents/${id(agentId)}`, assignment);
}

export async function removeProjectAgent(projectId: string, agentId: string): Promise<{ overview: ProjectOverview }> {
  return post(`${PROJECTS}/${id(projectId)}/agents/${id(agentId)}/remove`);
}

/** Every app with an account connected right now, with its accounts. */
export async function listConnectedApps(): Promise<{ apps: unknown }> {
  return api(`${PROJECTS}-connected-apps`);
}

/** The local projects on this Mac, for linking one to a project. Slow the first time. */
export async function listLocalProjects(): Promise<{ localProjects: unknown }> {
  return api(`${PROJECTS}-local-projects`);
}

/** Link one local project, by the path the roster gave for it. */
export async function linkLocalProject(projectId: string, path: string): Promise<{ overview: ProjectOverview }> {
  return post(`${PROJECTS}/${id(projectId)}/resources`, { kind: 'folder', ref: path });
}

/**
 * One part of a page, rendered on the Mac at the asked width. Each part takes
 * the Mac a few seconds and it renders one at a time, so a reader asks for
 * the next part only once the last one has arrived.
 */
export async function getProjectPageImage(projectId: string, pageId: string, part: {
  width: number;
  height: number;
  offset: number;
}): Promise<unknown> {
  return api(`${PROJECTS}/${id(projectId)}/pages/${id(pageId)}/image?width=${part.width}&height=${part.height}&offset=${part.offset}`);
}

/** The accounts connected right now for one app, for the owner to choose from. */
export async function listAccountChoices(projectId: string, toolkit: string): Promise<{ toolkit: string; accounts: ProjectAccountChoice[] }> {
  return api(`${PROJECTS}/${id(projectId)}/account-choices?toolkit=${id(toolkit)}`);
}

/**
 * Bind one connected account. The Mac decides which account it is from its
 * live connection list, so the phone sends an app and, when there is more than
 * one, the account the owner picked. `replace` is sent only after the owner
 * confirmed replacing the account already bound.
 */
export async function bindProjectAccount(projectId: string, input: {
  toolkit: string;
  accountId?: string;
  replace?: boolean;
}): Promise<{ overview: ProjectOverview }> {
  return post(`${PROJECTS}/${id(projectId)}/resources`, {
    kind: 'account',
    toolkit: input.toolkit,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.replace ? { replace: true } : {}),
  });
}

export async function bindProjectResource(projectId: string, input: {
  kind: Exclude<ProjectResourceKind, 'account'>;
  ref: string;
  label?: string;
}): Promise<{ overview: ProjectOverview }> {
  return post(`${PROJECTS}/${id(projectId)}/resources`, input);
}

export async function removeProjectResource(projectId: string, resourceId: string): Promise<{ overview: ProjectOverview }> {
  return post(`${PROJECTS}/${id(projectId)}/resources/${id(resourceId)}/remove`);
}

// ─── labelling what waits on the owner ─

/**
 * Which project each of these sessions works in. Sessions in no project are
 * absent from the answer. Asked once per screen load, with the session ids
 * the screen's rows already carry.
 */
export async function listProjectLabels(sessions: readonly string[]): Promise<{ labels: ProjectLabel[] }> {
  if (sessions.length === 0) return { labels: [] };
  return api(`${PROJECTS}-labels?sessions=${sessions.map(id).join(',')}`);
}

// ─── a conversation's project ─

/** Which project a conversation works in from its next message: a project's
 *  id, or null for none. Repeating the current choice is a no-op. */
export async function setChatProject(sessionId: string, projectId: string | null): Promise<{
  sessionId: string;
  projectId: string | null;
  projectName: string | null;
  changed: boolean;
}> {
  return post(`/m/api/chat/sessions/${id(sessionId)}/project`, { projectId });
}

// ─── delegated tasks ─

export async function getDelegatedTask(taskId: string): Promise<{ task: DelegatedTask }> {
  return api(`${TASKS}/${id(taskId)}`);
}

export async function listChatDelegatedTasks(sessionId: string): Promise<{ tasks: DelegatedTask[] }> {
  return api(`/m/api/chat/sessions/${id(sessionId)}/delegated-tasks`);
}

/**
 * Correct a task. While it is open the correction revises it (`revised`) and
 * `task` is that task. Once it has ended the correction becomes a task that
 * follows it (`followed`): `task` is the NEW task and `follows` is the one
 * that was corrected.
 */
export async function steerDelegatedTask(taskId: string, instruction: string): Promise<{
  task: DelegatedTask;
  applied?: 'revised' | 'followed';
  follows?: DelegatedTask | null;
}> {
  return post(`${TASKS}/${id(taskId)}/steer`, { instruction });
}

export async function stopDelegatedTask(taskId: string): Promise<{ task: DelegatedTask }> {
  return post(`${TASKS}/${id(taskId)}/stop`);
}

export async function resumeDelegatedTask(taskId: string): Promise<{ task: DelegatedTask }> {
  return post(`${TASKS}/${id(taskId)}/resume`);
}

export async function answerDelegatedTask(taskId: string, answer: string): Promise<{ task: DelegatedTask }> {
  return post(`${TASKS}/${id(taskId)}/answer`, { answer });
}

export async function getAgentWork(agentId: string): Promise<{ work: AgentAssignments }> {
  return api(`/m/api/agents/${id(agentId)}/assignments`);
}

// ─── refusals ─

/** The refusal's name (`NAME_TAKEN`, `TASK_NOT_OPEN`, ...), when the Mac gave one. */
export function refusalCode(error: unknown): string | null {
  const body = (error as ApiError | undefined)?.body as { error?: unknown } | null | undefined;
  return body && typeof body === 'object' && typeof body.error === 'string' ? body.error : null;
}

/** A refused task control answers with the task as it now stands. */
export function refusedTask(error: unknown): DelegatedTask | null {
  const body = (error as ApiError | undefined)?.body as { task?: unknown } | null | undefined;
  const task = body && typeof body === 'object' ? body.task : null;
  return task && typeof task === 'object' && typeof (task as DelegatedTask).taskId === 'string' ? task as DelegatedTask : null;
}
