import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolation FIRST (test-hygiene rule): this suite appends worker_result events.
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-inline-recovery-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createSession, appendEvent, resetEventLog } = await import('./eventlog.js');
const { summarizeFanoutCoverage } = await import('./fanout-ledger.js');
const { verifyInlineRecovery, _setFanoutItemJudgeForTests } = await import('./fanout-item-verify.js');

test.after(() => {
  _setFanoutItemJudgeForTests(null);
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function seedRun(sessionId: string): void {
  createSession({ id: sessionId, kind: 'chat', channel: 'test', userId: 'u1' });
  appendEvent({ sessionId, turn: 0, role: 'system', type: 'worker_result', data: { item: 'alpha.com', ok: true } });
  appendEvent({ sessionId, turn: 0, role: 'system', type: 'worker_result', data: { item: 'beta.com', ok: false, reason: 'ERROR: scrape failed' } });
  appendEvent({ sessionId, turn: 0, role: 'system', type: 'worker_result', data: { item: 'gamma.com', ok: false, reason: 'ERROR: scrape failed' } });
}

test('all failed items judge-confirmed → durable promotion flips coverage (blocked-despite-recovered class)', async () => {
  resetEventLog();
  const sid = 'sess-inline-recovery-pass';
  seedRun(sid);
  assert.equal(summarizeFanoutCoverage(sid).failed, 2, 'precondition: 2 failed');
  _setFanoutItemJudgeForTests(async () => ({ fabricated: false, reason: '' }));
  const promoted = await verifyInlineRecovery(sid, 'research 3 firms', ['beta.com', 'gamma.com'], 'Final report:\n| beta.com | real data | ... |\n| gamma.com | real data | ... |');
  assert.equal(promoted, true);
  const cov = summarizeFanoutCoverage(sid);
  assert.equal(cov.failed, 0, 'promotions flipped the ledger for every future reader');
  assert.equal(cov.done, 3);
});

test('ANY unconfirmed item → no promotion at all, block stands (fail-closed, no partial promote)', async () => {
  resetEventLog();
  const sid = 'sess-inline-recovery-partial';
  seedRun(sid);
  _setFanoutItemJudgeForTests(async (_o, item) => ({ fabricated: item === 'gamma.com', reason: 'row is TBD placeholder' }));
  const promoted = await verifyInlineRecovery(sid, 'research 3 firms', ['beta.com', 'gamma.com'], 'Final report with beta real and gamma TBD');
  assert.equal(promoted, false);
  assert.equal(summarizeFanoutCoverage(sid).failed, 2, 'no partial promotion — beta stays failed too until the WHOLE deliverable is honest');
});

test('judge timeout/null → fail-closed; empty deliverable / empty failures / oversized set → no promotion', async () => {
  resetEventLog();
  const sid = 'sess-inline-recovery-null';
  seedRun(sid);
  _setFanoutItemJudgeForTests(async () => null);
  assert.equal(await verifyInlineRecovery(sid, 'obj', ['beta.com'], 'a deliverable'), false, 'null verdict never promotes');
  _setFanoutItemJudgeForTests(async () => ({ fabricated: false, reason: '' }));
  assert.equal(await verifyInlineRecovery(sid, 'obj', [], 'a deliverable'), false, 'nothing failed = nothing to promote');
  assert.equal(await verifyInlineRecovery(sid, 'obj', ['beta.com'], '   '), false, 'no deliverable text = nothing to verify against');
  const many = Array.from({ length: 40 }, (_, i) => `site${i}.com`);
  assert.equal(await verifyInlineRecovery(sid, 'obj', many, 'deliverable'), false, 'oversized failed set cannot be honestly verified');
  assert.equal(summarizeFanoutCoverage(sid).failed, 2);
});
