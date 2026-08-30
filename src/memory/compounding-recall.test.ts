/** Run: node scripts/run-tests-isolated.mjs src/memory/compounding-recall.test.ts
 *
 * COMPOUNDING wave pins (2026-08-19): retrieval that lands.
 *  - BM25/FTS: relevance beats recency — the measured live failure was
 *    relevant facts evicted by common-token LIKE matches before scoring.
 *  - Thread anchors: a follow-up phrase retrieves against the session's own
 *    last reply tokens (deterministic, no model call).
 *  - Answerability is CONSUMED: the primer's use-rule changes when recall is
 *    partial/insufficient and names memory_recall_all as one call away.
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

test('answerability is consumed: a thin recall ships the PARTIAL/INSUFFICIENT rule naming memory_recall_all', async () => {
  rememberFact({ kind: 'project', content: 'Umbrella retro cadence is biweekly on Thursdays.' });
  const primer = await buildUnifiedTurnPrimer({
    query: 'umbrella retro cadence',
    surface: 'turn_memory_primer',
    limit: 4,
    maxChars: 1_800,
  });
  assert.equal(primer.status, 'ok');
  if (primer.answerability === 'supported') {
    assert.match(primer.text ?? '', /Answer local-memory questions from a complete evidence-backed FACT/);
  } else {
    assert.match(primer.text ?? '', /memory_recall_all/, 'a non-supported primer names the one-call escalation');
  }
});
