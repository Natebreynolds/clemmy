/**
 * Run: npx tsx --test src/memory/recall-auto-credit.test.ts
 */
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-recall-auto-credit';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { resetMemoryDb } = await import('./db.js');
const { getFact, rememberFact } = await import('./facts.js');
const { readRecallRun, recordRecallRun, recordRecallUse } = await import('./recall-usage.js');
const { autoCreditRecallRuns, detectUsedRefs } = await import('./recall-auto-credit.js');

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => { resetMemoryDb(); });

// ---------- detectUsedRefs (pure matcher) ----------

test('cited: an exact ref token in the reply credits, with token boundaries', () => {
  const detected = detectUsedRefs({
    candidates: [
      { type: 'fact', id: '12' },
      { type: 'fact', id: '123' },
    ],
    replyText: 'Per [ref fact:123] the deploy window is Thursday.',
  });
  assert.deepEqual(detected, [{ ref: { type: 'fact', id: '123' }, evidence: 'cited' }]);
});

test('cited: a ref token inside a tool-call argument credits too', () => {
  const detected = detectUsedRefs({
    candidates: [{ type: 'note', id: 'projects/atlas.md' }],
    replyText: 'Done.',
    toolArgTexts: ['{"path":"note:projects/atlas.md"}'],
  });
  assert.equal(detected.length, 1);
  assert.equal(detected[0].evidence, 'cited');
});

test('content: a distinctive identifier from the snippet credits', () => {
  const detected = detectUsedRefs({
    candidates: [{ type: 'fact', id: '7', snippet: 'The staging cluster lives at staging-eu.example.io port 8443.' }],
    replyText: 'I pointed the smoke test at staging-eu.example.io and it passed.',
    queryText: 'is staging healthy?',
  });
  assert.deepEqual(detected, [{ ref: { type: 'fact', id: '7', snippet: 'The staging cluster lives at staging-eu.example.io port 8443.' }, evidence: 'content' }]);
});

test('content: echoing the user query does NOT credit', () => {
  const detected = detectUsedRefs({
    candidates: [{ type: 'fact', id: '9', snippet: 'Quarterly revenue targets for the Hamilton account.' }],
    replyText: 'Here is what I found about quarterly revenue targets for the Hamilton account.',
    queryText: 'quarterly revenue targets for the Hamilton account',
  });
  assert.deepEqual(detected, []);
});

test('content: stopword-only overlap does NOT credit', () => {
  const detected = detectUsedRefs({
    candidates: [{ type: 'fact', id: '4', snippet: 'This was done because they should have been there.' }],
    replyText: 'They should have been there because this was done.',
    queryText: 'something unrelated',
  });
  assert.deepEqual(detected, []);
});

test('content: three distinctive words or a contiguous phrase credit; two words do not', () => {
  const snippet = 'Clementine daemon supervisor restarts crashed workers automatically overnight.';
  const threeWords = detectUsedRefs({
    candidates: [{ type: 'fact', id: '5', snippet }],
    replyText: 'The supervisor restarts crashed workers when needed.',
    queryText: 'what happens on failure?',
  });
  assert.equal(threeWords.length, 1);

  const twoWords = detectUsedRefs({
    candidates: [{ type: 'fact', id: '5', snippet }],
    replyText: 'The supervisor noticed workers were slow.',
    queryText: 'what happens on failure?',
  });
  assert.deepEqual(twoWords, []);

  const phrase = detectUsedRefs({
    candidates: [{ type: 'fact', id: '5', snippet }],
    replyText: 'Note: the daemon supervisor restarts crashed workers, so no action needed.',
    queryText: 'what happens on failure?',
  });
  assert.equal(phrase.length, 1);
});

test('snippet-less legacy candidates only credit via citation', () => {
  const candidates = [{ type: 'fact' as const, id: '31' }];
  assert.deepEqual(
    detectUsedRefs({ candidates, replyText: 'A long answer full of overlapping distinctive vocabulary tokens.' }),
    [],
  );
  assert.equal(
    detectUsedRefs({ candidates, replyText: 'Using fact:31 here.' }).length,
    1,
  );
});

test('per-run cap: at most 8 refs credit, cited ranked first', () => {
  const candidates = Array.from({ length: 12 }, (_, i) => ({
    type: 'fact' as const,
    id: String(i + 1),
    snippet: `Distinctive payload alpha-${i + 1} zebra-${i + 1} quantum-${i + 1} matches everything.`,
  }));
  const reply = `Cited fact:12 directly. ${candidates.map((c) => c.snippet).join(' ')}`;
  const detected = detectUsedRefs({ candidates, replyText: reply, queryText: 'unrelated' });
  assert.equal(detected.length, 8);
  assert.equal(detected[0].evidence, 'cited');
  assert.equal(detected[0].ref.id, '12');
});

// ---------- snippet carriage (A1) ----------

test('recordRecallRun persists snippets and readRecallRun returns them; identity stays type:id', () => {
  const run = recordRecallRun({
    objective: 'test snippets',
    surface: 'test',
    answerability: 'partial',
    candidateRefs: [
      { type: 'fact', id: '1', snippet: '  padded   snippet  text  ' },
      { type: 'fact', id: '1', snippet: 'a different snippet for the same ref' },
      { type: 'entity', id: '2' },
    ],
  });
  assert.equal(run.candidateRefs.length, 2, 'dedupe still keys on type:id only');
  assert.equal(run.candidateRefs[0].snippet, 'padded snippet text', 'first snippet wins, whitespace collapsed');

  const loaded = readRecallRun(run.id);
  assert.ok(loaded);
  assert.equal(loaded!.candidateRefs[0].snippet, 'padded snippet text');
  assert.equal(loaded!.candidateRefs[1].snippet, undefined);
});

test('oversized snippets are capped at 240 chars', () => {
  const run = recordRecallRun({
    objective: 'cap test',
    surface: 'test',
    answerability: 'partial',
    candidateRefs: [{ type: 'fact', id: '1', snippet: 'x'.repeat(1000) }],
  });
  assert.equal(run.candidateRefs[0].snippet?.length, 240);
});

// ---------- autoCreditRecallRuns (integration) ----------

test('auto-credit: a reply that uses one fact credits ONLY that fact', () => {
  const usedFact = rememberFact({ kind: 'project', content: 'The Atlas launch review moved to Thursday 14:00 in room B-204.' });
  const idleFact = rememberFact({ kind: 'project', content: 'Marketing owns the newsletter cadence decision entirely.' });
  const run = recordRecallRun({
    objective: 'when is the Atlas review?',
    surface: 'automatic_primer',
    answerability: 'supported',
    candidateRefs: [
      { type: 'fact', id: String(usedFact.id), snippet: usedFact.content },
      { type: 'fact', id: String(idleFact.id), snippet: idleFact.content },
    ],
  });

  const outcomes = autoCreditRecallRuns({
    recallIds: [run.id],
    replyText: 'The review moved to Thursday 14:00 in room B-204 — I updated the invite.',
  });
  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes[0].credited.map((d) => d.ref.id), [String(usedFact.id)]);
  assert.equal(getFact(usedFact.id)?.utilityCount, 1);
  assert.equal(getFact(idleFact.id)?.utilityCount, 0, 'merely-displayed alternative earns nothing');
});

test('auto-credit is idempotent across retries and per-run duplicate hooks', () => {
  const fact = rememberFact({ kind: 'project', content: 'Deploy freezes start Friday 18:00 UTC sharp.' });
  const run = recordRecallRun({
    objective: 'when do freezes start?',
    surface: 'automatic_primer',
    answerability: 'supported',
    candidateRefs: [{ type: 'fact', id: String(fact.id), snippet: fact.content }],
  });
  const args = { recallIds: [run.id, run.id], replyText: 'Freezes start Friday 18:00 UTC sharp, plan accordingly.' };
  autoCreditRecallRuns(args);
  autoCreditRecallRuns(args);
  assert.equal(getFact(fact.id)?.utilityCount, 1, 'retries cannot inflate utility');
});

test('auto-credit: an expired run credits nothing', () => {
  const fact = rememberFact({ kind: 'project', content: 'Server rack B-7 decommissions on 2026-08-01.' });
  const run = recordRecallRun({
    objective: 'rack plans?',
    surface: 'test',
    answerability: 'supported',
    candidateRefs: [{ type: 'fact', id: String(fact.id), snippet: fact.content }],
    nowIso: '2020-01-01T00:00:00.000Z',
    ttlHours: 1,
  });
  const outcomes = autoCreditRecallRuns({
    recallIds: [run.id],
    replyText: 'Rack B-7 decommissions on 2026-08-01.',
  });
  assert.deepEqual(outcomes, []);
  assert.equal(getFact(fact.id)?.utilityCount, 0);
});

test('auto-credit never demotes: it only records used, and an explicit not_useful can still be promoted later', () => {
  const fact = rememberFact({ kind: 'project', content: 'The vendor SLA guarantees four-hour response windows.' });
  const run = recordRecallRun({
    objective: 'sla?',
    surface: 'test',
    answerability: 'supported',
    candidateRefs: [{ type: 'fact', id: String(fact.id), snippet: fact.content }],
  });
  recordRecallUse({ recallId: run.id, refs: [`fact:${fact.id}`], outcome: 'not_useful' });
  const outcomes = autoCreditRecallRuns({
    recallIds: [run.id],
    replyText: 'The vendor SLA guarantees four-hour response windows, so we are covered.',
  });
  assert.equal(outcomes.length, 1);
  assert.equal(getFact(fact.id)?.utilityCount, 1, 'one-way promotion mirrors recordRecallUse semantics');
});

test('kill-switch: CLEMMY_AUTO_RECALL_CREDIT=off disables crediting entirely', () => {
  const previous = process.env.CLEMMY_AUTO_RECALL_CREDIT;
  process.env.CLEMMY_AUTO_RECALL_CREDIT = 'off';
  try {
    const fact = rememberFact({ kind: 'project', content: 'Kill-switch verification payload zx-9981 unique.' });
    const run = recordRecallRun({
      objective: 'switch?',
      surface: 'test',
      answerability: 'supported',
      candidateRefs: [{ type: 'fact', id: String(fact.id), snippet: fact.content }],
    });
    assert.deepEqual(autoCreditRecallRuns({ recallIds: [run.id], replyText: fact.content }), []);
    assert.equal(getFact(fact.id)?.utilityCount, 0);
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_AUTO_RECALL_CREDIT;
    else process.env.CLEMMY_AUTO_RECALL_CREDIT = previous;
  }
});
