/**
 * Run: npx tsx --test src/lib/project-pages.test.ts   (from apps/mobile-web)
 *
 * Pins for looking at a page made in a project on the phone: a part is drawn
 * only when the Mac's answer reads as a picture, the width asked for is a
 * phone's, the next part starts where the shared engine says, and what stands
 * below the last part follows from what has arrived.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_PAGE_MOST_PARTS,
  PROJECT_PAGE_PART_HEIGHT,
  projectPageNextOffset,
  projectPagePlace,
  projectPages,
  projectPageTitle,
} from '@clem/chat-engine';
import {
  PAGE_WIDTH_LEAST,
  PAGE_WIDTH_MOST,
  PAGE_WIDTH_USUAL,
  drawnPageParts,
  pageFailure,
  pageFooter,
  pageImageSource,
  pageNearEnd,
  pagePart,
  pagePartLabel,
  pageWidthFor,
  readPageImage,
  type PagePart,
} from './project-pages';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PICTURE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';

const answer = (over: Record<string, unknown> = {}) => ({
  page: { id: 'page-1', name: 'index.html' },
  image: PICTURE,
  mimeType: 'image/png',
  width: 390,
  height: PROJECT_PAGE_PART_HEIGHT,
  offsetY: 0,
  end: false,
  ...over,
});

const part = (offsetY: number, end = false): PagePart => (
  pagePart(readPageImage(answer({ offsetY, end }))!)
);

test('a part is read as the Mac sent it', () => {
  assert.deepEqual(readPageImage(answer({ offsetY: 1600 })), {
    image: PICTURE, mimeType: 'image/png', width: 390, height: PROJECT_PAGE_PART_HEIGHT, offsetY: 1600, end: false,
  });
  assert.equal(readPageImage(answer({ end: true }))!.end, true);
});

test('an answer that is not a picture of a part is no part', () => {
  for (const hostile of [
    null,
    undefined,
    'image',
    [],
    {},
    answer({ image: '' }),
    answer({ image: 42 }),
    answer({ image: { toString: () => PICTURE } }),
    answer({ image: `${PICTURE}" onerror="alert(1)` }),
    answer({ image: '<svg xmlns="http://www.w3.org/2000/svg"/>' }),
    answer({ mimeType: 'image/svg+xml' }),
    answer({ mimeType: 'text/html' }),
    answer({ mimeType: 'IMAGE/PNG' }),
    answer({ mimeType: 'image/png; charset=utf-8' }),
    answer({ mimeType: undefined }),
    answer({ width: 0 }),
    answer({ width: -390 }),
    answer({ width: '390' }),
    answer({ width: Number.NaN }),
    answer({ height: 0 }),
    answer({ height: Number.POSITIVE_INFINITY }),
    answer({ height: null }),
    answer({ offsetY: -1 }),
    answer({ offsetY: '0' }),
    answer({ offsetY: Number.NaN }),
    answer({ offsetY: undefined }),
  ]) {
    assert.equal(readPageImage(hostile), null, JSON.stringify(hostile) ?? String(hostile));
  }
});

test('only an explicit yes says the page ended', () => {
  for (const said of ['true', 1, 'yes', {}, null, undefined]) {
    assert.equal(readPageImage(answer({ end: said }))!.end, false, String(said));
  }
});

test('the width asked for is a phone width, whatever was measured', () => {
  assert.equal(pageWidthFor(388), 388);
  assert.equal(pageWidthFor(389.6), 390);
  assert.equal(pageWidthFor(320), PAGE_WIDTH_LEAST);
  assert.equal(pageWidthFor(638), PAGE_WIDTH_MOST);
  assert.equal(PAGE_WIDTH_LEAST, 360);
  assert.equal(PAGE_WIDTH_MOST, 430);
  assert.equal(PAGE_WIDTH_USUAL, 390);
  for (const missing of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 0, -20, '390', {}]) {
    assert.equal(pageWidthFor(missing), PAGE_WIDTH_USUAL, String(missing));
  }
});

test('a part is drawn from a data source of its own kind, never the kind the answer named', () => {
  assert.equal(pageImageSource({ image: PICTURE }), `data:image/png;base64,${PICTURE}`);
  const kept = pagePart(readPageImage(answer({ offsetY: 1600 }))!);
  assert.deepEqual(kept, { src: `data:image/png;base64,${PICTURE}`, width: 390, height: PROJECT_PAGE_PART_HEIGHT, offsetY: 1600, end: false });
  assert.equal(part(3200, true).src, '', 'a part that shows nothing keeps no picture');
  assert.equal(pagePartLabel(0, 'Pricing'), 'Part 1 of the page Pricing');
  assert.equal(pagePartLabel(2, 'Pricing'), 'Part 3 of the page Pricing');
});

test('every part is drawn but one that shows nothing, and that one still ends the asking', () => {
  const parts = [part(0), part(1600), part(3200, true)];
  assert.deepEqual(drawnPageParts(parts).map((row) => row.offsetY), [0, 1600]);
  assert.equal(projectPageNextOffset(parts), null);
  assert.equal(projectPageNextOffset(parts.slice(0, 2)), 3200);
  assert.deepEqual(drawnPageParts([]), []);
});

test('what stands below the last part follows from what has arrived', () => {
  const failure = pageFailure(new Error('HTTP 500'));
  assert.equal(pageFooter([], true, null), 'loading');
  assert.equal(pageFooter([part(0)], true, null), 'loading');
  assert.equal(pageFooter([part(0)], false, null), 'more');
  assert.equal(pageFooter([part(0)], false, failure), 'error');
  assert.equal(pageFooter([], false, failure), 'error');
  assert.equal(pageFooter([part(0), part(1600, true)], false, null), 'ended');
  assert.equal(pageFooter([part(0, true)], false, null), 'ended', 'a page with nothing on it has ended');

  const most = Array.from({ length: PROJECT_PAGE_MOST_PARTS }, (_, index) => part(index * PROJECT_PAGE_PART_HEIGHT));
  assert.equal(pageFooter(most, false, null), 'limit');
  assert.equal(pageFooter(most.slice(0, -1), false, null), 'more');
  const endsAtTheLimit = [...most.slice(0, -1), part((PROJECT_PAGE_MOST_PARTS - 1) * PROJECT_PAGE_PART_HEIGHT, true)];
  assert.equal(pageFooter(endsAtTheLimit, false, null), 'ended');
  // A request under way is what is said, whatever went wrong before it.
  assert.equal(pageFooter([part(0)], true, failure), 'loading');
});

test('the next part is asked for within one screen of the end of what is drawn', () => {
  assert.equal(pageNearEnd(2400, 800), false);
  assert.equal(pageNearEnd(801, 800), false);
  assert.equal(pageNearEnd(800, 800), true);
  assert.equal(pageNearEnd(0, 800), true);
  assert.equal(pageNearEnd(-120, 800), true, 'the end of the column is already on screen');
  assert.equal(pageNearEnd(100, 0), false, 'a viewer that was not laid out asks for nothing');
  assert.equal(pageNearEnd(Number.NaN, 800), false);
  assert.equal(pageNearEnd(100, Number.NaN), false);
});

test('a part that did not arrive is said in words, and a page that is gone is not asked for again', () => {
  const refused = (error: string, status = 404) => ({ status, message: error, body: { error } });
  const gone = pageFailure(refused('PAGE_NOT_FOUND'));
  assert.equal(gone.retry, false);
  assert.match(gone.text, /no longer where it was written/);
  assert.equal(pageFailure(refused('page_not_found')).retry, false);

  const large = pageFailure(refused('PAGE_TOO_LARGE', 413));
  assert.match(large.text, /too large/);
  const unrendered = pageFailure(refused('PAGE_NOT_RENDERED', 503));
  assert.equal(unrendered.retry, true);
  assert.match(unrendered.text, /could not render/);

  const offline = pageFailure({ offline: true, status: 0, body: null });
  assert.equal(offline.retry, true);
  assert.match(offline.text, /reach your Mac/);

  const unnamed = [pageFailure(new Error('HTTP 500')), pageFailure(null), pageFailure({ body: { error: 42 } }), pageFailure(refused('SOMETHING_NEW'))];
  for (const failure of unnamed) {
    assert.equal(failure.retry, true);
    assert.equal(failure.text, 'The page could not be shown. Try again.');
  }
  for (const failure of [gone, large, unrendered, offline, ...unnamed]) {
    assert.doesNotMatch(failure.text, /[A-Z]{3,}_[A-Z]/, 'no code reaches the screen');
  }
});

test('an overview from a Mac that predates pages lists none', () => {
  assert.deepEqual(projectPages({}), []);
  assert.deepEqual(projectPages({ pages: 'none' }), []);
  const pages = projectPages({ pages: [
    { id: 'page-1', name: 'index.html', folder: 'pricing', relativePath: 'pricing/index.html', localProject: { name: 'fixture-site', path: '/srv/fixture/code/fixture-site' }, madeAt: '2026-09-29T09:00:00Z', sessionId: 'sess-1' },
    { id: 'page-1', name: 'repeated.html' },
    { name: 'no id' },
    null,
  ] });
  assert.deepEqual(pages.map((page) => page.id), ['page-1']);
  assert.equal(projectPageTitle(pages[0]!), 'pricing');
  assert.equal(projectPagePlace(pages[0]!), 'In fixture-site · pricing/index.html');
});

test('the viewer draws pictures only, asks through the phone’s own call, and one part at a time', () => {
  const viewer = read('../components/ProjectPageViewer.tsx');
  const calls = read('./project-api.ts');
  assert.doesNotMatch(viewer, /<iframe|dangerouslySetInnerHTML|blob:|createObjectURL/, 'nothing a page contains is run or framed');
  assert.doesNotMatch(viewer, /\/m\/api|fetch\(/, 'a part is asked for through the API module, which adds the session proof');
  assert.doesNotMatch(`${viewer}${calls}`, /\/pages\/[^`'"]*\/(?:document|open)/, 'the phone has no document or open route');
  assert.match(calls, /\/pages\/\$\{id\(pageId\)\}\/image\?width=\$\{part\.width\}&height=\$\{part\.height\}&offset=\$\{part\.offset\}/);
  assert.match(viewer, /projectPageNextOffset\(kept\.current\)/, 'the next offset is the shared engine’s');
  assert.match(viewer, /if \(lock\.current \|\| !open\.current\) return;/, 'never two requests at once, and none after closing');
  assert.match(viewer, /if \(lock\.current \|\| halted\.current/, 'nothing is asked for after a failure until the reader asks again');
  assert.match(viewer, /height: PROJECT_PAGE_PART_HEIGHT/);
});

test('the pages are listed after the accounts and resources, and the column never scrolls sideways', () => {
  const screen = read('../screens/Project.tsx');
  const resources = screen.indexOf('aria-labelledby="project-resources"');
  const pages = screen.indexOf('aria-labelledby="project-pages"');
  const chats = screen.indexOf('aria-labelledby="project-chats"');
  assert.ok(resources > 0 && resources < pages && pages < chats);
  assert.match(screen, /pages\.length > 0 \|\| localProjects\.length > 0/);
  const css = read('../styles.css');
  assert.match(css, /\.project-page-scroll \{[^}]*overflow-x: hidden;/);
  assert.match(css, /\.project-page-part \{[^}]*display: block;[^}]*width: 100%;[^}]*height: auto;/);
  assert.match(css, /\.project-page-more \{[^}]*min-height: 48px;/);
});
