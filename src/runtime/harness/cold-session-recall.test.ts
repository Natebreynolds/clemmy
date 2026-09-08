/**
 * COLD session recall must find a relevant conversation behind a backlog.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/cold-session-recall.test.ts
 *
 * Measured cold lookup (L09): the search drained the pending queue oldest-first,
 * four sessions per no-cursor call, with no regard for the query. Five searches
 * advanced an old global index and the run stopped before the target was ever
 * indexed; the natural follow-up found it only after three more advances.
 *
 * The read now completes the indexing IT needs, relevant sessions first. These
 * tests build a real backlog of distractors and never warm the index by hand —
 * operator backfill cannot qualify the cold case.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-cold-recall-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'cold-recall\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { searchSessionHistory, historyRelevanceTerms } = await import('./session-history-search.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

const PRINCIPAL = 'owner-1';

/**
 * One complete prior conversation through the REAL producers.
 *
 * The assistant side must be a committed typed terminal: an `awaiting_user_input`
 * row carrying loose text is not what `pullRecentTurnsForSessions` projects, so
 * a fixture built that way indexes the question and silently drops the ANSWER —
 * which is usually the thing recall is actually looking for.
 */
function conversation(title: string, ask: string, answer: string, userId = PRINCIPAL): string {
  const row = eventlog.createSession({ kind: 'chat', channel: 'desktop', title, userId });
  const attempt = eventlog.beginRunAttempt(row.id, { runId: `run-${title}` });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1, role: 'user', data: { text: ask },
  });
  const identity = {
    sessionId: row.id,
    turn: source.turn,
    attemptId: attempt.attemptId,
    runId: attempt.runId ?? undefined,
    sourceUserSeq: source.seq,
  };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: answer },
  });
  return row.id;
}

test('relevance terms come from ordinary words', () => {
  assert.deepEqual(historyRelevanceTerms('the Peregrine pricing model'), ['the', 'peregrine', 'pricing', 'model']);
  assert.deepEqual(historyRelevanceTerms(''), []);
  assert.deepEqual(historyRelevanceTerms(undefined), []);
});

test('COLD: a relevant ANSWER is found behind a backlog, past the scan frontier', () => {
  // Each conversation contributes several public events, so 90 distractors put
  // the target far beyond the 128-public-event frontier one scan pass covers.
  // Before this it was not merely queued behind them — it was never QUEUED AT
  // ALL, and no amount of relevance ordering could have reached it.
  for (let i = 0; i < 90; i += 1) {
    conversation(`distractor ${i}`, `Please tidy the archive folder number ${i}.`, `Tidied folder ${i}.`);
  }
  conversation(
    'the one that matters',
    'What did we decide about that renewal?',
    'We agreed to hold the Peregrine renewal discount at twelve percent.',
  );
  for (let i = 90; i < 110; i += 1) {
    conversation(`distractor ${i}`, `Another unrelated errand ${i}.`, `Done ${i}.`);
  }

  // A COLD search: no cursor, nothing warmed, first ever lookup.
  const asker = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'asking', userId: PRINCIPAL });
  const src = eventlog.appendEvent({
    sessionId: asker.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'remind me what we said about the Peregrine renewal' },
  });

  const result = searchSessionHistory({
    sessionId: asker.id,
    sourceUserSeq: src.seq,
    query: 'Peregrine renewal discount',
  });

  const texts = result.hits.map((hit) => hit.excerpt ?? '').join(' | ');
  assert.match(texts, /twelve percent/,
    "the ANSWER is found on the FIRST cold search — the term appears only in the assistant turn");
  // 111 conversations, each contributing a user source plus a committed
  // terminal, so the public-event count is far past the 128 one pass covers.
  const publicEvents = 111 * 2;
  assert.ok(result.coverage.observed_through_seq > publicEvents,
    `the fixture reaches past a single scan pass (observed ${result.coverage.observed_through_seq})`);
  assert.ok(publicEvents > 128, 'and past the frontier a single pass can scan');
});

test('coverage stays honest when the backlog is not finished', () => {
  // Prioritising must not let the search claim it covered everything.
  const asker = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'asking2', userId: PRINCIPAL });
  const src = eventlog.appendEvent({
    sessionId: asker.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'anything' },
  });
  const result = searchSessionHistory({ sessionId: asker.id, sourceUserSeq: src.seq, query: 'Peregrine' });
  assert.equal(typeof result.coverage.complete, 'boolean');
  assert.ok(result.coverage.indexed_through_seq <= result.coverage.observed_through_seq,
    'indexed coverage never overstates what was observed');
});

test('ACCESS ISOLATION: prioritising never reaches another principal', () => {
  conversation(
    'someone else',
    'What is the Peregrine renewal discount on the other account?',
    'The Peregrine renewal discount there is nineteen percent.',
    'owner-2',
  );

  const asker = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'asking3', userId: PRINCIPAL });
  const src = eventlog.appendEvent({
    sessionId: asker.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'peregrine again' },
  });
  const result = searchSessionHistory({
    sessionId: asker.id, sourceUserSeq: src.seq, query: 'Peregrine renewal discount',
  });
  const texts = result.hits.map((hit) => hit.excerpt ?? '').join(' | ');
  assert.doesNotMatch(texts, /nineteen percent/, "another principal's conversation is never returned");
});
