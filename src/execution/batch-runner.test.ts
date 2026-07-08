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
const { validateBatchPlan, runBatchPlan, certifyBatchPlan, formatBatchLedger, readBatchLedger, _setBatchSleepForTests } = await import('./batch-runner.js');

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
  // The loop-causing mistake (2026-07-07): value in id, args left empty. Must
  // get a precise "EMPTY args" message, not the confusing "duplicate" one.
  const emptyArgs = { ...base, items: [{ id: 'executive coaching', args: {} }, { id: 'business coaching', args: {} }] };
  const emptyErrs = validateBatchPlan(emptyArgs as never);
  assert.ok(emptyErrs.some((e) => /EMPTY args/.test(e)), 'empty args must be named precisely');
  assert.ok(!emptyErrs.some((e) => /duplicates another/.test(e)), 'empty-args message must win over the duplicate check');
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

// ─── Rate-awareness (per-provider throttling) ─────────────────────────────────

test('runBatchPlan: a rate-limit pauses the whole batch, does NOT consume the item retry, and does NOT count toward the halt', async () => {
  calls.length = 0;
  const delays: number[] = [];
  _setBatchSleepForTests(async (ms) => { delays.push(ms); });
  // 'r1' hits a 429 on its first TWO dispatch attempts, then succeeds. Each 429 is
  // a BATCH-level pause + fresh re-run — the item's single transient retry is never
  // spent, and rate-limits never count as consecutive failures (haltAfter=1 proves it).
  let n = 0;
  _setCodeModeToolsForTests(new Map([
    ['read_file', fakeTool('read_file', () => { n += 1; if (n <= 2) throw new Error('HTTP 429 Too Many Requests'); return 'ok'; })],
  ]) as never);
  try {
    const ledger = await runBatchPlan({
      tool: 'read_file', sideEffect: 'read',
      objective: 'rate-limit back-off should not halt or burn the retry',
      items: [{ id: 'rl-1', args: { path: '/tmp/rl-1' } }],
      concurrency: 1, haltAfterConsecutiveFailures: 1,
    }, 'sess-ratelimit');
    assert.equal(ledger.halted, false, 'rate-limits must NOT halt (they are not consecutive failures)');
    assert.equal(ledger.succeeded, 1);
    const rl1 = ledger.outcomes.find((o) => o.id === 'rl-1')!;
    assert.equal(rl1.ok, true);
    assert.equal(rl1.attempts, 1, 'the successful run used a FRESH attempt — the rate-limit did not consume the retry');
    assert.equal(delays.length, 2, 'two 429s → two batch back-off pauses');
    assert.ok(delays[0] >= 2000 && delays[0] <= 2600, `first back-off ≈ base 2s + jitter (got ${delays[0]})`);
    assert.ok(delays[1] > delays[0] && delays[1] <= 60000, 'back-off grows exponentially, capped at 60s');
  } finally {
    _setBatchSleepForTests(null);
  }
});

test('runBatchPlan: persistent rate-limiting halts after 5 back-offs with the throttling named', async () => {
  calls.length = 0;
  const delays: number[] = [];
  _setBatchSleepForTests(async (ms) => { delays.push(ms); });
  _setCodeModeToolsForTests(new Map([
    ['read_file', fakeTool('read_file', () => { throw new Error('429 rate limit exceeded'); })],
  ]) as never);
  try {
    const ledger = await runBatchPlan({
      tool: 'read_file', sideEffect: 'read',
      objective: 'a provider that never stops throttling must halt honestly',
      items: [{ id: 'rl-forever', args: { path: '/tmp/rl-forever' } }],
      concurrency: 1,
    }, 'sess-ratelimit-halt');
    assert.equal(ledger.halted, true);
    assert.match(ledger.haltReason ?? '', /rate-limit|throttl|back-off/i, 'halt names the provider throttling');
    assert.equal(delays.length, 5, 'at most 5 back-off pauses, then halt on the 6th');
    assert.ok(delays.every((d) => d <= 60000), 'every back-off honors the 60s cap');
    // A rate-limit that never resolves is not counted as a normal failure outcome.
    assert.equal(ledger.outcomes.length, 0, 'the throttled item never produced a terminal failure outcome');
  } finally {
    _setBatchSleepForTests(null);
  }
});

// ─── Idempotency (safe re-run of a partially-failed batch) ────────────────────

test('runBatchPlan: a re-run skips an already-succeeded item but re-executes a failed one (idempotency)', async () => {
  // Run A: dedup-ok succeeds, dedup-fail hard-fails.
  calls.length = 0;
  let failToggle = 0;
  _setCodeModeToolsForTests(new Map([
    ['read_file', fakeTool('read_file', (input) => {
      const p = String(input.path);
      if (p.includes('dedup-fail')) { failToggle += 1; if (failToggle === 1) throw new Error('permission denied'); return 'ok-on-retry'; }
      return `contents of ${p}`;
    })],
  ]) as never);
  const items = [
    { id: 'dedup-ok', args: { path: '/tmp/dedup-ok' } },
    { id: 'dedup-fail', args: { path: '/tmp/dedup-fail' } },
  ];
  const ledgerA = await runBatchPlan({ tool: 'read_file', sideEffect: 'read', objective: 'first pass — one succeeds one fails', items, concurrency: 1 }, 'sess-dedup');
  assert.equal(ledgerA.outcomes.find((o) => o.id === 'dedup-ok')!.ok, true);
  assert.equal(ledgerA.outcomes.find((o) => o.id === 'dedup-fail')!.ok, false);
  assert.ok(ledgerA.outcomes.every((o) => typeof o.idempotencyKey === 'string' && o.idempotencyKey.length > 0), 'every outcome carries an idempotency key');

  // Run B: SAME plan. dedup-ok must be skipped (deduped); dedup-fail re-dispatched.
  calls.length = 0;
  const ledgerB = await runBatchPlan({ tool: 'read_file', sideEffect: 'read', objective: 'retry the partially-failed batch', items, concurrency: 1 }, 'sess-dedup');
  const okB = ledgerB.outcomes.find((o) => o.id === 'dedup-ok')!;
  const failB = ledgerB.outcomes.find((o) => o.id === 'dedup-fail')!;
  assert.equal(okB.deduped, true, 'the already-succeeded item is deduped, not re-run');
  assert.equal(okB.ok, true, 'a deduped item counts as succeeded');
  assert.match(okB.resultPreview ?? '', /^deduped: already executed in batch batch-/);
  assert.equal(failB.deduped ?? false, false, 'the previously-FAILED item is NOT deduped');
  assert.equal(failB.ok, true, 'the re-dispatched item now succeeds');
  // Only the previously-failed item was actually dispatched in run B.
  assert.equal(calls.length, 1, 'run B dispatched ONLY the failed item; the succeeded one was skipped');
  assert.equal(String((calls[0].input as { path?: string }).path), '/tmp/dedup-fail');

  // Ledger counts + format surface the dedup distinctly.
  assert.equal(ledgerB.succeeded, 2, 'deduped + re-run both count as succeeded');
  const text = formatBatchLedger(ledgerB);
  assert.match(text, /1 deduped \(already executed in a prior batch: batch-/);
});

test('composio items: connected_account_id is ALWAYS present (strict nullable-required schema) and SDK error banners are FAILURES', async () => {
  calls.length = 0;
  _setCodeModeToolsForTests(new Map([
    ['composio_execute_tool', fakeTool('composio_execute_tool', (input) => {
      // The real tool's parser rejects ABSENT keys before any network call —
      // mirror that contract so composition drift fails this test.
      if (!('connected_account_id' in input)) {
        return 'An error occurred while running the tool. Please try again. Error: InvalidToolInputError: Invalid JSON input for tool';
      }
      return JSON.stringify({ data: { ok: true } });
    })],
  ]) as never);
  const ledger = await runBatchPlan({
    tool: 'composio_execute_tool',
    composioSlug: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
    sideEffect: 'write',
    objective: 'verify composio composition satisfies the strict schema',
    items: [{ id: 'sheet-a', args: { title: 'A' } }, { id: 'sheet-b', args: { title: 'B' } }],
  }, 'sess-batch-test');
  assert.equal(ledger.succeeded, 2, 'both items must dispatch with the full strict key set');
  assert.equal(ledger.failed, 0);

  // Now the classifier: a tool that ALWAYS returns the SDK banner must be an
  // honest failure, never a fake success (the 2026-07-08 "5/5 succeeded" lie).
  _setCodeModeToolsForTests(new Map([
    ['composio_execute_tool', fakeTool('composio_execute_tool', () =>
      'An error occurred while running the tool. Please try again. Error: InvalidToolInputError: Invalid JSON input for tool')],
  ]) as never);
  const bad = await runBatchPlan({
    tool: 'composio_execute_tool',
    composioSlug: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
    sideEffect: 'write',
    objective: 'verify SDK error banners are counted as failures',
    items: [{ id: 'sheet-c', args: { title: 'C' } }],
  }, 'sess-batch-test');
  assert.equal(bad.succeeded, 0, 'an SDK error banner result must NOT count as success');
  assert.equal(bad.failed, 1);
  assert.match(bad.outcomes[0].error ?? '', /InvalidToolInputError|An error occurred/);
});
