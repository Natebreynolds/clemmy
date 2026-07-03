/**
 * Run: npx tsx --test src/spaces/publish.test.ts
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-space-publish-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { buildPublishSnapshot } = await import('./publish.js');
const { SPACES_DIR } = await import('./store.js');

const SLUG = 'client-seo-board';

function seedSpace(): void {
  const dir = path.join(SPACES_DIR, SLUG);
  mkdirSync(path.join(dir, 'view', 'assets'), { recursive: true });
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify({
    id: SLUG, title: 'Client SEO Board', status: 'active', version: 1,
    viewEntry: 'view/index.html',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    dataSources: [{ id: 'rankings' }], actions: [], revisions: [],
  }), 'utf-8');
  writeFileSync(path.join(dir, 'view', 'index.html'),
    '<!doctype html><html><head><title>Board</title></head><body><div id="app"></div>'
    + '<script>clem.data().then(d=>{document.getElementById("app").textContent=JSON.stringify(d)});</script>'
    + '</body></html>', 'utf-8');
  writeFileSync(path.join(dir, 'view', 'assets', 'style.css'), 'body{margin:0}', 'utf-8');
  writeFileSync(path.join(dir, 'data.json'), JSON.stringify({
    rankings: [{ kw: 'law firm seo', pos: 3 }, { kw: 'injury lawyer', pos: 7 }],
    _meta: { rankings: { refreshedAt: 'x', ok: true, runner: '/local/private/path/pull.mjs' } },
  }), 'utf-8');
}

test('buildPublishSnapshot: self-contained export — data inlined, _meta stripped, actions frozen, assets copied', () => {
  seedSpace();
  const result = buildPublishSnapshot(SLUG);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;

  assert.ok(result.dir.includes(path.join(SLUG, 'publish')), 'export lands under the space publish/ dir (never served)');
  const html = readFileSync(path.join(result.dir, 'index.html'), 'utf-8');

  // Dataset inlined; provenance stripped.
  assert.match(html, /law firm seo/, 'dataset rows are inlined');
  assert.ok(!html.includes('_meta'), 'reserved _meta provenance is stripped');
  assert.ok(!html.includes('/local/private/path'), 'runner paths never leak into the export');

  // Static bridge: same window.clem surface, side effects frozen, marked snapshot.
  assert.match(html, /window\.clem=\{slug:"client-seo-board",snapshot:true/, 'static clem bridge injected');
  assert.match(html, /published snapshot/, 'frozen actions explain themselves');
  assert.ok(!html.includes('/api/console/spaces'), 'no live data-plane URLs in the export');
  assert.match(html, /clementine-snapshot/, 'snapshot marker present');

  // Assets copied byte-for-byte.
  assert.equal(readFileSync(path.join(result.dir, 'assets', 'style.css'), 'utf-8'), 'body{margin:0}');
  assert.deepEqual(result.rowsBySource, { rankings: 2 });

  // Audit entry recorded.
  const audit = readFileSync(path.join(SPACES_DIR, SLUG, 'audit.jsonl'), 'utf-8');
  assert.match(audit, /PUBLISH/);
});

test('buildPublishSnapshot: each publish is a NEW timestamped folder (prior exports kept)', async () => {
  const first = buildPublishSnapshot(SLUG);
  await new Promise((r) => setTimeout(r, 5));
  const second = buildPublishSnapshot(SLUG);
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(first.dir, second.dir, 'exports never overwrite each other');
  assert.ok(existsSync(first.dir) && existsSync(second.dir));
  assert.ok(readdirSync(path.join(SPACES_DIR, SLUG, 'publish')).length >= 2);
});

test('buildPublishSnapshot: refuses archived and missing workspaces', () => {
  assert.equal(buildPublishSnapshot('never-existed').ok, false);
  const manifest = path.join(SPACES_DIR, SLUG, 'space.json');
  const rec = JSON.parse(readFileSync(manifest, 'utf-8'));
  writeFileSync(manifest, JSON.stringify({ ...rec, status: 'archived' }), 'utf-8');
  const res = buildPublishSnapshot(SLUG);
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /archived/);
  writeFileSync(manifest, JSON.stringify({ ...rec, status: 'active' }), 'utf-8');
});

after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});
