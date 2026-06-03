/**
 * Run: npx tsx --test src/runtime/harness/fanout-ledger.test.ts
 *
 * FIX 7 — the per-run fan-out coverage ledger. A batch that fans out N workers
 * and has some return ERROR: must report "M of N failed", not a hollow done.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordWorkerResult, summarizeLedger, clearLedger, fanoutLedgerEnabled } from './fanout-ledger.js';

test('summarizes done vs failed by callId, lists failed items', () => {
  const sid = 'sess-ledger-1';
  clearLedger(sid);
  recordWorkerResult({ sessionId: sid, callId: 'c1', item: 'Acme LLP', ok: true });
  recordWorkerResult({ sessionId: sid, callId: 'c2', item: 'Bar Law', ok: true });
  recordWorkerResult({ sessionId: sid, callId: 'c3', item: 'Qux Legal', ok: false, reason: 'ERROR: no email' });
  const s = summarizeLedger(sid);
  assert.equal(s.total, 3);
  assert.equal(s.done, 2);
  assert.equal(s.failed, 1);
  assert.deepEqual(s.failedItems, ['Qux Legal']);
  clearLedger(sid);
});

test('re-recording the same callId UPDATES, never double-counts', () => {
  const sid = 'sess-ledger-dedupe';
  clearLedger(sid);
  recordWorkerResult({ sessionId: sid, callId: 'c1', item: 'X', ok: false });
  recordWorkerResult({ sessionId: sid, callId: 'c1', item: 'X', ok: true }); // corrected
  const s = summarizeLedger(sid);
  assert.equal(s.total, 1, 'same callId is one item');
  assert.equal(s.done, 1);
  assert.equal(s.failed, 0);
  clearLedger(sid);
});

test('clearLedger resets a session; empty session summarizes to zero', () => {
  const sid = 'sess-ledger-clear';
  recordWorkerResult({ sessionId: sid, callId: 'c1', item: 'X', ok: true });
  clearLedger(sid);
  assert.deepEqual(summarizeLedger(sid), { total: 0, done: 0, failed: 0, failedItems: [] });
  assert.deepEqual(summarizeLedger('never-seen'), { total: 0, done: 0, failed: 0, failedItems: [] });
});

test('never throws on bad input', () => {
  assert.doesNotThrow(() => {
    // @ts-expect-error missing fields
    recordWorkerResult({});
    recordWorkerResult({ sessionId: '', callId: '', ok: true });
    summarizeLedger('');
    clearLedger('');
  });
});

test('flag defaults ON, honors the off kill-switch', () => {
  const prev = process.env.CLEMMY_FANOUT_LEDGER;
  try {
    delete process.env.CLEMMY_FANOUT_LEDGER;
    assert.equal(fanoutLedgerEnabled(), true, 'default on');
    process.env.CLEMMY_FANOUT_LEDGER = 'off';
    assert.equal(fanoutLedgerEnabled(), false, 'off disables');
    process.env.CLEMMY_FANOUT_LEDGER = 'on';
    assert.equal(fanoutLedgerEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_FANOUT_LEDGER;
    else process.env.CLEMMY_FANOUT_LEDGER = prev;
  }
});
