import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import type { WorkflowRunRecoveryLineageEntry } from './workflow-run-overlay.js';

interface StoredWorkflowRunRecord {
  id?: unknown;
  workflow?: unknown;
  status?: unknown;
  createdAt?: unknown;
  finishedAt?: unknown;
  requeuedFromRunId?: unknown;
  retryFailedItemsFromRunId?: unknown;
  retryFailedItemsStepId?: unknown;
  targetStepId?: unknown;
  selfHealAttempt?: unknown;
  recoveryIntent?: unknown;
}

interface StoredRecoveryIntent {
  kind?: unknown;
  createdAt?: unknown;
  sourceRunId?: unknown;
  sourceStepId?: unknown;
  requestedFrom?: unknown;
  reason?: unknown;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function recoveryIntent(record: StoredWorkflowRunRecord | undefined): StoredRecoveryIntent {
  const value = record?.recoveryIntent;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as StoredRecoveryIntent
    : {};
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
      // Ignore corrupt run records in this diagnostic read model.
    }
  }
  return records;
}

function sortRecords(a: StoredWorkflowRunRecord, b: StoredWorkflowRunRecord): number {
  return (stringValue(a.createdAt) ?? '').localeCompare(stringValue(b.createdAt) ?? '')
    || (stringValue(a.id) ?? '').localeCompare(stringValue(b.id) ?? '');
}

function recoverySourceRunId(record: StoredWorkflowRunRecord | undefined): string | undefined {
  const intent = recoveryIntent(record);
  return stringValue(intent.sourceRunId)
    ?? stringValue(record?.requeuedFromRunId)
    ?? stringValue(record?.retryFailedItemsFromRunId);
}

function recoverySourceStepId(record: StoredWorkflowRunRecord | undefined): string | undefined {
  const intent = recoveryIntent(record);
  return stringValue(intent.sourceStepId)
    ?? stringValue(record?.retryFailedItemsStepId)
    ?? stringValue(record?.targetStepId);
}

function recoveryKind(record: StoredWorkflowRunRecord | undefined): string | undefined {
  const intent = recoveryIntent(record);
  const explicit = stringValue(intent.kind);
  if (explicit) return explicit;
  if (stringValue(record?.retryFailedItemsFromRunId)) return 'failed_items';
  if (numberValue(record?.selfHealAttempt)) return 'self_heal';
  if (stringValue(record?.requeuedFromRunId)) return 'manual_requeue';
  if (stringValue(record?.targetStepId)) return 'step_try';
  return undefined;
}

function recoveryRequestedFrom(record: StoredWorkflowRunRecord | undefined): string | undefined {
  return stringValue(recoveryIntent(record).requestedFrom);
}

function recoveryReason(record: StoredWorkflowRunRecord | undefined): string | undefined {
  return stringValue(recoveryIntent(record).reason);
}

function addId(ids: string[], seen: Set<string>, id: string | undefined): boolean {
  if (!id || seen.has(id)) return false;
  seen.add(id);
  ids.push(id);
  return true;
}

function connectedRecoveryRunIds(records: StoredWorkflowRunRecord[], currentRunId: string): string[] {
  const byId = new Map<string, StoredWorkflowRunRecord>();
  const children = new Map<string, StoredWorkflowRunRecord[]>();
  for (const record of records) {
    const id = stringValue(record.id);
    if (!id) continue;
    byId.set(id, record);
    const source = recoverySourceRunId(record);
    if (source) {
      const list = children.get(source) ?? [];
      list.push(record);
      children.set(source, list);
    }
  }

  const ancestors: string[] = [];
  const ancestorSeen = new Set<string>();
  let cursor: string | undefined = currentRunId;
  while (cursor && !ancestorSeen.has(cursor)) {
    ancestorSeen.add(cursor);
    ancestors.unshift(cursor);
    const source = recoverySourceRunId(byId.get(cursor));
    if (!source) break;
    cursor = source;
    if (!byId.has(cursor)) {
      ancestors.unshift(cursor);
      break;
    }
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of ancestors) addId(ids, seen, id);

  const queue = [...ids];
  while (queue.length > 0 && ids.length < 30) {
    const parent = queue.shift();
    for (const child of (children.get(parent ?? '') ?? []).slice().sort(sortRecords)) {
      const childId = stringValue(child.id);
      if (addId(ids, seen, childId)) queue.push(childId!);
      if (ids.length >= 30) break;
    }
  }

  return ids;
}

function hasRecoveryEvidence(record: StoredWorkflowRunRecord | undefined): boolean {
  return Boolean(
    recoveryKind(record)
    || recoverySourceRunId(record)
    || recoverySourceStepId(record),
  );
}

export function buildWorkflowRecoveryLineage(
  workflowSlug: string,
  workflowName: string,
  currentRunId: string,
): WorkflowRunRecoveryLineageEntry[] {
  const records = readWorkflowRunRecords(workflowSlug, workflowName);
  const byId = new Map(records.map((record) => [stringValue(record.id), record] as const));
  const ids = connectedRecoveryRunIds(records, currentRunId);
  const currentRecord = byId.get(currentRunId);
  if (ids.length <= 1 && !hasRecoveryEvidence(currentRecord)) return [];

  return ids.map((runId) => {
    const record = byId.get(runId);
    return {
      runId,
      ...(recoverySourceRunId(record) ? { sourceRunId: recoverySourceRunId(record)! } : {}),
      ...(recoverySourceStepId(record) ? { sourceStepId: recoverySourceStepId(record)! } : {}),
      ...(stringValue(record?.createdAt) ? { createdAt: stringValue(record?.createdAt)! } : {}),
      ...(stringValue(record?.finishedAt) ? { finishedAt: stringValue(record?.finishedAt)! } : {}),
      ...(stringValue(record?.status) ? { status: stringValue(record?.status)! } : {}),
      ...(recoveryKind(record) ? { kind: recoveryKind(record)! } : {}),
      ...(recoveryRequestedFrom(record) ? { requestedFrom: recoveryRequestedFrom(record)! } : {}),
      ...(recoveryReason(record) ? { reason: recoveryReason(record)! } : {}),
      ...(!record ? { sourceMissing: true } : {}),
      isCurrent: runId === currentRunId,
    };
  });
}
