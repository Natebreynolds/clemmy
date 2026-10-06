/**
 * Binding an agent into work.
 *
 * One rendering, used wherever an agent's context enters a model call: a chat
 * turn inside the agent, a fan-out worker running as it, later a scheduled
 * run. The context is standing instructions plus what the agent reaches for
 * first; the pinned skills travel as their SKILL.md bodies so the model starts
 * knowing the craft instead of finding it. It narrows and orders; it never
 * widens what a turn may do — every gate downstream runs as it would for an
 * unbound turn.
 */
import { loadSkill } from '../memory/skill-store.js';
import { resolveRoleModel, type ModelRole } from '../runtime/harness/model-roles.js';
import { findAgentRecord, getAgentRecord, listAgentRecords, type AgentRecord } from './agent-record.js';

/** Bytes of skill text an agent may pin into a prompt in total. */
export const AGENT_SKILL_CONTEXT_MAX_CHARS = 24_000;

export interface AgentBinding {
  agent: AgentRecord;
  /** Standing context text for the system prefix. Stable across turns of one session. */
  context: string;
  /** Model role or named model the agent asks for; null = whatever the turn would use. */
  model: string | null;
  /** Tool families the surface is narrowed to; empty = the turn's usual surface. */
  tools: string[];
  /** Skills whose bodies were pinned in, in order. */
  pinnedSkills: string[];
  /** Skills the record names that are not installed; said, not hidden. */
  missingSkills: string[];
}

/** Resolve a binding by id or by the name a person typed. Null when unknown. */
export function resolveAgentBinding(idOrName: string | null | undefined): AgentBinding | null {
  const wanted = String(idOrName ?? '').trim();
  if (!wanted) return null;
  const agent = getAgentRecord(wanted) ?? findAgentRecord(wanted);
  return agent ? bindAgent(agent) : null;
}

export function bindAgent(agent: AgentRecord): AgentBinding {
  const pinnedSkills: string[] = [];
  const missingSkills: string[] = [];
  const skillBlocks: string[] = [];
  let budget = AGENT_SKILL_CONTEXT_MAX_CHARS;
  for (const name of agent.skills) {
    const skill = loadSkill(name);
    if (!skill) { missingSkills.push(name); continue; }
    const body = skill.body.trim();
    if (!body) { pinnedSkills.push(name); continue; }
    const slice = body.length > budget ? `${body.slice(0, Math.max(0, budget))}\n[skill text cut here; read the rest with skill_read]` : body;
    budget -= slice.length;
    pinnedSkills.push(name);
    skillBlocks.push(`### Skill: ${name}\n${slice}`);
    if (budget <= 0) break;
  }

  const lines: string[] = [
    `## Working as ${agent.name}`,
    agent.handles ? `Handles: ${agent.handles}` : '',
    agent.instructions ? `\n${agent.instructions}` : '',
  ];
  if (agent.workflows.length > 0) {
    lines.push(`\nWorkflows to reach for first (run by name before redoing the work by hand): ${agent.workflows.join(', ')}.`);
  }
  if (missingSkills.length > 0) {
    lines.push(`\nSkills this agent names that are not installed: ${missingSkills.join(', ')}. Say so if they were needed.`);
  }
  if (skillBlocks.length > 0) {
    lines.push('\n## Pinned skills', ...skillBlocks);
  }
  lines.push('\nThese are starting points, not limits: use anything else the request actually needs, and never claim work you did not do.');

  return {
    agent,
    context: lines.filter((line) => line !== '').join('\n').trim(),
    model: agent.model,
    tools: agent.tools,
    pinnedSkills,
    missingSkills,
  };
}

/** The line a worker or receipt uses to say who the work ran as. */
export function describeAgentBinding(binding: Pick<AgentBinding, 'agent'>): string {
  return binding.agent.name;
}

/** The saved agents a caller may name, for a refusal that lists the choices. */
export function listAgentChoicesForRefusal(limit = 12): string {
  const names = listAgentRecords().slice(0, limit).map((agent) => agent.name);
  return names.length > 0 ? names.join(', ') : 'none saved yet';
}

const MODEL_ROLES = new Set(['brain', 'worker', 'judge', 'writer']);

/** An agent's model field is a role name or a model the owner named. */
export function agentModelIsRole(model: string | null | undefined): model is ModelRole {
  return typeof model === 'string' && MODEL_ROLES.has(model.trim().toLowerCase());
}

export type WorkerAgentRequest =
  | { kind: 'none' }
  | { kind: 'refuse'; reason: string; shapes: string[] }
  | {
    kind: 'bound';
    binding: AgentBinding;
    model: string | null | undefined;
    /** The model the owner pinned on this saved agent, resolved; an owner
     *  choice the helper router honours like a saved rule. */
    pinnedModel?: string;
  };

/**
 * One decision per run_worker call: which saved agent the workers run as, and
 * which model the packet proposes. A different packet model is not an owner
 * override: routeWorkerModel must check it against the exact accepted source
 * before replacing pinnedModel. An unknown agent is
 * refused before any worker starts, with the saved names listed, the same way
 * an unknown model is.
 */
export function resolveWorkerAgentRequest(call: { agent?: string | null; model?: string | null }): WorkerAgentRequest {
  const requested = String(call.agent ?? '').trim();
  if (!requested) return { kind: 'none' };
  const binding = resolveAgentBinding(requested);
  if (!binding) {
    return {
      kind: 'refuse',
      reason: `"${requested.slice(0, 80)}" is not one of the owner's saved agents, so no worker started. Saved agents: ${listAgentChoicesForRefusal()}. Call run_worker again with one of these names, or with agent: null.`,
      shapes: ['agent:not_saved'],
    };
  }
  let pinnedModel = binding.model || undefined;
  if (agentModelIsRole(binding.model)) {
    const role = binding.model.trim().toLowerCase() as ModelRole;
    const resolved = resolveRoleModel(role);
    // Role readers may return a healthy default alongside the failed saved
    // binding. A specialist's owner pin cannot turn that default into the
    // saved choice. Packet model text carries no accepted owner authority at
    // this seam; the ordinary route gate handles verified overrides of live
    // pins after this binding has preserved their original constraint.
    if (resolved.inactiveBinding) {
      return {
        kind: 'refuse',
        reason: `The saved agent "${binding.agent.name}" requires the ${role} model "${resolved.inactiveBinding.modelId}", but that saved model is unavailable. No substitute was started. Reconnect its model or change the saved role choice before retrying.`,
        shapes: ['model:pinned_unavailable'],
      };
    }
    pinnedModel = resolved.modelId;
  }
  const model = call.model || pinnedModel;
  return { kind: 'bound', binding, model, ...(pinnedModel ? { pinnedModel } : {}) };
}
