/**
 * Build a TurnSemanticHostViewV1 from caller-supplied durable snapshots.
 * This function is pure: it does not read the eventlog or invent identities.
 */
import { createHash } from 'node:crypto';
import type {
  HostCapabilityDescriptorV1,
  OpenQuestionViewV1,
  ResumableGoalViewV1,
  TurnSemanticHostViewV1,
} from './turn-semantic-proposal.js';

export interface DurableSemanticSnapshotV1 {
  sessionId: string;
  sourceUserSeq: number;
  acceptedText: string;
  /** Mandatory audience identity. Session id is not a fallback. */
  audienceKey: string;
  userId: string;
  conversationKey: string;
  policyRevision: string;
  resumableGoals?: readonly ResumableGoalViewV1[];
  openQuestions?: readonly OpenQuestionViewV1[];
  capabilityIds?: readonly string[];
  capabilities?: readonly HostCapabilityDescriptorV1[];
  workflowIds?: readonly string[];
  catalogSnapshotDigest?: string;
  recentTurns?: ReadonlyArray<{ who: 'user' | 'assistant'; text: string }>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function audienceHashOf(input: {
  audienceKey: string;
  userId: string;
  conversationKey: string;
}): string {
  return sha256(JSON.stringify({
    audienceKey: input.audienceKey,
    userId: input.userId,
    conversationKey: input.conversationKey,
  }));
}

export function buildTurnSemanticHostViewV1(
  snapshot: DurableSemanticSnapshotV1,
): TurnSemanticHostViewV1 {
  if (!snapshot.audienceKey.trim() || !snapshot.userId.trim() || !snapshot.conversationKey.trim()) {
    throw new Error('semantic host view requires audience, user, and conversation identity');
  }
  if (!snapshot.policyRevision.trim()) {
    throw new Error('semantic host view requires a policy revision');
  }
  return {
    source: {
      sessionId: snapshot.sessionId,
      sourceUserSeq: snapshot.sourceUserSeq,
      inputHash: sha256(snapshot.acceptedText),
      audienceHash: audienceHashOf(snapshot),
    },
    policyRevision: snapshot.policyRevision,
    resumableGoals: snapshot.resumableGoals ? [...snapshot.resumableGoals] : [],
    openQuestions: snapshot.openQuestions ? [...snapshot.openQuestions] : [],
    catalog: {
      capabilityIds: new Set(
        snapshot.capabilities?.map((entry) => entry.id) ?? snapshot.capabilityIds ?? [],
      ),
      workflowIds: new Set(snapshot.workflowIds ?? []),
      ...(snapshot.capabilities ? { capabilities: [...snapshot.capabilities] } : {}),
    },
  };
}
