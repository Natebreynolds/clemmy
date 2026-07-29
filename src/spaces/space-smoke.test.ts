/**
 * Run: npx tsx --test src/spaces/space-smoke.test.ts
 *
 * The Space creation smoke (mirror of the workflow read-only creation test):
 * pure classifiers (looksEmpty, toolkitSlugForTool) + the runner-backed smoke
 * that catches a failed source and a zero-row source. No network/LLM (no
 * Composio actions declared → the toolkit check is skipped). Temp CLEMENTINE_HOME.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-smoke-test-'));

const smoke = await import('./space-smoke.js');
const store = await import('./store.js');
const runner = await import('./runner.js');

function writeRunner(slug: string, file: string, body: string) {
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), body, 'utf-8');
}

test('looksEmpty: empties vs data', () => {
  assert.equal(smoke.looksEmpty(null), true);
  assert.equal(smoke.looksEmpty([]), true);
  assert.equal(smoke.looksEmpty({}), true);
  assert.equal(smoke.looksEmpty({ contacts: [] }), true);
  assert.equal(smoke.looksEmpty({ _meta: { x: 1 } }), true);
  assert.equal(smoke.looksEmpty([1, 2]), false);
  assert.equal(smoke.looksEmpty({ contacts: [{ a: 1 }] }), false);
  assert.equal(smoke.looksEmpty({ count: 5 }), false);
});

test('toolkitSlugForTool derives the toolkit', () => {
  assert.equal(smoke.toolkitSlugForTool('OUTLOOK_OUTLOOK_SEND_EMAIL'), 'outlook');
  assert.equal(smoke.toolkitSlugForTool('SALESFORCE_QUERY'), 'salesforce');
});

test('smoke: a source returning rows passes (active, no failures, not empty)', async () => {
  const slug = 'smoke-ok';
  store.spaceStore.save({ id: slug, title: 'OK', dataSources: [{ id: 'pull', composioSlug: 'SALESFORCE_GET_CONTACTS' }] });
  runner._setSpaceComposioDispatchForTests(async () => ({
    ok: true as const, result: { rows: [{ a: 1 }] }, connectionId: 'ca-proof', identity: 'proof@example.test',
  }));
  try {
    const res = await smoke.runSpaceCreationSmoke(slug);
    assert.equal(res.failed.length, 0);
    assert.equal(res.empty.length, 0);
  } finally {
    runner._setSpaceComposioDispatchForTests(null);
  }
});

test('smoke: an installed legacy runner waits for pinned-entrypoint approval without being mislabeled broken', async () => {
  const slug = 'smoke-fail';
  store.spaceStore.save({ id: slug, title: 'Fail', dataSources: [{ id: 'pull', runner: 'bad.mjs' }] });
  writeRunner(slug, 'bad.mjs', 'process.exit(3)');
  const res = await smoke.runSpaceCreationSmoke(slug);
  assert.deepEqual(res.failed, []);
  assert.equal(res.awaitingApproval.length, 1);
  assert.equal(res.awaitingApproval[0]?.id, 'pull');
  assert.match(res.awaitingApproval[0]?.approvalId ?? '', /^apr-/);
});

test('smoke: a source returning [] is flagged empty (stays active, becomes a gap)', async () => {
  const slug = 'smoke-empty';
  store.spaceStore.save({ id: slug, title: 'Empty', dataSources: [{ id: 'pull', composioSlug: 'SALESFORCE_GET_CONTACTS' }] });
  runner._setSpaceComposioDispatchForTests(async () => ({
    ok: true as const, result: { rows: [] }, connectionId: 'ca-proof', identity: 'proof@example.test',
  }));
  try {
    const res = await smoke.runSpaceCreationSmoke(slug);
    assert.equal(res.failed.length, 0);
    assert.deepEqual(res.empty, ['pull']);
  } finally {
    runner._setSpaceComposioDispatchForTests(null);
  }
});

test('smoke: an explicitly allowed empty source is healthy and idempotent', async () => {
  const slug = 'smoke-expected-empty';
  store.spaceStore.save({
    id: slug,
    title: 'New content calendar',
    dataSources: [{ id: 'drafts', composioSlug: 'SALESFORCE_GET_DRAFTS', allowEmpty: true }],
  });
  runner._setSpaceComposioDispatchForTests(async () => ({
    ok: true as const, result: { rows: [] }, connectionId: 'ca-proof', identity: 'proof@example.test',
  }));
  try {
    const first = await smoke.runSpaceCreationSmoke(slug);
    const second = await smoke.runSpaceCreationSmoke(slug);
    assert.deepEqual(first.failed, []);
    assert.deepEqual(first.empty, []);
    assert.deepEqual(second.failed, []);
    assert.deepEqual(second.empty, []);
  } finally {
    runner._setSpaceComposioDispatchForTests(null);
  }
});
