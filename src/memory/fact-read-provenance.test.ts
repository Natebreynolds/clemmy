import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConsolidatedFact } from './facts.js';
import { formatFactRead } from './fact-read-provenance.js';

const fact = (id: number, extra: Partial<ConsolidatedFact> = {}): ConsolidatedFact => ({
  id, kind: 'reference', content: `source ${id}`, source: {}, score: 1,
  active: true, createdAt: '', updatedAt: '', ...extra,
});

test('exact reads expose recorded lineage without searching or traversing source graphs', () => {
  const reads: number[] = [];
  const output = formatFactRead(fact(9, { derivationDepth: 1, derivedFromFactIds: [2, 1, 2] }), id => {
    reads.push(id); return fact(id, { derivedFromFactIds: [99] });
  });
  assert.deepEqual(reads, [2, 1]);
  assert.match(output, /inferred pattern, not an explicit user rule/);
  assert.match(output, /Recorded source fact references: fact:2, fact:1/);
  assert.match(output, /source 2/);
  assert.doesNotMatch(output, /fact:99/);
});

test('previews bound content and lookups and do not resurface retired sources', () => {
  const reads: number[] = [];
  const output = formatFactRead(fact(9, { derivedFromFactIds: [1, 2, 3, 4, 5, 6, 7] }), id => {
    reads.push(id);
    if (id === 1) return fact(id, { active: false, content: 'FORGOTTEN' });
    if (id === 2) return fact(id, { supersededByFactId: 8, content: 'OUTDATED' });
    if (id === 3) return null;
    return fact(id, { content: 'a'.repeat(601) });
  });
  assert.deepEqual(reads, [1, 2, 3, 4, 5, 6]);
  assert.doesNotMatch(output, /FORGOTTEN|OUTDATED/);
  assert.match(output, /superseded by fact:8/);
  assert.match(output, /fact:3\] unavailable/);
  assert.match(output, /truncated; reopen/);
  assert.match(output, /1 source previews omitted/);
  assert.match(output, /fact:7/);
});

test('missing lineage is explicit for inference without labeling atomic facts user rules', () => {
  assert.match(formatFactRead(fact(1, { derivationDepth: 1 }), () => null), /references: unavailable/);
  assert.doesNotMatch(formatFactRead(fact(1), () => null), /explicit user rule|inferred pattern/);
});
