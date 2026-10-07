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

/** Only a confirmed queue/duplicate receipt can identify a run to open. */
export function workflowRunId(value: unknown): string | null {
  const receipt = value && typeof value === 'object' && !Array.isArray(value) ? value as WorkflowRunReceipt : {};
  if (receipt.held === true || receipt.status === 'held') return null;
  const id = typeof receipt.id === 'string' ? receipt.id.trim() : typeof receipt.runId === 'string' ? receipt.runId.trim() : '';
  const accepted = receipt.duplicate === true || receipt.status === 'duplicate'
    || (receipt.queued === true && (!receipt.status || receipt.status === 'queued'));
  return accepted && id ? id : null;
}

export function workflowRunTone(value: unknown): 'info' | 'warning' {
  const receipt = value && typeof value === 'object' && !Array.isArray(value) ? value as WorkflowRunReceipt : {};
  const id = typeof receipt.id === 'string' ? receipt.id.trim() : typeof receipt.runId === 'string' ? receipt.runId.trim() : '';
  if (receipt.held === true || receipt.status === 'held') return 'info';
  if ((receipt.duplicate === true || receipt.status === 'duplicate') && id) return 'info';
  if (receipt.queued === true && id && (!receipt.status || receipt.status === 'queued')) return 'info';
  return 'warning';
}

/** Queue acceptance is not evidence that execution has started or succeeded. */
export function workflowRunNotice(value: unknown): string {
  const receipt = value && typeof value === 'object' && !Array.isArray(value) ? value as WorkflowRunReceipt : {};
  const id = typeof receipt.id === 'string' ? receipt.id.trim() : typeof receipt.runId === 'string' ? receipt.runId.trim() : '';
  const message = typeof receipt.message === 'string' ? receipt.message.trim() : '';
  const detail = message || (typeof receipt.reason === 'string' ? receipt.reason.trim() : '');
  if ((receipt.duplicate === true || receipt.status === 'duplicate') && id) {
    return 'A matching run already exists. Open it in Automate to check its status.';
  }
  if (receipt.held === true || receipt.status === 'held') {
    const reason = detail || 'This workflow is waiting for preparation.';
    return `${reason} Check its readiness in Automate before requesting another run.`;
  }
  if (receipt.status === 'blocked_readiness' || receipt.status === 'disabled') {
    const reason = detail || 'This workflow is not ready to run.';
    return `${reason} Review its readiness in Automate, then try again.`;
  }
  if (receipt.queued === true && id && (!receipt.status || receipt.status === 'queued')) {
    return 'Queued. Open the run in Automate to follow its progress.';
  }
  return 'No queued run was confirmed. Refresh Automate and check its status before trying again.';
}

export function workflowRunFailure(error: unknown): string {
  const failure = error as { message?: unknown; body?: { status?: unknown } } | null;
  if (failure?.body?.status === 'blocked_readiness') return workflowRunNotice(failure.body);
  const message = typeof failure?.message === 'string' && failure.message.trim() ? failure.message.trim() : 'Could not confirm a queued run.';
  return `${message} Check Automate for this run’s status before trying again.`;
}
