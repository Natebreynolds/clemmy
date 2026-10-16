/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-run-inventory.test.ts
 */
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-run-inventory-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const inventory = await import('./workflow-run-inventory.js');

test.after(() => rmSync(TEST_HOME, { recursive: true, force: true }));
test.beforeEach(() => {
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  inventory._resetWorkflowRunInventoryForTests();
});

function write(id: string, record: Record<string, unknown>): void {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${id}.json`), JSON.stringify({ id, ...record }));
}

test('the inventory keeps light fields, newest first, and a run that finishes changes its workflow\'s signature', () => {
  inventory._resetWorkflowRunInventoryForTests();
  write('run-a', { workflow: 'flow', status: 'running', createdAt: '2026-10-16T01:00:00.000Z',
    stepOutputs: { gather: 'x'.repeat(50_000) }, workflowDefinitionSnapshot: { version: 1, definitionHash: 'h1', definition: { steps: [] } },
    output: 'big', reportBack: { outcome: 'done', detail: 'long' } });
  write('run-b', { workflow: 'other', status: 'completed', createdAt: '2026-10-16T02:00:00.000Z' });

  const entries = inventory.workflowRunInventory();
  assert.deepEqual(entries.map((entry) => entry.record.id), ['run-b', 'run-a']);
  const a = entries.find((entry) => entry.record.id === 'run-a')!.record;
  assert.equal(a.stepOutputs, undefined);
  assert.equal(a.output, undefined);
  assert.deepEqual(a.stepOutputKeys, ['gather']);
  assert.deepEqual(a.workflowDefinitionSnapshot, { version: 1, definitionHash: 'h1' });
  assert.deepEqual(a.reportBack, { outcome: 'done' });

  const before = inventory.workflowRunInventorySignature(['flow']);
  const otherBefore = inventory.workflowRunInventorySignature(['other']);
  write('run-a', { workflow: 'flow', status: 'completed', finishedAt: '2026-10-16T01:05:00.000Z', createdAt: '2026-10-16T01:00:00.000Z' });
  assert.notEqual(inventory.workflowRunInventorySignature(['flow']), before, 'an existing run finishing is a change');
  assert.equal(inventory.workflowRunInventorySignature(['other']), otherBefore, 'another workflow\'s signature is untouched');
  assert.equal(inventory.workflowRunInventory().find((entry) => entry.record.id === 'run-a')!.record.status, 'completed');

  unlinkSync(path.join(WORKFLOW_RUNS_DIR, 'run-b.json'));
  assert.deepEqual(inventory.workflowRunInventory().map((entry) => entry.record.id), ['run-a']);
});

test('warm history and exact-run polling parse no unchanged records; changing one record parses only that record', (t) => {
  for (let i = 0; i < 32; i++) write(`parse-${i}`, {
    workflow: 'parse-count', status: 'running', createdAt: `2026-10-16T01:00:${String(i).padStart(2, '0')}.000Z`,
    stepOutputs: { read: 'heavy-output'.repeat(2_000) },
  });
  const reads = t.mock.method(fs, 'readFileSync');
  const stats = t.mock.method(fs, 'statSync');
  const listings = t.mock.method(fs, 'readdirSync');
  const parses = t.mock.method(JSON, 'parse');
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const runReads = () => reads.mock.calls.filter(call => typeof call.arguments[0] === 'string'
    && path.dirname(call.arguments[0]) === WORKFLOW_RUNS_DIR && call.arguments[0].endsWith('.json')).length;
  const runParses = () => parses.mock.calls.filter(call => typeof call.arguments[0] === 'string'
    && call.arguments[0].includes('"workflow":"parse-count"')).length;
  assert.equal(inventory.workflowRunInventory().length, 32);
  assert.equal(runReads(), 32);
  assert.equal(runParses(), 32);
  inventory.workflowRunInventorySignature(['parse-count']);
  inventory.workflowRunInventory();
  assert.equal(runReads(), 32, 'warm list/signature polls retain only the light projection');
  assert.equal(runParses(), 32);
  const listingCount = listings.mock.calls.length;
  const statCount = stats.mock.calls.length;
  assert.equal(inventory.workflowRunInventoryEntry('parse-8')?.record.status, 'running');
  assert.equal(listings.mock.calls.length, listingCount, 'viewed run does not enumerate the corpus');
  assert.equal(stats.mock.calls.length, statCount + 1, 'viewed run checks exactly one generation');
  assert.equal(runReads(), 32);
  write('parse-8', { workflow: 'parse-count', status: 'completed', needsAttention: true,
    reportBack: { outcome: 'blocked', detail: 'not retained' } });
  const changed = inventory.workflowRunInventoryEntry('parse-8')!.record;
  assert.equal(changed.status, 'completed');
  assert.equal(changed.needsAttention, true);
  assert.deepEqual(changed.reportBack, { outcome: 'blocked' });
  inventory.workflowRunInventory();
  assert.equal(runReads(), 33);
  assert.equal(runParses(), 33, 'one changed record is parsed exactly once across both consumers');
});

test('same-size atomic replacement with preserved mtime changes the projection and signature', () => {
  write('atomic', { workflow: 'atomic-flow', status: 'queued' });
  const file = path.join(WORKFLOW_RUNS_DIR, 'atomic.json');
  const fixed = new Date('2026-10-16T01:00:00.000Z');
  utimesSync(file, fixed, fixed);
  const beforeStat = statSync(file);
  const before = inventory.workflowRunInventorySignature(['atomic-flow']);
  const replacement = `${file}.replacement`;
  writeFileSync(replacement, JSON.stringify({ id: 'atomic', workflow: 'atomic-flow', status: 'failed' }));
  utimesSync(replacement, fixed, fixed);
  renameSync(replacement, file);
  assert.equal(statSync(file).size, beforeStat.size);
  assert.equal(statSync(file).mtimeMs, beforeStat.mtimeMs);
  assert.equal(inventory.workflowRunInventoryEntry('atomic')?.record.status, 'failed');
  assert.notEqual(inventory.workflowRunInventorySignature(['atomic-flow']), before);
});

test('a record replaced during the read is omitted until a stable generation can be read', (t) => {
  write('racing', { workflow: 'race-flow', status: 'running' });
  const file = path.join(WORKFLOW_RUNS_DIR, 'racing.json');
  const original = fs.readFileSync;
  let replace = true;
  t.mock.method(fs, 'readFileSync', (...args) => {
    const bytes = Reflect.apply(original, fs, args);
    if (args[0] === file && replace) {
      replace = false;
      const replacement = `${file}.replacement`;
      writeFileSync(replacement, JSON.stringify({ id: 'racing', workflow: 'race-flow', status: 'completed' }));
      renameSync(replacement, file);
    }
    return bytes;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(inventory.workflowRunInventoryEntry('racing'), null, 'unproven bytes never enter the cache');
  assert.equal(inventory.workflowRunInventoryEntry('racing')?.record.status, 'completed');
});

test('corruption, deletion and unreadable generations remove old projections and repairs return', (t) => {
  write('repair', { workflow: 'repair-flow', status: 'running' });
  const file = path.join(WORKFLOW_RUNS_DIR, 'repair.json');
  assert.equal(inventory.workflowRunInventoryEntry('repair')?.record.status, 'running');
  writeFileSync(file, '{broken');
  assert.deepEqual(inventory.workflowRunInventory(), []);
  write('repair', { workflow: 'repair-flow', status: 'completed' });
  assert.equal(inventory.workflowRunInventory().length, 1);
  const original = fs.statSync;
  const mocked = t.mock.method(fs, 'statSync', (...args) => {
    if (args[0] === file) throw Object.assign(new Error('controlled unreadable generation'), { code: 'EACCES' });
    return Reflect.apply(original, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(inventory.workflowRunInventory(), [], 'a failed stat cannot retain old status');
  mocked.mock.restore();
  syncBuiltinESMExports();
  assert.equal(inventory.workflowRunInventory().length, 1);
  unlinkSync(file);
  assert.equal(inventory.workflowRunInventoryEntry('repair'), null);
  assert.deepEqual(inventory.workflowRunInventory(), []);
});

test('exact-run lookup rejects paths without touching storage', (t) => {
  const reads = t.mock.method(fs, 'readFileSync');
  const stats = t.mock.method(fs, 'statSync');
  const listings = t.mock.method(fs, 'readdirSync');
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const runId of ['', '../foreign', 'nested/run', 'nested\\run']) {
    assert.equal(inventory.workflowRunInventoryEntry(runId), null);
  }
  assert.equal(reads.mock.calls.length, 0);
  assert.equal(stats.mock.calls.length, 0);
  assert.equal(listings.mock.calls.length, 0);
});

test('one captured inventory derives every workflow signature without rescanning metadata or parsing records', (t) => {
  for (let i = 0; i < 24; i++) write(`capture-${i}`, {
    workflow: `workflow-${i % 4}`, status: 'running', createdAt: `2026-10-16T01:00:${String(i).padStart(2, '0')}.000Z`,
    stepOutputs: { read: 'heavy'.repeat(4_000) },
  });
  const reads = t.mock.method(fs, 'readFileSync');
  const stats = t.mock.method(fs, 'statSync');
  const listings = t.mock.method(fs, 'readdirSync');
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const first = inventory.captureWorkflowRunInventory();
  assert.equal(first.entries.length, 24);
  assert.equal(reads.mock.calls.length, 24);
  assert.equal(stats.mock.calls.length, 48, 'cold records each have stable before/after metadata');
  assert.equal(listings.mock.calls.length, 1);
  for (let i = 0; i < 4; i++) {
    assert.match(first.signatureFor([`workflow-${i}`]), /^v2:[a-f0-9]{24}$/);
    assert.equal(first.signatureFor([`workflow-${i}`, 'missing', `workflow-${i}`]), first.signatureFor(['missing', `workflow-${i}`]));
  }
  assert.equal(reads.mock.calls.length, 24);
  assert.equal(stats.mock.calls.length, 48, 'per-workflow memo identities do not rescan the corpus');
  assert.equal(listings.mock.calls.length, 1);
  const warm = inventory.captureWorkflowRunInventory();
  assert.equal(reads.mock.calls.length, 24, 'a new unchanged request parses no heavy records');
  assert.equal(stats.mock.calls.length, 72, 'a new request checks each generation exactly once');
  assert.equal(listings.mock.calls.length, 2);
  assert.equal(warm.signatureFor(['workflow-0', 'workflow-1']), first.signatureFor(['workflow-1', 'workflow-0']));
});

test('captured records and signatures remain coherent after exact refresh, atomic replacement, deletion and cache reset', () => {
  write('captured', { workflow: 'captured-flow', status: 'queued' });
  write('independent', { workflow: 'another-flow', status: 'running' });
  const file = path.join(WORKFLOW_RUNS_DIR, 'captured.json');
  const fixed = new Date('2026-10-16T01:00:00.000Z');
  utimesSync(file, fixed, fixed);
  const beforeStat = statSync(file);
  const original = inventory.captureWorkflowRunInventory();
  const originalKey = original.signatureFor(['captured-flow']);
  const independentKey = original.signatureFor(['another-flow']);
  assert.ok(Object.isFrozen(original));
  assert.ok(Object.isFrozen(original.entries));
  const replacement = `${file}.replacement`;
  writeFileSync(replacement, JSON.stringify({ id: 'captured', workflow: 'captured-flow', status: 'failed' }));
  utimesSync(replacement, fixed, fixed);
  renameSync(replacement, file);
  assert.equal(statSync(file).size, beforeStat.size);
  assert.equal(statSync(file).mtimeMs, beforeStat.mtimeMs);
  assert.equal(inventory.workflowRunInventoryEntry('captured')?.record.status, 'failed', 'another reader refreshes the shared cache');
  assert.equal(original.entries.find(entry => entry.record.id === 'captured')?.record.status, 'queued');
  assert.equal(original.signatureFor(['captured-flow']), originalKey, 'old proof cannot acquire a newer memo identity');
  const refreshed = inventory.captureWorkflowRunInventory();
  assert.equal(refreshed.entries.find(entry => entry.record.id === 'captured')?.record.status, 'failed');
  assert.notEqual(refreshed.signatureFor(['captured-flow']), originalKey);
  assert.equal(refreshed.signatureFor(['another-flow']), independentKey, 'unrelated workflow groups remain stable');
  assert.equal(inventory.workflowRunInventorySignature(['captured-flow']), refreshed.signatureFor(['captured-flow']), 'legacy signature wrapper uses the same opaque identity');
  unlinkSync(file);
  assert.equal(inventory.workflowRunInventoryEntry('captured'), null);
  assert.equal(refreshed.entries.find(entry => entry.record.id === 'captured')?.record.status, 'failed');
  const afterDeletion = inventory.captureWorkflowRunInventory();
  assert.equal(afterDeletion.entries.some(entry => entry.record.id === 'captured'), false);
  assert.notEqual(afterDeletion.signatureFor(['captured-flow']), refreshed.signatureFor(['captured-flow']));
  inventory._resetWorkflowRunInventoryForTests();
  assert.equal(original.signatureFor(['captured-flow']), originalKey, 'signature derivation no longer consults global cache');
  assert.equal(original.entries.find(entry => entry.record.id === 'captured')?.record.status, 'queued');
});
