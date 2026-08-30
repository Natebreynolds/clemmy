import { frozenMutationProgress } from './mutation-verification-proof.js';

/**
 * A minimal public projection for the one state ordinary generated prose
 * cannot safely describe on its own: some, but not all, exact frozen mutation
 * receipts are verified. The words contain no provider payload, schema, or
 * internal harness state and claim only what those durable receipts prove.
 */
export function exactPartialMutationPresentation(input: {
  sessionId: string;
  sourceUserSeq: number;
}): string | null {
  const progress = frozenMutationProgress(input);
  if (progress.status !== 'partial') return null;
  const created = progress.verified.some((fact) => fact.createdResource);
  return created
    ? 'The requested resource was created and verified, but the remaining requested change was not completed or verified.'
    : 'Part of the requested work was completed and verified, but the remaining requested change was not completed or verified.';
}
