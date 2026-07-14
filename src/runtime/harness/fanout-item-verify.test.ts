/**
 * Run: npx tsx --test src/runtime/harness/fanout-item-verify.test.ts
 *
 * Wave 4 Stage 2 — per-item verification of fan-out worker outputs. Proves:
 *  (a) the zero-LLM tripwire flags blocked/promise-shaped non-completions and does
 *      NOT flag a genuine result (incl. a terse NUMERIC one — the fail-closed hazard
 *      the adversarial review surfaced);
 *  (b) the single-verdict parser only fails an item on an explicit FABRICATED;
 *  (c) verifyFanoutItems judges ONLY the flagged subset, ONE item per call (no
 *      sibling can be steered by an injection in another output), and records a
 *      confirmed hollow output as worker_result ok:false → summarizeFanoutCoverage
 *      counts it failed;
 *  (d) fail-open: a null judge marks nothing; kill-switch disables it.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-fanout-verify-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const { fanoutItemTripwire, parseFanoutItemVerdict, verifyFanoutItems, fanoutItemVerifyEnabled, _setFanoutItemJudgeForTests } = await import('./fanout-item-verify.js');
const { resetEventLog, createSession, appendEvent } = await import('./eventlog.js');
const { summarizeFanoutCoverage, clearLedger } = await import('./fanout-ledger.js');
const { recordSubagentRun } = await import('../../agents/subagent-runs.js');

after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

test('fanoutItemTripwire: flags blocked/promise non-completions; does NOT flag a genuine result (incl. terse numeric)', () => {
  assert.equal(fanoutItemTripwire("I'll gather Firm B's contacts and send them over shortly.").flagged, true, 'promise-shaped');
  assert.equal(fanoutItemTripwire('Unable to complete: I could not access the CRM, need credentials.').flagged, true, 'blocked');
  // #3 fix: a genuine terse NUMERIC result is NOT flagged (no fail-closed hazard).
  assert.equal(fanoutItemTripwire('Processed 1,240 records; 47 flagged, 1,193 clean. Error rate 3.8%.').flagged, false, 'terse numeric is genuine');
  assert.equal(fanoutItemTripwire('Firm C has 88 employees and $12M revenue.').flagged, false, 'bare figures are not flagged');
  assert.equal(fanoutItemTripwire('Firm A is a litigation boutique focused on appellate work.').flagged, false, 'clean qualitative');
  assert.equal(fanoutItemTripwire('').flagged, false, 'empty is not flagged (ERROR-handled upstream)');
});

test('parseFanoutItemVerdict: only an explicit FABRICATED fails; GENUINE/prose/empty → not fabricated / null', () => {
  assert.deepEqual(parseFanoutItemVerdict('FABRICATED: promise, no artifact'), { fabricated: true, reason: 'promise, no artifact' });
  assert.equal(parseFanoutItemVerdict('GENUINE')?.fabricated, false);
  assert.equal(parseFanoutItemVerdict('GENUINE: real result present')?.fabricated, false);
  assert.equal(parseFanoutItemVerdict('some unparseable prose with no marker'), null, 'no marker → null → caller fails open');
  assert.equal(parseFanoutItemVerdict(''), null);
  // Anchored to a marker LINE — a mention of the word inside prose is not a verdict.
  assert.equal(parseFanoutItemVerdict('The output looks fabricated to me maybe'), null);
});

function seedWorker(sid: string, item: string, pk: string, output: string): void {
  recordSubagentRun({
    id: `w-${item}`, parentRunId: sid, parentKind: 'session', provider: 'claude', model: 'm',
    task: item, packetKey: pk, status: 'ok', output, startedAt: 't', finishedAt: 't',
  });
  appendEvent({ sessionId: sid, turn: 0, role: 'system', type: 'worker_result', data: { item, ok: true, packetKey: pk } });
}

test('verifyFanoutItems: judges ONLY flagged items (one per call); a confirmed hollow output flips coverage to failed', async () => {
  resetEventLog();
  const sid = createSession({ kind: 'execution' }).id;
  clearLedger(sid);
  // A: clean qualitative (not flagged) · B: promise (flagged) · C: terse numeric (not flagged)
  seedWorker(sid, 'Firm A', 'pkA', 'Firm A is a litigation boutique focused on appellate work; strong reputation.');
  seedWorker(sid, 'Firm B', 'pkB', "I'll compile Firm B's contacts and send them over shortly.");
  seedWorker(sid, 'Firm C', 'pkC', 'Firm C: 88 employees, $12M revenue, founded 1998.');
  assert.deepEqual(
    { total: summarizeFanoutCoverage(sid).total, failed: summarizeFanoutCoverage(sid).failed },
    { total: 3, failed: 0 }, 'all 3 start done',
  );

  const judged: string[] = [];
  _setFanoutItemJudgeForTests(async (_obj, item) => {
    judged.push(item);
    return { fabricated: item === 'Firm B', reason: item === 'Firm B' ? 'hollow promise, no artifact' : 'ok' };
  });
  try {
    const fab = await verifyFanoutItems(sid, 'Enrich each firm with real contact + firmographic data.');
    assert.deepEqual(fab.map((f) => f.item), ['Firm B'], 'only Firm B confirmed');
  } finally {
    _setFanoutItemJudgeForTests(null);
  }

  // Only the flagged item (Firm B) was judged; A (clean) and C (terse numeric) never were.
  assert.deepEqual(judged, ['Firm B'], 'only the flagged item is judged, one per call');

  const cov = summarizeFanoutCoverage(sid);
  assert.equal(cov.total, 3);
  assert.equal(cov.done, 2);
  assert.equal(cov.failed, 1);
  assert.deepEqual(cov.failedItems, ['Firm B']);
});

test('verifyFanoutItems: fail-open — a null judge verdict marks NOTHING failed', async () => {
  resetEventLog();
  const sid = createSession({ kind: 'execution' }).id;
  clearLedger(sid);
  seedWorker(sid, 'Firm X', 'pkX', "I'll get to Firm X next.");
  _setFanoutItemJudgeForTests(async () => null); // judge unavailable
  try {
    assert.deepEqual(await verifyFanoutItems(sid, 'Enrich each firm.'), []);
  } finally {
    _setFanoutItemJudgeForTests(null);
  }
  assert.equal(summarizeFanoutCoverage(sid).failed, 0, 'nothing marked failed on a judge hiccup');
});

test('verifyFanoutItems: no flagged items → ZERO judge calls (clean batch)', async () => {
  resetEventLog();
  const sid = createSession({ kind: 'execution' }).id;
  clearLedger(sid);
  seedWorker(sid, 'Firm A', 'pkA', 'Firm A: litigation boutique, appellate focus, established 1998.');
  seedWorker(sid, 'Firm C', 'pkC', 'Firm C: 88 employees, $12M revenue.');
  let called = false;
  _setFanoutItemJudgeForTests(async () => { called = true; return null; });
  try {
    assert.deepEqual(await verifyFanoutItems(sid, 'Enrich each firm.'), []);
  } finally {
    _setFanoutItemJudgeForTests(null);
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
