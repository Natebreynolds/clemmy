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
const { workflowEndingKeepsFacts, workflowEndingInClemsWords, _setWorkflowRunOriginReaderForTests } = await import('./workflow-ending-voice.js');
const { installTurnSemanticModelPort } = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');

const report = 'Saved 20 books to /Users/user/clem-fixtures/out/page7-books.csv from https://books.toscrape.com/catalogue/page-7.html.';

test('a faithful retelling keeps the facts, home-relative paths included', () => {
  assert.equal(workflowEndingKeepsFacts('All 20 books from page 7 are in /Users/user/clem-fixtures/out/page7-books.csv.', report, 'done'), true);
  const home = `${os.homedir()}/clem-fixtures/out/x.csv`;
  assert.equal(workflowEndingKeepsFacts('It is in ~/clem-fixtures/out/x.csv.', `Wrote ${home}.`, 'done'), true);
});

test('current home paths stay equivalent and invented files stay refused outside conventional home roots', (t) => {
  for (const home of ['/work/clem-fixture', '/sandbox/clem[fixture].home']) {
    t.mock.method(os, 'homedir', () => home);
    const named = `${home}/out/known.csv`;
    assert.equal(workflowEndingKeepsFacts('Saved ~/out/known.csv.', `Wrote ${named}.`, 'done'), true);
    assert.equal(workflowEndingKeepsFacts(`Saved ${named}.`, 'Wrote ~/out/known.csv.', 'done'), true);
    assert.equal(workflowEndingKeepsFacts(`Saved ${home}/out/invented.csv.`, `Wrote ${named}.`, 'done'), false);
    assert.equal(workflowEndingKeepsFacts('Saved ~/out/invented.csv.', `Wrote ${named}.`, 'done'), false);
    t.mock.restoreAll();
  }
});

test('a link or file the report never named, or a blocked run told as done, keeps the report', () => {
  assert.equal(workflowEndingKeepsFacts('Saved to /Users/user/Desktop/books.csv.', report, 'done'), false, 'an invented location');
  assert.equal(workflowEndingKeepsFacts('See https://example.com/run for details.', report, 'done'), false, 'an invented link');
  assert.equal(workflowEndingKeepsFacts('All done — the page is saved.', 'One step stopped: the page did not load.', 'blocked'), false);
  assert.equal(workflowEndingKeepsFacts('   ', report, 'done'), false);
});

test('with no brain to ask, the runner keeps its own report', async () => {
  assert.equal(await workflowEndingInClemsWords({ runId: 'run-x', workflow: 'w', outcome: 'blocked', report }), null);
});

test('a run the owner started together with others is voiced as one of the set, never as the whole request', async () => {
  // Live 2026-10-21: the first of two runs to finish, voiced against a request
  // that named both, said it had nothing on the second; the join carried that
  // denial into the owner's reply and the review.
  const calls: Array<Record<string, unknown>> = [];
  _setWorkflowRunOriginReaderForTests(() => [{ version: 2, runId: 'run-a', observerId: 'obs', originSessionId: 'sess-x',
    sourceUserSeq: 7, replyTarget: { kind: 'chat' }, replyTargetDigest: 'd', sourceGroupId: 'workflow-origin-group-v1:g', sourceGroupDigest: 'gd',
    recordedAt: '2026-10-21T00:00:00.000Z' } as never]);
  installTurnSemanticModelPort({
    async interpret() { throw new Error('not used'); },
    async voiceWorkflowRunEnding(call) {
      calls.push(call as unknown as Record<string, unknown>);
      return { message: `All 20 books from page 7 are in /Users/user/clem-fixtures/out/page7-books.csv.`, evidenceDigest: call.evidenceDigest, modelIdentity: 'fixture' };
    },
  } as never);
  try {
    const told = await workflowEndingInClemsWords({ runId: 'run-a', workflow: 'w', outcome: 'done', report, setSize: 2 });
    assert.match(told ?? '', /page7-books\.csv/);
    assert.deepEqual(calls[0]!.partOfSet, { count: 2 }, JSON.stringify(calls[0]));
    await workflowEndingInClemsWords({ runId: 'run-a', workflow: 'w', outcome: 'done', report, setSize: 1 });
    assert.equal(calls[1]!.partOfSet, undefined, 'a run started alone speaks for the request');
  } finally {
    installTurnSemanticModelPort(null);
    _setWorkflowRunOriginReaderForTests(null);
  }
});
