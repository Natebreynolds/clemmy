import { AsyncLocalStorage } from 'node:async_hooks';
import type { PersistedConversation } from './session.js';

export const WORKFLOW_PARENT_LEASE_PREFIX = 'workflow-parent:';

/** Private runtime ownership, never a model-supplied resume flag. The durable
 * tool-batch ledger owns progress; this activation-local snapshot prevents an
 * older parent's replay from replacing another conversation's snapshot. */
export interface WorkflowParentActivation {
  sessionId: string;
  sourceUserSeq: number;
  attemptId: string;
  runId: string;
  assertOwned(): void;
  /** Reopened child execution evidence for the parent's completion reviewer.
   * This host callback is never supplied through model continuation text. */
  completionEvidence?(): string;
  conversation: PersistedConversation;
}

const storage = new AsyncLocalStorage<WorkflowParentActivation>();

export function withWorkflowParentActivation<T>(activation: WorkflowParentActivation, fn: () => T): T {
  activation.assertOwned();
  return storage.run(activation, fn);
}

export function workflowParentActivation(sessionId: string, sourceUserSeq?: number): WorkflowParentActivation | undefined {
  const active = storage.getStore();
  if (!active || active.sessionId !== sessionId
    || (sourceUserSeq !== undefined && active.sourceUserSeq !== sourceUserSeq)) return undefined;
  active.assertOwned();
  return active;
}
