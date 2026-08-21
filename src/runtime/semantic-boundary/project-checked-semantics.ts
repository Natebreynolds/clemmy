/**
 * One-way projection from a process-local checked semantic proposal into
 * existing durable shapes. This module writes no database and stores no
 * checked envelope. Callers apply the returned mutations to the canonical
 * chain (goal revision → graph → contract → continuity).
 *
 * Criterion IDs are opaque. All proposed work meaning comes from the
 * hash-bound `work` object on the proposal — never from a sideband argument
 * or from parsing criterion names.
 */
import { destinationsOf, type AcceptedGoalConstruct, type AcceptedGoalV1 } from '../graph/accepted-goal.js';
import type { ProposedTurnGraphV1 } from '../graph/turn-graph-proposal.js';
import type { RuntimeToolEffect } from '../harness/tool-effect.js';
import type {
  ContextCheckedTurnSemanticProposalV1,
  GoalRefV1,
  ProposedSemanticWorkV1,
  SlotAnswerV1,
  TurnRelationV1,
} from './turn-semantic-proposal.js';
import {
  isContextCheckedTurnSemanticProposalV1,
  workDestinationsOf,
} from './turn-semantic-proposal.js';

function workIsUnderspecifiedWrite(work: ProposedSemanticWorkV1 | null): boolean {
  if (!work) return false;
  if (work.operations.length > 0) {
    return work.operations.every((operation) => (
      !operation.capabilityRef
      || operation.capabilityRef === 'unknown'
    ));
  }
  if (work.requestedEffect === 'unknown' || work.requestedEffect === 'none') {
    return work.construct !== 'none';
  }
  if (work.requestedEffect !== 'external_write' && work.requestedEffect !== 'local_write') {
    return false;
  }
  const sinks = workDestinationsOf(work);
  if (sinks.length === 0) return true;
  return sinks.some((sink) => sink.posture === 'named_existing' && sink.handleRequired);
}

export type SemanticProjectionKind =
  | 'conversation'
  | 'mint_goal'
  | 'continue_same_root'
  | 'settle_slot'
  | 'amend_revision'
  | 'abandon_root'
  | 'keep_slot_open';

export interface SemanticProjectionV1 {
  kind: SemanticProjectionKind;
  source: ContextCheckedTurnSemanticProposalV1['source'];
  relation: TurnRelationV1;
  targetGoal: GoalRefV1 | null;
  /** Typed goal/work copied from the hash-bound proposal. Effects are requests. */
  goal?: {
    construct: AcceptedGoalConstruct;
    collection?: { count: number; projection: string[] };
    destinations?: AcceptedGoalV1['destinations'];
    destination?: AcceptedGoalV1['destination'];
    requestedEffect: RuntimeToolEffect | 'none';
    constraintIds: string[];
    openSlotKeys: string[];
    candidateRefs: Array<{ kind: 'capability' | 'workflow'; id: string }>;
    operations: ProposedSemanticWorkV1['operations'];
    deliverables: ProposedSemanticWorkV1['deliverables'];
    evidenceRequirements: string[];
  };
  slotAnswer?: SlotAnswerV1;
  parkPriorGoal: boolean;
}

export type SemanticProjectionResult =
  | { ok: true; projection: SemanticProjectionV1 }
  | { ok: false; reason: string };

function goalFromWork(
  proposal: ContextCheckedTurnSemanticProposalV1['proposal'],
): SemanticProjectionV1['goal'] | undefined {
  const work = proposal.work;
  const draft = proposal.goal;
  if (!work || !draft) return undefined;
  return {
    construct: work.construct,
    ...(work.cardinality
      ? { collection: { count: work.cardinality.count, projection: [...work.cardinality.fields] } }
      : {}),
    ...(() => {
      const destinations = workDestinationsOf(work);
      if (destinations.length === 0) return {};
      return {
        destinations: destinations.map((entry) => ({ ...entry })),
        destination: { ...destinations[0]! },
      };
    })(),
    requestedEffect: work.requestedEffect,
    constraintIds: draft.criteria.map((criterion) => criterion.id),
    openSlotKeys: draft.openSlots.map((slot) => slot.slotKey),
    candidateRefs: [...draft.candidates],
    operations: work.operations.map((operation) => ({ ...operation, dependsOn: [...operation.dependsOn], evidence: [...operation.evidence] })),
    deliverables: work.deliverables.map((deliverable) => ({ ...deliverable })),
    evidenceRequirements: [...work.evidenceRequirements],
  };
}

/**
 * Project a checked proposal. All goal/work meaning is already inside the
 * hash-bound proposal. This function does not accept a sideband work object.
 */
export function projectCheckedSemantics(
  checked: ContextCheckedTurnSemanticProposalV1,
): SemanticProjectionResult {
  if (!isContextCheckedTurnSemanticProposalV1(checked)) {
    return { ok: false, reason: 'semantics are not a host-checked in-process envelope' };
  }
  const { proposal, source } = checked;
  const goal = goalFromWork(proposal);

  switch (proposal.relation) {
    case 'conversation':
      return {
        ok: true,
        projection: {
          kind: 'conversation',
          source,
          relation: proposal.relation,
          targetGoal: null,
          parkPriorGoal: false,
        },
      };
    case 'new_goal': {
      const clarifyingOpenSlots = proposal.goal !== null
        && proposal.goal.openSlots.length > 0
        && !proposal.work;
      return {
        ok: true,
        projection: clarifyingOpenSlots
          ? {
              kind: 'conversation',
              source,
              relation: proposal.relation,
              targetGoal: null,
              parkPriorGoal: false,
            }
          : {
              kind: 'mint_goal',
              source,
              relation: proposal.relation,
              targetGoal: null,
              goal,
              parkPriorGoal: true,
            },
      };
    }
    case 'continue_goal':
      return {
        ok: true,
        projection: {
          kind: 'continue_same_root',
          source,
          relation: proposal.relation,
          targetGoal: proposal.targetGoal,
          parkPriorGoal: false,
        },
      };
    case 'answer_open_slot':
      return {
        ok: true,
        projection: {
          kind: 'settle_slot',
          source,
          relation: proposal.relation,
          targetGoal: proposal.targetGoal,
          slotAnswer: proposal.slotAnswers[0],
          parkPriorGoal: false,
        },
      };
    case 'amend_goal':
      return {
        ok: true,
        projection: {
          kind: 'amend_revision',
          source,
          relation: proposal.relation,
          targetGoal: proposal.targetGoal,
          goal,
          parkPriorGoal: false,
        },
      };
    case 'abandon_goal':
      return {
        ok: true,
        projection: {
          kind: 'abandon_root',
          source,
          relation: proposal.relation,
          targetGoal: proposal.targetGoal,
          parkPriorGoal: false,
        },
      };
    case 'ambiguous':
      return {
        ok: true,
        projection: {
          kind: 'keep_slot_open',
          source,
          relation: proposal.relation,
          targetGoal: proposal.targetGoal,
          parkPriorGoal: false,
        },
      };
    default:
      return { ok: false, reason: 'unknown semantic relation' };
  }
}

/** Compile a provider-neutral work sketch from a mint/amend projection. */
export function proposedGraphFromProjection(projection: SemanticProjectionV1): ProposedTurnGraphV1 {
  if (!projection.goal || projection.kind === 'conversation' || projection.kind === 'abandon_root') {
    return { nodes: [{ kind: 'compose_reply' }] };
  }
  if (projection.goal.operations.length > 0) {
    const nodes: ProposedTurnGraphV1['nodes'] = projection.goal.operations.map((operation) => ({
      id: operation.id,
      kind: operation.requestedEffect === 'read' ? 'retrieve' : 'execute',
      effect: operation.requestedEffect,
      capabilityRole: operation.role,
      dependsOn: [...operation.dependsOn],
      evidence: [...operation.evidence],
    }));
    nodes.push({ kind: 'verify' });
    if (projection.goal.openSlotKeys.length > 0) nodes.push({ kind: 'await_input' });
    nodes.push({ kind: 'compose_reply' });
    const sinks = destinationsOf(projection.goal);
    return {
      nodes,
      requestedEffect: projection.goal.requestedEffect,
      destinationFamily: sinks[0]?.family,
      destinationPosture: sinks[0]?.posture,
      destinationFamilies: sinks.map((sink) => sink.family),
    };
  }
  const nodes: ProposedTurnGraphV1['nodes'] = [];
  const sinks = destinationsOf(projection.goal);
  if (projection.goal.construct !== 'none') {
    nodes.push({ kind: 'retrieve', effect: 'read', capabilityRole: 'source' });
    if ((projection.goal.collection?.count ?? 0) >= 1) {
      nodes.push({
        kind: 'retrieve',
        effect: 'read',
        capabilityRole: 'collection',
        cardinality: projection.goal.collection?.count,
        requiredFields: projection.goal.collection?.projection,
      });
    }
    if (sinks.length > 1) {
      nodes.push({
        kind: 'execute',
        effect: 'host_only',
        capabilityRole: 'transform',
      });
      for (const [index, sink] of sinks.entries()) {
        nodes.push({
          id: index === 0 ? 'op-write' : `op-write-${index}`,
          kind: 'execute',
          effect: projection.goal.requestedEffect === 'none' ? 'unknown' : projection.goal.requestedEffect,
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
        effect: projection.goal.requestedEffect === 'none' ? 'unknown' : projection.goal.requestedEffect,
        capabilityRole: 'destination',
      });
    }
    nodes.push({ kind: 'verify' });
  }
  if (projection.goal.openSlotKeys.length > 0) {
    nodes.push({ kind: 'await_input' });
  }
  nodes.push({ kind: 'compose_reply' });
  return {
    nodes,
    requestedEffect: projection.goal.requestedEffect,
    destinationFamily: sinks[0]?.family,
    destinationPosture: sinks[0]?.posture,
    destinationFamilies: sinks.map((sink) => sink.family),
  };
}
