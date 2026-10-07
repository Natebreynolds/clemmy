/**
 * Run: npx tsx --test src/spaces/publish.test.ts
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { Script } from 'node:vm';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-space-publish-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { buildPublishSnapshot, _setPublishCaptureObserverForTests } = await import('./publish.js');
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
  assert.ok(!/\\"_meta\\"/.test(html), 'reserved _meta provenance is stripped from the inlined dataset');
  assert.ok(!html.includes('/local/private/path'), 'runner paths never leak into the export');

  // Static bridge: same window.clem surface, side effects frozen, marked snapshot.
  assert.match(html, /window\.clem=\{slug:"client-seo-board",snapshot:true/, 'static clem bridge injected');
  assert.ok(
    html.indexOf('window.clem=') < html.indexOf('clem.data().then'),
    'published bridge is defined before the authored script executes',
  );
  assert.ok(html.indexOf('window.clem=') < html.indexOf('<body>'), 'published bridge starts in <head>, matching live views');
  assert.match(html, /published snapshot/, 'frozen actions explain themselves');
  // The framework design layer travels with the export, so a snapshot looks
  // like the live view in either theme and the helper kit keeps working.
  assert.ok(html.indexOf('<style id="clem-view-design">') > 0, 'design stylesheet inlined');
  assert.ok(html.indexOf('window.__clemKit=') < html.indexOf('window.clem='), 'kit precedes the static bridge');
  assert.match(html, /window\.clem\.fmt=K\.fmt;window\.clem\.ui=K\.ui/, 'static bridge adopts the kit');
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

test('buildPublishSnapshot: hostile external data cannot break out of the bridge script and hydrates exactly', async () => {
  const slug = 'script-boundary-board';
  const dir = path.join(SPACES_DIR, slug);
  mkdirSync(path.join(dir, 'view'), { recursive: true });
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify({
    id: slug, title: 'Script Boundary Board', status: 'active', version: 1,
    viewEntry: 'view/index.html',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    dataSources: [{ id: 'external' }], actions: [], revisions: [],
  }), 'utf-8');
  writeFileSync(
    path.join(dir, 'view', 'index.html'),
    '<!doctype html><html><head><title>Boundary</title></head>'
      + '<body><script>window.__AUTHORED_SCRIPT_RAN__=true;</script></body></html>',
    'utf-8',
  );
  const hostileRow: Record<string, unknown> = {
    copy: '</script><script>window.__PUBLISHED_DATA_EXECUTED__=true</script><!--',
    html: '<img src=x onerror="window.__PUBLISHED_HTML_EXECUTED__=true">',
    separators: '\u2028\u2029',
  };
  Object.defineProperty(hostileRow, '__proto__', {
    value: { remainsAnOwnDataKey: true },
    enumerable: true,
  });
  const hostile: Record<string, unknown> = { external: [hostileRow] };
  writeFileSync(path.join(dir, 'data.json'), JSON.stringify(hostile), 'utf-8');

  const result = buildPublishSnapshot(slug);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const html = readFileSync(path.join(result.dir, 'index.html'), 'utf-8');

  // Exactly the framework kit, the static bridge, and the authored script.
  assert.equal((html.match(/<script\b/gi) ?? []).length, 3, 'data cannot mint an executable script element');
  assert.ok(!html.includes('</script><script>window.__PUBLISHED_DATA_EXECUTED__'), 'literal script boundary is absent');
  assert.match(html, /\\u003c\/script>/, 'HTML-significant less-than signs are escaped in script source');

  const bridgeAt = html.indexOf('window.clem=');
  const authoredAt = html.indexOf('window.__AUTHORED_SCRIPT_RAN__');
  assert.ok(bridgeAt >= 0 && bridgeAt < authoredAt, 'published bridge precedes authored JavaScript');
  const scriptStart = html.lastIndexOf('<script', bridgeAt);
  const sourceStart = html.indexOf('>', scriptStart) + 1;
  const sourceEnd = html.indexOf('</script>', bridgeAt);
  const bridgeSource = html.slice(sourceStart, sourceEnd);
  const windowObject: Record<string, unknown> = {};
  new Script(bridgeSource).runInNewContext({ window: windowObject });
  const clem = windowObject.clem as { data(): Promise<unknown> };
  const hydrated = await clem.data();
  assert.equal(JSON.stringify(hydrated), JSON.stringify(hostile), 'snapshot data matches the live JSON document');
  assert.equal(
    Object.prototype.hasOwnProperty.call((hydrated as { external: unknown[] }).external[0], '__proto__'),
    true,
    'JSON hydration does not reinterpret a nested external data key as an object prototype',
  );
  assert.equal(windowObject.__PUBLISHED_DATA_EXECUTED__, undefined);
  assert.equal(windowObject.__PUBLISHED_HTML_EXECUTED__, undefined);
});

function seedPublishFixture(slug: string): string {
  const dir = path.join(SPACES_DIR, slug);
  mkdirSync(path.join(dir, 'view', 'assets'), { recursive: true });
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify({
    id: slug, title: 'Controlled publish fixture', status: 'active', version: 1,
    viewEntry: 'view/index.html', dataSources: [], actions: [], revisions: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
  writeFileSync(path.join(dir, 'view', 'index.html'), '<html><body>ORIGINAL_VIEW</body></html>');
  writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ fixture: [{ version: 'ORIGINAL_DATA' }] }));
  return dir;
}

test('publish refuses linked roots, HTML, directories, cycles, manifest, dataset and output before creating an export', () => {
  const outside = path.join(TMP_HOME, 'outside-publish-fixture');
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'outside.html'), '<html>OUTSIDE_BYTES_MUST_NOT_EXPORT</html>');
  writeFileSync(path.join(outside, 'outside.json'), JSON.stringify({ outside: 'OUTSIDE_BYTES_MUST_NOT_EXPORT' }));
  for (const [index, kind] of ['html', 'directory', 'cycle', 'view', 'manifest', 'dataset', 'dangling-data', 'output'].entries()) {
    const slug = `publish-linked-${index}`;
    const dir = seedPublishFixture(slug);
    if (kind === 'html') symlinkSync(path.join(outside, 'outside.html'), path.join(dir, 'view', 'linked.html'));
    if (kind === 'directory') symlinkSync(outside, path.join(dir, 'view', 'linked-directory'), 'dir');
    if (kind === 'cycle') symlinkSync(path.join(dir, 'view'), path.join(dir, 'view', 'assets', 'cycle'), 'dir');
    if (kind === 'view') {
      rmSync(path.join(dir, 'view'), { recursive: true });
      symlinkSync(outside, path.join(dir, 'view'), 'dir');
    }
    if (kind === 'manifest') {
      rmSync(path.join(dir, 'space.json'));
      symlinkSync(path.join(outside, 'outside.json'), path.join(dir, 'space.json'));
    }
    if (kind === 'dataset' || kind === 'dangling-data') {
      rmSync(path.join(dir, 'data.json'));
      symlinkSync(path.join(outside, kind === 'dataset' ? 'outside.json' : 'missing.json'), path.join(dir, 'data.json'));
    }
    if (kind === 'output') symlinkSync(outside, path.join(dir, 'publish'), 'dir');
    const before = readdirSync(outside).sort();
    const result = buildPublishSnapshot(slug);
    assert.equal(result.ok, false, kind);
    if (result.ok) continue;
    assert.doesNotMatch(result.error, /OUTSIDE_BYTES_MUST_NOT_EXPORT/);
    assert.ok(!result.error.includes(outside), 'public refusal never exposes external target paths');
    if (kind !== 'output') assert.equal(existsSync(path.join(dir, 'publish')), false, 'capture refusal creates no export output');
    assert.deepEqual(readdirSync(outside).sort(), before, 'linked output target receives no export');
  }
});

test('publish refuses nonregular assets without opening them', { skip: process.platform === 'win32' }, () => {
  const dir = seedPublishFixture('publish-nonregular');
  execFileSync('mkfifo', [path.join(dir, 'view', 'assets', 'fixture-pipe')]);
  const result = buildPublishSnapshot('publish-nonregular');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /view\/assets\/fixture-pipe.*regular file/);
  assert.equal(existsSync(path.join(dir, 'publish')), false);
});

test('linked Workspace root is rejected before its outside recovery journal is inspected', () => {
  const outside = path.join(TMP_HOME, 'outside-root-journal-fixture');
  mkdirSync(outside, { recursive: true });
  const journal = path.join(outside, '.clementine-workspace-update.json');
  writeFileSync(journal, '{INVALID_OUTSIDE_JOURNAL_BYTES');
  const slug = 'publish-linked-root-journal';
  symlinkSync(outside, path.join(SPACES_DIR, slug), 'dir');
  const result = buildPublishSnapshot(slug);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /"Workspace".*direct directory/,
      'root refusal happens before the owner would parse the outside recovery journal');
    assert.ok(!result.error.includes(outside));
    assert.doesNotMatch(result.error, /INVALID_OUTSIDE_JOURNAL_BYTES/);
  }
  assert.equal(readFileSync(journal, 'utf8'), '{INVALID_OUTSIDE_JOURNAL_BYTES');
  assert.deepEqual(readdirSync(outside), ['.clementine-workspace-update.json']);
});

test('publish refuses corrupt present datasets while a genuinely absent dataset and nested assets still export', () => {
  for (const [index, bytes] of ['{broken PRIVATE_FIXTURE_BYTES', 'null', '[]'].entries()) {
    const slug = `publish-corrupt-data-${index}`;
    const dir = seedPublishFixture(slug);
    writeFileSync(path.join(dir, 'data.json'), bytes);
    const result = buildPublishSnapshot(slug);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /data.json/);
      assert.doesNotMatch(result.error, /PRIVATE_FIXTURE_BYTES/);
    }
    assert.equal(existsSync(path.join(dir, 'publish')), false);
  }
  const slug = 'publish-no-dataset';
  const dir = seedPublishFixture(slug);
  rmSync(path.join(dir, 'data.json'));
  mkdirSync(path.join(dir, 'view', 'assets', 'nested'));
  const binary = Buffer.alloc(2 * 1024 * 1024 + 17, 42);
  binary[0] = 0; binary[1] = 255; binary[binary.length - 1] = 10;
  writeFileSync(path.join(dir, 'view', 'assets', 'nested', 'fixture.bin'), binary);
  writeFileSync(path.join(dir, 'view', '..style.css'), 'body{color:inherit}');
  const result = buildPublishSnapshot(slug);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) {
    assert.deepEqual(result.rowsBySource, {});
    assert.deepEqual(readFileSync(path.join(result.dir, 'assets', 'nested', 'fixture.bin')), binary);
    assert.equal(readFileSync(path.join(result.dir, '..style.css'), 'utf8'), 'body{color:inherit}',
      'an in-root filename beginning with dots is not a parent traversal');
    assert.match(readFileSync(path.join(result.dir, 'index.html'), 'utf8'), /ORIGINAL_VIEW/);
  }
});

test('publish capture holds the existing snapshot owner across dataset and view against a cooperating writer', async () => {
  const slug = 'publish-revision-barrier';
  const dir = seedPublishFixture(slug);
  const attempted = path.join(TMP_HOME, 'publish-writer-attempted');
  const committed = path.join(TMP_HOME, 'publish-writer-committed');
  let writer: ReturnType<typeof spawn> | undefined;
  let writerDone: Promise<void> | undefined;
  _setPublishCaptureObserverForTests(() => {
    const code = `import fs from 'node:fs';\n`
      + `const { withWorkspaceSnapshotMutation } = await import(${JSON.stringify(new URL('./workspace-snapshot.ts', import.meta.url).href)});\n`
      + `fs.writeFileSync(${JSON.stringify(attempted)}, 'attempted');\n`
      + `withWorkspaceSnapshotMutation(${JSON.stringify(slug)}, () => {\n`
      + `fs.writeFileSync(${JSON.stringify(path.join(dir, 'data.json'))}, JSON.stringify({fixture:[{version:'NEW_DATA'}]}));\n`
      + `fs.writeFileSync(${JSON.stringify(path.join(dir, 'view', 'index.html'))}, '<html><body>NEW_VIEW</body></html>');\n`
      + `fs.writeFileSync(${JSON.stringify(committed)}, 'committed'); });`;
    writer = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      env: { ...process.env, CLEMENTINE_HOME: TMP_HOME }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errorText = '';
    writer.stderr?.on('data', data => { errorText += String(data); });
    writerDone = new Promise((resolve, reject) => {
      writer!.once('error', reject);
      writer!.once('exit', code => code === 0 ? resolve() : reject(new Error(`Controlled writer failed: ${errorText}`)));
    });
    const deadline = Date.now() + 5_000;
    const sleepCell = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(attempted) && Date.now() < deadline) Atomics.wait(sleepCell, 0, 0, 20);
    assert.ok(existsSync(attempted), 'separate process reached the shared owner barrier');
    Atomics.wait(sleepCell, 0, 0, 150);
    assert.equal(existsSync(committed), false, 'writer cannot commit between dataset and view capture');
    assert.match(readFileSync(path.join(dir, 'view', 'index.html'), 'utf8'), /ORIGINAL_VIEW/);
  });
  try {
    const result = buildPublishSnapshot(slug);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(writerDone);
    await writerDone;
    assert.equal(existsSync(committed), true, 'writer completes when capture releases its owner');
    if (result.ok) {
      const html = readFileSync(path.join(result.dir, 'index.html'), 'utf8');
      assert.match(html, /ORIGINAL_DATA/);
      assert.match(html, /ORIGINAL_VIEW/);
      assert.doesNotMatch(html, /NEW_DATA|NEW_VIEW/);
    }
    assert.match(readFileSync(path.join(dir, 'view', 'index.html'), 'utf8'), /NEW_VIEW/);
  } finally {
    _setPublishCaptureObserverForTests(null);
    if (writer && writer.exitCode === null) writer.kill();
  }
});

after(() => {
  _setPublishCaptureObserverForTests(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});
