/**
 * One-way doors, made visible in the graph.
 *
 * Nodes already declare `sideEffect` and `requiresApproval`, but that
 * information only ever fired at dispatch time — the model discovered a wall by
 * hitting it. Expressing irreversibility as graph structure lets a planner see
 * the door before routing through it, which is the difference between a harness
 * that surprises and a harness that guides.
 *
 * It is also the safety property that makes model-owned reshaping shippable: a
 * patch must never be able to route around an approval-gated irreversible node,
 * and must never introduce an ungated send. Both checks are deterministic —
 * no judge decides whether a reshape is safe.
 */
import type { WorkflowGraphDefinition, WorkflowGraphNode } from './workflow-graph.js';

/** A node whose execution commits an effect that cannot be undone by the graph. */
export interface IrreversibleBoundary {
  nodeId: string;
  sideEffect: 'write' | 'send';
  /** A declarative approval gate stands in front of this effect. */
  gated: boolean;
}

function isIrreversible(node: WorkflowGraphNode): node is WorkflowGraphNode & { sideEffect: 'write' | 'send' } {
  return node.sideEffect === 'write' || node.sideEffect === 'send';
}

export function irreversibleBoundaries(graph: WorkflowGraphDefinition): IrreversibleBoundary[] {
  return (graph.nodes ?? [])
    .filter(isIrreversible)
    .map((node) => ({
      nodeId: node.id,
      sideEffect: node.sideEffect,
      gated: node.requiresApproval === true,
    }));
}

/**
 * Reasons this patch would weaken an irreversible boundary. Empty means safe.
 *
 * Readiness requires every ENABLED incoming edge to be complete, so adding an
 * edge only ever adds a constraint. The bypass vector is disabling an edge out
 * of a gated node while its target retains another enabled path: the target
 * then runs without ever waiting for the approval. The second vector is
 * introducing a fresh send-class node with no gate at all.
 */
export function irreversibleBoundaryViolations(
  before: WorkflowGraphDefinition,
  after: WorkflowGraphDefinition,
): string[] {
  const violations: string[] = [];
  const beforeNodeIds = new Set((before.nodes ?? []).map((node) => node.id));
  const gatedBefore = new Map(
    irreversibleBoundaries(before).filter((b) => b.gated).map((b) => [b.nodeId, b]),
  );

  // 1. A newly introduced send-class node must carry its own approval gate.
  for (const node of after.nodes ?? []) {
    if (beforeNodeIds.has(node.id)) continue;
    if (node.sideEffect === 'send' && node.requiresApproval !== true) {
      violations.push(`New send node "${node.id}" must declare requiresApproval before it can join a running graph.`);
    }
  }

  // 2. An existing gate may not be removed by replacing the node in place.
  const afterNodeById = new Map((after.nodes ?? []).map((node) => [node.id, node]));
  for (const [nodeId] of gatedBefore) {
    const next = afterNodeById.get(nodeId);
    if (!next) {
      violations.push(`Approval-gated node "${nodeId}" cannot be removed from a running graph.`);
      continue;
    }
    if (next.requiresApproval !== true) {
      violations.push(`Approval gate on "${nodeId}" cannot be removed.`);
    }
  }

  // 3. Disabling an edge out of a gated node bypasses it when the target keeps
  //    another enabled route. (Disabling its ONLY route stalls the target
  //    instead, which is withholding work, not bypassing a gate.)
  const enabledAfter = (after.edges ?? []).filter((edge) => !edge.disabled);
  for (const edge of before.edges ?? []) {
    if (edge.disabled) continue;
    if (!gatedBefore.has(edge.source)) continue;
    const stillEnabled = enabledAfter.some((candidate) => candidate.id === edge.id);
    if (stillEnabled) continue;
    const targetKeepsAnotherRoute = enabledAfter.some((candidate) => candidate.target === edge.target);
    if (targetKeepsAnotherRoute) {
      violations.push(
        `Disabling "${edge.id}" would let "${edge.target}" run without waiting for approval-gated "${edge.source}".`,
      );
    }
  }

  return violations;
}
