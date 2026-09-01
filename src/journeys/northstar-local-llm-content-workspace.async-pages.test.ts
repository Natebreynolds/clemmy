/**
 * Run: node scripts/run-tests-isolated.mjs src/journeys/northstar-local-llm-content-workspace.async-pages.test.ts
 *
 * The shared async S→R→W pages verify the same three records in every PID.
 *
 * Cold recovery derives its evidence from the same durable rows and the same
 * verifier as the in-process path; the only way the two can disagree is if
 * the provider bytes differ between processes. They did (2026-08-31): the
 * cold fixture's private copy of the third page put `<time itemprop=
 * "datePublished">` outside `<article>`, so the cold PID verified two records
 * and the resumed run ended in `insufficient_evidence`. Both processes now
 * import one module; this pins its bytes against the verifier contract and
 * keeps the exact drifted page as the negative.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-async-pages-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const {
  ASYNC_SELECTED_URLS,
  ASYNC_VERIFIED_PUBLICATION_DAYS,
  RAW_HTML_ONLY_HOSTILE_TOKEN,
  asyncCompletedPages,
} = await import('./northstar-local-llm-content-workspace.async-pages.fixture.js');
const { verifyRecentArticleDateEvidence } = await import('../runtime/harness/recent-article-date-evidence.js');

test.after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const CANDIDATES = ASYNC_SELECTED_URLS.map((url, index) => ({
  recordId: `candidate-${index + 1}`,
  title: `Local model article candidate number ${index + 1}`,
  url,
  finding: `Candidate ${index + 1} describes practical local inference tradeoffs for technical builders across latency, memory, privacy, and recovery behavior.`,
  publisher: `Fixture publisher ${index + 1}`,
}));

function completed(rows: ReturnType<typeof asyncCompletedPages>) {
  return { status: 'completed', total: rows.length, completed: rows.length, data: rows };
}

test('every PID verifies exactly the three recent articles from the shared pages', () => {
  const verified = verifyRecentArticleDateEvidence({
    acceptedAt: '2026-08-31T12:00:00.000Z',
    maxAgeDays: 30,
    minDistinctRecords: 3,
    candidates: CANDIDATES,
    completedBatchResult: completed(asyncCompletedPages()),
  });
  assert.equal(verified.status, 'verified', verified.status === 'verified' ? '' : verified.reason);
  if (verified.status !== 'verified') return;
  assert.deepEqual(verified.evidence.records.map((row) => row.url), ASYNC_SELECTED_URLS.slice(0, 3));
  assert.deepEqual(verified.evidence.records.map((row) => row.publishedAt), [
    ASYNC_VERIFIED_PUBLICATION_DAYS[0],
    ASYNC_VERIFIED_PUBLICATION_DAYS[1],
    ASYNC_VERIFIED_PUBLICATION_DAYS[2],
  ]);
  assert.deepEqual(verified.evidence.records.map((row) => row.dateEvidence), [
    'json_ld_article',
    'article_published_time',
    'article_time',
  ], 'the three pages exercise all three page-owned date carriers');
  assert.doesNotMatch(JSON.stringify(verified.evidence), new RegExp(RAW_HTML_ONLY_HOSTILE_TOKEN),
    'raw page bytes never enter the verified evidence');
});

test('the drifted cold copy (time element outside <article>) is exactly the 2-of-3 failure', () => {
  const rows = asyncCompletedPages();
  rows[2] = {
    rawHtml: `<html><body><time itemprop="datePublished" datetime="${ASYNC_VERIFIED_PUBLICATION_DAYS[2]}">${ASYNC_VERIFIED_PUBLICATION_DAYS[2]}</time>${RAW_HTML_ONLY_HOSTILE_TOKEN}</body></html>`,
    metadata: { sourceURL: ASYNC_SELECTED_URLS[2]!, statusCode: 200 },
  };
  const verified = verifyRecentArticleDateEvidence({
    acceptedAt: '2026-08-31T12:00:00.000Z',
    maxAgeDays: 30,
    minDistinctRecords: 3,
    candidates: CANDIDATES,
    completedBatchResult: completed(rows),
  });
  assert.deepEqual(verified, {
    status: 'insufficient',
    reason: 'only 2 candidate article(s) have one unambiguous page-owned recent publication date',
    verifiedCount: 2,
  });
});

test('the shared pages are still inside the 30-day window as of today (the journey accepts at wall-clock time)', () => {
  const verified = verifyRecentArticleDateEvidence({
    acceptedAt: new Date().toISOString(),
    maxAgeDays: 30,
    minDistinctRecords: 3,
    candidates: CANDIDATES,
    completedBatchResult: completed(asyncCompletedPages()),
  });
  assert.equal(verified.status, 'verified',
    `the async journey pages carry absolute publication days (${Object.values(ASYNC_VERIFIED_PUBLICATION_DAYS).join(', ')}); `
    + 'once they age past 30 days the in-process and cold journeys both fail with insufficient_evidence — '
    + 'move the days forward in northstar-local-llm-content-workspace.async-pages.fixture.ts (one place).');
});
