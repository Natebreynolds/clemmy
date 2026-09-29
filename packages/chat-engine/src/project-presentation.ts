/**
 * Projects, the agents assigned to them and scoped memory, as both apps show
 * them. The shapes are what the projects API returns; the functions are the
 * words drawn from those shapes, so the desktop and the phone say the same
 * thing about the same record.
 *
 * A project here is a durable body of work. It is not a code folder and it
 * is not a Space; a project may list Spaces among what it uses.
 */
import type { DelegatedTask } from './delegated-task.js';

export interface ProjectSummary {
  id: string;
  name: string;
  purpose: string;
  status: 'active' | 'archived';
  updatedAt: string;
  agents: Array<{ agentId: string; agentName: string }>;
  activeTasks: number;
  needsYou: number;
}

export interface ProjectRecordView {
  id: string;
  name: string;
  purpose: string;
  goals: string[];
  context: string;
  status: 'active' | 'archived';
  revision: number;
  createdFrom: 'chat' | 'console' | 'phone' | null;
  originSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ProjectAssignmentView {
  agentId: string;
  agentName: string;
  handles: string;
  /** False when the agent assigned was deleted or replaced. */
  available: boolean;
  responsibility: string;
  context: string;
  skills: string[];
  shareMethods: boolean;
  revision: number;
  assignedAt: string;
}

export type ProjectResourceKind = 'account' | 'space' | 'workflow' | 'folder' | 'link';

export interface ProjectResourceView {
  id: string;
  projectId: string;
  kind: ProjectResourceKind;
  label: string;
  toolkit: string | null;
  /** For an account: the app's name as a person writes it. */
  appName?: string | null;
  accountId: string | null;
  ref: string | null;
  verifiedAt: string | null;
  state: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectConversationView {
  sessionId: string;
  title: string | null;
  updatedAt: string;
  agentName: string | null;
  /** True when the conversation works in this project now, not only before. */
  current: boolean;
}

export interface ProjectDecisionView {
  kind: 'question' | 'approval';
  /**
   * False for something asked in the conversation's own words: it is
   * answered there, and is never approved or declined from a card. Absent
   * from a service that predates the field, where every decision was formal.
   */
  formal?: boolean;
  /** A question's offered answers; empty for an approval. Absent from a
   *  service that predates the field. */
  options?: string[];
  taskId: string | null;
  sessionId: string;
  approvalId: string | null;
  questionId: string | null;
  title: string;
  detail: string;
  owner: string;
  askedAt: string;
}

export interface ProjectOverview {
  project: ProjectRecordView;
  agents: ProjectAssignmentView[];
  resources: ProjectResourceView[];
  tasks: DelegatedTask[];
  conversations: ProjectConversationView[];
  decisions: ProjectDecisionView[];
}

export interface AgentAssignments {
  agentId: string;
  projects: Array<{ projectId: string; projectName: string; responsibility: string; shareMethods: boolean; activeTasks: number }>;
  /** Tasks it owns that are not finished. */
  currentTasks: DelegatedTask[];
  /** Tasks it owned that ended, newest first. */
  recentOutcomes: DelegatedTask[];
}

/** An account the owner can bind, as the live connection list names it. */
export interface ProjectAccountChoice { accountId: string; label: string }

/** An app with an account connected right now. `name` is how a person writes it. */
export interface ProjectConnectedApp { toolkit: string; name: string; accounts: ProjectAccountChoice[] }

/** Which project a session works in, for labelling what waits on the owner. */
export interface SessionProjectLabel {
  sessionId: string;
  projectId: string;
  projectName: string;
  agentName: string | null;
  taskId: string | null;
}

/** Labels by the session they belong to. A session in no project has none. */
export function projectLabelsBySession(labels: readonly SessionProjectLabel[]): Map<string, SessionProjectLabel> {
  const bySession = new Map<string, SessionProjectLabel>();
  for (const label of labels) {
    if (label?.sessionId && label.projectName?.trim() && !bySession.has(label.sessionId)) bySession.set(label.sessionId, label);
  }
  return bySession;
}

/** "Weekly Sales", or "Weekly Sales · Sales Assistant" when an agent is on it. */
export function sessionProjectLabelText(label: Pick<SessionProjectLabel, 'projectName' | 'agentName'>): string {
  const project = label.projectName.trim();
  const agent = label.agentName?.trim();
  return agent ? `${project} · ${agent}` : project;
}

/** The answers a question offers, as one-tap replies; none for anything else. */
export function projectDecisionOptions(decision: Pick<ProjectDecisionView, 'kind' | 'options'>): string[] {
  if (decision.kind !== 'question') return [];
  return (decision.options ?? []).filter((option) => typeof option === 'string' && option.trim().length > 0);
}

/** True when a decision is made on a card; false when it is answered in the conversation. */
export function projectDecisionIsFormal(decision: Pick<ProjectDecisionView, 'formal'>): boolean {
  return decision.formal !== false;
}

/** The app an account belongs to, as a person writes it; never the slug when a name is known. */
export function projectResourceApp(resource: Pick<ProjectResourceView, 'appName' | 'toolkit' | 'kind'>): string {
  if (resource.kind !== 'account') return '';
  return resource.appName?.trim() || resource.toolkit?.trim() || '';
}

/** Where a fact applies. `user` is everywhere. */
export interface MemoryScope {
  kind: 'user' | 'project' | 'agent' | 'project_agent';
  projectId: string | null;
  projectName: string | null;
  agentId: string | null;
  agentName: string | null;
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "Everywhere", "Weekly Sales", "Sales Assistant", "Sales Assistant in Weekly Sales". */
export function memoryScopeLabel(scope: MemoryScope | null | undefined): string {
  if (!scope || scope.kind === 'user') return 'Everywhere';
  const project = scope.projectName?.trim() || 'a project';
  const agent = scope.agentName?.trim() || 'an agent';
  if (scope.kind === 'project') return scope.projectName?.trim() || 'One project';
  if (scope.kind === 'agent') return scope.agentName?.trim() || 'One agent';
  return `${agent} in ${project}`;
}

/** What the chip's tooltip says about where the fact is used. */
export function memoryScopeHint(scope: MemoryScope | null | undefined): string {
  if (!scope || scope.kind === 'user') return 'Used in every conversation';
  if (scope.kind === 'project') return `Used only in ${scope.projectName?.trim() || 'this project'}`;
  if (scope.kind === 'agent') return `Used only by ${scope.agentName?.trim() || 'this agent'}`;
  return `Used only by ${scope.agentName?.trim() || 'this agent'} in ${scope.projectName?.trim() || 'this project'}`;
}

/** True when a fact is kept to a project, an agent, or both. */
export function memoryScopeIsNarrow(scope: MemoryScope | null | undefined): boolean {
  return Boolean(scope && scope.kind !== 'user');
}

/** The agents assigned to a project, by name: all of them up to `max`, then a count. */
export function projectAgentsLine(summary: Pick<ProjectSummary, 'agents'>, max = 3): string {
  const names = (summary.agents ?? []).map((agent) => agent.agentName?.trim()).filter((name): name is string => Boolean(name));
  if (names.length === 0) return 'No agents assigned';
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/** How much work is moving in a project. */
export function projectWorkLine(summary: Pick<ProjectSummary, 'activeTasks'>): string {
  const active = Math.max(0, Math.floor(summary.activeTasks || 0));
  return active === 0 ? 'Nothing running' : `${count(active, 'task')} active`;
}

/** The marker on a project with something waiting on the owner; null with nothing waiting. */
export function projectNeedsYouLabel(summary: Pick<ProjectSummary, 'needsYou'>): string | null {
  const waiting = Math.max(0, Math.floor(summary.needsYou || 0));
  if (waiting === 0) return null;
  return waiting === 1 ? 'Needs you' : `${waiting} need you`;
}

/** Active projects with anything waiting on the owner first, then the most recently changed; archived apart. */
export function arrangeProjects<T extends Pick<ProjectSummary, 'status' | 'needsYou' | 'updatedAt'>>(
  projects: readonly T[],
): { active: T[]; archived: T[] } {
  const recent = (a: T, b: T) => b.updatedAt.localeCompare(a.updatedAt);
  const active = projects.filter((project) => project.status !== 'archived')
    .sort((a, b) => Number(b.needsYou > 0) - Number(a.needsYou > 0) || recent(a, b));
  const archived = projects.filter((project) => project.status === 'archived').sort(recent);
  return { active, archived };
}

const RESOURCE_KIND_WORDS: Record<ProjectResourceKind, { one: string; many: string }> = {
  account: { one: 'Account', many: 'Accounts' },
  space: { one: 'Space', many: 'Spaces' },
  workflow: { one: 'Workflow', many: 'Workflows' },
  folder: { one: 'Folder', many: 'Folders' },
  link: { one: 'Link', many: 'Links' },
};

export function projectResourceKindLabel(kind: string, plural = false): string {
  const words = RESOURCE_KIND_WORDS[kind as ProjectResourceKind];
  if (!words) return plural ? 'Other' : 'Resource';
  return plural ? words.many : words.one;
}

/** What to call a resource: the owner's label, else what it points at. */
export function projectResourceName(resource: Pick<ProjectResourceView, 'label' | 'ref' | 'toolkit' | 'kind'>): string {
  return resource.label?.trim() || resource.ref?.trim() || resource.toolkit?.trim() || projectResourceKindLabel(resource.kind);
}

/**
 * Whether a binding was checked against what is connected. Only an account
 * is ever checked; anything else is a pointer the owner attached, and says
 * nothing either way.
 */
export function projectResourceVerification(
  resource: Pick<ProjectResourceView, 'kind' | 'verifiedAt'>,
): { verified: boolean; label: string } | null {
  if (resource.kind !== 'account') return null;
  return resource.verifiedAt
    ? { verified: true, label: 'Verified' }
    : { verified: false, label: 'Not verified' };
}

/** Resources grouped by kind, accounts first, each group in the order given. */
export function groupProjectResources<T extends Pick<ProjectResourceView, 'kind'>>(
  resources: readonly T[],
): Array<{ kind: ProjectResourceKind; label: string; items: T[] }> {
  const order: ProjectResourceKind[] = ['account', 'space', 'workflow', 'folder', 'link'];
  return order
    .map((kind) => ({ kind, label: projectResourceKindLabel(kind, true), items: resources.filter((resource) => resource.kind === kind) }))
    .filter((group) => group.items.length > 0);
}

/** Who is asking and about what: "Sales Assistant · Draft the weekly briefing". */
export function projectDecisionSource(decision: Pick<ProjectDecisionView, 'owner' | 'title'>): string {
  const owner = decision.owner?.trim() || 'Clem';
  const title = decision.title?.trim();
  return title ? `${owner} · ${title}` : owner;
}

/** What answering does, said before the owner answers. */
export function projectDecisionConsequence(decision: Pick<ProjectDecisionView, 'kind' | 'taskId' | 'owner' | 'formal'>): string {
  const owner = decision.owner?.trim() || 'Clem';
  if (decision.formal === false) return `${owner} asked this in the conversation and continues once you reply there.`;
  if (decision.kind === 'question') return `${owner} is waiting on your answer and continues once you give it.`;
  return decision.taskId
    ? `${owner} is paused on this. Approving lets the task continue; declining stops this step.`
    : `${owner} is paused on this. Approving lets the reply continue; declining stops this step.`;
}
