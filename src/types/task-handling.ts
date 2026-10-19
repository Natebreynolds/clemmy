/** Read-only retained evidence for one accepted chat request. No field grants
 * execution permission or claims why a model thought what it did. */
export interface TaskHandlingUsageTotals {
  calls: number; failedCalls: number; uncertifiedCalls: number; unknownCostCalls: number;
  promptTokens: number; cachedReadTokens: number; uncachedWorkTokens: number;
  outputTokens: number; reportedTotalTokens: number; modelMs: number;
}
/** Current memory subwork only; it does not revise a task's historical outcome. */
export type TaskMemoryState = 'pending' | 'saved' | 'refused' | 'needs_choice' | 'unavailable';
export interface TaskMemoryStatus {
  version: 1;
  sessionId: string;
  sourceUserSeq: number;
  observedAt: string;
  memory: null | {
    state: TaskMemoryState | 'mixed';
    candidates: Array<{ candidateId: number; state: TaskMemoryState; factId?: number;
      reason?: 'inactive' | 'superseded' | 'unverified' | 'retry_exhausted' | 'destination_unresolved' }>;
    counts: { pending: number; saved: number; refused: number; needsChoice: number; unavailable: number };
    nextStep: 'wait' | 'review_memory' | 'clarify_destination' | 'check_again' | 'none';
    pollAfterMs: number | null;
  };
}
export interface TaskHandlingDetails {
  version: 1;
  sessionId: string;
  sourceUserSeq: number;
  acceptedAt: string;
  observedAt: string;
  attemptIds: string[];
  tools: Array<{
    callId: string; eventSeq: number; name: string; attemptId?: string;
    status: 'started' | 'returned' | 'failed' | 'reused';
    dispatchEvidence: 'physical' | 'lifecycle' | 'reused'; physicalDispatches?: number;
    effect?: string; startedAt: string; finishedAt?: string;
    /** Advisory preparation recorded for the accepted request, not proof of causal reasoning or account authority. */
    selection?: { kind: 'owner_preference' | 'prepared_approach'; strategyId?: string; factId?: number; text?: string };
  }>;
  models: Array<{
    callId: string; role: string; provider: string; requestedModel?: string;
    resolvedModel: string; servedModel?: string; servedProvider?: string; providerReportedModel?: string;
    attemptId?: string; status: 'started' | 'success' | 'failed' | 'fallback' | 'cancelled';
    responseCompleted: boolean; fallbackToModel?: string; durationMs?: number;
  }>;
  usage: {
    scope: 'accepted_source'; meteringStartedAt: string; sourcePredatesMetering: boolean;
    totals: TaskHandlingUsageTotals; byRole: Record<string, TaskHandlingUsageTotals>;
  } | null;
  memory: {
    consolidation?: TaskMemoryStatus['memory'];
    provided: {
      recordedAt: string; sourceUserSeq: number;
      totals?: { tokens: number; bytes: number; coreTokens: number; relevantTokens: number; nowTokens: number };
      manifest: Array<{ section: string; tier: 'core' | 'relevant' | 'now'; tokens: number; bytes: number; refs: Array<{ type: string; id: string }> }>;
    } | null;
    recall: Array<{ id: string; surface: string; createdAt: string;
      refs: Array<{ type: string; id: string; text?: string; outcome: 'offered' | 'used' | 'not_useful' }> }>;
  };
  limits: { toolsTruncated: boolean; modelsTruncated: boolean; memoryTruncated: boolean };
  limitations: string[];
}
