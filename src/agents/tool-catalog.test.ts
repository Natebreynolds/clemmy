import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

// Isolate CLEMENTINE_HOME BEFORE importing anything that resolves the hot-set
// state path, so the LRU never touches real state (memory: isolate CLEMENTINE_HOME).
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-hotset-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  catalogEntries,
  buildToolCatalog,
  allRegistryNames,
  resolveHotSet,
  rankCatalog,
} = await import('./tool-catalog.js');
const { recordToolHit, getHotSet, _resetHotSetForTest } = await import('./tool-hotset.js');
const { TOOL_REGISTRY } = await import('../tools/tool-registry.js');
const { TOOL_JIT_MANDATED } = await import('./tool-jit.js');

// ── catalog derives 1:1 from the registry ─────────────────────────────────────

test('catalog lists every registry tool (reachability invariant)', () => {
  const catalog = new Set(catalogEntries().map((e) => e.name));
  const registry = allRegistryNames();
  const missing = [...registry].filter((n) => !catalog.has(n)).sort();
  assert.deepEqual(missing, [], `registry tools missing from the catalog: ${missing.join(', ')}`);
  assert.equal(catalog.size, registry.size);
  assert.equal(catalog.size, TOOL_REGISTRY.length);
});

test('policy-allowed filter restricts the catalog to the lane surface', () => {
  const allowed = new Set(['read_file', 'run_batch', 'memory_recall']);
  const catalog = catalogEntries({ allowedNames: allowed });
  assert.deepEqual(new Set(catalog.map((e) => e.name)), allowed);
  // Reachability holds within the restricted surface too.
  for (const n of allowed) assert.ok(catalog.some((e) => e.name === n), `${n} missing`);
});

test('buildToolCatalog renders "name — one-liner" lines and is non-trivial', () => {
  const text = buildToolCatalog();
  const lines = text.split('\n');
  assert.equal(lines.length, TOOL_REGISTRY.length);
  const runBatch = lines.find((l) => l.startsWith('run_batch —'));
  assert.ok(runBatch && runBatch.length > 'run_batch — '.length, 'run_batch line should carry a summary');
});

// ── hot-set resolution ────────────────────────────────────────────────────────

test('resolveHotSet seeds from TOOL_JIT_MANDATED and includes session LRU', () => {
  _resetHotSetForTest();
  const sid = 'sess-hotset-1';
  recordToolHit(sid, 'workflow_schedule'); // a discoverable (non-core) registry tool
  const hot = resolveHotSet(sid, 'schedule a recurring workflow');

  const mandatedInRegistry = [...TOOL_JIT_MANDATED].filter((n) => allRegistryNames().has(n));
  for (const n of mandatedInRegistry) assert.ok(hot.has(n), `mandated ${n} should be first-class`);
  assert.ok(hot.has('workflow_schedule'), 'session LRU tool should be promoted');
});

test('resolveHotSet drops LRU names that are not real registry tools', () => {
  _resetHotSetForTest();
  const sid = 'sess-hotset-2';
  recordToolHit(sid, 'not_a_real_tool');
  const hot = resolveHotSet(sid, 'do something');
  assert.ok(!hot.has('not_a_real_tool'), 'ghost tool must never enter the hot-set');
});

test('resolveHotSet respects an allowedNames policy', () => {
  _resetHotSetForTest();
  const sid = 'sess-hotset-3';
  recordToolHit(sid, 'read_file');
  const allowed = new Set(['read_file']);
  const hot = resolveHotSet(sid, 'read a file', { allowedNames: allowed });
  assert.deepEqual([...hot], ['read_file']); // mandated tools excluded by policy
});

test('resolveHotSet makes an explicitly named tool first-class without prior LRU state', () => {
  _resetHotSetForTest();
  const hot = resolveHotSet('sess-hotset-literal', 'Call task_hygiene now and report its exact result.');
  assert.ok(hot.has('task_hygiene'));
  assert.ok(!getHotSet('sess-hotset-literal').includes('task_hygiene'), 'literal promotion is turn-scoped, not persisted');
});

// ── ranking (lexical fallback path, embeddings off in tests) ───────────────────

test('rankCatalog ranks an on-topic tool above an unrelated one', async () => {
  const ranked = await rankCatalog('schedule a recurring workflow');
  const idx = (name: string) => ranked.findIndex((r) => r.name === name);
  const sched = idx('workflow_schedule');
  const readFile = idx('read_file');
  assert.ok(sched >= 0 && readFile >= 0);
  assert.ok(sched < readFile, 'workflow_schedule should outrank read_file for this query');
});

test('rankCatalog returns all entries and never throws on empty query', async () => {
  const ranked = await rankCatalog('');
  assert.equal(ranked.length, TOOL_REGISTRY.length);
});
