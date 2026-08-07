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
  buildCompactToolCatalog,
  allRegistryNames,
  resolveHotSet,
  rankCatalog,
  executionLaneToolSearchEnabled,
} = await import('./tool-catalog.js');
const { recordToolHit, getHotSet, _resetHotSetForTest } = await import('./tool-hotset.js');
const { TOOL_REGISTRY } = await import('../tools/tool-registry.js');
const { TOOL_SEARCH_ALWAYS_LOADED } = await import('./tool-catalog.js');

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

test('compact catalog preserves every name without repeating descriptions', () => {
  const text = buildCompactToolCatalog();
  const tokens = new Set(text.split(/[^a-zA-Z0-9_]+/).filter(Boolean));
  for (const name of allRegistryNames()) assert.ok(tokens.has(name), `${name} missing from compact index`);
  assert.ok(text.length * 2 < buildToolCatalog().length, 'names-only index should materially reduce prompt bytes');
  assert.doesNotMatch(text, / — /, 'compact index carries names; tool_search supplies descriptions and schemas');
});

// ── hot-set resolution ────────────────────────────────────────────────────────

test('resolveHotSet seeds from the tiny schema kernel and includes session LRU', () => {
  _resetHotSetForTest();
  const sid = 'sess-hotset-1';
  recordToolHit(sid, 'workflow_schedule'); // a discoverable (non-core) registry tool
  const hot = resolveHotSet(sid, 'schedule a recurring workflow');

  const kernelInRegistry = [...TOOL_SEARCH_ALWAYS_LOADED].filter((n) => allRegistryNames().has(n));
  for (const n of kernelInRegistry) assert.ok(hot.has(n), `schema kernel ${n} should be first-class`);
  assert.ok(hot.has('workflow_schedule'), 'session LRU tool should be promoted');
});

test('resolveHotSet does not inherit the broad legacy JIT core', () => {
  const hot = resolveHotSet('sess-lean-kernel', 'hello there');
  assert.deepEqual(
    [...hot].sort(),
    [...TOOL_SEARCH_ALWAYS_LOADED].sort(),
    'a benign turn should load only the acquisition/recovery kernel',
  );
  for (const formerlyBroadCore of ['browser_harness_run', 'composio_execute_tool', 'run_shell_command', 'write_file']) {
    assert.equal(hot.has(formerlyBroadCore), false, `${formerlyBroadCore} must remain deferred but reachable`);
  }
});

// THE ASKING AFFORDANCE (live 2026-08-07). On the schema-on-demand lane the
// tool for asking the user a question had no schema at turn start, so the model
// would have had to search for the ability to ask while every tool needed to
// just start working was already loaded. It never asked. These pins fail if
// asking is ever pushed back behind discovery on any lane, for any wording.
test('the ask tool is first-class on a bare turn — asking is never behind a search', () => {
  _resetHotSetForTest();
  const hot = resolveHotSet('sess-ask-affordance', 'hello there');
  assert.ok(hot.has('ask_user_question'), 'ask_user_question must be schema-loaded with no prompting');
});

test('the ask tool stays first-class for a request that never names a tool', () => {
  _resetHotSetForTest();
  // The owner's real message that produced zero questions and went straight to work.
  const hot = resolveHotSet(
    'sess-ask-live-fixture',
    'we started pulling the data for arizona criminal defense firms but still havnt gotten them into a new airtable base can we finalize that',
  );
  assert.ok(hot.has('ask_user_question'), 'a consequential ask must not have to earn the right to ask back');
});

test('the ask tool description teaches WHEN to ask, not just the mechanics', async () => {
  const { TOOL_REGISTRY: registry } = await import('../tools/tool-registry.js');
  const entry = registry.find((d) => d.name === 'ask_user_question');
  assert.ok(entry, 'ask_user_question must stay in the registry');
  // A one-liner about pausing taught the model nothing about judgment; the
  // description has to name the trigger, or the affordance goes unused again.
  assert.match(entry!.description ?? '', /would change what you do|materially/i);
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

// ── execution-lane schema-on-demand admission ─────────────────────────────────

test('execution lanes get the deferred surface only while global tool-search is ON', () => {
  const priorExec = process.env.CLEMMY_EXECUTION_TOOL_SEARCH;
  const priorGlobal = process.env.CLEMMY_CODEX_TOOL_SEARCH;
  try {
    // Default: both on → execution lanes admitted to schema-on-demand.
    delete process.env.CLEMMY_EXECUTION_TOOL_SEARCH;
    delete process.env.CLEMMY_CODEX_TOOL_SEARCH;
    assert.equal(executionLaneToolSearchEnabled(), true, 'default admits execution lanes');

    // Execution kill-switch: full surface on execution lanes, chat untouched.
    process.env.CLEMMY_EXECUTION_TOOL_SEARCH = 'off';
    assert.equal(executionLaneToolSearchEnabled(), false, 'execution kill-switch stands the lane down');

    // Global tool-search off ⇒ execution lanes MUST fall back to the full
    // surface (never the legacy JIT pruner — pruning without catalog recovery
    // would strand a dropped tool on an unattended run).
    delete process.env.CLEMMY_EXECUTION_TOOL_SEARCH;
    process.env.CLEMMY_CODEX_TOOL_SEARCH = 'off';
    assert.equal(executionLaneToolSearchEnabled(), false, 'no catalog ⇒ no admission ⇒ full surface');
  } finally {
    if (priorExec === undefined) delete process.env.CLEMMY_EXECUTION_TOOL_SEARCH;
    else process.env.CLEMMY_EXECUTION_TOOL_SEARCH = priorExec;
    if (priorGlobal === undefined) delete process.env.CLEMMY_CODEX_TOOL_SEARCH;
    else process.env.CLEMMY_CODEX_TOOL_SEARCH = priorGlobal;
  }
});
