/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-memgraph npx tsx --test src/dashboard/memory-graph.test.ts
 *
 * Characterizes the Phase-0 graph-fidelity fixes:
 *  - fact→entity edges use WORD-BOUNDARY matching (no more "team" ⊂ "teamwork"
 *    false edges) and are flagged `inferred: true` (so the UI can render them
 *    dashed vs WS2's stored edges).
 *  - graph meta reports `totalFacts` (true active count) so the UI can show
 *    "showing N of M" instead of implying the rendered slice is everything.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-memgraph';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const { resetMemoryDb, openMemoryDb } = await import('../memory/db.js');
// eslint-disable-next-line import/first
const { rememberFact } = await import('../memory/facts.js');
// eslint-disable-next-line import/first
const { upsertEntity } = await import('../memory/reflection.js');
// eslint-disable-next-line import/first
const { rememberToolChoice } = await import('../memory/tool-choice-store.js');
// eslint-disable-next-line import/first
const { createFocus } = await import('../memory/focus.js');
// eslint-disable-next-line import/first
const { syncFactEntityLinks, recordEntityEdge } = await import('../memory/relations.js');
// eslint-disable-next-line import/first
const { buildMemoryGraph, collectNonFactStoreNodes } = await import('./memory-graph.js');

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => { resetMemoryDb(); });

test('fact→entity edges are word-boundary matched, not naive substrings', () => {
  // "teamwork" must NOT link to an entity named "team" (the old includes() bug);
  // a real word mention ("Acme") MUST link.
  upsertEntity({ type: 'company', name: 'team' });
  const acmeId = upsertEntity({ type: 'company', name: 'Acme' });
  rememberFact({ kind: 'project', content: 'Shipped the teamwork retro deck for Acme this week.' });

  const db = openMemoryDb();
  const { edges } = buildMemoryGraph(db, { entitiesLimit: 50 });
  const entityEdges = edges.filter((e) => e.type === 'entity');

  // The only entity edge should be to Acme (a real word), never to "team".
  assert.ok(entityEdges.some((e) => e.target === `entity:${acmeId}`), 'expected an inferred edge to Acme');
  assert.ok(!entityEdges.some((e) => e.target.startsWith('entity:') && e.target !== `entity:${acmeId}`),
    'no false edge (e.g. "team" ⊂ "teamwork") should be emitted');
});

test('WS2: after link sync, the fact→entity edge is STORED (solid), not inferred', () => {
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const fact = rememberFact({ kind: 'project', content: 'Met with Acme about the renewal.' });
  syncFactEntityLinks();

  const db = openMemoryDb();
  const { edges } = buildMemoryGraph(db, { entitiesLimit: 50 });
  const edge = edges.find((e) => e.type === 'entity' && e.source === `fact:${fact.id}` && e.target === `entity:${acme}`);
  assert.ok(edge, 'expected a fact→entity edge');
  assert.ok(!edge?.inferred, 'a stored edge must NOT be flagged inferred (renders solid)');
});

test('WS2: entity↔entity edges render as labeled "related" edges between entity nodes', () => {
  const dana = upsertEntity({ type: 'person', name: 'Dana' });
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  // A fact mentioning both keeps the entity nodes present in the graph.
  rememberFact({ kind: 'project', content: 'Dana from Acme signed the renewal.' });
  syncFactEntityLinks();
  recordEntityEdge({ subjectId: dana, predicate: 'works at', objectId: acme });

  const db = openMemoryDb();
  const { edges } = buildMemoryGraph(db, { entitiesLimit: 50 });
  const rel = edges.find((e) => e.type === 'related');
  assert.ok(rel, 'expected a related entity↔entity edge');
  assert.equal(rel?.label, 'works at');
});

test('inferred fact→entity edges carry inferred:true', () => {
  const acmeId = upsertEntity({ type: 'company', name: 'Acme' });
  rememberFact({ kind: 'project', content: 'Met with Acme about the renewal.' });
  const db = openMemoryDb();
  const { edges } = buildMemoryGraph(db, { entitiesLimit: 50 });
  const edge = edges.find((e) => e.type === 'entity' && e.target === `entity:${acmeId}`);
  assert.ok(edge, 'expected an entity edge to Acme');
  assert.equal(edge?.inferred, true, 'render-derived entity edges must be flagged inferred');
});

const NON_FACT_TYPES = new Set(['tool-recall', 'skill', 'workflow', 'goal', 'focus']);

test('WS1: non-fact stores (tool-recall, focus) appear as first-class nodes when graph-full is on', () => {
  delete process.env.CLEMMY_GRAPH_FULL; // default = on
  rememberToolChoice({ intent: 'pull stale salesforce accounts', choice: { kind: 'cli', identifier: 'sf', testedAt: new Date().toISOString() } });
  createFocus({ resourceRef: 'deal-board', title: 'D’Amore renewal', summary: 'tracking the renewal' });

  const db = openMemoryDb();
  const { nodes, meta } = buildMemoryGraph(db);
  assert.ok(nodes.some((n) => n.type === 'tool-recall'), 'tool-recall node should be present');
  assert.ok(nodes.some((n) => n.type === 'focus'), 'focus node should be present');
  assert.equal(meta.graphFull, true);
  assert.ok((meta.stores as { toolRecall: number }).toolRecall >= 1, 'meta.stores.toolRecall counted');
});

test('WS1: CLEMMY_GRAPH_FULL=off restores the legacy fact-only graph (byte-compatible)', () => {
  process.env.CLEMMY_GRAPH_FULL = 'off';
  try {
    rememberToolChoice({ intent: 'list dormant opportunities', choice: { kind: 'cli', identifier: 'sf', testedAt: new Date().toISOString() } });
    createFocus({ resourceRef: 'board-2', title: 'Q3 board', summary: 'q3' });
    const db = openMemoryDb();
    const { nodes, meta } = buildMemoryGraph(db);
    assert.ok(!nodes.some((n) => NON_FACT_TYPES.has(n.type)), 'no non-fact node types when flag off');
    assert.equal(meta.graphFull, false);
  } finally {
    delete process.env.CLEMMY_GRAPH_FULL;
  }
});

test('WS1: collectNonFactStoreNodes is independently callable and counts each store', () => {
  rememberToolChoice({ intent: 'enrich a domain', choice: { kind: 'composio', identifier: 'dataforseo', testedAt: new Date().toISOString() } });
  const { nodes, counts } = collectNonFactStoreNodes();
  assert.ok(counts.toolRecall >= 1);
  assert.ok(nodes.some((n) => n.type === 'tool-recall' && n.label.includes('enrich')));
});

test('graph meta reports totalFacts (true active count) for the truncation banner', () => {
  // factsLimit clamps to a floor of 10, so seed above it to exercise truncation.
  for (let i = 0; i < 15; i++) rememberFact({ kind: 'project', content: `Distinct project fact number ${i} alpha bravo` });
  const db = openMemoryDb();
  const { meta } = buildMemoryGraph(db, { factsLimit: 10 });
  assert.equal(meta.factCount, 10, 'factCount is the rendered (truncated) slice');
  assert.equal(meta.totalFacts, 15, 'totalFacts is the true active count');
});
