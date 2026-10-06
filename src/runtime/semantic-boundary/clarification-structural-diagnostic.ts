/** Finite local rejection observations, never a model claim or execution
 * authority. Raw proposals, quotes, errors and source text are not retained. */
import { createHash } from 'node:crypto';
import type { ClarificationRevisionInput } from './clarification-revision.js';

export const CLARIFICATION_STRUCTURAL_REJECTION_REASONS = [
  'duplicate_decision_id', 'options_changed', 'question_quote_unbound',
  'reply_quote_unbound', 'settled_fields_invalid', 'no_residual_decision',
] as const;

export interface ClarificationStructuralRejection {
  reason: typeof CLARIFICATION_STRUCTURAL_REJECTION_REASONS[number];
  decisionIndex: number | null;
  anchorOrigin: 'question' | 'option' | null;
  optionIndex: number | null;
}

export interface ClarificationStructuralDiagnostic extends ClarificationStructuralRejection {
  version: 1;
  kind: 'clarification_structural_rejection';
  anchorPolicy: 'question_and_visible_options_v1';
  sessionId: string;
  sourceUserSeq: number;
  inputDigest: string;
  proposalDigest: string;
}

/** Same exact tuple and ordering used by revision and persisted receipt
 * validation. Optional public annotation remains separately bound as before. */
export function clarificationRevisionInputDigest(input: ClarificationRevisionInput): string {
  return createHash('sha256').update(JSON.stringify({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    rootTask: input.rootTask,
    deliveredQuestion: input.deliveredQuestion,
    deliveredOptions: [...input.deliveredOptions],
    acceptedReply: input.acceptedReply,
    ...(input.deliveredPublicQuestion !== undefined ? {
      deliveredPublicQuestion: input.deliveredPublicQuestion,
      deliveredQuestionAnnotation: input.deliveredQuestionAnnotation,
    } : {}),
  })).digest('hex');
}

/** Strict projection for the caller's exact source. It cannot prove the
 * proposal was semantically correct, reviewed, retained or allowed to run. */
export function validatedClarificationStructuralDiagnostic(
  value: unknown,
  input: ClarificationRevisionInput,
): ClarificationStructuralDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  const keys = ['version', 'kind', 'anchorPolicy', 'sessionId', 'sourceUserSeq', 'inputDigest', 'proposalDigest',
    'reason', 'decisionIndex', 'anchorOrigin', 'optionIndex'];
  const digestPattern = /^[a-f0-9]{64}$/;
  if (Object.keys(d).length !== keys.length || Object.keys(d).some((key) => !keys.includes(key))
    || d.version !== 1 || d.kind !== 'clarification_structural_rejection' || d.anchorPolicy !== 'question_and_visible_options_v1'
    || d.sessionId !== input.sessionId || typeof d.sessionId !== 'string' || !d.sessionId.trim() || d.sessionId.length > 512
    || d.sourceUserSeq !== input.sourceUserSeq || !Number.isSafeInteger(d.sourceUserSeq) || (d.sourceUserSeq as number) <= 0
    || typeof d.inputDigest !== 'string' || !digestPattern.test(d.inputDigest)
    || typeof d.proposalDigest !== 'string' || !digestPattern.test(d.proposalDigest)
    || typeof d.reason !== 'string' || !(CLARIFICATION_STRUCTURAL_REJECTION_REASONS as readonly string[]).includes(d.reason)
    || !(d.decisionIndex === null || (Number.isInteger(d.decisionIndex) && (d.decisionIndex as number) >= 0 && (d.decisionIndex as number) < 8))
    || !(d.anchorOrigin === null || d.anchorOrigin === 'question' || d.anchorOrigin === 'option')
    || !(d.optionIndex === null || (Number.isInteger(d.optionIndex) && (d.optionIndex as number) >= 0 && (d.optionIndex as number) < 8))) return null;
  const globalReason = d.reason === 'options_changed' || d.reason === 'no_residual_decision';
  if (globalReason !== (d.decisionIndex === null)
    || (globalReason && (d.anchorOrigin !== null || d.optionIndex !== null))
    || (d.reason === 'question_quote_unbound' && (d.anchorOrigin !== null || d.optionIndex !== null))
    || ((d.anchorOrigin === 'option') !== (d.optionIndex !== null))
    || (!globalReason && d.reason !== 'question_quote_unbound' && d.reason !== 'duplicate_decision_id' && d.anchorOrigin === null)
    || (d.anchorOrigin === 'option' && (!Array.isArray(input.deliveredOptions) || (d.optionIndex as number) >= input.deliveredOptions.length))) return null;
  try {
    if (d.inputDigest !== clarificationRevisionInputDigest(input)) return null;
  } catch { return null; }
  return { ...d } as unknown as ClarificationStructuralDiagnostic;
}

export function createClarificationStructuralDiagnostic(
  input: ClarificationRevisionInput,
  proposalDigest: string,
  rejection: ClarificationStructuralRejection,
): ClarificationStructuralDiagnostic {
  return {
    version: 1, kind: 'clarification_structural_rejection', anchorPolicy: 'question_and_visible_options_v1',
    sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq,
    inputDigest: clarificationRevisionInputDigest(input), proposalDigest,
    ...rejection,
  };
}
