/**
 * Stop ONE durable chat attempt — the single Stop primitive every surface
 * shares.
 *
 * Extracted from the desktop console route so the mobile app can stop a live
 * turn at all. Before this, the phone's engine `stop()` was stream-detach only:
 * the screen went quiet and the backend kept burning — model calls, tool calls,
 * external writes — with no way to reach the kill latch from mobile. Stopping
 * work is not a desktop feature.
 *
 * Semantics shared by every Stop surface:
 *  - The kill latch is EXACT: it names the attempt and run id, so a stale
 *    button click can never widen into a session-wide kill.
 *  - Approval rows predate attempt ids, so only the session's currently-active
 *    attempt clears its time-bounded approvals/interrupt state; on a stale
 *    attempt the latch still lands and nothing else is touched.
 *  - Cascade: background tasks this session spawned (or that run AS it) die
 *    with the stop. Without this the task row kept polling "Working now" after
 *    the user explicitly stopped the chat that owned it (live 2026-07-08), and
 *    its external writes kept landing. Coding runs the chat dispatched stop
 *    the same way: the request lands in their store and the daemon that owns
 *    each agent ends it. Workflow children require the exact accepted source's
 *    durable group; shared physical occurrences need their explicit run Stop.
 */
import {
  getActiveRunAttempt,
  getKillRequest,
  getRunAttemptBySourceUserSeq,
  getRunAttemptSourceUserEvent,
  requestKill,
  type RunAttemptRef,
} from './eventlog.js';
import * as approvalRegistry from './approval-registry.js';
import { HarnessSession } from './session.js';
import { listBackgroundTasks, cancelBackgroundTask } from '../../execution/background-tasks.js';
import { requestCodingRunStopsForOrigin } from '../../execution/coding-run-store.js';
import { readPendingWorkflowChatDispatchOwnership } from '../../tools/workflow-run-queue.js';
import {
  createWorkflowChatDispatchPreparationAuthority,
  readActiveWorkflowOriginGroup,
  readWorkflowOriginGroup,
  readWorkflowRunChatDispatchPreparations,
  workflowOriginSourceGroupId,
} from '../../execution/workflow-origin-group.js';
import { cancelWorkflowRunAtBoundary, isTerminalWorkflowRunStatus } from '../../execution/workflow-run-cancellation.js';
import { readWorkflowRunRecordUnlocked } from '../../execution/workflow-run-record.js';
import { WORKFLOW_RUNS_DIR } from '../../tools/shared.js';
import type { ExactOriginDeliveryTarget } from '../exact-origin-delivery.js';
import { createHash } from 'node:crypto';
import { lstatSync, opendirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface ExactWorkflowStopReceipt {
  status: 'complete' | 'partial' | 'unavailable';
  matchedRunIds: string[];
  cancelledRunIds: string[];
  alreadyCancelledRunIds: string[];
  alreadyTerminalRunIds: string[];
  failures: Array<{ runId?: string; code: 'source_unbound' | 'ownership_unavailable' | 'shared_child_requires_exact_run_stop' | 'child_stop_failed' | 'membership_open' }>;
}

// This bounds observational qualification, never workflow admission. If the
// retained ownership set exceeds it, Stop stays partial and the existing exact
// physical-run control remains available. The budget spans all children.
const STOP_OWNERSHIP_READ_LIMIT = 10_000;
const STOP_OWNERSHIP_RECORD_MAX_BYTES = 64 * 1024;
type OwnershipReadBudget = { remaining: number };
function strictOwnershipEntries(dir: string, budget: OwnershipReadBudget, visit: (name: string) => void): void {
  let stat;
  try { stat = lstatSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid ownership directory');
  const handle = opendirSync(dir);
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (--budget.remaining < 0) throw new Error('ownership read allowance exhausted');
      visit(entry.name);
    }
  } finally { handle.closeSync(); }
}
function strictOwnershipRecord(dir: string, name: string): Record<string, unknown> {
  if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('unknown ownership entry');
  const file = path.join(dir, name), stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > STOP_OWNERSHIP_RECORD_MAX_BYTES) throw new Error('invalid ownership node');
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid ownership record');
  return value as Record<string, unknown>;
}
function exclusiveWorkflowObservers(
  runId: string, groupId: string, identity: { sessionId: string; sourceUserSeq: number }, budget: OwnershipReadBudget,
): boolean {
  const dir = path.join(WORKFLOW_RUNS_DIR, '.run-origins', createHash('sha256').update(runId).digest('hex'));
  let exclusive = true;
  strictOwnershipEntries(dir, budget, (name) => {
    const marker = strictOwnershipRecord(dir, name);
    if (marker.runId !== runId || (marker.version !== 1 && marker.version !== 2)) throw new Error('unknown observer authority');
    if (marker.version === 1 || marker.sourceGroupId !== groupId
      || marker.originSessionId !== identity.sessionId || marker.sourceUserSeq !== identity.sourceUserSeq) {
      exclusive = false; // private/foreign/legacy observers never disappear from negative proof
      return;
    }
    const sealed = readWorkflowOriginGroup(groupId);
    if (!sealed || name !== `${sealed.observerId.slice('workflow-origin-v2:'.length)}.json`
      || marker.observerId !== sealed.observerId || marker.sourceGroupDigest !== sealed.sourceGroupDigest
      || marker.replyTargetDigest !== sealed.replyTargetDigest
      || JSON.stringify(marker.replyTarget) !== JSON.stringify(sealed.replyTarget)
      || typeof marker.recordedAt !== 'string' || !Number.isFinite(Date.parse(marker.recordedAt))) {
      throw new Error('unproved observer authority');
    }
  });
  return exclusive;
}
/** Admissions precede per-run pins. Read every retained admission metadata
 * record before inferring that another accepted source does not share the run.
 * Unknown evidence or an exhausted allowance closes this negative proof. */
function exclusiveWorkflowAdmissions(runId: string, groupId: string, budget: OwnershipReadBudget): boolean {
  const root = path.join(WORKFLOW_RUNS_DIR, '.origin-groups');
  let exclusive = true;
  strictOwnershipEntries(root, budget, (groupName) => {
    if (!/^[a-f0-9]{64}$/.test(groupName)) throw new Error('unknown group ownership entry');
    const groupDir = path.join(root, groupName), stat = lstatSync(groupDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid group ownership directory');
    const dir = path.join(groupDir, 'admissions');
    strictOwnershipEntries(dir, budget, (name) => {
      const raw = strictOwnershipRecord(dir, name);
      if (typeof raw.runId !== 'string' || typeof raw.originSessionId !== 'string'
        || typeof raw.queueRequestDigest !== 'string' || !Number.isSafeInteger(raw.sourceUserSeq)
        || Number(raw.sourceUserSeq) <= 0) throw new Error('invalid admission ownership');
      const canonical = createWorkflowChatDispatchPreparationAuthority({ runId: raw.runId,
        queueRequestDigest: raw.queueRequestDigest, observer: { sessionId: raw.originSessionId,
          sourceUserSeq: Number(raw.sourceUserSeq), replyTarget: raw.replyTarget as ExactOriginDeliveryTarget } });
      for (const key of ['version', 'runId', 'sourceGroupId', 'observerId', 'originSessionId', 'sourceUserSeq',
        'replyTargetDigest', 'queueRequestDigest', 'preparationDigest'] as const) {
        if (raw[key] !== canonical[key]) throw new Error('unproved admission ownership');
      }
      if (name !== `${canonical.queueRequestDigest}.json`
        || groupName !== createHash('sha256').update(canonical.sourceGroupId).digest('hex')) throw new Error('misplaced admission ownership');
      if (canonical.runId === runId && canonical.sourceGroupId !== groupId) exclusive = false;
    });
  });
  return exclusive;
}

/** Stop only existing durable children of this accepted source. The run lock
 * serializes observer admission with cancellation through the existing API's
 * read-only precondition; compiled settlement stays outside that run lock. */
function stopExactWorkflowChildren(
  sessionId: string,
  attempt: RunAttemptRef,
  reason: string,
  resolver: string,
): ExactWorkflowStopReceipt | undefined {
  const receipt: ExactWorkflowStopReceipt = {
    status: 'complete', matchedRunIds: [], cancelledRunIds: [], alreadyCancelledRunIds: [],
    alreadyTerminalRunIds: [], failures: [],
  };
  let identity: { sessionId: string; sourceUserSeq: number };
  let groupId: string;
  try {
    const source = getRunAttemptSourceUserEvent(attempt);
    if (!source) return undefined; // legacy authority cannot mint a source pin
    identity = { sessionId, sourceUserSeq: source.seq };
    const owner = getRunAttemptBySourceUserSeq(sessionId, source.seq);
    if (!owner || owner.attemptId !== attempt.attemptId || owner.runId !== attempt.runId
      || source.sessionId !== sessionId || source.role !== 'user' || source.data.synthetic === true
      || !getKillRequest(sessionId, { attemptId: attempt.attemptId, runId: attempt.runId })) {
      receipt.status = 'unavailable';
      receipt.failures.push({ code: 'source_unbound' });
      return receipt;
    }
    groupId = workflowOriginSourceGroupId(identity);
    const active = readActiveWorkflowOriginGroup(groupId);
    if (active) {
      if (active.sealed.sourceGroupId !== groupId || active.sealed.originSessionId !== sessionId
        || active.sealed.sourceUserSeq !== identity.sourceUserSeq) throw new Error('source group mismatch');
      receipt.matchedRunIds = active.sealed.members.map((member) => member.runId);
    } else {
      const pending = readPendingWorkflowChatDispatchOwnership(identity);
      if (!pending) return undefined;
      if (pending.sourceGroupId !== groupId || pending.originSessionId !== sessionId
        || pending.sourceUserSeq !== identity.sourceUserSeq) throw new Error('pending group mismatch');
      receipt.matchedRunIds = [...pending.runIds];
      // A captured preparation snapshot cannot fence a later admission. Stop
      // existing held members but leave that unsealed ownership explicit.
      receipt.failures.push({ code: 'membership_open' });
    }
  } catch {
    receipt.status = 'unavailable';
    receipt.failures.push({ code: 'ownership_unavailable' });
    return receipt;
  }
  const readBudget: OwnershipReadBudget = { remaining: STOP_OWNERSHIP_READ_LIMIT };
  for (const runId of receipt.matchedRunIds) {
    try {
      if (!/^[A-Za-z0-9_.:-]+$/.test(runId)) throw new Error('invalid child identity');
      const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
      const current = readWorkflowRunRecordUnlocked<Record<string, unknown>>(file);
      if (!current || current.id !== runId || typeof current.workflow !== 'string') throw new Error('missing child');
      if (isTerminalWorkflowRunStatus(current.status)
        && ((current.status !== 'dry_run' && current.status !== 'creation_test')
          || typeof current.finishedAt === 'string')) {
        (current.status === 'cancelled' ? receipt.alreadyCancelledRunIds : receipt.alreadyTerminalRunIds).push(runId);
        continue;
      }
      const outcome = cancelWorkflowRunAtBoundary({ runId, expectedWorkflow: current.workflow,
        reason, source: `${resolver}:exact-chat-stop`, precondition: (fresh) => {
        const active = readActiveWorkflowOriginGroup(groupId);
        const bound = active ? active.sealed.originSessionId === sessionId
          && active.sealed.sourceUserSeq === identity.sourceUserSeq
          && active.sealed.members.some((member) => member.runId === runId)
          : readPendingWorkflowChatDispatchOwnership(identity)?.runIds.includes(runId);
        if (!bound) return 'ownership_unproved';
        // Canonical deduplication can attach several accepted requests to one
        // physical occurrence. Membership is not proof of exclusive ownership.
        const shared = readWorkflowRunChatDispatchPreparations(runId).some((pin) => pin.sourceGroupId !== groupId)
          || !exclusiveWorkflowObservers(runId, groupId, identity, readBudget)
          || !exclusiveWorkflowAdmissions(runId, groupId, readBudget)
          || (fresh.chatDispatchSourceGroupId !== undefined && fresh.chatDispatchSourceGroupId !== groupId)
          || fresh.originSessionId !== undefined || fresh.originSessionIds !== undefined;
        return shared ? 'shared_child_requires_exact_run_stop' : 'allow';
      } });
      if (outcome.status === 'refused' && outcome.reason === 'shared_child_requires_exact_run_stop') {
        receipt.failures.push({ runId, code: 'shared_child_requires_exact_run_stop' });
      } else if (outcome.status === 'refused') receipt.failures.push({ runId, code: 'ownership_unavailable' });
      else if (outcome.status === 'cancelled') receipt.cancelledRunIds.push(runId);
      else if (outcome.status === 'already_cancelled') receipt.alreadyCancelledRunIds.push(runId);
      else if (outcome.status === 'already_terminal') receipt.alreadyTerminalRunIds.push(runId);
      else receipt.failures.push({ runId, code: 'child_stop_failed' });
    } catch {
      receipt.failures.push({ runId, code: 'child_stop_failed' });
    }
  }
  if (receipt.failures.length > 0) receipt.status = 'partial';
  return receipt;
}

export function stopExactHarnessAttempt(
  sessionId: string,
  attempt: RunAttemptRef,
  reason: string,
  resolver: string,
): { cancelledApprovals: number; cancelledTasks: number; workflowStop?: ExactWorkflowStopReceipt } {
  requestKill(sessionId, reason, {
    attemptId: attempt.attemptId,
    runId: attempt.runId,
  });
  const current = getActiveRunAttempt(sessionId);
  if (!current || current.attemptId !== attempt.attemptId) return { cancelledApprovals: 0, cancelledTasks: 0 };

  const pending = approvalRegistry.listPending({ sessionId, status: 'pending' })
    .filter((row) => row.requestedAt >= attempt.startedAt);
  let cancelledApprovals = 0;
  for (const row of pending) {
    if (approvalRegistry.resolve(
      row.approvalId,
      'cancelled_by_user',
      resolver,
    ).ok) cancelledApprovals += 1;
  }
  if (cancelledApprovals > 0) {
    try {
      HarnessSession.load(sessionId)?.clearInterruptState({ emitEvent: false });
    } catch { /* the durable kill and approval resolutions remain authoritative */ }
  }
  let cancelledTasks = 0;
  try {
    for (const task of listBackgroundTasks()) {
      const t = task as { id: string; status: string; sessionId?: string; originSessionId?: string; runSessionId?: string };
      const linked = t.sessionId === sessionId || t.originSessionId === sessionId || t.runSessionId === sessionId;
      const active = t.status === 'pending' || t.status === 'running' || t.status === 'awaiting_approval';
      if (linked && active) {
        cancelBackgroundTask(t.id, 'Cancelled with its chat session when the user stopped the run.');
        cancelledTasks += 1;
      }
    }
  } catch { /* best effort — the stale-runner sweeper still interrupts them later */ }
  try {
    cancelledTasks += requestCodingRunStopsForOrigin(sessionId, 'Stopped with its chat when the user stopped the run.').length;
  } catch { /* the run's own card and the board can still stop it */ }
  const workflowStop = stopExactWorkflowChildren(sessionId, current, reason, resolver);
  cancelledTasks += workflowStop?.cancelledRunIds.length ?? 0;
  return { cancelledApprovals, cancelledTasks, ...(workflowStop ? { workflowStop } : {}) };
}
