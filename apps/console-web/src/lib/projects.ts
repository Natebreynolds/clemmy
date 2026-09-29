/**
 * Projects — typed fetchers over /api/console/project-records, and the
 * delegated tasks that work inside them.
 *
 * A project is a durable body of work: a purpose, goals, the context work
 * inside it shares, the agents assigned to it and the accounts it uses. It
 * is not the code folder Connect lists (that is /api/console/projects and
 * lib/connect), and it is not a Space.
 *
 * The shapes and the words drawn from them live in the shared chat engine so
 * the phone shows the same record the same way; this file is the desktop's
 * door to the server.
 */
import type {
  AgentAssignments, DelegatedTask, DelegatedTaskCorrection, ProjectAccountChoice, ProjectConnectedApp, ProjectOverview,
  ProjectResourceKind, ProjectSummary, SessionProjectLabel,
} from '@clem/chat-engine';
import { apiGet, apiPost, type ApiError } from './api';
import { unifiedChatSessionId } from './last-session';

export type {
  AgentAssignments, DelegatedTask, DelegatedTaskCorrection, ProjectAccountChoice, ProjectAssignmentView,
  ProjectConnectedApp, ProjectConversationView, ProjectDecisionView, ProjectOverview, ProjectResourceKind,
  ProjectResourceView, ProjectSummary,
} from '@clem/chat-engine';

const BASE = '/api/console/project-records';
const TASKS = '/api/console/delegated-tasks';
const id = (value: string) => encodeURIComponent(value);

/** Query keys. `['projects']` already belongs to Connect's code folders. */
export const projectKeys = {
  all: ['project-records'] as const,
  list: (archived: boolean) => ['project-records', 'list', archived ? 'with-archived' : 'active'] as const,
  overview: (projectId: string) => ['project-records', 'overview', projectId] as const,
  accountChoices: (projectId: string, toolkit: string) => ['project-records', 'account-choices', projectId, toolkit] as const,
  connectedApps: ['project-records', 'connected-apps'] as const,
  sessionTasks: (sessionId: string) => ['delegated-tasks', 'session', sessionId] as const,
  agentAssignments: (agentId: string) => ['agents', 'assignments', agentId] as const,
};

// ─── Errors ───
// The server answers a refusal with `{ error: 'UPPER_SNAKE', ... }`. The code
// decides what the screen does; the sentence is what the owner reads.

export function apiErrorCode(error: unknown): string | null {
  const body = (error as Partial<ApiError> | null)?.body;
  if (!body || typeof body !== 'object') return null;
  const code = (body as Record<string, unknown>).error;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : null;
}

export function apiErrorBody(error: unknown): Record<string, unknown> {
  const body = (error as Partial<ApiError> | null)?.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

const REFUSALS: Record<string, string> = {
  NAME_REQUIRED: 'Give the project a name.',
  NAME_TAKEN: 'Another project already has that name.',
  PROJECT_NOT_FOUND: 'This project no longer exists.',
  NOT_FOUND: 'This project no longer exists.',
  PROJECT_ARCHIVED: 'This project is archived. Restore it to change it.',
  ARCHIVED: 'This project is archived. Restore it to change it.',
  AGENT_NOT_FOUND: 'That agent no longer exists.',
  AGENT_REQUIRED: 'Choose an agent first.',
  TOOLKIT_REQUIRED: 'Choose an app first.',
  RESOURCE_INCOMPLETE: 'That is missing what it points at.',
  TOO_MANY_RESOURCES: 'This project already lists as many resources as it can hold. Remove one first.',
  ACCOUNT_NOT_CONNECTED: 'No account is connected for that app. Connect one first.',
  ACCOUNT_CHOICE_REQUIRED: 'Choose which account this project uses.',
  CONFLICTING_ACCOUNT: 'This project already uses another account for that app.',
  SESSION_NOT_FOUND: 'That conversation no longer exists.',
  NOT_A_CONVERSATION: 'Only a conversation can work in a project.',
  TASK_NOT_FOUND: 'This task no longer exists.',
  TASK_NOT_OPEN: 'This task has already ended, so it cannot be corrected.',
  OWNER_UNAVAILABLE: 'The agent that owned this task is no longer there, so nobody can take the correction. Ask for the work again in a conversation.',
  STOPPING: 'This task is stopping. Correct it once it has stopped.',
  FACT_NOT_FOUND: 'That fact is no longer there.',
  INVALID_FACT: 'That fact could not be found.',
  ALREADY_KEPT_THERE: 'It is already kept there.',
  TASK_NOT_RESUMABLE: 'This task cannot be resumed from where it is.',
  TASK_NOT_WAITING: 'This task is no longer waiting on an answer.',
  ALREADY_ANSWERED: 'This question was already answered.',
  INSTRUCTION_REQUIRED: 'Say what should change, in a few words or more.',
  ANSWER_REQUIRED: 'Type an answer first.',
};

/** One plain sentence for a refusal or a failure, never a code. */
export function refusalText(error: unknown, fallback = 'That didn’t go through. Try again.'): string {
  const code = apiErrorCode(error);
  if (code && REFUSALS[code]) return REFUSALS[code];
  const message = error instanceof Error ? error.message.trim() : '';
  // An unmapped code is not a sentence; the fallback is.
  if (!message || /^[A-Z][A-Z0-9_]*$/.test(message) || /^HTTP \d+$/.test(message)) return fallback;
  return message;
}

// ─── Projects ───

export const listProjects = (includeArchived = false) =>
  apiGet<{ projects?: ProjectSummary[] }>(`${BASE}${includeArchived ? '?archived=1' : ''}`)
    .then((r) => r.projects ?? []);

export const getProjectOverview = (projectId: string) =>
  apiGet<{ overview: ProjectOverview }>(`${BASE}/${id(projectId)}`).then((r) => r.overview);

export interface ProjectInput { name?: string; purpose?: string; goals?: string[]; context?: string }

const overviewOf = (r: { overview: ProjectOverview }) => r.overview;

export const createProject = (input: ProjectInput & { name: string }) =>
  apiPost<{ overview: ProjectOverview }>(BASE, input).then(overviewOf);

export const updateProject = (projectId: string, input: ProjectInput) =>
  apiPost<{ overview: ProjectOverview }>(`${BASE}/${id(projectId)}`, input).then(overviewOf);

export const archiveProject = (projectId: string) =>
  apiPost<{ overview: ProjectOverview }>(`${BASE}/${id(projectId)}/archive`).then(overviewOf);

export const restoreProject = (projectId: string) =>
  apiPost<{ overview: ProjectOverview }>(`${BASE}/${id(projectId)}/restore`).then(overviewOf);

// ─── Assignments ───

export interface AssignmentInput { responsibility?: string; context?: string; skills?: string[]; shareMethods?: boolean }

export const saveAssignment = (projectId: string, agentId: string, input: AssignmentInput = {}) =>
  apiPost<{ overview: ProjectOverview }>(`${BASE}/${id(projectId)}/agents/${id(agentId)}`, input).then(overviewOf);

export const removeAssignment = (projectId: string, agentId: string) =>
  apiPost<{ overview: ProjectOverview }>(`${BASE}/${id(projectId)}/agents/${id(agentId)}/remove`).then(overviewOf);

export const getAgentAssignments = (agentId: string) =>
  apiGet<{ work: AgentAssignments }>(`/api/console/agents/${id(agentId)}/assignments`)
    .then((r): AgentAssignments => ({
      agentId: r.work?.agentId ?? agentId,
      projects: r.work?.projects ?? [],
      currentTasks: r.work?.currentTasks ?? [],
      recentOutcomes: r.work?.recentOutcomes ?? [],
    }));

// ─── Accounts and resources ───

export const getAccountChoices = (projectId: string, toolkit: string) =>
  apiGet<{ toolkit: string; accounts?: ProjectAccountChoice[] }>(
    `${BASE}/${id(projectId)}/account-choices?toolkit=${encodeURIComponent(toolkit)}`,
  ).then((r) => r.accounts ?? []);

/**
 * What binding an account came to. The three refusals are answers the
 * screen acts on, not failures: choose one, connect one, or confirm
 * replacing the one already bound.
 */
export type AccountBinding =
  | { kind: 'bound'; overview: ProjectOverview }
  | { kind: 'choose'; accounts: ProjectAccountChoice[] }
  | { kind: 'not_connected' }
  | { kind: 'conflict'; bound: ProjectAccountChoice };

export function accountBindingFromRefusal(error: unknown): Exclude<AccountBinding, { kind: 'bound' }> | null {
  const code = apiErrorCode(error);
  const body = apiErrorBody(error);
  if (code === 'ACCOUNT_NOT_CONNECTED') return { kind: 'not_connected' };
  if (code === 'ACCOUNT_CHOICE_REQUIRED') {
    const accounts = Array.isArray(body.accounts) ? body.accounts : [];
    return {
      kind: 'choose',
      accounts: accounts.flatMap((row): ProjectAccountChoice[] => {
        const account = row as Partial<ProjectAccountChoice> | null;
        return account && typeof account.accountId === 'string' && account.accountId
          ? [{ accountId: account.accountId, label: typeof account.label === 'string' && account.label.trim() ? account.label : 'Unnamed account' }]
          : [];
      }),
    };
  }
  if (code === 'CONFLICTING_ACCOUNT') {
    const bound = body.bound as Partial<ProjectAccountChoice> | undefined;
    return {
      kind: 'conflict',
      bound: {
        accountId: typeof bound?.accountId === 'string' ? bound.accountId : '',
        label: typeof bound?.label === 'string' && bound.label.trim() ? bound.label : 'another account',
      },
    };
  }
  return null;
}

export async function bindAccount(
  projectId: string,
  input: { toolkit: string; accountId?: string; replace?: boolean },
): Promise<AccountBinding> {
  try {
    const result = await apiPost<{ overview: ProjectOverview }>(`${BASE}/${id(projectId)}/resources`, {
      kind: 'account',
      toolkit: input.toolkit,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.replace ? { replace: true } : {}),
    });
    return { kind: 'bound', overview: result.overview };
  } catch (error) {
    const refusal = accountBindingFromRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
}

export const attachResource = (
  projectId: string,
  input: { kind: Exclude<ProjectResourceKind, 'account'>; ref: string; label?: string },
) => apiPost<{ overview: ProjectOverview }>(`${BASE}/${id(projectId)}/resources`, input).then(overviewOf);

export const removeResource = (projectId: string, resourceId: string) =>
  apiPost<{ overview: ProjectOverview }>(`${BASE}/${id(projectId)}/resources/${id(resourceId)}/remove`).then(overviewOf);

/** Every app with an account connected right now, with its accounts. */
export const getConnectedApps = () =>
  apiGet<{ apps?: ProjectConnectedApp[] }>(`${BASE}-connected-apps`)
    .then((r) => (r.apps ?? []).map((app): ProjectConnectedApp => ({
      toolkit: app.toolkit,
      name: app.name?.trim() || app.toolkit,
      accounts: app.accounts ?? [],
    })));

/** Which project each of these sessions works in. Sessions in none are left out. */
export const getProjectLabels = (sessionIds: readonly string[]) =>
  apiGet<{ labels?: SessionProjectLabel[] }>(`${BASE}-labels?sessions=${sessionIds.map(encodeURIComponent).join(',')}`)
    .then((r) => r.labels ?? []);

// ─── A conversation's project ───

/** Which project a conversation works in, by id and the name it shows. */
export interface ConversationProject { id: string; name: string }

/** Move a conversation into a project from its next message: a project's
 *  id, or null for none. Repeating the current choice is a no-op. */
export const setConversationProject = (sessionId: string, projectId: string | null) =>
  apiPost<{ sessionId: string; projectId: string | null; projectName: string | null; changed: boolean }>(
    `/api/console/sessions/${id(sessionId)}/project`,
    { projectId },
  );

// ─── Delegated tasks ───

const taskOf = (r: { task: DelegatedTask }) => r.task;

export const getDelegatedTask = (taskId: string) =>
  apiGet<{ task: DelegatedTask }>(`${TASKS}/${id(taskId)}`).then(taskOf);

export const listConversationTasks = (sessionId: string) =>
  apiGet<{ tasks?: DelegatedTask[] }>(`/api/console/sessions/${id(sessionId)}/delegated-tasks`)
    .then((r) => r.tasks ?? []);

/**
 * Correct a task. Work still open takes the correction itself; work that
 * had ended is followed by a new task for the same owner, and the answer
 * says which happened.
 */
export const steerTask = (taskId: string, instruction: string): Promise<DelegatedTaskCorrection> =>
  apiPost<{ task: DelegatedTask; applied?: string; follows?: DelegatedTask | null }>(`${TASKS}/${id(taskId)}/steer`, { instruction })
    .then((r): DelegatedTaskCorrection => (r.applied === 'followed'
      ? { applied: 'followed', task: r.task, follows: r.follows ?? null }
      : { applied: 'revised', task: r.task }));

export const stopTask = (taskId: string) =>
  apiPost<{ task: DelegatedTask }>(`${TASKS}/${id(taskId)}/stop`).then(taskOf);

export const resumeTask = (taskId: string) =>
  apiPost<{ task: DelegatedTask }>(`${TASKS}/${id(taskId)}/resume`).then(taskOf);

export const answerTask = (taskId: string, answer: string) =>
  apiPost<{ task: DelegatedTask }>(`${TASKS}/${id(taskId)}/answer`, { answer }).then(taskOf);

/** The task's view when a refusal carries the record as it stands now. */
export function taskFromRefusal(error: unknown): DelegatedTask | null {
  const task = apiErrorBody(error).task as Partial<DelegatedTask> | undefined;
  return task && typeof task.taskId === 'string' && typeof task.phase === 'string' ? task as DelegatedTask : null;
}

/** Where a task's full run opens. */
export function taskRunPath(taskId: string): string {
  return `/tasks?select=${encodeURIComponent(taskId)}`;
}

/** Where a project's conversation opens in Chat. */
export function conversationPath(sessionId: string): string {
  return `/chat/${encodeURIComponent(unifiedChatSessionId(sessionId))}`;
}

/** Goals as the owner types them, one to a line, as the list the server keeps. */
export function goalsFromText(text: string): string[] {
  const seen = new Set<string>();
  const goals: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const goal = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
    if (!goal || seen.has(goal.toLowerCase())) continue;
    seen.add(goal.toLowerCase());
    goals.push(goal);
  }
  return goals;
}

export function goalsToText(goals: readonly string[]): string {
  return goals.join('\n');
}
