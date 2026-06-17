/**
 * Run: npx tsx --test src/runtime/harness/worker-thrash.test.ts
 *
 * FIX 1.1 — per-worker loop-guard isolation. The 44-attorney batch
 * (sess-mpx56kgj) fanned out 44 workers that all shared ONE loop-guard
 * tracker (workers inherit the parent sessionId via AsyncLocalStorage), so
 * their identical-shape calls aggregated and tripped the guard 72× → the run
 * was cancelled. These tests prove (a) the shared-tracker poison is real and
 * (b) keying the guard by a per-worker guardrailScopeId isolates each worker
 * so a sibling's repeats can't trip another's guard.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-worker-thrash-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { evaluateToolCall, _resetAllTrackersForTests } = await import('./tool-guardrail.js');
const {
  wrapToolForHarness,
  withHarnessRunContext,
  workerThrashGuardEnabled,
  ToolCallsCounter,
} = await import('./brackets.js');

test.after(() => {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const MUT_ARGS = { tool_slug: 'OUTLOOK_SEND_EMAIL', arguments: '{"to":"x@y.com"}' };

test('shared loop-guard key: identical mutating calls AGGREGATE and trip the block (the 44-worker poison)', () => {
  _resetAllTrackersForTests();
  // Simulate 5 workers each making ONE identical-shape mutating call, all
  // keyed on the same parent session (today's behavior, flag off).
  let last;
  for (let i = 0; i < 5; i++) {
    last = evaluateToolCall('parent-sess', 'composio_execute_tool', MUT_ARGS);
  }
  assert.equal(last!.action, 'block', '5 identical mutating calls on ONE key must trip the block');
});

test('per-worker keys ISOLATE the guard: 4 identical calls per worker never trip', () => {
  _resetAllTrackersForTests();
  // Same 8 calls, but split across two per-worker scope keys (4 each).
  for (let i = 0; i < 4; i++) {
    const a = evaluateToolCall('parent-sess::w:A', 'composio_execute_tool', MUT_ARGS);
    const b = evaluateToolCall('parent-sess::w:B', 'composio_execute_tool', MUT_ARGS);
    assert.notEqual(a.action, 'block', `worker A call ${i + 1} must not block`);
    assert.notEqual(a.action, 'escalate', `worker A call ${i + 1} must not escalate`);
    assert.notEqual(b.action, 'block', `worker B call ${i + 1} must not block`);
  }
});

test('flag helper: CLEMMY_WORKER_THRASH_GUARD defaults ON, honors the off kill-switch', () => {
  const prev = process.env.CLEMMY_WORKER_THRASH_GUARD;
  try {
    delete process.env.CLEMMY_WORKER_THRASH_GUARD;
    assert.equal(workerThrashGuardEnabled(), true, 'default on (validated live)');
    process.env.CLEMMY_WORKER_THRASH_GUARD = 'off';
    assert.equal(workerThrashGuardEnabled(), false, 'off is the kill-switch');
    process.env.CLEMMY_WORKER_THRASH_GUARD = 'on';
    assert.equal(workerThrashGuardEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_WORKER_THRASH_GUARD;
    else process.env.CLEMMY_WORKER_THRASH_GUARD = prev;
  }
});

test('runBrackets keys the guard by guardrailScopeId when set (plumbing)', async () => {
  const prevBrackets = process.env.HARNESS_TOOL_BRACKETS;
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  _resetAllTrackersForTests();
  try {
    const counter = new ToolCallsCounter(1000);
    // write_file is mutating → its exact-args block is NOT demoted by applyMode,
    // so on the trip the wrapper surfaces a SOFT tool-error string (both wrapper
    // paths share that disposition now — see softToolError).
    const wrapped = wrapToolForHarness({
      name: 'write_file',
      execute: async (_input: unknown) => 'ok',
    });

    // Two per-worker scopes, 4 identical calls each → neither trips (isolated).
    for (const scope of ['p::w:A', 'p::w:B']) {
      await withHarnessRunContext(
        { sessionId: 'p', counter, guardrailScopeId: scope },
        async () => {
          for (let i = 0; i < 4; i++) {
            assert.equal(await wrapped.execute!({ path: 'a', content: 'same' }), 'ok',
              `${scope} call ${i + 1} should pass (isolated window)`);
          }
        },
      );
    }

    // Contrast: NO scope id (all share sessionId) → the 5th identical call trips.
    _resetAllTrackersForTests();
    await withHarnessRunContext(
      { sessionId: 'p2', counter },
      async () => {
        for (let i = 0; i < 4; i++) await wrapped.execute!({ path: 'a', content: 'same' });
        const blocked = await wrapped.execute!({ path: 'a', content: 'same' });
        assert.match(String(blocked), /Tool call refused by harness: tool-call guardrail/,
          'shared-key 5th identical mutating call must block (soft tool error)');
      },
    );
  } finally {
    if (prevBrackets === undefined) delete process.env.HARNESS_TOOL_BRACKETS;
    else process.env.HARNESS_TOOL_BRACKETS = prevBrackets;
  }
});
