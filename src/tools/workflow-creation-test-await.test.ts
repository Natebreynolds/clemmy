/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/workflow-creation-test-await.test.ts
 *
 * workflow_create waits for the creation test it starts (bounded, only inside
 * a daemon that drains runs) so the authoring receipt carries the settled
 * outcome. Live 2026-09-22: the brain spent seven frames polling for what the
 * daemon knew after 66 s, and the turn ended "blocked" on a finished workflow.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-creation-await-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { awaitWorkflowCreationTestSettlement, CREATION_TEST_AWAIT_MS } = await import('./workflow-run-queue.js');
const { WORKFLOW_RUNS_DIR } = await import('./shared.js');
const { addNotification } = await import('../runtime/notifications.js');
const { timeoutForTool, DEFAULT_TIMEOUTS_MS } = await import('../runtime/harness/brackets.js');

test('without a draining daemon the tool never waits', async () => {
  const started = Date.now();
  const settled = await awaitWorkflowCreationTestSettlement('run-none', 'Some workflow', { drainRegistered: () => false });
  assert.equal(settled, null);
  assert.ok(Date.now() - started < 200);
});

test('inside a daemon the tool waits for the run record to settle and reads the test outcome', async () => {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runId = 'run-settles';
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(file, JSON.stringify({ id: runId, workflow: 'Invite digest', status: 'creation_test', createdAt: new Date().toISOString() }));
  addNotification({
    id: `workflow-${runId}-creationtest`,
    kind: 'workflow',
    title: 'Workflow ready: Invite digest',
    body: '✅ Creation test passed for "Invite digest" — read-only steps returned real data. I\'ve ENABLED it.',
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { workflow: 'Invite digest', runId, creationTest: true, pass: true, activationCompatible: true },
  });
  setTimeout(() => {
    writeFileSync(file, JSON.stringify({ id: runId, workflow: 'Invite digest', status: 'creation_test', createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), notifiedAt: new Date().toISOString() }));
  }, 150);
  const settled = await awaitWorkflowCreationTestSettlement(runId, 'Invite digest', { drainRegistered: () => true, pollMs: 40, boundMs: 5_000 });
  assert.ok(settled, 'settles once notifiedAt lands');
  assert.equal(settled.pass, true);
  assert.equal(settled.activationCompatible, true);
  assert.match(settled.body, /Creation test passed/);
  assert.ok(settled.waitedMs >= 100 && settled.waitedMs < 4_000);
});

test('a test that outlives the bound leaves the queued message truthful (null), never a timeout', async () => {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runId = 'run-slow';
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({ id: runId, workflow: 'Slow', status: 'creation_test' }));
  const settled = await awaitWorkflowCreationTestSettlement(runId, 'Slow', { drainRegistered: () => true, pollMs: 30, boundMs: 120 });
  assert.equal(settled, null);
});

test('the authoring tools get the external-work time budget, above the await bound', () => {
  for (const tool of ['workflow_create', 'workflow_update', 'workflow_reshape']) {
    assert.equal(timeoutForTool(tool), DEFAULT_TIMEOUTS_MS.externalApi, tool);
  }
  assert.ok(CREATION_TEST_AWAIT_MS < DEFAULT_TIMEOUTS_MS.externalApi);
  assert.equal(timeoutForTool('workflow_get'), DEFAULT_TIMEOUTS_MS.default, 'reads keep the default budget');
});
