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
  AgentAssignments, DelegatedTask, DelegatedTaskCorrection, ProjectAccountChoice, ProjectConnectedApp, ProjectLocalProject,
  ProjectOverview, ProjectPageView, ProjectResourceKind, ProjectSummary, SessionProjectLabel,
} from '@clem/chat-engine';
import { projectPageRefusal, projectPages } from '@clem/chat-engine';
import { apiGet, apiPost, withToken, type ApiError } from './api';
import { unifiedChatSessionId } from './last-session';

export type {
  AgentAssignments, DelegatedTask, DelegatedTaskCorrection, ProjectAccountChoice, ProjectAssignmentView,
  ProjectCodingRunView, ProjectConnectedApp, ProjectConversationView, ProjectDecisionView, ProjectLocalProject,
  ProjectOverview, ProjectPageView, ProjectResourceKind, ProjectResourceView, ProjectSummary,
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
  localProjects: ['project-records', 'local-projects'] as const,
  pageDocument: (projectId: string, pageId: string, reload: number) => ['project-records', 'page-document', projectId, pageId, reload] as const,
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
  LOCAL_PROJECT_CHOICE_REQUIRED: 'Choose which local project to link.',
  LOCAL_PROJECT_NOT_FOUND: 'That folder is not among the code folders on this computer. Add it in Connect first.',
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

// ─── Local projects ───
// A local project is a code folder on this machine, from the roster Connect
// keeps. A project links to it by its path; nothing off the roster is linked.

function rosterRows(value: unknown): ProjectLocalProject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row): ProjectLocalProject[] => {
    const entry = row as Partial<ProjectLocalProject> | null;
    return entry && typeof entry.path === 'string' && entry.path
      ? [{
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : entry.path.split(/[\\/]/).filter(Boolean).pop() ?? entry.path,
        path: entry.path,
        type: typeof entry.type === 'string' ? entry.type : '',
        description: typeof entry.description === 'string' ? entry.description : '',
        git: entry.git === true,
        ...(entry.found === true ? { found: true } : {}),
      }]
      : [];
  });
}

/** The code folders on this computer, then the project folders found where
 *  people keep them (linking one of those adds it). The first read can take
 *  a few seconds. */
export const getLocalProjects = () =>
  apiGet<{ localProjects?: unknown; foundProjects?: unknown }>(`${BASE}-local-projects`)
    .then((r) => [...rosterRows(r.localProjects), ...rosterRows(r.foundProjects).map((row) => ({ ...row, found: true }))]);

/**
 * What linking a local project came to. A refusal that names the folders to
 * choose from is an answer the picker acts on, not a failure.
 */
export type LocalProjectLink =
  | { kind: 'linked'; overview: ProjectOverview }
  | { kind: 'choose' | 'not_found'; named: string; localProjects: ProjectLocalProject[] };

export function localProjectLinkFromRefusal(error: unknown): Exclude<LocalProjectLink, { kind: 'linked' }> | null {
  const code = apiErrorCode(error);
  if (code !== 'LOCAL_PROJECT_CHOICE_REQUIRED' && code !== 'LOCAL_PROJECT_NOT_FOUND') return null;
  const body = apiErrorBody(error);
  return {
    kind: code === 'LOCAL_PROJECT_CHOICE_REQUIRED' ? 'choose' : 'not_found',
    named: typeof body.named === 'string' ? body.named : '',
    localProjects: rosterRows(body.localProjects),
  };
}

export async function linkLocalProject(projectId: string, path: string): Promise<LocalProjectLink> {
  try {
    const result = await apiPost<{ overview: ProjectOverview }>(`${BASE}/${id(projectId)}/resources`, { kind: 'folder', ref: path });
    return { kind: 'linked', overview: result.overview };
  } catch (error) {
    const refusal = localProjectLinkFromRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
}

export const attachResource = (
  projectId: string,
  input: { kind: Exclude<ProjectResourceKind, 'account' | 'folder'>; ref: string; label?: string },
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

// ─── Pages made in a project ───
// A page is an HTML file that work in the project wrote into a linked local
// project. The desktop frames the document itself, in a sandbox; what a page
// is called and what a refusal says are the shared engine's words.

/** Where a page opens to be looked at. */
export function pageViewerPath(projectId: string, pageId: string): string {
  return `/projects/${id(projectId)}/pages/${id(pageId)}`;
}

/**
 * The address the frame loads. It never carries the session token: a page
 * can read its own address, and the session cookie already authorizes the
 * frame. `reload` only makes the address new, so the frame asks again.
 */
export function pageDocumentUrl(projectId: string, pageId: string, reload = 0): string {
  const url = `${BASE}/${id(projectId)}/pages/${id(pageId)}/document`;
  return Number.isInteger(reload) && reload > 0 ? `${url}?reload=${reload}` : url;
}

/**
 * Ask for the document before it is framed. A sandboxed frame cannot say why
 * it is empty, so a refusal is read here, where it can be said in words.
 * Nothing of the document is kept: the frame reads it for itself.
 */
export async function checkPageDocument(projectId: string, pageId: string): Promise<true> {
  let response: Response;
  try {
    response = await fetch(withToken(pageDocumentUrl(projectId, pageId)), { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw Object.assign(new Error('Clementine’s local service is restarting or unavailable. Wait a few seconds, then try again.'), { status: 0 });
  }
  if (response.ok) {
    void response.body?.cancel().catch(() => undefined);
    // A value, not nothing: a read that answers with nothing is taken for a failed one.
    return true;
  }
  let body: unknown = null;
  try { body = await response.json(); } catch { body = null; }
  throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, body });
}

/** Open the page in the owner's own browser, on the Mac. */
export const openPageInBrowser = (projectId: string, pageId: string) =>
  apiPost<{ ok?: boolean }>(`${BASE}/${id(projectId)}/pages/${id(pageId)}/open`).then(() => undefined);

/**
 * A refusal about a page as a sentence: the shared words when they name the
 * code, else what any other refusal from a project says.
 */
export function pageRefusalText(error: unknown, fallback: string): string {
  const code = apiErrorCode(error);
  const words = code ? projectPageRefusal(code) : '';
  return words && words !== projectPageRefusal(null) ? words : refusalText(error, fallback);
}

/** Whether a saved file's name says it is a page. */
export function isPageName(name: string | null | undefined): boolean {
  return /\.html?$/i.test((name ?? '').trim());
}

/**
 * The page behind a saved-file card, found by the conversation that wrote it
 * and the name the card shows. Null when there is none, or when more than one
 * page answers to the name: a card never opens the wrong page.
 */
export async function findSessionPage(sessionId: string, name: string, folder: string): Promise<{ projectId: string; page: ProjectPageView } | null> {
  if (!sessionId || !isPageName(name)) return null;
  try {
    const found = await apiGet<{ projectId?: unknown; page?: unknown }>(
      `/api/console/sessions/${id(sessionId)}/page?name=${encodeURIComponent(name)}&folder=${encodeURIComponent(folder)}`,
    );
    const page = projectPages({ pages: [found.page] })[0];
    return typeof found.projectId === 'string' && found.projectId && page ? { projectId: found.projectId, page } : null;
  } catch {
    // No page, or no answer: the card keeps what it could already do.
    return null;
  }
}

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
