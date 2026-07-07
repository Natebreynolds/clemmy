/**
 * Run: npx tsx --test src/execution/batch-runner.test.ts
 *
 * Isolated temp CLEMENTINE_HOME. Exercises the deterministic parts of the
 * batch runner: plan validation, the execution loop (success, polite-failure
 * detection, transient retry, consecutive-failure halt, read concurrency),
 * ledger honesty, and the certification judge's fail-closed semantics when no
 * judge model is reachable (write/send refuse; read proceeds advisory).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-batch-runner';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const { _setCodeModeToolsForTests } = await import('../tools/code-mode-tool.js');
// eslint-disable-next-line import/first
const { validateBatchPlan, runBatchPlan, certifyBatchPlan, formatBatchLedger, readBatchLedger } = await import('./batch-runner.js');

type FakeCall = { name: string; input: unknown };
const calls: FakeCall[] = [];

function fakeTool(name: string, impl: (input: Record<string, unknown>) => unknown | Promise<unknown>) {
  return {
    name,
    invoke: async (_ctx: unknown, input: string) => {
      const parsed = JSON.parse(input || '{}') as Record<string, unknown>;
      calls.push({ name, input: parsed });
      return impl(parsed);
    },
  };
}

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('validateBatchPlan: catches the shapes that must never execute', () => {
  const base = { tool: 'read_file', sideEffect: 'read' as const, objective: 'read some fixture files', items: [{ id: 'a', args: { path: '/tmp/a' } }] };
  assert.deepEqual(validateBatchPlan(base as never), []);
  assert.ok(validateBatchPlan({ ...base, items: [] } as never).length > 0, 'empty items');
  assert.ok(validateBatchPlan({ ...base, tool: 'run_shell_command' } as never).length > 0, 'non-read local tool rejected');
  assert.ok(validateBatchPlan({ ...base, tool: 'composio_execute_tool' } as never).some((e) => /composioSlug/.test(e)), 'composio requires one pinned slug');
  assert.ok(validateBatchPlan({ ...base, tool: 'read_file', sideEffect: 'send' } as never).some((e) => /READ plans only/.test(e)), 'local tools cannot be write plans');
  const dupArgs = { ...base, items: [{ id: 'a', args: { path: '/tmp/x' } }, { id: 'b', args: { path: '/tmp/x' } }] };
  assert.ok(validateBatchPlan(dupArgs as never).some((e) => /duplicates another item/.test(e)), 'identical args across items rejected');
  const dupIds = { ...base, items: [{ id: 'a', args: { path: '/tmp/x' } }, { id: 'a', args: { path: '/tmp/y' } }] };
  assert.ok(validateBatchPlan(dupIds as never).some((e) => /duplicate item id/.test(e)));
});

test('runBatchPlan: read batch executes every item, ledger honest, zero model involvement', async () => {
  calls.length = 0;
  _setCodeModeToolsForTests(new Map([['read_file', fakeTool('read_file', (input) => `contents of ${String(input.path)}`)]]) as never);
  const ledger = await runBatchPlan({
    tool: 'read_file',
    sideEffect: 'read',
    objective: 'read three fixture files for the test',
    items: [1, 2, 3].map((n) => ({ id: `f${n}`, args: { path: `/tmp/f${n}` } })),
    concurrency: 2,
  }, 'sess-batch-test');
  assert.equal(ledger.total, 3);
  assert.equal(ledger.succeeded, 3);
  assert.equal(ledger.failed, 0);
  assert.equal(ledger.halted, false);
  assert.equal(calls.length, 3, 'every item dispatched exactly once');
  const persisted = readBatchLedger(ledger.batchId);
  assert.ok(persisted && persisted.succeeded === 3, 'ledger persisted to disk');
});

test('runBatchPlan: transient failures retry once; hard failures do not; consecutive failures halt', async () => {
  calls.length = 0;
  let flaky = 0;
  _setCodeModeToolsForTests(new Map([
    ['read_file', fakeTool('read_file', (input) => {
      const p = String(input.path);
      if (p.includes('flaky')) { flaky += 1; if (flaky === 1) throw new Error('fetch failed: read ECONNRESET'); return 'recovered'; }
      if (p.includes('dead')) throw new Error('permission denied');
      return 'ok';
    })],
  ]) as never);
  const ledger = await runBatchPlan({
    tool: 'read_file',
    sideEffect: 'read',
    objective: 'exercise retry + halt semantics deterministically',
    items: [
      { id: 'good', args: { path: '/tmp/good' } },
      { id: 'flaky', args: { path: '/tmp/flaky' } },
      { id: 'dead1', args: { path: '/tmp/dead1' } },
      { id: 'dead2', args: { path: '/tmp/dead2' } },
      { id: 'never-runs', args: { path: '/tmp/never' } },
    ],
    concurrency: 1,
    haltAfterConsecutiveFailures: 2,
  }, 'sess-batch-test');
  const byId = Object.fromEntries(ledger.outcomes.map((o) => [o.id, o]));
  assert.equal(byId.good.ok, true);
  assert.equal(byId.flaky.ok, true, 'transient error must be retried to success');
  assert.equal(byId.flaky.attempts, 2);
  assert.equal(byId.dead1.ok, false);
  assert.equal(byId.dead1.attempts, 1, 'non-transient failure must NOT retry');
  assert.equal(ledger.halted, true, 'two consecutive hard failures halt the batch');
  assert.equal(ledger.outcomes.length, 4, 'the item after the halt never ran');
  const text = formatBatchLedger(ledger);
  assert.match(text, /dead1/); assert.match(text, /dead2/); assert.match(text, /HALTED/);
  assert.match(text, /never attempted/);
});

test('runBatchPlan: a composio polite-failure result counts as a FAILED item, not success', async () => {
  calls.length = 0;
  _setCodeModeToolsForTests(new Map([
    ['composio_execute_tool', fakeTool('composio_execute_tool', () => '⚠️ composio_execute_tool FAILED (slug=X): boom')],
  ]) as never);
  const ledger = await runBatchPlan({
    tool: 'composio_execute_tool',
    composioSlug: 'X_SLUG',
    sideEffect: 'write',
    objective: 'verify polite failures are honest failures',
    items: [{ id: 'one', args: { a: 1 } }],
  }, 'sess-batch-test');
  assert.equal(ledger.failed, 1);
  assert.equal(ledger.succeeded, 0);
});

test('certifyBatchPlan: judge unreachable → write/send fail CLOSED, read proceeds advisory', async () => {
  const items = [{ id: 'a', args: { x: 1 } }];
  const send = await certifyBatchPlan({ tool: 'composio_execute_tool', composioSlug: 'S', sideEffect: 'send', objective: 'send things without a judge available', items });
  assert.equal(send.allow, false, 'send plan must refuse when the judge cannot run');
  assert.match(send.reason, /fail-closed/);
  const read = await certifyBatchPlan({ tool: 'read_file', sideEffect: 'read', objective: 'read things without a judge available', items });
  assert.equal(read.allow, true, 'read plan proceeds advisory');
  assert.equal(read.judged, false);
});
