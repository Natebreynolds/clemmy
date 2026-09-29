/**
 * What the desktop and the phone are shown about projects, the agents
 * assigned to them and the tasks delegated into them.
 *
 * One builder per view, read by both surfaces, so they cannot disagree about
 * a project's work or about what is waiting on the owner. Every field comes
 * from a record: the project store, the task record, the session table, the
 * approval registry. Nothing is inferred from what an agent said.
 */
import { getAgentRecord } from '../agents/agent-record.js';
import {
  getBackgroundTask, listBackgroundTasks, type BackgroundTaskRecord,
} from '../execution/background-tasks.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
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
  question: { id: string; text: string; options: string[] } | null;
  approvalId: string | null;
  /** The opening of the result, when there is one. The full text is the report. */
  resultPreview: string | null;
  resultPath: string | null;
  error: string | null;
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

export function delegatedTaskView(task: BackgroundTaskRecord): DelegatedTaskView {
  const delegation = task.delegation;
  const revisions = (task.contractRevisions ?? []).slice(-12).map((revision) => ({
    version: revision.version,
    instruction: revision.instruction.slice(0, 600),
    evidencePolicy: revision.evidencePolicy,
    queuedAt: revision.queuedAt,
    applied: Boolean(revision.appliedAt),
  }));
  const open = !task.archived && !TERMINAL.has(task.status) && task.status !== 'cancelling';
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
    question: task.status === 'awaiting_input' && task.pendingQuestionId && task.pendingQuestion
      ? { id: task.pendingQuestionId, text: task.pendingQuestion.slice(0, 2_000), options: (task.pendingQuestionOptions ?? []).slice(0, 8) }
      : null,
    approvalId: task.status === 'awaiting_approval' ? task.pendingApprovalId ?? null : null,
    resultPreview: task.result ? task.result.slice(0, 1_200) : null,
    resultPath: task.resultPath ?? null,
    error: task.error ? task.error.slice(0, 600) : null,
    originSessionId: task.originSessionId ?? null,
    runSessionId: task.runSessionId,
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? null,
    updatedAt: task.updatedAt,
    controls: {
      canSteer: open,
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
  revision: number;
  assignedAt: string;
}

function assignmentView(row: ProjectAssignment): AssignmentView {
  const agent = getAgentRecord(row.agentId);
  const same = Boolean(agent) && !(row.agentCreatedAt && agent!.createdAt && row.agentCreatedAt !== agent!.createdAt);
  return {
    agentId: row.agentId,
    agentName: agent?.name ?? row.agentId,
    handles: agent?.handles ?? '',
    available: same,
    responsibility: row.responsibility,
    context: row.context,
    skills: row.skills,
    shareMethods: row.shareMethods,
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

export interface ProjectDecisionView {
  kind: 'question' | 'approval';
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
  const sessions = new Map<string, { taskId: string | null; owner: string; title: string }>();
  for (const task of tasks) {
    const owner = task.delegation?.agentName ?? 'Clem';
    sessions.set(task.runSessionId, { taskId: task.id, owner, title: task.title });
    if (task.status === 'awaiting_input' && task.pendingQuestionId && task.pendingQuestion) {
      decisions.push({ kind: 'question', taskId: task.id, sessionId: task.originSessionId ?? task.runSessionId,
        approvalId: null, questionId: task.pendingQuestionId, title: task.title,
        detail: task.pendingQuestion.slice(0, 600), owner, askedAt: task.updatedAt });
    }
  }
  for (const conversation of conversationsForProject(projectId, 50)) {
    if (!conversation.current) continue;
    sessions.set(conversation.sessionId, { taskId: null, owner: conversation.agentName ?? 'Clem', title: conversation.title ?? 'Conversation' });
  }
  try {
    for (const approval of approvalRegistry.listPending({ status: 'pending' })) {
      const from = sessions.get(approval.sessionId);
      if (!from || approvalRegistry.isExpired(approval)) continue;
      decisions.push({ kind: 'approval', taskId: from.taskId, sessionId: approval.sessionId, approvalId: approval.approvalId,
        questionId: null, title: from.title, detail: approval.subject.slice(0, 600), owner: from.owner, askedAt: approval.requestedAt });
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

export interface ProjectOverviewView {
  project: ProjectRecord;
  agents: AssignmentView[];
  resources: ProjectResource[];
  tasks: DelegatedTaskView[];
  conversations: ProjectConversationView[];
  decisions: ProjectDecisionView[];
}

export function projectOverview(projectId: string): ProjectOverviewView | null {
  const project = getProject(projectId);
  if (!project) return null;
  return {
    project,
    agents: listAssignments(project.id).map(assignmentView),
    resources: listResources(project.id),
    tasks: delegatedTasksForProject(project.id),
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
