/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-keychain-locked-failure.test.ts
 *
 * A local command step that fails while the owner's login keychain is locked
 * is reported as that, first, and marked for one follow-up. The same failure
 * with the keychain unlocked reads exactly as before.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-keychain-'));
process.env.CLEMENTINE_HOME = tmp;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMENTINE_WORKFLOW_CONCURRENCY = '2';

const { writeWorkflow } = await import('../memory/workflow-store.js');
const { processWorkflowRuns } = await import('./workflow-runner.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { __loginKeychainTest__ } = await import('../runtime/login-keychain.js');
const { listNotifications } = await import('../runtime/notifications.js');

after(() => { rmSync(tmp, { recursive: true, force: true }); });
afterEach(() => {
  __loginKeychainTest__.setRunner(null);
  __loginKeychainTest__.setPlatform(null);
});

async function failCommandStep(slug: string, keychain: 'locked' | 'unlocked') {
  __loginKeychainTest__.setPlatform(() => 'darwin');
  __loginKeychainTest__.setRunner(async () => ({ code: keychain === 'locked' ? 51 : 0 }));
  const workflowName = `Keychain ${slug}`;
  writeWorkflow(slug, {
    name: workflowName,
    description: 'Pulls activity through a command-line tool.',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'pull_activity',
      prompt: 'Pull the activity.',
      sideEffect: 'read',
      deterministic: { runner: 'pull.mjs' },
    }],
  } as never);
  const scripts = path.join(tmp, 'vault', '00-System', 'workflows', slug, 'scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(path.join(scripts, 'pull.mjs'),
    'process.stderr.write("No authorization information found for the org.\\n"); process.exit(1);\n', 'utf-8');
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runId = `${slug}-${Date.now()}`;
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(file, JSON.stringify({ id: runId, workflow: workflowName, status: 'queued', inputs: {}, createdAt: new Date().toISOString() }), 'utf-8');
  await processWorkflowRuns({} as never);
  return { runId, run: JSON.parse(readFileSync(file, 'utf-8')) as Record<string, any> };
}

test('a command step that fails while the login keychain is locked says so first and is marked for one follow-up', async () => {
  const { runId, run } = await failCommandStep('locked-pull', 'locked');
  assert.equal(run.status, 'error');
  assert.match(run.error, /^Your Mac's login keychain is locked/);
  assert.match(run.error, /security unlock-keychain ~\/Library\/Keychains\/login\.keychain-db/);
  assert.match(run.error, /Deterministic runner/, 'the original failure is kept under it');
  assert.equal(run.failureContext?.loginKeychain, 'locked');
  assert.ok(run.failureContext?.observedAt);
  const notice = listNotifications(50).find((row) => row.metadata?.runId === runId);
  assert.equal(notice?.metadata?.failureCause, 'login_keychain_locked');
  assert.match(notice?.body ?? '', /login keychain is locked/);
});

test('the same failure with the keychain unlocked reads as before and is not marked', async () => {
  const { runId, run } = await failCommandStep('unlocked-pull', 'unlocked');
  assert.equal(run.status, 'error');
  assert.doesNotMatch(run.error, /keychain/i);
  assert.equal(run.failureContext, undefined);
  const notice = listNotifications(50).find((row) => row.metadata?.runId === runId);
  assert.equal(notice?.metadata?.failureCause, undefined);
});
