export interface WorkflowRunReceipt {
  queued?: boolean;
  duplicate?: boolean;
  held?: boolean;
  status?: string;
  id?: string;
  runId?: string;
  message?: string;
  reason?: string;
}

/** Queue acceptance is not evidence that execution has started or succeeded. */
export function workflowRunNotice(value: unknown): string {
  const receipt = value && typeof value === 'object' && !Array.isArray(value) ? value as WorkflowRunReceipt : {};
  const id = typeof receipt.id === 'string' ? receipt.id.trim() : typeof receipt.runId === 'string' ? receipt.runId.trim() : '';
  const message = typeof receipt.message === 'string' ? receipt.message.trim() : '';
  const detail = message || (typeof receipt.reason === 'string' ? receipt.reason.trim() : '');
  if ((receipt.duplicate === true || receipt.status === 'duplicate') && id) {
    return 'A matching run already exists. Check Recent runs for its status.';
  }
  if (receipt.held === true || receipt.status === 'held') {
    const reason = detail || 'This flow is waiting for preparation.';
    return `${reason} Check its readiness on the desktop before requesting another run.`;
  }
  if (receipt.status === 'blocked_readiness' || receipt.status === 'disabled') {
    const reason = detail || 'This flow is not ready to run.';
    return `${reason} Review its readiness on the desktop, then try again.`;
  }
  if (receipt.queued === true && id && (!receipt.status || receipt.status === 'queued')) {
    return 'Queued. Check Recent runs to follow its progress.';
  }
  return 'No queued run was confirmed. Refresh Recent runs and check its status before trying again.';
}

export function workflowRunFailure(error: unknown): string {
  const failure = error as { message?: unknown; body?: { status?: unknown } } | null;
  if (failure?.body?.status === 'blocked_readiness') return workflowRunNotice(failure.body);
  const message = typeof failure?.message === 'string' && failure.message.trim() ? failure.message.trim() : 'Could not confirm a queued run.';
  return `${message} Check Recent runs for this run’s status before trying again.`;
}
