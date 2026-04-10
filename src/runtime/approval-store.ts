import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import type { PendingApproval } from '../types.js';

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
  }

  replace(item: PendingApproval): void {
    const approvals = loadApprovals();
    const index = approvals.findIndex((entry) => entry.id === item.id);
    if (index >= 0) {
      approvals[index] = item;
    } else {
      approvals.push(item);
    }
    saveApprovals(approvals);
  }

  updateStatus(id: string, status: PendingApproval['status'], state?: string): PendingApproval | undefined {
    const approvals = loadApprovals();
    const approval = approvals.find((item) => item.id === id);
    if (!approval) return undefined;
    approval.status = status;
    if (state !== undefined) {
      approval.state = state;
    }
    saveApprovals(approvals);
    return approval;
  }
}
