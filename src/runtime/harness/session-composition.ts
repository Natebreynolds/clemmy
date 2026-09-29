/**
 * Session composition root.
 *
 * The loop never learns a job type. Session identity mounts tools and primers
 * the way a plugin/profile would: same dispatch kernel, different surface.
 *
 *   chat            → memory inject + connected callable surface
 *   space-<slug>    → + workspace contract primer + space_* pin
 *   workflow:…      → + saved-bundle allowlist (caller-supplied)
 *   execution/agent → same kernel, different durable session kind
 *
 * Memory injects. It does not grant catalog reachability.
 * Workspaces are live profiles. Workflows are saved bundles.
 * Dispatch stays `dispatchAdmittedSource` regardless of mount.
 */
import { getSession, type SessionKind } from './eventlog.js';
import { HarnessSession } from './session.js';
import {
  buildWorkspaceContextPrimer,
  workspaceSlugFromSessionId,
  WORKSPACE_DOCK_HOT_TOOLS,
  WORKSPACE_DOCK_TOOLS,
} from '../../spaces/workspace-context.js';

import { resolveAgentBinding, type AgentBinding } from '../../agents/agent-binding.js';
import { resolveProjectBinding, type ProjectBinding } from '../../projects/project-binding.js';
import { sessionProjectState } from '../../projects/session-project-state.js';

export const WORKSPACE_CONTEXT_PRIMER_PREFIX = '[workspace-context]';

export type SessionMountKind = 'chat' | 'workspace' | 'workflow' | 'execution' | 'agent';

export interface SessionPrimer {
  prefix: string;
  text: string;
}

export interface SessionWorkflowIdentity {
  name: string | null;
  runId: string | null;
  stepId: string | null;
}

export interface SessionMount {
  kind: SessionMountKind;
  sessionId: string;
  /** Durable eventlog kind. Workspace docks remain `chat`. */
  sessionKind: SessionKind;
  workspaceSlug: string | null;
  workflow: SessionWorkflowIdentity | null;
  memory: { readonly inject: true; readonly grantsReachability: false };
  primers: readonly SessionPrimer[];
  /** Survive JIT pruning when the name is already reachable this turn. */
  pinnedTools: readonly string[];
  /** First-class schema-on-demand kernel (subset of pinnedTools). */
  hotTools: readonly string[];
  /** Saved-bundle restriction. Null = connected surface, not a job type. */
  toolAllowlist: readonly string[] | null;
  /** The saved agent this session works in, when it was opened in one. */
  agent: AgentBinding | null;
  /** The project this session works in, when it has one. */
  project: ProjectBinding | null;
}

/** Tools an agent's pinned workflows need first-class to be run by name. */
const AGENT_WORKFLOW_TOOLS: readonly string[] = Object.freeze(['workflow_get', 'workflow_run']);
const AGENT_SKILL_TOOLS: readonly string[] = Object.freeze(['skill_read']);

function agentFromMetadata(metadata: Record<string, unknown> | null | undefined): AgentBinding | null {
  const id = typeof metadata?.agentId === 'string' ? metadata.agentId.trim() : '';
  if (!id) return null;
  try {
    const binding = resolveAgentBinding(id);
    // A delegated task was given to one agent. A different agent saved later
    // under the same name is not the one it was given to.
    const given = typeof metadata?.delegatedAgentCreatedAt === 'string' ? metadata.delegatedAgentCreatedAt.trim() : '';
    if (binding && given && binding.agent.createdAt && binding.agent.createdAt !== given) return null;
    return binding;
  } catch {
    return null;
  }
}

function projectFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  agentId: string | null,
): ProjectBinding | null {
  const { projectId } = sessionProjectState(metadata);
  if (!projectId) return null;
  try {
    return resolveProjectBinding(projectId, { agentId });
  } catch {
    return null;
  }
}

/** A task the host delegated carries the agent and project it was given when
 * it was created. Nothing else that runs unattended takes either. */
function isDelegatedTask(metadata: Record<string, unknown> | null | undefined): boolean {
  return typeof metadata?.delegatedTaskId === 'string' && metadata.delegatedTaskId.trim() !== '';
}

export interface ComposeSessionInput {
  sessionId: string;
  sessionKind?: SessionKind | string | null;
  metadata?: Record<string, unknown> | null;
  toolAllowlist?: readonly string[] | null;
}

const MEMORY: SessionMount['memory'] = Object.freeze({
  inject: true as const,
  grantsReachability: false as const,
});

function stringMeta(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function workspaceSlugFromMountLineage(
  sessionId: string,
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const direct = workspaceSlugFromSessionId(sessionId);
  if (direct) return direct;
  const raw = metadata?.__session_mount;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const mount = raw as Record<string, unknown>;
  if (mount.version !== 1 || mount.kind !== 'workspace') return null;
  const slug = typeof mount.workspaceSlug === 'string' ? mount.workspaceSlug.trim() : '';
  const rootSessionId = typeof mount.rootSessionId === 'string' ? mount.rootSessionId.trim() : '';
  if (!slug || rootSessionId !== `space-${slug}`) return null;
  return workspaceSlugFromSessionId(rootSessionId) === slug ? slug : null;
}

function asSessionKind(value: string | null | undefined): SessionKind | null {
  if (value === 'chat' || value === 'execution' || value === 'workflow' || value === 'agent') {
    return value;
  }
  return null;
}

function workflowIdentity(
  sessionId: string,
  sessionKind: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): SessionWorkflowIdentity | null {
  if (sessionKind !== 'workflow' && !sessionId.startsWith('workflow:')) return null;
  let runId = stringMeta(metadata, 'workflowRunId') ?? stringMeta(metadata, 'runId');
  let stepId = stringMeta(metadata, 'stepId');
  const name = stringMeta(metadata, 'workflowName') ?? stringMeta(metadata, 'workflow');
  if ((!runId || !stepId) && sessionId.startsWith('workflow:')) {
    const parts = sessionId.slice('workflow:'.length).split(':');
    runId = runId ?? (parts[0] || null);
    stepId = stepId ?? (parts[1] || null);
  }
  return { name, runId, stepId };
}

function workspacePrimers(slug: string): SessionPrimer[] {
  const text = buildWorkspaceContextPrimer(slug);
  if (!text) return [];
  return [{ prefix: WORKSPACE_CONTEXT_PRIMER_PREFIX, text }];
}

function freezeNames(names: readonly string[] | null | undefined): readonly string[] | null {
  if (!names) return null;
  return Object.freeze([...names]);
}

/**
 * Identity-only mount. Does not read the user prompt, pick a provider, or
 * dispatch. Callers apply primers and pins; `dispatchAdmittedSource` stays
 * the one kernel.
 */
/**
 * Whether a session takes a saved agent and a project: a plain conversation,
 * or a task the host delegated. Decided from identity alone, without
 * resolving either binding, so it is cheap enough to ask on every read.
 */
export function sessionTakesIdentity(input: ComposeSessionInput): boolean {
  const sessionId = (input.sessionId ?? '').trim();
  if (sessionId && workspaceSlugFromMountLineage(sessionId, input.metadata)) return false;
  const givenKind = asSessionKind(input.sessionKind ?? null);
  if (workflowIdentity(sessionId, givenKind ?? input.sessionKind, input.metadata)) return false;
  if (givenKind === 'execution') return isDelegatedTask(input.metadata);
  return givenKind !== 'agent';
}

export function composeSession(input: ComposeSessionInput): SessionMount {
  const sessionId = (input.sessionId ?? '').trim();
  const workspaceSlug = sessionId
    ? workspaceSlugFromMountLineage(sessionId, input.metadata)
    : null;
  const givenKind = asSessionKind(input.sessionKind ?? null);
  const workflow = workflowIdentity(sessionId, givenKind ?? input.sessionKind, input.metadata);
  const kind: SessionMountKind = workspaceSlug
    ? 'workspace'
    : workflow
      ? 'workflow'
      : givenKind === 'execution' || givenKind === 'agent'
        ? givenKind
        : 'chat';
  const sessionKind: SessionKind = kind === 'workflow'
    ? 'workflow'
    : givenKind === 'execution' || givenKind === 'agent'
      ? givenKind
      : 'chat';
  const toolAllowlist = freezeNames(input.toolAllowlist);

  if (kind === 'workspace' && workspaceSlug) {
    return {
      kind,
      sessionId,
      sessionKind,
      workspaceSlug,
      workflow: null,
      memory: MEMORY,
      primers: workspacePrimers(workspaceSlug),
      pinnedTools: WORKSPACE_DOCK_TOOLS,
      hotTools: WORKSPACE_DOCK_HOT_TOOLS,
      toolAllowlist,
      agent: null,
      project: null,
    };
  }

  // A chat opened inside a saved agent: its standing context joins the
  // stable system prefix (see harnessInstructions), and the tools its pinned
  // workflows and skills need stay first-class. Nothing widens. A task the
  // host delegated to an agent mounts it the same way.
  const takesIdentity = kind === 'chat' || (kind === 'execution' && isDelegatedTask(input.metadata));
  const agent = takesIdentity ? agentFromMetadata(input.metadata) : null;
  const project = takesIdentity ? projectFromMetadata(input.metadata, agent?.agent.id ?? null) : null;
  const agentTools = agent || project
    ? [
        ...(agent && agent.agent.workflows.length > 0 ? AGENT_WORKFLOW_TOOLS : []),
        ...((agent && (agent.pinnedSkills.length > 0 || agent.missingSkills.length > 0))
          || (project && (project.pinnedSkills.length > 0 || project.missingSkills.length > 0))
          ? AGENT_SKILL_TOOLS : []),
      ]
    : [];

  return {
    kind,
    sessionId,
    sessionKind,
    workspaceSlug: null,
    workflow,
    memory: MEMORY,
    primers: [],
    pinnedTools: agentTools,
    hotTools: agentTools,
    toolAllowlist,
    agent,
    project,
  };
}

/**
 * The standing context a mount adds to the stable system prefix: who the
 * work runs as, then the project it runs in. Empty for an unattached turn,
 * so its prefix is byte-for-byte what it was.
 */
export function sessionMountContext(mount: Pick<SessionMount, 'agent' | 'project'>): string {
  return [mount.agent?.context ?? '', mount.project?.context ?? ''].filter(Boolean).join('\n\n');
}

/**
 * The agent a session was opened in, as bounded event fields, so a route
 * marker can say who the turn ran as. Empty for an unbound session.
 */
export function sessionAgentFields(sessionId: string | null | undefined): { agentId?: string; agentName?: string } {
  if (!sessionId) return {};
  try {
    const metadata = getSession(sessionId)?.metadata;
    const agentId = typeof metadata?.agentId === 'string' ? metadata.agentId.trim() : '';
    if (!agentId) return {};
    const agentName = typeof metadata?.agentName === 'string' ? metadata.agentName.trim().slice(0, 64) : '';
    return { agentId, ...(agentName ? { agentName } : {}) };
  } catch {
    return {};
  }
}

/**
 * The project a session works in, as bounded event fields, so a route marker
 * can say which project the turn worked in and which rendering of it.
 */
export function sessionProjectFields(sessionId: string | null | undefined): {
  projectId?: string; projectName?: string; projectRevision?: string;
} {
  if (!sessionId) return {};
  try {
    const row = getSession(sessionId);
    const mount = composeSession({ sessionId, sessionKind: row?.kind, metadata: row?.metadata });
    if (!mount.project) return {};
    return {
      projectId: mount.project.project.id,
      projectName: mount.project.project.name.slice(0, 80),
      projectRevision: mount.project.revision,
    };
  } catch {
    return {};
  }
}

/** Look up the durable row when present; identity still parses from the id. */
export function composeSessionFromStore(
  sessionId: string,
  extra?: { toolAllowlist?: readonly string[] | null },
): SessionMount {
  let sessionKind: SessionKind | undefined;
  let metadata: Record<string, unknown> | undefined;
  try {
    const row = getSession(sessionId);
    sessionKind = row?.kind;
    metadata = row?.metadata;
  } catch {
    // Store unavailable — the session id still identifies the mount.
  }
  return composeSession({
    sessionId,
    sessionKind,
    metadata,
    toolAllowlist: extra?.toolAllowlist,
  });
}

/** Characters of an agent's standing instructions a reviewer is shown. */
const AGENT_REVIEW_MAX_CHARS = 6_000;

/**
 * What a reviewer needs to judge a reply written inside a saved agent: its
 * name, what it handles, its standing instructions and the skills it pins.
 * Empty for a turn Clem answered without an agent. The pinned skill bodies
 * stay with the answerer; the reviewer opens a skill it needs by name.
 */
export function sessionAgentReviewContext(sessionId: string | null | undefined): string {
  if (!sessionId) return '';
  try {
    const metadata = getSession(sessionId)?.metadata;
    const agentId = metadata?.agentId;
    const binding = typeof agentId === 'string' ? resolveAgentBinding(agentId) : null;
    const project = projectReviewContext(metadata, binding?.agent.id ?? null);
    if (!binding) return project;
    const { agent } = binding;
    const instructions = agent.instructions.length > AGENT_REVIEW_MAX_CHARS
      ? `${agent.instructions.slice(0, AGENT_REVIEW_MAX_CHARS)}\n[instructions cut here for length]`
      : agent.instructions;
    return [
      `Agent: ${agent.name}`,
      agent.handles ? `Handles: ${agent.handles}` : '',
      instructions ? `Standing instructions:\n${instructions}` : '',
      binding.pinnedSkills.length > 0 ? `Pinned skills: ${binding.pinnedSkills.join(', ')}` : '',
      project,
    ].filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

/** What a reviewer needs to judge work done inside a project: what the
 * project is for, and the part the answering agent has in it. */
function projectReviewContext(metadata: Record<string, unknown> | null | undefined, agentId: string | null): string {
  const project = projectFromMetadata(metadata, agentId);
  if (!project) return '';
  const context = project.context.length > AGENT_REVIEW_MAX_CHARS
    ? `${project.context.slice(0, AGENT_REVIEW_MAX_CHARS)}\n[project context cut here for length]`
    : project.context;
  return `Project context:\n${context}`;
}

/**
 * Durable eventlog kind for a newly created session. Workspace docks stay
 * `chat`; only workflow identity changes the kind.
 */
export function durableSessionKind(
  mount: SessionMount,
  opts?: { surface?: string | null },
): SessionKind {
  if (mount.kind === 'workflow') return 'workflow';
  if (mount.kind === 'execution' || mount.kind === 'agent') return mount.kind;
  const surface = (opts?.surface ?? '').toLowerCase();
  if (surface === 'background' || surface === 'cron') return 'execution';
  return 'chat';
}

function addReachable(
  target: Set<string>,
  names: readonly string[],
  reachable: Iterable<string>,
): Set<string> {
  const allowed = reachable instanceof Set ? reachable : new Set(reachable);
  for (const name of names) {
    if (allowed.has(name)) target.add(name);
  }
  return target;
}

/** Keep composition-pinned tools on a JIT-reduced surface. */
export function pinCompositionTools(
  exposed: Set<string>,
  mount: SessionMount,
  reachable: Iterable<string>,
): Set<string> {
  return addReachable(exposed, mount.pinnedTools, reachable);
}

/** Keep the composition hot kernel first-class under schema-on-demand. */
export function pinCompositionHotTools(
  hot: Set<string>,
  mount: SessionMount,
  reachable: Iterable<string>,
): Set<string> {
  return addReachable(hot, mount.hotTools, reachable);
}

/**
 * Seed prefix-keyed context primers onto the Codex conversation snapshot.
 * Idempotent: `HarnessSession.setContextPrimer` no-ops when text is current.
 * Best-effort: a missing session never fails the turn.
 */
export function applySessionMountPrimers(sessionId: string, mount: SessionMount): void {
  if (mount.primers.length === 0) return;
  try {
    const session = HarnessSession.load(sessionId);
    if (!session) return;
    for (const primer of mount.primers) {
      if (primer.text) session.setContextPrimer(primer.prefix, primer.text);
    }
  } catch {
    // Primer mount is composition, never turn authority.
  }
}

export function renderSessionMountPrimers(mount: SessionMount): string {
  return mount.primers.map((primer) => primer.text).filter(Boolean).join('\n\n');
}
