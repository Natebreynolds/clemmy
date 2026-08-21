/**
 * Same-root continuation: a reply is an audit event that settles or amends
 * the existing root goal. Disposition comes from a typed projection, never
 * from inspecting answer prose.
 */
import type { TaskContinuityPacketInput } from '../../memory/task-continuity.js';
import type { ContinuationAnswerDisposition } from '../../types.js';
import type { TurnGraphAwaitInput, TurnGraphIR } from '../graph/turn-graph-ir.js';
import type { SemanticProjectionV1 } from './project-checked-semantics.js';
import type { SlotAnswerV1 } from './turn-semantic-proposal.js';

export type SameRootContinuation =
  | {
      action: 'settle_slot';
      goalId: string;
      revision: number;
      disposition: Extract<ContinuationAnswerDisposition, 'affirmed' | 'selected' | 'provided'>;
      selectedOption?: string;
      slotAnswer: SlotAnswerV1;
    }
  | {
      action: 'keep_open';
      goalId: string;
      revision: number;
    }
  | {
      action: 'amend';
      goalId: string;
      fromRevision: number;
      toRevision: number;
    }
  | {
      action: 'park_and_mint';
      priorGoalId: string;
    }
  | {
      action: 'abandon';
      goalId: string;
      revision: number;
    }
  | {
      action: 'continue';
      goalId: string;
      revision: number;
    }
  | { action: 'conversation' };

export function sameRootFromProjection(projection: SemanticProjectionV1): SameRootContinuation {
  switch (projection.kind) {
    case 'conversation':
      return { action: 'conversation' };
    case 'mint_goal':
      return {
        action: 'park_and_mint',
        priorGoalId: projection.targetGoal?.goalId ?? '',
      };
    case 'continue_same_root':
      return {
        action: 'continue',
        goalId: projection.targetGoal?.goalId ?? '',
        revision: projection.targetGoal?.baseRevision ?? 0,
      };
    case 'settle_slot': {
      const answer = projection.slotAnswer;
      const selected = answer?.kind === 'option' ? answer.optionId : undefined;
      return {
        action: 'settle_slot',
        goalId: projection.targetGoal?.goalId ?? '',
        revision: projection.targetGoal?.baseRevision ?? 0,
        disposition: selected ? 'selected' : 'provided',
        ...(selected ? { selectedOption: selected } : {}),
        slotAnswer: answer ?? {
          kind: 'value',
          questionId: '',
          slotKey: '',
          value: '',
        },
      };
    }
    case 'amend_revision':
      return {
        action: 'amend',
        goalId: projection.targetGoal?.goalId ?? '',
        fromRevision: projection.targetGoal?.baseRevision ?? 0,
        toRevision: (projection.targetGoal?.baseRevision ?? 0) + 1,
      };
    case 'abandon_root':
      return {
        action: 'abandon',
        goalId: projection.targetGoal?.goalId ?? '',
        revision: projection.targetGoal?.baseRevision ?? 0,
      };
    case 'keep_slot_open':
      return {
        action: 'keep_open',
        goalId: projection.targetGoal?.goalId ?? '',
        revision: projection.targetGoal?.baseRevision ?? 0,
      };
    default:
      return { action: 'conversation' };
  }
}

export function awaitInputFromGraph(graph: TurnGraphIR): TurnGraphAwaitInput | undefined {
  return graph.nodes.find((node) => node.kind === 'await_input')?.awaitInput;
}

/** Continuity packet bytes are copied from the await_input node, not from
 *  model prose. The host writes the packet when that node publishes. */
export function continuityPacketFromAwaitInput(input: {
  sessionId: string;
  originatingSourceUserSeq: number;
  awaitInput: TurnGraphAwaitInput;
}): TaskContinuityPacketInput {
  return {
    sessionId: input.sessionId,
    originatingSourceUserSeq: input.originatingSourceUserSeq,
    pause: {
      kind: 'clarification',
      question: input.awaitInput.deliveredQuestion,
      options: input.awaitInput.visibleOptions.map((option) => option.label),
      slot: {
        goalId: input.awaitInput.goalId,
        revision: input.awaitInput.revision,
        questionId: input.awaitInput.questionId,
        slotKey: input.awaitInput.slotId,
        predecessorRefs: input.awaitInput.predecessorRefs,
      },
    },
  };
}

export function typedDispositionFromProjection(
  projection: SemanticProjectionV1,
): { disposition: ContinuationAnswerDisposition; selectedOption?: string } | null {
  const root = sameRootFromProjection(projection);
  if (root.action === 'settle_slot') {
    return {
      disposition: root.disposition,
      ...(root.selectedOption ? { selectedOption: root.selectedOption } : {}),
    };
  }
  if (root.action === 'park_and_mint') {
    return { disposition: 'declined_with_new_task' };
  }
  if (root.action === 'abandon') {
    return { disposition: 'declined' };
  }
  return null;
}
