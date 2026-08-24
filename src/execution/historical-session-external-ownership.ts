import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { scanWorkflowRunRecordSnapshot } from './workflow-run-record.js';

export type HistoricalSessionExternalOwnership =
  | { status: 'clear' }
  | { status: 'owned'; ownerKind: 'background_task' | 'workflow_run'; ownerId: string }
  | { status: 'unknown'; reason: string };

export interface HistoricalSessionExternalOwnershipOptions {
  backgroundTaskDir?: string;
  workflowRunsDir?: string;
  maxFilesPerStore?: number;
}

const BACKGROUND_TERMINAL = new Set(['done', 'blocked', 'failed', 'aborted', 'cancelled']);
const WORKFLOW_TERMINAL = new Set([
  'completed',
  'completed_with_errors',
  'blocked',
  'error',
  'failed',
  'cancelled',
]);

function boundedReason(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function jsonFiles(directory: string, cap: number): string[] | HistoricalSessionExternalOwnership {
  let entries: string[];
  try {
    entries = readdirSync(directory)
      .filter((entry) => entry.endsWith('.json'))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return { status: 'unknown', reason: `external owner directory read failed: ${boundedReason(error)}` };
  }
  if (entries.length > cap) {
    return { status: 'unknown', reason: `external owner inventory exceeds bounded cap ${cap}` };
  }
  return entries.map((entry) => path.join(directory, entry));
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function inspectBackgroundTasks(
  sessionId: string,
  directory: string,
  cap: number,
): HistoricalSessionExternalOwnership {
  const inventory = jsonFiles(directory, cap);
  if (!Array.isArray(inventory)) return inventory;
  for (const filePath of inventory) {
    let record: Record<string, unknown> | null = null;
    try {
      record = plainRecord(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);
    } catch (error) {
      return { status: 'unknown', reason: `background owner read failed: ${boundedReason(error)}` };
    }
    const fileId = path.basename(filePath, '.json');
    if (
      !record
      || typeof record.id !== 'string'
      || record.id !== fileId
      || typeof record.status !== 'string'
      || (record.originSessionId !== undefined && typeof record.originSessionId !== 'string')
      || (record.runSessionId !== undefined && typeof record.runSessionId !== 'string')
    ) return { status: 'unknown', reason: `background owner record ${fileId} is malformed` };
    if (record.originSessionId !== sessionId && record.runSessionId !== sessionId) continue;
    if (!BACKGROUND_TERMINAL.has(record.status)) {
      return { status: 'owned', ownerKind: 'background_task', ownerId: record.id };
    }
  }
  return { status: 'clear' };
}

function workflowIsTerminal(record: Record<string, unknown>): boolean {
  if (typeof record.status === 'string' && WORKFLOW_TERMINAL.has(record.status)) return true;
  return (record.status === 'dry_run' || record.status === 'creation_test')
    && typeof record.finishedAt === 'string';
}

function inspectWorkflowRuns(
  sessionId: string,
  directory: string,
  cap: number,
): HistoricalSessionExternalOwnership {
  const inventory = jsonFiles(directory, cap);
  if (!Array.isArray(inventory)) return inventory;
  for (const filePath of inventory) {
    // The ownership proof itself is read-only. A present writer lock is not a
    // reason to reclaim or wait; it is durable ambiguity, so retain the blob.
    let writerLockPresent = false;
    try {
      statSync(`${filePath}.record-lock`);
      writerLockPresent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { status: 'unknown', reason: `workflow owner ${path.basename(filePath)} lock is unreadable` };
      }
    }
    if (writerLockPresent) {
      return { status: 'unknown', reason: `workflow owner ${path.basename(filePath)} is busy` };
    }
    const scan = scanWorkflowRunRecordSnapshot<Record<string, unknown>>(filePath);
    if (scan.status !== 'ok') {
      return { status: 'unknown', reason: `workflow owner ${path.basename(filePath)} is ${scan.status}` };
    }
    const record = scan.record;
    if (
      (record.originSessionId !== undefined && typeof record.originSessionId !== 'string')
      || (record.originSessionIds !== undefined && (
        !Array.isArray(record.originSessionIds)
        || record.originSessionIds.some((entry) => typeof entry !== 'string')
      ))
      || (record.status !== undefined && typeof record.status !== 'string')
    ) return { status: 'unknown', reason: `workflow owner ${record.id} has malformed lineage` };
    const origins = new Set<string>([`workflow:${String(record.id)}`]);
    if (typeof record.originSessionId === 'string') origins.add(record.originSessionId);
    if (Array.isArray(record.originSessionIds)) {
      for (const origin of record.originSessionIds) origins.add(origin as string);
    }
    if (!origins.has(sessionId)) continue;
    if (!workflowIsTerminal(record)) {
      return {
        status: 'owned',
        ownerKind: 'workflow_run',
        ownerId: String(record.id),
      };
    }
  }
  return { status: 'clear' };
}

/**
 * Strict, synchronous boot proof. It does not claim, repair, quarantine, or
 * execute an owner. An unreadable generation retains the interrupt blob.
 */
export function inspectHistoricalSessionExternalOwnership(
  sessionId: string,
  options: HistoricalSessionExternalOwnershipOptions = {},
): HistoricalSessionExternalOwnership {
  const cap = Number.isSafeInteger(options.maxFilesPerStore)
    ? Math.max(1, Math.min(options.maxFilesPerStore!, 16_384))
    : 4_096;
  const background = inspectBackgroundTasks(
    sessionId,
    options.backgroundTaskDir ?? path.join(BASE_DIR, 'state', 'background-tasks'),
    cap,
  );
  if (background.status !== 'clear') return background;
  return inspectWorkflowRuns(sessionId, options.workflowRunsDir ?? WORKFLOW_RUNS_DIR, cap);
}
