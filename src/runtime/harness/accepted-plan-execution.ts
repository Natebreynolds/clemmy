import { listEvents } from './eventlog.js';
/** Reviewed-plan selection is accepted user context, never a tool consent grant. */
import { acceptedTaskMode, acceptedTaskModeIdentity } from './accepted-task-mode.js';
import { getPlanExecutionClaim, getPlanRevision, type PlanArtifactV1, type PlanExecutionClaimV1 } from './plan-artifacts.js';
import { closedCanonicalJson, SEALED_CALL_CANONICAL_LIMITS } from '../../shared/closed-canonical-json.js';

export function acceptedPlanExecution(sessionId: string, sourceUserSeq: number): { artifact: PlanArtifactV1; claim: PlanExecutionClaimV1 } | null {
  if (acceptedTaskMode(sessionId, sourceUserSeq)?.kind !== 'execute') return null;
  const source = acceptedTaskModeIdentity(sessionId, sourceUserSeq);
  if (source.mode?.kind !== 'execute') return null;
  const scope = { sessionId, principalId: source.principalId, ref: source.mode.executeRef };
  const artifact = getPlanRevision(scope);
  const claim = getPlanExecutionClaim(scope);
  if (!claim || claim.sessionId !== sessionId || claim.sourceUserSeq !== sourceUserSeq
    || artifact.readiness !== 'ready' || artifact.missingPrerequisites.length !== 0) {
    throw new Error('Execute has no exact ready revision and accepted-source execution claim.');
  }
  return { artifact, claim };
}

/** Compact durable identity; full reviewed bytes remain in the immutable artifact. */
export function acceptedPlanExecutionObjective(sessionId: string, sourceUserSeq: number): string | null {
  const selected = acceptedPlanExecution(sessionId, sourceUserSeq);
  if (!selected) return null;
  return `Execute reviewed plan ${selected.artifact.planId}, revision ${selected.artifact.revision}, digest ${selected.artifact.digest}.`;
}

export function acceptedPlanExecutionText(sessionId: string, sourceUserSeq: number): string | null {
  const selected = acceptedPlanExecution(sessionId, sourceUserSeq);
  if (!selected) return null;
  const source = listEvents(sessionId, { sinceSeq: sourceUserSeq - 1, types: ['user_input_received'], limit: 1 }).find(event => event.seq === sourceUserSeq);
  const literal = typeof source?.data.displayText === 'string' && source.data.displayText ? source.data.displayText : typeof source?.data.text === 'string' ? source.data.text : '';
  if (!literal) throw new Error('Execute source text is missing.');
  return [
    literal,
    `The user explicitly selected Execute for reviewed plan ${selected.artifact.planId}, revision ${selected.artifact.revision}, digest ${selected.artifact.digest}.`,
    'The following immutable reviewed plan defines the requested work. Its selection is not blanket tool, send, destructive-action, or account consent; existing per-call policy still applies.',
    '<reviewed-plan>', selected.artifact.fullText, '</reviewed-plan>',
    '<reviewed-structure>', closedCanonicalJson(selected.artifact.structuredPlan ?? {}, SEALED_CALL_CANONICAL_LIMITS), '</reviewed-structure>',
  ].join('\n');
}
