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
 *   - timeoutForTool picks shell/MCP/default budgets correctly
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
const { resetEventLog, createSession, requestKill } = await import('./eventlog.js');
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
  DEFAULT_TIMEOUTS_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_TOOL_CALLS_PER_TURN,
  wrapToolForHarness,
  withHarnessRunContext,
} = await import('./brackets.js');

test.after(() => {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
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
          () => wrapped.execute!({}),
          (err: Error) => err instanceof ToolCallsLimitExceeded,
        );
      },
    );
    // The crucial assertion — execute MUST NOT have run when the
    // pre-increment check throws.
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
