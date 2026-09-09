import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hitSourceLine, memoryKind, whyChip, whyChips } from './memory-why.js';

test('scores become words and strong matches lead', () => {
  assert.deepEqual(whyChip('semantic similarity 0.91'), { label: 'similar meaning', strong: true });
  assert.deepEqual(whyChip('lexical relevance 0.31'), { label: 'word match', strong: false });
  assert.deepEqual(whyChip('lexical relevance 0.95'), { label: 'exact words', strong: true });
  assert.deepEqual(whyChip('source-backed'), { label: 'has a source' });
  assert.deepEqual(whyChip('entity name or alias matched'), { label: 'exact name', strong: true });
  assert.equal(whyChip('supports fact:123'), null, 'an id is not a reason');
  assert.deepEqual(whyChip('something new the engine says'), { label: 'something new the engine says' }, 'unknown reasons pass through, never invented');
  const chips = whyChips({ whyRecalled: ['lexical relevance 0.2', 'semantic similarity 0.9', 'source-backed', 'semantic similarity 0.9'] });
  assert.deepEqual(chips.map((c) => c.label), ['similar meaning', 'word match', 'has a source'], 'deduped, strong first');
});

test('kinds read as a person names them', () => {
  assert.equal(memoryKind('fact', 'feedback'), 'preference');
  assert.equal(memoryKind('fact', 'constraint'), 'rule');
  assert.equal(memoryKind('entity'), 'person');
  assert.equal(memoryKind('procedure'), 'howto');
  assert.equal(memoryKind('episode'), 'moment');
});

test('the meta column names the source and the date', () => {
  assert.deepEqual(hitSourceLine({ evidence: [{ episodeId: 'e', excerpt: 'x', sourceUri: 'salesforce://Opportunity/006' }], validFrom: '2026-08-25T10:00:00Z' }), { source: 'Salesforce', when: 'Aug 25' });
  assert.deepEqual(hitSourceLine({ evidence: [], validFrom: undefined }), { source: '', when: '' });
  assert.equal(hitSourceLine({ evidence: [{ episodeId: 'e', excerpt: 'x', sourceUri: 'clementine://session/abc' }], validFrom: undefined }).source, '', 'her own sessions are not a source a person names');
  assert.deepEqual(whyChip('stored graph traversal'), { label: 'linked in memory' });
});
