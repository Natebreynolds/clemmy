import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryEvidenceHit } from './recall-memory.js';
import { prioritizeDistinctiveRecallFacts } from './recall-distinctive-priority.js';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-distinctive-recall-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_EMBEDDINGS = 'off';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
delete process.env.OPENAI_API_KEY;
const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const { rememberFact, forgetFact } = await import('./facts.js');
const { recallEverything, formatUnifiedRecall, projectedRecallAnswerability } = await import('./unified-recall.js');
const { buildUnifiedTurnPrimer } = await import('./turn-primer.js');
const { upsertEntity } = await import('./reflection.js');
const { withMemoryReadScope, stampMemoryScope } = await import('./memory-scope.js');
const { createRecallRunId, recordRecallRun, recordRecallUse } = await import('./recall-usage.js');

beforeEach(() => resetMemoryDb());
after(() => rmSync(testHome, { recursive: true, force: true }));

function fact(id: string, text: string, score = 0.63): MemoryEvidenceHit {
  return { ref: { type: 'fact', id }, text, title: 'user fact', score, confidence: 1,
    evidence: [{ episodeId: `source:${id}`, excerpt: text }], whyRecalled: [] };
}

test('candidate rarity preserves all exact requested terms and full source, without mutating inputs', () => {
  const first = fact('a', 'Use amberleaf conventions, retaining its conditions.');
  const second = fact('b', 'Use mintleaf conventions, retaining its conditions.');
  const broad = Array.from({ length: 8 }, (_, i) => fact(`c${i}`, `Conventions require ordinary conditions for item ${i}.`));
  const hits = [first, second, ...broad];
  const out = prioritizeDistinctiveRecallFacts(hits, 'Use amberleaf and mintleaf conventions.');
  assert.equal(out.length, hits.length);
  assert.equal(out[0].score, out[1].score, 'both requested identities earn symmetric priority');
  assert.ok(out[0].score > out[2].score);
  assert.equal(first.score, 0.63);
  assert.equal(out[0].text, first.text);
  assert.equal(out[0].evidence, first.evidence);
  assert.equal(out[0].confidence, first.confidence, 'ranking is not an upgrade in authority');
});

test('fact/policy aliases count once and negative utility projections receive no bonus', () => {
  const target = fact('1', 'violet records retain every source condition.');
  const other = fact('2', 'ordinary records retain every source condition.');
  const policy = { ...target, ref: { type: 'policy' as const, id: '1' } };
  const base = prioritizeDistinctiveRecallFacts([target, other], 'violet records');
  const aliases = prioritizeDistinctiveRecallFacts([target, policy, other], 'violet records');
  assert.equal(aliases[0].score, base[0].score);
  assert.equal(aliases[1].score, base[0].score);
  assert.deepEqual(prioritizeDistinctiveRecallFacts([target, policy, other], 'violet records', new Set(['fact:1'])),
    [target, policy, other], 'negative attribution cannot be undone through its policy alias');
});

test('singleton, absent, prefix and unsupported matches do not gain priority; sparse ordinary matches stay bounded', () => {
  const singleton = [fact('1', 'violet convention')];
  assert.equal(prioritizeDistinctiveRecallFacts(singleton, 'violet convention'), singleton);
  const hits = [fact('1', 'violetleaf convention'), fact('2', 'garden convention')];
  assert.deepEqual(prioritizeDistinctiveRecallFacts(hits, 'violet convention'), hits, 'no prefix match');
  assert.deepEqual(prioritizeDistinctiveRecallFacts(hits, 'unrelated'), hits);
  const unsupported = { ...fact('3', 'violet convention'), evidence: [] };
  assert.equal(prioritizeDistinctiveRecallFacts([...hits, unsupported], 'violet convention')[2], unsupported);
  const relevant = fact('long', 'Current source checking records explain why answering from retained evidence matters, with every condition.', 0.74);
  const incidental = fact('short', 'The current wallpaper is blue.', 0.58);
  const sparse = prioritizeDistinctiveRecallFacts([relevant, incidental], 'current source checking before answering');
  assert.ok(sparse[0].score > sparse[1].score, 'one ordinary sparse match must not displace stronger broad support');
  assert.ok(sparse[1].score - incidental.score < 0.07);
  const boilerplate = [fact('word', 'You should give the answer only here.'), fact('other', 'Ordinary gardening record.')];
  assert.deepEqual(prioritizeDistinctiveRecallFacts(boilerplate, 'Could you give this to me only here?'), boilerplate,
    'function words are not distinctive content');
});

test('Unicode full-token equality is supported without an identifier detector', () => {
  const hits = [fact('1', 'Zéphyr instructions retain scope.'), fact('2', 'Standard instructions retain scope.')];
  assert.ok(prioritizeDistinctiveRecallFacts(hits, 'zéphyr instructions')[0].score > hits[0].score);
  assert.deepEqual(prioritizeDistinctiveRecallFacts(hits, 'zéph instructions'), hits);
});

function seedCompetition() {
  const marker = 'MeadowLoom79';
  const target = rememberFact({ kind: 'user', content: `My recurring preference for ${marker} explanations is three short numbered items followed by "Meadow horizon". Apply it only for that named explanation.` });
  for (let i = 0; i < 18; i += 1) {
    rememberFact({ kind: 'user', content: `Workspace source for ordinary record ${i}: orchard ${i}, compass ${i}, lantern ${i}.` });
  }
  for (const name of ['source', 'current', 'checking', 'matters', 'workspace', 'skill', 'identifier']) {
    upsertEntity({ type: 'thing', name });
  }
  return { marker, target };
}

test('real temp memory admits an unpinned learned preference through both bounded ambient primer and targeted cross-store rendering', async () => {
  const { marker, target } = seedCompetition();
  assert.equal(target.pinned, false);
  const query = `Give me a ${marker} explanation of why checking the current source matters before answering.`;
  const primer = await buildUnifiedTurnPrimer({ query, surface: 'automatic_primer', limit: 10,
    maxChars: 1_200, format: 'tail', selection: { relativeFloor: 0.5, reservedPolicySlots: 2 } });
  assert.equal(primer.status, 'ok');
  assert.ok(primer.visibleRefs?.some(ref => ref.type === 'fact' && ref.id === String(target.id)));
  assert.ok(primer.text?.includes(target.content), 'retain the complete conditional preference');
  assert.ok((primer.text?.length ?? 0) <= 1_200, 'the existing prompt budget remains bounded');
  const result = await recallEverything(`${marker} skill or workspace identifier`, { limit: 10 });
  const rendered = formatUnifiedRecall(result, 4_000);
  assert.ok(rendered.includes(`[ref fact:${target.id}]`));
  assert.ok(rendered.includes(target.content));
  assert.ok(rendered.length <= 4_000);
  assert.match(rendered, /coverage: non-exhaustive/);
});

test('real admission still excludes inactive, other-project, future and corrected facts before rarity; negative attribution stays demoted', async () => {
  const { marker, target } = seedCompetition();
  const hidden = rememberFact({ kind: 'user', content: `${marker} hidden tenant requirement.` });
  stampMemoryScope('fact', hidden.id, { projectId: 'other-project', agentKey: null });
  const inactive = rememberFact({ kind: 'user', content: `${marker} retired requirement.` });
  forgetFact(inactive.id);
  const future = rememberFact({ kind: 'user', content: `${marker} future requirement.` });
  openMemoryDb().prepare('UPDATE consolidated_facts SET created_at=?,valid_from=? WHERE id=?')
    .run('2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', future.id);
  const corrected = rememberFact({ kind: 'user', content: `${marker} contradicted requirement.` });
  const correctionRun = recordRecallRun({ id: createRecallRunId(), objective: marker, surface: 'memory_recall_all',
    answerability: 'partial',
    candidateRefs: [{ type: 'fact', id: String(corrected.id) }] });
  recordRecallUse({ recallId: correctionRun.id, refs: [`fact:${corrected.id}`], outcome: 'not_useful', detail: 'auto:correction fixture' });
  const negativeRun = recordRecallRun({ id: createRecallRunId(), objective: marker, surface: 'memory_recall_all',
    answerability: 'partial',
    candidateRefs: [{ type: 'fact', id: String(target.id) }] });
  recordRecallUse({ recallId: negativeRun.id, refs: [`fact:${target.id}`], outcome: 'not_useful', detail: 'fixture not applicable' });
  const result = await withMemoryReadScope({ projectId: 'this-project', agentKey: null },
    () => recallEverything(`${marker} explanation`, { limit: 50, perStore: 30, stores: ['fact'], graphDepth: 0 }));
  const ids = result.hits.map(hit => hit.ref);
  for (const excluded of [hidden, inactive, future, corrected]) assert.ok(!ids.includes(String(excluded.id)));
  const kept = result.hits.find(hit => hit.ref === String(target.id));
  assert.ok(kept);
  assert.ok(kept.whyRecalled?.some(reason => reason.includes('not-useful')));
  assert.ok(!kept.whyRecalled?.some(reason => reason.includes('distinctive')), 'negative utility is not overridden');
});

test('the exact existing support boundary is preserved and complete-set projection cannot upgrade a weak rarity match', () => {
  const weak = fact('weak', 'Bluewillow roster history retains complete conditions.', 0.449);
  const eligible = fact('eligible', 'Amberleaf roster history retains complete conditions.', 0.45);
  const other = fact('other', 'Ordinary roster history retains complete conditions.', 0.58);
  const hits = prioritizeDistinctiveRecallFacts([weak, eligible, other], 'Bluewillow Amberleaf roster');
  assert.equal(hits[0], weak);
  assert.ok(hits[1].score > 0.45, 'the existing inclusive boundary remains inclusive');
  const projected = { type: 'fact' as const, ref: weak.ref.id, title: 'user fact', snippet: weak.text,
    score: hits[0].score, evidence: weak.evidence, truncated: false };
  assert.equal(projectedRecallAnswerability({ objective: 'complete Bluewillow roster', answerability: 'supported' }, [projected]), 'partial',
    'new rarity must not manufacture complete-set eligibility from a weak fact');
});
