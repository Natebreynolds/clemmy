/**
 * Callable-surface oracle pins (W1 Stage 1.1).
 *
 * The load-bearing properties: fail-closed toward silence (no registration /
 * unknown name → never mandatable), cached contracts surface schema AND the
 * banked working example, task-scoped elimination flows through, and the
 * mandate precondition (reachable + un-eliminated + schema in hand) holds.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'callable-surface-test-'));

import test from 'node:test';
import assert from 'node:assert/strict';

const { saveToolContract, saveToolContractExample, _clearToolContractsForTests } = await import('../../tools/tool-contract-store.js');
const { eliminateCandidateForTask } = await import('./attempt-settlement.js');
const {
  _clearLocalSchemaProviderForTests,
  isMandatable,
  registerLocalSchemaProvider,
  resolveCallable,
} = await import('./callable-surface.js');

test.beforeEach(() => {
  _clearToolContractsForTests();
  _clearLocalSchemaProviderForTests();
});

test('FAIL-CLOSED: no registration and no contract → silence, never a phantom mandate', () => {
  const entry = resolveCallable('fixture_unregistered_tool');
  assert.equal(entry.schemaSource, 'none');
  assert.equal(entry.reachable, false, 'bare local name without registration is not provably dispatchable');
  assert.equal(isMandatable(entry), false);
});

test('registered local schema → direct carrier, mandatable, required fields surfaced', () => {
  registerLocalSchemaProvider(() => new Map([
    ['fixture_local_tool', { type: 'object', required: ['input'], properties: { input: { type: 'string' } } }],
  ]));
  const entry = resolveCallable('fixture_local_tool');
  assert.equal(entry.schemaSource, 'local_registry');
  assert.equal(entry.carrier, 'direct');
  assert.deepEqual(entry.requiredFields, ['input']);
  assert.equal(isMandatable(entry), true);
});

test('cached contract → provider carrier with schema AND the banked working example', () => {
  saveToolContract({
    identifier: 'GOOGLESHEETS_SHEET_FROM_JSON',
    schema: { type: 'object', required: ['title', 'sheet_name', 'sheet_json'], properties: {} },
  });
  saveToolContractExample({
    identifier: 'GOOGLESHEETS_SHEET_FROM_JSON',
    exampleArgs: { title: 'x', sheet_name: 'y', sheet_json: '[]' },
  });
  const entry = resolveCallable('GOOGLESHEETS_SHEET_FROM_JSON');
  assert.equal(entry.schemaSource, 'cached_contract');
  assert.equal(entry.carrier, 'provider_carrier');
  assert.deepEqual(entry.requiredFields, ['title', 'sheet_name', 'sheet_json']);
  assert.ok(entry.exampleArgs, 'the worked example rides the oracle so refusals can contain the answer');
  assert.equal(isMandatable(entry), true);
});

test('slug-shaped identity without schema stays dispatchable but NEVER mandatable', () => {
  const slug = resolveCallable('APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS');
  assert.equal(slug.reachable, true, 'schema-first validation happens at dispatch');
  assert.equal(slug.schemaSource, 'none');
  assert.equal(isMandatable(slug), false, 'no schema in hand → a guardrail may not name it');

  const mcp = resolveCallable('dataforseo__serp_organic_live_advanced');
  assert.equal(mcp.reachable, true);
  assert.equal(mcp.carrier, 'call_tool');
  assert.equal(isMandatable(mcp), false);
});

test('task-scoped elimination defeats mandatability even with a schema in hand', () => {
  registerLocalSchemaProvider(() => new Map([
    ['browser_harness_run', { type: 'object', required: ['url'], properties: {} }],
  ]));
  eliminateCandidateForTask('sess-cs-test', 41, 'browser_harness_run');
  const eliminated = resolveCallable('browser_harness_run', { sessionId: 'sess-cs-test', sourceUserSeq: 41 });
  assert.equal(eliminated.eliminatedForTask, true);
  assert.equal(isMandatable(eliminated), false, 'the model must not be steered back to a disproved candidate');

  const otherTask = resolveCallable('browser_harness_run', { sessionId: 'sess-cs-test', sourceUserSeq: 42 });
  assert.equal(otherTask.eliminatedForTask, false, 'elimination is task-scoped, never global');
  assert.equal(isMandatable(otherTask), true);
});

test('oracle is total: empty and garbage names return silent entries, never throw', () => {
  for (const name of ['', '   ', 'not a tool name!!', 'shape:outlook:create:draft']) {
    const entry = resolveCallable(name);
    assert.equal(entry.schema, null);
    assert.equal(isMandatable(entry), false);
  }
});

test.after(() => {
  rmSync(process.env.CLEMENTINE_HOME!, { recursive: true, force: true });
});
