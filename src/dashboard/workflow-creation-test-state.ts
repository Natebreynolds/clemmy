/**
 * The creation test as the workflow page should show it: running (a test for
 * this exact definition is still in flight), passed, or needs review — with
 * the daemon's own report. Live 2026-09-22: "Enable workflow" queued a test,
 * the drawer refetched once, and the switch the user had just flipped showed
 * off again with nothing saying why.
 */
import type { NotificationRecord } from '../runtime/notifications.js';

export interface WorkflowCreationTestState {
  runId: string;
  status: 'running' | 'passed' | 'needs_review';
  /** The report the daemon wrote (present once settled). */
  body?: string;
  at?: string;
}

export function workflowCreationTestState(input: {
  workflowName: string;
  pendingRunId?: string | null;
  notifications: readonly Pick<NotificationRecord, 'id' | 'body' | 'createdAt' | 'metadata'>[];
}): WorkflowCreationTestState | null {
  if (input.pendingRunId) return { runId: input.pendingRunId, status: 'running' };
  let latest: Pick<NotificationRecord, 'id' | 'body' | 'createdAt' | 'metadata'> | null = null;
  for (const row of input.notifications) {
    const meta = row.metadata ?? {};
    if (meta.creationTest !== true || meta.workflow !== input.workflowName || typeof meta.runId !== 'string') continue;
    if (!latest || row.createdAt > latest.createdAt) latest = row;
  }
  if (!latest) return null;
  const meta = latest.metadata ?? {};
  return {
    runId: String(meta.runId),
    status: meta.pass === true ? 'passed' : 'needs_review',
    body: latest.body,
    at: latest.createdAt,
  };
}
