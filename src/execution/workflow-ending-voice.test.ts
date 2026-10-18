/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-ending-voice.test.ts
 *
 * Clem's words for a chat-started run's ending replace the runner's report
 * only when they keep its verdict and name no link or file it never named.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
const { workflowEndingKeepsFacts, workflowEndingInClemsWords } = await import('./workflow-ending-voice.js');

const report = 'Saved 20 books to /Users/owner/clem-fixtures/out/page7-books.csv from https://books.toscrape.com/catalogue/page-7.html.';

test('a faithful retelling keeps the facts, home-relative paths included', () => {
  assert.equal(workflowEndingKeepsFacts('All 20 books from page 7 are in /Users/owner/clem-fixtures/out/page7-books.csv.', report, 'done'), true);
  const home = `${os.homedir()}/clem-fixtures/out/x.csv`;
  assert.equal(workflowEndingKeepsFacts('It is in ~/clem-fixtures/out/x.csv.', `Wrote ${home}.`, 'done'), true);
});

test('a link or file the report never named, or a blocked run told as done, keeps the report', () => {
  assert.equal(workflowEndingKeepsFacts('Saved to /Users/owner/Desktop/books.csv.', report, 'done'), false, 'an invented location');
  assert.equal(workflowEndingKeepsFacts('See https://example.com/run for details.', report, 'done'), false, 'an invented link');
  assert.equal(workflowEndingKeepsFacts('All done — the page is saved.', 'One step stopped: the page did not load.', 'blocked'), false);
  assert.equal(workflowEndingKeepsFacts('   ', report, 'done'), false);
});

test('with no brain to ask, the runner keeps its own report', async () => {
  assert.equal(await workflowEndingInClemsWords({ runId: 'run-x', workflow: 'w', outcome: 'blocked', report }), null);
});
