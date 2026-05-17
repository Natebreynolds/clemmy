import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import type { PendingApproval } from '../types.js';
import { actionBus } from './action-bus.js';

function emitIfResolved(previous: PendingApproval | undefined, next: PendingApproval): void {
  // `pending → approved` and `pending → rejected` are the transitions
  // the dashboard cares about; status reaffirmations (pending → pending)
  // shouldn't generate a notification.
  if (!previous || previous.status === next.status) return;
  if (next.status === 'approved' || next.status === 'rejected') {
    actionBus.emit({ kind: 'approval.resolved', approval: next, resolution: next.status });
  }
}

const STATE_DIR = path.join(BASE_DIR, 'state');
const APPROVAL_FILE = path.join(STATE_DIR, 'approvals.json');

function ensureDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

function loadApprovals(): PendingApproval[] {
  ensureDir();
  if (!existsSync(APPROVAL_FILE)) return [];
  try {
    return JSON.parse(readFileSync(APPROVAL_FILE, 'utf-8')) as PendingApproval[];
  } catch {
    return [];
  }
}

function saveApprovals(items: PendingApproval[]): void {
  ensureDir();
  writeFileSync(APPROVAL_FILE, JSON.stringify(items, null, 2));
}

export class ApprovalStore {
  listPending(): PendingApproval[] {
    return loadApprovals().filter((item) => item.status === 'pending');
  }

  get(id: string): PendingApproval | undefined {
    return loadApprovals().find((item) => item.id === id);
  }

  add(item: PendingApproval): void {
    const approvals = loadApprovals();
    approvals.push(item);
    saveApprovals(approvals);
    if (item.status === 'pending') {
      actionBus.emit({ kind: 'approval.created', approval: item });
    }
  }

  replace(item: PendingApproval): void {
    const approvals = loadApprovals();
    const index = approvals.findIndex((entry) => entry.id === item.id);
    const previous = index >= 0 ? approvals[index] : undefined;
    if (index >= 0) {
      approvals[index] = item;
    } else {
      approvals.push(item);
    }
    saveApprovals(approvals);
    if (!previous && item.status === 'pending') {
      actionBus.emit({ kind: 'approval.created', approval: item });
    } else {
      emitIfResolved(previous, item);
    }
  }

  updateStatus(id: string, status: PendingApproval['status'], state?: string): PendingApproval | undefined {
    const approvals = loadApprovals();
    const approval = approvals.find((item) => item.id === id);
    if (!approval) return undefined;
    const previous = { ...approval };
    approval.status = status;
    if (state !== undefined) {
      approval.state = state;
    }
    saveApprovals(approvals);
    emitIfResolved(previous, approval);
    return approval;
  }
}

/**
 * Force-reject approvals that have been sitting `pending` longer than
 * `staleAfterMs`. The original run is long gone (timed out, cancelled,
 * or replaced by a follow-up message) so the approval has nothing left
 * to gate — but the dashboard still surfaces it as "needs you" forever.
 * We rewrite the status to `rejected` so the queue clears.
 *
 * Default threshold: 24 hours. Conservative — interactive approvals
 * usually resolve in minutes, so anything older than a day is dead.
 */
export function sweepStaleApprovals(staleAfterMs = 24 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - staleAfterMs;
  const approvals = loadApprovals();
  let swept = 0;
  for (const approval of approvals) {
    if (approval.status !== 'pending') continue;
    const created = Date.parse(approval.createdAt);
    if (Number.isFinite(created) && created > cutoff) continue;
    approval.status = 'rejected';
    swept += 1;
  }
  if (swept > 0) saveApprovals(approvals);
  return swept;
}
