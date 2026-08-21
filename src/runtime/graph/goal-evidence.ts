/**
 * Host judge: accepted goal → graph requirements → durable evidence.
 * Model prose never grants DONE.
 */
import { destinationsOf } from './accepted-goal.js';
import type { TurnGraphIR } from './turn-graph-ir.js';
import { verifyRequiredEvidence } from './evidence-verifiers.js';

export type GoalEvidenceRepair =
  | 'discover'
  | 'retry'
  | 'add-read-node'
  | 'rebind-schema'
  | 'ask-user';

export type GoalEvidenceVerdict =
  | { status: 'done' }
  | { status: 'incomplete'; reason: string; repair?: GoalEvidenceRepair }
  | { status: 'awaiting'; reason: string };

export interface GoalEvidenceObservation {
  /** Distinct collected members observed for the goal collection. */
  collectedCount?: number;
  /** Projection roles present on the collected set. */
  projectionPresent?: string[];
  /** Exact provider id of a newly created destination. */
  createdArtifactId?: string;
  /** Readback of that exact id succeeded. */
  readbackVerified?: boolean;
  /** Public handle (url/link) of the verified artifact. */
  artifactHandle?: string;
  /** Per-sink proofs. Canonical when more than one destination is admitted. */
  sinks?: ReadonlyArray<{
    family: string;
    createdArtifactId?: string;
    createReceiptId?: string;
    readbackVerified?: boolean;
    readbackContent?: unknown;
    artifactHandle?: string;
  }>;
  /** A source locator was observed without the collection. */
  sourceLocated?: boolean;
  /** Every collected member. Required-field checks apply to each record. */
  records?: ReadonlyArray<Record<string, unknown>>;
  /** Transform output is lineage-bound to the collected set. */
  lineagePresent?: boolean;
  /** Durable create receipt id, distinct from a tool_returned event. */
  createReceiptId?: string;
  /** Exact-id readback payload. Absence is not verification. */
  readbackContent?: unknown;
  /**
   * Transport-only. A tool_returned event is not physical success and must
   * never satisfy a construct goal.
   */
  toolReturned?: boolean;
}

export type QualitativeGoalJudge =
  | { status: 'satisfied' }
  | { status: 'repair'; unmetConstraintIds: string[]; patch?: unknown }
  | { status: 'needs_input'; slotId: string }
  | { status: 'blocked'; reason: string };

/**
 * Host hard-predicate gate. A qualitative judge may add repair / needs_input
 * / blocked. It cannot mark an action graph DONE when these predicates fail.
 * `toolReturned` is ignored.
 */
export function evaluateGoalEvidence(input: {
  graph: TurnGraphIR;
  observation: GoalEvidenceObservation;
  qualitative?: QualitativeGoalJudge;
}): GoalEvidenceVerdict {
  const constraints = input.graph.classification.goalConstraints;
  if (!constraints || constraints.construct === 'none') {
    return { status: 'done' };
  }
  const requiredKinds = [...(constraints.evidenceRequirements ?? [])];
  if (constraints.collection && constraints.collection.count >= 1 && !requiredKinds.includes('collection')) {
    requiredKinds.push('collection');
  }
  const sinks = destinationsOf(constraints);
  if (sinks.length > 0) {
    for (const kind of ['create_receipt', 'readback'] as const) {
      if (!requiredKinds.includes(kind) && !requiredKinds.includes(kind.replace('_', '-'))) {
        requiredKinds.push(kind);
      }
    }
    if (sinks.some((sink) => sink.handleRequired) && !requiredKinds.includes('artifact_handle')) {
      requiredKinds.push('artifact_handle');
    }
  }
  const verified = verifyRequiredEvidence({
    graph: input.graph,
    observation: input.observation,
    requiredKinds,
  });
  if (verified.status !== 'done') return verified;
  if (input.qualitative && input.qualitative.status !== 'satisfied') {
    if (input.qualitative.status === 'needs_input') {
      return { status: 'awaiting', reason: `needs_input:${input.qualitative.slotId}` };
    }
    return {
      status: 'incomplete',
      reason: input.qualitative.status === 'blocked'
        ? input.qualitative.reason
        : `unmet constraints: ${input.qualitative.unmetConstraintIds.join(', ')}`,
      repair: input.qualitative.status === 'blocked' ? 'ask-user' : 'retry',
    };
  }
  if (input.observation.toolReturned === true && !input.observation.createdArtifactId) {
    return {
      status: 'incomplete',
      reason: 'tool_returned is not physical success',
      repair: 'retry',
    };
  }
  return { status: 'done' };
}
