import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { addNotification } from '../runtime/notifications.js';
import { finishRun, getRun } from '../runtime/run-events.js';
import {
  persistWorkflowRunRecordQuarantine,
  scanWorkflowRunRecordSnapshot,
  type WorkflowRunRecordCorruptionEvidence,
  type WorkflowRunRecordQuarantineMarkerV1,
} from './workflow-run-record.js';

export interface WorkflowRunCorruptionReconcileResult {
  scanned: number;
  healthy: number;
  missing: number;
  busy: number;
  corrupt: number;
  blocked: number;
  failed: number;
}

function trustedRunIdFromFileName(fileName: string): string | null {
  if (!fileName.endsWith('.json')) return null;
  const runId = fileName.slice(0, -'.json'.length);
  if (!runId || runId !== runId.replace(/[^a-zA-Z0-9_.:-]/g, '')) return null;
  return runId;
}

function corruptionReasonLabel(reason: WorkflowRunRecordCorruptionEvidence['reason']): string {
  switch (reason) {
    case 'invalid_json': return 'its JSON is unreadable';
    case 'not_json_object': return 'its JSON root is not an object';
    case 'invalid_canonical_identity': return 'its canonical run identity is missing or contradictory';
  }
}

function recoveryBody(marker: WorkflowRunRecordQuarantineMarkerV1): string {
  return [
    `Clementine blocked ${marker.fileName} because ${corruptionReasonLabel(marker.reason)}.`,
    'The recovery path dispatched no new workflow step, model, provider, or tool from this corrupt generation. The original bytes were preserved unchanged.',
    'Replace this exact record from a known-good source, or archive it after reviewing the quarantine fingerprint. Clementine will resume only after a separately written record passes the canonical validator.',
    `Quarantine fingerprint: ${marker.corruptionId.slice(0, 16)}.`,
  ].join('\n\n');
}

function surfaceQuarantinedWorkflowRun(
  marker: WorkflowRunRecordQuarantineMarkerV1,
): void {
  const body = recoveryBody(marker);
  // Stable content-addressed id: boot, drain, and watchdog can all replay this
  // outbox safely. addNotification repairs a partial queue admission and
  // otherwise dedupes it to one user-visible card.
  addNotification({
    id: `workflow-run-record-corrupt-${marker.corruptionId}`,
    kind: 'workflow',
    title: `Workflow run blocked — ${marker.fileName} needs repair`,
    body,
    createdAt: marker.detectedAt,
    read: false,
    metadata: {
      needsAttention: true,
      errorCategory: 'workflow_run_record_corrupt',
      quarantineId: marker.corruptionId,
      recordFile: marker.fileName,
      recordPathDigest: marker.pathDigest,
      contentDigest: marker.contentDigest,
      byteLength: marker.byteLength,
      reason: marker.reason,
      provenNoDispatch: true,
      recommendedRecovery: {
        action: 'open_tasks',
        label: 'Open Tasks',
        detail: 'Restore this exact run record from known-good durable state, or archive it after review.',
        href: '/tasks',
      },
    },
  });

  // A running workflow normally already owns one Activity record. Close that
  // existing projection exactly once when its id is trustworthy from the
  // canonical filename; never manufacture workflow identity from corrupt JSON.
  const runId = trustedRunIdFromFileName(marker.fileName);
  if (!runId) return;
  const activity = getRun(runId);
  if (!activity || (activity.source !== 'workflow' && activity.sessionId !== `workflow:${runId}`)) return;
  const error = `workflow_run_record_corrupt:${marker.corruptionId}`;
  if (
    activity.status === 'blocked'
    && activity.needsAttention === true
    && activity.error === error
  ) return;
  finishRun(runId, {
    status: 'blocked',
    message: 'Workflow recovery blocked further admission because its durable run record is corrupt.',
    outputPreview: body,
    error,
    needsAttention: true,
  });
}

export type WorkflowRunCorruptionSurfaceResult =
  | { status: 'blocked'; marker: WorkflowRunRecordQuarantineMarkerV1 }
  | { status: 'retry' };

/**
 * Convert one exact corrupt generation into durable blocked truth, then replay
 * its stable presentation outbox. The marker must commit before visibility;
 * if either the record changed or the marker store is unavailable, this tick
 * remains a zero-dispatch retry.
 */
export function reconcileCorruptWorkflowRunRecord(
  filePath: string,
  evidence: WorkflowRunRecordCorruptionEvidence,
  detectedAt?: string,
): WorkflowRunCorruptionSurfaceResult {
  const marker = persistWorkflowRunRecordQuarantine(filePath, evidence, detectedAt);
  if (!marker) return { status: 'retry' };
  surfaceQuarantinedWorkflowRun(marker);
  return { status: 'blocked', marker };
}

/** Boot/tick recovery sweep. It has no provider/model/tool dependency. */
export function reconcileCorruptWorkflowRunRecords(
  runsDirectory = WORKFLOW_RUNS_DIR,
  detectedAt?: string,
): WorkflowRunCorruptionReconcileResult {
  const result: WorkflowRunCorruptionReconcileResult = {
    scanned: 0,
    healthy: 0,
    missing: 0,
    busy: 0,
    corrupt: 0,
    blocked: 0,
    failed: 0,
  };
  if (!existsSync(runsDirectory)) return result;
  for (const file of readdirSync(runsDirectory).filter((entry) => entry.endsWith('.json')).sort()) {
    result.scanned += 1;
    const filePath = path.join(runsDirectory, file);
    const scan = scanWorkflowRunRecordSnapshot<Record<string, unknown>>(filePath);
    if (scan.status === 'ok') {
      result.healthy += 1;
      continue;
    }
    if (scan.status === 'missing') {
      result.missing += 1;
      continue;
    }
    if (scan.status === 'busy') {
      result.busy += 1;
      continue;
    }
    result.corrupt += 1;
    try {
      const surfaced = reconcileCorruptWorkflowRunRecord(filePath, scan.evidence, detectedAt);
      if (surfaced.status === 'blocked') result.blocked += 1;
      else result.failed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
