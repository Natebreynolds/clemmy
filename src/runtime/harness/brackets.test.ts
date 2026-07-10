/**
 * Run: npx tsx --test src/runtime/harness/brackets.test.ts
 *
 * Contracts the reliability brackets must keep:
 *   - assertNotKilled throws once kill_switches has a row
 *   - ToolCallsCounter throws after the cap is exceeded
 *   - TokenBudgetTracker fires condenser/soft-halt callbacks exactly
 *     once each on first crossing
 *   - withTimeout rejects when work exceeds the deadline and resolves
 *     when work completes in time
 *   - timeoutForTool picks shell/MCP/code-mode/default budgets correctly
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-harness-brackets-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic imports — see eventlog.test.ts for why.
const { resetEventLog, createSession, requestKill, appendEvent, writeToolOutput, listEvents } = await import('./eventlog.js');
const {
  assertNotKilled,
  KillRequested,
  ToolCallsCounter,
  ToolCallsLimitExceeded,
  TokenBudgetTracker,
  TokenBudgetExceeded,
  withTimeout,
  ToolTimeout,
  timeoutForTool,
  isTimeoutSelfCorrectTool,
  DEFAULT_TIMEOUTS_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_TOOL_CALLS_PER_TURN,
  wrapToolForHarness,
  withHarnessRunContext,
  harnessToolBracketsEnabled,
  softToolError,
  parallelPreWriteGatesEnabled,
  startGate,
  OrphanedWriteRetryError,
} = await import('./brackets.js');

test.after(() => {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// Step 1 of the gate-unification: BOTH wrapper paths (invoke + legacy execute)
// now surface a recoverable gate block as a soft tool-error STRING, not a throw.
// These gate tests assert the block via the marker the message carries; re-raise
// the soft string so their existing assert.rejects + /MARKER/ checks keep reading
// the block. (The string-vs-throw disposition itself is the softToolError unit
// test above; this just lets the gate-behavior tests stay focused on the gate.)
async function raiseSoftRefusal<T>(p: T | Promise<T>): Promise<T> {
  const v = await p;
  if (typeof v === 'string' && v.startsWith('Tool call refused by harness:')) {
    throw new Error(v);
  }
  return v;
}

test('parallelPreWriteGatesEnabled: DEFAULT-ON with =off kill-switch', () => {
  const prev = process.env.CLEMMY_PARALLEL_PREWRITE_GATES;
  try {
    delete process.env.CLEMMY_PARALLEL_PREWRITE_GATES;
    assert.equal(parallelPreWriteGatesEnabled(), true, 'unset → ON');
    process.env.CLEMMY_PARALLEL_PREWRITE_GATES = 'off';
    assert.equal(parallelPreWriteGatesEnabled(), false, 'kill-switch honored');
    process.env.CLEMMY_PARALLEL_PREWRITE_GATES = 'OFF';
    assert.equal(parallelPreWriteGatesEnabled(), false, 'case-insensitive');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_PARALLEL_PREWRITE_GATES;
    else process.env.CLEMMY_PARALLEL_PREWRITE_GATES = prev;
  }
});

test('startGate: a never-awaited rejected gate does NOT surface as an unhandled rejection', async () => {
  // The concurrent siblings (goal-fidelity / output-grounding) start before grounding;
  // if grounding blocks first they are never awaited. startGate must swallow their
  // rejection so it never crashes the run. Watch for an unhandledRejection.
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on('unhandledRejection', onUnhandled);
  try {
    startGate(Promise.reject(new Error('grounding blocked first; this judge was never awaited')));
    await new Promise((r) => setTimeout(r, 20)); // flush microtasks + a macrotask
    assert.equal(unhandled, false, 'startGate swallowed the never-awaited rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('startGate: the awaiter still sees the real value/rejection (the pass path)', async () => {
  assert.equal(await startGate(Promise.resolve('verdict-ok')), 'verdict-ok');
  // a rejection still propagates to the gate block that awaits it (handled fail-open there)
  await assert.rejects(startGate(Promise.reject(new Error('judge errored'))), /judge errored/);
});

test('harnessToolBracketsEnabled: DEFAULT-ON (keystone flip) with =off kill-switch', () => {
  const prev = process.env.HARNESS_TOOL_BRACKETS;
  try {
    delete process.env.HARNESS_TOOL_BRACKETS;
    assert.equal(harnessToolBracketsEnabled(), true, 'unset → ON (the 24/7 keystone default)');
    process.env.HARNESS_TOOL_BRACKETS = 'on';
    assert.equal(harnessToolBracketsEnabled(), true);
    process.env.HARNESS_TOOL_BRACKETS = 'off';
    assert.equal(harnessToolBracketsEnabled(), false, 'kill-switch honored');
    process.env.HARNESS_TOOL_BRACKETS = 'OFF';
    assert.equal(harnessToolBracketsEnabled(), false, 'case-insensitive kill-switch');
  } finally {
    if (prev === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = prev;
  }
});

test('softToolError: a recoverable gate throw → soft string; escalation/unknown → null (propagate)', () => {
  // Step 1 of the gate-unification: this shared helper is the SINGLE disposition
  // for both the invoke and the legacy execute wrappers, so a gate throw can no
  // longer crash the run purely because a tool used `execute` instead of `invoke`.
  const soft = softToolError(new ToolCallsLimitExceeded(5));
  assert.equal(typeof soft, 'string');
  assert.match(soft as string, /Tool call refused by harness/);
  // A plain Error (an unknown bug) and a generic non-Error MUST propagate.
  assert.equal(softToolError(new Error('boom')), null);
  assert.equal(softToolError({ statusCode: 500 }), null);
});

test('wrapToolForHarness: default-ON wraps the tool; =off returns it unchanged', () => {
  const prev = process.env.HARNESS_TOOL_BRACKETS;
  const raw = { name: 'demo', execute: async () => 'ok' };
  try {
    delete process.env.HARNESS_TOOL_BRACKETS;
    assert.notEqual(wrapToolForHarness(raw), raw, 'default-on → wrapped (new object)');
    process.env.HARNESS_TOOL_BRACKETS = 'off';
    assert.equal(wrapToolForHarness(raw), raw, 'kill-switch → unchanged');
  } finally {
    if (prev === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = prev;
  }
});

test('assertNotKilled is a no-op without a kill row', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  assert.doesNotThrow(() => assertNotKilled(sess.id));
});

test('assertNotKilled throws KillRequested after requestKill', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  requestKill(sess.id, 'user pressed stop');
  assert.throws(() => assertNotKilled(sess.id), (err: unknown) => {
    assert.ok(err instanceof KillRequested);
    assert.equal(err.sessionId, sess.id);
    return true;
  });
});

test('ToolCallsCounter throws when the limit is exceeded', () => {
  const c = new ToolCallsCounter(3);
  c.increment();
  c.increment();
  c.increment();
  assert.equal(c.currentCount, 3);
  assert.throws(() => c.increment(), ToolCallsLimitExceeded);
});

test('ToolCallsCounter.reset clears the per-turn count', () => {
  const c = new ToolCallsCounter(2);
  c.increment();
  c.reset();
  c.increment();
  c.increment();
  assert.throws(() => c.increment(), ToolCallsLimitExceeded);
});

test('ToolCallsCounter rejects an invalid limit', () => {
  assert.throws(() => new ToolCallsCounter(0));
  assert.throws(() => new ToolCallsCounter(-1));
});

test('TokenBudgetTracker fires condenser exactly once on crossing 50%', () => {
  let firedCondenser = 0;
  const t = new TokenBudgetTracker(1000, 1000, {
    onCondenserTrigger: () => {
      firedCondenser += 1;
    },
  });
  t.add(200, 0);
  assert.equal(firedCondenser, 0);
  t.add(400, 0); // 600/1000 = 60% — crosses condenser
  assert.equal(firedCondenser, 1);
  t.add(100, 0);
  assert.equal(firedCondenser, 1, 'callback is single-shot');
});

test('TokenBudgetTracker fires soft-halt exactly once on crossing 80%', () => {
  let firedSoft = 0;
  const t = new TokenBudgetTracker(1000, 1000, {
    onSoftHalt: () => {
      firedSoft += 1;
    },
  });
  t.add(700, 0);
  assert.equal(firedSoft, 0);
  t.add(150, 0); // 850/1000 = 85%
  assert.equal(firedSoft, 1);
  t.add(50, 0);
  assert.equal(firedSoft, 1, 'callback is single-shot');
});

test('TokenBudgetTracker assertWithinBudget throws over budget', () => {
  const t = new TokenBudgetTracker(100, 100);
  t.add(120, 0);
  assert.throws(() => t.assertWithinBudget(), TokenBudgetExceeded);
});

test('TokenBudgetTracker.reset clears usage and re-arms callbacks', () => {
  let fired = 0;
  const t = new TokenBudgetTracker(1000, 1000, {
    onCondenserTrigger: () => {
      fired += 1;
    },
  });
  t.add(600, 0);
  assert.equal(fired, 1);
  t.reset();
  assert.equal(t.snapshot().used.inputTokens, 0);
  t.add(600, 0);
  assert.equal(fired, 2, 'reset re-arms callbacks');
});

test('TokenBudgetTracker rejects zero/negative budgets', () => {
  assert.throws(() => new TokenBudgetTracker(0, 100));
  assert.throws(() => new TokenBudgetTracker(100, -5));
});

test('withTimeout resolves when work completes in time', async () => {
  const value = await withTimeout(Promise.resolve('done'), 50, 'noop');
  assert.equal(value, 'done');
});

test('withTimeout rejects with ToolTimeout when work exceeds the deadline', async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve('slow'), 100));
  await assert.rejects(() => withTimeout(slow, 20, 'slow_tool'), (err: unknown) => {
    assert.ok(err instanceof ToolTimeout);
    assert.equal(err.toolName, 'slow_tool');
    return true;
  });
});

test('withTimeout propagates the underlying error', async () => {
  const failing = Promise.reject(new Error('boom'));
  await assert.rejects(() => withTimeout(failing, 50, 'fail'), /boom/);
});

// P0-2 (v0.5.5): when the SDK pauses a tool for approval, the
// withTimeout timer must NOT fire — the tool isn't stuck, it's parked.
// The shipped fix re-arms the timer while isPaused() reports true.
test('withTimeout does not fire while isPaused() returns true', async () => {
  // Work that settles AFTER the nominal timeout. With isPaused
  // permanently true, withTimeout must re-arm and let the work win.
  const work = new Promise<string>((resolve) => setTimeout(() => resolve('done'), 80));
  const value = await withTimeout(work, 20, 'parked_tool', {
    isPaused: () => true,
    pauseRecheckMs: 20,
  });
  assert.equal(value, 'done', 'withTimeout rejected while paused — re-arm regressed');
});

test('withTimeout fires once isPaused() returns false', async () => {
  // Work outlives the test — only the timeout can settle withTimeout.
  // Flip isPaused → false after one re-arm window so the next tick fires.
  const work = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 500));
  let paused = true;
  const flipTimer = setTimeout(() => { paused = false; }, 25);
  try {
    await assert.rejects(
      () => withTimeout(work, 15, 'parked_then_unparked', {
        isPaused: () => paused,
        pauseRecheckMs: 15,
      }),
      (err: unknown) => {
        assert.ok(err instanceof ToolTimeout);
        assert.equal(err.toolName, 'parked_then_unparked');
        return true;
      },
    );
  } finally {
    clearTimeout(flipTimer);
  }
  // Let the late work settle so the timer doesn't leak past the test.
  await work;
});

// ─── withTimeout onTimeout hook (S3 abort) ──────────────────────────────────
// The hook fires EXACTLY ONCE, only on the real rejection — never on a success,
// never on the pause-defer re-arm path.

test('withTimeout onTimeout: fires exactly once on a real timeout', async () => {
  const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 500));
  let calls = 0;
  await assert.rejects(
    () => withTimeout(slow, 15, 'aborter', { onTimeout: () => { calls += 1; } }),
    (err: unknown) => err instanceof ToolTimeout,
  );
  await slow; // drain
  assert.equal(calls, 1, 'onTimeout fired once on timeout');
});

test('withTimeout onTimeout: never fires when work completes in time', async () => {
  let calls = 0;
  const value = await withTimeout(Promise.resolve('done'), 50, 'fast', { onTimeout: () => { calls += 1; } });
  assert.equal(value, 'done');
  await new Promise((r) => setTimeout(r, 60)); // outlive the nominal timeout window
  assert.equal(calls, 0, 'onTimeout must not fire on success');
});

test('withTimeout onTimeout: never fires on the pause-defer re-arm path', async () => {
  // Parked the whole time → withTimeout re-arms forever and the work eventually
  // wins; onTimeout must never fire because it never actually rejected.
  const work = new Promise<string>((resolve) => setTimeout(() => resolve('done'), 40));
  let calls = 0;
  const value = await withTimeout(work, 10, 'parked', {
    isPaused: () => true,
    pauseRecheckMs: 10,
    onTimeout: () => { calls += 1; },
  });
  assert.equal(value, 'done');
  assert.equal(calls, 0, 'onTimeout must not fire while parked/re-arming');
});

test('withTimeout onTimeout: fires once (not per re-arm) after unpause', async () => {
  const work = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 500));
  let paused = true;
  let calls = 0;
  const flip = setTimeout(() => { paused = false; }, 30);
  try {
    await assert.rejects(
      () => withTimeout(work, 12, 'parked_then_fire', {
        isPaused: () => paused,
        pauseRecheckMs: 12,
        onTimeout: () => { calls += 1; },
      }),
      (err: unknown) => err instanceof ToolTimeout,
    );
  } finally {
    clearTimeout(flip);
  }
  await work;
  assert.equal(calls, 1, 'onTimeout fired exactly once, only on the real rejection after unpause');
});

test('timeoutForTool: run_shell_command uses the shell budget', () => {
  assert.equal(timeoutForTool('run_shell_command'), DEFAULT_TIMEOUTS_MS.shell);
});

test('timeoutForTool: MCP-namespaced tools use the MCP budget', () => {
  assert.equal(timeoutForTool('dataforseo__serp_organic_live'), DEFAULT_TIMEOUTS_MS.mcp);
});

test('timeoutForTool: unrecognized tool uses the default', () => {
  assert.equal(timeoutForTool('write_file'), DEFAULT_TIMEOUTS_MS.default);
});

test('DEFAULT_MAX_TURNS exposes the roles the orchestrator hands off to', () => {
  for (const role of ['planner', 'verifier', 'researcher', 'writer', 'reviewer', 'executor', 'orchestrator', 'session']) {
    assert.ok(typeof DEFAULT_MAX_TURNS[role] === 'number', `missing role ${role}`);
  }
  assert.equal(DEFAULT_MAX_TURNS.orchestrator, 40);
  assert.equal(DEFAULT_TOOL_CALLS_PER_TURN, 16);
});

// ─── T2.1: wrapToolForHarness ──────────────────────────────────────

test('ToolCallsCounter.willExceed is non-mutating + reports correctly', () => {
  const counter = new ToolCallsCounter(3);
  assert.equal(counter.willExceed(), false);
  assert.equal(counter.currentCount, 0); // unchanged
  counter.increment();
  counter.increment();
  counter.increment();
  assert.equal(counter.currentCount, 3);
  assert.equal(counter.willExceed(), true);
  assert.equal(counter.currentCount, 3); // willExceed didn't mutate
});

test('wrapToolForHarness: no-op when HARNESS_TOOL_BRACKETS is off', () => {
  const prev = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'off';
  try {
    const original = {
      name: 'test_tool',
      execute: async (input: unknown) => ({ echoed: input }),
    };
    const wrapped = wrapToolForHarness(original);
    assert.equal(wrapped, original, 'returns the same reference when flag is off');
  } finally {
    process.env.HARNESS_TOOL_BRACKETS = prev;
  }
});

test('wrapToolForHarness: forwards the execute call when flag is on', async () => {
  const prev = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  try {
    let receivedInput: unknown;
    const wrapped = wrapToolForHarness({
      name: 'echo',
      execute: async (input) => { receivedInput = input; return 'ok'; },
    });
    // Without a run-context, the wrapper should still forward (no kill
    // check, no counter check — graceful degradation).
    const result = await wrapped.execute!({ value: 42 });
    assert.equal(result, 'ok');
    assert.deepEqual(receivedInput, { value: 42 });
  } finally {
    process.env.HARNESS_TOOL_BRACKETS = prev;
  }
});

test('wrapToolForHarness: pre-increment throws BEFORE execute when at limit', async () => {
  const prev = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  try {
    const counter = new ToolCallsCounter(2);
    counter.increment(); counter.increment(); // counter is now at limit
    let executedTimes = 0;
    const wrapped = wrapToolForHarness({
      name: 'sentinel',
      execute: async (_input: unknown) => { executedTimes++; return 'ran'; },
    });
    await withHarnessRunContext(
      { sessionId: 'test-session', counter },
      async () => {
        await assert.rejects(
          () => raiseSoftRefusal(wrapped.execute!({})),
          (err: Error) => /exceeded the limit/.test(err.message),
        );
      },
    );
    // The crucial assertion — execute MUST NOT have run when the
    // pre-increment check blocks.
    assert.equal(executedTimes, 0);
  } finally {
    process.env.HARNESS_TOOL_BRACKETS = prev;
  }
});

test('wrapToolForHarness: kill switch is checked mid-turn (per-tool)', async () => {
  const prev = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  try {
    const counter = new ToolCallsCounter(10);
    const wrapped = wrapToolForHarness({
      name: 'check_kill',
      execute: async (_input: unknown) => 'ran',
    });
    // First call goes through fine.
    await withHarnessRunContext(
      { sessionId: sess.id, counter },
      async () => {
        await wrapped.execute!({});
      },
    );
    // Now request a kill mid-turn and try another tool call.
    requestKill(sess.id, 'mid-turn kill test');
    await withHarnessRunContext(
      { sessionId: sess.id, counter },
      async () => {
        await assert.rejects(
          () => wrapped.execute!({}),
          (err: Error) => err instanceof KillRequested,
        );
      },
    );
  } finally {
    process.env.HARNESS_TOOL_BRACKETS = prev;
  }
});

test('timeoutForTool: run_tool_program outer budget exceeds the code-mode sandbox ceiling', () => {
  assert.equal(timeoutForTool('run_tool_program'), DEFAULT_TIMEOUTS_MS.externalApi);
  assert.ok(
    timeoutForTool('run_tool_program') > 180_000,
    'outer harness must not kill code mode before its default 180s sandbox ceiling can return partial results',
  );
});

test('wrapToolForHarness: applies per-tool timeout via withTimeout', async () => {
  const prev = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  try {
    const counter = new ToolCallsCounter(10);
    const wrapped = wrapToolForHarness(
      {
        name: 'slow_tool',
        execute: async (_input: unknown) => {
          await new Promise((r) => setTimeout(r, 200));
          return 'ran';
        },
      },
      { timeoutMs: 50 },
    );
    await withHarnessRunContext(
      { sessionId: 'timeout-session', counter },
      async () => {
        await assert.rejects(
          () => wrapped.execute!({}),
          (err: Error) => err instanceof ToolTimeout,
        );
      },
    );
  } finally {
    process.env.HARNESS_TOOL_BRACKETS = prev;
  }
});

// ─── Tool-timeout self-correction (long external jobs) ──────────────────────
//
// A withTimeout kill of an external-API / long-job tool (Composio, MCP) returns a
// self-correcting corrective as the tool RESULT (run continues) instead of
// propagating ToolTimeout to the loop's ask-user "retry/switch/stop" pause. Reads
// → async START+POLL; writes → verify-before-retry. Internal/shell/draft_plan and
// run_worker are excluded from the GENERAL path (run_worker has its own block).

const tscSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a tool whose work (200ms) exceeds a 50ms budget; return {result}|{error}.
 *  Manages the bracket + gate env so the call reaches withTimeout (the exec/confirm
 *  gates default ON and would otherwise intercept a composio write first). */
async function runTscTimeout(opts: {
  name: string;
  path?: 'execute' | 'invoke';
  input?: unknown;            // execute: raw input; invoke: args object (JSON-stringified)
  selfCorrect?: 'on' | 'off'; // override CLEMMY_TOOL_TIMEOUT_SELF_CORRECT (default: unset → on)
}): Promise<{ result?: unknown; error?: unknown }> {
  const saved = {
    HARNESS_TOOL_BRACKETS: process.env.HARNESS_TOOL_BRACKETS,
    CLEMMY_EXECUTION_GATE: process.env.CLEMMY_EXECUTION_GATE,
    CLEMMY_CONFIRM_FIRST: process.env.CLEMMY_CONFIRM_FIRST,
    CLEMMY_TOOL_TIMEOUT_SELF_CORRECT: process.env.CLEMMY_TOOL_TIMEOUT_SELF_CORRECT,
  };
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  process.env.CLEMMY_CONFIRM_FIRST = 'off';
  if (opts.selfCorrect) process.env.CLEMMY_TOOL_TIMEOUT_SELF_CORRECT = opts.selfCorrect;
  else delete process.env.CLEMMY_TOOL_TIMEOUT_SELF_CORRECT;
  try {
    const counter = new ToolCallsCounter(10);
    const slow = async () => { await tscSleep(200); return 'ran'; };
    if (opts.path === 'invoke') {
      const wrapped = wrapToolForHarness({ name: opts.name, invoke: slow }, { timeoutMs: 50 });
      const argStr = JSON.stringify(opts.input ?? {});
      return await withHarnessRunContext({ sessionId: `tsc-inv-${opts.name}`, counter }, async () => {
        try {
          const result = await (wrapped as unknown as {
            invoke: (rc: unknown, i: unknown, d: unknown) => Promise<unknown>;
          }).invoke(null, argStr, { toolCall: { callId: `c-${opts.name}` } });
          return { result };
        } catch (error) { return { error }; }
      });
    }
    const wrapped = wrapToolForHarness({ name: opts.name, execute: slow }, { timeoutMs: 50 });
    return await withHarnessRunContext({ sessionId: `tsc-${opts.name}`, counter }, async () => {
      try { return { result: await wrapped.execute!(opts.input ?? {}) }; }
      catch (error) { return { error }; }
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('timeout self-correct: composio READ timeout → async start+poll corrective, no throw', async () => {
  const { result, error } = await runTscTimeout({
    name: 'composio_execute_tool',
    input: { tool_slug: 'APIFY_GET_DATASET_ITEMS' },
  });
  assert.equal(error, undefined, 'run continues — no ToolTimeout thrown');
  assert.equal(typeof result, 'string');
  assert.match(result as string, /TIMED OUT/);
  assert.match(result as string, /ASYNC pattern|START the job|POLL/i);
  assert.doesNotMatch(result as string, /WRITE TIMED OUT/);
});

test('timeout self-correct: composio WRITE timeout → verify-before-retry corrective', async () => {
  const { result, error } = await runTscTimeout({
    name: 'composio_execute_tool',
    input: { tool_slug: 'AIRTABLE_CREATE_RECORD' },
  });
  assert.equal(error, undefined);
  assert.match(result as string, /WRITE TIMED OUT/);
  assert.match(result as string, /READ THE TARGET BACK|duplicate|verify/i);
  assert.doesNotMatch(result as string, /Use the ASYNC pattern/);
});

test('timeout self-correct: kill-switch off restores ToolTimeout propagation', async () => {
  const { error } = await runTscTimeout({
    name: 'composio_execute_tool',
    input: { tool_slug: 'APIFY_GET_DATASET_ITEMS' },
    selfCorrect: 'off',
  });
  assert.ok(error instanceof ToolTimeout, 'kill-switch off → propagate to ask-user card');
});

test('timeout self-correct: internal + draft_plan timeouts still propagate (ask-user card preserved)', async () => {
  for (const name of ['memory_search', 'draft_plan', 'read_file']) {
    const { error } = await runTscTimeout({ name });
    assert.ok(error instanceof ToolTimeout, `${name} must keep propagating`);
  }
});

test('timeout self-correct: MCP (__) and dynamic cx_ tools self-correct on the invoke path', async () => {
  for (const name of ['dataforseo__serp_organic_live', 'cx_apify_run_actor']) {
    const { result, error } = await runTscTimeout({ name, path: 'invoke' });
    assert.equal(error, undefined, `${name} should not throw`);
    assert.match(result as string, /TIMED OUT/, `${name} returns the corrective`);
  }
});

test('timeout self-correct: run_worker keeps its OWN message on the invoke path (precedence)', async () => {
  const { result, error } = await runTscTimeout({ name: 'run_worker', path: 'invoke' });
  assert.equal(error, undefined);
  assert.match(result as string, /run_worker timed out/);
  assert.match(result as string, /needs-attention/);
  assert.doesNotMatch(result as string, /Use the ASYNC pattern/);
});

test('isTimeoutSelfCorrectTool: external-API/MCP class only', () => {
  for (const t of ['composio_execute_tool', 'cx_apify_run_actor', 'external_api_foo', 'dataforseo__serp']) {
    assert.equal(isTimeoutSelfCorrectTool(t), true, `${t} should self-correct`);
  }
  for (const t of ['run_worker', 'draft_plan', 'memory_search', 'write_file', 'run_shell_command', 'read_file']) {
    assert.equal(isTimeoutSelfCorrectTool(t), false, `${t} should NOT self-correct`);
  }
});

// ─── S3 orphan ledger + orphaned-write retry corrective ────────────────────
//
// A mutating external write that TIMES OUT records an external_write_orphaned
// audit event (a maybe-landed write); a read does not. A later same-shape retry
// then gets a verify-before-retry corrective ONCE (informs, doesn't hard-block).

/** Run a composio timeout in an EXPLICIT session (the shared runTscTimeout uses a
 *  fixed sessionId, which would cross-contaminate these per-session assertions). */
async function runComposioTimeoutInSession(sessionId: string, input: unknown): Promise<unknown> {
  const saved = {
    HARNESS_TOOL_BRACKETS: process.env.HARNESS_TOOL_BRACKETS,
    CLEMMY_EXECUTION_GATE: process.env.CLEMMY_EXECUTION_GATE,
    CLEMMY_CONFIRM_FIRST: process.env.CLEMMY_CONFIRM_FIRST,
  };
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  process.env.CLEMMY_CONFIRM_FIRST = 'off';
  try {
    const counter = new ToolCallsCounter(10);
    const slow = async () => { await tscSleep(200); return 'ran'; };
    const wrapped = wrapToolForHarness({ name: 'composio_execute_tool', invoke: slow }, { timeoutMs: 50 });
    return await withHarnessRunContext({ sessionId, counter }, async () =>
      (wrapped as unknown as { invoke: (rc: unknown, i: unknown, d: unknown) => Promise<unknown> })
        .invoke(null, JSON.stringify(input), { toolCall: { callId: 'c-orphan' } }));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('orphan ledger: a mutating composio timeout records external_write_orphaned; a read does NOT', async () => {
  const writeSess = createSession({ kind: 'chat' }).id;
  await runComposioTimeoutInSession(writeSess, { tool_slug: 'AIRTABLE_CREATE_RECORD', arguments: { email: 'orphan@example.com' } });
  const orphans = listEvents(writeSess, { types: ['external_write_orphaned'] });
  assert.equal(orphans.length, 1, 'mutating write timeout records exactly one orphan');
  assert.equal(orphans[0].data.slug, 'AIRTABLE_CREATE_RECORD');
  assert.ok((orphans[0].data.targets as string[]).includes('orphan@example.com'), 'target captured');
  assert.equal(typeof orphans[0].data.argsDigest, 'string');
  assert.equal(orphans[0].data.aborted, true, 'aborted flag reflects the default-on kill-switch');

  const readSess = createSession({ kind: 'chat' }).id;
  await runComposioTimeoutInSession(readSess, { tool_slug: 'APIFY_GET_DATASET_ITEMS', arguments: { datasetId: 'ds1' } });
  assert.equal(listEvents(readSess, { types: ['external_write_orphaned'] }).length, 0, 'a read timeout records no orphan');
});

test('orphaned-write retry: a same-shape retry after an orphan gets the verify-first corrective; a different shape does not', async () => {
  const saved = {
    HARNESS_TOOL_BRACKETS: process.env.HARNESS_TOOL_BRACKETS,
    CLEMMY_EXECUTION_GATE: process.env.CLEMMY_EXECUTION_GATE,
    CLEMMY_CONFIRM_FIRST: process.env.CLEMMY_CONFIRM_FIRST,
  };
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  process.env.CLEMMY_CONFIRM_FIRST = 'off';
  try {
    const sess = createSession({ kind: 'chat' }).id;
    // Seed the orphan ledger: a prior AIRTABLE_CREATE_RECORD to dup@example.com timed out.
    appendEvent({
      sessionId: sess, turn: 0, role: 'system', type: 'external_write_orphaned',
      data: { tool: 'composio_execute_tool', slug: 'AIRTABLE_CREATE_RECORD', targets: ['dup@example.com'], argsDigest: 'seed', timeoutMs: 50, aborted: true },
    });
    const counter = new ToolCallsCounter(10);
    const wrapped = wrapToolForHarness({ name: 'composio_execute_tool', invoke: async () => 'OK' }, {});
    const invoke = (args: unknown, callId: string) =>
      (wrapped as unknown as { invoke: (rc: unknown, i: unknown, d: unknown) => Promise<unknown> })
        .invoke(null, JSON.stringify(args), { toolCall: { callId } });
    await withHarnessRunContext({ sessionId: sess, counter }, async () => {
      // 1) matching same-shape/target retry → soft verify-first corrective (NOT executed)
      const first = String(await invoke({ tool_slug: 'AIRTABLE_CREATE_RECORD', arguments: { email: 'dup@example.com', n: 1 } }, 'r1'));
      assert.match(first, /refused by harness/i);
      assert.match(first, /ORPHANED_WRITE_RETRY|READ THE TARGET BACK|verify/i);
      // 2) the CONSCIOUS retry (same shape+target) now passes — warn-once speed bump
      const second = String(await invoke({ tool_slug: 'AIRTABLE_CREATE_RECORD', arguments: { email: 'dup@example.com', n: 2 } }, 'r2'));
      assert.doesNotMatch(second, /ORPHANED_WRITE_RETRY/);
      assert.match(second, /OK/);
      // 3) a DIFFERENT target (no matching orphan) is unaffected
      const other = String(await invoke({ tool_slug: 'AIRTABLE_CREATE_RECORD', arguments: { email: 'fresh@example.com', n: 3 } }, 'r3'));
      assert.doesNotMatch(other, /ORPHANED_WRITE_RETRY/);
      assert.match(other, /OK/);
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('OrphanedWriteRetryError: is a soft tool error (informs, never hard-aborts)', () => {
  const err = new OrphanedWriteRetryError({ toolName: 'composio_execute_tool', shapeKey: 'AIRTABLE_CREATE_RECORD', target: 'dup@example.com' });
  const soft = softToolError(err);
  assert.ok(soft && soft.startsWith('Tool call refused by harness:'), 'surfaces as a recoverable soft error');
});

// ─── Move 2: confirm-first gate (batch external writes / worker fan-out) ───

test('confirm-first gate: same-shape writes accrue across calls and the batch trips at the threshold', async () => {
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const prevConfirm = process.env.CLEMMY_CONFIRM_FIRST;
  const prevExecGate = process.env.CLEMMY_EXECUTION_GATE;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CONFIRM_FIRST = 'on';
  // Isolate confirm-first: turn the execution-wrap gate off so the only
  // thing that can block is the batch gate under test.
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const { ConfirmFirstRequiredError } = await import('./confirm-first-gate.js');
  const { openPlanScope, closePlanScope } = await import('../../agents/plan-scope.js');
  try {
    // Default batchConfirmThreshold is 5 → writes 1..4 pass, #5 blocks.
    const counter = new ToolCallsCounter(100);
    const wrapped = wrapToolForHarness({
      name: 'composio_execute_tool',
      // Same slug each time (same shape), different args (like 25 emails
      // to different recipients fanned across workers) so loop-detection
      // doesn't fire on identical signatures.
      execute: async (_input: unknown) => 'sent',
    });

    const sendNo = (n: number) =>
      raiseSoftRefusal(withHarnessRunContext({ sessionId: sess.id, counter }, () =>
        wrapped.execute!({ tool_slug: 'GMAIL_SEND_EMAIL', arguments: JSON.stringify({ to: `person${n}@x.com` }) }),
      ));

    // Writes 1..4 succeed. (The fan-out nudge may be appended from the 3rd
    // distinct call on — the gate's concern is only that the write PASSES.)
    for (let n = 1; n <= 4; n += 1) {
      assert.ok(String(await sendNo(n)).startsWith('sent'), `write #${n} should pass below threshold`);
    }
    // Write #5 trips the batch gate — no instruction-reviewed plan scope.
    await assert.rejects(async () => { await sendNo(5); }, (err: Error) => /CONFIRM_FIRST_REQUIRED/.test(err.message));

    // Approving a plan opens a scope that ENUMERATES the send slug — the
    // gateway name alone no longer launders consent (2026-07-09 Hole A), so the
    // reviewed scope must name the actual slug it covers.
    openPlanScope({
      sessionId: sess.id,
      planProposalId: 'plan-test',
      approvedPlanObjective: 'Send the reviewed batch of emails',
      allowedTools: ['composio_execute_tool'],
      allowedComposioSlugs: ['GMAIL_SEND_EMAIL'],
    });
    assert.ok(String(await sendNo(5)).startsWith('sent'), 'write passes once the slug is enumerated in a reviewed scope');

    // Closing the scope re-arms the gate.
    closePlanScope(sess.id, 'test');
    await assert.rejects(async () => { await sendNo(6); }, (err: Error) => /CONFIRM_FIRST_REQUIRED/.test(err.message));
  } finally {
    process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
    process.env.CLEMMY_CONFIRM_FIRST = prevConfirm;
    process.env.CLEMMY_EXECUTION_GATE = prevExecGate;
  }
});

test('confirm-first gate: YOLO never extends to an irreversible batch — threshold blocks; a certified batch passes', async () => {
  // Supersedes the 2026-06-02 contract after sess-mrds80fu (2026-07-09): YOLO
  // waved 10 outbound emails through this gate. New contract: YOLO still skips
  // the gate for irreversible sends UNDER the threshold, but AT the threshold
  // an ad-hoc irreversible send requires a reviewed approval — and a certified
  // batch item (human-approved, byte-pinned run_batch plan) satisfies it.
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const prevConfirm = process.env.CLEMMY_CONFIRM_FIRST;
  const prevExecGate = process.env.CLEMMY_EXECUTION_GATE;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CONFIRM_FIRST = 'on';
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const { saveProactivityPolicy } = await import('../../agents/proactivity-policy.js');
  const { listEvents } = await import('./eventlog.js');
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const counter = new ToolCallsCounter(100);
    const wrapped = wrapToolForHarness({
      name: 'composio_execute_tool',
      execute: async (_input: unknown) => 'sent',
    });
    const sendNo = (n: number, certified = false) =>
      withHarnessRunContext(
        { sessionId: sess.id, counter, ...(certified ? { certifiedBatch: { batchId: 'b1', payloadHash: 'h1' } } : {}) },
        () => wrapped.execute!({ tool_slug: 'OUTLOOK_SEND_EMAIL', arguments: JSON.stringify({ to: `person${n}@x.com` }) }),
      );
    // Under the threshold (5): YOLO standing approval still flows.
    for (let n = 1; n <= 4; n += 1) {
      assert.ok(String(await sendNo(n)).startsWith('sent'), `YOLO send #${n} under threshold should pass`);
    }
    // AT the threshold: the ad-hoc irreversible send is BLOCKED despite YOLO
    // (surfaced as the soft refusal string, so the agent can recover).
    const blocked = String(await sendNo(5));
    assert.match(blocked, /refused by harness/i, 'send #5 must be refused even in YOLO');
    assert.doesNotMatch(blocked, /^sent/, 'the blocked send must not execute');
    // A certified batch item (human-approved, byte-pinned plan) passes the gate.
    assert.ok(String(await sendNo(5, true)).startsWith('sent'), 'certified batch item passes — the approval IS the reviewed plan');
    // Continuity: every ALLOWED write is still recorded for batch counting.
    const writes = listEvents(sess.id, { types: ['external_write'] });
    assert.equal(writes.length, 5, 'allowed writes (4 under-threshold + 1 certified) recorded');
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'balanced' });
    process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
    process.env.CLEMMY_CONFIRM_FIRST = prevConfirm;
    process.env.CLEMMY_EXECUTION_GATE = prevExecGate;
  }
});

test('confirm-first gate: explicit off escape hatch lets batches pass', async () => {
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const prevConfirm = process.env.CLEMMY_CONFIRM_FIRST;
  const prevExecGate = process.env.CLEMMY_EXECUTION_GATE;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CONFIRM_FIRST = 'off'; // explicitly off (default flipped to on for release)
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  try {
    const counter = new ToolCallsCounter(100);
    const wrapped = wrapToolForHarness({
      name: 'composio_execute_tool',
      execute: async (_input: unknown) => 'sent',
    });
    // 8 same-shape writes, well past the threshold — all pass with flag off.
    for (let n = 1; n <= 8; n += 1) {
      const r = await withHarnessRunContext({ sessionId: sess.id, counter }, () =>
        wrapped.execute!({ tool_slug: 'GMAIL_SEND_EMAIL', arguments: JSON.stringify({ to: `p${n}@x.com` }) }),
      );
      assert.ok(String(r).startsWith('sent'), `write #${n} should pass when confirm-first is off`);
    }
  } finally {
    process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
    process.env.CLEMMY_CONFIRM_FIRST = prevConfirm;
    process.env.CLEMMY_EXECUTION_GATE = prevExecGate;
  }
});

test('fan-out nudge: appended to the tool RESULT on serial same-slug calls; suppressed in worker scope', async () => {
  // The live 2026-06-11 serial run: 74 sequential composio calls, 8 warn-only
  // guardrail events the model never saw. The nudge must land IN the result
  // the model reads — and must NOT fire inside a run_worker scope (workers
  // can't fan out further).
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const prevConfirm = process.env.CLEMMY_CONFIRM_FIRST;
  const prevExecGate = process.env.CLEMMY_EXECUTION_GATE;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CONFIRM_FIRST = 'off';
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  try {
    const counter = new ToolCallsCounter(100);
    const wrapped = wrapToolForHarness({
      name: 'composio_execute_tool',
      execute: async (_input: unknown) => 'rows',
    });
    const call = (n: number, scopeId?: string) =>
      withHarnessRunContext(
        { sessionId: sess.id, counter, ...(scopeId ? { guardrailScopeId: scopeId } : {}) },
        () => wrapped.execute!({ tool_slug: 'AIRTABLE_LIST_RECORDS', arguments: JSON.stringify({ view: `v${n}` }) }),
      );
    assert.equal(await call(1), 'rows');
    assert.equal(await call(2), 'rows');
    const r3 = String(await call(3));
    assert.ok(r3.includes('[harness fan-out check]'), '3rd distinct same-slug call carries the nudge in the RESULT');
    assert.ok(r3.includes('run_worker'), 'nudge steers toward run_worker');

    // Worker scope: same serial pattern, nudge suppressed.
    resetEventLog();
    const sess2 = createSession({ kind: 'chat' });
    const counter2 = new ToolCallsCounter(100);
    const wrapped2 = wrapToolForHarness({
      name: 'composio_execute_tool',
      execute: async (_input: unknown) => 'rows',
    });
    for (let n = 1; n <= 4; n += 1) {
      const r = await withHarnessRunContext(
        { sessionId: sess2.id, counter: counter2, guardrailScopeId: `${sess2.id}::w:test` },
        () => wrapped2.execute!({ tool_slug: 'AIRTABLE_LIST_RECORDS', arguments: JSON.stringify({ view: `v${n}` }) }),
      );
      assert.equal(r, 'rows', `worker-scope call #${n} must NOT carry the fan-out nudge`);
    }
  } finally {
    process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
    process.env.CLEMMY_CONFIRM_FIRST = prevConfirm;
    process.env.CLEMMY_EXECUTION_GATE = prevExecGate;
  }
});

test('within-task fetch-memory nudge: appended to the result on an identical CACHE_SAFE read; suppressed in worker scope and on error-shaped prior output', async () => {
  // FIX 2. A byte-identical repeat of a static read points the model at
  // recall_tool_result instead of re-fetching. callId threads only on the
  // INVOKE path (production), so the wrapped tool exposes `invoke`.
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const prevConfirm = process.env.CLEMMY_CONFIRM_FIRST;
  const prevExecGate = process.env.CLEMMY_EXECUTION_GATE;
  const prevNudge = process.env.CLEMMY_WITHIN_TASK_RECALL_NUDGE;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CONFIRM_FIRST = 'off';
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  process.env.CLEMMY_WITHIN_TASK_RECALL_NUDGE = 'on';
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  try {
    const counter = new ToolCallsCounter(100);
    const wrapped = wrapToolForHarness({ name: 'memory_search', invoke: async () => 'memory rows' });
    const args = JSON.stringify({ query: 'market leaders' });
    const invoke = (callId: string, scopeId?: string) =>
      withHarnessRunContext(
        { sessionId: sess.id, counter, ...(scopeId ? { guardrailScopeId: scopeId } : {}) },
        () => (wrapped as unknown as { invoke: (rc: unknown, i: unknown, d: unknown) => Promise<unknown> })
          .invoke(null, args, { toolCall: { callId } }),
      );
    assert.equal(await invoke('call-1'), 'memory rows');
    // hooks.ts persists tool_outputs in prod; seed it so the serve-side peek finds it.
    writeToolOutput({ sessionId: sess.id, callId: 'call-1', tool: 'memory_search', output: 'memory rows' });
    const r2 = String(await invoke('call-2'));
    assert.ok(r2.includes('[within-task memory]'), 'cache nudge lands in the result');
    assert.ok(r2.includes('recall_tool_result'), 'nudge points at recall_tool_result');
    assert.ok(r2.includes('call-1'), 'nudge carries the prior call id');

    // Worker scope: identical repeat, nudge suppressed (tracker/tool_outputs keying diverges).
    resetEventLog();
    const sess2 = createSession({ kind: 'chat' });
    const counter2 = new ToolCallsCounter(100);
    const wrapped2 = wrapToolForHarness({ name: 'memory_search', invoke: async () => 'rows' });
    const wargs = JSON.stringify({ query: 'q' });
    const winvoke = (callId: string) =>
      withHarnessRunContext(
        { sessionId: sess2.id, counter: counter2, guardrailScopeId: `${sess2.id}::w:test` },
        () => (wrapped2 as unknown as { invoke: (rc: unknown, i: unknown, d: unknown) => Promise<unknown> })
          .invoke(null, wargs, { toolCall: { callId } }),
      );
    await winvoke('w-1');
    writeToolOutput({ sessionId: sess2.id, callId: 'w-1', tool: 'memory_search', output: 'rows' });
    assert.equal(await winvoke('w-2'), 'rows', 'worker-scope repeat carries NO cache nudge');

    // Error-shaped prior output: a retry after a transient failure must NOT be discouraged.
    resetEventLog();
    const sess3 = createSession({ kind: 'chat' });
    const counter3 = new ToolCallsCounter(100);
    const wrapped3 = wrapToolForHarness({ name: 'memory_search', invoke: async () => 'ERROR: timed out' });
    const eargs = JSON.stringify({ query: 'e' });
    const einvoke = (callId: string) =>
      withHarnessRunContext(
        { sessionId: sess3.id, counter: counter3 },
        () => (wrapped3 as unknown as { invoke: (rc: unknown, i: unknown, d: unknown) => Promise<unknown> })
          .invoke(null, eargs, { toolCall: { callId } }),
      );
    await einvoke('e-1');
    writeToolOutput({ sessionId: sess3.id, callId: 'e-1', tool: 'memory_search', output: 'ERROR: timed out' });
    assert.equal(await einvoke('e-2'), 'ERROR: timed out', 'an error-shaped prior result does NOT become a do-not-retry nudge');
  } finally {
    process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
    process.env.CLEMMY_CONFIRM_FIRST = prevConfirm;
    process.env.CLEMMY_EXECUTION_GATE = prevExecGate;
    if (prevNudge === undefined) delete process.env.CLEMMY_WITHIN_TASK_RECALL_NUDGE;
    else process.env.CLEMMY_WITHIN_TASK_RECALL_NUDGE = prevNudge;
  }
});

test('grounding gate: an irreversible send contradicting the target\'s own artifacts is soft-blocked; corrected payload passes; duplicate re-send bumps once (Eley incident replay)', async () => {
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const prevConfirm = process.env.CLEMMY_CONFIRM_FIRST;
  const prevExecGate = process.env.CLEMMY_EXECUTION_GATE;
  const prevGrounding = process.env.CLEMMY_GROUNDING_GATE;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CONFIRM_FIRST = 'off';
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  process.env.CLEMMY_GROUNDING_GATE = 'on';
  resetEventLog();
  const { writeToolOutput, appendEvent } = await import('./eventlog.js');
  const grounding = await import('./grounding-gate.js');
  grounding._resetGroundingStateForTests();
  grounding._resetDuplicateStateForTests();
  const sess = createSession({ kind: 'chat' });
  // The extraction worker's CORRECT artifact for this target (Denver).
  writeToolOutput({
    sessionId: sess.id,
    callId: 'call_extract_eley',
    tool: 'run_worker',
    output: 'Eley Law Firm; verified search term: "workers compensation lawyer Denver"; contact cliff@eleylawfirm.com; subject: Denver comp search gap',
  });
  grounding._setGroundingJudgeForTests(async (payload) => payload.includes('Houston')
    ? { grounded: false, reason: 'Payload claims Houston; the extraction artifact for this target says Denver.' }
    : { grounded: true, reason: 'Matches the Denver extraction.' });
  try {
    const counter = new ToolCallsCounter(100);
    const wrapped = wrapToolForHarness({
      name: 'composio_execute_tool',
      execute: async (_input: unknown) => 'sent',
    });
    const send = (subject: string) =>
      raiseSoftRefusal(withHarnessRunContext({ sessionId: sess.id, counter }, () =>
        wrapped.execute!({
          tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
          arguments: JSON.stringify({ to_email: 'cliff@eleylawfirm.com', subject, body: `${subject} body` }),
        }),
      ));
    // 1. Corrupted payload (Houston) → soft-blocked with the discrepancy.
    await assert.rejects(() => Promise.resolve(send('Houston workers comp search')), (err: Error) => {
      assert.match(err.message, /GROUNDING_CHECK_FAILED/);
      assert.match(err.message, /Denver/);
      return true;
    });
    // 2. Corrected payload (Denver) → allowed.
    assert.equal(await send('Denver comp search gap'), 'sent');
    // 3. Re-send to the SAME target after a recorded external_write →
    //    duplicate bump fires once…
    appendEvent({
      sessionId: sess.id, turn: 0, role: 'system', type: 'external_write',
      data: { shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL', toolName: 'composio_execute_tool', irreversible: true, count: 1, underScope: false, targets: ['cliff@eleylawfirm.com', 'eleylawfirm.com'] },
    });
    await assert.rejects(() => Promise.resolve(send('Denver comp search gap')), (err: Error) => {
      assert.match(err.message, /DUPLICATE_EXTERNAL_WRITE/);
      assert.match(err.message, /cliff@eleylawfirm\.com/);
      return true;
    });
    // …and the retry is STILL refused — a HARD WALL, not a speed bump (no double-send).
    await assert.rejects(() => Promise.resolve(send('Denver comp search gap')), /DUPLICATE_EXTERNAL_WRITE/);
  } finally {
    grounding._setGroundingJudgeForTests(null);
    process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
    process.env.CLEMMY_CONFIRM_FIRST = prevConfirm;
    process.env.CLEMMY_EXECUTION_GATE = prevExecGate;
    if (prevGrounding === undefined) delete process.env.CLEMMY_GROUNDING_GATE; else process.env.CLEMMY_GROUNDING_GATE = prevGrounding;
  }
});

test('destination gate: a PROD ambient publish HARD-blocks every attempt until explicit; a DRAFT ambient publish is a one-shot nudge (2026-06-14 Test-5 fix)', async () => {
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const prevConfirm = process.env.CLEMMY_CONFIRM_FIRST;
  const prevExecGate = process.env.CLEMMY_EXECUTION_GATE;
  const prevGrounding = process.env.CLEMMY_GROUNDING_GATE;
  const prevDest = process.env.CLEMMY_DESTINATION_GATE;
  const prevOffer = process.env.CLEMMY_BG_OFFER_NUDGE;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CONFIRM_FIRST = 'off';
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  process.env.CLEMMY_GROUNDING_GATE = 'off';
  process.env.CLEMMY_DESTINATION_GATE = 'on';
  // This test drives 7+ tool calls in one chat session, crossing the background-
  // offer nudge floor — orthogonal to the destination gate under test, so disable
  // it here to keep the exact-output assertions byte-stable.
  process.env.CLEMMY_BG_OFFER_NUDGE = 'off';
  resetEventLog();
  const destination = await import('./destination-gate.js');
  destination._resetDestinationStateForTests();
  const sess = createSession({ kind: 'chat' });
  try {
    const counter = new ToolCallsCounter(100);
    const wrapped = wrapToolForHarness({ name: 'run_shell_command', execute: async () => 'deployed' });
    const shell = (command: string) =>
      raiseSoftRefusal(withHarnessRunContext({ sessionId: sess.id, counter }, () => wrapped.execute!({ command })));
    const prodCmd = 'netlify deploy --dir "/x/site" --prod --json';
    // 1. PROD ambient publish → hard-blocked.
    await assert.rejects(() => Promise.resolve(shell(prodCmd)), (err: Error) => {
      assert.match(err.message, /IMPLICIT_DESTINATION/);
      assert.match(err.message, /REFUSED|netlify status/);
      return true;
    });
    // 2. RETRYING the SAME prod command is STILL refused (the Test-5 fix — no
    //    clobber-by-retry). This is the core regression.
    await assert.rejects(() => Promise.resolve(shell(prodCmd)), /IMPLICIT_DESTINATION/);
    await assert.rejects(() => Promise.resolve(shell(prodCmd)), /IMPLICIT_DESTINATION/);
    // 3. PROVENANCE (2026-06-15 clobber): an EXPLICIT --site to a target that was
    //    NEVER created or named this session is REFUSED — explicit ≠ correct
    //    (the coffee-shop-onto-a-law-firm-site case).
    await assert.rejects(() => Promise.resolve(shell('netlify deploy --dir "/x/site" --prod --site stranger-999 --json')), /UNVERIFIED_DESTINATION/);
    //    …but once the user has named the target (or it was created), it passes.
    appendEvent({ sessionId: sess.id, turn: 0, role: 'user', type: 'user_input_received', data: { text: 'deploy it to abc123 please' } });
    assert.equal(await shell('netlify deploy --dir "/x/site" --prod --site abc123 --json'), 'deployed');
    // 4. A DRAFT (non-prod) ambient publish is the gentle one-shot: blocks once…
    await assert.rejects(() => Promise.resolve(shell('netlify deploy --dir "/x/site"')), /IMPLICIT_DESTINATION/);
    // …then a conscious retry passes.
    assert.equal(await shell('netlify deploy --dir "/x/site"'), 'deployed');
    // 5. A non-publish command is untouched.
    assert.equal(await shell('ls -la /x/site'), 'deployed');
    // 6. PROVENANCE via the API create path (2026-06-15 Fernwood false-positive):
    //    she self-recovered into `netlify api createSite` (not `sites:create`);
    //    the gate must recognize it and ALLOW the deploy to her own new site.
    appendEvent({
      sessionId: sess.id, turn: 0, role: 'Clem', type: 'tool_called',
      data: { tool: 'run_shell_command', callId: 'cs1', arguments: JSON.stringify({ command: 'netlify api createSite --data \'{"name":"fernwood","account_slug":"natebreynolds"}\'' }) },
    });
    appendEvent({
      sessionId: sess.id, turn: 0, role: 'Clem', type: 'tool_returned',
      data: { tool: 'run_shell_command', callId: 'cs1', result: 'exit_code: 0\n\n{"id":"244fc7d2-newsite","name":"fernwood","ssl_url":"https://fernwood.netlify.app"}' },
    });
    assert.equal(await shell('netlify deploy --dir "/x/site" --prod --site 244fc7d2-newsite --json'), 'deployed');
    // 7. PROVENANCE via current Netlify CLI plain-text output. netlify-cli 24
    //    prints "Project ID:" instead of JSON; that id must confer provenance
    //    for the immediate explicit --site deploy.
    appendEvent({
      sessionId: sess.id, turn: 0, role: 'Clem', type: 'tool_called',
      data: { tool: 'run_shell_command', callId: 'cs2', arguments: JSON.stringify({ command: 'npx netlify-cli sites:create --name ai-agent-loop-runloop --account-slug natebreynolds' }) },
    });
    appendEvent({
      sessionId: sess.id, turn: 0, role: 'Clem', type: 'tool_returned',
      data: {
        tool: 'run_shell_command',
        callId: 'cs2',
        result: [
          'exit_code: 0',
          '',
          'stdout:',
          '',
          'Project Created',
          '\x1B[32mAdmin URL: \x1B[39m https://app.netlify.com/projects/ai-agent-loop-runloop',
          '\x1B[32mURL: \x1B[39m       https://ai-agent-loop-runloop.netlify.app',
          '\x1B[32mProject ID: \x1B[39m9fce1eaf-84db-4d7c-911e-fb9bd4d92498',
          '',
          'Project already linked to "ai-agent-loop-site"',
          'Admin url: https://app.netlify.com/projects/ai-agent-loop-site',
          '',
          'To unlink this project, run: npx netlify unlink',
        ].join('\n'),
      },
    });
    assert.equal(await shell('npx netlify-cli deploy --dir "/x/site" --prod --site 9fce1eaf-84db-4d7c-911e-fb9bd4d92498 --json'), 'deployed');
    await assert.rejects(() => Promise.resolve(shell('npx netlify-cli deploy --dir "/x/site" --prod --site ai-agent-loop-site --json')), /UNVERIFIED_DESTINATION/);
    // 8. PROVENANCE via the Claude Agent SDK gated-MCP trace shape. That lane
    //    logs `args` + `preview` instead of the legacy `arguments` + `result`;
    //    the destination gate must still see the CLI-created project id.
    appendEvent({
      sessionId: sess.id, turn: 0, role: 'Clem', type: 'tool_called',
      data: { tool: 'run_shell_command', callId: 'cs3', args: { command: 'npx netlify-cli sites:create --name sdk-agent-site --account-slug natebreynolds' } },
    });
    appendEvent({
      sessionId: sess.id, turn: 0, role: 'tool', type: 'tool_returned',
      data: {
        tool: 'run_shell_command',
        callId: 'cs3',
        ok: true,
        preview: [
          'exit_code: 0',
          '',
          'stdout:',
          '',
          'Project Created',
          '\x1B[32mURL: \x1B[39m       https://sdk-agent-site.netlify.app',
          '\x1B[32mProject ID: \x1B[39msdk-agent-site-id-123',
        ].join('\n'),
      },
    });
    assert.equal(await shell('npx netlify-cli deploy --dir "/x/site" --prod --site sdk-agent-site-id-123 --json'), 'deployed');
    // A failed create attempt must not prove a target merely because the
    // command carried `--name`.
    appendEvent({
      sessionId: sess.id, turn: 0, role: 'Clem', type: 'tool_called',
      data: { tool: 'run_shell_command', callId: 'cs4', args: { command: 'npx netlify-cli sites:create --name failed-site --account-slug missing-team' } },
    });
    appendEvent({
      sessionId: sess.id, turn: 0, role: 'tool', type: 'tool_returned',
      data: { tool: 'run_shell_command', callId: 'cs4', ok: false, preview: 'exit_code: 1\n\nstderr:\nError: no such team' },
    });
    await assert.rejects(() => Promise.resolve(shell('npx netlify-cli deploy --dir "/x/site" --prod --site failed-site --json')), /UNVERIFIED_DESTINATION/);
  } finally {
    process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
    process.env.CLEMMY_CONFIRM_FIRST = prevConfirm;
    process.env.CLEMMY_EXECUTION_GATE = prevExecGate;
    if (prevGrounding === undefined) delete process.env.CLEMMY_GROUNDING_GATE; else process.env.CLEMMY_GROUNDING_GATE = prevGrounding;
    if (prevDest === undefined) delete process.env.CLEMMY_DESTINATION_GATE; else process.env.CLEMMY_DESTINATION_GATE = prevDest;
    if (prevOffer === undefined) delete process.env.CLEMMY_BG_OFFER_NUDGE; else process.env.CLEMMY_BG_OFFER_NUDGE = prevOffer;
  }
});

test('shell-send grounding: a curl POST with a contradicting payload soft-blocks; the corrected payload passes (audit #2)', async () => {
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const prevConfirm = process.env.CLEMMY_CONFIRM_FIRST;
  const prevExecGate = process.env.CLEMMY_EXECUTION_GATE;
  const prevGrounding = process.env.CLEMMY_GROUNDING_GATE;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CONFIRM_FIRST = 'off';
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  process.env.CLEMMY_GROUNDING_GATE = 'on';
  resetEventLog();
  const { writeToolOutput } = await import('./eventlog.js');
  const grounding = await import('./grounding-gate.js');
  grounding._resetGroundingStateForTests();
  grounding._resetDuplicateStateForTests();
  const sess = createSession({ kind: 'chat' });
  writeToolOutput({
    sessionId: sess.id, callId: 'c_extract', tool: 'run_worker',
    output: 'Eley Law Firm; verified "workers compensation lawyer Denver"; contact cliff@eleylawfirm.com',
  });
  grounding._setGroundingJudgeForTests(async (payload) => payload.includes('Houston')
    ? { grounded: false, reason: 'Payload claims Houston; the extraction artifact says Denver.' }
    : { grounded: true, reason: 'Matches the Denver extraction.' });
  try {
    const counter = new ToolCallsCounter(100);
    const wrapped = wrapToolForHarness({
      name: 'run_shell_command',
      execute: async (_input: unknown) => 'posted',
    });
    const post = (city: string) =>
      raiseSoftRefusal(withHarnessRunContext({ sessionId: sess.id, counter }, () =>
        wrapped.execute!({
          command: `curl -X POST https://api.example.com/send -d '{"to_email":"cliff@eleylawfirm.com","body":"${city} comp search gap"}'`,
        })));
    // Corrupted payload (Houston) → grounding soft-blocks the shell send.
    await assert.rejects(() => Promise.resolve(post('Houston')), (err: Error) => {
      assert.match(err.message, /GROUNDING_CHECK_FAILED/);
      assert.match(err.message, /Denver/);
      return true;
    });
    // Corrected payload (Denver) → allowed; the shared external_write is recorded.
    assert.equal(await post('Denver'), 'posted');
    const { listEvents } = await import('./eventlog.js');
    assert.ok(
      listEvents(sess.id, { types: ['external_write'] }).some((e) => (e.data as { shell?: boolean }).shell === true),
      'a shell external_write was recorded',
    );
    // A plain read curl (GET) is NOT gated.
    const readCurl = wrapToolForHarness({ name: 'run_shell_command', execute: async () => 'ok' });
    assert.equal(
      await withHarnessRunContext({ sessionId: sess.id, counter }, () => readCurl.execute!({ command: 'curl -s https://api.example.com/status' })),
      'ok',
    );
  } finally {
    grounding._setGroundingJudgeForTests(null);
    process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
    process.env.CLEMMY_CONFIRM_FIRST = prevConfirm;
    process.env.CLEMMY_EXECUTION_GATE = prevExecGate;
    if (prevGrounding === undefined) delete process.env.CLEMMY_GROUNDING_GATE; else process.env.CLEMMY_GROUNDING_GATE = prevGrounding;
  }
});

test('parallel shell pre-write gates consume the prestarted output-grounding promise exactly once', async () => {
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const prevConfirm = process.env.CLEMMY_CONFIRM_FIRST;
  const prevExecGate = process.env.CLEMMY_EXECUTION_GATE;
  const prevGrounding = process.env.CLEMMY_GROUNDING_GATE;
  const prevDestination = process.env.CLEMMY_DESTINATION_GATE;
  const prevGoal = process.env.CLEMMY_GOAL_FIDELITY_GATE;
  const prevOutput = process.env.CLEMMY_OUTPUT_GROUNDING_GATE;
  const prevParallel = process.env.CLEMMY_PARALLEL_PREWRITE_GATES;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CONFIRM_FIRST = 'off';
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  process.env.CLEMMY_GROUNDING_GATE = 'off';
  process.env.CLEMMY_DESTINATION_GATE = 'off';
  process.env.CLEMMY_GOAL_FIDELITY_GATE = 'off';
  process.env.CLEMMY_OUTPUT_GROUNDING_GATE = 'on';
  process.env.CLEMMY_PARALLEL_PREWRITE_GATES = 'on';
  resetEventLog();
  const output = await import('./output-grounding-gate.js');
  output._resetOutputGroundingStateForTests();
  const sess = createSession({ kind: 'chat' });
  writeToolOutput({
    sessionId: sess.id,
    callId: 'analytics-source',
    tool: 'analytics_lookup',
    output: 'Acme campaign source rows: ad spend was $1,000 and conversions were 25.',
  });
  let judgeCalls = 0;
  output._setOutputGroundingJudgeForTests(async () => {
    judgeCalls += 1;
    return { verdict: 'grounded', offending: [], reason: 'plausibly derived from source rows' };
  });
  try {
    const counter = new ToolCallsCounter(100);
    const wrapped = wrapToolForHarness({
      name: 'run_shell_command',
      execute: async () => 'posted',
    });
    const command = `curl -X POST https://api.example.com/send -d '{"body":"Acme ad spend was $2,400."}'`;
    assert.equal(
      await withHarnessRunContext({ sessionId: sess.id, counter }, () => wrapped.execute!({ command })),
      'posted',
    );
    assert.equal(judgeCalls, 1, 'one shell send must not double-call the output-grounding judge');
  } finally {
    output._setOutputGroundingJudgeForTests(null);
    process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
    process.env.CLEMMY_CONFIRM_FIRST = prevConfirm;
    process.env.CLEMMY_EXECUTION_GATE = prevExecGate;
    if (prevGrounding === undefined) delete process.env.CLEMMY_GROUNDING_GATE; else process.env.CLEMMY_GROUNDING_GATE = prevGrounding;
    if (prevDestination === undefined) delete process.env.CLEMMY_DESTINATION_GATE; else process.env.CLEMMY_DESTINATION_GATE = prevDestination;
    if (prevGoal === undefined) delete process.env.CLEMMY_GOAL_FIDELITY_GATE; else process.env.CLEMMY_GOAL_FIDELITY_GATE = prevGoal;
    if (prevOutput === undefined) delete process.env.CLEMMY_OUTPUT_GROUNDING_GATE; else process.env.CLEMMY_OUTPUT_GROUNDING_GATE = prevOutput;
    if (prevParallel === undefined) delete process.env.CLEMMY_PARALLEL_PREWRITE_GATES; else process.env.CLEMMY_PARALLEL_PREWRITE_GATES = prevParallel;
  }
});

test('shell-send compensation: a FAILED shell network-mutation is netted out — the retry is NOT a false duplicate (review 2026-06-14)', async () => {
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const prevConfirm = process.env.CLEMMY_CONFIRM_FIRST;
  const prevExecGate = process.env.CLEMMY_EXECUTION_GATE;
  const prevGrounding = process.env.CLEMMY_GROUNDING_GATE;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CONFIRM_FIRST = 'off';
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  process.env.CLEMMY_GROUNDING_GATE = 'on';
  resetEventLog();
  const grounding = await import('./grounding-gate.js');
  grounding._resetGroundingStateForTests();
  grounding._resetDuplicateStateForTests();
  grounding._setGroundingJudgeForTests(async () => ({ grounded: true, reason: 'ok' }));
  const sess = createSession({ kind: 'chat' });
  const cmd = `curl -X POST https://api.example.com/send -d '{"to_email":"cliff@eleylawfirm.com"}'`;
  try {
    const counter = new ToolCallsCounter(100);
    // First invocation fails (non-zero exit); second succeeds.
    let attempt = 0;
    const wrapped = wrapToolForHarness({
      name: 'run_shell_command',
      execute: async () => { attempt += 1; return attempt === 1 ? 'exit_code: 28  stderr: curl: (28) timed out' : 'exit_code: 0  stdout: sent'; },
    });
    const post = () => withHarnessRunContext({ sessionId: sess.id, counter }, () => wrapped.execute!({ command: cmd }));
    // 1. First send: grounding passes, the gate records an external_write, the
    //    command FAILS → compensateFailedExternalWrite emits external_write_failed.
    assert.match(String(await post()), /exit_code: 28/);
    const { listEvents } = await import('./eventlog.js');
    assert.ok(listEvents(sess.id, { types: ['external_write_failed'] }).length >= 1, 'failed shell send was compensated');
    // 2. Retry of the SAME target → the failure nets out the prior write, so it is
    //    NOT a DUPLICATE_EXTERNAL_WRITE. Before the fix this threw.
    assert.match(String(await post()), /exit_code: 0/);
  } finally {
    grounding._setGroundingJudgeForTests(null);
    process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
    process.env.CLEMMY_CONFIRM_FIRST = prevConfirm;
    process.env.CLEMMY_EXECUTION_GATE = prevExecGate;
    if (prevGrounding === undefined) delete process.env.CLEMMY_GROUNDING_GATE; else process.env.CLEMMY_GROUNDING_GATE = prevGrounding;
  }
});

test('duplicate-target gate: a FAILED dispatch is netted out — the corrected retry is not a "duplicate" (2026-06-12 live replay)', async () => {
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  const prevConfirm = process.env.CLEMMY_CONFIRM_FIRST;
  const prevExecGate = process.env.CLEMMY_EXECUTION_GATE;
  const prevGrounding = process.env.CLEMMY_GROUNDING_GATE;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CONFIRM_FIRST = 'off';
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  process.env.CLEMMY_GROUNDING_GATE = 'on';
  resetEventLog();
  const { appendEvent, listEvents } = await import('./eventlog.js');
  const grounding = await import('./grounding-gate.js');
  grounding._resetGroundingStateForTests();
  grounding._resetDuplicateStateForTests();
  grounding._setGroundingJudgeForTests(async () => ({ grounded: true, reason: 'ok' }));
  const sess = createSession({ kind: 'chat' });
  try {
    const counter = new ToolCallsCounter(100);
    let nextResult = '';
    const wrapped = wrapToolForHarness({
      name: 'composio_execute_tool',
      execute: async (_input: unknown) => nextResult,
    });
    const send = () =>
      raiseSoftRefusal(withHarnessRunContext({ sessionId: sess.id, counter }, () =>
        wrapped.execute!({
          tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
          arguments: JSON.stringify({ to_email: 'nathan@example.com', subject: 'Gate test', body: 'b' }),
        }),
      ));
    const recordWrite = () => appendEvent({
      sessionId: sess.id, turn: 0, role: 'system', type: 'external_write',
      data: { shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL', toolName: 'composio_execute_tool', irreversible: true, count: 1, underScope: false, targets: ['nathan@example.com', 'example.com'] },
    });

    // 1. The dispatch FAILS HARD at composio validation. The external_write
    //    record still lands (confirm-first emits it pre-dispatch, after the
    //    dup gate passed for that same call — so record it post-call here).
    nextResult = "⚠️ composio_execute_tool FAILED (slug=OUTLOOK_OUTLOOK_SEND_EMAIL): Invalid request data provided - Following fields are missing: {'to_email'}";
    const r1 = String(await send());
    recordWrite();
    assert.match(r1, /FAILED/);
    const failures = listEvents(sess.id, { types: ['external_write_failed'] });
    assert.equal(failures.length, 1, 'hard failure emits the compensation event');

    // 2. The corrected retry must NOT be duplicate-blocked — the only prior
    //    write demonstrably never happened.
    nextResult = 'sent';
    assert.equal(await send(), 'sent', 'corrected retry sails through');

    // 3. A real prior (successful send) STILL trips the bump — netting only
    //    cancels failures, one-for-one.
    recordWrite();
    await assert.rejects(() => Promise.resolve(send()), (err: Error) => {
      assert.match(err.message, /DUPLICATE_EXTERNAL_WRITE/);
      return true;
    });
  } finally {
    grounding._setGroundingJudgeForTests(null);
    process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
    process.env.CLEMMY_CONFIRM_FIRST = prevConfirm;
    process.env.CLEMMY_EXECUTION_GATE = prevExecGate;
    if (prevGrounding === undefined) delete process.env.CLEMMY_GROUNDING_GATE; else process.env.CLEMMY_GROUNDING_GATE = prevGrounding;
  }
});

// ─── Inc A2: mid-runTurn background-offer nudge ──────────────────────────────

test('Inc A2: background-offer nudge appends once after the tool-call floor in a foreground chat', async () => {
  const prevB = process.env.HARNESS_TOOL_BRACKETS;
  const prevN = process.env.CLEMMY_BG_OFFER_NUDGE;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  delete process.env.CLEMMY_BG_OFFER_NUDGE; // default on
  try {
    const sess = createSession({ kind: 'chat' });
    const counter = new ToolCallsCounter(50);
    for (let i = 0; i < 5; i++) counter.increment(); // 5 prior calls this runTurn
    const wrapped = wrapToolForHarness({ name: 'probe', execute: async () => 'tool-output' });
    const ctx = { sessionId: sess.id, counter } as { sessionId: string; counter: ToolCallsCounter; backgroundOfferNudged?: boolean };
    // 6th call crosses the floor → nudge appended to the tool result.
    const res = (await withHarnessRunContext(ctx, async () => wrapped.execute!({}))) as string;
    assert.match(res, /tool-output/, 'real tool output preserved');
    assert.match(res, /\[background offer\]/, 'crossing the 6-call floor appends the offer nudge');
    assert.match(res, /offer_background/, 'nudge names the tool to call');
    // At most once per runTurn (same ctx → flag set).
    const res2 = (await withHarnessRunContext(ctx, async () => wrapped.execute!({}))) as string;
    assert.doesNotMatch(res2, /\[background offer\]/, 'nudge fires at most once per runTurn');
  } finally {
    process.env.HARNESS_TOOL_BRACKETS = prevB;
    if (prevN === undefined) delete process.env.CLEMMY_BG_OFFER_NUDGE; else process.env.CLEMMY_BG_OFFER_NUDGE = prevN;
  }
});

test('Inc A2: no offer nudge below the floor, with the kill-switch off, or in a non-chat session', async () => {
  const prevB = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  const run = async (sessionId: string, priorCalls: number): Promise<string> => {
    const counter = new ToolCallsCounter(50);
    for (let i = 0; i < priorCalls; i++) counter.increment();
    const wrapped = wrapToolForHarness({ name: 'probe', execute: async () => 'out' });
    return (await withHarnessRunContext({ sessionId, counter }, async () => wrapped.execute!({}))) as string;
  };
  try {
    // below the floor (2 calls) → no nudge
    const chatA = createSession({ kind: 'chat' });
    assert.doesNotMatch(await run(chatA.id, 1), /\[background offer\]/, 'below floor → no nudge');
    // kill-switch off → no nudge even past the floor
    process.env.CLEMMY_BG_OFFER_NUDGE = 'off';
    const chatB = createSession({ kind: 'chat' });
    assert.doesNotMatch(await run(chatB.id, 5), /\[background offer\]/, '=off → no nudge');
    delete process.env.CLEMMY_BG_OFFER_NUDGE;
    // non-chat (execution) session → no nudge (offering to background a background run is nonsensical)
    const exec = createSession({ kind: 'execution' });
    assert.doesNotMatch(await run(exec.id, 5), /\[background offer\]/, 'non-chat → no nudge');
  } finally {
    process.env.HARNESS_TOOL_BRACKETS = prevB;
    delete process.env.CLEMMY_BG_OFFER_NUDGE;
  }
});

// ─── Certified-batch item: skip the per-item LLM judge tax ─────────────────
// A run_batch execute (approved + certified) byte-pins its payloads by
// payloadHash, so re-judging each item at the write boundary is latency, not
// safety. ctx.certifiedBatch skips goal-fidelity + output-grounding; every
// deterministic gate still runs; ad-hoc dispatches keep full judging.
async function runCertifiedSendProbe(opts: { certifiedBatch?: { batchId: string; payloadHash: string }; killSwitchOff?: boolean }) {
  resetEventLog();
  const { _setGoalFidelityJudgeForTests, _resetGoalFidelityStateForTests } = await import('./goal-fidelity-gate.js');
  const saved: Record<string, string | undefined> = {
    HARNESS_TOOL_BRACKETS: process.env.HARNESS_TOOL_BRACKETS,
    CLEMMY_GROUNDING_GATE: process.env.CLEMMY_GROUNDING_GATE,
    CLEMMY_OUTPUT_GROUNDING_GATE: process.env.CLEMMY_OUTPUT_GROUNDING_GATE,
    CLEMMY_BATCH_SKIP_ITEM_JUDGE: process.env.CLEMMY_BATCH_SKIP_ITEM_JUDGE,
  };
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  // Isolate goal-fidelity: the other two per-write judges are off so the counter
  // reflects ONLY whether the goal-fidelity judge ran.
  process.env.CLEMMY_GROUNDING_GATE = 'off';
  process.env.CLEMMY_OUTPUT_GROUNDING_GATE = 'off';
  if (opts.killSwitchOff) process.env.CLEMMY_BATCH_SKIP_ITEM_JUDGE = 'off';
  else delete process.env.CLEMMY_BATCH_SKIP_ITEM_JUDGE;
  let judgeCalls = 0;
  _resetGoalFidelityStateForTests();
  _setGoalFidelityJudgeForTests(async () => { judgeCalls += 1; return { fulfills: true, gap: 'ok' }; });
  try {
    const sess = createSession({ kind: 'chat' }).id;
    // A goal (re-derived from the user's ask) so the goal-fidelity judge WOULD fire.
    appendEvent({ sessionId: sess, turn: 0, role: 'user', type: 'user_input_received', data: { text: 'Send 10 personalized intro emails to the prospect list I approved.' } });
    let invoked = 0;
    const wrapped = wrapToolForHarness({ name: 'composio_execute_tool', invoke: async () => { invoked += 1; return 'OK sent'; } }, {});
    const args = { tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL', arguments: JSON.stringify({ to_email: 'a@firm.com', subject: 's', body: 'hello there, a personalized note for you' }) };
    const counter = new ToolCallsCounter(100);
    await withHarnessRunContext(
      { sessionId: sess, counter, ...(opts.certifiedBatch ? { certifiedBatch: opts.certifiedBatch } : {}) },
      () => (wrapped as unknown as { invoke: (rc: unknown, i: unknown, d: unknown) => Promise<unknown> })
        .invoke({ context: { sessionId: sess } }, JSON.stringify(args), { toolCall: { callId: 'c-probe' } }),
    );
    const skipEvents = listEvents(sess, { types: ['guardrail_tripped'] })
      .filter((e) => (e.data as { kind?: string }).kind === 'batch_certified_judge_skip');
    return { invoked, judgeCalls, skipEvents };
  } finally {
    _setGoalFidelityJudgeForTests(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('certified-batch item SKIPS the per-item goal-fidelity judge but still hits the write boundary', async () => {
  const r = await runCertifiedSendProbe({ certifiedBatch: { batchId: 'batch-cert-1', payloadHash: 'ph-abc' } });
  assert.equal(r.judgeCalls, 0, 'the per-item goal-fidelity judge was skipped for a certified item');
  assert.equal(r.skipEvents.length, 1, 'the skip is visible in the trace');
  assert.equal((r.skipEvents[0].data as { judgeSkipped?: string }).judgeSkipped, 'batch_certified');
  assert.equal(r.invoked, 1, 'the write still executed through the boundary');
});

test('ad-hoc write (no certifiedBatch ctx) STILL runs the per-item goal-fidelity judge', async () => {
  const r = await runCertifiedSendProbe({});
  assert.equal(r.judgeCalls, 1, 'an uncertified write keeps full per-item judging');
  assert.equal(r.skipEvents.length, 0, 'no skip event for an ad-hoc write');
  assert.equal(r.invoked, 1);
});

test('kill-switch CLEMMY_BATCH_SKIP_ITEM_JUDGE=off restores per-item judging for a certified item', async () => {
  const r = await runCertifiedSendProbe({ certifiedBatch: { batchId: 'batch-cert-2', payloadHash: 'ph-xyz' }, killSwitchOff: true });
  assert.equal(r.judgeCalls, 1, 'kill-switch off ⇒ the judge runs even for a certified item');
  assert.equal(r.skipEvents.length, 0, 'no skip event when disabled');
});

// ─── P0c: a JUDGE FAILURE on an irreversible action mints an approval card ───
async function runJudgeFailSendProbe(opts: {
  killSwitchOff?: boolean;
  judge: 'timeout' | 'genuine_block';
  targetEmail?: string;
} = { judge: 'timeout' }) {
  resetEventLog();
  rmSync(path.join(TMP_HOME, 'pending-actions'), { recursive: true, force: true });
  const { _setGoalFidelityJudgeForTests, _resetGoalFidelityStateForTests } = await import('./goal-fidelity-gate.js');
  const { listPendingActions } = await import('./pending-actions.js');
  const SEND = 'OUTLOOK_OUTLOOK_SEND_EMAIL';
  const OPENING = 'Our agency helps law firms dominate local search with SEO, paid media, and conversion-focused websites.';
  const saved: Record<string, string | undefined> = {
    HARNESS_TOOL_BRACKETS: process.env.HARNESS_TOOL_BRACKETS,
    CLEMMY_GROUNDING_GATE: process.env.CLEMMY_GROUNDING_GATE,
    CLEMMY_OUTPUT_GROUNDING_GATE: process.env.CLEMMY_OUTPUT_GROUNDING_GATE,
    CLEMMY_JUDGE_FAIL_APPROVAL: process.env.CLEMMY_JUDGE_FAIL_APPROVAL,
  };
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_GROUNDING_GATE = 'off';
  process.env.CLEMMY_OUTPUT_GROUNDING_GATE = 'off';
  if (opts.killSwitchOff) process.env.CLEMMY_JUDGE_FAIL_APPROVAL = 'off';
  else delete process.env.CLEMMY_JUDGE_FAIL_APPROVAL;
  _resetGoalFidelityStateForTests();
  const seedSend = (slug: string, toEmail: string, sess: string, cid: string) =>
    appendEvent({ sessionId: sess, turn: 0, role: 'orchestrator', type: 'tool_called', data: { tool: 'composio_execute_tool', callId: cid, arguments: JSON.stringify({ tool_slug: slug, arguments: JSON.stringify({ to_email: toEmail, subject: 's', body: OPENING }) }) } });
  try {
    const sess = createSession({ kind: 'chat' }).id;
    appendEvent({ sessionId: sess, turn: 0, role: 'user', type: 'user_input_received', data: { text: 'Send the 10 approved intro emails to the prospect list.' } });
    if (opts.judge === 'timeout') {
      // Two prior byte-identical sends to DISTINCT targets → a burst is in flight,
      // so a judge OUTAGE fails CLOSED (the exact live scenario).
      seedSend(SEND, 'a@firm-a.com', sess, 's1');
      seedSend(SEND, 'b@firm-b.com', sess, 's2');
      _setGoalFidelityJudgeForTests(async () => { throw new Error('judge timed out'); });
    } else {
      // A GENUINE gap verdict with a loaded skill → hard block, NOT a judge failure.
      const scid = 'skill_1';
      appendEvent({ sessionId: sess, turn: 0, role: 'orchestrator', type: 'tool_called', data: { tool: 'skill_read', callId: scid, arguments: JSON.stringify({ name: 'outbound' }) } });
      writeToolOutput({ sessionId: sess, callId: scid, tool: 'skill_read', output: 'SKILL: outbound\n(manifest)\n---\nResearch each firm and personalize the opening per firm before sending.' });
      _setGoalFidelityJudgeForTests(async () => ({ fulfills: false, gap: 'the opening is identical across firms — per-firm research was skipped' }));
    }
    let invoked = 0;
    const wrapped = wrapToolForHarness({ name: 'composio_execute_tool', invoke: async () => { invoked += 1; return 'OK sent'; } }, {});
    const args = { tool_slug: SEND, arguments: JSON.stringify({ to_email: opts.targetEmail ?? 'c@firm-c.com', subject: 's', body: OPENING }) };
    const counter = new ToolCallsCounter(100);
    const result = String(await withHarnessRunContext(
      { sessionId: sess, counter },
      () => (wrapped as unknown as { invoke: (rc: unknown, i: unknown, d: unknown) => Promise<unknown> })
        .invoke({ context: { sessionId: sess } }, JSON.stringify(args), { toolCall: { callId: 'c-jf' } }),
    ));
    return { invoked, result, pending: listPendingActions({ status: 'all', limit: 100 }), sess };
  } finally {
    _setGoalFidelityJudgeForTests(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('P0c: a goal-fidelity judge OUTAGE on an irreversible send refuses AND mints ONE pending-approval card (names its id)', async () => {
  const r = await runJudgeFailSendProbe({ judge: 'timeout' });
  assert.equal(r.invoked, 0, 'the send was refused (not fired unjudged)');
  assert.match(r.result, /Tool call refused by harness/i, 'still a refusal');
  assert.equal(r.pending.length, 1, 'exactly one pending-approval card was minted');
  assert.equal(r.pending[0].toolName, 'composio_execute_tool');
  assert.match(r.pending[0].title, /Judge couldn't verify/i);
  assert.match(r.result, new RegExp(r.pending[0].id), 'the tool result names the pending action id so the model can tell the user');
  assert.match(r.result, /do NOT retry the send yourself/i);
});

test('P0c: a repeated judge-fail on the SAME payload dedups — no second card', async () => {
  // First mint.
  await runJudgeFailSendProbe({ judge: 'timeout', targetEmail: 'dedup@firm.com' });
  // Second identical attempt in the same run would loop a batch; assert dedup by
  // driving a fresh probe that reuses the same payload against the same open card.
  const { listPendingActions, findOpenPendingActionByPayload } = await import('./pending-actions.js');
  // The probe resets the event log + pending dir each call, so instead assert the
  // helper directly: an open card for a payload is found and reused, not duplicated.
  const r = await runJudgeFailSendProbe({ judge: 'timeout', targetEmail: 'dedup2@firm.com' });
  assert.equal(r.pending.length, 1, 'one card for the run');
  // Re-minting the SAME payload finds the existing open card (dedup guard).
  const again = findOpenPendingActionByPayload(r.pending[0].toolName, r.pending[0].payload);
  assert.ok(again && again.id === r.pending[0].id, 'the open card is reused for an identical payload');
  assert.equal(listPendingActions({ status: 'all', limit: 100 }).length, 1, 'still exactly one card');
});

test('P0c: a GENUINE fidelity gap (not a judge failure) refuses with NO pending card (unchanged)', async () => {
  const r = await runJudgeFailSendProbe({ judge: 'genuine_block' });
  assert.equal(r.invoked, 0, 'the send is still refused');
  assert.match(r.result, /Tool call refused by harness/i);
  assert.equal(r.pending.length, 0, 'a genuine verdict block mints NO approval card');
});

test('P0c: kill-switch CLEMMY_JUDGE_FAIL_APPROVAL=off restores plain refusal (no card)', async () => {
  const r = await runJudgeFailSendProbe({ judge: 'timeout', killSwitchOff: true });
  assert.equal(r.invoked, 0, 'still refused');
  assert.equal(r.pending.length, 0, 'kill-switch off ⇒ no pending card minted');
});
