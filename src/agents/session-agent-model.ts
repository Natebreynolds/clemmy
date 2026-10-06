/**
 * The model a conversation answers on while it is switched to a saved agent
 * the owner pinned a model to.
 *
 * Switching to an agent set to a model answers on that model, not on the
 * model the owner happens to use elsewhere. The agent's model applies from
 * the switch until the owner picks a model for this conversation on the
 * model chip; the later choice wins. Execution stops when the saved choice is
 * unavailable; the nonthrowing picker helpers remain preview reads only.
 */
import { getSession, openEventLog } from '../runtime/harness/eventlog.js';
import { modelProviderLive, resolveRoleModel, type ModelRole, type ResolvedRoleModel } from '../runtime/harness/model-roles.js';
import { resolveProvider } from '../runtime/harness/model-wire-registry.js';
import { routedPrimaryModel } from '../runtime/harness/router-model.js';
import { agentModelIsRole } from './agent-binding.js';
import { getAgentRecord } from './agent-record.js';
import { sessionAgentState } from './session-agent-state.js';

export interface SessionAgentModel {
  modelId: string;
  agentId: string;
  agentName: string;
}

export interface SessionAgentModelDeps {
  metadataOf: (sessionId: string) => Record<string, unknown> | null;
  agentModel: (agentId: string) => { name: string; model: string | null } | null;
  live: (modelId: string) => boolean;
  roleModel: (role: ModelRole) => Pick<ResolvedRoleModel, 'modelId' | 'inactiveBinding'>;
}

const productionDeps: SessionAgentModelDeps = {
  metadataOf: (sessionId) => getSession(sessionId)?.metadata ?? null,
  agentModel: (agentId) => {
    const agent = getAgentRecord(agentId);
    return agent ? { name: agent.name, model: agent.model } : null;
  },
  live: (modelId) => modelProviderLive(modelId, resolveProvider(modelId)),
  roleModel: resolveRoleModel,
};

export type SessionAgentExecutionModel =
  | { kind: 'default' }
  | ({ kind: 'pinned' } & SessionAgentModel)
  | { kind: 'unavailable'; modelId: string | null; savedModel: string | null;
      agentId: string | null; agentName: string | null; reason: 'not_connected' | 'unverified' };
export type UnavailableSessionAgentModel = Extract<SessionAgentExecutionModel, { kind: 'unavailable' }>;

/** A saved name must still route to itself and its declared owning provider.
 * Canonical route selection is pure: it constructs no model and performs no
 * provider I/O. In particular an all-in collapse is not availability. */
export function savedAgentModelExecutionLive(modelId: string, deps: {
  route: (modelId: string) => Pick<ReturnType<typeof routedPrimaryModel>, 'modelId' | 'provider'>;
  live: typeof modelProviderLive;
} = { route: routedPrimaryModel, live: modelProviderLive }): boolean {
  try {
    const route = deps.route(modelId);
    return route.modelId === modelId && deps.live(modelId, route.provider);
  } catch { return false; }
}

function time(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

let depsForTests: Partial<SessionAgentModelDeps> = {};
/** Test seam: replace how liveness, agents or metadata are read. */
export function _setSessionAgentModelDepsForTests(overrides: Partial<SessionAgentModelDeps>): void { depsForTests = overrides; }

/** Execution never converts an unavailable saved choice into owner-default
 * routing. The later model-chip choice still wins; role pins resolve through
 * the canonical role reader, but its inactive binding is a refusal, not a
 * grant to dispatch the reader's default substitute. No provider call runs. */
export function sessionAgentExecutionModel(sessionId: string,
  overrides: Partial<SessionAgentModelDeps> = {}): SessionAgentExecutionModel {
  const deps = { ...productionDeps, ...depsForTests, ...overrides };
  const executionLive = overrides.live ?? depsForTests.live ?? savedAgentModelExecutionLive;
  let agentId: string | null = null; let agentName: string | null = null;
  let savedModel: string | null = null; let modelId: string | null = null;
  try {
    const metadata = deps.metadataOf(sessionId);
    const state = sessionAgentState(metadata);
    agentId = state.agentId; agentName = state.agentName;
    if (!agentId) return { kind: 'default' };
    const chosenAt = time(metadata?.brainChosenAt);
    const switchedAt = time(metadata?.agentSetAt);
    if (chosenAt !== null && (switchedAt === null || chosenAt >= switchedAt)) return { kind: 'default' };
    const agent = deps.agentModel(agentId);
    if (!agent) throw new Error('The saved agent could not be verified.');
    agentName = agent.name;
    savedModel = agent.model?.trim() || null;
    if (!savedModel) return { kind: 'default' };
    modelId = savedModel;
    if (agentModelIsRole(savedModel)) {
      const resolved = deps.roleModel(savedModel.toLowerCase() as ModelRole);
      if (resolved.inactiveBinding) {
        return { kind: 'unavailable', modelId: resolved.inactiveBinding.modelId, savedModel,
          agentId, agentName, reason: 'not_connected' };
      }
      modelId = resolved.modelId.trim() || null;
    }
    if (!modelId || !executionLive(modelId)) return { kind: 'unavailable', modelId, savedModel,
      agentId, agentName, reason: 'not_connected' };
    return { kind: 'pinned', modelId, agentId, agentName };
  } catch {
    return { kind: 'unavailable', modelId, savedModel, agentId, agentName, reason: 'unverified' };
  }
}

/** Nonthrowing preview: a live saved choice, or no currently available chip
 * override. This value alone never authorizes owner-default execution. */
export function agentAnsweringModel(
  agentId: string,
  overrides: Partial<SessionAgentModelDeps> = {},
): SessionAgentModel | null {
  const deps = { ...productionDeps, ...depsForTests, ...overrides };
  try {
    const agent = deps.agentModel(agentId);
    const pinned = agent?.model?.trim();
    if (!agent || !pinned) return null;
    const modelId = agentModelIsRole(pinned)
      ? deps.roleModel(pinned.toLowerCase() as ModelRole).modelId
      : pinned;
    if (!modelId || !deps.live(modelId)) return null;
    return { modelId, agentId, agentName: agent.name };
  } catch {
    return null;
  }
}

/** The agent's model for this conversation's next turn, or null. */
export function sessionAgentAnsweringModel(
  sessionId: string,
  overrides: Partial<SessionAgentModelDeps> = {},
): SessionAgentModel | null {
  const deps = { ...productionDeps, ...depsForTests, ...overrides };
  try {
    const metadata = deps.metadataOf(sessionId);
    const { agentId } = sessionAgentState(metadata);
    if (!agentId) return null;
    // The owner chose a model in this conversation after switching to the
    // agent: that choice answers.
    const chosenAt = time(metadata?.brainChosenAt);
    const switchedAt = time(metadata?.agentSetAt);
    if (chosenAt !== null && (switchedAt === null || chosenAt >= switchedAt)) return null;
    return agentAnsweringModel(agentId, overrides);
  } catch {
    return null;
  }
}

/** What the composer's model chip names as answering the next message. The
 *  agent chip's choice is applied when that message is sent, so a choice that
 *  differs from the conversation's agent (or opens a new conversation) reads
 *  as a fresh switch. `agentId` undefined = the conversation's own agent;
 *  null = Clem with no agent. */
export function nextAnsweringAgentModel(
  sessionId: string | null,
  agentId: string | null | undefined,
  overrides: Partial<SessionAgentModelDeps> = {},
): SessionAgentModel | null {
  const deps = { ...productionDeps, ...depsForTests, ...overrides };
  if (agentId === null) return null;
  try {
    const current = sessionId ? sessionAgentState(deps.metadataOf(sessionId)).agentId : null;
    if (sessionId && (agentId === undefined || agentId === current)) return sessionAgentAnsweringModel(sessionId, overrides);
    return agentId ? agentAnsweringModel(agentId, overrides) : null;
  } catch {
    return null;
  }
}

/** The owner picked a model for this conversation on the model chip: that
 *  choice answers from now on, over an agent's pinned model. */
export function recordBrainChosenForSession(sessionId: string, at: Date = new Date()): void {
  const clean = sessionId.trim();
  if (!clean) return;
  // Touch only this key, atomically: a running turn may be writing its own
  // bookkeeping into the same metadata column.
  openEventLog().prepare(
    `UPDATE sessions SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.brainChosenAt', ?) WHERE id = ?`,
  ).run(at.toISOString(), clean);
}
