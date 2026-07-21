/**
 * Run: npx tsx --test src/execution/workflow-run-state.test.ts
 * Employee-memory primitive (2026-07-21): durable cross-run workflow state —
 * the fix for amnesiac recurring runs duplicating work every hour.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wf-state-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  WORKFLOW_STATE_DIR,
  filterUnprocessed,
  markProcessed,
  readWorkflowState,
  setWorkflowStateValues,
  workflowStateSummaryLine,
} = await import('./workflow-run-state.js');

test.after(() => rmSync(TMP, { recursive: true, force: true }));

test('the hourly-scrape contract: filter → process fresh only → mark — the second run skips everything done', () => {
  const wf = 'inbox-attachment-sort';
  // Run 1: 3 attachments arrive.
  const run1 = filterUnprocessed(wf, ['msg-1:att-a', 'msg-2:att-b', 'msg-3:att-c']);
  assert.deepEqual(run1.fresh, ['msg-1:att-a', 'msg-2:att-b', 'msg-3:att-c']);
  markProcessed(wf, run1.fresh);
  setWorkflowStateValues(wf, { lastRunAt: '2026-07-21T05:00:00Z', sheetRow: 4 });

  // Run 2 (an hour later): same 3 + 1 new. ONLY the new one is fresh.
  const run2 = filterUnprocessed(wf, ['msg-1:att-a', 'msg-2:att-b', 'msg-3:att-c', 'msg-4:att-d']);
  assert.deepEqual(run2.fresh, ['msg-4:att-d'], 'no duplicate downloads/uploads/rows on the second run');
  assert.equal(run2.seen.length, 3);

  const state = readWorkflowState(wf);
  assert.equal(state.values.sheetRow, 4, 'cursors persist across runs');
});

test('values merge; null deletes; the size cap throws a friendly redirect', () => {
  const wf = 'values-wf';
  setWorkflowStateValues(wf, { a: 1, b: 'x' });
  setWorkflowStateValues(wf, { b: null, c: true });
  assert.deepEqual(readWorkflowState(wf).values, { a: 1, c: true });
  assert.throws(
    () => setWorkflowStateValues(wf, { blob: 'z'.repeat(70 * 1024) }),
    /Keep state small/,
  );
});

test('processed ledger prunes oldest past the cap — recent watermarks always survive', () => {
  const wf = 'prune-wf';
  markProcessed(wf, Array.from({ length: 5100 }, (_, i) => `item-${i}`));
  const state = readWorkflowState(wf);
  const keys = Object.keys(state.processed);
  assert.equal(keys.length, 5000, 'bounded');
  assert.ok('item-5099' in state.processed, 'newest kept');
});

test('corrupt state quarantines (bytes survive) rather than silently resetting', () => {
  const wf = 'corrupt-wf';
  markProcessed(wf, ['k1']);
  const file = path.join(WORKFLOW_STATE_DIR, 'corrupt-wf.json');
  writeFileSync(file, '{ nope', 'utf-8');
  const state = readWorkflowState(wf);
  assert.deepEqual(state.processed, {}, 'fresh state after corruption');
  assert.ok(readdirSync(WORKFLOW_STATE_DIR).some((f) => f.startsWith('corrupt-wf.json.corrupt-')), 'original bytes kept for repair');
});

test('summary line: null when no state; actionable instructions when state exists', () => {
  assert.equal(workflowStateSummaryLine('never-used-wf'), null, 'lean by default — no priming noise');
  const wf = 'primed-wf';
  markProcessed(wf, ['m1', 'm2']);
  setWorkflowStateValues(wf, { watermark: 'msg-99' });
  const line = workflowStateSummaryLine(wf);
  assert.ok(line);
  assert.match(line!, /2 processed item keys/);
  assert.match(line!, /watermark/);
  assert.match(line!, /filter_unprocessed/, 'the priming teaches the contract');
});

test('workflow names sanitize to one state file (no traversal, stable slugs)', () => {
  markProcessed('My Hourly Scrape!', ['x']);
  markProcessed('my hourly scrape', ['y']);
  const state = readWorkflowState('MY HOURLY SCRAPE');
  assert.deepEqual(Object.keys(state.processed).sort(), ['x', 'y'], 'case/punctuation variants share the slug');
});
