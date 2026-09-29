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

/**
 * A local project: a code folder on this machine, from the roster the app
 * keeps. A project links to local projects; it never is one, and a local
 * project is never called a "project" on its own.
 */
export interface ProjectLocalProject {
  name: string;
  path: string;
  /** What kind of code it holds, as the roster detects it. */
  type: string;
  description: string;
  /** Whether it is a repository, which coding work needs. */
  git: boolean;
}

/** A local project as a project's resource shows it: what the folder is now. */
export interface ProjectLinkedLocalProject {
  name: string;
  path: string;
  /** False when the folder is no longer on this machine. */
  present: boolean;
  git: boolean;
  /** What the folder offers whoever works in it. Absent from a server that
   * does not describe it; nothing is claimed then. */
  instructions?: string[];
  commands?: string[];
  toolServers?: ProjectLocalToolServer[];
}

/** A tool server a local project declares, and whether Clem is connected to
 * one of the same name. Declaring one connects nothing. */
export interface ProjectLocalToolServer {
  name: string;
  connected: boolean;
}

/** A page made in a project: an HTML file written into a linked local project. */
export interface ProjectPageView {
  id: string;
  name: string;
  /** The folder the file lies in. */
  folder: string;
  /** Where it is inside the local project. */
  relativePath: string;
  localProject: { name: string; path: string };
  madeAt: string;
  sessionId: string | null;
}

/** One part of a page, rendered on the Mac. */
export interface ProjectPageImage {
  image: string;
  mimeType: string;
  width: number;
  height: number;
  offsetY: number;
  /** The part shows nothing: the page ended above it. */
  end: boolean;
}

export type ProjectCodingRunPhase = 'waiting_to_start' | 'working' | 'handed_to_you' | 'finished';

/** One coding run started from a conversation of the project. */
export interface ProjectCodingRunView {
  runId: string;
  objective: string;
  /** The local project it works in, and whether that one is linked to the project. */
  localProject: { name: string; path: string; linked: boolean };
  branch: string;
  phase: ProjectCodingRunPhase;
  originSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectResourceView {
  id: string;
  projectId: string;
  kind: ProjectResourceKind;
  label: string;
  toolkit: string | null;
  /** For an account: the app's name as a person writes it. */
  appName?: string | null;
  /** For a linked local project (kind 'folder'): what the folder is now.
   *  Null for every other kind; absent from a service that predates it. */
  localProject?: ProjectLinkedLocalProject | null;
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
  /** Coding runs started from the project's conversations, newest first.
   *  Absent from a service that predates them. */
  codingRuns?: ProjectCodingRunView[];
  /** Pages that work in the project wrote into its linked local projects,
   *  newest first. Absent from a service that predates them. */
  pages?: ProjectPageView[];
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
  folder: { one: 'Local project', many: 'Local projects' },
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

/** Said once under the "Local projects" heading. */
export const PROJECT_LOCAL_PROJECTS_HINT = 'Where Clem works on files and code for this project.';

/**
 * Resources grouped by kind: local projects first, then accounts, then the
 * rest; each group in the order given. A group may carry one line that says
 * what it is for.
 */
export function groupProjectResources<T extends Pick<ProjectResourceView, 'kind'>>(
  resources: readonly T[],
): Array<{ kind: ProjectResourceKind; label: string; hint?: string; items: T[] }> {
  const order: ProjectResourceKind[] = ['folder', 'account', 'space', 'workflow', 'link'];
  return order
    .map((kind) => ({
      kind,
      label: projectResourceKindLabel(kind, true),
      ...(kind === 'folder' ? { hint: PROJECT_LOCAL_PROJECTS_HINT } : {}),
      items: resources.filter((resource) => resource.kind === kind),
    }))
    .filter((group) => group.items.length > 0);
}

// ─── Pages made in a project ───

export const PROJECT_PAGES_LABEL = 'Pages made here';
export const PROJECT_PAGES_HINT = 'Pages Clem wrote into this project\u2019s local projects. Looking at one changes nothing.';
export const PROJECT_PAGES_EMPTY = 'No page has been made in this project yet.';
/** What the desktop's frame allows a page: its scripts, and nothing of the app. */
export const PROJECT_PAGE_FRAME_SANDBOX = 'allow-scripts';
export const PROJECT_PAGE_FRAME_NOTE = 'Shown in a sandbox: the page cannot reach Clem, your accounts or your files.';
export const PROJECT_PAGE_RENDERED_NOTE = 'Rendered on your Mac at this width. Nothing on the page runs here.';
/** How tall one rendered part is, and how many parts a reader asks for at most. */
export const PROJECT_PAGE_PART_HEIGHT = 1600;
export const PROJECT_PAGE_MOST_PARTS = 12;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The pages of an overview as this build can read them; anything else is left out. */
export function projectPages(overview: { pages?: unknown } | null | undefined): ProjectPageView[] {
  const value = overview?.pages;
  if (!Array.isArray(value)) return [];
  const pages: ProjectPageView[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const raw = row as Record<string, unknown>;
    const id = text(raw.id);
    const relativePath = text(raw.relativePath);
    if (!id || pages.some((page) => page.id === id)) continue;
    const local = (raw.localProject && typeof raw.localProject === 'object' ? raw.localProject : {}) as Record<string, unknown>;
    const name = text(raw.name) || pathLeaf(relativePath) || 'Page';
    pages.push({
      id, name,
      folder: text(raw.folder),
      relativePath,
      localProject: { name: text(local.name) || pathLeaf(text(local.path)) || 'a local project', path: text(local.path) },
      madeAt: text(raw.madeAt),
      sessionId: text(raw.sessionId) || null,
    });
  }
  return pages;
}

/** What a page is called: its folder when the file is only an index, else its file name. */
export function projectPageTitle(page: Pick<ProjectPageView, 'name' | 'folder'>): string {
  const name = page.name.trim();
  const folder = page.folder.trim();
  return /^index\.html?$/i.test(name) && folder ? folder : name || folder || 'Page';
}

/** Where a page is: the local project, then the path inside it. */
export function projectPagePlace(page: Pick<ProjectPageView, 'localProject' | 'relativePath'>): string {
  const project = page.localProject?.name?.trim() || 'a local project';
  return page.relativePath ? `In ${project} \u00b7 ${page.relativePath}` : `In ${project}`;
}

/** Where the next part of a rendered page starts, or null when there is no more to ask for. */
export function projectPageNextOffset(parts: ReadonlyArray<Pick<ProjectPageImage, 'offsetY' | 'height' | 'end'>>): number | null {
  if (parts.length === 0) return 0;
  const last = parts[parts.length - 1]!;
  if (last.end || parts.length >= PROJECT_PAGE_MOST_PARTS) return null;
  return last.offsetY + last.height;
}

/** Said in place of a page that could not be shown. */
export function projectPageRefusal(code: string | null | undefined): string {
  switch ((code ?? '').toUpperCase()) {
    case 'PAGE_NOT_FOUND': return 'That page is no longer where it was written, or its folder is no longer linked to this project.';
    case 'PAGE_TOO_LARGE': return 'That page is too large to show here. Open it in your browser on your Mac.';
    case 'PAGE_NOT_RENDERED': return 'Your Mac could not render the page. It needs Chrome, Edge, Brave or Chromium installed.';
    case 'THIS_MACHINE_ONLY': return 'That can only be done on your Mac.';
    case 'NOT_SUPPORTED_HERE': return 'Opening a page in the browser works on a Mac only.';
    default: return 'The page could not be shown. Try again.';
  }
}

// ─── Local projects and coding work ───

/**
 * The local project a folder resource links to. A resource saved before the
 * server described folders has only its label and path; nothing is claimed
 * about whether that folder is still there.
 */
export function projectLinkedLocalProject(
  resource: Pick<ProjectResourceView, 'kind' | 'label' | 'ref' | 'localProject'>,
): (ProjectLinkedLocalProject & { known: boolean }) | null {
  if (resource.kind !== 'folder') return null;
  const described = resource.localProject;
  if (described) {
    return {
      name: described.name?.trim() || pathLeaf(described.path) || 'Local project',
      path: described.path,
      present: described.present === true,
      git: described.git === true,
      instructions: names(described.instructions),
      commands: names(described.commands),
      toolServers: toolServers(described.toolServers),
      known: true,
    };
  }
  const path = resource.ref?.trim() ?? '';
  return { name: resource.label?.trim() || pathLeaf(path) || 'Local project', path, present: true, git: true, known: false };
}

/** Only what is a name is kept; an answer this build cannot read is left out. */
function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const kept: string[] = [];
  for (const entry of value) {
    const name = typeof entry === 'string' ? entry.trim() : '';
    if (name && !kept.includes(name)) kept.push(name);
  }
  return kept;
}

function toolServers(value: unknown): ProjectLocalToolServer[] {
  if (!Array.isArray(value)) return [];
  const kept: ProjectLocalToolServer[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as { name?: unknown; connected?: unknown };
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    // Only an explicit yes says Clem can reach it.
    if (name && !kept.some((row) => row.name === name)) kept.push({ name, connected: raw.connected === true });
  }
  return kept;
}

function pathLeaf(path: string | null | undefined): string {
  const parts = (path ?? '').split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Said when the folder is gone; null while it is there. */
export function projectLocalProjectMissingLine(localProject: Pick<ProjectLinkedLocalProject, 'present'>): string | null {
  return localProject.present ? null : 'This folder is no longer on this Mac. Remove it, or link the local project where it lives now.';
}

export const PROJECT_LOCAL_COMMANDS_LABEL = 'Commands it offers';
export const PROJECT_LOCAL_COMMANDS_HINT = 'Ask for one by name in a conversation in this project.';
export const PROJECT_LOCAL_TOOL_SERVERS_LABEL = 'Tools it expects';

/** The commands a local project names, in its own order; empty when it names none. */
export function projectLocalProjectCommands(localProject: Pick<ProjectLinkedLocalProject, 'commands'>): string[] {
  return names(localProject.commands);
}

/**
 * The tool servers a local project declares, the connected ones first, and
 * what to say about the ones Clem cannot reach. Null line when none is missing.
 */
export function projectLocalProjectToolServers(localProject: Pick<ProjectLinkedLocalProject, 'toolServers'>): {
  servers: ProjectLocalToolServer[];
  missing: string[];
  missingLine: string | null;
} {
  const all = toolServers(localProject.toolServers);
  const servers = [...all.filter((row) => row.connected), ...all.filter((row) => !row.connected)];
  const missing = servers.filter((row) => !row.connected).map((row) => row.name);
  const missingLine = missing.length === 0 ? null
    : missing.length === 1
      ? `${missing[0]} is not connected. Work here that needs it will say so until it is connected in Connect.`
      : `${listOf(missing)} are not connected. Work here that needs them will say so until they are connected in Connect.`;
  return { servers, missing, missingLine };
}

function listOf(items: string[]): string {
  return items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Said when the folder is there and is not a repository; null otherwise. */
export function projectLocalProjectGitLine(localProject: Pick<ProjectLinkedLocalProject, 'present' | 'git'>): string | null {
  return localProject.present && !localProject.git ? 'Coding work cannot run here yet: this folder is not a git repository.' : null;
}

/**
 * A path short enough for one line, cut in the middle so that where it
 * starts and the folder it ends in both stay readable.
 */
export function middleTruncatePath(path: string, max = 48): string {
  const text = (path ?? '').trim();
  if (text.length <= max || max < 8) return text;
  const keep = max - 1;
  const tail = Math.ceil(keep * 0.6);
  const head = keep - tail;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** The roster as a picker shows it: each local project, and whether the project already links it. */
export function projectLocalProjectChoices<T extends Pick<ProjectLocalProject, 'path' | 'name'>>(
  roster: readonly T[],
  resources: readonly Pick<ProjectResourceView, 'kind' | 'ref'>[],
): Array<{ localProject: T; linked: boolean }> {
  const linked = new Set(resources.filter((resource) => resource.kind === 'folder' && resource.ref).map((resource) => resource.ref as string));
  const seen = new Set<string>();
  return roster
    .filter((row) => (row.path && !seen.has(row.path) ? (seen.add(row.path), true) : false))
    .map((localProject) => ({ localProject, linked: linked.has(localProject.path) }))
    .sort((a, b) => a.localProject.name.localeCompare(b.localProject.name));
}

/** Why a local project was not linked, in words; null for anything else. */
export function projectLocalProjectRefusal(code: string | null | undefined, named?: string | null): string | null {
  const name = named?.trim();
  if (code === 'LOCAL_PROJECT_CHOICE_REQUIRED') {
    return name ? `More than one local project is called “${name}”. Choose the one you mean.` : 'Choose which local project to link.';
  }
  if (code === 'LOCAL_PROJECT_NOT_FOUND') {
    return name
      ? `“${name}” is not among the code folders on this Mac. Choose one of these, or add the folder in Connect first.`
      : 'That folder is not among the code folders on this Mac. Choose one of these, or add the folder in Connect first.';
  }
  return null;
}

const CODING_PHASE_WORDS: Record<ProjectCodingRunPhase, { label: string; tone: 'neutral' | 'live' | 'info' | 'success'; settled: boolean }> = {
  waiting_to_start: { label: 'Waiting to start', tone: 'neutral', settled: false },
  working: { label: 'Working', tone: 'live', settled: false },
  handed_to_you: { label: 'Handed to you', tone: 'info', settled: false },
  finished: { label: 'Finished', tone: 'success', settled: true },
};

/** A coding run's phase in words. One this build does not know reads as working, never as finished. */
export function projectCodingRunPhase(phase: string): { label: string; tone: 'neutral' | 'live' | 'info' | 'success'; settled: boolean } {
  return CODING_PHASE_WORDS[phase as ProjectCodingRunPhase] ?? CODING_PHASE_WORDS.working;
}

/** Where a coding run works: "in clementine-next", and that it is not linked here when it is not. */
export function projectCodingRunPlace(run: Pick<ProjectCodingRunView, 'localProject'>): string {
  const name = run.localProject?.name?.trim() || pathLeaf(run.localProject?.path) || 'a local project';
  return run.localProject?.linked === false ? `In ${name}, which is not linked to this project` : `In ${name}`;
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
