import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunContext } from '@openai/agents';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-home-tools-'));
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
const { getLocalDeferredDispatchTools, getLocalToolCatalog, getLocalToolSchemas } = await import('./local-runtime-tools.js');
const { observeCurrentLocalPlanningDefinition } = await import('../runtime/harness/local-planning-capability.js');
const { parseHostLocalWriteCommitFacts } = await import('../runtime/harness/host-local-write-commit.js');
const { InvalidArgumentsPreDispatchResult } = await import('../runtime/harness/attempt-settlement.js');
const { spaceStore } = await import('../spaces/store.js');
const { loadHomeLayout } = await import('../runtime/home-layout.js');

const tools = getLocalDeferredDispatchTools();
async function call(name: string, args: object) {
  const tool = tools.find(tool => tool.type === 'function' && tool.name === name);
  assert.ok(tool?.type === 'function', `${name} is callable`);
  return tool.invoke(new RunContext({ sessionId: 'home-tool-journey' }), JSON.stringify(args));
}

test('Home read and placement publish exact schemas and planning semantics', async () => {
  for (const name of ['home_get', 'home_update']) {
    assert.ok(getLocalToolCatalog().some(tool => tool.name === name));
    assert.ok(getLocalToolSchemas().has(name));
    const observed = await observeCurrentLocalPlanningDefinition({ name, carrier: 'work_call' });
    assert.equal(observed.ok, true, JSON.stringify(observed));
    if (observed.ok) assert.equal(observed.definition.descriptor.effect, name === 'home_get' ? 'read' : 'local_write');
  }
});

test('real captured tools create and edit a pinned Space, resize and unpin without deleting it', async () => {
  const before = JSON.parse(String(await call('home_get', {})));
  const slug = 'home-proof-board';
  const created = await call('space_save', { slug, title: 'Home proof board',
    view_html: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>Mentions</h1><p>17</p></body></html>',
    initial_data_json: JSON.stringify({ mentions: 17, _mobile: { headline: [{ label: 'Mentions', value: '17' }] } }),
  });
  assert.match(String(created), /Created workspace/);
  const dataPath = path.join(process.env.CLEMENTINE_HOME!, 'spaces', slug, 'data.json');
  const pin = { operation: 'pin', space_id: slug, expected_revision: before.revision };
  const first = String(await call('home_update', pin));
  const receipt = parseHostLocalWriteCommitFacts(first);
  assert.equal(receipt?.createdId, 'home');
  assert.equal(receipt?.handle, 'state/home-layout.json');
  assert.equal(parseHostLocalWriteCommitFacts(String(await call('home_update', pin)))?.contentDigest, receipt?.contentDigest);
  const read = JSON.parse(String(await call('home_get', {})));
  assert.equal(read.tiles.length, 1);
  assert.equal(read.tiles[0].spaceId, slug);
  const snapshot = String(await call('space_get', { slug }));
  const revision = snapshot.match(/Snapshot revision: ([a-f0-9]{64})/)?.[1];
  assert.ok(revision, snapshot);
  const replacement = JSON.parse(readFileSync(dataPath, 'utf8'));
  replacement.mentions = 31;
  replacement._mobile.headline[0].value = '31';
  const edited = await call('space_save', { slug, title: 'Home proof board', expected_revision: revision,
    replacement_data_json: JSON.stringify(replacement),
    view_html: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>Mentions</h1><p>31</p></body></html>',
  });
  assert.ok(parseHostLocalWriteCommitFacts(String(edited)), String(edited));
  assert.deepEqual(loadHomeLayout(), read, 'content edits preserve Home placement and its revision');
  const data = readFileSync(dataPath, 'utf8');
  assert.equal(JSON.parse(data).mentions, 31);
  assert.equal(JSON.parse(data)._mobile.headline[0].value, '31');
  assert.match(readFileSync(path.join(path.dirname(dataPath), spaceStore.get(slug)!.viewEntry), 'utf8'), /<p>31<\/p>/);
  const saved = spaceStore.get(slug)!;
  await call('home_update', { operation: 'update', space_id: slug, expected_revision: read.revision, width: 'wide' });
  const stale = await call('home_update', { operation: 'update', space_id: slug, expected_revision: read.revision, width: 'small' });
  assert.ok(stale instanceof InvalidArgumentsPreDispatchResult, String(stale));
  assert.match(String(stale), /layout_conflict/);
  await call('home_update', { operation: 'remove', space_id: slug, expected_revision: loadHomeLayout().revision });
  assert.equal(loadHomeLayout().tiles.length, 0);
  assert.equal(spaceStore.get(slug)?.version, saved.version);
  assert.equal(readFileSync(dataPath, 'utf8'), data);
});
