/** A creation test reuses the unchanged read results of the test just before it, using controlled executors only. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';
import type { WorkflowEvent } from './workflow-events.js';

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
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const journal = await import('./workflow-events.js');
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
  // The run history is ordered by directory mtime; keep it on the controlled clock too.
  utimesSync(path.join(WORKFLOWS_DIR, name, 'runs', runId), new Date(), new Date());
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
  assert.equal(reuse.creationTestResultStillCurrent('2026-10-25T18:01:00Z', now), false, 'future observations cannot be fresh');
  const midnight = new Date(2026, 9, 26, 0, 5).getTime();
  assert.equal(reuse.creationTestResultStillCurrent(new Date(midnight - 10 * 60_000).toISOString(), midnight), false,
    'a recent observation from the previous local calendar day still expires');
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

test('reuse at ten minutes does not renew the original read at twenty minutes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T12:00:00.000Z') });
  const name = 'creation-reuse-original-age';
  let reads = 0;
  runner._setWorkflowCallNodeForTests(async () => ({ records: [{ id: `controlled-${++reads}` }] }));
  const definition = workflow(name, [readStep(), shapeStep({ v: 1 })]);
  const firstAt = new Date().toISOString();
  await runner.runCreationTest(definition, name, `${name}-1`, {}, {} as never);
  settle(name, `${name}-1`, definition, firstAt);

  t.mock.timers.tick(10 * 60_000);
  const secondAt = new Date().toISOString();
  const two = await runner.runCreationTest(definition, name, `${name}-2`, {}, {} as never);
  assert.equal(reads, 1, 'the original read is still fresh at ten minutes');
  assert.equal(two.steps.every((step) => step.reusedFrom), true);
  settle(name, `${name}-2`, definition, secondAt);

  t.mock.timers.tick(10 * 60_000);
  const three = await runner.runCreationTest(definition, name, `${name}-3`, {}, {} as never);
  assert.equal(reads, 2, 'the original read is twenty minutes old even though its copy is only ten');
  assert.equal(three.steps.some((step) => step.reusedFrom), false, 'dependent results are refreshed too');
});

test('valid chained reuse keeps the original read age in its step line and journal', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T12:00:00.000Z') });
  const name = 'creation-reuse-chain-age';
  let reads = 0;
  runner._setWorkflowCallNodeForTests(async () => { reads++; return { records: [{ id: 'controlled-1' }] }; });
  const definition = workflow(name, [readStep()]);
  const firstAt = new Date().toISOString();
  await runner.runCreationTest(definition, name, `${name}-1`, {}, {} as never);
  settle(name, `${name}-1`, definition, firstAt);
  t.mock.timers.tick(10 * 60_000);
  const secondAt = new Date().toISOString();
  await runner.runCreationTest(definition, name, `${name}-2`, {}, {} as never);
  settle(name, `${name}-2`, definition, secondAt);
  t.mock.timers.tick(4 * 60_000);
  const three = await runner.runCreationTest(definition, name, `${name}-3`, {}, {} as never);
  assert.equal(reads, 1, 'a valid second reuse is preserved');
  assert.match(runner.creationTestStepLines(three.steps)[0]!, /test 14 min ago/);
  const completion = journal.readWorkflowEvents(name, `${name}-3`).find((event) => event.kind === 'step_completed');
  assert.equal(completion?.meta?.inheritedFromRunId, `${name}-2`, 'the immediate reuse link is retained');
  assert.deepEqual(completion?.meta?.creationTestReadOrigin,
    { runId: `${name}-1`, observedAt: firstAt, admittedAt: firstAt }, 'the original observation never advances');
});

test('a file save between the original read and its copy still invalidates a later reuse', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T12:00:00.000Z') });
  const name = 'creation-reuse-chain-file';
  let reads = 0;
  runner._setWorkflowCallNodeForTests(async () => { reads++; return { records: [{ id: 'controlled-1' }] }; });
  const definition = workflow(name, [readStep()]);
  const firstAt = new Date().toISOString();
  await runner.runCreationTest(definition, name, `${name}-1`, {}, {} as never);
  settle(name, `${name}-1`, definition, firstAt);
  t.mock.timers.tick(5 * 60_000);
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', userId: 'desktop', title: 'Controlled chain fixture' });
  eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'deliverable_saved',
    data: { name: 'controlled-runner.mjs', dir: 'fixtures', bytes: 12 } });
  t.mock.timers.tick(5 * 60_000);
  const secondAt = new Date().toISOString();
  await runner.runCreationTest(definition, name, `${name}-2`, {}, {} as never);
  settle(name, `${name}-2`, definition, secondAt);
  assert.equal(reads, 1);
  t.mock.timers.tick(60_000);
  const three = await runner.runCreationTest(definition, name, `${name}-3`, {}, {} as never, { originSessionId: session.id });
  assert.equal(reads, 2, 'the saved file is newer than the original evidence, even though older than the copy');
  assert.equal(three.steps.some((step) => step.reusedFrom), false);
});

test('an inherited legacy completion without original observation metadata is read again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T12:00:00.000Z') });
  const name = 'creation-reuse-legacy-origin';
  let reads = 0;
  const output = { records: [{ id: 'controlled-1' }] };
  runner._setWorkflowCallNodeForTests(async () => { reads++; return output; });
  const definition = workflow(name, [readStep()]);
  const firstAt = new Date().toISOString();
  await runner.runCreationTest(definition, name, `${name}-1`, {}, {} as never);
  journal.appendWorkflowEventDurably(name, `${name}-1`, { kind: 'step_completed', stepId: 'read_packet', output,
    meta: { inheritedFromRunId: 'older-unavailable-fixture', reusedUnchangedInCreationTest: true } });
  settle(name, `${name}-1`, definition, firstAt);
  t.mock.timers.tick(60_000);
  const two = await runner.runCreationTest(definition, name, `${name}-2`, {}, {} as never);
  assert.equal(reads, 2, 'an unknown inherited observation must not become fresh by falling back to its copy timestamp');
  assert.equal(two.steps.some((step) => step.reusedFrom), false);
});

test('each step keeps its own observation age when an earlier read expires during a long test', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T12:00:00.000Z') });
  const name = 'creation-reuse-per-step-age';
  let reads = 0;
  runner._setWorkflowCallNodeForTests(async () => {
    reads++;
    if (reads === 2) t.mock.timers.tick(10 * 60_000);
    return { records: [{ id: `controlled-${reads}` }] };
  });
  const definition = workflow(name, [readStep(), { ...readStep(), id: 'later_packet' }]);
  const admittedAt = new Date().toISOString();
  await runner.runCreationTest(definition, name, `${name}-1`, {}, {} as never);
  settle(name, `${name}-1`, definition, admittedAt);
  t.mock.timers.tick(10 * 60_000);
  const two = await runner.runCreationTest(definition, name, `${name}-2`, {}, {} as never);
  assert.equal(reads, 3, 'only the twenty-minute-old read runs again');
  assert.equal(two.steps.find((step) => step.stepId === 'read_packet')?.reusedFrom, undefined);
  assert.equal(two.steps.find((step) => step.stepId === 'later_packet')?.reusedFrom?.observedAt, '2026-10-26T12:10:00.000Z');
});

test('invalid, self-inherited, skipped and invalidated provenance cannot refresh an observation', () => {
  const original = '2026-10-26T12:00:00.000Z';
  const copiedAt = '2026-10-26T12:10:00.000Z';
  const origin = { runId: 'origin-run', admittedAt: original, observedAt: original };
  const completion = (meta?: Record<string, unknown>): WorkflowEvent =>
    ({ kind: 'step_completed', stepId: 'read_packet', t: copiedAt, meta });
  const inherited = { inheritedFromRunId: 'prior-run', reusedUnchangedInCreationTest: true, creationTestReadOrigin: origin };
  for (const meta of [
    { ...inherited, creationTestReadOrigin: { ...origin, observedAt: 'unknown' } },
    { ...inherited, creationTestReadOrigin: { ...origin, observedAt: '2026-10-26T12:11:00.000Z' } },
    { ...inherited, creationTestReadOrigin: { ...origin, admittedAt: copiedAt } },
    { ...inherited, creationTestReadOrigin: { ...origin, runId: 'copy-run' } },
    { ...inherited, inheritedFromRunId: 'copy-run' },
    { creationTestReadOrigin: origin },
  ]) assert.equal(reuse.creationTestReadOrigins([completion(meta)], 'copy-run', copiedAt).size, 0);
  for (const kind of ['step_skipped', 'step_invalidated'] as const) {
    assert.equal(reuse.creationTestReadOrigins([completion(inherited), { kind, stepId: 'read_packet', t: copiedAt }],
      'copy-run', copiedAt).size, 0);
  }
});

test('a slow changed step cannot carry a later independent reuse past its original freshness window', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T12:00:00.000Z') });
  const name = 'creation-reuse-execution-age';
  let reads = 0;
  runner._setWorkflowCallNodeForTests(async () => {
    reads++;
    if (reads === 3) t.mock.timers.tick(10 * 60_000);
    return { records: [{ id: `controlled-${reads}` }] };
  });
  const first = workflow(name, [{ ...readStep(), id: 'slow_packet' }, readStep()]);
  const admittedAt = new Date().toISOString();
  await runner.runCreationTest(first, name, `${name}-1`, {}, {} as never);
  settle(name, `${name}-1`, first, admittedAt);
  t.mock.timers.tick(10 * 60_000);
  const changed = workflow(name, [{ ...readStep({ scope: 'changed-fixture' }), id: 'slow_packet' }, readStep()]);
  const two = await runner.runCreationTest(changed, name, `${name}-2`, {}, {} as never);
  assert.equal(reads, 4, 'the unchanged read expired while the changed step was running');
  assert.equal(two.steps.some((step) => step.reusedFrom), false);
});
