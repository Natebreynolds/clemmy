/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/keychain-unlock-followup.test.ts
 *
 * A workflow run that failed while the login keychain was locked gets exactly
 * one follow-up once it is unlocked: the ordinary safe re-run when it allows,
 * otherwise one message asking. Never while still locked, never twice.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-keychain-followup-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { followUpKeychainLockedRuns, __keychainFollowUpTest__ } = await import('./keychain-unlock-followup.js');
const { __loginKeychainTest__ } = await import('../runtime/login-keychain.js');
const { listNotifications } = await import('../runtime/notifications.js');

after(() => { rmSync(HOME, { recursive: true, force: true }); });
afterEach(() => {
  __keychainFollowUpTest__.setRequeue(null);
  __loginKeychainTest__.setRunner(null);
  __loginKeychainTest__.setPlatform(null);
});

function keychain(state: 'locked' | 'unlocked'): void {
  __loginKeychainTest__.setPlatform(() => 'darwin');
  __loginKeychainTest__.setRunner(async () => ({ code: state === 'locked' ? 51 : 0 }));
}

function writeRun(id: string, extra: Record<string, unknown> = {}): string {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const file = path.join(WORKFLOW_RUNS_DIR, `${id}.json`);
  writeFileSync(file, JSON.stringify({
    id,
    workflow: `Team update ${id}`,
    status: 'error',
    error: 'Deterministic runner failed (exit 1)',
    failureContext: { loginKeychain: 'locked', observedAt: new Date().toISOString() },
    ...extra,
  }), 'utf-8');
  return file;
}

const read = (file: string) => JSON.parse(readFileSync(file, 'utf-8')) as Record<string, any>;

test('nothing is followed up while the keychain is still locked', async () => {
  const file = writeRun('still-locked');
  keychain('locked');
  let requeues = 0;
  __keychainFollowUpTest__.setRequeue(() => { requeues += 1; return { status: 'queued', id: 'x', message: '' }; });
  const result = await followUpKeychainLockedRuns();
  assert.equal(result.checked, true);
  assert.deepEqual(result.rerun, []);
  assert.deepEqual(result.asked, []);
  assert.equal(requeues, 0);
  assert.equal(read(file).keychainFollowUp, undefined);
  rmSync(file);
});

test('once unlocked, a run the safe re-run accepts is re-run once', async () => {
  const file = writeRun('safe-rerun');
  keychain('unlocked');
  const requeued: string[] = [];
  __keychainFollowUpTest__.setRequeue((runId) => { requeued.push(runId); return { status: 'queued', id: 'rerun-1', message: 'queued' }; });
  const first = await followUpKeychainLockedRuns();
  assert.deepEqual(first.rerun, ['safe-rerun']);
  assert.deepEqual(requeued, ['safe-rerun']);
  assert.equal(read(file).keychainFollowUp.action, 'rerun');
  assert.equal(read(file).keychainFollowUp.rerunId, 'rerun-1');
  const second = await followUpKeychainLockedRuns();
  assert.deepEqual(second.rerun, [], 'never twice');
  assert.equal(second.checked, false, 'nothing is waiting, so the keychain is not even asked');
  assert.deepEqual(requeued, ['safe-rerun']);
  rmSync(file);
});

test('a run the safe re-run refuses gets one message asking instead', async () => {
  const file = writeRun('may-have-written');
  keychain('unlocked');
  __keychainFollowUpTest__.setRequeue(() => ({ status: 'ambiguous', message: 'a step may have written' }));
  const result = await followUpKeychainLockedRuns();
  assert.deepEqual(result.asked, ['may-have-written']);
  assert.equal(read(file).keychainFollowUp.action, 'asked');
  const notice = listNotifications(50).find((row) => row.id === 'workflow-may-have-written-keychain-unlocked');
  assert.ok(notice, 'the owner is asked once');
  assert.match(notice!.body, /login keychain is unlocked again/);
  assert.match(notice!.body, /have not run it again on my own/);
  assert.equal(notice!.metadata?.offer, 'run_again');
  await followUpKeychainLockedRuns();
  assert.equal(listNotifications(50).filter((row) => row.id === 'workflow-may-have-written-keychain-unlocked').length, 1);
  rmSync(file);
});

test('runs without the mark, finished runs and old runs are left alone', async () => {
  keychain('unlocked');
  const plain = writeRun('plain-failure', { failureContext: undefined });
  const done = writeRun('completed', { status: 'completed' });
  const old = writeRun('old-failure');
  const fourDaysAgo = (Date.now() - 4 * 24 * 60 * 60_000) / 1000;
  utimesSync(old, fourDaysAgo, fourDaysAgo);
  let requeues = 0;
  __keychainFollowUpTest__.setRequeue(() => { requeues += 1; return { status: 'queued', id: 'x', message: '' }; });
  const result = await followUpKeychainLockedRuns();
  assert.equal(result.checked, false);
  assert.equal(requeues, 0);
  for (const file of [plain, done, old]) rmSync(file);
});
