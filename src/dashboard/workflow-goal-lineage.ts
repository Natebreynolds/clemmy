import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readWorkflowEvents } from '../execution/workflow-events.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { buildWorkflowRunGraphOverlay, type WorkflowRunGoalLineageEntry } from './workflow-run-overlay.js';

interface StoredWorkflowRunRecord {
  id?: unknown;
  workflow?: unknown;
  status?: unknown;
  createdAt?: unknown;
  finishedAt?: unknown;
  requeuedFromRunId?: unknown;
  goalAttempt?: unknown;
}

function readWorkflowRunRecords(workflowSlug: string, workflowName: string): StoredWorkflowRunRecord[] {
  let files: string[] = [];
  try {
    files = readdirSync(WORKFLOW_RUNS_DIR).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  const records: StoredWorkflowRunRecord[] = [];
  for (const file of files) {
    try {
      const record = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as StoredWorkflowRunRecord;
      if (record.workflow === workflowName || record.workflow === workflowSlug) records.push(record);
    } catch {
      // Ignore corrupt run records in a diagnostic read model.
    }
  }
  return records;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function sortRecords(a: StoredWorkflowRunRecord, b: StoredWorkflowRunRecord): number {
  return (stringValue(a.createdAt) ?? '').localeCompare(stringValue(b.createdAt) ?? '')
    || (stringValue(a.id) ?? '').localeCompare(stringValue(b.id) ?? '');
}

function connectedRunIds(records: StoredWorkflowRunRecord[], currentRunId: string): string[] {
  const byId = new Map<string, StoredWorkflowRunRecord>();
  const children = new Map<string, StoredWorkflowRunRecord[]>();
  for (const record of records) {
    const id = stringValue(record.id);
    if (!id) continue;
    byId.set(id, record);
    const source = stringValue(record.requeuedFromRunId);
    if (source) {
      const list = children.get(source) ?? [];
      list.push(record);
      children.set(source, list);
    }
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  let cursor = currentRunId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    ids.unshift(cursor);
    const source = stringValue(byId.get(cursor)?.requeuedFromRunId);
    if (!source) break;
    cursor = source;
  }

  cursor = currentRunId;
  while (cursor && !seen.has(`child:${cursor}`)) {
    seen.add(`child:${cursor}`);
    const next = (children.get(cursor) ?? []).slice().sort(sortRecords)[0];
    const nextId = stringValue(next?.id);
    if (!nextId || ids.includes(nextId)) break;
    ids.push(nextId);
    cursor = nextId;
  }

  return ids;
}

export function buildWorkflowGoalLineage(
  workflowSlug: string,
  workflowName: string,
  currentRunId: string,
  stepIds: readonly string[],
): WorkflowRunGoalLineageEntry[] {
  const records = readWorkflowRunRecords(workflowSlug, workflowName);
  const ids = connectedRunIds(records, currentRunId);
  if (ids.length === 0) return [];
  const byId = new Map(records.map((record) => [stringValue(record.id), record] as const));
  return ids.map((runId) => {
    const record = byId.get(runId);
    const overlay = buildWorkflowRunGraphOverlay(readWorkflowEvents(workflowSlug, runId), { stepIds });
    const goal = overlay.goal;
    const recordGoalAttempt = numberValue(record?.goalAttempt);
    return {
      runId,
      sourceRunId: stringValue(record?.requeuedFromRunId),
      createdAt: stringValue(record?.createdAt),
      finishedAt: stringValue(record?.finishedAt),
      status: stringValue(record?.status),
      goalStatus: goal?.status && goal.status !== 'unknown' ? goal.status : null,
      reason: goal?.reason,
      attempt: goal?.attempt ?? (recordGoalAttempt != null ? recordGoalAttempt + 1 : undefined),
      maxAttempts: goal?.maxAttempts,
      successRatePercent: goal?.successRatePercent,
      criteriaMet: goal?.criteriaMet,
      criteriaTotal: goal?.criteriaTotal,
      requeueRunId: goal?.requeueRunId,
      isCurrent: runId === currentRunId,
    };
  });
}
