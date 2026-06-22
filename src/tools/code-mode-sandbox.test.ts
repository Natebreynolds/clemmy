/**
 * Run: npx tsx --test src/tools/code-mode-sandbox.test.ts
 *
 * Code Mode sandbox (Lane C Phase 1). Proves BOTH that the plumbing works (a
 * program calls clem.<tool> over RPC and returns a distilled value) AND that the
 * sandbox cannot escape — no fs/child_process/net module load, no fetch, with
 * bounded time + RPC budget. The security tests are the "no errors" guarantee:
 * untrusted model code stays contained.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCodeModeProgram, type CodeModeDispatch } from './code-mode-sandbox.js';

const noDispatch: CodeModeDispatch = async () => null;

test('happy path: a program calls clem.<tool> over RPC and returns a distilled value', async () => {
  const dispatch: CodeModeDispatch = async (method, args) => {
    if (method === 'add') { const a = args as { a: number; b: number }; return a.a + a.b; }
    return null;
  };
  const r = await runCodeModeProgram('const s = await clem.add({a:2,b:3}); return { sum: s };', dispatch, { timeoutMs: 15_000 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.value, { sum: 5 });
  assert.equal(r.rpcCalls, 1);
});

test('a multi-call loop returns ONE distilled value (the token win) — intermediates stay in the sandbox', async () => {
  const dispatch: CodeModeDispatch = async (_m, args) => ({ big: 'x'.repeat(500), n: (args as { n: number }).n });
  const r = await runCodeModeProgram(
    'let total = 0; for (let i = 0; i < 5; i++) { const row = await clem.fetchRow({ n: i }); total += row.n; } return { total };',
    dispatch, { timeoutMs: 15_000 },
  );
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.value, { total: 0 + 1 + 2 + 3 + 4 });
  assert.equal(r.rpcCalls, 5);
});

test('SECURITY: import("node:fs") is blocked', async () => {
  const r = await runCodeModeProgram('try { await import("node:fs"); return "LEAKED"; } catch (e) { return "blocked"; }', noDispatch, { timeoutMs: 15_000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value, 'blocked');
});

test('SECURITY: import("node:child_process") is blocked', async () => {
  const r = await runCodeModeProgram('try { await import("node:child_process"); return "LEAKED"; } catch (e) { return "blocked"; }', noDispatch, { timeoutMs: 15_000 });
  assert.equal(r.value, 'blocked');
});

test('SECURITY: import("node:net") / http is blocked', async () => {
  const r = await runCodeModeProgram('try { await import("node:net"); return "LEAKED"; } catch (e) { return "blocked"; }', noDispatch, { timeoutMs: 15_000 });
  assert.equal(r.value, 'blocked');
});

test('SECURITY: global fetch is removed (no network without a module)', async () => {
  const r = await runCodeModeProgram('return { fetch: typeof fetch, ws: typeof WebSocket };', noDispatch, { timeoutMs: 15_000 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.value, { fetch: 'undefined', ws: 'undefined' });
});

test('BUDGET: a program exceeding the RPC budget is stopped', async () => {
  const r = await runCodeModeProgram('for (let i = 0; i < 100; i++) { await clem.noop({}); } return "done";', noDispatch, { timeoutMs: 15_000, maxRpcCalls: 3 });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /RPC budget/);
});

test('TIMEOUT: a runaway program is killed', async () => {
  const r = await runCodeModeProgram('while (true) {} ', noDispatch, { timeoutMs: 1500 });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /exceeded .*ms|killed/);
});

test('a program that throws surfaces the error (not a crash)', async () => {
  const r = await runCodeModeProgram('throw new Error("boom");', noDispatch, { timeoutMs: 15_000 });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /boom/);
});
