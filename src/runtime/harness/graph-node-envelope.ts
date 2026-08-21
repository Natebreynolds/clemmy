/**
 * Host-built immutable invocation envelope for one admitted graph node.
 * Adapters translate this into provider arguments. Model-authored args
 * never cross this boundary.
 */
import type { TurnGraphIR, TurnGraphNode } from '../graph/turn-graph-ir.js';
import type { BoundNodeCapability } from './graph-node-capability.js';

export const GRAPH_NODE_INVOCATION_ENVELOPE_VERSION = 1 as const;

export interface GraphNodePredecessorRefV1 {
  nodeId: string;
  role: string;
  artifactRef?: string;
  contentDigest?: string;
  value?: unknown;
}

export interface GraphNodeInvocationEnvelopeV1 {
  readonly version: typeof GRAPH_NODE_INVOCATION_ENVELOPE_VERSION;
  readonly identity: {
    sessionId: string;
    sourceUserSeq: number;
    acceptedTaskId: string;
  };
  readonly goal: {
    objective: string;
    revision: number;
    criteria: ReadonlyArray<{ id: string; statement: string }>;
  };
  readonly node: { id: string; role: string };
  readonly cardinality: { count: number; fields: readonly string[] } | null;
  readonly predecessors: readonly GraphNodePredecessorRefV1[];
  readonly expectedOutput: { kind: string };
  readonly binding: {
    capabilityId: string;
    manifestDigest: string;
    schemaDigest: string;
    account?: string;
    effect: string;
    destination?: { family: string; posture: string };
  };
}

function deepCloneFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const cloned = structuredClone(value);
  const freezeDeep = (next: unknown): unknown => {
    if (!next || typeof next !== 'object') return next;
    if (Array.isArray(next)) {
      for (const child of next) freezeDeep(child);
      return Object.freeze(next);
    }
    for (const child of Object.values(next as Record<string, unknown>)) freezeDeep(child);
    return Object.freeze(next);
  };
  return freezeDeep(cloned) as T;
}

export function sealGraphNodeInvocationEnvelope(
  envelope: GraphNodeInvocationEnvelopeV1,
): GraphNodeInvocationEnvelopeV1 {
  return Object.freeze({
    version: GRAPH_NODE_INVOCATION_ENVELOPE_VERSION,
    identity: Object.freeze({ ...envelope.identity }),
    goal: Object.freeze({
      objective: envelope.goal.objective,
      revision: envelope.goal.revision,
      criteria: Object.freeze(envelope.goal.criteria.map((criterion) => Object.freeze({ ...criterion }))),
    }),
    node: Object.freeze({ ...envelope.node }),
    cardinality: envelope.cardinality
      ? Object.freeze({
          count: envelope.cardinality.count,
          fields: Object.freeze([...envelope.cardinality.fields]),
        })
      : null,
    predecessors: Object.freeze(envelope.predecessors.map((prior) => Object.freeze({
      nodeId: prior.nodeId,
      role: prior.role,
      ...(prior.artifactRef ? { artifactRef: prior.artifactRef } : {}),
      ...(prior.contentDigest ? { contentDigest: prior.contentDigest } : {}),
      ...(prior.value !== undefined && !prior.artifactRef
        ? { value: deepCloneFreeze(prior.value) }
        : {}),
    }))),
    expectedOutput: Object.freeze({ ...envelope.expectedOutput }),
    binding: Object.freeze({
      ...envelope.binding,
      ...(envelope.binding.destination
        ? { destination: Object.freeze({ ...envelope.binding.destination }) }
        : {}),
    }),
  });
}

export function buildGraphNodeInvocationEnvelope(input: {
  graph: TurnGraphIR;
  node: Pick<TurnGraphNode, 'id'> & { capabilityRole?: string };
  binding: BoundNodeCapability;
  identity: { sessionId: string; sourceUserSeq: number; acceptedTaskId: string };
  goal: {
    objective: string;
    revision: number;
    criteria: ReadonlyArray<{ id: string; statement: string }>;
  };
  predecessors: readonly GraphNodePredecessorRefV1[];
}): GraphNodeInvocationEnvelopeV1 {
  const collection = input.graph.classification.goalConstraints?.collection;
  const outputKind = input.binding.manifest?.producedOutputKinds?.[0]
    ?? input.binding.manifest?.outputContract.kind
    ?? input.binding.destination?.family
    ?? 'records';
  return sealGraphNodeInvocationEnvelope({
    version: GRAPH_NODE_INVOCATION_ENVELOPE_VERSION,
    identity: input.identity,
    goal: {
      objective: input.goal.objective,
      revision: input.goal.revision,
      criteria: input.goal.criteria,
    },
    node: { id: input.node.id, role: input.node.capabilityRole ?? '' },
    cardinality: collection
      ? { count: collection.count, fields: collection.projection }
      : null,
    predecessors: input.predecessors,
    expectedOutput: { kind: outputKind },
    binding: {
      capabilityId: input.binding.capabilityId,
      manifestDigest: input.binding.manifestDigest ?? '',
      schemaDigest: input.binding.schemaDigest,
      account: input.binding.account,
      effect: String(input.binding.effect),
      destination: input.binding.destination,
    },
  });
}
