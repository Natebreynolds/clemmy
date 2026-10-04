/**
 * What the desktop and the phone are shown about projects, the agents
 * assigned to them and the tasks delegated into them.
 *
 * One builder per view, read by both surfaces, so they cannot disagree about
 * a project's work or about what is waiting on the owner. Every field comes
 * from a record: the project store, the task record, the session table, the
 * approval registry. Nothing is inferred from what an agent said.
 */
import { RETAINED_WORK_TERMINAL_HEADER } from '../runtime/harness/retained-work-checkpoint.js';
import { getAgentRecord } from '../agents/agent-record.js';
import {
  getBackgroundTask, listBackgroundTasks, type BackgroundTaskRecord,
} from '../execution/background-tasks.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { connectedAppName } from './connected-accounts.js';
import { localProjectAt } from './local-projects.js';
import { localProjectOffers } from './local-project-offers.js';
import { pagesMadeInProject, type ProjectPageView } from './local-pages.js';
import { discoverMcpServers } from '../runtime/mcp-config.js';
import { slugifyServerName } from '../runtime/mcp-namespace-shim.js';
import { listCodingRuns } from '../execution/coding-run-store.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import {
  getProject, listAssignments, listAssignmentsForAgent, listProjects, listResources,
  type ProjectAssignment, type ProjectRecord, type ProjectResource,
} from './project-record.js';

export type DelegatedTaskPhaseView =
  | 'waiting_to_start' | 'working' | 'stopping' | 'needs_you' | 'paused' | 'finished' | 'stopped' | 'failed';

export interface DelegatedTaskView {
  taskId: string;
  title: string;
  status: BackgroundTaskRecord['status'];
  phase: DelegatedTaskPhaseView;
  /** Who owns the work. A null agent is Clem herself. */
  owner: { agentId: string | null; agentName: string | null; chosenBy: 'owner' | 'clem' | 'router' | null };
  project: { id: string; name: string | null } | null;
  /** The version of the request the task is working to; 1 is the original. */
  requestVersion: number;
  revisions: Array<{ version: number; instruction: string; evidencePolicy: string; queuedAt: string; applied: boolean }>;
  /** A correction that has not reached the agent yet. */
  correctionPending: boolean;
  artifactDestination: string | null;
  /** The finished task this one corrects, when it is a follow-up. */
  followsTaskId: string | null;
  question: { id: string; text: string; options: string[] } | null;
  approvalId: string | null;
  /** The opening of the result, when there is one. The full text is the report. */
  resultPreview: string | null;
  resultPath: string | null;
  error: string | null;
  /** What the agent said as it worked, newest last. */
  checkIns: Array<{ at: string; note: string }>;
  originSessionId: string | null;
  runSessionId: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  controls: { canSteer: boolean; canStop: boolean; canResume: boolean; canAnswer: boolean };
}

const TERMINAL: ReadonlySet<string> = new Set(['done', 'failed', 'aborted', 'interrupted']);
const RESUMABLE: ReadonlySet<string> = new Set(['awaiting_continue', 'interrupted', 'failed', 'aborted', 'blocked']);

function phaseOf(task: BackgroundTaskRecord): DelegatedTaskPhaseView {
  switch (task.status) {
    case 'pending': return 'waiting_to_start';
    case 'running': return 'working';
    case 'cancelling': return 'stopping';
    case 'awaiting_input':
    case 'awaiting_approval': return 'needs_you';
    case 'awaiting_continue':
    case 'blocked':
    case 'interrupted': return 'paused';
    case 'done': return 'finished';
    case 'aborted': return 'stopped';
    default: return 'failed';
  }
}

/** Why a task stopped, as the owner reads it: the retained-work handle listing
 * is for the model that resumes the work. */
function ownerFacingError(error: string | undefined): string | null {
  const text = (error ?? '').trim();
  if (!text) return null;
  const cut = text.indexOf(RETAINED_WORK_TERMINAL_HEADER);
  const owner = (cut >= 0 ? text.slice(0, cut) : text).trim();
  return owner ? owner.slice(0, 600) : null;
}

export function delegatedTaskView(task: BackgroundTaskRecord): DelegatedTaskView {
  const delegation = task.delegation;
  const revisions = (task.contractRevisions ?? []).slice(-12).map((revision) => ({
    version: revision.version,
    instruction: revision.instruction.slice(0, 600),
    evidencePolicy: revision.evidencePolicy,
    queuedAt: revision.queuedAt,
    applied: Boolean(revision.appliedAt),
  }));
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    phase: phaseOf(task),
    owner: {
      agentId: delegation?.agentId ?? null,
      agentName: delegation?.agentName ?? null,
      chosenBy: delegation?.assignedBy ?? null,
    },
    project: delegation?.projectId ? { id: delegation.projectId, name: delegation.projectName } : null,
    requestVersion: task.contractVersion ?? 1,
    revisions,
    correctionPending: Boolean(task.pendingContractRevision),
    artifactDestination: delegation?.artifactDestination ?? null,
    followsTaskId: delegation?.followsTaskId ?? null,
    question: task.status === 'awaiting_input' && task.pendingQuestionId && task.pendingQuestion
      ? { id: task.pendingQuestionId, text: task.pendingQuestion.slice(0, 2_000), options: (task.pendingQuestionOptions ?? []).slice(0, 8) }
      : null,
    approvalId: task.status === 'awaiting_approval' ? cardApprovalId(task.pendingApprovalId) : null,
    resultPreview: task.result ? task.result.slice(0, 1_200) : null,
    resultPath: task.resultPath ?? null,
    error: ownerFacingError(task.error),
    checkIns: (task.checkIns ?? []).slice(-12).map((entry) => ({ at: entry.at, note: entry.note.slice(0, 600) })),
    originSessionId: task.originSessionId ?? null,
    runSessionId: task.runSessionId,
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? null,
    updatedAt: task.updatedAt,
    controls: {
      // A finished task can still be corrected: the correction becomes a
      // task that follows it.
      canSteer: !task.archived && task.status !== 'cancelling',
      canStop: !task.archived && !TERMINAL.has(task.status) && task.status !== 'cancelling',
      canResume: !task.archived && RESUMABLE.has(task.status),
      canAnswer: task.status === 'awaiting_input' && Boolean(task.pendingQuestionId),
    },
  };
}

function delegatedTasks(filter: (task: BackgroundTaskRecord) => boolean, limit: number): DelegatedTaskView[] {
  return listBackgroundTasks({ includeArchived: false })
    .filter((task) => Boolean(task.delegation) && !task.internal && filter(task))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map(delegatedTaskView);
}

export function delegatedTaskById(taskId: string): DelegatedTaskView | null {
  const task = getBackgroundTask(taskId);
  return task?.delegation && !task.internal ? delegatedTaskView(task) : null;
}

export function delegatedTasksForSession(sessionId: string, limit = 20): DelegatedTaskView[] {
  return delegatedTasks((task) => task.originSessionId === sessionId, limit);
}

export function delegatedTasksForProject(projectId: string, limit = 30): DelegatedTaskView[] {
  return delegatedTasks((task) => task.delegation?.projectId === projectId, limit);
}

export function delegatedTasksForAgent(agentId: string, limit = 30): DelegatedTaskView[] {
  return delegatedTasks((task) => task.delegation?.agentId === agentId, limit);
}

export interface AssignmentView {
  agentId: string;
  agentName: string;
  handles: string;
  /** False when the record assigned was deleted or replaced under its id. */
  available: boolean;
  responsibility: string;
  context: string;
  skills: string[];
  shareMethods: boolean;
  /** Whole jobs in the project go to this agent. */
  lead: boolean;
  revision: number;
  assignedAt: string;
}

function assignmentView(row: ProjectAssignment): AssignmentView {
  const agent = getAgentRecord(row.agentId);
  const same = Boolean(agent) && !(row.agentCreatedAt && agent!.createdAt && row.agentCreatedAt !== agent!.createdAt);
  return {
    agentId: row.agentId,
    // The agent as it is now when it is still the one assigned; otherwise
    // the name the assignment was made with, never another agent's.
    agentName: (same ? agent!.name : row.agentName) || row.agentId,
    handles: same ? agent!.handles ?? '' : '',
    available: same,
    responsibility: row.responsibility,
    context: row.context,
    skills: row.skills,
    shareMethods: row.shareMethods,
    lead: row.lead,
    revision: row.revision,
    assignedAt: row.assignedAt,
  };
}

export interface ProjectConversationView {
  sessionId: string;
  title: string | null;
  updatedAt: string;
  agentName: string | null;
  /** True when the conversation works in this project now, not only before. */
  current: boolean;
}

export function conversationsForProject(projectId: string, limit = 20): ProjectConversationView[] {
  try {
    const rows = openEventLog().prepare(`
      SELECT id, title, updated_at AS updatedAt, metadata_json AS metadata
        FROM sessions
       WHERE kind = 'chat'
         AND (json_extract(metadata_json, '$.projectId') = ?
           OR EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(metadata_json, '$.projectIds'), '[]')) WHERE value = ?))
       ORDER BY updated_at DESC LIMIT ?
    `).all(projectId, projectId, Math.max(1, Math.min(100, limit))) as Array<{ id: string; title: string | null; updatedAt: string; metadata: string | null }>;
    return rows.map((row) => {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>; } catch { /* unreadable metadata names nothing */ }
      return {
        sessionId: row.id,
        title: row.title,
        updatedAt: row.updatedAt,
        agentName: typeof metadata.agentName === 'string' && metadata.agentId ? metadata.agentName : null,
        current: metadata.projectId === projectId,
      };
    });
  } catch {
    return [];
  }
}

/** The id of an approval that is decided on a card, and of no other. */
function cardApprovalId(approvalId: string | undefined): string | null {
  if (!approvalId) return null;
  try {
    const row = approvalRegistry.get(approvalId);
    return row && approvalRegistry.isFormalApprovalSurface(row) ? approvalId : null;
  } catch {
    return null;
  }
}

export interface ProjectDecisionView {
  kind: 'question' | 'approval';
  /** For a question: the answers it offered, when it offered any. */
  options: string[];
  /** For an approval: whether it is decided on a card. One that was asked in
   * the conversation's own words is answered there, never from a card. */
  formal: boolean;
  /** Where answering it happens. */
  taskId: string | null;
  sessionId: string;
  approvalId: string | null;
  questionId: string | null;
  title: string;
  detail: string;
  owner: string;
  askedAt: string;
}

/** What is waiting on the owner in one project: a task's question, or an
 * approval asked by one of the project's conversations or tasks. */
export function decisionsForProject(projectId: string, limit = 12): ProjectDecisionView[] {
  const tasks = listBackgroundTasks({ includeArchived: false })
    .filter((task) => task.delegation?.projectId === projectId && !task.internal);
  const decisions: ProjectDecisionView[] = [];
  const sessions = new Map<string, { taskId: string | null; owner: string; title: string; conversation: string | null }>();
  for (const task of tasks) {
    const owner = task.delegation?.agentName ?? 'Clem';
    sessions.set(task.runSessionId, { taskId: task.id, owner, title: task.title, conversation: task.originSessionId ?? null });
    if (task.status === 'awaiting_input' && task.pendingQuestionId && task.pendingQuestion) {
      decisions.push({ kind: 'question', taskId: task.id, sessionId: task.originSessionId ?? task.runSessionId,
        options: (task.pendingQuestionOptions ?? []).slice(0, 8),
        formal: true, approvalId: null, questionId: task.pendingQuestionId, title: task.title,
        detail: task.pendingQuestion.slice(0, 600), owner, askedAt: task.updatedAt });
    }
  }
  for (const conversation of conversationsForProject(projectId, 50)) {
    if (!conversation.current) continue;
    sessions.set(conversation.sessionId, { taskId: null, owner: conversation.agentName ?? 'Clem', title: conversation.title ?? 'Conversation',
      conversation: conversation.sessionId });
  }
  try {
    for (const approval of approvalRegistry.listPending({ status: 'pending' })) {
      const from = sessions.get(approval.sessionId);
      if (!from || approvalRegistry.isExpired(approval)) continue;
      // The registry says what a pending row may show: a card's id, or, for
      // one asked in the conversation's own words, only the question.
      const shown = approvalRegistry.projectPendingApprovalUserDependency(approval);
      decisions.push(shown.kind === 'approval'
        ? { kind: 'approval', options: [], formal: true, taskId: from.taskId, sessionId: approval.sessionId, approvalId: shown.approvalId,
          questionId: null, title: from.title, detail: approval.subject.slice(0, 600), owner: from.owner, askedAt: approval.requestedAt }
        // Answered in a conversation, so it names one: the task's own when a task asked.
        : { kind: 'approval', options: [], formal: false, taskId: from.taskId, sessionId: from.conversation ?? approval.sessionId, approvalId: null,
          questionId: null, title: from.title, detail: shown.question.slice(0, 600), owner: from.owner, askedAt: approval.requestedAt });
    }
  } catch { /* the registry is read elsewhere too; a project view never fails on it */ }
  return decisions.sort((a, b) => b.askedAt.localeCompare(a.askedAt)).slice(0, limit);
}

export interface ProjectSummaryView {
  id: string;
  name: string;
  purpose: string;
  status: ProjectRecord['status'];
  updatedAt: string;
  agents: Array<{ agentId: string; agentName: string }>;
  activeTasks: number;
  needsYou: number;
}

export function projectSummary(project: ProjectRecord): ProjectSummaryView {
  const tasks = listBackgroundTasks({ includeArchived: false })
    .filter((task) => task.delegation?.projectId === project.id && !task.internal);
  return {
    id: project.id,
    name: project.name,
    purpose: project.purpose,
    status: project.status,
    updatedAt: project.updatedAt,
    agents: listAssignments(project.id).map(assignmentView).filter((row) => row.available)
      .map((row) => ({ agentId: row.agentId, agentName: row.agentName })),
    activeTasks: tasks.filter((task) => !TERMINAL.has(task.status)).length,
    needsYou: project.status === 'active' ? decisionsForProject(project.id, 50).length : 0,
  };
}

export function projectSummaries(options: { includeArchived?: boolean } = {}): ProjectSummaryView[] {
  return listProjects(options).map(projectSummary);
}

export type ProjectResourceView = ProjectResource & {
  /** For an account: the app's name as a person writes it. */
  appName: string | null;
  /** For a linked local project: whether the folder is still there, and
   * whether it is a repository. Null for every other kind. */
  localProject: {
    name: string; path: string; present: boolean; git: boolean;
    /** What the folder offers: its instruction files, the commands it names,
     * and the tool servers it declares with whether Clem is connected to one
     * of the same name. */
    instructions: string[];
    commands: string[];
    toolServers: Array<{ name: string; connected: boolean }>;
  } | null;
};

/** One coding run started from a conversation of the project. */
export interface ProjectCodingRunView {
  runId: string;
  objective: string;
  /** The local project it works in, and whether that one is linked here. */
  localProject: { name: string; path: string; linked: boolean };
  branch: string;
  /** `working` until the run has settled; what it came to is read from the run. */
  phase: 'waiting_to_start' | 'working' | 'handed_to_you' | 'finished';
  originSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

type ConnectedToolServers = () => string[];
let connectedToolServersForTests: ConnectedToolServers | null = null;

/** Test seam. Null restores Clem's own connections. */
export function _setConnectedToolServersForTests(list: ConnectedToolServers | null): void {
  connectedToolServersForTests = list;
}

function connectedToolServers(): Set<string> {
  try {
    const names = connectedToolServersForTests
      ? connectedToolServersForTests()
      : discoverMcpServers().filter((server) => server.enabled !== false).map((server) => server.name);
    return new Set(names.map(slugifyServerName));
  } catch {
    // Unknown is shown as not connected: the page never claims a connection it could not read.
    return new Set();
  }
}

function offersView(folder: string): { instructions: string[]; commands: string[]; toolServers: Array<{ name: string; connected: boolean }> } {
  const offers = localProjectOffers(folder);
  const connected = offers.toolServers.length > 0 ? connectedToolServers() : new Set<string>();
  return {
    instructions: offers.instructions,
    commands: offers.commands.map((row) => row.name),
    toolServers: offers.toolServers.map((name) => ({ name, connected: connected.has(slugifyServerName(name)) })),
  };
}

function codingPhase(state: string): ProjectCodingRunView['phase'] {
  if (state === 'admitted') return 'waiting_to_start';
  if (state === 'detached') return 'handed_to_you';
  return state === 'settled' ? 'finished' : 'working';
}

/** The coding runs that conversations of this project started, newest first. */
export function codingRunsForProject(projectId: string, limit = 12): ProjectCodingRunView[] {
  try {
    const linked = new Set(listResources(projectId).filter((row) => row.kind === 'folder' && row.ref).map((row) => row.ref!));
    const sessions = new Set(conversationsForProject(projectId, 100).map((row) => row.sessionId));
    if (sessions.size === 0) return [];
    return listCodingRuns({ limit: 200 })
      .filter((run) => run.originSessionId !== null && sessions.has(run.originSessionId))
      .slice(0, Math.max(1, Math.min(50, limit)))
      .map((run) => ({
        runId: run.runId,
        objective: run.objective.slice(0, 300),
        localProject: { name: run.projectName, path: run.projectPath, linked: linked.has(run.projectPath) },
        branch: run.branch,
        phase: codingPhase(run.state),
        originSessionId: run.originSessionId,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      }));
  } catch {
    // The coding store is read elsewhere too; a project view never fails on it.
    return [];
  }
}

export interface ProjectOverviewView {
  project: ProjectRecord;
  agents: AssignmentView[];
  resources: ProjectResourceView[];
  tasks: DelegatedTaskView[];
  codingRuns: ProjectCodingRunView[];
  /** HTML pages that work in the project wrote into its linked local projects. */
  pages: ProjectPageView[];
  conversations: ProjectConversationView[];
  decisions: ProjectDecisionView[];
}

export function projectOverview(projectId: string): ProjectOverviewView | null {
  const project = getProject(projectId);
  if (!project) return null;
  return {
    project,
    agents: listAssignments(project.id).map(assignmentView),
    resources: listResources(project.id).map((resource) => ({
      ...resource, appName: resource.toolkit ? connectedAppName(resource.toolkit) : null,
      localProject: resource.kind === 'folder' && resource.ref
        ? { name: resource.label || resource.ref, path: resource.ref, ...localProjectAt(resource.ref), ...offersView(resource.ref) }
        : null,
    })),
    tasks: delegatedTasksForProject(project.id),
    codingRuns: codingRunsForProject(project.id),
    pages: pagesMadeInProject(project.id),
    conversations: conversationsForProject(project.id),
    decisions: project.status === 'active' ? decisionsForProject(project.id) : [],
  };
}

export interface AgentWorkView {
  agentId: string;
  projects: Array<{ projectId: string; projectName: string; responsibility: string; shareMethods: boolean; activeTasks: number }>;
  /** Tasks it owns that are not finished. */
  currentTasks: DelegatedTaskView[];
  /** Tasks it owned that ended, newest first. */
  recentOutcomes: DelegatedTaskView[];
}

export function agentWork(agentId: string): AgentWorkView {
  const tasks = delegatedTasksForAgent(agentId, 60);
  const open = tasks.filter((task) => !TERMINAL.has(task.status));
  return {
    agentId,
    projects: listAssignmentsForAgent(agentId).flatMap((row) => {
      const project = getProject(row.projectId);
      return project ? [{
        projectId: project.id, projectName: project.name, responsibility: row.responsibility, shareMethods: row.shareMethods,
        activeTasks: open.filter((task) => task.project?.id === project.id).length,
      }] : [];
    }),
    currentTasks: open.slice(0, 12),
    recentOutcomes: tasks.filter((task) => TERMINAL.has(task.status)).slice(0, 12),
  };
}

export interface SessionProjectLabel {
  sessionId: string;
  projectId: string;
  projectName: string;
  /** The agent that owns the work there, when there is one. */
  agentName: string | null;
  /** Set when the session is a delegated task's own run. */
  taskId: string | null;
}

/**
 * Which project each of these sessions works in, for labelling what waits on
 * the owner. A conversation is labelled by its own project; a delegated
 * task's run by the project it was delegated into. A session in no project
 * is left out.
 */
export function projectLabelsForSessions(sessionIds: readonly string[]): SessionProjectLabel[] {
  const wanted = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))].slice(0, 200);
  if (wanted.length === 0) return [];
  const labels: SessionProjectLabel[] = [];
  const runs = new Map(listBackgroundTasks({ includeArchived: false })
    .filter((task) => task.delegation?.projectId)
    .map((task) => [task.runSessionId, task] as const));
  const db = openEventLog();
  for (const sessionId of wanted) {
    const task = runs.get(sessionId);
    if (task?.delegation?.projectId) {
      const project = getProject(task.delegation.projectId);
      if (project) labels.push({ sessionId, projectId: project.id, projectName: project.name, agentName: task.delegation.agentName, taskId: task.id });
      continue;
    }
    try {
      const row = db.prepare('SELECT metadata_json AS metadata FROM sessions WHERE id = ?').get(sessionId) as { metadata: string | null } | undefined;
      if (!row) continue;
      const metadata = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>;
      const project = typeof metadata.projectId === 'string' ? getProject(metadata.projectId) : null;
      if (!project) continue;
      labels.push({ sessionId, projectId: project.id, projectName: project.name,
        agentName: typeof metadata.agentName === 'string' && metadata.agentId ? metadata.agentName : null, taskId: null });
    } catch { /* an unreadable session is left unlabelled */ }
  }
  return labels;
}
