/**
 * Run: node scripts/run-tests-isolated.mjs src/spaces/space-preview.test.ts
 *
 * The author's eyes on a Workspace: a headless screenshot of the exact served
 * document with its stored data. The browser is faked here (a script that
 * writes the screenshot and lingers, like a real one can); a real render runs
 * only with CLEMMY_TEST_REAL_BROWSER=1.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-preview-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const preview = await import('./space-preview.js');
after(() => rmSync(HOME, { recursive: true, force: true }));

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

function fakeBrowser(name: string, body: string): string {
  const file = path.join(HOME, name);
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

const lingering = fakeBrowser('lingering-browser.js', `
const fs = require('node:fs');
const arg = process.argv.find((value) => value.startsWith('--screenshot='));
fs.writeFileSync(arg.slice('--screenshot='.length), Buffer.from('${PNG.toString('hex')}', 'hex'));
fs.writeFileSync(${JSON.stringify(path.join(HOME, 'lingering.pid'))}, String(process.pid));
setInterval(() => {}, 1000);
`);
const silent = fakeBrowser('silent-browser.js', 'setInterval(() => {}, 1000);');

const temporaryPreviewDirs = () => readdirSync(os.tmpdir()).filter((name) => name.startsWith('clem-space-preview-') && !HOME.endsWith(name));

test('a browser that writes its screenshot and lingers still yields the image, and is stopped and cleaned up', async () => {
  const before = new Set(temporaryPreviewDirs());
  const result = await preview.renderWorkspacePreview({
    slug: 'my-board',
    servedViewHtml: '<!doctype html><html><body><h1>Board</h1></body></html>',
    dataset: { rows: [1, 2, 3] },
    theme: 'dark',
    width: 390,
  }, { browser: lingering, timeoutMs: 10_000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.ok(result.png.equals(PNG), 'the screenshot bytes come back');
  assert.equal(result.theme, 'dark');
  assert.equal(result.width, 390);
  const pid = Number((await import('node:fs')).readFileSync(path.join(HOME, 'lingering.pid'), 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the lingering browser process was stopped');
  assert.deepEqual(temporaryPreviewDirs().filter((name) => !before.has(name)), [], 'its temporary files were removed');
});

test('the page\'s uncaught errors and refused loads come back with the preview; its ordinary logging and the host page do not', async () => {
  const log = [
    '[1:2:1008/233008.933442:INFO:CONSOLE:1] "Uncaught ReferenceError: rowz is not defined", source: file:///tmp/x/view.html (12)',
    '[1:2:1008/233008.933442:INFO:CONSOLE:1] "Uncaught ReferenceError: rowz is not defined", source: file:///tmp/x/view.html (12)',
    '[1:2:1008/233008.933516:INFO:CONSOLE:1] "rendered 3 rows", source: file:///tmp/x/view.html (14)',
    '[1:2:1008/233008.933516:INFO:CONSOLE(3)] "Refused to load the image \'https://x.example/a.png\' because it violates the following Content Security Policy directive", source: file:///tmp/x/view.html (0)',
    '[1:2:1008/233008.933516:INFO:CONSOLE:1] "Uncaught TypeError: host", source: file:///tmp/x/index.html (1)',
    'some unrelated browser line',
  ].join('\n');
  assert.deepEqual(preview.pageProblemsFromBrowserLog(log), [
    'Uncaught ReferenceError: rowz is not defined (line 12)',
    'Refused to load the image \'https://x.example/a.png\' because it violates the following Content Security Policy directive (line 0)',
  ]);

  const reporting = fakeBrowser('reporting-browser.js', `
const fs = require('node:fs');
process.stderr.write('[1:2:1008/1.0:INFO:CONSOLE:1] "Uncaught SyntaxError: Unexpected token \\')\\'", source: file:///tmp/p/view.html (4)\\n');
const arg = process.argv.find((value) => value.startsWith('--screenshot='));
fs.writeFileSync(arg.slice('--screenshot='.length), Buffer.from('${PNG.toString('hex')}', 'hex'));
`);
  const result = await preview.renderWorkspacePreview({
    slug: 'broken-board', servedViewHtml: '<html><body></body></html>', dataset: {},
  }, { browser: reporting, timeoutMs: 10_000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.deepEqual(result.problems, ["Uncaught SyntaxError: Unexpected token ')' (line 4)"]);
});

test('a browser that never writes a screenshot times out with a reason; no browser at all says so', async () => {
  const slow = await preview.renderWorkspacePreview({
    slug: 'my-board', servedViewHtml: '<html></html>', dataset: {},
  }, { browser: silent, timeoutMs: 1_200 });
  assert.equal(slow.ok, false);
  if (!slow.ok) assert.match(slow.reason, /did not produce a preview in time/);
  const none = await preview.renderWorkspacePreview({
    slug: 'my-board', servedViewHtml: '<html></html>', dataset: {},
  }, { browser: null });
  assert.equal(none.ok, false);
  if (!none.ok) assert.match(none.reason, /no Chromium-family browser/);
});

test('the preview host frames the view like the desktop and answers the bridge from the stored data only', () => {
  const page = preview.previewHostPage({
    slug: 'my-board',
    dataset: { emails: [{ subject: '</script><script>alert(1)</script>' }] },
    viewFile: 'view.html',
    theme: 'dark',
  });
  assert.match(page, /<iframe id="frame" sandbox="allow-scripts"><\/iframe>/);
  assert.match(page, /frame\.src="view\.html\?theme=dark"/);
  assert.ok(!page.includes('</script><script>alert(1)'), 'stored data cannot close the host script');
  assert.match(page, /if\(r\.op==='data'\)return reply\(true,D\)/);
  assert.match(page, /actions, notes, and compose do not run/);
  assert.match(page, /iframe\{border:0;width:100%;/, 'without a width the frame fills the window');
  const phone = preview.previewHostPage({ slug: 'my-board', dataset: {}, viewFile: 'view.html', theme: 'light', width: 390 });
  assert.match(phone, /iframe\{border:0;width:390px;/, 'a phone preview lays the view out at the phone width');
  const lower = preview.previewHostPage({ slug: 'my-board', dataset: {}, viewFile: 'view.html', theme: 'light', offsetY: 900 });
  assert.match(lower, /top:-900px;height:calc\(100% \+ 900px\)/, 'a lower part of the page is shown by shifting a taller frame');
});

test('a local page is framed where it lies, at the requested width, and cannot leave its frame', () => {
  const page = preview.localPageHostPage({ fileUrl: 'file:///srv/work/a%20brief/index.html?x=1&y=2', width: 390, offsetY: 0 });
  assert.match(page, /<iframe sandbox="allow-scripts allow-same-origin" src="file:\/\/\/srv\/work\/a%20brief\/index\.html\?x=1&amp;y=2"><\/iframe>/);
  assert.ok(!/allow-(?:forms|popups|top-navigation|modals|downloads)/.test(page), 'the page cannot submit, open windows or navigate the preview away');
  assert.match(page, /iframe\{border:0;width:390px;height:100%;/, 'the page lays out at the requested width');
  const lower = preview.localPageHostPage({ fileUrl: 'file:///srv/work/index.html', width: 1440, offsetY: 900 });
  assert.match(lower, /top:-900px;height:calc\(100% \+ 900px\)/, 'a lower part of the page is shown by shifting a taller frame');
  const hostile = preview.localPageHostPage({ fileUrl: 'file:///srv/"><script>alert(1)</script>', width: 1440, offsetY: 0 });
  assert.ok(!hostile.includes('<script>alert(1)'), 'a file name cannot close the frame tag');
});

test('a local page preview returns the image, clamps its size, and leaves nothing behind', async () => {
  const pageDir = mkdtempSync(path.join(HOME, 'page-'));
  const file = path.join(pageDir, 'index.html');
  writeFileSync(file, '<!doctype html><html><body><h1>Brief</h1></body></html>', 'utf8');
  const temporary = () => readdirSync(os.tmpdir()).filter((name) => name.startsWith('clem-page-preview-'));
  const before = new Set(temporary());
  const result = await preview.renderLocalPagePreview({ file, width: 5000, height: 100, offsetY: 30_000 }, { browser: lingering, timeoutMs: 10_000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.ok(result.png.equals(PNG), 'the screenshot bytes come back');
  assert.deepEqual([result.width, result.height, result.offsetY], [2000, 480, 20_000]);
  assert.deepEqual(temporary().filter((name) => !before.has(name)), [], 'its temporary files were removed');
  assert.equal(existsSync(file), true, 'the page itself is untouched');
  const none = await preview.renderLocalPagePreview({ file }, { browser: null });
  assert.equal(none.ok, false);
  if (!none.ok) assert.match(none.reason, /no Chromium-family browser/);
  const slow = await preview.renderLocalPagePreview({ file }, { browser: silent, timeoutMs: 1_200 });
  assert.equal(slow.ok, false);
  if (!slow.ok) assert.match(slow.reason, /did not produce a preview in time/);
});

test('a real installed browser renders a local page with what lies beside it', { skip: process.env.CLEMMY_TEST_REAL_BROWSER !== '1' }, async () => {
  const browser = preview.findPreviewBrowser();
  assert.ok(browser, 'CLEMMY_TEST_REAL_BROWSER=1 needs an installed Chromium-family browser');
  const pageDir = mkdtempSync(path.join(HOME, 'real-page-'));
  writeFileSync(path.join(pageDir, 'page.css'), 'html,body{margin:0;height:100%;background:#ff0000}@media (max-width:390px){html,body{background:#00ff00}}', 'utf8');
  writeFileSync(path.join(pageDir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="page.css"></head><body><script>try{localStorage.setItem("k","v")}catch(e){document.documentElement.style.background="#0000ff"}</script></body></html>', 'utf8');
  const result = await preview.renderLocalPagePreview({ file: path.join(pageDir, 'index.html'), width: 390, height: 600 }, { browser });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.png.readUInt32BE(16), 390, 'the image is phone width');
  const pixel = await firstPixel(result.png);
  assert.deepEqual(pixel, [0, 255, 0], `the page loaded its own stylesheet and saw a 390-pixel viewport (first pixel ${pixel.join(',')})`);
});

test('a real installed browser renders a page finer without laying it out wider', { skip: process.env.CLEMMY_TEST_REAL_BROWSER !== '1' }, async () => {
  const browser = preview.findPreviewBrowser();
  assert.ok(browser, 'CLEMMY_TEST_REAL_BROWSER=1 needs an installed Chromium-family browser');
  const pageDir = mkdtempSync(path.join(HOME, 'fine-page-'));
  writeFileSync(path.join(pageDir, 'index.html'), '<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#ff0000}@media (max-width:390px){html,body{background:#00ff00}}</style></head><body></body></html>', 'utf8');
  const result = await preview.renderLocalPagePreview({ file: path.join(pageDir, 'index.html'), width: 390, height: 600, scale: 2 }, { browser });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual([result.width, result.height], [390, 600], 'the size answered is the layout size');
  assert.deepEqual([result.png.readUInt32BE(16), result.png.readUInt32BE(20)], [780, 1200], 'the picture has twice the pixels each way');
  assert.deepEqual(await firstPixel(result.png), [0, 255, 0], 'the page still saw a 390-pixel viewport');
});

test('a real installed browser renders a Workspace document', { skip: process.env.CLEMMY_TEST_REAL_BROWSER !== '1' }, async () => {
  const browser = preview.findPreviewBrowser();
  assert.ok(browser, 'CLEMMY_TEST_REAL_BROWSER=1 needs an installed Chromium-family browser');
  const result = await preview.renderWorkspacePreview({
    slug: 'real-render',
    servedViewHtml: '<!doctype html><html><body style="background:#123"><script>document.body.innerHTML="<h1 style=color:#fff>"+(window.__SPACE_DATA__?"planted":"missing")+"</h1>"</script></body></html>',
    dataset: {},
    width: 800,
    height: 600,
  }, { browser });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.ok(result.png.subarray(0, 8).equals(PNG.subarray(0, 8)), 'a PNG came back');
});

test('a real installed browser reports a Workspace page that throws', { skip: process.env.CLEMMY_TEST_REAL_BROWSER !== '1' }, async () => {
  const browser = preview.findPreviewBrowser();
  assert.ok(browser, 'CLEMMY_TEST_REAL_BROWSER=1 needs an installed Chromium-family browser');
  const result = await preview.renderWorkspacePreview({
    slug: 'real-throw',
    servedViewHtml: '<!doctype html><html><body><h1>Board</h1><script>document.querySelector("h1").textContent = rows.length;</script></body></html>',
    dataset: {},
    width: 800,
    height: 600,
  }, { browser });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.match(result.problems.join('\n'), /Uncaught ReferenceError: rows is not defined/);
});

/** RGB of the first pixel of a PNG (the first pixel of any scanline filter is
 *  stored raw, because its left and upper neighbours are zero). */
async function firstPixel(png: Buffer): Promise<[number, number, number]> {
  const { inflateSync } = await import('node:zlib');
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  return [raw[1]!, raw[2]!, raw[3]!];
}

test('a real installed browser lays a phone preview out at the phone width', { skip: process.env.CLEMMY_TEST_REAL_BROWSER !== '1' }, async () => {
  const browser = preview.findPreviewBrowser();
  assert.ok(browser, 'CLEMMY_TEST_REAL_BROWSER=1 needs an installed Chromium-family browser');
  const result = await preview.renderWorkspacePreview({
    slug: 'phone-render',
    servedViewHtml: '<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#ff0000}@media (max-width:390px){html,body{background:#00ff00}}</style></head><body></body></html>',
    dataset: {},
    width: 390,
    height: 600,
  }, { browser });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.png.readUInt32BE(16), 390, 'the image is phone width');
  const pixel = await firstPixel(result.png);
  assert.deepEqual(pixel, [0, 255, 0], `the view saw a 390-pixel viewport (first pixel ${pixel.join(',')})`);
});

test('a real installed browser shows a lower part of a long page at the requested offset', { skip: process.env.CLEMMY_TEST_REAL_BROWSER !== '1' }, async () => {
  const browser = preview.findPreviewBrowser();
  assert.ok(browser, 'CLEMMY_TEST_REAL_BROWSER=1 needs an installed Chromium-family browser');
  const result = await preview.renderWorkspacePreview({
    slug: 'long-render',
    servedViewHtml: '<!doctype html><html><head><style>html,body{margin:0}.top{height:1000px;background:#ff0000}.bottom{height:1000px;background:#00ff00}</style></head><body><div class="top"></div><div class="bottom"></div></body></html>',
    dataset: {},
    width: 600,
    height: 600,
    offsetY: 1000,
  }, { browser });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const pixel = await firstPixel(result.png);
  assert.deepEqual(pixel, [0, 255, 0], `the screenshot starts at the offset (first pixel ${pixel.join(',')})`);
});
