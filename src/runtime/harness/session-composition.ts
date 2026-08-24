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
    };
  }

  return {
    kind,
    sessionId,
    sessionKind,
    workspaceSlug: null,
    workflow,
    memory: MEMORY,
    primers: [],
    pinnedTools: [],
    hotTools: [],
    toolAllowlist,
  };
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
