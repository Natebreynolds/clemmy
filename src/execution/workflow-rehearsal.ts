import path from 'node:path';

import { currentDispatchLease } from '../runtime/harness/dispatch-lease.js';
import { getSession } from '../runtime/harness/eventlog.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { readWorkflowRunRecordSnapshot, workflowRunPhase } from './workflow-run-record.js';

/**
 * The workflow run the current tool call belongs to, when that run is a
 * rehearsal (a creation test that has not finished). Tools that keep a
 * workflow's own memory use it to leave the real memory untouched while the
 * test exercises the same calls a run makes.
 */
export function currentCallRehearsal(): { workflowRunId: string } | null {
  try {
    const lease = currentDispatchLease();
    if (!lease) return null;
    const session = getSession(lease.sessionId, { withoutConversationState: true });
    const runId = session?.metadata?.workflowRunId;
    if (session?.kind !== 'workflow' || typeof runId !== 'string' || !runId) return null;
    const record = readWorkflowRunRecordSnapshot<Record<string, unknown>>(
      path.join(WORKFLOW_RUNS_DIR, `${runId}.json`),
    );
    return workflowRunPhase(record) === 'rehearsal' ? { workflowRunId: runId } : null;
  } catch {
    return null;
  }
}
