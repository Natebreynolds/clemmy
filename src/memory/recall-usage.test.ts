/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-recall-usage npx tsx --test src/memory/recall-usage.test.ts
 */
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-recall-usage';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const { getFact, rememberFact } = await import('./facts.js');
const {
  parseRecallRef,
  readRecallRefUtilitySignals,
  readRecallUsageHealth,
  reapExpiredUnusedRecallRuns,
  recordRecallRun,
  recordRecallUse,
} = await import('./recall-usage.js');

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => { resetMemoryDb(); });

test('selected use credits only an exact returned ref and retries are idempotent', () => {
  const fact = rememberFact({ kind: 'project', content: 'The Atlas launch review is Thursday.' });
  const run = recordRecallRun({
    objective: 'when is the Atlas review?',
    surface: 'test',
    answerability: 'supported',
    candidateRefs: [
      { type: 'fact', id: String(fact.id) },
      { type: 'entity', id: '42' },
      { type: 'fact', id: String(fact.id) },
    ],
  });
  assert.equal(run.candidateRefs.length, 2, 'candidate refs are deduplicated');

  const first = recordRecallUse({
    recallId: run.id,
    refs: [`fact:${fact.id}`, 'fact:999999'],
    detail: 'Changed the date in the answer.',
  });
  assert.equal(first.ok, true);
  assert.deepEqual(first.utilityFactIds, [fact.id]);
  assert.deepEqual(first.rejected, ['fact:999999']);
  assert.equal(getFact(fact.id)?.utilityCount, 1);

  const retry = recordRecallUse({ recallId: run.id, refs: [`fact:${fact.id}`] });
  assert.equal(retry.recorded.length, 0);
  assert.equal(retry.duplicates.length, 1);
  assert.equal(getFact(fact.id)?.utilityCount, 1, 'retry cannot inflate utility');
});

test('fact and policy projections of one claim earn one utility increment per recall', () => {
  const fact = rememberFact({ kind: 'constraint', content: 'Never send an external message without approval.' });
  const run = recordRecallRun({
    objective: 'send the update',
    surface: 'test',
    answerability: 'supported',
    candidateRefs: [
      { type: 'fact', id: String(fact.id) },
      { type: 'policy', id: String(fact.id) },
    ],
  });
  const result = recordRecallUse({ recallId: run.id, refs: [`policy:${fact.id}`, `fact:${fact.id}`] });
  assert.equal(result.recorded.length, 2, 'both selected projections remain auditable');
  assert.deepEqual(result.utilityFactIds, [fact.id]);
  assert.equal(getFact(fact.id)?.utilityCount, 1);
});

test('not-useful feedback and expired recall runs never reinforce ranking', () => {
  const fact = rememberFact({ kind: 'reference', content: 'Old candidate resource pointer.' });
  const now = '2026-07-15T12:00:00.000Z';
  const run = recordRecallRun({
    objective: 'find the current resource',
    surface: 'test',
    answerability: 'partial',
    candidateRefs: [{ type: 'fact', id: String(fact.id) }],
    nowIso: now,
  });
  const feedback = recordRecallUse({
    recallId: run.id,
    refs: [`fact:${fact.id}`],
    outcome: 'not_useful',
    nowIso: '2026-07-15T12:01:00.000Z',
  });
  assert.equal(feedback.recorded.length, 1);
  assert.equal(getFact(fact.id)?.utilityCount, 0);

  const expired = recordRecallRun({
    objective: 'old recall',
    surface: 'test',
    answerability: 'partial',
    candidateRefs: [{ type: 'fact', id: String(fact.id) }],
    nowIso: '2026-06-01T00:00:00.000Z',
    ttlHours: 1,
  });
  const late = recordRecallUse({ recallId: expired.id, refs: [`fact:${fact.id}`], nowIso: now });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'expired');
  assert.equal(getFact(fact.id)?.utilityCount, 0);
  assert.equal(reapExpiredUnusedRecallRuns(now), 1, 'only the expired run without feedback is reaped');
});

test('not-useful feedback can be corrected to material use exactly once', () => {
  const fact = rememberFact({ kind: 'project', content: 'The Juniper review moved to Friday.' });
  const run = recordRecallRun({
    objective: 'when is the Juniper review?',
    surface: 'test',
    answerability: 'supported',
    candidateRefs: [{ type: 'fact', id: String(fact.id) }],
  });
  const ref = `fact:${fact.id}`;
  recordRecallUse({ recallId: run.id, refs: [ref], outcome: 'not_useful' });
  assert.equal(getFact(fact.id)?.utilityCount, 0);

  const corrected = recordRecallUse({ recallId: run.id, refs: [ref], outcome: 'used', detail: 'The date was used.' });
  assert.deepEqual(corrected.utilityFactIds, [fact.id]);
  assert.equal(corrected.recorded.length, 1);
  assert.equal(getFact(fact.id)?.utilityCount, 1);

  const retry = recordRecallUse({ recallId: run.id, refs: [ref], outcome: 'used' });
  assert.equal(retry.recorded.length, 0);
  assert.equal(retry.duplicates.length, 1);
  assert.equal(getFact(fact.id)?.utilityCount, 1);
});

test('exact utility signals cover every memory ref type without touching fact counters', () => {
  const refs = [
    { type: 'note' as const, id: '/vault/projects/cobalt.md' },
    { type: 'entity' as const, id: '42' },
    { type: 'resource' as const, id: '7' },
    { type: 'episode' as const, id: 'meeting:local:cobalt' },
    { type: 'procedure' as const, id: 'review cobalt launch' },
  ];
  const first = recordRecallRun({
    objective: 'review the Cobalt launch', surface: 'test', answerability: 'supported',
    candidateRefs: refs,
  });
  recordRecallUse({
    recallId: first.id,
    refs: refs.map((ref) => `${ref.type}:${ref.id}`),
  });
  const second = recordRecallRun({
    objective: 'review the Cobalt launch again', surface: 'test', answerability: 'partial',
    candidateRefs: refs,
  });
  recordRecallUse({
    recallId: second.id,
    refs: [`resource:${refs[2].id}`],
    outcome: 'not_useful',
  });

  const signals = readRecallRefUtilitySignals(refs);
  for (const ref of refs) {
    assert.equal(signals.get(`${ref.type}:${ref.id}`)?.used, 1, `${ref.type} material use is queryable`);
  }
  assert.equal(signals.get('resource:7')?.notUseful, 1);
  assert.ok(signals.get('episode:meeting:local:cobalt')?.lastUsedAt);
  const health = readRecallUsageHealth();
  assert.equal(health.refUtilityEvents, refs.length);
  assert.equal(health.refTypeUses.episode, 1);
  assert.equal(health.refTypeUses.resource, 1);
  assert.equal(health.topRefShare, 1 / refs.length);
});

test('health reports run conversion and fact-use concentration without join inflation', () => {
  const a = rememberFact({ kind: 'user', content: 'Nathan prefers concise status updates.' });
  const b = rememberFact({ kind: 'project', content: 'Project Juniper uses a weekly status report.' });
  const now = '2026-07-15T12:00:00.000Z';
  const runA = recordRecallRun({
    objective: 'format the status', surface: 'test', answerability: 'supported', nowIso: now,
    candidateRefs: [{ type: 'fact', id: String(a.id) }, { type: 'fact', id: String(b.id) }],
  });
  recordRecallUse({ recallId: runA.id, refs: [`fact:${a.id}`, `fact:${b.id}`], nowIso: now });
  const runB = recordRecallRun({
    objective: 'how concise?', surface: 'test', answerability: 'supported', nowIso: now,
    candidateRefs: [{ type: 'fact', id: String(a.id) }],
  });
  recordRecallUse({ recallId: runB.id, refs: [`fact:${a.id}`], nowIso: now });
  recordRecallRun({
    objective: 'unanswered lookup', surface: 'test', answerability: 'insufficient', nowIso: now,
    candidateRefs: [],
  });

  const health = readRecallUsageHealth(30, now);
  assert.equal(health.runs, 3, 'multiple selected refs do not inflate the run denominator');
  assert.equal(health.usedRuns, 2);
  assert.equal(health.conversionRate, 2 / 3);
  assert.equal(health.factUtilityEvents, 3);
  assert.equal(health.refUtilityEvents, 3);
  assert.equal(health.refTypeUses.fact, 3);
  assert.equal(health.topFact?.id, a.id);
  assert.equal(health.topFactShare, 2 / 3);
  assert.equal(health.topRef?.type, 'fact');
  assert.equal(health.topRefShare, 2 / 3);
});

test('ref parsing preserves ids that contain colons', () => {
  assert.deepEqual(parseRecallRef('episode:meeting:local:abc'), { type: 'episode', id: 'meeting:local:abc' });
  assert.equal(parseRecallRef('unknown:1'), null);
  assert.equal(parseRecallRef('fact:'), null);
});
