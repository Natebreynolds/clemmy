import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryEvidenceHit } from './recall-memory.js';
import { explicitlyNamesRecallEntity, prioritizeNamedEntityFacts } from './named-entity-recall-priority.js';

function fact(id: string, score = 0.63): MemoryEvidenceHit {
  return { ref: { type: 'fact', id }, text: 'A stored reporting convention.', score, confidence: 1,
    evidence: [{ episodeId: `source:${id}`, excerpt: 'The user supplied this convention.' }], whyRecalled: [] };
}

test('complete multiword names match case and punctuation without partial-name inference', () => {
  assert.equal(explicitlyNamesRecallEntity('Use the Alpha—Observatory convention.', 'Alpha Observatory'), true);
  assert.equal(explicitlyNamesRecallEntity('Use the Alpha Observatory convention.', 'Alpha'), false);
  assert.equal(explicitlyNamesRecallEntity('Use the Alpha Observatory Annex convention.', 'Alpha Observatory Annexes'), false);
  assert.equal(explicitlyNamesRecallEntity('Use Alpha and Observatory conventions.', 'Alpha Observatory'), false);
  assert.equal(explicitlyNamesRecallEntity('Read project 123.', '123'), false);
});

test('source-backed facts for named entities precede generic entity stubs without merging scopes', () => {
  const entity: MemoryEvidenceHit = { ref: { type: 'entity', id: 1 }, title: 'Alpha', text: 'project · mentioned 4×',
    score: 0.72, confidence: 0.75, evidence: [], whyRecalled: [] };
  const hits = [entity, fact('10'), fact('11', 0.62), fact('12', 0.7)];
  const result = prioritizeNamedEntityFacts(hits, new Set([2, 3]), [
    { factId: 10, entityId: 2, truth: 'stored' },
    { factId: 11, entityId: 3, truth: 'stored' },
    { factId: 12, entityId: 4, truth: 'stored' },
  ]).sort((a, b) => b.score - a.score);
  assert.deepEqual(result.slice(0, 2).map(hit => hit.ref.id), ['10', '11']);
  assert.equal(result.find(hit => hit.ref.id === '12')?.score, 0.7);
  assert.equal(hits[1].score, 0.63, 'ranking does not mutate stored/source candidates');
});

test('inferred links, missing evidence, and excluded candidates gain no authority', () => {
  const noEvidence = { ...fact('11'), evidence: [] };
  const hits = [fact('10'), noEvidence];
  const result = prioritizeNamedEntityFacts(hits, new Set([1]), [
    { factId: 10, entityId: 1, truth: 'inferred' },
    { factId: 11, entityId: 1, truth: 'stored' },
    { factId: 99, entityId: 1, truth: 'stored' },
  ]);
  assert.deepEqual(result, hits);
  assert.equal(result.some(hit => hit.ref.id === '99'), false, 'filtered facts cannot be resurrected');
});

test('broad recall and identity-only rosters retain all candidates and original ordering', () => {
  const roster: MemoryEvidenceHit[] = Array.from({ length: 8 }, (_, id) => ({
    ref: { type: 'entity', id }, title: `Person ${id}`, text: 'person · mentioned 2×',
    score: 0.72, confidence: 0.75, evidence: [], whyRecalled: [],
  }));
  assert.deepEqual(prioritizeNamedEntityFacts(roster, new Set([1]), []), roster);
  const hits = [...roster, fact('10')];
  assert.equal(prioritizeNamedEntityFacts(hits, new Set(), [{ factId: 10, entityId: 1, truth: 'stored' }]), hits);
});
