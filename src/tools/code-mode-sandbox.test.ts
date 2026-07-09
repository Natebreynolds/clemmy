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

// 2026-07-08 (sess-mrco803b): a program iterated a PATH STRING char-by-char —
// 199 one-character list_files calls, all failing, for 4 minutes until the RPC
// budget stopped it. The consecutive-failure breaker must abort a broken
// program at ~10 failed calls and hand the error back to the model.
test('failure breaker: 10 consecutive tool-call failures abort the program with a fix-your-program error', async () => {
  let calls = 0;
  const dispatch: CodeModeDispatch = async () => { calls++; throw new Error('ENOENT: no such directory "U"'); };
  const r = await runCodeModeProgram(
    // The observed bug shape: for..of over a string → one call per character.
    `for (const dir of "/Users/nathan/some/path") { try { await clem.list_files({ directory: dir }); } catch { /* keep looping */ } } return 'done';`,
    dispatch,
    { timeoutMs: 20_000 },
  );
  assert.equal(r.ok, false, 'the broken program is aborted, not run to completion');
  assert.match(r.error ?? '', /consecutive tool calls failed/i);
  assert.ok(calls <= 12, `dispatch stopped near the breaker threshold, got ${calls}`);
});

test('failure breaker: intervening successes reset the count — a probe-and-miss program is NOT aborted', async () => {
  let calls = 0;
  const dispatch: CodeModeDispatch = async () => {
    calls++;
    if (calls % 3 === 0) return { ok: true };
    throw new Error('miss');
  };
  const r = await runCodeModeProgram(
    `let hits = 0;
     for (let i = 0; i < 24; i++) { try { await clem.probe({ i }); hits++; } catch { /* expected misses */ } }
     return { hits };`,
    dispatch,
    { timeoutMs: 20_000 },
  );
  assert.equal(r.ok, true, 'a program with periodic successes runs to completion');
  assert.equal(calls, 24);
});

// ─── Strategic-wave Track 4: partial results, idle deadline, progress, concurrency ───

test('partial results: a program killed mid-run returns what its completed calls produced', async () => {
  let n = 0;
  const dispatch: CodeModeDispatch = async () => {
    n++;
    if (n <= 5) return { item: n };
    await new Promise((r) => setTimeout(r, 60_000)); // call 6 hangs forever
    return null;
  };
  const r = await runCodeModeProgram(
    `const out = []; for (let i = 0; i < 10; i++) { out.push(await clem.fetch_item({ i })); } return out;`,
    dispatch,
    { timeoutMs: 30_000, idleTimeoutMs: 2_500 },
  );
  assert.equal(r.ok, false, 'the hung program is killed');
  assert.match(r.error ?? '', /idle for 2500ms/);
  assert.ok(r.partial, 'partials are attached to the failure');
  assert.equal(r.partial!.completed, 5, 'the five completed fetches are reported');
  assert.match(r.partial!.recent.at(-1)!.preview, /"item":5/, 'result previews survive');
});

test('idle deadline: a SLOW but ACTIVE program is NOT killed at the idle window', async () => {
  // Each call takes ~1.2× the idle window — activity (RPC completions) must
  // keep resetting the deadline; only a genuinely silent program dies.
  const dispatch: CodeModeDispatch = async () => { await new Promise((r) => setTimeout(r, 1_200)); return 'ok'; };
  const r = await runCodeModeProgram(
    `const a = await clem.slow({}); const b = await clem.slow({}); const c = await clem.slow({}); return [a, b, c];`,
    dispatch,
    { timeoutMs: 30_000, idleTimeoutMs: 3_000 },
  );
  assert.equal(r.ok, true, `active program ran to completion (got: ${r.error ?? 'ok'})`);
  assert.deepEqual(r.value, ['ok', 'ok', 'ok']);
});

test('clem.progress() narrates without consuming the RPC budget', async () => {
  const seen: string[] = [];
  const dispatch: CodeModeDispatch = async () => 'data';
  const r = await runCodeModeProgram(
    `await clem.progress('1/2 fetched'); const x = await clem.get({}); await clem.progress('2/2 fetched'); return x;`,
    dispatch,
    { timeoutMs: 15_000, onProgress: (m) => seen.push(m) },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['1/2 fetched', '2/2 fetched']);
  assert.equal(r.rpcCalls, 1, 'progress calls are not tool calls');
});

test('dispatch concurrency is capped host-side (Promise.all does not stampede)', async () => {
  let inFlight = 0; let peak = 0;
  const dispatch: CodeModeDispatch = async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 120));
    inFlight--;
    return 'ok';
  };
  const r = await runCodeModeProgram(
    `return (await Promise.all(Array.from({ length: 24 }, (_, i) => clem.hit({ i })))).length;`,
    dispatch,
    { timeoutMs: 30_000 },
  );
  assert.equal(r.ok, true);
  assert.equal(r.value, 24, 'every call still completes');
  assert.ok(peak <= 8, `in-flight dispatches capped at 8, saw ${peak}`);
});
