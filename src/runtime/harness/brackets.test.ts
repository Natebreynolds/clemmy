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
const { resetEventLog, createSession, requestKill, appendEvent, writeToolOutput } = await import('./eventlog.js');
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
  harnessToolBracketsEnabled,
  softToolError,
  parallelPreWriteGatesEnabled,
  startGate,
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

    // Approving a plan opens a scope that covers the rest of the batch.
    openPlanScope({
      sessionId: sess.id,
      planProposalId: 'plan-test',
      approvedPlanObjective: 'Send the reviewed batch of emails',
      allowedTools: ['composio_execute_tool'],
    });
    assert.ok(String(await sendNo(5)).startsWith('sent'), 'write passes once a plan scope exists');

    // Closing the scope re-arms the gate.
    closePlanScope(sess.id, 'test');
    await assert.rejects(async () => { await sendNo(6); }, (err: Error) => /CONFIRM_FIRST_REQUIRED/.test(err.message));
  } finally {
    process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
    process.env.CLEMMY_CONFIRM_FIRST = prevConfirm;
    process.env.CLEMMY_EXECUTION_GATE = prevExecGate;
  }
});

test('confirm-first gate: YOLO standing approval lets an irreversible batch run without a plan scope', async () => {
  // Regression for the 2026-06-02 live incident: in YOLO the user has granted
  // STANDING approval, but the batch gate (an approval gate) still tripped on
  // the 5th send and demanded a plan the user had already approved. YOLO must
  // skip the block while still RECORDING each write for batch-count continuity.
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
    const sendNo = (n: number) =>
      withHarnessRunContext({ sessionId: sess.id, counter }, () =>
        wrapped.execute!({ tool_slug: 'OUTLOOK_SEND_EMAIL', arguments: JSON.stringify({ to: `person${n}@x.com` }) }),
      );
    // 8 irreversible sends, well past the threshold of 5 — ALL pass in YOLO,
    // no plan scope ever opened.
    for (let n = 1; n <= 8; n += 1) {
      assert.ok(String(await sendNo(n)).startsWith('sent'), `YOLO send #${n} should pass (standing approval)`);
    }
    // Continuity preserved: each allowed write was still recorded so the batch
    // count stays accurate if the user later leaves YOLO mid-session.
    const writes = listEvents(sess.id, { types: ['external_write'] });
    assert.equal(writes.length, 8, 'every YOLO write should still be recorded for batch-count continuity');
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
    // …and the conscious retry passes (speed bump, not a wall).
    assert.equal(await send('Denver comp search gap'), 'sent');
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
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CONFIRM_FIRST = 'off';
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  process.env.CLEMMY_GROUNDING_GATE = 'off';
  process.env.CLEMMY_DESTINATION_GATE = 'on';
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
