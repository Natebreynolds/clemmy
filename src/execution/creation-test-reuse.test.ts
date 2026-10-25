/** A creation test reuses the unchanged read results of the test just before it, using controlled executors only. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-creation-reuse-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_BRAIN_FALLOVER = 'off';
process.env.CLEMENTINE_WORKFLOW_TRANSIENT_RETRY_FLOOR = '0';
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Controlled creation test forbids provider requests.'); };

const runner = await import('./workflow-runner.js');
const reuse = await import('./creation-test-reuse.js');
const { createWorkflowRunDefinitionSnapshot } = await import('./workflow-run-definition.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const eventlog = await import('../runtime/harness/eventlog.js');

test.afterEach(() => { runner._setWorkflowCallNodeForTests(); });
test.after(() => {
  globalThis.fetch = originalFetch;
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function workflow(name: string, steps: WorkflowStepInput[], goal?: string): WorkflowDefinition {
  return { name, description: 'Controlled creation-test reuse fixture.', enabled: false, trigger: { manual: true }, steps,
    ...(goal ? { goal: { objective: goal } } : {}) } as WorkflowDefinition;
}
const readStep = (args: Record<string, unknown> = { scope: 'controlled-fixture' }): WorkflowStepInput =>
  ({ id: 'read_packet', prompt: '', sideEffect: 'read', call: { tool: 'CONTROLLED_GET_RECORDS', args } });
const shapeStep = (value: unknown): WorkflowStepInput => ({ id: 'shape_packet', prompt: '', sideEffect: 'read',
  dependsOn: ['read_packet'], transform: { version: 1, expression: { op: 'literal', value } } });

/** Record a settled test the way the run queue does, so the next one can find it. */
function settle(name: string, runId: string, definition: WorkflowDefinition, admittedAt: string): void {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId, workflow: name, inputs: {}, status: 'creation_test', createdAt: admittedAt,
    finishedAt: new Date().toISOString(), workflowDefinitionSnapshot: createWorkflowRunDefinitionSnapshot(name, definition, admittedAt),
  }));
}

test('only read steps that, with everything they read from, run exactly as before are unchanged', () => {
  const read = (step: WorkflowStepInput) => step.sideEffect === 'read';
  const before = workflow('pure', [readStep(), shapeStep({ v: 1 }),
    { id: 'post', prompt: 'Post it.', sideEffect: 'send', dependsOn: ['shape_packet'] }], 'Old goal.');
  assert.deepEqual([...reuse.readStepsUnchangedSince(before, workflow('pure', before.steps, 'New goal.'), read)],
    ['read_packet', 'shape_packet'], 'a goal change leaves every read result as it was; a send is never reused');
  assert.deepEqual([...reuse.readStepsUnchangedSince(before, workflow('pure', [readStep(), shapeStep({ v: 2 }), before.steps[2]!]), read)],
    ['read_packet'], 'a changed step runs; what it reads from stays');
  assert.deepEqual([...reuse.readStepsUnchangedSince(before, workflow('pure', [readStep({ scope: 'other' }), shapeStep({ v: 1 }), before.steps[2]!]), read)],
    [], 'a changed source runs again, and so does everything that reads from it');
  assert.equal(reuse.readStepsUnchangedSince(before, { ...before, allowedTools: ['another_tool'] }, read).size, 0,
    'a workflow-wide tool change leaves nothing to reuse');
  const now = Date.parse('2026-10-25T18:00:00Z');
  assert.equal(reuse.creationTestResultStillCurrent('2026-10-25T17:50:00Z', now), true);
  assert.equal(reuse.creationTestResultStillCurrent('2026-10-25T17:40:00Z', now), false, 'older than the window');
});

test('a goal-only edit re-tests from the test just before it: the source is not read again and the step line says so', async () => {
  const name = 'creation-reuse-goal';
  let reads = 0;
  runner._setWorkflowCallNodeForTests(async () => { reads++; return { records: [{ id: 'controlled-1' }] }; });
  const first = workflow(name, [readStep(), shapeStep({ v: 1 })], 'Report the controlled packet.');
  const admittedAt = new Date().toISOString();
  const one = await runner.runCreationTest(first, name, `${name}-1`, {}, {} as never);
  assert.equal(one.pass, true);
  assert.equal(reads, 1);
  settle(name, `${name}-1`, first, admittedAt);

  const second = workflow(name, first.steps, 'Report the controlled packet for every item.');
  const two = await runner.runCreationTest(second, name, `${name}-2`, {}, {} as never);
  assert.equal(two.pass, true);
  assert.equal(reads, 1, 'the unchanged source was not read again');
  assert.deepEqual(two.steps.map((step) => step.reusedFrom?.runId), [`${name}-1`, `${name}-1`]);
  assert.match(runner.creationTestStepLines(two.steps)[0]!, /Read packet — returned data in the test \d+ s ago; unchanged since/);

  const changed = workflow(name, [readStep({ scope: 'changed-fixture' }), shapeStep({ v: 1 })], second.goal?.objective);
  settle(name, `${name}-2`, second, new Date().toISOString());
  const three = await runner.runCreationTest(changed, name, `${name}-3`, {}, {} as never);
  assert.equal(three.pass, true);
  assert.equal(reads, 2, 'a changed source is read again');
  assert.equal(three.steps.some((step) => step.reusedFrom), false, 'and nothing downstream of it is reused');
});

test('a file saved from the conversation after the earlier test began means every step runs again', async () => {
  const name = 'creation-reuse-saved-file';
  let reads = 0;
  runner._setWorkflowCallNodeForTests(async () => { reads++; return { records: [{ id: 'controlled-1' }] }; });
  const definition = workflow(name, [readStep(), shapeStep({ v: 1 })]);
  const admittedAt = new Date(Date.now() - 1_000).toISOString();
  await runner.runCreationTest(definition, name, `${name}-1`, {}, {} as never);
  settle(name, `${name}-1`, definition, admittedAt);
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', userId: 'desktop', title: 'Controlled reuse fixture' });
  eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'deliverable_saved',
    data: { name: 'controlled-runner.mjs', dir: 'fixtures', bytes: 12 } });
  const again = await runner.runCreationTest(definition, name, `${name}-2`, {}, {} as never, { originSessionId: session.id });
  assert.equal(reads, 2, 'the script a step runs may have changed, so the source is read again');
  assert.equal(again.steps.some((step) => step.reusedFrom), false);
});
