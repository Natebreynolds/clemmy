/**
 * Run: npx tsx --test src/runtime/harness/run-token-budget.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-run-token-budget-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  accrueSessionTokens,
  createSession,
  getSession,
  getSessionTokensUsed,
  sumSessionTokensUsedByPrefix,
  updateSession,
} = await import('./eventlog.js');
const {
  budgetLine,
  budgetLineFor,
  checkRunTokenWindow,
  formatTokens,
  openRunTokenWindow,
  resolveRunTokenCeiling,
  runTokenBudgetEnforcementEnabled,
} = await import('./run-token-budget.js');
const { recordModelUsage } = await import('../usage-log.js');
const { recordCodexHarnessUsage } = await import('./codex-model.js');
const { harnessRunContextStorage, ToolCallsCounter } = await import('./brackets.js');

let seq = 0;
function freshSession(): string {
  seq += 1;
  const id = `budget-test-${Date.now().toString(36)}-${seq}`;
  createSession({ id, kind: 'chat' } as never);
  return id;
}

afterEach(() => {
  delete process.env.CLEMMY_RUN_TOKEN_BUDGET;
  delete process.env.HARNESS_MAX_RUN_TOKENS;
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The meter: atomic accrual into the (previously dead) sessions column
// ---------------------------------------------------------------------------

test('accrueSessionTokens: concurrent increments sum exactly (no lost updates)', async () => {
  const sess = freshSession();
  await Promise.all(Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() => accrueSessionTokens(sess, i + 1))));
  assert.equal(getSessionTokensUsed(sess), (50 * 51) / 2);
});

test('accrueSessionTokens: an interleaved updateSession(status) patch cannot erase spend', () => {
  const sess = freshSession();
  accrueSessionTokens(sess, 1_000);
  // Simulate the race: a status patch built from a snapshot taken before more spend lands.
  accrueSessionTokens(sess, 2_000);
  updateSession(sess, { status: 'completed' });
  assert.equal(getSessionTokensUsed(sess), 3_000, 'the blanket UPDATE never touches tokens_used');
  // An EXPLICIT tokensUsed patch still works (the only sanctioned writer besides accrual).
  updateSession(sess, { tokensUsed: 5 });
  assert.equal(getSessionTokensUsed(sess), 5);
});

test('accrueSessionTokens: missing session and junk deltas are silent no-ops', () => {
  assert.equal(accrueSessionTokens('no-such-session', 100), false);
  const sess = freshSession();
  assert.equal(accrueSessionTokens(sess, 0), false);
  assert.equal(accrueSessionTokens(sess, -50), false);
  assert.equal(accrueSessionTokens(sess, Number.NaN), false);
  assert.equal(getSessionTokensUsed(sess), 0);
});

test('recordModelUsage accrues UNCACHED tokens to the source session', () => {
  const sess = freshSession();
  recordModelUsage({
    sessionId: sess,
    model: 'test-model',
    inputTokens: 100_000,
    cachedInputTokens: 80_000,
    outputTokens: 5_000,
    totalTokens: 105_000,
  });
  assert.equal(getSessionTokensUsed(sess), 25_000, 'cache reads never eat the ceiling');
});

test('recordCodexHarnessUsage records under the ALS run session (the false-pass fix)', () => {
  const sess = freshSession();
  harnessRunContextStorage.run({ sessionId: sess, counter: new ToolCallsCounter(100) }, () => {
    recordCodexHarnessUsage(
      { input_tokens: 10_000, output_tokens: 2_000, total_tokens: 12_000, input_tokens_details: { cached_tokens: 4_000 } },
      'gpt-5.6-codex',
      'resp-1',
    );
  });
  assert.equal(getSessionTokensUsed(sess), 8_000, 'the Codex harness lane now meters (uncached)');
});

test('sumSessionTokensUsedByPrefix sums a workflow run and escapes LIKE metacharacters', () => {
  const runId = `wfrun${Date.now().toString(36)}`;
  createSession({ id: `workflow:${runId}:step-a`, kind: 'execution' } as never);
  createSession({ id: `workflow:${runId}:step-b`, kind: 'execution' } as never);
  createSession({ id: `workflow:${runId}x:decoy`, kind: 'execution' } as never);
  accrueSessionTokens(`workflow:${runId}:step-a`, 300);
  accrueSessionTokens(`workflow:${runId}:step-b`, 700);
  accrueSessionTokens(`workflow:${runId}x:decoy`, 999);
  assert.equal(sumSessionTokensUsedByPrefix(`workflow:${runId}:`), 1_000);
});

// ---------------------------------------------------------------------------
// The window: baseline math, thresholds, ceiling resolution
// ---------------------------------------------------------------------------

test('resolveRunTokenCeiling precedence: override → env/preset default; 0 = unlimited', () => {
  assert.equal(resolveRunTokenCeiling({ override: 5_000_000, budget: { maxRunTokens: 10_000_000 } }), 5_000_000);
  assert.equal(resolveRunTokenCeiling({ override: 0, budget: { maxRunTokens: 10_000_000 } }), 0, 'explicit 0 = unlimited wins');
  assert.equal(resolveRunTokenCeiling({ budget: { maxRunTokens: 10_000_000 } }), 10_000_000);
  assert.equal(resolveRunTokenCeiling({ budget: { maxRunTokens: 0 } }), 0);
});

test('window math: a run parks on ITS OWN spend, never on session history', () => {
  const sess = freshSession();
  accrueSessionTokens(sess, 9_000_000); // a week of prior chat history
  const window = openRunTokenWindow({ sessionId: sess, ceiling: 1_000_000 });
  assert.equal(checkRunTokenWindow(window).exceeded, false, 'history is behind the baseline');
  accrueSessionTokens(sess, 999_999);
  assert.equal(checkRunTokenWindow(window).exceeded, false);
  accrueSessionTokens(sess, 1);
  const status = checkRunTokenWindow(window);
  assert.equal(status.exceeded, true);
  assert.equal(status.usedWindow, 1_000_000);
  assert.equal(status.usedLifetime, 10_000_000);
});

test('window math: a durable caller-provided baseline aggregates across the whole chain', () => {
  const sess = freshSession();
  accrueSessionTokens(sess, 500);
  const baseline = getSessionTokensUsed(sess);
  const window = openRunTokenWindow({ sessionId: sess, ceiling: 1_000, baseline });
  // Three "auto-continue cycles", each under the ceiling alone:
  accrueSessionTokens(sess, 400);
  assert.equal(checkRunTokenWindow(window).exceeded, false);
  accrueSessionTokens(sess, 400);
  assert.equal(checkRunTokenWindow(window).exceeded, false);
  accrueSessionTokens(sess, 400);
  assert.equal(checkRunTokenWindow(window).exceeded, true, 'the chain aggregates past the ceiling');
  // A user continue = a NEW window at the current counter → fresh budget, no re-park loop.
  const rearmed = openRunTokenWindow({ sessionId: sess, ceiling: 1_000 });
  assert.equal(checkRunTokenWindow(rearmed).exceeded, false);
});

test('warn thresholds fire single-shot at 0.5 and 0.8', () => {
  const sess = freshSession();
  const window = openRunTokenWindow({ sessionId: sess, ceiling: 1_000 });
  accrueSessionTokens(sess, 550);
  assert.equal(checkRunTokenWindow(window).crossedThreshold, 0.5);
  assert.equal(checkRunTokenWindow(window).crossedThreshold, undefined, 'single-shot');
  accrueSessionTokens(sess, 300);
  assert.equal(checkRunTokenWindow(window).crossedThreshold, 0.8);
  assert.equal(checkRunTokenWindow(window).crossedThreshold, undefined);
});

test('unlimited ceiling: no checks, no thresholds, no budget line', () => {
  const sess = freshSession();
  accrueSessionTokens(sess, 50_000_000);
  const window = openRunTokenWindow({ sessionId: sess, ceiling: 0, baseline: 0 });
  const status = checkRunTokenWindow(window);
  assert.equal(status.exceeded, false);
  assert.equal(status.crossedThreshold, undefined);
  assert.equal(budgetLine(status), null);
});

test('kill-switch: enforcement off hides every budget surface; the meter is separate', () => {
  process.env.CLEMMY_RUN_TOKEN_BUDGET = 'off';
  assert.equal(runTokenBudgetEnforcementEnabled(), false);
  const sess = freshSession();
  const window = openRunTokenWindow({ sessionId: sess, ceiling: 100 });
  accrueSessionTokens(sess, 1_000); // metering still works
  assert.equal(getSessionTokensUsed(sess), 1_000);
  assert.equal(budgetLine(checkRunTokenWindow(window)), null, 'no budget line when enforcement is off');
});

test('formatTokens + budgetLine render the honest fraction', () => {
  assert.equal(formatTokens(6_200_000), '6.2M');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(45_000), '45k');
  const sess = freshSession();
  const window = openRunTokenWindow({ sessionId: sess, ceiling: 10_000_000 });
  accrueSessionTokens(sess, 6_200_000);
  const line = budgetLine(checkRunTokenWindow(window));
  assert.match(line ?? '', /token budget 62% used \(6\.2M\/10M\)/);
});

test('budgetLineFor: the single renderer for raw window parts (drain check-ins)', () => {
  const sess = freshSession();
  accrueSessionTokens(sess, 4_500_000);
  const line = budgetLineFor(sess, 0, 10_000_000);
  assert.match(line ?? '', /token budget 45% used \(4\.5M\/10M\)/);
  assert.equal(budgetLineFor(sess, 0, 0), null, 'no ceiling ⇒ no line');
  process.env.CLEMMY_RUN_TOKEN_BUDGET = 'off';
  assert.equal(budgetLineFor(sess, 0, 10_000_000), null, 'kill-switch off ⇒ no line');
});
