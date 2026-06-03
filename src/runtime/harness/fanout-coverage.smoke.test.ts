/**
 * Run: npx tsx --test src/runtime/harness/fanout-coverage.smoke.test.ts
 *
 * Synthetic fan-out coverage replay (FIX 1.3 + FIX 7, flags ON). Drives the
 * REAL run-hooks (attachEventLogHooks → onToolEnd) with N run_worker results —
 * some succeeding, some returning ERROR:, some empty (the turn-cap soft-convert
 * case) — and proves the coverage path end-to-end:
 *   (a) failing/empty workers are normalized to ERROR: and counted as failed,
 *   (b) successful siblings are still counted done (no aborted batch),
 *   (c) classifyBackgroundTaskOutcome reports "M of N failed", not a hollow done.
 *
 * Offline + deterministic. The real-model fan-out run (a live campaign) is the
 * owner-gated final step — never run against live APIs here.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-fanout-cov-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_FANOUT_LEDGER = 'on';
process.env.CLEMMY_WORKER_THRASH_GUARD = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { attachEventLogHooks, extractSessionIdFromContext } = await import('./hooks.js');
const { resetEventLog, createSession, listEvents } = await import('./eventlog.js');
const { summarizeLedger, clearLedger } = await import('./fanout-ledger.js');
const { classifyBackgroundTaskOutcome } = await import('../../execution/background-tasks.js');
const { normalizeWorkerOutput } = await import('../../agents/worker-output.js');

type RunHooksLike = import('./hooks.js').RunHooksLike;

test.after(() => {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function makeStub(): RunHooksLike & { emit: EventEmitter['emit'] } {
  const ee = new EventEmitter();
  return {
    on: (event, listener) => ee.on(event, listener),
    off: (event, listener) => ee.off(event, listener),
    emit: ee.emit.bind(ee),
  };
}
function ctx(sessionId: string): unknown {
  return { context: { sessionId, turn: 0 } };
}

test('synthetic fan-out: failing items are counted failed, siblings done, run reports M of N', () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const runSessionId = sess.id;
  clearLedger(runSessionId);
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });

  // 10 workers: 7 succeed, 2 return ERROR:, 1 returns the SDK generic
  // turn-cap string (FIX 1.3 normalizes that empty/error result to ERROR:).
  const N = 10;
  const failedIds = new Set([3, 6]);
  const turnCapId = 9;
  for (let i = 1; i <= N; i++) {
    const callId = `call_w${i}`;
    const item = `Firm ${i}`;
    stub.emit('agent_tool_start', ctx(runSessionId), { name: 'orchestrator' }, { name: 'run_worker' },
      { toolCall: { callId, arguments: JSON.stringify({ item, objective: 'enrich', resolvedTools: 'x', context: 'x', instructions: 'x', expectedOutput: 'x' }) } });

    let raw: string;
    if (failedIds.has(i)) raw = `ERROR: ${item} had no contact email on file`;
    else if (i === turnCapId) raw = 'An error occurred while running the tool. Please try again. Error: Max turns (8) exceeded';
    else raw = `Enriched ${item}: DA 40, top kw pos 3`;

    // The brackets run_worker branch applies normalizeWorkerOutput before the
    // result reaches the hook; mirror that here so the test exercises the same
    // string the ledger sees in production.
    const normalized = normalizeWorkerOutput(raw);
    stub.emit('agent_tool_end', ctx(runSessionId), { name: 'orchestrator' }, { name: 'run_worker' },
      normalized, { toolCall: { callId } });
  }

  // (a)+(b): coverage counts — 3 failed (2 explicit ERROR + 1 turn-cap), 7 done.
  const cov = summarizeLedger(runSessionId);
  assert.equal(cov.total, N, 'every worker recorded — no item silently dropped');
  assert.equal(cov.failed, 3, '2 ERROR + 1 turn-cap-normalized = 3 failed');
  assert.equal(cov.done, 7, 'the 7 successful siblings still counted done (batch not aborted)');
  assert.ok(cov.failedItems.includes('Firm 3') && cov.failedItems.includes('Firm 6'), 'failed items labeled');
  assert.ok(cov.failedItems.includes('Firm 9'), 'the turn-capped worker is reported failed, not a hollow done');

  // (c): the run reports partial coverage, NOT a hollow done.
  const outcome = classifyBackgroundTaskOutcome({ runSessionId }, 'Enriched the firms.');
  assert.equal(outcome.outcome, 'blocked', 'a partial batch must not report done');
  assert.match(outcome.reason ?? '', /7\/10 items done, 3 failed/);

  // (d): the turn-capped worker emits always-on worker_capped telemetry (the
  // only signal of worker turn-ceiling hits — feeds maxTurns recalibration).
  const capped = listEvents(runSessionId, { types: ['worker_capped'] });
  assert.equal(capped.length, 1, 'the turn-capped worker logs exactly one worker_capped event');
  assert.equal((capped[0].data as { item?: string }).item, 'Firm 9');
  clearLedger(runSessionId);
});

test('synthetic fan-out: a fully-successful batch still reports done', () => {
  resetEventLog();
  const sess = createSession({ kind: 'execution' });
  const runSessionId = sess.id;
  clearLedger(runSessionId);
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });

  for (let i = 1; i <= 5; i++) {
    const callId = `ok_w${i}`;
    stub.emit('agent_tool_start', ctx(runSessionId), { name: 'orchestrator' }, { name: 'run_worker' },
      { toolCall: { callId, arguments: JSON.stringify({ item: `Firm ${i}` }) } });
    stub.emit('agent_tool_end', ctx(runSessionId), { name: 'orchestrator' }, { name: 'run_worker' },
      `Enriched Firm ${i}`, { toolCall: { callId } });
  }
  assert.equal(summarizeLedger(runSessionId).failed, 0);
  assert.equal(classifyBackgroundTaskOutcome({ runSessionId }, 'All done.').outcome, 'done');
  clearLedger(runSessionId);
});
