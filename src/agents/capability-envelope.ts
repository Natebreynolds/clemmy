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
 * This slice is INSTRUMENTATION WITH TEETH DEFERRED: the envelope travels
 * with the agent and is queryable at the dispatch boundary, but nothing
 * refuses on it yet. The enforcement slice — the boundary refusing a tool
 * absent from the envelope, and binding revisions for schema-on-demand
 * growth — lands against this exact artifact, which is why it must exist
 * first and why its digest must be honest now.
 *
 * Sealing failure is LOUD and non-fatal: an agent still builds (chat must
 * not die because instrumentation refused), but the warning names the exact
 * refusals, because a silent skip is how instrumentation rots.
 */
import { createHash } from 'node:crypto';

import {
  sealAdmissionEnvelope,
  type AdmissionEnvelope,
  type AdmittedCapability,
  type EnvelopeBudget,
} from '../runtime/graph/admission-envelope.js';
import { classifyRuntimeToolEffect } from '../runtime/harness/tool-effect.js';

export interface SealableToolLike {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
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
 *  contract the model sees, so it is part of the fingerprint. */
export function toolSchemaFingerprint(tool: SealableToolLike): string {
  return sha256(stableJson({
    name: typeof tool.name === 'string' ? tool.name : '',
    description: typeof tool.description === 'string' ? tool.description : '',
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

export function bindAgentCapabilityEnvelope(agent: object, envelope: AdmissionEnvelope): void {
  AGENT_ENVELOPES.set(agent, envelope);
}

/** The sealed surface this agent was built with, or null for agents that
 *  predate sealing (tests, custom builders). Callers must treat null as
 *  "unknown", never as "unlimited". */
export function boundAgentCapabilityEnvelope(agent: object): AdmissionEnvelope | null {
  return AGENT_ENVELOPES.get(agent) ?? null;
}
