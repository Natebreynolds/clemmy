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
const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');
const { workflowRehearsalKey } = await import('../execution/workflow-run-definition.js');
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
  const definition = { name: 'Invite digest', description: 'controlled local test', enabled: true, trigger: { manual: true }, steps: [{ id: 'read', prompt: 'Read fixture', sideEffect: 'read' }] } as import('../memory/workflow-store.js').WorkflowDefinition;
  writeWorkflow('Invite digest', definition);
  const body = 'Creation test passed with real fixture data.';
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(file, JSON.stringify({ id: runId, workflow: 'Invite digest', status: 'creation_test', createdAt: new Date().toISOString() }));
  addNotification({
    id: `workflow-${runId}-creationtest`,
    kind: 'workflow',
    title: 'Workflow ready: Invite digest',
    body,
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { workflow: 'Invite digest', runId, creationTest: true, pass: true, activationCompatible: true },
  });
  setTimeout(() => {
    writeFileSync(file, JSON.stringify({ id: runId, workflow: 'Invite digest', status: 'creation_test', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), rehearsal: { passed: true, definitionKey: workflowRehearsalKey(readWorkflow('Invite digest')!.data) }, reportBack: { version: 1, workflowName: 'Invite digest', outcome: 'done', detail: body, acknowledgedOriginSessionIds: [] } }));
  }, 150);
  const settled = await awaitWorkflowCreationTestSettlement(runId, 'Invite digest', { drainRegistered: () => true, pollMs: 40, boundMs: 5_000 });
  assert.ok(settled, 'settles from the immutable terminal even before a notification marker');
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


test('Stop releases the authoring waiter immediately without turning a card into a verdict', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const waiting = awaitWorkflowCreationTestSettlement('run-stop', 'Never settled', { drainRegistered: () => true, pollMs: 10_000, boundMs: 30_000, signal: controller.signal });
  controller.abort();
  assert.equal(await waiting, null);
  assert.ok(Date.now() - started < 500);
});

test('a mutable notification and old notifiedAt alone cannot claim a finished test', async () => {
  const runId = 'run-card-only';
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({ id: runId, workflow: 'Card only', status: 'creation_test', notifiedAt: new Date().toISOString() }));
  addNotification({ id: `workflow-${runId}-creationtest`, kind: 'workflow', title: 'card', body: 'not canonical', createdAt: new Date().toISOString(), read: false, metadata: { runId, pass: true } });
  assert.equal(await awaitWorkflowCreationTestSettlement(runId, 'Card only', { drainRegistered: () => true, pollMs: 5, boundMs: 20 }), null);
});

for (const terminalStatus of ['cancelled', 'error', 'creation_test'] as const) {
  test(`a child ${terminalStatus} terminal returns immediately while its authoring waiter is still live`, async () => {
    const runId = `run-child-${terminalStatus}`;
    const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
    const body = terminalStatus === 'cancelled' ? 'The child test was stopped.' : 'The child test ended without a valid rehearsal.';
    writeFileSync(file, JSON.stringify({ id: runId, workflow: 'Child test', status: 'creation_test' }));
    const controller = new AbortController();
    const started = Date.now();
    const waiting = awaitWorkflowCreationTestSettlement(runId, 'Child test', { drainRegistered: () => true, pollMs: 5, boundMs: 30_000, signal: controller.signal });
    writeFileSync(file, JSON.stringify({ id: runId, workflow: 'Child test', status: terminalStatus, finishedAt: new Date().toISOString(),
      reportBack: { version: 1, workflowName: 'Child test', outcome: 'failed', detail: body, acknowledgedOriginSessionIds: [] } }));
    const settled = await waiting;
    assert.ok(settled);
    assert.equal(controller.signal.aborted, false);
    assert.equal(settled.terminalStatus, terminalStatus === 'cancelled' ? 'cancelled' : 'failed');
    assert.equal(settled.pass, false);
    assert.equal(settled.body, body);
    assert.ok(Date.now() - started < 500);
  });
}

test('a workflow saved in a folder other than its name is read back by its name, so a passed test that turned it on says so', async () => {
  const definition = { name: 'Team Calendar Pull', description: 'Controlled fixture.', enabled: true, trigger: { manual: true },
    steps: [{ id: 'pull', prompt: '', call: { tool: 'read_file', args: { path: '/tmp/controlled.json' } }, sideEffect: 'read' }] } as never;
  writeWorkflow('team-calendar-pull', definition);
  const runId = 'run-folder-name';
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({ id: runId, workflow: 'Team Calendar Pull', status: 'creation_test',
    createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    rehearsal: { passed: true, definitionKey: workflowRehearsalKey(readWorkflow('team-calendar-pull')!.data) },
    reportBack: { version: 1, workflowName: 'Team Calendar Pull', outcome: 'done', detail: 'Creation test passed.', acknowledgedOriginSessionIds: [] } }));
  const settled = await awaitWorkflowCreationTestSettlement(runId, 'Team Calendar Pull', { drainRegistered: () => true, pollMs: 20, boundMs: 2_000 });
  assert.ok(settled);
  assert.equal(settled!.enabled, true);
  assert.equal(settled!.activationCompatible, true, 'an unchanged definition is not reported as changed');
});
