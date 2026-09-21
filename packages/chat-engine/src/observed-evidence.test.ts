import assert from 'node:assert/strict';
import test from 'node:test';
import { evidenceChips, observedEvidenceChips } from './evidence-presentation.js';

/**
 * The receipt row has to draw from what the client WATCHED, because the
 * harness's own `evidenceRefs` arrives on ~4% of terminals (100 of 2,426 live).
 * Without a second route the row almost never drew, so "done" went back to
 * resting on the prose above it — the exact thing the row exists to replace.
 *
 * The line these tests defend is that observation is not proof. A settled
 * external write is genuine evidence, because 'confirmed' is set by
 * external_write_succeeded — the same event a server-side receipt would cite.
 * Everything softer must degrade to a weaker claim rather than borrow a
 * stronger one.
 */

test('a confirmed external write is reported as confirmed', () => {
  const chips = observedEvidenceChips([
    { id: 'x-write-1', kind: 'tool', status: 'done', effect: 'external_write', write: { disposition: 'confirmed' } },
    { id: 'x-write-2', kind: 'tool', status: 'done', effect: 'external_write', write: { disposition: 'confirmed' } },
  ]);
  assert.equal(chips.length, 1);
  assert.equal(chips[0]?.kind, 'external_receipt');
  assert.equal(chips[0]?.label, '2 writes confirmed');
});

test('a reserved or orphaned write is NOT reported as landed', () => {
  const chips = observedEvidenceChips([
    { id: 'a', kind: 'tool', status: 'running', effect: 'external_write', write: { disposition: 'reserved' } },
    { id: 'b', kind: 'tool', status: 'done', effect: 'external_write', write: { disposition: 'orphaned' } },
    { id: 'c', kind: 'tool', status: 'done', effect: 'external_write', write: { disposition: 'failed' } },
  ]);
  assert.deepEqual(chips, [],
    'a dispatched-but-unobserved write must never read as a settled one — '
    + 'orphaned means it MAY have landed, which is not a receipt');
});

test('the rolling deliverables row contributes its own total, not one', () => {
  const chips = observedEvidenceChips([
    { id: 'deliverables', kind: 'event', status: 'done', count: 3 },
  ]);
  assert.equal(chips[0]?.label, '3 files');
});

test('read work degrades to the weakest kind and never claims a source', () => {
  const chips = observedEvidenceChips([
    { id: 't1', kind: 'tool', status: 'done', effect: 'read' },
    { id: 't2', kind: 'tool', status: 'done', effect: 'read' },
  ]);
  assert.equal(chips.length, 1);
  assert.equal(chips[0]?.kind, 'tool_result',
    'a `source` chip claims Clem read a named artifact; all the client saw was a tool return');
  assert.equal(chips[0]?.label, '2 results');
});

test('unfinished work contributes nothing', () => {
  const chips = observedEvidenceChips([
    { id: 't1', kind: 'tool', status: 'running', effect: 'read' },
    { id: 't2', kind: 'tool', status: 'failed', effect: 'read' },
  ]);
  assert.deepEqual(chips, []);
});

test('an empty or absent turn renders nothing rather than a zero', () => {
  assert.deepEqual(observedEvidenceChips([]), []);
  assert.deepEqual(observedEvidenceChips(undefined), []);
});

test('the harness own refs still outrank observation where both exist', () => {
  // The caller prefers evidenceChips; this pins that they are distinguishable —
  // proven chips carry refs, observed chips cannot.
  const proven = evidenceChips([{ kind: 'external_receipt', id: 'r1' }]);
  const observed = observedEvidenceChips([
    { id: 'x', kind: 'tool', status: 'done', effect: 'external_write', write: { disposition: 'confirmed' } },
  ]);
  assert.equal(proven[0]?.refs.length, 1, 'a proven chip carries the harness ref');
  assert.equal(observed[0]?.refs.length, 0, 'an observed chip has no ref to open');
  assert.equal(proven[0]?.label, observed[0]?.label, 'but both read the same to the owner');
});

test('ordering puts the load-bearing evidence first', () => {
  const chips = observedEvidenceChips([
    { id: 't1', kind: 'tool', status: 'done', effect: 'read' },
    { id: 'deliverables', kind: 'event', status: 'done', count: 1 },
    { id: 'x', kind: 'tool', status: 'done', effect: 'external_write', write: { disposition: 'confirmed' } },
  ]);
  assert.deepEqual(chips.map((c) => c.kind), ['external_receipt', 'artifact', 'tool_result']);
});
