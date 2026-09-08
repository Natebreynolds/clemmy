/** Typed Plan controls on this daemon's authenticated owner surfaces. Pairing
 * and console authorization remain at the HTTP boundary. The durable plan
 * principal is preserved; a surface/device identity is audit attribution. */
import { createHash } from 'node:crypto';
import { getActiveRunAttempt, getSession, openEventLog } from './eventlog.js';
import { getPlanRevision, PlanArtifactError } from './plan-artifacts.js';
import { parseTaskMode, type PlanRevisionRef, type TaskMode } from './task-mode.js';

export interface AuthenticatedPlanOwnerActor {
  surface: 'desktop' | 'mobile';
  id: string;
}
export interface ReviewedPlanOwnerControlV1 {
  version: 1;
  actor: AuthenticatedPlanOwnerActor;
  conversationPrincipalId: string;
  planRef: PlanRevisionRef;
}

export function resolveReviewedPlanOwnerControl(input: {
  sessionId: string;
  ref: PlanRevisionRef;
  actor: AuthenticatedPlanOwnerActor;
}): { sessionId: string; principalId: string; ownerControl: ReviewedPlanOwnerControlV1 } {
  if (!input.actor.id.trim() || !['desktop', 'mobile'].includes(input.actor.surface)) {
    throw new PlanArtifactError('denied', 'An authenticated owner surface is required.');
  }
  const session = getSession(input.sessionId);
  if (!session) throw new PlanArtifactError('missing', 'The reviewed conversation no longer exists.');
  const principalId = session.userId ?? session.id;
  getPlanRevision({ sessionId: session.id, principalId, ref: input.ref });
  return { sessionId: session.id, principalId, ownerControl: {
    version: 1, actor: { ...input.actor }, conversationPrincipalId: principalId, planRef: { ...input.ref },
  } };
}

/** C8 Execute is new; its two surfaces share the existing desktop byte shape.
 * Ordinary and absent-mode request hashes are intentionally unchanged. */
export function reviewedPlanExecuteInputHash(input: {
  text: string; attachmentIds?: string[]; taskMode: TaskMode;
}): string {
  const mode = parseTaskMode(input.taskMode);
  if (mode?.kind !== 'execute') throw new Error('Exact Execute mode is required.');
  return createHash('sha256').update(JSON.stringify({ input: input.text.trim(),
    attachmentIds: input.attachmentIds ?? [], taskMode: mode })).digest('hex');
}

/** Joining the same execution is handled first by the durable ingress owner.
 * A fresh control must never replace an unrelated live attempt or steer it. */
export function assertReviewedPlanExecuteSessionIdle(sessionId: string, existingRunId?: string): void {
  const active = getActiveRunAttempt(sessionId);
  if (active && active.runId !== existingRunId) {
    throw new PlanArtifactError('conflict', 'This conversation has active work. Stop it or wait for it to finish before Execute.');
  }
}

/** Serialize the final idle check with attempt/source admission, including
 * another process claiming unrelated work after the HTTP preflight. */
export function withReviewedPlanExecuteAdmission<T>(sessionId: string, runId: string, admit: () => T): T {
  return openEventLog().transaction(() => {
    assertReviewedPlanExecuteSessionIdle(sessionId, runId);
    return admit();
  }).immediate();
}
