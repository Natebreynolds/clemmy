import { appendEvent } from '../runtime/harness/eventlog.js';

/**
 * A compact, runtime-owned receipt proving that an execution boundary accepted
 * a candidate as safe to learn from. The receipt does not judge the procedure's
 * prose; it only prevents paused, degraded, ambiguous, or incomplete runs from
 * silently becoming procedural memory.
 */
export const LEARNING_RECEIPT_VERSION = 1 as const;

export type LearningAuthority =
  | 'goal_validation'
  | 'independent_completion_judge'
  | 'execution_controller'
  | 'workflow_terminal'
  | 'background_delivery_verifier'
  | 'manual_user_request';

export type LearningTarget = 'skill' | 'strategy' | 'workflow_pattern';

export interface LearningReceipt {
  version: typeof LEARNING_RECEIPT_VERSION;
  target: LearningTarget;
  authority: LearningAuthority;
  sessionId: string;
  sourceId: string;
  verifiedAt: string;
  evidence: string[];
}

export interface LearningCandidateInput {
  target: LearningTarget;
  authority: LearningAuthority;
  sessionId: string;
  sourceId: string;
  terminalSuccess: boolean;
  /** Independent model-family or deterministic criterion validation passed. */
  independentValidation?: boolean;
  /** A durable execution/workflow/background controller accepted completion. */
  controllerValidation?: boolean;
  /** The user explicitly requested distillation of the current trace. */
  explicitUserRequest?: boolean;
  failedOpen?: boolean;
  selfJudge?: boolean;
  awaitingUser?: boolean;
  needsAttention?: boolean;
  artifactVerificationPending?: number;
  ambiguousExternalWrites?: number;
  manifestRemaining?: number;
  manifestAnomalies?: number;
  manifestUntrackedCheckpoints?: number;
  externalWriteRequired?: boolean;
  externalWriteReceipts?: number;
}

export interface LearningDecision {
  eligible: boolean;
  reasons: string[];
  receipt?: LearningReceipt;
}

const AUTHORITIES = new Set<LearningAuthority>([
  'goal_validation',
  'independent_completion_judge',
  'execution_controller',
  'workflow_terminal',
  'background_delivery_verifier',
  'manual_user_request',
]);

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value ?? 0)) : 0;
}

function authorityEvidence(input: LearningCandidateInput): string | null {
  switch (input.authority) {
    case 'goal_validation':
    case 'independent_completion_judge':
      return input.independentValidation ? 'independent_validation' : null;
    case 'execution_controller':
    case 'workflow_terminal':
    case 'background_delivery_verifier':
      return input.controllerValidation ? 'controller_validation' : null;
    case 'manual_user_request':
      return input.explicitUserRequest ? 'explicit_user_request' : null;
  }
}

/**
 * Pure eligibility gate shared by every brain and execution surface.
 *
 * This is deliberately a narrow negative boundary: it rejects known reasons a
 * run is unsafe to learn from, while leaving novelty and procedure authoring to
 * the skill/pattern stores. It never changes the run's user-facing outcome.
 */
export function evaluateLearningCandidate(input: LearningCandidateInput): LearningDecision {
  const reasons: string[] = [];
  const sessionId = input.sessionId.trim();
  const sourceId = input.sourceId.trim();
  const authorityProof = authorityEvidence(input);

  if (!sessionId) reasons.push('missing session identity');
  if (!sourceId) reasons.push('missing source identity');
  if (!input.terminalSuccess) reasons.push('execution did not reach terminal success');
  if (!authorityProof) reasons.push(`missing ${input.authority} validation authority`);
  if (input.failedOpen) reasons.push('completion verification failed open');
  if (input.selfJudge) reasons.push('completion was only self-judged');
  if (input.awaitingUser) reasons.push('execution is awaiting user input');
  if (input.needsAttention) reasons.push('execution completed with needs-attention quality state');

  const artifactVerificationPending = nonNegative(input.artifactVerificationPending);
  const ambiguousExternalWrites = nonNegative(input.ambiguousExternalWrites);
  const manifestRemaining = nonNegative(input.manifestRemaining);
  const manifestAnomalies = nonNegative(input.manifestAnomalies);
  const manifestUntrackedCheckpoints = nonNegative(input.manifestUntrackedCheckpoints);
  const externalWriteReceipts = nonNegative(input.externalWriteReceipts);

  if (artifactVerificationPending > 0) {
    reasons.push(`${artifactVerificationPending} artifact binding(s) remain unverified`);
  }
  if (ambiguousExternalWrites > 0) {
    reasons.push(`${ambiguousExternalWrites} external write(s) have ambiguous outcomes`);
  }
  if (manifestRemaining > 0) {
    reasons.push(`${manifestRemaining} canonical manifest item(s) remain incomplete`);
  }
  if (manifestAnomalies > 0) {
    reasons.push(`${manifestAnomalies} work-manifest anomaly/anomalies remain`);
  }
  if (manifestUntrackedCheckpoints > 0) {
    reasons.push(`${manifestUntrackedCheckpoints} work checkpoint(s) are outside the canonical manifest`);
  }
  if (input.externalWriteRequired && externalWriteReceipts === 0) {
    reasons.push('the objective required an external write but no committed receipt exists');
  }

  if (reasons.length > 0 || !authorityProof) return { eligible: false, reasons };

  const evidence = ['terminal_success', authorityProof];
  if (artifactVerificationPending === 0) evidence.push('artifact_bindings_clear');
  if (ambiguousExternalWrites === 0) evidence.push('external_writes_unambiguous');
  if (manifestRemaining === 0 && manifestAnomalies === 0 && manifestUntrackedCheckpoints === 0) {
    evidence.push('manifest_clear');
  }
  if (input.externalWriteRequired) evidence.push('external_write_receipt');

  return {
    eligible: true,
    reasons: [],
    receipt: {
      version: LEARNING_RECEIPT_VERSION,
      target: input.target,
      authority: input.authority,
      sessionId,
      sourceId,
      verifiedAt: new Date().toISOString(),
      evidence,
    },
  };
}

/** Re-check persisted receipt shape at every memory write/read boundary. */
export function isValidLearningReceipt(
  value: unknown,
  expected?: { target?: LearningTarget; sessionId?: string; sourceId?: string },
): value is LearningReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<LearningReceipt>;
  if (receipt.version !== LEARNING_RECEIPT_VERSION) return false;
  if (receipt.target !== 'skill' && receipt.target !== 'strategy' && receipt.target !== 'workflow_pattern') return false;
  if (!receipt.authority || !AUTHORITIES.has(receipt.authority)) return false;
  if (typeof receipt.sessionId !== 'string' || !receipt.sessionId.trim()) return false;
  if (typeof receipt.sourceId !== 'string' || !receipt.sourceId.trim()) return false;
  if (typeof receipt.verifiedAt !== 'string' || !Number.isFinite(Date.parse(receipt.verifiedAt))) return false;
  if (!Array.isArray(receipt.evidence) || !receipt.evidence.includes('terminal_success')) return false;
  const requiredAuthorityEvidence = receipt.authority === 'goal_validation'
    || receipt.authority === 'independent_completion_judge'
    ? 'independent_validation'
    : receipt.authority === 'manual_user_request'
      ? 'explicit_user_request'
      : 'controller_validation';
  if (!receipt.evidence.includes(requiredAuthorityEvidence)) return false;
  if (expected?.target && receipt.target !== expected.target) return false;
  if (expected?.sessionId && receipt.sessionId !== expected.sessionId) return false;
  if (expected?.sourceId && receipt.sourceId !== expected.sourceId) return false;
  return true;
}

/** Best-effort visibility: every accepted/rejected auto-learning candidate is
 * queryable in the same run trace that supplied its execution evidence. */
export function recordLearningDecision(
  input: LearningCandidateInput,
  decision: LearningDecision,
  detail?: Record<string, unknown>,
): void {
  try {
    appendEvent({
      sessionId: input.sessionId,
      turn: 0,
      role: 'system',
      type: 'learning_candidate_evaluated',
      data: {
        target: input.target,
        authority: input.authority,
        sourceId: input.sourceId,
        eligible: decision.eligible,
        reasons: decision.reasons.slice(0, 8),
        ...(decision.receipt ? { receipt: decision.receipt } : {}),
        ...(detail ? { detail } : {}),
      },
    });
  } catch {
    // Learning observability must never change execution or memory behavior.
  }
}
