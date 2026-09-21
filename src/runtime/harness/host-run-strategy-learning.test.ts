/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-run-strategy-learning.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-strategy-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { createSession, appendEvent } = await import('./eventlog.js');
const { learnHostRunStrategyForAcceptedTask } = await import('./host-run-strategy-learning.js');
const { evaluateLearningCandidate } = await import('../../memory/learning-receipt.js');
const { renderRunStrategiesForContext } = await import('../../memory/run-strategy-store.js');

after(() => {
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('a host done terminal without settlements does not invent a strategy', () => {
  const session = createSession({ kind: 'chat', channel: 'desktop', title: 'no-tools' });
  const user = appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Create a local fixture file' },
  });
  const result = learnHostRunStrategyForAcceptedTask({
    sessionId: session.id,
    sourceUserSeq: user.seq,
  });
  assert.equal(result.status, 'not_proven');
  assert.equal(renderRunStrategiesForContext('Create a local fixture file'), '');
});

test('configured host review is eligible strategy authority', () => {
  const decision = evaluateLearningCandidate({
    target: 'strategy',
    authority: 'configured_completion_review',
    sessionId: 'sess-host',
    sourceId: 'sess-host:12',
    terminalSuccess: true,
    ownerSelectedJudge: true,
    controllerValidation: true,
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.receipt?.authority, 'configured_completion_review');
});

test('fail-open host review is not eligible to teach a strategy', () => {
  const decision = evaluateLearningCandidate({
    target: 'strategy',
    authority: 'configured_completion_review',
    sessionId: 'sess-host',
    sourceId: 'sess-host:13',
    terminalSuccess: true,
    ownerSelectedJudge: true,
    failedOpen: true,
  });
  assert.equal(decision.eligible, false);
});
