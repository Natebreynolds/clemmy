/**
 * Host-owned minimum orchestration mode. The model may propose more topology;
 * it cannot downgrade durability, recovery, human boundaries, or verification.
 */
import { createHash } from 'node:crypto';
import { destinationsOf, type AcceptedGoalV1 } from '../graph/accepted-goal.js';

export const CONTROL_COMPLEXITY_VERSION = 1 as const;

export type OrchestrationMode = 'direct' | 'bounded_loop' | 'durable_pipeline' | 'durable_graph';

export type ControlComplexityReason =
  | 'single_bound_operation'
  | 'homogeneous_iteration'
  | 'ordered_checkpoints'
  | 'plural_sinks'
  | 'human_boundary'
  | 'async_wait'
  | 'uncertain_effect'
  | 'independent_recovery';

export interface ControlComplexityAssessmentV1 {
  version: typeof CONTROL_COMPLEXITY_VERSION;
  acceptedSourceDigest: string;
  mode: OrchestrationMode;
  reasons: ControlComplexityReason[];
  requiresDurability: boolean;
  requiresHumanBoundary: boolean;
  requiresReconciliation: boolean;
  allowsPartialCompletion: boolean;
  digest: string;
}

function digestOf(assessment: Omit<ControlComplexityAssessmentV1, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify(assessment)).digest('hex');
}

export function assessControlComplexity(input: {
  acceptedSourceDigest: string;
  goal: Pick<AcceptedGoalV1, 'construct' | 'route' | 'destinations' | 'destination' | 'collection'>;
  executableNodeCount: number;
  openHumanDependency?: boolean;
  asyncWait?: boolean;
  uncertainEffect?: boolean;
}): ControlComplexityAssessmentV1 {
  const sinks = destinationsOf(input.goal);
  const reasons: ControlComplexityReason[] = [];
  if (input.openHumanDependency) reasons.push('human_boundary');
  if (input.asyncWait) reasons.push('async_wait');
  if (input.uncertainEffect) reasons.push('uncertain_effect');
  if (sinks.length > 1) reasons.push('plural_sinks');
  if (input.goal.construct === 'fanout') reasons.push('homogeneous_iteration');
  if (input.goal.construct === 'collect_then_construct' && sinks.length <= 1) {
    reasons.push('ordered_checkpoints');
  }
  if (sinks.length > 1 || input.goal.construct === 'fanout') reasons.push('independent_recovery');

  let mode: OrchestrationMode = 'direct';
  if (sinks.length > 1 || input.asyncWait || input.uncertainEffect) {
    mode = 'durable_graph';
  } else if (input.goal.construct === 'collect_then_construct') {
    mode = 'durable_pipeline';
  } else if (input.goal.construct === 'fanout') {
    mode = 'bounded_loop';
  } else if (
    (input.goal.route === 'retrieve' || input.goal.construct === 'single_act' || input.goal.construct === 'none')
    && input.executableNodeCount <= 1
    && sinks.length <= 1
  ) {
    mode = 'direct';
    reasons.push('single_bound_operation');
  } else if (input.executableNodeCount > 1) {
    mode = 'durable_pipeline';
    reasons.push('ordered_checkpoints');
  } else {
    reasons.push('single_bound_operation');
  }

  const requiresHumanBoundary = Boolean(input.openHumanDependency);
  const requiresDurability = mode === 'durable_pipeline' || mode === 'durable_graph' || Boolean(input.asyncWait);
  const requiresReconciliation = Boolean(input.uncertainEffect) || sinks.length > 0;
  const allowsPartialCompletion = mode === 'durable_graph' || mode === 'durable_pipeline';
  const base = {
    version: CONTROL_COMPLEXITY_VERSION,
    acceptedSourceDigest: input.acceptedSourceDigest,
    mode,
    reasons: [...new Set(reasons)],
    requiresDurability,
    requiresHumanBoundary,
    requiresReconciliation,
    allowsPartialCompletion,
  };
  return { ...base, digest: digestOf(base) };
}

export function generalSchedulerForbidden(mode: OrchestrationMode): boolean {
  // Direct is the only mode that must not pay the general graph scheduler.
  // A typed bounded-loop runner is not in this slice; fanout still advances
  // through the durable scheduler rather than the one-node direct runner.
  return mode === 'direct';
}
