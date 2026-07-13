/**
 * Run: npx tsx --test src/runtime/harness/fanout-item-verify.test.ts
 *
 * Wave 4 Stage 2 — per-item verification of fan-out worker outputs. Proves:
 *  (a) the zero-LLM tripwire flags hollow/blocked/unsupported outputs, passes clean;
 *  (b) the batched-verdict parser is strict (all-or-null);
 *  (c) verifyFanoutItems judges ONLY the flagged subset and records a confirmed
 *      fabrication as worker_result ok:false → summarizeFanoutCoverage counts it failed;
 *  (d) fail-open: a null judge marks nothing; kill-switch disables the whole thing.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-fanout-verify-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const { fanoutItemTripwire, parseFanoutVerdicts, verifyFanoutItems, fanoutItemVerifyEnabled, _setFanoutBatchJudgeForTests } = await import('./fanout-item-verify.js');
const { resetEventLog, createSession, appendEvent } = await import('./eventlog.js');
const { summarizeFanoutCoverage } = await import('./fanout-ledger.js');
const { recordSubagentRun } = await import('../../agents/subagent-runs.js');

after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

test('fanoutItemTripwire: flags hollow/blocked/unsupported outputs; passes a clean evidence-bearing result', () => {
  assert.equal(fanoutItemTripwire("I'll gather Firm B's contacts and send them over shortly.").flagged, true, 'promise-shaped');
  assert.equal(fanoutItemTripwire('Unable to complete: I could not access the CRM, need credentials.').flagged, true, 'blocked');
  assert.equal(fanoutItemTripwire('Firm C has 88 employees and $12M revenue.').flagged, true, 'unsupported figures');
  // Clean: figures WITH an evidence marker (URL) → not flagged.
  assert.equal(fanoutItemTripwire('Firm D: 42 attorneys per https://firmd.com/about').flagged, false, 'figures with evidence');
  // Clean: substantive, no numbers, not promise/blocked.
  assert.equal(fanoutItemTripwire('Firm A is a litigation boutique focused on appellate work.').flagged, false, 'clean qualitative');
  assert.equal(fanoutItemTripwire('').flagged, false, 'empty is not flagged (ERROR-handled upstream)');
});

test('parseFanoutVerdicts: strict all-or-null; maps GENUINE/FABRICATED', () => {
  const v = parseFanoutVerdicts('1: GENUINE\n2: FABRICATED: promise, no artifact\n3: GENUINE', 3);
  assert.ok(v);
  assert.deepEqual(v!.map((x) => x.fabricated), [false, true, false]);
  assert.equal(v![1].reason, 'promise, no artifact');
  // Missing a verdict → null (caller fails open).
  assert.equal(parseFanoutVerdicts('1: GENUINE\n2: FABRICATED', 3), null);
  assert.equal(parseFanoutVerdicts('garbage', 2), null);
});

function seedWorker(sid: string, item: string, pk: string, output: string): void {
  recordSubagentRun({
    id: `w-${item}`, parentRunId: sid, parentKind: 'session', provider: 'claude', model: 'm',
    task: item, packetKey: pk, status: 'ok', output, startedAt: 't', finishedAt: 't',
  });
  appendEvent({ sessionId: sid, turn: 0, role: 'system', type: 'worker_result', data: { item, ok: true, packetKey: pk } });
}

test('verifyFanoutItems: judges ONLY flagged items; a confirmed fabrication flips coverage to failed', async () => {
  resetEventLog();
  const sid = createSession({ kind: 'execution' }).id;
  // A: clean (not flagged) · B: promise-shaped (flagged) · C: unsupported figures (flagged)
  seedWorker(sid, 'Firm A', 'pkA', 'Firm A is a litigation boutique focused on appellate work; strong reputation.');
  seedWorker(sid, 'Firm B', 'pkB', "I'll compile Firm B's contacts and send them over shortly.");
  seedWorker(sid, 'Firm C', 'pkC', 'Firm C has 88 employees and $12M revenue.');
  assert.deepEqual(
    { total: summarizeFanoutCoverage(sid).total, failed: summarizeFanoutCoverage(sid).failed },
    { total: 3, failed: 0 }, 'all 3 start done',
  );

  const judged: string[] = [];
  _setFanoutBatchJudgeForTests(async (_obj, outputs) => {
    for (const o of outputs) judged.push(o.item);
    // B is a hollow promise → fabricated; C's figures are (say) plausible → genuine.
    return outputs.map((o) => ({ fabricated: o.item === 'Firm B', reason: o.item === 'Firm B' ? 'hollow promise, no artifact' : 'ok' }));
  });
  try {
    const fab = await verifyFanoutItems(sid, 'Enrich each firm with real contact + firmographic data.');
    assert.deepEqual(fab.map((f) => f.item), ['Firm B'], 'only Firm B confirmed fabricated');
  } finally {
    _setFanoutBatchJudgeForTests(null);
  }

  // Clean Firm A was NEVER sent to the judge (tripwire skipped it).
  assert.ok(!judged.includes('Firm A'), 'clean item is not judged');
  assert.deepEqual(judged.sort(), ['Firm B', 'Firm C'], 'only the flagged subset is judged');

  // Coverage now reflects the fabrication: 3 total, 2 done, 1 failed (Firm B).
  const cov = summarizeFanoutCoverage(sid);
  assert.equal(cov.total, 3);
  assert.equal(cov.done, 2);
  assert.equal(cov.failed, 1);
  assert.deepEqual(cov.failedItems, ['Firm B']);
});

test('verifyFanoutItems: fail-open — a null judge verdict marks NOTHING failed', async () => {
  resetEventLog();
  const sid = createSession({ kind: 'execution' }).id;
  seedWorker(sid, 'Firm X', 'pkX', "I'll get to Firm X next.");
  _setFanoutBatchJudgeForTests(async (_obj, outputs) => outputs.map(() => null)); // judge unavailable
  try {
    const fab = await verifyFanoutItems(sid, 'Enrich each firm.');
    assert.deepEqual(fab, [], 'a null judge confirms nothing');
  } finally {
    _setFanoutBatchJudgeForTests(null);
  }
  assert.equal(summarizeFanoutCoverage(sid).failed, 0, 'nothing marked failed on a judge hiccup');
});

test('verifyFanoutItems: no flagged items → ZERO judge calls (the clean-batch common case)', async () => {
  resetEventLog();
  const sid = createSession({ kind: 'execution' }).id;
  seedWorker(sid, 'Firm A', 'pkA', 'Firm A: litigation boutique, appellate focus, established 1998.');
  let called = false;
  _setFanoutBatchJudgeForTests(async (_obj, outputs) => { called = true; return outputs.map(() => null); });
  try {
    const fab = await verifyFanoutItems(sid, 'Enrich each firm.');
    assert.deepEqual(fab, []);
  } finally {
    _setFanoutBatchJudgeForTests(null);
  }
  assert.equal(called, false, 'a clean batch never spends a judge call');
});

test('fanoutItemVerifyEnabled: default ON; off|0|false disable', () => {
  const prev = process.env.CLEMMY_FANOUT_ITEM_VERIFY;
  try {
    delete process.env.CLEMMY_FANOUT_ITEM_VERIFY;
    assert.equal(fanoutItemVerifyEnabled(), true);
    for (const off of ['off', '0', 'false']) {
      process.env.CLEMMY_FANOUT_ITEM_VERIFY = off;
      assert.equal(fanoutItemVerifyEnabled(), false, `${off} disables`);
    }
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_FANOUT_ITEM_VERIFY; else process.env.CLEMMY_FANOUT_ITEM_VERIFY = prev;
  }
});
