/**
 * Build the durable host snapshot for one accepted source. Pure over caller
 * state — eventlog/packet reads happen in the caller.
 */
import type { TurnGraphIR } from '../graph/turn-graph-ir.js';
import type { DurableSemanticSnapshotV1 } from './build-semantic-host-view.js';
import type { OpenQuestionViewV1, ResumableGoalViewV1 } from './turn-semantic-proposal.js';
import { currentInputSuppressesPriorTask } from '../harness/current-task-authority.js';

export function snapshotFromAcceptedSource(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedText: string;
  acceptedAt?: string;
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
    kind: 'clarification' | 'approval' | 'recovery';
    question: string;
    options: ReadonlyArray<string | { optionId: string; label: string }>;
    optionIntents?: ReadonlyArray<{ optionIndex: number; action: 'explain' | 'customize' }>;
    originatingSourceUserSeq: number;
    goalId?: string;
    revision?: number;
    questionId?: string;
    slotKey?: string;
    predecessorRefs?: readonly string[];
  } | null;
}): DurableSemanticSnapshotV1 {
  const suppressPriorTask = currentInputSuppressesPriorTask(input.acceptedText);
  const awaitInput = suppressPriorTask
    ? undefined
    : input.parentGraph?.nodes.find((node) => node.kind === 'await_input')?.awaitInput;
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
      // An await_input node is an ordinary semantic clarification. Its public
      // renderer explicitly tells the user that the visible choices are only
      // shortcuts and that they may answer in their own words. Preserve that
      // contract here: a value answer can settle the slot as `provided`, but
      // it still cannot acquire any option id or option-specific meta action.
      allowFreeText: true,
    });
  } else if (!suppressPriorTask && input.packet) {
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
      options: input.packet.options.map((option, index) => {
        const visible = typeof option === 'string'
          ? { optionId: `opt-${index + 1}`, label: option }
          : option;
        const metaAction = input.packet?.optionIntents
          ?.find((intent) => intent.optionIndex === index)?.action;
        return { ...visible, ...(metaAction ? { metaAction } : {}) };
      }),
      // Approval/recovery controls remain exact-option-only. Ordinary
      // clarification packets match the delivered "in your own words"
      // contract even when they also expose bounded visible shortcuts.
      allowFreeText: input.packet.kind === 'clarification',
    });
  }
  return {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedText: input.acceptedText,
    ...(input.acceptedAt ? { acceptedAt: input.acceptedAt } : {}),
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
