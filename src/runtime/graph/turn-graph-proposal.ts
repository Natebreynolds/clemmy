/**
 * Host validation for a planner-proposed turn graph.
 * Production fallback compiles from AcceptedGoal — never from a vendor sentence.
 */
import {
  destinationsOf,
  type AcceptedGoalDestinationPosture,
  type AcceptedGoalV1,
} from './accepted-goal.js';
import type { TurnGraphNodeKind } from './turn-graph-ir.js';

const WRITE_EFFECTS = new Set(['external_write', 'local_write', 'admin']);
const EFFECT_RANK: Record<string, number> = {
  none: 0,
  read: 1,
  unknown: 2,
  local_write: 3,
  external_write: 4,
  admin: 5,
};

export interface ProposedTurnGraphNodeV1 {
  id?: string;
  kind: TurnGraphNodeKind;
  /** Requested effect. Host clamps to the accepted ceiling. */
  effect?: string;
  capabilityRole?: string;
  constraintIds?: string[];
  cardinality?: number;
  requiredFields?: string[];
  dependsOn?: string[];
  dataFrom?: string[];
  evidence?: string[];
}

export interface ProposedTurnGraphV1 {
  nodes: ProposedTurnGraphNodeV1[];
  edges?: Array<{ source: string; target: string }>;
  deliverables?: string[];
  unresolvedSlots?: string[];
  requestedEffect?: string;
  destinationFamily?: string;
  destinationPosture?: AcceptedGoalDestinationPosture;
  destinationFamilies?: string[];
  budget?: { maxNodes?: number; maxExpansions?: number };
}

export type ProposedGraphValidation =
  | { ok: true }
  | { ok: false; reason: string };

export interface ProposedGraphCeiling {
  effect?: AcceptedGoalV1['effectCeiling'];
  destinationFamily?: string;
  destinationPosture?: NonNullable<AcceptedGoalV1['destination']>['posture'];
  destinationFamilies?: readonly string[];
  cardinality?: number;
  capabilityRoles?: ReadonlySet<string>;
  maxNodes?: number;
  maxExpansions?: number;
  settledWriteNodeIds?: ReadonlySet<string>;
}

function effectRank(effect: string | undefined): number {
  if (!effect) return EFFECT_RANK.unknown;
  return EFFECT_RANK[effect] ?? EFFECT_RANK.unknown;
}

function ceilingRank(ceiling: AcceptedGoalV1['effectCeiling'] | undefined): number {
  if (!ceiling || ceiling === 'none') return EFFECT_RANK.none;
  return EFFECT_RANK[ceiling] ?? EFFECT_RANK.unknown;
}

/**
 * Validate a model-proposed graph against the accepted goal and optional
 * host ceiling. Unknown requested effects never become reads by omission.
 */
export function validateProposedGraph(
  goal: AcceptedGoalV1,
  proposed: ProposedTurnGraphV1,
  ceiling?: ProposedGraphCeiling,
): ProposedGraphValidation {
  const kinds = proposed.nodes.map((node) => node.kind);
  if (goal.construct === 'collect_then_construct' || goal.construct === 'single_act') {
    if (!kinds.includes('retrieve')) {
      return { ok: false, reason: 'construct goal requires a retrieve node' };
    }
    if (!kinds.includes('execute')) {
      return { ok: false, reason: 'construct goal requires an execute node' };
    }
    if (!kinds.includes('verify')) {
      return { ok: false, reason: 'construct goal requires a verify node' };
    }
    const write = proposed.nodes.find((node) => node.kind === 'execute');
    if (goal.effectCeiling === 'external_write' && write?.effect !== 'external_write') {
      return { ok: false, reason: 'execute node must carry the external-write ceiling' };
    }
  }
  if ((goal.collection?.count ?? 0) >= 3) {
    const reads = proposed.nodes.filter((node) => (
      node.kind === 'retrieve'
      && node.capabilityRole !== 'readback'
    ));
    if (goal.construct === 'collect_then_construct') {
      if (reads.length !== 1) {
        return { ok: false, reason: 'an aggregate collect-then-construct goal requires exactly one source/collection read' };
      }
    } else if (reads.length < 2) {
      return { ok: false, reason: 'a counted fanout collection requires a source read and a collection read' };
    }
  }

  const hostEffect = ceiling?.effect ?? goal.effectCeiling;
  const requested = proposed.requestedEffect
    ?? proposed.nodes.find((node) => node.kind === 'execute')?.effect;
  if (requested && effectRank(requested) > ceilingRank(hostEffect)) {
    return { ok: false, reason: 'proposed graph widens the accepted effect ceiling' };
  }
  if (requested === 'read' && (hostEffect === 'unknown' || hostEffect === undefined)) {
    return { ok: false, reason: 'unknown effect cannot become a read by omission' };
  }
  for (const node of proposed.nodes) {
    if (node.effect === 'read' && hostEffect === 'unknown') {
      return { ok: false, reason: 'unknown effect cannot become a read by omission' };
    }
    if (node.effect && effectRank(node.effect) > ceilingRank(hostEffect)) {
      return { ok: false, reason: `node ${node.kind} widens the accepted effect ceiling` };
    }
  }

  const acceptedSinks = destinationsOf(goal);
  const destFamily = ceiling?.destinationFamily ?? acceptedSinks[0]?.family;
  if (
    proposed.destinationFamily
    && destFamily
    && proposed.destinationFamily !== destFamily
  ) {
    return { ok: false, reason: 'proposed graph changes the accepted destination family' };
  }
  const destPosture = ceiling?.destinationPosture ?? acceptedSinks[0]?.posture;
  if (
    proposed.destinationPosture
    && destPosture
    && proposed.destinationPosture !== destPosture
  ) {
    return { ok: false, reason: 'proposed graph changes the accepted destination posture' };
  }
  const acceptedFamilies = [
    ...new Set((ceiling?.destinationFamilies ?? acceptedSinks.map((sink) => sink.family)).filter(Boolean)),
  ].sort();
  if ((proposed.destinationFamilies?.length ?? 0) > 0 && acceptedFamilies.length > 0) {
    const proposedFamilies = [...new Set(proposed.destinationFamilies)].sort();
    if (proposedFamilies.join('\0') !== acceptedFamilies.join('\0')) {
      return { ok: false, reason: 'proposed graph changes the accepted destination set' };
    }
  }
  if (acceptedSinks.length > 1) {
    const writes = proposed.nodes.filter((node) => node.kind === 'execute' && (
      node.capabilityRole === 'destination' || node.capabilityRole === 'create'
    ));
    if (writes.length < acceptedSinks.length) {
      return { ok: false, reason: 'proposed graph omits an accepted destination sink' };
    }
    if (!proposed.nodes.some((node) => node.capabilityRole === 'transform' || node.kind === 'reduce')) {
      return { ok: false, reason: 'a multi-destination goal requires an evidence-bearing transform' };
    }
  }

  const acceptedCount = ceiling?.cardinality ?? goal.collection?.count;
  if (
    acceptedCount !== undefined
    && proposed.nodes.some((node) => (node.cardinality ?? 0) > acceptedCount)
  ) {
    return { ok: false, reason: 'proposed graph widens accepted cardinality' };
  }

  if (ceiling?.capabilityRoles) {
    for (const node of proposed.nodes) {
      if (node.capabilityRole && !ceiling.capabilityRoles.has(node.capabilityRole)) {
        return { ok: false, reason: `unknown capability role: ${node.capabilityRole}` };
      }
    }
  }

  if (ceiling?.maxNodes !== undefined && proposed.nodes.length > ceiling.maxNodes) {
    return { ok: false, reason: 'proposed graph exceeds the node budget' };
  }
  if (
    ceiling?.maxExpansions !== undefined
    && (proposed.budget?.maxExpansions ?? 0) > ceiling.maxExpansions
  ) {
    return { ok: false, reason: 'proposed graph expands the expansion budget' };
  }
  if (ceiling?.settledWriteNodeIds) {
    for (const node of proposed.nodes) {
      if (node.id && WRITE_EFFECTS.has(node.effect ?? '') && ceiling.settledWriteNodeIds.has(node.id)) {
        return { ok: false, reason: `cannot replay settled write ${node.id}` };
      }
    }
  }

  const nodeIds = proposed.nodes.map((node, index) => node.id ?? `n${index}`);
  if (new Set(nodeIds).size !== nodeIds.length) {
    return { ok: false, reason: 'proposed graph has duplicate node ids' };
  }
  const known = new Set(nodeIds);
  for (const edge of proposed.edges ?? []) {
    if (!known.has(edge.source) || !known.has(edge.target)) {
      return { ok: false, reason: 'proposed edge references an unknown node' };
    }
    if (edge.source === edge.target) {
      return { ok: false, reason: 'proposed graph contains a self-edge' };
    }
  }
  if ((proposed.edges ?? []).length > 0) {
    const indegree = new Map(nodeIds.map((id) => [id, 0]));
    const outgoing = new Map(nodeIds.map((id) => [id, [] as string[]]));
    for (const edge of proposed.edges ?? []) {
      outgoing.get(edge.source)?.push(edge.target);
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    }
    const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
    let visited = 0;
    while (ready.length > 0) {
      const id = ready.shift() as string;
      visited += 1;
      for (const target of outgoing.get(id) ?? []) {
        const next = (indegree.get(target) ?? 0) - 1;
        indegree.set(target, next);
        if (next === 0) ready.push(target);
      }
    }
    if (visited !== nodeIds.length) {
      return { ok: false, reason: 'proposed graph must be acyclic' };
    }
  }

  return { ok: true };
}

/** Deterministic fallback topology from the accepted goal shape.
 *  Test helper / last-resort sketch — not compile authority when typed
 *  semantics supplied a work proposal. */
export function fallbackProposedGraph(goal: AcceptedGoalV1): ProposedTurnGraphV1 {
  if (goal.construct === 'none') {
    return { nodes: [{ kind: 'compose_reply' }] };
  }
  const aggregateCollection = goal.construct === 'collect_then_construct'
    && (goal.collection?.count ?? 0) >= 3;
  const nodes: ProposedTurnGraphV1['nodes'] = [{
    kind: 'retrieve',
    effect: 'read',
    capabilityRole: aggregateCollection ? 'collection' : 'source',
    constraintIds: goal.collection ? ['collection'] : [],
    ...(aggregateCollection ? {
      cardinality: goal.collection?.count,
      requiredFields: goal.collection?.projection,
    } : {}),
  }];
  if ((goal.collection?.count ?? 0) >= 3 && !aggregateCollection) {
    nodes.push({
      kind: 'retrieve',
      effect: 'read',
      capabilityRole: 'collection',
      constraintIds: ['collection'],
      cardinality: goal.collection?.count,
      requiredFields: goal.collection?.projection,
    });
  }
  const sinks = destinationsOf(goal);
  if (sinks.length > 1) {
    nodes.push({
      kind: 'execute',
      effect: 'host_only',
      capabilityRole: 'transform',
      evidence: ['lineage'],
    });
    for (const [index, sink] of sinks.entries()) {
      nodes.push({
        id: index === 0 ? 'op-write' : `op-write-${index}`,
        kind: 'execute',
        effect: goal.effectCeiling === 'none' ? 'unknown' : goal.effectCeiling,
        capabilityRole: 'destination',
        constraintIds: [`destination:${sink.family}`],
      });
      nodes.push({
        id: index === 0 ? 'op-readback' : `op-readback-${index}`,
        kind: 'retrieve',
        effect: 'read',
        capabilityRole: 'readback',
      });
    }
  } else {
    nodes.push({
      kind: 'execute',
      effect: goal.effectCeiling === 'none' ? 'unknown' : goal.effectCeiling,
      capabilityRole: 'destination',
      constraintIds: sinks[0] ? ['destination'] : [],
    });
  }
  nodes.push({ kind: 'verify', constraintIds: [
    ...(goal.collection ? ['collection'] : []),
    ...sinks.map((sink) => `destination:${sink.family}`),
  ] });
  nodes.push({ kind: 'compose_reply' });
  return {
    nodes,
    requestedEffect: goal.effectCeiling === 'none' ? undefined : goal.effectCeiling,
    destinationFamily: sinks[0]?.family,
    destinationPosture: sinks[0]?.posture,
    destinationFamilies: sinks.map((sink) => sink.family),
  };
}

export function proposeTurnGraphFromGoal(goal: AcceptedGoalV1): {
  proposed: ProposedTurnGraphV1;
  plannerSource: 'deterministic_fallback';
} {
  const proposed = fallbackProposedGraph(goal);
  const validated = validateProposedGraph(goal, proposed);
  if (!validated.ok) {
    throw new Error(`goal fallback topology is illegal: ${validated.reason}`);
  }
  return { proposed, plannerSource: 'deterministic_fallback' };
}
