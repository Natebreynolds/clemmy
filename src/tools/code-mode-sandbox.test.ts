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
import { runCodeModeProgram, cleanCodeModeStderr, type CodeModeDispatch } from './code-mode-sandbox.js';

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

// Break-it 2026-07-11: a return value larger than the pipe buffer (~64KB) is not
// written synchronously; a bare process.exit(0) TRUNCATED it, so the parent saw
// "exited (0) without returning a value" and the result (or its parking) was
// silently lost. The wrapper now flushes before exiting.
test('a LARGE return value is flushed + parked, not silently lost (flush-before-exit)', async () => {
  let parked = false;
  const r = await runCodeModeProgram(
    'return "Z".repeat(1024 * 1024);', // 1MB — well over any pipe buffer
    noDispatch,
    { timeoutMs: 15_000, onLargeResult: (json) => { parked = true; return `handle-${json.length}`; } },
  );
  assert.equal(r.ok, true, `1MB return must succeed, not be lost (got: ${r.error ?? 'ok'})`);
  assert.equal(parked, true, 'the oversized value was parked via onLargeResult');
  assert.match(JSON.stringify(r.value), /resultHandle/, 'the model gets a handle, not a truncated blob');
});

// LEGIBILITY (G3): a SyntaxError used to vanish behind the generic "exited (1)"
// message — its real text sat in .logs, dropped. cleanCodeModeStderr rewrites the
// wrapper's line numbers to the USER's own lines and strips internal noise.
test('cleanCodeModeStderr: rewrites program.mjs:<wrapperLine> to the user program line', () => {
  const logs = [
    'file:///tmp/clem-codemode-abc/program.mjs:23\n    const __ret = await (async () => { const x = ;\n                                                 ^\n\n',
    "SyntaxError: Unexpected token ';'\n    at compileSourceTextModule (node:internal/modules/esm/utils:346:16)\n",
    '    at async onImport.tracePromise (node:internal/modules/esm/loader:664:25)\nNode.js v22.22.0\n',
  ];
  const out = cleanCodeModeStderr(logs);
  assert.match(out, /your program \(line 1\)/, 'wrapper line 23 → user line 1');
  assert.match(out, /SyntaxError: Unexpected token ';'/);
  assert.doesNotMatch(out, /node:internal/, 'internal frames stripped');
  assert.doesNotMatch(out, /program\.mjs/, 'temp path stripped');
  assert.doesNotMatch(out, /Node\.js v/, 'runtime footer stripped');
});

test('cleanCodeModeStderr: keeps console breadcrumbs, empty logs → empty, bounds length', () => {
  assert.equal(cleanCodeModeStderr(['fetched 3 rows\nabout to fail\n']), 'fetched 3 rows\nabout to fail');
  assert.equal(cleanCodeModeStderr([]), '');
  assert.ok(cleanCodeModeStderr(['x'.repeat(5000)]).length <= 801, 'bounded to ~800 chars');
});

// Break-it 2026-07-11: a large non-whitespace stderr blob (a program that
// console.log's a huge minified token then fails) made the path-rewrite regex
// run superlinearly and freeze the single-threaded daemon for seconds. The input
// is now bounded BEFORE the regex — the scan is O(1) in the blob size, and the
// real error text (at the END of stderr) survives.
test('cleanCodeModeStderr: a 256KB non-whitespace blob is handled fast and keeps the trailing error', () => {
  const t0 = performance.now();
  const out = cleanCodeModeStderr([`${'x'.repeat(256 * 1024)}\nSyntaxError: boom\n`]);
  const ms = performance.now() - t0;
  assert.ok(out.length <= 801, 'bounded');
  assert.match(out, /SyntaxError: boom/, 'the real error at the tail survives the pre-bound');
  assert.ok(ms < 250, `must not block the event loop (took ${ms.toFixed(0)}ms; pre-fix was ~10000ms)`);
});

test('LEGIBILITY end-to-end: a real SyntaxError populates .logs with the user line and error text', async () => {
  const r = await runCodeModeProgram('const a = 1;\nconst x = ;\nreturn a;', noDispatch, { timeoutMs: 15_000 });
  assert.equal(r.ok, false);
  const detail = cleanCodeModeStderr(r.logs);
  assert.match(detail, /your program \(line 2\)/, 'error de-offset to the user\'s own line 2');
  assert.match(detail, /SyntaxError/);
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

test('failure breaker: tool-error text results also abort the program', async () => {
  let calls = 0;
  const dispatch: CodeModeDispatch = async (_method, args) => {
    calls++;
    const dir = (args as { directory?: string }).directory ?? '';
    return `Directory does not exist: /Applications/Clementine.app/Contents/Resources/daemon/${dir}`;
  };
  const r = await runCodeModeProgram(
    // The live bug did not throw: list_files returned a normal text result that
    // started with "Directory does not exist:", so the old failure breaker reset.
    `for (const dir of "/Users/nathan/some/path") { await clem.list_files({ directory: dir }); } return 'done';`,
    dispatch,
    { timeoutMs: 20_000 },
  );
  assert.equal(r.ok, false, 'tool-error result banners count as failures');
  assert.match(r.error ?? '', /tool-error results/i);
  assert.ok(calls <= 12, `dispatch stopped near the breaker threshold, got ${calls}`);
  assert.equal(r.partial?.completed ?? 0, 0);
  assert.ok((r.partial?.failed ?? 0) >= 10, 'soft tool failures are reported in partials');
});

test('failure breaker: structured ok:false tool results also abort the program', async () => {
  let calls = 0;
  const dispatch: CodeModeDispatch = async () => {
    calls++;
    return { ok: false, error: 'InvalidToolInputError: Invalid JSON input for tool', raw: 'An error occurred while running the tool.' };
  };
  const r = await runCodeModeProgram(
    `for (let i = 0; i < 30; i++) { await clem.composio_execute_tool({ i }); } return 'done';`,
    dispatch,
    { timeoutMs: 20_000 },
  );
  assert.equal(r.ok, false, 'structured tool failures count toward the breaker');
  assert.match(r.error ?? '', /tool-error results/i);
  assert.ok(calls <= 12, `dispatch stopped near the breaker threshold, got ${calls}`);
  assert.equal(r.partial?.completed ?? 0, 0);
  assert.ok((r.partial?.failed ?? 0) >= 10);
});

test('failure breaker: non-zero structured shell results also abort the program', async () => {
  let calls = 0;
  const dispatch: CodeModeDispatch = async () => {
    calls++;
    return { ok: false, exit_code: 2, stdout: '', stderr: 'sf: bad query' };
  };
  const r = await runCodeModeProgram(
    `for (let i = 0; i < 30; i++) { await clem.run_shell_command({ command: 'sf query' }); } return 'done';`,
    dispatch,
    { timeoutMs: 20_000 },
  );
  assert.equal(r.ok, false, 'non-zero shell results count toward the breaker');
  assert.match(r.error ?? '', /tool-error results/i);
  assert.ok(calls <= 12, `dispatch stopped near the breaker threshold, got ${calls}`);
});

test('failure breaker: ordinary empty-result text is data, not a tool failure', async () => {
  let calls = 0;
  const dispatch: CodeModeDispatch = async () => { calls++; return 'No matching files found'; };
  const r = await runCodeModeProgram(
    `const out = []; for (let i = 0; i < 12; i++) out.push(await clem.search({ i })); return out.length;`,
    dispatch,
    { timeoutMs: 20_000 },
  );
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value, 12);
  assert.equal(calls, 12);
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
    // A hung DISPATCH is "waiting on the host", not idle — so it now rides to the
    // hard ceiling (a short one here), not the idle timer. Partials still salvage.
    { timeoutMs: 3_000, idleTimeoutMs: 1_000 },
  );
  assert.equal(r.ok, false, 'the hung program is killed');
  assert.match(r.error ?? '', /ceiling/);
  assert.ok(r.partial, 'partials are attached to the failure');
  assert.equal(r.partial!.completed, 5, 'the five completed fetches are reported');
  assert.match(r.partial!.recent.at(-1)!.preview, /"item":5/, 'result previews survive');
});

// Move 5 prerequisite: a single dispatch legitimately longer than the idle window
// (a slow tool call or a 30-60s sub-agent) is NOT idle-killed — the program is
// waiting on the host, not wedged. The hard ceiling remains the real bound.
test('idle deadline: a single dispatch longer than the idle window is NOT killed (waits on host)', async () => {
  const dispatch: CodeModeDispatch = async () => { await new Promise((r) => setTimeout(r, 2_500)); return { done: true }; };
  const r = await runCodeModeProgram('return await clem.longCall({});', dispatch, { timeoutMs: 10_000, idleTimeoutMs: 1_000 });
  assert.equal(r.ok, true, `slow in-flight dispatch survived (got: ${r.error ?? 'ok'})`);
  assert.deepEqual(r.value, { done: true });
});

// The wedge case MUST still die: a program stuck with NO dispatch in flight (no
// host wait) is genuinely idle and is killed at the idle window.
test('idle deadline: a program stuck with NO dispatch in flight is still idle-killed', async () => {
  const r = await runCodeModeProgram('await new Promise(() => {}); return 1;', noDispatch, { timeoutMs: 30_000, idleTimeoutMs: 1_000 });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /idle for 1000ms/);
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
