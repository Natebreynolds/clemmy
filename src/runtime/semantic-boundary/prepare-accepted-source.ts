/**
 * Build the durable host snapshot for one accepted source. Pure over caller
 * state — eventlog/packet reads happen in the caller.
 */
import type { TurnGraphIR } from '../graph/turn-graph-ir.js';
import type { DurableSemanticSnapshotV1 } from './build-semantic-host-view.js';
import type { OpenQuestionViewV1, ResumableGoalViewV1 } from './turn-semantic-proposal.js';

export function snapshotFromAcceptedSource(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedText: string;
  audienceKey: string;
  userId: string;
  conversationKey: string;
  policyRevision: string;
  capabilityIds?: readonly string[];
  capabilities?: DurableSemanticSnapshotV1['capabilities'];
  workflowIds?: readonly string[];
  catalogSnapshotDigest?: string;
  parentGraph?: TurnGraphIR | null;
  recentTurns?: ReadonlyArray<{ who: 'user' | 'assistant'; text: string }>;
  packet?: {
    question: string;
    options: ReadonlyArray<string | { optionId: string; label: string }>;
    originatingSourceUserSeq: number;
    goalId?: string;
    revision?: number;
    questionId?: string;
    slotKey?: string;
    predecessorRefs?: readonly string[];
  } | null;
}): DurableSemanticSnapshotV1 {
  const awaitInput = input.parentGraph?.nodes.find((node) => node.kind === 'await_input')?.awaitInput;
  const resumableGoals: ResumableGoalViewV1[] = [];
  const openQuestions: OpenQuestionViewV1[] = [];
  if (awaitInput) {
    resumableGoals.push({
      goalId: awaitInput.goalId,
      baseRevision: awaitInput.revision,
      checkpointRef: input.parentGraph?.compiler.graphHash,
      settledEvidenceRefs: [...(awaitInput.predecessorRefs ?? [])],
    });
    openQuestions.push({
      questionId: awaitInput.questionId,
      goalId: awaitInput.goalId,
      goalRevision: awaitInput.revision,
      slotKey: awaitInput.slotId,
      question: awaitInput.deliveredQuestion,
      options: awaitInput.visibleOptions.map((option) => ({ ...option })),
      allowFreeText: awaitInput.visibleOptions.length === 0,
    });
  } else if (input.packet) {
    const goalId = input.packet.goalId ?? `goal:${input.sessionId}:${input.packet.originatingSourceUserSeq}`;
    const revision = input.packet.revision ?? 0;
    resumableGoals.push({
      goalId,
      baseRevision: revision,
      settledEvidenceRefs: input.packet.predecessorRefs ? [...input.packet.predecessorRefs] : [],
    });
    openQuestions.push({
      questionId: input.packet.questionId ?? `question:${input.packet.originatingSourceUserSeq}`,
      goalId,
      goalRevision: revision,
      slotKey: input.packet.slotKey ?? 'reply',
      question: input.packet.question,
      options: input.packet.options.map((option, index) => (
        typeof option === 'string'
          ? { optionId: `opt-${index + 1}`, label: option }
          : option
      )),
      allowFreeText: input.packet.options.length === 0,
    });
  }
  return {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedText: input.acceptedText,
    audienceKey: input.audienceKey,
    userId: input.userId,
    conversationKey: input.conversationKey,
    policyRevision: input.policyRevision,
    resumableGoals,
    openQuestions,
    capabilityIds: input.capabilityIds,
    capabilities: input.capabilities,
    workflowIds: input.workflowIds,
    catalogSnapshotDigest: input.catalogSnapshotDigest,
    ...(input.recentTurns ? { recentTurns: [...input.recentTurns] } : {}),
  };
}
