import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-work-review-inventory-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const inventory = await import('../execution/workflow-run-inventory.js');
const { observeWorkflowRuns } = await import('./work-review-runtime.js');

test.after(() => rmSync(home, { recursive: true, force: true }));
test.beforeEach(() => {
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  inventory._resetWorkflowRunInventoryForTests();
});

function write(file: string, raw: unknown): void {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, file), JSON.stringify(raw));
}

test('work review keeps its selected filename window and observation fields, independent of record dates', () => {
  write('a.json', { id: 'date-newest', workflow: 'older filename', status: 'failed', createdAt: '2099-01-01' });
  write('z.json', { id: 'exact-id', workflow: 'Named workflow', workflowSlug: 'unused', status: 'running',
    createdAt: '2000-01-01', finishedAt: '2000-01-02', completedAt: 'unused', error: 'kept error',
    needsAttention: true, source: 'controlled', targetStepId: 'read', stepOutputs: { read: 'heavy'.repeat(20_000) } });
  write('y with spaces.json', { id: ' ', workflow: ' ', workflowSlug: 'slug fallback', status: 'completed',
    completedAt: '2001-01-02', needsAttention: 'true', source: ' ', targetStepId: ' ' });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'zz.tmp'), 'not a run');
  assert.deepEqual(observeWorkflowRuns(2), {
    runs: [
      { runId: 'exact-id', workflow: 'Named workflow', status: 'running', createdAt: '2000-01-01',
        finishedAt: '2000-01-02', error: 'kept error', needsAttention: true, source: 'controlled', targetStepId: 'read' },
      { runId: 'y with spaces', workflow: 'slug fallback', status: 'completed', createdAt: undefined,
        finishedAt: '2001-01-02', error: undefined, needsAttention: false, source: undefined, targetStepId: null },
    ],
    failures: 0,
  });
  assert.deepEqual(observeWorkflowRuns(0), { runs: [], failures: 0 });
});

test('a warm review reads no unchanged JSON and a changed selected run is read only once', (t) => {
  for (let i = 0; i < 8; i++) write(`${i}.json`, { id: String(i), workflow: 'read-count', status: 'running',
    stepOutputs: { heavy: 'output'.repeat(20_000) } });
  const reads = t.mock.method(fs, 'readFileSync');
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const runReads = () => reads.mock.calls.filter(call => typeof call.arguments[0] === 'string'
    && path.dirname(call.arguments[0]) === WORKFLOW_RUNS_DIR).map(call => path.basename(String(call.arguments[0])));
  const first = observeWorkflowRuns(2);
  assert.deepEqual(runReads(), ['7.json', '6.json'], 'cold observation does not decode older unselected records');
  assert.deepEqual(observeWorkflowRuns(2), first);
  assert.deepEqual(runReads(), ['7.json', '6.json'], 'warm observation checks generations without decoding heavy results');
  write('7.json', { id: '7', workflow: 'read-count', status: 'completed', finishedAt: '2026-10-18T04:00:00Z' });
  assert.equal(observeWorkflowRuns(2).runs[0]?.status, 'completed');
  assert.equal(observeWorkflowRuns(2).runs[0]?.status, 'completed');
  assert.deepEqual(runReads(), ['7.json', '6.json', '7.json']);
  assert.equal(inventory.workflowRunInventoryEntry('7')?.record.status, 'completed');
  assert.deepEqual(runReads(), ['7.json', '6.json', '7.json'], 'other inventory consumers reuse the same light projection');
});

test('same-size replacement preserving modification time refreshes the work observation', () => {
  write('atomic.json', { workflow: 'atomic', status: 'queued' });
  const file = path.join(WORKFLOW_RUNS_DIR, 'atomic.json');
  const fixed = new Date('2026-10-16T01:00:00Z');
  utimesSync(file, fixed, fixed);
  const before = statSync(file);
  assert.equal(observeWorkflowRuns().runs[0]?.status, 'queued');
  const replacement = `${file}.replacement`;
  writeFileSync(replacement, JSON.stringify({ workflow: 'atomic', status: 'failed' }));
  utimesSync(replacement, fixed, fixed);
  renameSync(replacement, file);
  assert.equal(statSync(file).size, before.size);
  assert.equal(statSync(file).mtimeMs, before.mtimeMs);
  assert.equal(observeWorkflowRuns().runs[0]?.status, 'failed');
});

test('read failures remain distinct from decoded values with no workflow, and repaired records return', () => {
  for (const [file, raw] of Object.entries({
    'null.json': null, 'array.json': [], 'string.json': 'text', 'number.json': 0,
    'boolean.json': false, 'incomplete.json': { workflow: 'missing status' },
    'valid.json': { workflow: 'retained', status: 'running' },
  })) write(file, raw);
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'broken.json'), '{broken');
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'prototype.json'),
    '{"__proto__":{"workflow":"not a workflow","status":"failed"}}');
  assert.deepEqual(observeWorkflowRuns().runs.map(row => row.workflow), ['retained']);
  assert.equal(observeWorkflowRuns().failures, 2, 'null and malformed JSON failed in the legacy observer');
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'valid.json'), '{broken');
  assert.equal(observeWorkflowRuns().failures, 3);
  assert.deepEqual(observeWorkflowRuns().runs, [], 'a previous successful generation cannot survive corruption');
  write('valid.json', { workflow: 'retained', status: 'completed' });
  assert.equal(observeWorkflowRuns().failures, 2);
  assert.equal(observeWorkflowRuns().runs[0]?.status, 'completed');
});

test('unreadable and vanished selected generations fail without stale observations', (t) => {
  write('visible.json', { workflow: 'visible', status: 'running' });
  assert.equal(observeWorkflowRuns().runs.length, 1);
  const file = path.join(WORKFLOW_RUNS_DIR, 'visible.json');
  const original = fs.statSync;
  const unreadable = t.mock.method(fs, 'statSync', (...args) => {
    if (args[0] === file) throw Object.assign(new Error('controlled unreadable generation'), { code: 'EACCES' });
    return Reflect.apply(original, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(observeWorkflowRuns(), { runs: [], failures: 1 });
  unreadable.mock.restore();
  syncBuiltinESMExports();
  assert.equal(observeWorkflowRuns().runs.length, 1);
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (...args) => {
    const result = Reflect.apply(readdir, fs, args);
    if (args[0] === WORKFLOW_RUNS_DIR) unlinkSync(file);
    return result;
  });
  syncBuiltinESMExports();
  assert.deepEqual(observeWorkflowRuns(), { runs: [], failures: 1 });
});

test('a file replaced while being decoded is not published until its generation is stable', (t) => {
  write('racing.json', { workflow: 'racing', status: 'running' });
  const file = path.join(WORKFLOW_RUNS_DIR, 'racing.json');
  const read = fs.readFileSync;
  let replace = true;
  t.mock.method(fs, 'readFileSync', (...args) => {
    const bytes = Reflect.apply(read, fs, args);
    if (args[0] === file && replace) {
      replace = false;
      const replacement = `${file}.replacement`;
      writeFileSync(replacement, JSON.stringify({ workflow: 'racing', status: 'completed' }));
      renameSync(replacement, file);
    }
    return bytes;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(observeWorkflowRuns(), { runs: [], failures: 1 });
  assert.equal(observeWorkflowRuns().runs[0]?.status, 'completed');
});
