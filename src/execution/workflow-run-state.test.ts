/**
 * Run: npx tsx --test src/execution/workflow-run-state.test.ts
 * Employee-memory primitive (2026-07-21): durable cross-run workflow state —
 * the fix for amnesiac recurring runs duplicating work every hour.
 */
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wf-state-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  WORKFLOW_STATE_DIR,
  WorkflowStateUnavailableError,
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

test('corrupt ledger preserves bytes and refuses get/filter/mark/set across process reopen', () => {
  const wf = 'corrupt-wf';
  markProcessed(wf, ['k1']);
  const file = path.join(WORKFLOW_STATE_DIR, 'corrupt-wf.json');
  writeFileSync(file, '{ nope', 'utf-8');
  assert.throws(() => readWorkflowState(wf), WorkflowStateUnavailableError);
  const quarantine = readdirSync(WORKFLOW_STATE_DIR).find(f => f.startsWith('corrupt-wf.json.corrupt-'));
  assert.ok(quarantine, 'original bytes kept for repair');
  assert.equal(readFileSync(path.join(WORKFLOW_STATE_DIR, quarantine), 'utf8'), '{ nope');
  assert.ok(existsSync(`${file}.unavailable`), 'durable unavailability precedes removal of original');
  for (const readOrWrite of [
    () => readWorkflowState(wf),
    () => filterUnprocessed(wf, ['k1']),
    () => markProcessed(wf, ['new-key']),
    () => setWorkflowStateValues(wf, { cursor: 'new' }),
  ]) assert.throws(readOrWrite, WorkflowStateUnavailableError);
  assert.equal(existsSync(file), false, 'failed mutators never create a replacement ledger');
  const result = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `const mod = await import(${JSON.stringify(new URL('./workflow-run-state.ts', import.meta.url).href)});\n`
    + `try { mod.filterUnprocessed('corrupt-wf', ['k1']); process.exitCode = 1; } catch (error) { if (error.name !== 'WorkflowStateUnavailableError') throw error; }`,
  ], { env: { ...process.env, CLEMENTINE_HOME: TMP }, encoding: 'utf8' });
  assert.equal(result, '', 'new process remains unavailable without relying on memory');
  assert.match(workflowStateSummaryLine(wf)!, /Pause.*restore a valid saved ledger/);
});

test('malformed structural ledgers never discard processed evidence into empty state', () => {
  for (const [index, state] of [
    {}, null, [],
    { values: {}, processed: [], updatedAt: new Date().toISOString() },
    { values: {}, processed: { completed: 7 }, updatedAt: new Date().toISOString() },
    { values: {}, processed: { completed: 'not-a-date' }, updatedAt: new Date().toISOString() },
    { values: [], processed: { completed: new Date().toISOString() }, updatedAt: new Date().toISOString() },
  ].entries()) {
    const wf = `malformed-${index}`;
    const file = path.join(WORKFLOW_STATE_DIR, `${wf}.json`);
    writeFileSync(file, JSON.stringify(state));
    assert.throws(() => filterUnprocessed(wf, ['completed']), WorkflowStateUnavailableError);
    assert.throws(() => filterUnprocessed(wf, ['completed']), WorkflowStateUnavailableError);
  }
});

test('old quarantines refuse missing state; a genuinely new missing ledger stays empty', () => {
  const file = path.join(WORKFLOW_STATE_DIR, 'old-quarantine.json');
  writeFileSync(`${file}.corrupt-legacy`, 'old original bytes');
  assert.throws(() => readWorkflowState('old-quarantine'), WorkflowStateUnavailableError);
  assert.ok(existsSync(`${file}.unavailable`));
  assert.equal(readFileSync(`${file}.corrupt-legacy`, 'utf8'), 'old original bytes');
  assert.deepEqual(filterUnprocessed('genuinely-new', ['new']), { fresh: ['new'], seen: [] });
});

test('dangling or nonregular present ledgers remain unavailable across reopen without replacement', () => {
  for (const kind of ['dangling', 'directory']) {
    const wf = `present-${kind}`;
    const file = path.join(WORKFLOW_STATE_DIR, `${wf}.json`);
    if (kind === 'dangling') symlinkSync(path.join(WORKFLOW_STATE_DIR, 'missing-target.json'), file);
    else mkdirSync(file);
    assert.throws(() => filterUnprocessed(wf, ['completed']), WorkflowStateUnavailableError);
    assert.throws(() => markProcessed(wf, ['new']), WorkflowStateUnavailableError);
    assert.throws(() => setWorkflowStateValues(wf, { cursor: 'new' }), WorkflowStateUnavailableError);
    assert.equal(existsSync(file), false, 'uncertain original is retained in quarantine, not replaced');
    assert.ok(readdirSync(WORKFLOW_STATE_DIR).some(name => name.startsWith(`${wf}.json.corrupt-`)));
  }
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `const mod = await import(${JSON.stringify(new URL('./workflow-run-state.ts', import.meta.url).href)});\n`
    + `try { mod.filterUnprocessed('present-dangling', ['completed']); process.exitCode = 1; } catch (error) { if (error.name !== 'WorkflowStateUnavailableError') throw error; }`,
  ], { env: { ...process.env, CLEMENTINE_HOME: TMP }, encoding: 'utf8' });
});

test('inaccessible ledger or evidence directory refuses unknown state instead of treating it as absent', { skip: process.getuid?.() === 0 }, () => {
  const wf = 'unreadable-wf';
  markProcessed(wf, ['completed']);
  const file = path.join(WORKFLOW_STATE_DIR, `${wf}.json`);
  chmodSync(file, 0o000);
  try {
    assert.throws(() => filterUnprocessed(wf, ['completed']), /unavailable.*EACCES/);
    assert.throws(() => markProcessed(wf, ['new']), WorkflowStateUnavailableError);
  } finally {
    const retained = readdirSync(WORKFLOW_STATE_DIR).find(name => name.startsWith(`${wf}.json.corrupt-`));
    if (retained) chmodSync(path.join(WORKFLOW_STATE_DIR, retained), 0o600);
    if (existsSync(file)) chmodSync(file, 0o600);
  }
  chmodSync(WORKFLOW_STATE_DIR, 0o000);
  try {
    assert.throws(() => readWorkflowState('unknown-inaccessible'), /unavailable.*EACCES/);
    assert.throws(() => setWorkflowStateValues('unknown-inaccessible', {}), WorkflowStateUnavailableError);
  } finally { chmodSync(WORKFLOW_STATE_DIR, 0o755); }
});

test('explicit exact valid restoration resumes dedupe while retaining the missing-state fence', () => {
  const wf = 'restored-wf';
  markProcessed(wf, ['completed']);
  setWorkflowStateValues(wf, { cursor: 'completed' });
  const file = path.join(WORKFLOW_STATE_DIR, `${wf}.json`);
  const backup = readFileSync(file, 'utf8');
  writeFileSync(file, '{broken');
  assert.throws(() => readWorkflowState(wf), WorkflowStateUnavailableError);
  writeFileSync(file, backup, 'utf8'); // An explicit owner restoration, not an internal reset.
  assert.deepEqual(filterUnprocessed(wf, ['completed', 'new']), { fresh: ['new'], seen: ['completed'] });
  assert.equal(readWorkflowState(wf).values.cursor, 'completed');
  markProcessed(wf, ['new']);
  rmSync(file);
  assert.throws(() => readWorkflowState(wf), WorkflowStateUnavailableError);
});

test('failed quarantine rename or marker creation keeps original ledger and refuses work', { skip: process.getuid?.() === 0 }, () => {
  for (const markerExists of [false, true]) {
    const wf = markerExists ? 'rename-denied' : 'marker-denied';
    const file = path.join(WORKFLOW_STATE_DIR, `${wf}.json`);
    writeFileSync(file, '{preserved');
    if (markerExists) writeFileSync(`${file}.unavailable`, 'unavailable');
    chmodSync(WORKFLOW_STATE_DIR, 0o555);
    try {
      assert.throws(() => readWorkflowState(wf), WorkflowStateUnavailableError);
      assert.throws(() => filterUnprocessed(wf, ['completed']), WorkflowStateUnavailableError);
      assert.equal(readFileSync(file, 'utf8'), '{preserved');
    } finally { chmodSync(WORKFLOW_STATE_DIR, 0o755); }
  }
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
