/** Run: node scripts/run-tests-isolated.mjs src/memory/compounding-recall.test.ts
 *
 * COMPOUNDING wave pins (2026-08-19): retrieval that lands.
 *  - BM25/FTS: relevance beats recency — the measured live failure was
 *    relevant facts evicted by common-token LIKE matches before scoring.
 *  - Thread anchors: a follow-up phrase retrieves against the session's own
 *    last reply tokens (deterministic, no model call).
 *  - Answerability is CONSUMED: the primer's use-rule changes when recall is
 *    ambient candidates preserve evidence/date/scope without forcing another
 *    broad retrieval when the requested fact is already present.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-compounding-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-compounding\n', 'utf8');

const { rememberFact, searchFactsByText } = await import('./facts.js');
const { buildUnifiedTurnPrimer } = await import('./turn-primer.js');
const { appendEvent, createSession } = await import('../runtime/harness/eventlog.js');
const { enrichRecallQuery, distinctiveAnchorTokens } = await import('../runtime/harness/recall-query-enrichment.js');

test('BM25: the fact covering the distinctive terms outranks newer common-token matches', () => {
  // Twenty newer facts all mention "project"; one older fact holds the answer.
  rememberFact({ kind: 'project', content: 'The staging deploy token for acme lives in the vault under acme-staging-token.' });
  for (let i = 0; i < 20; i += 1) {
    rememberFact({ kind: 'project', content: `Project status note ${i}: routine sync, no blockers, project on track.` });
  }
  const hits = searchFactsByText('staging deploy token acme', 5);
  assert.ok(hits.length > 0, 'search returned hits');
  assert.match(hits[0]!.content, /acme-staging-token/, `the covering fact ranks first, got: ${hits[0]!.content.slice(0, 80)}`);
});

test('thread anchors: a bare follow-up phrase gains the last reply\'s distinctive tokens', () => {
  const session = createSession({ id: 'anchors-thread', kind: 'chat', userId: 'user-1' });
  appendEvent({
    sessionId: session.id, turn: 1, role: 'assistant',
    type: 'conversation_completed',
    data: { reply: 'Found two offices for Baker Lewis Schwisow: Seattle on Mercer Street and Everett on Pacific Avenue.' },
  });
  const enriched = enrichRecallQuery(session.id, 'and the second one?');
  assert.match(enriched, /^and the second one\?/);
  assert.match(enriched, /\[thread context\]/);
  assert.match(enriched, /everett|schwisow|mercer/i, `anchors carry the thread: ${enriched}`);
});

test('anchor tokens exclude stopwords, short tokens, and query-covered tokens', () => {
  const anchors = distinctiveAnchorTokens(
    'The report was sent to operations yesterday with the quarterly numbers attached.',
    'what about the report',
  );
  assert.ok(!anchors.includes('report'), 'query-covered tokens excluded');
  assert.ok(!anchors.includes('the'));
  assert.ok(anchors.includes('operations') || anchors.includes('quarterly'), JSON.stringify(anchors));
});

test('ambient recall preserves usable evidence and asks targeted retrieval only for missing facts', async () => {
  const fact = rememberFact({ kind: 'project', content: 'As of 2026-07-14, Umbrella retro cadence is biweekly on Thursdays.' });
  const primer = await buildUnifiedTurnPrimer({
    query: 'umbrella retro cadence',
    surface: 'automatic_primer',
    limit: 4,
    maxChars: 1_800,
  });
  assert.equal(primer.status, 'ok');
  assert.equal(primer.answerability, 'partial', 'ambient context does not certify an entire business task');
  assert.ok(primer.text?.includes(`[ref fact:${fact.id}]`), 'the usable fact retains its exact reference');
  assert.match(primer.text ?? '', /2026-07-14.*biweekly on Thursdays/);
  assert.match(primer.text ?? '', /Use complete, applicable facts directly/);
  assert.match(primer.text ?? '', /dated record does not establish facts for another date/i);
  assert.match(primer.text ?? '', /targeted memory query when a requested fact is missing or its scope is uncertain/);
  assert.doesNotMatch(primer.text ?? '', /call memory_recall_all \(one call\)/,
    'thin ambient context is not an unconditional command to search all memory again');
});
