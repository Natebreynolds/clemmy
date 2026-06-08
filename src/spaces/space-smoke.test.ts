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
  store.spaceStore.save({ id: slug, title: 'OK', dataSources: [{ id: 'pull', runner: 'r.mjs' }] });
  writeRunner(slug, 'r.mjs', 'process.stdout.write(JSON.stringify({rows:[{a:1}]}))');
  const res = await smoke.runSpaceCreationSmoke(slug);
  assert.equal(res.failed.length, 0);
  assert.equal(res.empty.length, 0);
});

test('smoke: a source that errors is reported as failed (→ caller parks paused)', async () => {
  const slug = 'smoke-fail';
  store.spaceStore.save({ id: slug, title: 'Fail', dataSources: [{ id: 'pull', runner: 'bad.mjs' }] });
  writeRunner(slug, 'bad.mjs', 'process.exit(3)');
  const res = await smoke.runSpaceCreationSmoke(slug);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].id, 'pull');
});

test('smoke: a source returning [] is flagged empty (stays active, becomes a gap)', async () => {
  const slug = 'smoke-empty';
  store.spaceStore.save({ id: slug, title: 'Empty', dataSources: [{ id: 'pull', runner: 'empty.mjs' }] });
  writeRunner(slug, 'empty.mjs', 'process.stdout.write(JSON.stringify({rows:[]}))');
  const res = await smoke.runSpaceCreationSmoke(slug);
  assert.equal(res.failed.length, 0);
  assert.deepEqual(res.empty, ['pull']);
});
