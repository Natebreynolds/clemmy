/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/page-read-doors.test.ts
 *
 * A page that could not be read one way comes back saying so with the other
 * doors on this machine; a page that reads fine carries nothing extra.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { assessUnreadablePage, browserUnavailableDoors, visibleTextOfHtml } = await import('./page-read-doors.js');

const shell = `<!DOCTYPE html><html lang="en"><head><script nonce="x">${'var a = 1;'.repeat(2_000)}</script>`
  + '<style>body{margin:0}</style></head><body><div id="app"></div><noscript>Enable JavaScript</noscript>'
  + '<script>window.__INIT__ = {"agenda":"loaded later"};</script></body></html>';

test('a script shell with no visible text names the browser and a connected reader as the next doors', () => {
  const page = assessUnreadablePage(
    { ok: true, status: 200, contentType: 'text/html;charset=UTF-8', bytes: shell.length, body: shell },
    { browser: 'older' },
  );
  assert.ok(page);
  assert.equal(page!.reason, 'script_rendered');
  assert.ok(page!.visibleTextChars < 50, String(page!.visibleTextChars));
  assert.match(page!.next, /builds its text with scripts/);
  assert.match(page!.next, /browser_open, browser_navigate to this URL, then browser_read/);
  assert.match(page!.next, /tool_search "read a web page as text"/);
  assert.match(page!.next, /Do not treat this page as empty/);
  assert.doesNotMatch(page!.next, /In a batch/);
});

test('a site that refuses the plain fetch is blocked_by_site whatever the body says', () => {
  const page = assessUnreadablePage(
    { ok: false, status: 403, contentType: 'text/html', bytes: 1_200, body: '<html><body><h1>Just a moment...</h1><p>Checking your browser</p></body></html>' },
    { browser: 'none', inBatch: true },
  );
  assert.ok(page);
  assert.equal(page!.reason, 'blocked_by_site');
  assert.match(page!.textPreview, /^Just a moment\.\.\. Checking your browser$/);
  assert.doesNotMatch(page!.next, /browser_open/, 'no browser is offered on this machine');
  assert.match(page!.next, /tool_search "read a web page as text"/);
  assert.match(page!.next, /record that item as skipped with this reason and continue with the others/);
});

test('a page that reads fine carries nothing extra, and visible text drops scripts, styles and tags', () => {
  const html = '<html><head><title>Shelf</title><style>.a{}</style></head><body><h1>Books &amp; prices</h1>'
    + `<p>${'A fine paragraph of real text. '.repeat(40)}</p><script>track()</script></body></html>`;
  assert.equal(assessUnreadablePage(
    { ok: true, status: 200, contentType: 'text/html', bytes: 20_000, body: html },
    { browser: 'older' },
  ), null);
  assert.equal(visibleTextOfHtml('<p>Books &amp; prices</p><script>x</script>'), 'Books & prices');
  assert.equal(assessUnreadablePage(
    { ok: true, status: 200, contentType: 'application/json', bytes: 20, body: '{"ok":true}' },
    { browser: 'older' },
  ), null, 'JSON is not a page');
  assert.equal(assessUnreadablePage(
    { ok: true, status: 200, contentType: 'text/html', bytes: 300, body: '<html><body>tiny</body></html>' },
    { browser: 'older' },
  ), null, 'a small page with little text is just a small page');
});

test('a refused browser debugging connection is explained and the other doors are named', () => {
  const next = browserUnavailableDoors('[WinError 1225] The remote computer refused the network connection', { localChrome: true });
  assert.match(next, /not accepting a debugging connection/);
  assert.match(next, /remote debugging enabled/);
  assert.match(next, /http_read/);
  assert.match(next, /tool_search "read a web page as text"/);
  assert.match(next, /ask for the page text only as the last resort/);
  const other = browserUnavailableDoors('Page URL exceeds the exact identity limit', { localChrome: true });
  assert.match(other, /^The browser on this machine did not answer/);
});

test('the computer\'s browser is the next door when it is on, and turning it on is the owner\'s one tap when it is not', () => {
  const blocked = { ok: false, status: 403, contentType: 'text/html', bytes: 900, body: '<html><body>Access denied</body></html>' };
  const on = assessUnreadablePage(blocked, { browser: 'computer' })!;
  assert.match(on.next, /your computer's browser .*browser_prepare, browser_navigate/);
  assert.doesNotMatch(on.next, /browser_open|turn on your computer/);
  const off = assessUnreadablePage(blocked, { browser: 'computer_off' })!;
  assert.doesNotMatch(off.next, /browser_open|browser_prepare/, 'no browser tool is named while none is on');
  assert.match(off.next, /ask the owner in your own words whether to turn on your computer \(one tap at Connect → Your computer\)/);
  assert.match(off.next, /tool_search "read a web page as text"/, 'the other doors come first');
});

