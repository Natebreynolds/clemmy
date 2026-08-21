/**
 * Host-owned capability binder for admitted graph execution.
 *
 * Semantic role names never authorize dispatch. An admitted node must resolve
 * through a host catalog to an exact capability identity, schema/version,
 * canonical arguments, account, effect, and destination. Unresolved roles
 * block. There is no process-global adapter map.
 */
import { createHash } from 'node:crypto';
import type { TurnGraphCapabilityRequirement, TurnGraphEffect, TurnGraphIR, TurnGraphNode } from '../graph/turn-graph-ir.js';
import type { RuntimeToolEffect } from './tool-effect.js';
import type { GraphNodeInvocationEnvelopeV1 } from './graph-node-envelope.js';

export interface GraphNodeCapabilityInvoke {
  (input: {
    nodeId: string;
    role: string;
    payload: unknown;
    envelope?: GraphNodeInvocationEnvelopeV1;
    identity: { sessionId: string; sourceUserSeq: number; acceptedTaskId: string };
    binding: BoundNodeCapability;
    authority?: import('./resolved-call-authority.js').ResolvedCallAuthorityV1;
  }): Promise<unknown>;
}

export interface GraphNodeCapabilityReconcile {
  (input: {
    destination?: { family: string; posture: string };
    intendedDigest: string;
    artifactId?: string;
    authority?: import('./resolved-call-authority.js').ResolvedCallAuthorityV1;
    physicalDispatchId?: string;
    accountId?: string;
    operationId?: string;
    operationVersion?: string;
    schemaFingerprint?: string;
    reconcilePortId?: string;
  }): Promise<{
    exists: boolean;
    id?: string;
    handle?: string;
    receipt?: string;
    content?: unknown;
    /** Proof the remote artifact holds the intended bytes, without moving them. */
    contentDigest?: string;
  }>;
}

export interface BoundNodeCapability {
  capabilityId: string;
  toolName: string;
  schemaVersion: string;
  schemaDigest: string;
  args: Record<string, unknown>;
  account?: string;
  effect: RuntimeToolEffect | 'none' | 'compute' | 'host_only';
  destination?: { family: string; posture: string };
  /** Trusted-manifest digest. Absent means the binding cannot authorize a call. */
  manifestDigest?: string;
  providerKind?: 'local_registry' | 'composio' | 'native_mcp' | 'reviewed_cli';
  liveFingerprint?: string;
  delegatedFrom?: string;
  /** In-process copy of the trusted manifest. Digest is the durable identity. */
  manifest?: import('./capability-manifest.js').CapabilityManifestV1;
  /** Read-only recovery probe for a previously-started, outcome-unknown I/O.
   * It can recover authority for that exact crossing but never authorizes a
   * second invoke. */
  reconcile?: GraphNodeCapabilityReconcile;
  invoke: GraphNodeCapabilityInvoke;
}

export interface BindAdmittedNodeCapabilityInput {
  node: Pick<TurnGraphNode, 'id' | 'kind'> & {
    capabilityRole?: string;
    effect?: TurnGraphEffect;
    capabilities?: TurnGraphCapabilityRequirement[];
  };
  graph: TurnGraphIR;
  identity?: { sessionId: string; sourceUserSeq: number; acceptedTaskId: string };
  acceptedText: string;
  catalog?: HostCapabilityCatalog;
}

export interface HostCapabilityCatalog {
  bind(input: BindAdmittedNodeCapabilityInput): BoundNodeCapability | null;
}

export type BindAdmittedNodeResult =
  | { ok: true; binding: BoundNodeCapability }
  | { ok: false; reason: string };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const EFFECT_RANK: Record<string, number> = {
  none: 0,
  read: 1,
  compute: 1,
  host_only: 1,
  unknown: 2,
  local_write: 3,
  external_write: 4,
  admin: 5,
};

function effectFits(bindingEffect: string, nodeEffect: string, graphCeiling: string): boolean {
  const rank = (effect: string) => EFFECT_RANK[effect] ?? EFFECT_RANK.unknown;
  return bindingEffect === nodeEffect && rank(nodeEffect) <= rank(graphCeiling);
}

function bindingComplete(binding: BoundNodeCapability): boolean {
  return Boolean(
    binding.capabilityId.trim()
    && binding.toolName.trim()
    && binding.schemaVersion.trim()
    && binding.schemaDigest.trim()
    && binding.effect
    && binding.manifestDigest?.trim(),
  );
}

/**
 * Resolve one admitted node through the host catalog. A role string is never
 * enough: the binder must return a complete identity whose effect fits the
 * node and graph ceiling. Live search text cannot authorize invoke.
 */
export function bindAdmittedNodeCapability(
  input: BindAdmittedNodeCapabilityInput,
): BindAdmittedNodeResult {
  if (!input.catalog) {
    return { ok: false, reason: `no capability catalog for node ${input.node.id}` };
  }
  const bound = input.catalog.bind(input);
  if (!bound) {
    return { ok: false, reason: `capability catalog has no exact binding for node ${input.node.id}` };
  }
  if (!bindingComplete(bound)) {
    return { ok: false, reason: `catalog binding for node ${input.node.id} is missing exact capability identity` };
  }
  const nodeEffect = input.node.effect?.kind ?? 'unknown';
  const ceiling = input.graph.effectCeiling ?? 'unknown';
  if (!effectFits(bound.effect, nodeEffect, String(ceiling))) {
    return {
      ok: false,
      reason: `binding effect ${bound.effect} exceeds node ${nodeEffect} or graph ceiling ${ceiling}`,
    };
  }
  return { ok: true, binding: bound };
}

export function catalogDigestOf(catalog: HostCapabilityCatalog | undefined): string {
  if (!catalog) return sha256('no-catalog');
  return sha256('host-capability-catalog');
}
