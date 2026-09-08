/** Presentation-only run-record status. Never a recovery or cancellation grant. */
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { scanWorkflowRunRecordSnapshot } from '../execution/workflow-run-record.js';

export interface UnifiedRunCoverage {
  version: 1;
  /** The returned sessions are known recorded steps, not the entire planned topology. */
  kind: 'known_steps';
  state: 'available' | 'unavailable';
  reason?: 'record_missing' | 'record_busy' | 'record_corrupt' | 'identity_mismatch' | 'unrecognized_status';
}

export interface WorkflowRunStatusProjection {
  status: 'active' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  runCoverage: UnifiedRunCoverage;
}

function unavailable(reason: NonNullable<UnifiedRunCoverage['reason']>): WorkflowRunStatusProjection {
  return { status: 'unknown', runCoverage: { version: 1, kind: 'known_steps', state: 'unavailable', reason } };
}

function readExactRunStatus(runId: string, runsDirectory: string): WorkflowRunStatusProjection {
  if (!runId || runId.length > 512 || runId !== runId.trim()
    || runId === '.' || runId === '..'
    || path.posix.basename(runId) !== runId || path.win32.basename(runId) !== runId) {
    return unavailable('identity_mismatch');
  }
  const file = path.join(runsDirectory, `${runId}.json`);
  try {
    // Do not follow a symlink to a record outside the requested inventory.
    if (!lstatSync(file).isFile()) return unavailable('identity_mismatch');
  } catch (error) {
    return unavailable((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'record_missing' : 'record_busy');
  }
  const snapshot = scanWorkflowRunRecordSnapshot<Record<string, unknown>>(file);
  if (snapshot.status !== 'ok') {
    if (snapshot.status === 'corrupt' && snapshot.evidence.reason === 'invalid_canonical_identity') {
      return unavailable('identity_mismatch');
    }
    return unavailable(snapshot.status === 'missing' ? 'record_missing'
      : snapshot.status === 'busy' ? 'record_busy' : 'record_corrupt');
  }
  if (snapshot.record.id !== runId) return unavailable('identity_mismatch');
  let status: WorkflowRunStatusProjection['status'];
  switch (snapshot.record.status) {
    case 'running': case 'queued': status = 'active'; break;
    case 'parked': case 'paused': case 'held':
    case 'awaiting_input': case 'awaiting_approval': case 'awaiting_catchup_decision':
    case 'blocked_capability': case 'blocked_mutation': status = 'paused'; break;
    case 'completed': status = 'completed'; break;
    case 'error': case 'failed': case 'blocked': case 'completed_with_errors': status = 'failed'; break;
    case 'cancelled': status = 'cancelled'; break;
    default: return unavailable('unrecognized_status');
  }
  return { status, runCoverage: { version: 1, kind: 'known_steps', state: 'available' } };
}

/** One memo per API request, with no global historical-event scan or record locks. */
export function createWorkflowRunStatusReader(runsDirectory = WORKFLOW_RUNS_DIR): (runId: string) => WorkflowRunStatusProjection {
  const memo = new Map<string, WorkflowRunStatusProjection>();
  return (runId) => {
    let result = memo.get(runId);
    if (!result) { result = readExactRunStatus(runId, runsDirectory); memo.set(runId, result); }
    return { ...result, runCoverage: { ...result.runCoverage } };
  };
}
