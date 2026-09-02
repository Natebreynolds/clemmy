/**
 * Identity of Clem's own workflow self-improvement turns (workflow-self-
 * improvement.ts). One predicate, imported by every seam that must treat the
 * turn as host-internal: the named-workflow shortcut (its text is ABOUT a
 * workflow that was asked to run, never a run request) and workflow_update
 * (the rewrite of an enabled workflow is verified by the run the consumer
 * re-queues, never parked disabled behind a creation test).
 */
export const WORKFLOW_IMPROVEMENT_SESSION_PREFIX = 'workflow-improvement:';

export function isWorkflowImprovementSessionId(sessionId: string | null | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith(WORKFLOW_IMPROVEMENT_SESSION_PREFIX);
}
