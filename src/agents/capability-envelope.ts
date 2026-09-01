/**
 * The agent's sealed capability envelope (Clem 4, Stage 4 activation, slice 1).
 *
 * `buildOrchestratorAgent` assembles a tool surface; until now that surface
 * existed only as the mutable array handed to the SDK. This module seals it
 * into the immutable, content-addressed `AdmissionEnvelope` the graph layer
 * defined — every tool named with the schema fingerprint it shipped with and
 * the widest effect class it may perform — and binds it to the agent the way
 * MCP scope is bound: a module-private WeakMap, unreachable from model
 * output.
 *
 * The envelope now has teeth at the built-in schema-on-demand dispatch
 * boundary: acquisition must append (or reuse) a binding revision before the
 * inner tool can run. A missing authority or a name outside the universe is a
 * typed `requires_readmission` refusal, never a warning followed by dispatch.
 *
 * Sealing failure is LOUD and non-fatal: an agent still builds (chat must
 * not die because instrumentation refused), but the warning names the exact
 * refusals, because a silent skip is how instrumentation rots.
 */
import { createHash } from 'node:crypto';

import {
  appendBindings,
  initialBindingRevision,
  sealAdmissionEnvelope,
  type AdmissionEnvelope,
  type AdmittedCapability,
  type CapabilityBindingRevision,
  type EnvelopeBudget,
} from '../runtime/graph/admission-envelope.js';
import { classifyRuntimeToolEffect } from '../runtime/harness/tool-effect.js';

export interface SealableToolLike {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  /**
   * Set by a builder whose description is re-rendered from per-turn host
   * state (a planning card that grows with same-source disclosures). Such
   * prose is turn STATE the model reads, not the callable contract, so it is
   * excluded from the shipped-schema fingerprint; name + parameters remain.
   * Plain own property on purpose: harness wrappers spread the tool object.
   */
  descriptionCarriesTurnState?: unknown;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/** The schema a tool SHIPPED with, fingerprinted. Description is part of the
 *  contract the model sees, so it is part of the fingerprint — unless the
 *  builder declared it turn state (see SealableToolLike). Live 2026-09-01: a
 *  crash-resume re-primed plan_task with the disclosures its card had gained,
 *  the description-bearing fingerprint changed, and the immutable host root
 *  read the same source as a changed surface (authority_conflict → poison). */
export function toolSchemaFingerprint(tool: SealableToolLike): string {
  const volatileDescription = tool.descriptionCarriesTurnState === true;
  return sha256(stableJson({
    name: typeof tool.name === 'string' ? tool.name : '',
    description: !volatileDescription && typeof tool.description === 'string' ? tool.description : '',
    parameters: tool.parameters ?? null,
  }));
}

/** Widest effect class a tool may perform, from the runtime classifier that
 *  already fails closed: unknown and admin flatten UP to 'send', never down. */
export function toolEffectClass(name: string): AdmittedCapability['effectClass'] {
  const effect = classifyRuntimeToolEffect(name, undefined).effect;
  if (effect === 'read' || effect === 'compute') return 'read';
  if (effect === 'local_write') return 'write';
  return 'send'; // external_write, admin, unknown — ceiling-safe
}

export function sealAgentCapabilityEnvelope(input: {
  sessionId: string;
  tools: readonly SealableToolLike[];
  policyHash: string;
  budget: EnvelopeBudget;
}): { ok: true; envelope: AdmissionEnvelope } | { ok: false; errors: string[] } {
  const capabilities: AdmittedCapability[] = [];
  for (const tool of input.tools) {
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name) return { ok: false, errors: ['a tool without a name cannot be admitted'] };
    capabilities.push({
      name,
      schemaFingerprint: toolSchemaFingerprint(tool),
      effectClass: toolEffectClass(name),
      accountIdentity: '', // accounts bind at dispatch through the broker
    });
  }
  const sealed = sealAdmissionEnvelope({
    attemptId: input.sessionId || 'unbound',
    tenant: 'local',
    workspace: '',
    policyHash: input.policyHash,
    // The chat surface's ceiling: tools that send exist on it by design.
    effectCeiling: 'send',
    capabilities,
    budget: input.budget,
  });
  return sealed.ok ? { ok: true, envelope: sealed.envelope } : sealed;
}

// ── binding (the bindAgentMcpToolScope pattern) ──────────────────────────────

const AGENT_ENVELOPES = new WeakMap<object, AdmissionEnvelope>();
const AGENT_REVISIONS = new WeakMap<object, CapabilityBindingRevision>();

export function bindAgentCapabilityEnvelope(agent: object, envelope: AdmissionEnvelope): void {
  AGENT_ENVELOPES.set(agent, envelope);
}

/** The sealed UNIVERSE this agent was built under, or null for agents that
 *  predate sealing (tests, custom builders). Callers must treat null as
 *  "unknown", never as "unlimited". */
export function boundAgentCapabilityEnvelope(agent: object): AdmissionEnvelope | null {
  return AGENT_ENVELOPES.get(agent) ?? null;
}

/**
 * Seal the ADMITTED CATALOG UNIVERSE and record the active surface as
 * binding revision 1 — the envelope/revision split the charter demands.
 * Deferred (schema-on-demand) tools live in the universe from birth, so a
 * later acquisition is a monotonic revision WITHIN it, never a widening;
 * MCP tools are governed by their own bound scope authority, and the two
 * compose at enforcement. Refuses if the active surface names anything the
 * universe does not contain — impossible by construction, load-bearing to
 * assert.
 */
export function sealAgentCapabilityUniverse(input: {
  sessionId: string;
  universeTools: readonly SealableToolLike[];
  activeToolNames: readonly string[];
  policyHash: string;
  budget: EnvelopeBudget;
}): { ok: true; envelope: AdmissionEnvelope; revision: CapabilityBindingRevision } | { ok: false; errors: string[] } {
  const sealed = sealAgentCapabilityEnvelope({
    sessionId: input.sessionId,
    tools: input.universeTools,
    policyHash: input.policyHash,
    budget: input.budget,
  });
  if (!sealed.ok) return sealed;
  const revision = initialBindingRevision(sealed.envelope, input.activeToolNames);
  if (!revision.ok) {
    return {
      ok: false,
      errors: revision.kind === 'requires_readmission'
        ? [`active surface names capabilities outside the sealed universe: ${revision.outside.join(', ')}`]
        : revision.errors,
    };
  }
  return { ok: true, envelope: sealed.envelope, revision: revision.revision };
}

export function bindAgentCapabilityRevision(agent: object, revision: CapabilityBindingRevision): void {
  AGENT_REVISIONS.set(agent, revision);
}

export type AgentCapabilityBindingResult =
  | { ok: true; revision: CapabilityBindingRevision; changed: boolean }
  | {
      ok: false;
      kind: 'requires_readmission';
      outside: string[];
      reason: string;
    };

/**
 * Admit a schema-on-demand acquisition as the next monotonic binding
 * revision. An already-bound name reuses the current revision without churn.
 * Missing envelope/revision authority and names outside the sealed universe
 * both fail closed as typed `requires_readmission` results; callers must not
 * dispatch after either refusal.
 */
export function appendAgentCapabilityBinding(
  agent: object,
  name: string,
): AgentCapabilityBindingResult {
  const envelope = AGENT_ENVELOPES.get(agent);
  const previous = AGENT_REVISIONS.get(agent);
  if (!envelope || !previous) {
    return {
      ok: false,
      kind: 'requires_readmission',
      outside: [name],
      reason: 'agent has no sealed capability envelope and active binding revision',
    };
  }
  if (previous.bound.includes(name)) return { ok: true, revision: previous, changed: false };
  const appended = appendBindings(envelope, previous, [name]);
  if (!appended.ok) {
    return {
      ok: false,
      kind: 'requires_readmission',
      outside: appended.kind === 'requires_readmission' ? appended.outside : [name],
      reason: appended.kind === 'requires_readmission'
        ? `"${appended.outside.join(', ')}" is outside the sealed capability universe`
        : appended.errors.join('; '),
    };
  }
  AGENT_REVISIONS.set(agent, appended.revision);
  return { ok: true, revision: appended.revision, changed: true };
}

/** The active binding revision, or null (unknown, never unlimited). */
export function boundAgentCapabilityRevision(agent: object): CapabilityBindingRevision | null {
  return AGENT_REVISIONS.get(agent) ?? null;
}
