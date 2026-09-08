import {
  getLatestPlanRevision, getPlanExecutionClaim, getPlanRevision, PlanArtifactError,
} from '../runtime/harness/plan-artifacts.js';
import { getSession } from '../runtime/harness/eventlog.js';
import { parsePlanRevisionRef } from '../runtime/harness/task-mode.js';
import { resolveReviewedPlanOwnerControl, type AuthenticatedPlanOwnerActor } from '../runtime/harness/reviewed-plan-owner-control.js';

/** Both authenticated surfaces use the same exact-ref response. Authentication
 * itself remains at the route: mobile supplies its paired device principal;
 * the local owner-authorized console may inspect its selected session. */
export function planArtifactResponse(input: {
  planId: unknown;
  sessionId: unknown;
  revision: unknown;
  digest: unknown;
  principal: { kind: 'mobile_device'; principalId: string } | { kind: 'local_owner' }
    | { kind: 'authenticated_owner'; actor: AuthenticatedPlanOwnerActor };
}): { status: number; body: Record<string, unknown> } {
  try {
    if (typeof input.sessionId !== 'string' || !input.sessionId.trim()
      || input.sessionId !== input.sessionId.trim()
      || typeof input.revision !== 'string' || !/^[1-9][0-9]*$/.test(input.revision)) {
      return { status: 400, body: { error: 'Exact sessionId, revision, and digest are required.' } };
    }
    const ref = parsePlanRevisionRef({ planId: input.planId, revision: Number(input.revision), digest: input.digest });
    const session = getSession(input.sessionId);
    if (!session) return { status: 404, body: { error: 'Conversation not found.' } };
    const principalId = input.principal.kind === 'mobile_device'
      ? input.principal.principalId : input.principal.kind === 'authenticated_owner'
        ? resolveReviewedPlanOwnerControl({ sessionId: session.id, ref, actor: input.principal.actor }).principalId
        : session.userId ?? session.id;
    const scope = { sessionId: session.id, principalId };
    const artifact = getPlanRevision({ ...scope, ref });
    const current = getLatestPlanRevision({ ...scope, planId: ref.planId });
    const latest = current ? { planId: current.planId, revision: current.revision, digest: current.digest } : null;
    const execution = getPlanExecutionClaim({ ...scope, ref });
    return { status: 200, body: { artifact, latest, execution } };
  } catch (error) {
    if (error instanceof PlanArtifactError) {
      const status = error.code === 'denied' ? 403 : error.code === 'missing' ? 404
        : error.code === 'invalid' ? 400 : 409;
      return { status, body: { error: error.message, code: error.code,
        ...(error.latestRef ? { latestRef: error.latestRef } : {}) } };
    }
    if (error instanceof Error && /^INVALID_(?:TASK_MODE|PLAN_REVISION_REF)$/.test(error.message)) {
      return { status: 400, body: { error: 'Invalid exact plan revision reference.' } };
    }
    return { status: 500, body: { error: 'Unable to load the complete reviewed plan.' } };
  }
}
