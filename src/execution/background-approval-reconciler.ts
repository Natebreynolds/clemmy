import pino from 'pino';
import { ApprovalStore } from '../runtime/approval-store.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import type { PendingApproval } from '../types.js';
import {
  listBackgroundTasks,
  markBackgroundTaskApprovalBindingBlocked,
  queueBackgroundTaskApprovalResolution,
  type BackgroundTaskRecord,
} from './background-tasks.js';

const logger = pino({ name: 'clementine-next.background-approval-reconciler' });

type CanonicalApprovalRow = approvalRegistry.PendingApprovalRow;

interface BackgroundApprovalReconcilerDependencies {
  listAwaitingTasks(): BackgroundTaskRecord[];
  getCanonicalApproval(approvalId: string): CanonicalApprovalRow | undefined;
  getLegacyApproval(approvalId: string): PendingApproval | undefined;
  queueDecision(approvalId: string, approved: boolean): BackgroundTaskRecord | null;
  blockBinding(input: Parameters<typeof markBackgroundTaskApprovalBindingBlocked>[0]): BackgroundTaskRecord | null;
}

const defaultDependencies: BackgroundApprovalReconcilerDependencies = {
  listAwaitingTasks: () => listBackgroundTasks({ status: 'awaiting_approval' }),
  getCanonicalApproval: (approvalId) => approvalRegistry.get(approvalId),
  getLegacyApproval: (approvalId) => new ApprovalStore().get(approvalId),
  queueDecision: (approvalId, approved) => queueBackgroundTaskApprovalResolution(approvalId, approved),
  blockBinding: (input) => markBackgroundTaskApprovalBindingBlocked(input),
};

export interface BackgroundApprovalReconcileResult {
  scanned: number;
  pending: number;
  legacyPending: number;
  queuedApproved: number;
  queuedRejected: number;
  blockedMissing: number;
  blockedMismatch: number;
  blockedAmbiguous: number;
  blockedInvalid: number;
  raced: number;
  failed: number;
}

function emptyResult(): BackgroundApprovalReconcileResult {
  return {
    scanned: 0,
    pending: 0,
    legacyPending: 0,
    queuedApproved: 0,
    queuedRejected: 0,
    blockedMissing: 0,
    blockedMismatch: 0,
    blockedAmbiguous: 0,
    blockedInvalid: 0,
    raced: 0,
    failed: 0,
  };
}

type CanonicalDecision =
  | { kind: 'pending' }
  | { kind: 'queue'; approved: boolean }
  | { kind: 'invalid'; detail: string };

function canonicalDecision(row: CanonicalApprovalRow): CanonicalDecision {
  if (row.status === 'pending') {
    const requestedAt = Date.parse(row.requestedAt);
    const expiresAt = Date.parse(row.expiresAt);
    if (!Number.isFinite(requestedAt) || !Number.isFinite(expiresAt) || expiresAt < requestedAt) {
      return {
        kind: 'invalid',
        detail: `Approval ${row.approvalId} has an invalid pending lifetime. This task was blocked without dispatch.`,
      };
    }
    return { kind: 'pending' };
  }

  if (row.status === 'resolved' && row.resolution === 'approved') {
    if (!approvalRegistry.approvalResolutionWithinLifetime(row)) {
      return {
        kind: 'invalid',
        detail: `Approval ${row.approvalId} says approved, but its decision is outside the exact card lifetime. No action was dispatched.`,
      };
    }
    if (row.consumedAt) {
      return {
        kind: 'invalid',
        detail: `Approval ${row.approvalId} was already consumed by another continuation. This task was blocked to prevent a duplicate action.`,
      };
    }
    return { kind: 'queue', approved: true };
  }

  if (
    (row.status === 'resolved' && (
      row.resolution === 'rejected'
      || row.resolution === 'cancelled_by_user'
      || row.resolution === 'cancelled_by_system'
    ))
    || (row.status === 'expired' && row.resolution === 'expired')
    || (row.status === 'cancelled' && (
      row.resolution === 'cancelled_by_user'
      || row.resolution === 'cancelled_by_system'
    ))
  ) {
    return { kind: 'queue', approved: false };
  }

  return {
    kind: 'invalid',
    detail: `Approval ${row.approvalId} has contradictory terminal state (${row.status}/${row.resolution ?? 'none'}). This task was blocked without dispatch.`,
  };
}

function blockTask(
  dependencies: BackgroundApprovalReconcilerDependencies,
  task: BackgroundTaskRecord,
  code: Parameters<typeof markBackgroundTaskApprovalBindingBlocked>[0]['code'],
  detail: string,
): boolean {
  return Boolean(dependencies.blockBinding({
    taskId: task.id,
    approvalId: task.pendingApprovalId ?? null,
    code,
    detail,
  }));
}

function exactAwaitingOwners(
  dependencies: BackgroundApprovalReconcilerDependencies,
  approvalId: string,
): BackgroundTaskRecord[] {
  return dependencies.listAwaitingTasks()
    .filter((task) => task.pendingApprovalId === approvalId);
}

/**
 * Reconcile durable background-task parking from the two approval stores.
 *
 * SQLite is canonical for harness approvals. The file-backed lookup exists only
 * so upgraded native-runtime tasks are not misclassified as missing. Missing,
 * contradictory, or multiply-bound authority blocks visibly; it never guesses a
 * decision. Storage exceptions leave the task parked for the next boot/tick.
 */
export function reconcileBackgroundTaskApprovals(
  input: { approvalId?: string; limit?: number } = {},
  dependencies: BackgroundApprovalReconcilerDependencies = defaultDependencies,
): BackgroundApprovalReconcileResult {
  const result = emptyResult();
  const limit = Math.max(1, Math.min(1_000, Math.trunc(input.limit ?? 200)));
  let candidates: BackgroundTaskRecord[];
  try {
    candidates = dependencies.listAwaitingTasks()
      .filter((task) => !input.approvalId || task.pendingApprovalId === input.approvalId)
      .slice(0, limit);
  } catch {
    result.failed += 1;
    return result;
  }

  result.scanned = candidates.length;
  const missingIds = candidates.filter((task) => !task.pendingApprovalId);
  for (const task of missingIds) {
    if (blockTask(
      dependencies,
      task,
      'approval_registry_missing',
      'This task says it is awaiting approval, but it has no exact approval id. No action was dispatched.',
    )) result.blockedMissing += 1;
    else result.raced += 1;
  }

  const byApprovalId = new Map<string, BackgroundTaskRecord[]>();
  for (const task of candidates) {
    const approvalId = task.pendingApprovalId;
    if (!approvalId) continue;
    const group = byApprovalId.get(approvalId) ?? [];
    group.push(task);
    byApprovalId.set(approvalId, group);
  }

  for (const [approvalId, initialOwners] of byApprovalId) {
    let canonical: CanonicalApprovalRow | undefined;
    let legacy: PendingApproval | undefined;
    try {
      canonical = dependencies.getCanonicalApproval(approvalId);
      if (!canonical) legacy = dependencies.getLegacyApproval(approvalId);
    } catch {
      // A transient registry failure cannot be translated into user rejection.
      // Leave every exact task parked and retry on the next boot/tick.
      result.failed += initialOwners.length;
      continue;
    }

    const authoritySessionId = canonical?.sessionId ?? legacy?.sessionId;
    if (!canonical && !legacy) {
      for (const task of initialOwners) {
        if (blockTask(
          dependencies,
          task,
          'approval_registry_missing',
          `Approval ${approvalId} is absent from both durable approval stores. No decision or action was inferred.`,
        )) result.blockedMissing += 1;
        else result.raced += 1;
      }
      continue;
    }

    const matchingOwners = initialOwners.filter((task) => task.runSessionId === authoritySessionId);
    if (matchingOwners.length !== 1) {
      for (const task of initialOwners) {
        const matches = task.runSessionId === authoritySessionId;
        if (blockTask(
          dependencies,
          task,
          matches ? 'approval_binding_ambiguous' : 'approval_binding_mismatch',
          matches
            ? `Approval ${approvalId} is bound to more than one waiting task in session ${authoritySessionId}. No action was dispatched.`
            : `Approval ${approvalId} belongs to session ${authoritySessionId}, not task session ${task.runSessionId}. No action was dispatched.`,
        )) {
          if (matches) result.blockedAmbiguous += 1;
          else result.blockedMismatch += 1;
        } else result.raced += 1;
      }
      continue;
    }

    const exactOwner = matchingOwners[0];
    for (const task of initialOwners) {
      if (task.id === exactOwner.id) continue;
      if (blockTask(
        dependencies,
        task,
        'approval_binding_mismatch',
        `Approval ${approvalId} belongs to task session ${exactOwner.runSessionId}, not task session ${task.runSessionId}. No action was dispatched.`,
      )) result.blockedMismatch += 1;
      else result.raced += 1;
    }

    if (legacy) {
      if (legacy.status === 'pending') {
        result.legacyPending += 1;
        continue;
      }
      if (legacy.status === 'approved') {
        if (blockTask(
          dependencies,
          exactOwner,
          'approval_decision_invalid',
          `Legacy approval ${approvalId} says approved, but that store has no exact decision lifetime or one-shot consumption proof. This task was blocked without dispatch; restart it to request a fresh approval.`,
        )) result.blockedInvalid += 1;
        else result.raced += 1;
        continue;
      }
      const owners = exactAwaitingOwners(dependencies, approvalId);
      if (owners.length !== 1 || owners[0]?.id !== exactOwner.id) {
        if (blockTask(
          dependencies,
          exactOwner,
          'approval_binding_ambiguous',
          `Approval ${approvalId} no longer has one exact waiting task. No action was dispatched.`,
        )) result.blockedAmbiguous += 1;
        else result.raced += 1;
        continue;
      }
      const queued = dependencies.queueDecision(approvalId, false);
      if (queued?.id === exactOwner.id) {
        result.queuedRejected += 1;
      } else result.raced += 1;
      continue;
    }

    const decision = canonicalDecision(canonical!);
    if (decision.kind === 'pending') {
      result.pending += 1;
      continue;
    }
    if (decision.kind === 'invalid') {
      if (blockTask(
        dependencies,
        exactOwner,
        'approval_decision_invalid',
        decision.detail,
      )) result.blockedInvalid += 1;
      else result.raced += 1;
      continue;
    }

    // Re-read after mismatch repair. queueBackgroundTaskApprovalResolution uses
    // an exact awaiting+approval-id CAS, but its lookup is intentionally broad;
    // requiring one owner here keeps a corrupted duplicate from winning lookup.
    const owners = exactAwaitingOwners(dependencies, approvalId);
    if (owners.length !== 1 || owners[0]?.id !== exactOwner.id) {
      if (blockTask(
        dependencies,
        exactOwner,
        'approval_binding_ambiguous',
        `Approval ${approvalId} no longer has one exact waiting task. No action was dispatched.`,
      )) result.blockedAmbiguous += 1;
      else result.raced += 1;
      continue;
    }
    const queued = dependencies.queueDecision(approvalId, decision.approved);
    if (queued?.id === exactOwner.id) {
      if (decision.approved) result.queuedApproved += 1;
      else result.queuedRejected += 1;
    } else result.raced += 1;
  }

  return result;
}

let listenerInstalled = false;

/** Live latency optimization. Boot and ordinary background ticks remain the
 * durable backstops for a crash before or during this listener. */
export function installBackgroundTaskApprovalReconciler(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  approvalRegistry.onApprovalResolved((row) => {
    const result = reconcileBackgroundTaskApprovals({ approvalId: row.approvalId, limit: 16 });
    if (result.failed > 0) {
      logger.warn({ approvalId: row.approvalId, result }, 'background approval listener will retry on the durable tick');
    }
  });
}

export const backgroundApprovalReconcilerInternalsForTest = {
  canonicalDecision,
};
