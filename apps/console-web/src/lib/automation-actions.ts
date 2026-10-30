import type { PendingCommit } from './pending-commit';
import { automationRunHref } from './automation-editor';
import { workflowRunFailure, workflowRunId, workflowRunNotice, workflowRunTone } from './workflow-run-receipt';

export type AutomationFeedback = { text: string; error?: boolean; href?: string; label?: string };

/** Only the mounted action owner can publish a receipt; never retry a write automatically. */
export async function performAutomationAction(options: {
  commit: PendingCommit;
  key: string;
  request: () => Promise<unknown>;
  workflow?: string;
  pending: (key: string | null) => void;
  feedback: (value: AutomationFeedback | null) => void;
  refresh: () => unknown;
}): Promise<void> {
  const { commit, key, request, workflow, pending, feedback, refresh } = options;
  const token = commit.begin();
  if (!token) return;
  pending(key); feedback(null);
  try {
    const result = await request();
    if (!commit.owns(token)) return;
    const runId = workflow ? workflowRunId(result) : null;
    feedback(workflow ? {
      text: workflowRunNotice(result), error: workflowRunTone(result) === 'warning',
      ...(runId ? { href: automationRunHref(workflow, runId), label: 'View run' }
        : { href: `/automate/${encodeURIComponent(workflow)}?advanced=1`, label: 'Review workflow' }),
    } : { text: key.startsWith('cancel:') ? 'Reminder cancelled.' : 'Schedule updated.' });
  } catch (error) {
    if (commit.owns(token)) feedback({ error: true, text: workflow ? workflowRunFailure(error)
      : `${error instanceof Error ? error.message : 'The change could not be confirmed.'} Refresh the status before trying again.` });
  } finally {
    if (commit.finish(token)) { pending(null); refresh(); }
  }
}
