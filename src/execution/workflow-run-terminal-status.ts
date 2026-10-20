/** Canonical terminal-status display predicate; no workflow state transitions. */
export type WorkflowRunTerminalStatus =
  | 'completed'
  | 'completed_with_errors'
  | 'blocked'
  | 'error'
  | 'failed'
  | 'cancelled'
  | 'dry_run'
  | 'creation_test';

export const TERMINAL_STATUSES = new Set<WorkflowRunTerminalStatus>([
  'completed',
  'completed_with_errors',
  'blocked',
  'error',
  'failed',
  'cancelled',
  'dry_run',
  'creation_test',
]);

/** A run in one of the terminal states — nothing to cancel/cleanup. Exported
 *  for the workflow-lifecycle cleanup (delete/disable) and tests. */
export function isTerminalWorkflowRunStatus(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL_STATUSES.has(status as WorkflowRunTerminalStatus);
}
