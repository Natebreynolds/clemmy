/**
 * Run: node scripts/run-tests-isolated.mjs apps/console-web/src/screens/ProjectPageViewer.test.ts
 *
 * A page made in a project is a document Clem wrote and nobody has read. The
 * frame that shows it is given the shared sandbox and nothing wider, and the
 * viewer is a deferred route beside the project's own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROJECT_PAGE_FRAME_SANDBOX } from '@clem/chat-engine';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const viewer = read('./ProjectPageViewer.tsx');

test('the shared sandbox lets a page run its scripts, and nothing else', () => {
  assert.equal(PROJECT_PAGE_FRAME_SANDBOX, 'allow-scripts');
});

test('the frame takes its sandbox from the shared words, and the viewer names no wider one', () => {
  const frames = [...viewer.matchAll(/<iframe\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(frames.length, 1, 'the viewer draws one frame');
  const frame = frames[0]!;
  assert.match(frame, /\bsandbox=\{PROJECT_PAGE_FRAME_SANDBOX\}/);
  assert.equal([...frame.matchAll(/\bsandbox=/g)].length, 1, 'the sandbox is said once');
  assert.doesNotMatch(frame, /\{\.\.\./, 'nothing is spread onto the frame');
  assert.match(frame, /\breferrerPolicy="no-referrer"/);
  assert.match(frame, /\bloading="eager"/);
  assert.match(frame, /\btitle=\{`Page: \$\{title\}`\}/);
  assert.match(frame, /\bsrc=\{pageDocumentUrl\(/);
  assert.doesNotMatch(frame, /srcDoc|\ballow=/, 'the document comes from its own address, with no permissions of the app');

  for (const token of [
    'allow-same-origin', 'allow-forms', 'allow-popups', 'allow-top-navigation', 'allow-modals', 'allow-downloads',
    'allow-pointer-lock', 'allow-presentation', 'allow-orientation-lock', 'allow-storage-access',
  ]) {
    assert.ok(!viewer.includes(token), `the viewer names ${token}`);
  }
  assert.doesNotMatch(viewer, /withToken|getAuthToken/, 'the frame\'s address never carries the session');
});

test('a page that is not in the project is said in words before any frame is drawn', () => {
  const missing = viewer.indexOf('if (!page) return <PageGone');
  const framed = viewer.indexOf('return <PageFrame');
  assert.ok(missing > 0 && framed > missing, 'the page is looked for before it is framed');
  assert.match(viewer, /projectPageRefusal\('PAGE_NOT_FOUND'\)/);
  assert.match(viewer, /check\.isSuccess \? \(/, 'the frame waits for the document to answer');
});

test('the viewer is a deferred route beside the project page', () => {
  const app = read('../app.tsx');
  assert.match(app, /<Route path="\/projects\/:id\/pages\/:pageId" element=\{deferred\(<ProjectPageViewer \/>\)\} \/>/);
  assert.ok(
    app.indexOf('path="/projects/:id/pages/:pageId"') > app.indexOf('path="/projects/:id"'),
    'it is registered with the project routes',
  );
});
