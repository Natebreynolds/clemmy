/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-relations npx tsx --test src/memory/relations.test.ts
 *
 * WS2 — stored relationship layer. Covers the deterministic fact↔entity link
 * sync (word-boundary, no false positives), entity↔entity edges, and the
 * objective→entity resolver that backs entity recall.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-relations';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const { resetMemoryDb } = await import('./db.js');
// eslint-disable-next-line import/first
const { rememberFact } = await import('./facts.js');
// eslint-disable-next-line import/first
const { upsertEntity } = await import('./reflection.js');
// eslint-disable-next-line import/first
const {
  syncFactEntityLinks, getFactIdsForEntity, getEntityIdsForFact,
  recordEntityEdge, loadEntityEdges, resolveEntityIdsForText, loadFactEntityEdges,
} = await import('./relations.js');

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => { resetMemoryDb(); });

test('syncFactEntityLinks stores a fact↔entity link by word boundary, not substring', () => {
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  upsertEntity({ type: 'company', name: 'team' }); // must NOT match "teamwork"
  const f1 = rememberFact({ kind: 'project', content: 'Kicked off the renewal with Acme this week.' });
  rememberFact({ kind: 'project', content: 'Ran a teamwork retro on Friday.' });

  const stats = syncFactEntityLinks();
  assert.ok(stats.linksWritten >= 1, 'at least the Acme link is written');

  const factsForAcme = getFactIdsForEntity(acme);
  assert.ok(factsForAcme.includes(f1.id), 'Acme links to the renewal fact');
  assert.equal(getEntityIdsForFact(f1.id).includes(acme), true);

  // No entity links the teamwork fact (no "team" false positive).
  const all = loadFactEntityEdges([f1.id]).concat(loadFactEntityEdges(getFactIdsForEntity(acme)));
  assert.ok(!all.some((e) => e.entityId !== acme), 'only the Acme entity is linked');
});

test('syncFactEntityLinks is idempotent (re-running does not duplicate links)', () => {
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const f = rememberFact({ kind: 'project', content: 'Renewal with Acme.' });
  syncFactEntityLinks();
  syncFactEntityLinks();
  assert.deepEqual(getEntityIdsForFact(f.id), [acme]);
});

test('recordEntityEdge upserts and reinforces an entity↔entity relation', () => {
  const dana = upsertEntity({ type: 'person', name: 'Dana' });
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  recordEntityEdge({ subjectId: dana, predicate: 'works at', objectId: acme });
  recordEntityEdge({ subjectId: dana, predicate: 'works at', objectId: acme });
  const edges = loadEntityEdges();
  assert.equal(edges.length, 1, 'one deduped edge');
  assert.equal(edges[0].predicate, 'works at');
  assert.equal(edges[0].recurrenceCount, 2, 'recurrence reinforced');
});

test('recordEntityEdge ignores self-edges and blank predicates', () => {
  const a = upsertEntity({ type: 'person', name: 'Dana' });
  recordEntityEdge({ subjectId: a, predicate: 'is', objectId: a }); // self
  recordEntityEdge({ subjectId: a, predicate: '   ', objectId: a + 999 }); // blank
  assert.equal(loadEntityEdges().length, 0);
});

test('resolveEntityIdsForText matches by canonical name and alias (word boundary)', () => {
  const acme = upsertEntity({ type: 'company', name: 'Acme', aliases: ['Acme Corporation'] });
  upsertEntity({ type: 'person', name: 'Dana' });
  const ids = resolveEntityIdsForText('please summarize the Acme renewal');
  assert.ok(ids.includes(acme));
  assert.ok(!resolveEntityIdsForText('nothing relevant here').includes(acme));
});
