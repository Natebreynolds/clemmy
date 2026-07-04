/**
 * T2.2 — cross-run forEach watermark store.
 * Per-test temp dir via CLEMENTINE_HOME (BINDING) — set BEFORE any src import.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-watermark-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { readSeenItemKeys, markItemsSeen, clearStepWatermark } = await import('./workflow-watermark-store.js');

test('watermark: mark → read round-trip, per (workflow, step), idempotent', () => {
  assert.equal(readSeenItemKeys('daily-leads', 'process').size, 0);

  markItemsSeen('daily-leads', 'process', ['L-1', 'L-2']);
  const seen = readSeenItemKeys('daily-leads', 'process');
  assert.deepEqual([...seen].sort(), ['L-1', 'L-2']);

  // idempotent re-mark + accumulate
  markItemsSeen('daily-leads', 'process', ['L-2', 'L-3']);
  assert.deepEqual([...readSeenItemKeys('daily-leads', 'process')].sort(), ['L-1', 'L-2', 'L-3']);

  // isolated per step and per workflow
  assert.equal(readSeenItemKeys('daily-leads', 'other-step').size, 0);
  assert.equal(readSeenItemKeys('other-workflow', 'process').size, 0);
});

test('watermark: empty/blank keys are ignored; clear forgets the step only', () => {
  markItemsSeen('wf-a', 'step-1', ['', '  ', 'real-key']);
  assert.deepEqual([...readSeenItemKeys('wf-a', 'step-1')], ['real-key']);

  markItemsSeen('wf-a', 'step-2', ['keep-me']);
  clearStepWatermark('wf-a', 'step-1');
  assert.equal(readSeenItemKeys('wf-a', 'step-1').size, 0);
  assert.deepEqual([...readSeenItemKeys('wf-a', 'step-2')], ['keep-me']);
});

test('watermark: caps at 5000 most recent keys', () => {
  const keys = Array.from({ length: 5010 }, (_, i) => `k-${i}`);
  // mark in two batches so "newest" is well-defined by insertion date ordering
  markItemsSeen('wf-big', 'fan', keys.slice(0, 5000));
  markItemsSeen('wf-big', 'fan', keys.slice(5000));
  const seen = readSeenItemKeys('wf-big', 'fan');
  assert.equal(seen.size, 5000);
  // the second batch (newest) survived the cap
  assert.equal(seen.has('k-5009'), true);
});
