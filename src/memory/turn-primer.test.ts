/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-turn-primer npx tsx --test src/memory/turn-primer.test.ts
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-turn-primer';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const { getFact, rememberFact } = await import('./facts.js');
const { readFactRecallTrace } = await import('./recall-trace.js');
const {
  _setUnifiedTurnPrimerRecallForTest,
  buildUnifiedTurnPrimer,
} = await import('./turn-primer.js');

beforeEach(() => {
  resetMemoryDb();
  _setUnifiedTurnPrimerRecallForTest(null);
  delete process.env.CLEMMY_UNIFIED_TURN_PRIMER;
});

after(() => {
  _setUnifiedTurnPrimerRecallForTest(null);
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('primer persists and exposes only refs that fit the actual prompt budget', async () => {
  const fact = rememberFact({ kind: 'project', content: 'The Juniper review is Thursday.' });
  const clippedPath = `/vault/${'very-long-meeting-path-'.repeat(20)}.md`;
  _setUnifiedTurnPrimerRecallForTest(async () => ({
    objective: 'when is Juniper?',
    answerability: 'supported',
    diagnostics: { candidates: 17, stores: ['fact', 'note'], elapsedMs: 9 },
    perStore: { fact: 1, vault: 1 },
    hits: [
      {
        type: 'fact', ref: String(fact.id), title: 'project fact', snippet: fact.content,
        score: 0.92, confidence: 0.9, whyRecalled: ['lexical relevance 1.00'], evidence: [],
      },
      {
        type: 'vault', ref: clippedPath, title: 'Oversized meeting', snippet: 'x'.repeat(500),
        score: 0.8, confidence: 0.8, whyRecalled: ['recorded meeting source'],
        evidence: [{ episodeId: 'note:oversized', excerpt: 'x'.repeat(500), sourceUri: clippedPath }],
      },
    ],
  }));

  const primer = await buildUnifiedTurnPrimer({
    query: 'when is Juniper?',
    surface: 'automatic_primer',
    maxChars: 700,
    timeoutMs: 100,
  });

  assert.equal(primer.status, 'ok');
  assert.equal(primer.hitCount, 1);
  assert.equal(primer.retrievedHitCount, 2);
  assert.equal(primer.omittedHitCount, 1);
  assert.match(primer.text ?? '', new RegExp(`\\[ref fact:${fact.id}\\]`));
  assert.doesNotMatch(primer.text ?? '', /Oversized meeting/);
  assert.ok((primer.text?.length ?? 0) <= 700, 'the complete primer respects its configured budget');
  assert.ok(primer.recallId, 'a visible primer has an attributable recall id');

  const row = openMemoryDb().prepare(`
    SELECT surface, candidate_refs_json FROM memory_recall_runs WHERE id = ?
  `).get(primer.recallId) as { surface: string; candidate_refs_json: string };
  assert.equal(row.surface, 'automatic_primer');
  assert.deepEqual(JSON.parse(row.candidate_refs_json), [
    // The snippet carries what the model actually SAW so post-turn auto-credit
    // can match demonstrable use; identity remains type:id.
    { type: 'fact', id: String(fact.id), snippet: `project fact: ${fact.content}` },
  ]);
  assert.equal(getFact(fact.id)?.impressionCount, 1);
  assert.equal(getFact(fact.id)?.utilityCount, 0, 'automatic exposure is never utility');
  const trace = readFactRecallTrace(20).find((entry) => entry.query === 'when is Juniper?');
  assert.equal(trace?.mode, 'automatic_primer');
  assert.equal(trace?.includedCount, 1);
  assert.equal(trace?.omittedCount, 1);
  assert.equal(trace?.candidateCount, 17);
});

test('primer includes actionable source URIs for visible source-backed memory', async () => {
  const sourceUri = '/vault/04-Meetings/2026-07-15-in-person-review.md';
  _setUnifiedTurnPrimerRecallForTest(async () => ({
    objective: 'what was my meeting today about?',
    answerability: 'supported',
    diagnostics: { candidates: 2, stores: ['note'], elapsedMs: 4 },
    perStore: { vault: 1 },
    hits: [{
      type: 'vault', ref: sourceUri, title: 'In-person review',
      snippet: 'Reviewed revenue and legal data integration gaps.', score: 0.98, confidence: 0.95,
      whyRecalled: ['exact temporal match', 'in-person capture match'],
      evidence: [{ episodeId: `note:${sourceUri}`, excerpt: 'Reviewed revenue.', sourceUri }],
    }],
  }));

  const primer = await buildUnifiedTurnPrimer({
    query: 'what was my meeting today about?', surface: 'claude_primer', maxChars: 1_200,
  });
  assert.equal(primer.status, 'ok');
  assert.match(primer.text ?? '', /\[ref note:\/vault\/04-Meetings\/2026-07-15-in-person-review\.md\]/);
  assert.doesNotMatch(primer.text ?? '', /\[source:/, 'the note ref already carries the actionable path');
  assert.doesNotMatch(primer.text ?? '', /\[why:|\[\d+ sources?\]/, 'automatic prompts omit UI/tool diagnostics');
  assert.ok(primer.text?.includes(sourceUri));
});

test('primer keeps one distinct source locator for an episode ref', async () => {
  _setUnifiedTurnPrimerRecallForTest(async () => ({
    objective: 'meeting decision', answerability: 'supported',
    diagnostics: { candidates: 1, stores: ['episode'], elapsedMs: 1 },
    perStore: { episode: 1 },
    hits: [{
      type: 'episode', ref: 'episode-1', title: 'Planning review', snippet: 'Approved the launch sequence.',
      score: 1, confidence: 1, whyRecalled: ['stored graph traversal'],
      evidence: [{ episodeId: 'episode-1', excerpt: 'Approved the launch sequence.', sourceUri: '/vault/04-Meetings/planning.md' }],
    }],
  }));
  const primer = await buildUnifiedTurnPrimer({ query: 'meeting decision', surface: 'automatic_primer', maxChars: 1_200 });
  assert.match(primer.text ?? '', /\[ref episode:episode-1\]/);
  assert.match(primer.text ?? '', /\[source: \/vault\/04-Meetings\/planning\.md\]/);
  assert.doesNotMatch(primer.text ?? '', /why:|source(?:s)?\]/i);
});

test('primer emits each canonical ref once and stays within the working-turn budget', async () => {
  _setUnifiedTurnPrimerRecallForTest(async () => ({
    objective: 'Juniper planning', answerability: 'supported',
    diagnostics: { candidates: 20, stores: ['fact', 'episode'], elapsedMs: 3 },
    perStore: { fact: 2, episode: 1 },
    hits: [
      { type: 'fact', ref: '41', title: 'Juniper plan', snippet: 'Launch review is Thursday.', score: 1, whyRecalled: ['lexical relevance'] },
      { type: 'fact', ref: '41', title: 'Duplicate Juniper plan', snippet: 'The same canonical fact.', score: 0.9, whyRecalled: ['stored graph traversal'] },
      { type: 'episode', ref: 'episode-2', title: 'Juniper meeting', snippet: 'The team reviewed launch timing.', score: 0.8, whyRecalled: ['recorded meeting source'] },
    ],
  }));
  const primer = await buildUnifiedTurnPrimer({
    query: 'Juniper planning', surface: 'automatic_primer', maxChars: 1_800,
  });
  assert.equal(primer.status, 'ok');
  assert.equal(primer.hitCount, 2);
  assert.equal(primer.retrievedHitCount, 2);
  assert.equal(primer.text?.match(/\[ref fact:41\]/g)?.length, 1);
  assert.ok((primer.text?.length ?? 0) <= 1_800);
  assert.doesNotMatch(primer.text ?? '', /\[why:|\[\d+ sources?\]/);
});

test('primer timeout is bounded and creates no attribution run', { timeout: 30_000 }, async () => {
  _setUnifiedTurnPrimerRecallForTest(async () => await new Promise(() => { /* deliberately stalled */ }));
  const primer = await buildUnifiedTurnPrimer({
    query: 'market leader accounts', surface: 'automatic_primer', timeoutMs: 25,
  });
  assert.equal(primer.status, 'timeout');
  // The explicit test timeout is the runaway guard. A wall-clock assertion is
  // not reliable here because the full suite can deschedule this worker while
  // other embedding-heavy files run, delaying both the ranker and its timer.
  const count = openMemoryDb().prepare('SELECT COUNT(*) AS n FROM memory_recall_runs').get() as { n: number };
  assert.equal(count.n, 0);
});

test('authoritative empty recall creates no prompt or attribution run', async () => {
  _setUnifiedTurnPrimerRecallForTest(async () => ({
    objective: 'unknown memory', hits: [], perStore: {}, answerability: 'insufficient',
    diagnostics: { candidates: 0, stores: ['fact', 'note'], elapsedMs: 2 },
  }));
  const primer = await buildUnifiedTurnPrimer({ query: 'unknown memory', surface: 'claude_primer' });
  assert.equal(primer.status, 'empty');
  assert.equal(primer.text, undefined);
  const count = openMemoryDb().prepare('SELECT COUNT(*) AS n FROM memory_recall_runs').get() as { n: number };
  assert.equal(count.n, 0);
  const trace = readFactRecallTrace(20).find((entry) => entry.query === 'unknown memory');
  assert.equal(trace?.includedCount, 0);
  assert.equal(trace?.omittedCount, 0);
  assert.equal(trace?.candidateCount, 0);
});
