/**
 * One follow-up for each workflow run that failed while the owner's login
 * keychain was locked, once it is unlocked again.
 *
 * The runner marks such a run (`failureContext.loginKeychain = 'locked'`).
 * When the keychain reads as unlocked, each marked run gets exactly one
 * follow-up: the safe whole-run re-run when it proves nothing outside the Mac
 * could have been written, otherwise one message asking the owner whether to
 * run it again. The re-run gate is the ordinary one; an unlocked keychain is
 * never a reason to repeat a step that may have written somewhere.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';
import { probeLoginKeychain } from '../runtime/login-keychain.js';
import { addNotification } from '../runtime/notifications.js';
import {
  readWorkflowRunRecordSnapshot,
  readWorkflowRunRecordUnlocked,
  withWorkflowRunRecordLock,
  writeWorkflowRunRecordDurablyUnlocked,
} from './workflow-run-record.js';

const logger = pino({ name: 'clementine.keychain-unlock-followup' });

/** Runs older than this are not followed up: the owner has moved on. */
const FOLLOW_UP_WINDOW_MS = 72 * 60 * 60_000;

interface KeychainLockedRun {
  id?: string;
  workflow?: string;
  status?: string;
  failureContext?: { loginKeychain?: string; observedAt?: string };
  keychainFollowUp?: { at: string; action: 'rerun' | 'asked'; rerunId?: string };
}

export interface KeychainFollowUpResult {
  checked: boolean;
  rerun: string[];
  asked: string[];
}

type Requeue = (runId: string) => { status: string; id?: string; message: string };

let requeueForTests: Requeue | null = null;

async function requeueRun(runId: string): Promise<{ status: string; id?: string; message: string }> {
  if (requeueForTests) return requeueForTests(runId);
  const { requeueWorkflowFromRun } = await import('../tools/workflow-run-queue.js');
  return requeueWorkflowFromRun(runId, {
    source: 'keychain_unlock',
    recoveryIntent: {
      kind: 'safe_rerun',
      sourceRunId: runId,
      requestedFrom: 'keychain_unlock',
      reason: 'the login keychain was locked when this run failed and is unlocked now',
    },
  });
}

function pendingRunFiles(now: number): string[] {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return [];
  const files: string[] = [];
  for (const name of readdirSync(WORKFLOW_RUNS_DIR)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(WORKFLOW_RUNS_DIR, name);
    try {
      if (now - statSync(file).mtimeMs > FOLLOW_UP_WINDOW_MS) continue;
    } catch { continue; }
    const run = readWorkflowRunRecordSnapshot<KeychainLockedRun>(file);
    if (run?.status === 'error' && run.failureContext?.loginKeychain === 'locked' && !run.keychainFollowUp) files.push(file);
  }
  return files;
}

/** Claim one run for its single follow-up. False when another pass has. */
function claim(file: string, action: 'rerun' | 'asked', rerunId?: string): boolean {
  return withWorkflowRunRecordLock(file, () => {
    const current = readWorkflowRunRecordUnlocked<KeychainLockedRun>(file);
    if (!current || current.keychainFollowUp) return false;
    writeWorkflowRunRecordDurablyUnlocked(file, {
      ...current,
      keychainFollowUp: { at: new Date().toISOString(), action, ...(rerunId ? { rerunId } : {}) },
    });
    return true;
  });
}

/**
 * Called on the daemon's five-minute timer. Cheap when nothing is waiting:
 * the keychain is only asked about when a marked run exists.
 */
export async function followUpKeychainLockedRuns(now = Date.now()): Promise<KeychainFollowUpResult> {
  const files = pendingRunFiles(now);
  if (files.length === 0) return { checked: false, rerun: [], asked: [] };
  const probe = await probeLoginKeychain({ fresh: true });
  if (probe.state !== 'unlocked') return { checked: true, rerun: [], asked: [] };
  const result: KeychainFollowUpResult = { checked: true, rerun: [], asked: [] };
  for (const file of files) {
    const run = readWorkflowRunRecordSnapshot<KeychainLockedRun>(file);
    const runId = run?.id ?? path.basename(file, '.json');
    const workflow = run?.workflow ?? 'A workflow';
    // Claim first, so a second pass or process never follows up twice.
    if (!claim(file, 'asked')) continue;
    let requeued: { status: string; id?: string; message: string } | null = null;
    try {
      requeued = await requeueRun(runId);
    } catch (error) {
      logger.warn({ err: error, runId }, 'keychain follow-up re-run was refused');
    }
    if (requeued?.status === 'queued' && requeued.id) {
      withWorkflowRunRecordLock(file, () => {
        const current = readWorkflowRunRecordUnlocked<KeychainLockedRun>(file);
        if (!current) return;
        writeWorkflowRunRecordDurablyUnlocked(file, {
          ...current,
          keychainFollowUp: { ...(current.keychainFollowUp ?? { at: new Date().toISOString() }), action: 'rerun', rerunId: requeued!.id },
        });
      });
      result.rerun.push(runId);
      continue;
    }
    addNotification({
      id: `workflow-${runId}-keychain-unlocked`,
      kind: 'workflow',
      title: `Ready to run again: ${workflow}`,
      body: `Your Mac's login keychain is unlocked again. "${workflow}" failed earlier while it was locked. `
        + 'It may have started writing before it failed, so I have not run it again on my own. Tell me to run it again when you want it.',
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { workflow, runId, status: 'error', failureCause: 'login_keychain_locked', offer: 'run_again' },
    });
    result.asked.push(runId);
  }
  return result;
}

export const __keychainFollowUpTest__ = {
  setRequeue(next: Requeue | null): void { requeueForTests = next; },
};
