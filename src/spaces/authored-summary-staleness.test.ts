/**
 * Run: npx tsx --test src/spaces/authored-summary-staleness.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dropStaleAuthoredSummary } from './workspace-db.js';

test('a source commit without its own summary drops the authored top-level summary; one with it keeps it', () => {
  const doc = { _mobile: { headline: [{ label: 'Drafts saved', value: '0' }] }, prospects: [{ status: 'Not drafted' }], _meta: { prospects: { ok: true } } };
  const after = dropStaleAuthoredSummary(doc, [{ status: 'Draft saved' }]) as Record<string, unknown>;
  assert.equal('_mobile' in after, false, 'stale tiles are gone; inference sees the new records');
  assert.deepEqual(after.prospects, doc.prospects, 'nothing else changes');
  assert.ok('_mobile' in doc, 'the input is not mutated');
  const kept = dropStaleAuthoredSummary(doc, { records: [], _mobile: { headline: [] } });
  assert.equal(kept, doc, 'a source that re-authors its summary keeps the document as it is');
  const plain = { prospects: [] };
  assert.equal(dropStaleAuthoredSummary(plain, [1]), plain, 'no summary, nothing to drop');
  assert.equal(dropStaleAuthoredSummary('not an object', {}), 'not an object');
});
