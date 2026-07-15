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
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import type { EmbeddingProvider } from '../memory/embeddings.js';

const TEST_HOME = '/tmp/clemmy-test-memgraph';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const { resetMemoryDb, openMemoryDb } = await import('../memory/db.js');
// eslint-disable-next-line import/first
const { rememberFact, updateFact } = await import('../memory/facts.js');
// eslint-disable-next-line import/first
const { embedMissingFacts, _setEmbeddingProviderForTest } = await import('../memory/embeddings.js');
// eslint-disable-next-line import/first
const { upsertEntity } = await import('../memory/reflection.js');
// eslint-disable-next-line import/first
const { rememberToolChoice } = await import('../memory/tool-choice-store.js');
// eslint-disable-next-line import/first
const { createFocus } = await import('../memory/focus.js');
// eslint-disable-next-line import/first
const {
  syncFactEntityLinks, syncFactResourceLinks, recordEntityEdge,
  recordGroundedEntityRelationship, setFactEntityLinks, setFactResourceLinks,
} = await import('../memory/relations.js');
// eslint-disable-next-line import/first
const { upsertResourcePointer } = await import('../memory/source-map.js');
// eslint-disable-next-line import/first
const { buildMemoryGraph, buildMemoryNeighborhood, collectNonFactStoreNodes } = await import('./memory-graph.js');
// eslint-disable-next-line import/first
const { mergeEntities, observeEntityFromEpisode } = await import('../memory/entity-identity.js');
// eslint-disable-next-line import/first
const { recordMemoryEpisode } = await import('../memory/temporal-memory.js');

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => {
  resetMemoryDb();
  // Keep the suite deterministic and avoid loading the optional local model;
  // semantic-cache cases opt into their own tiny test provider below.
  _setEmbeddingProviderForTest(null);
});
afterEach(() => { _setEmbeddingProviderForTest(null); });

function fakeEmbeddingProvider(model: string, dim: number): EmbeddingProvider {
  return {
    name: 'graph-test',
    model,
    dim,
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Float32Array(dim);
        for (let i = 0; i < dim; i++) {
          vector[i] = ((text.charCodeAt(i % Math.max(1, text.length)) || 1) % 11) + 1;
        }
        return vector;
      });
    },
  };
}

test('fact→entity edges are word-boundary matched, not naive substrings', () => {
  // "teamwork" must NOT link to an entity named "team" (the old includes() bug);
  // a real word mention ("Acme") MUST link.
  upsertEntity({ type: 'company', name: 'team' });
  const acmeId = upsertEntity({ type: 'company', name: 'Acme' });
  rememberFact({ kind: 'project', content: 'Shipped the teamwork retro deck for Acme this week.' });

  const db = openMemoryDb();
  const { edges } = buildMemoryGraph(db, { entitiesLimit: 50, truthMode: 'augmented' });
  const entityEdges = edges.filter((e) => e.type === 'entity');

  // The only entity edge should be to Acme (a real word), never to "team".
  assert.ok(entityEdges.some((e) => e.target === `entity:${acmeId}`), 'expected an inferred edge to Acme');
  assert.ok(!entityEdges.some((e) => e.target.startsWith('entity:') && e.target !== `entity:${acmeId}`),
    'no false edge (e.g. "team" ⊂ "teamwork") should be emitted');
});

test('persisted text-matched fact→entity links remain inferred and are hidden from stored truth', () => {
  const fact = rememberFact({ kind: 'project', content: 'Met with Acme about the renewal.' });
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  syncFactEntityLinks();

  const db = openMemoryDb();
  const { edges } = buildMemoryGraph(db, { entitiesLimit: 50, truthMode: 'augmented' });
  const edge = edges.find((e) => e.type === 'entity' && e.source === `fact:${fact.id}` && e.target === `entity:${acme}`);
  assert.ok(edge, 'expected a fact→entity edge');
  assert.equal(edge?.truth, 'inferred');
  assert.equal(edge?.inferred, true, 'saving a name match does not turn it into verified truth');
  const stored = buildMemoryGraph(db, { entitiesLimit: 50, truthMode: 'stored' });
  assert.ok(!stored.edges.some((candidate) => candidate.id === edge?.id));
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

test('stored graph projects canonical identities and preserves redirected history off-canvas', () => {
  const canonical = upsertEntity({ type: 'person', name: 'Nathan Reynolds' });
  const duplicate = upsertEntity({ type: 'person', name: 'Nate' });
  const fact = rememberFact({ kind: 'user', content: 'Nate leads the client review.' });
  setFactEntityLinks(fact.id, [duplicate]);
  mergeEntities({ sourceEntityId: duplicate, canonicalEntityId: canonical, reason: 'reviewed test duplicate' });

  const graph = buildMemoryGraph(openMemoryDb(), { entitiesLimit: 50, truthMode: 'stored' });
  assert.ok(graph.nodes.some((node) => node.id === `entity:${canonical}`));
  assert.ok(!graph.nodes.some((node) => node.id === `entity:${duplicate}`), 'redirect source is historical, not a second visible person');
  assert.ok(graph.edges.some((edge) => edge.source === `fact:${fact.id}` && edge.target === `entity:${canonical}`));
  assert.equal(graph.meta.coverage?.totals?.entities, 1);
});

test('temporal entity edges expose stored evidence metadata and hide expired relationships', () => {
  const dana = upsertEntity({ type: 'person', name: 'Dana' });
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const legacy = upsertEntity({ type: 'company', name: 'Legacy Co' });
  rememberFact({ kind: 'project', content: 'Dana works with Acme and previously advised Legacy Co.' });
  syncFactEntityLinks();
  recordEntityEdge({
    subjectId: dana,
    predicate: 'works at',
    objectId: acme,
    confidence: 0.91,
    validFrom: '2025-01-01T00:00:00.000Z',
  });
  recordEntityEdge({
    subjectId: dana,
    predicate: 'advised',
    objectId: legacy,
    validFrom: '2020-01-01T00:00:00.000Z',
    validTo: '2021-01-01T00:00:00.000Z',
  });

  const { edges } = buildMemoryGraph(openMemoryDb(), { entitiesLimit: 50 });
  const current = edges.find((edge) => edge.type === 'related' && edge.label === 'works at');
  assert.equal(current?.data?.confidence, 0.91);
  assert.equal(current?.data?.validFrom, '2025-01-01T00:00:00.000Z');
  assert.ok(!edges.some((edge) => edge.type === 'related' && edge.label === 'advised'));
});

test('stored relationship graph and depth-1 neighborhoods expose exact durable evidence', () => {
  const dana = upsertEntity({ type: 'person', name: 'Dana' });
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const sourceText = 'The directory confirms Dana works at Acme.';
  const episode = recordMemoryEpisode({
    kind: 'tool_result', sessionId: 'graph-rel-s', callId: 'graph-rel-c',
    sourceUri: 'directory://people/dana', content: sourceText,
  });
  recordGroundedEntityRelationship({
    subjectId: dana, predicate: 'works at', objectId: acme,
    evidenceEpisodeId: episode.id, evidenceExcerpt: 'Dana works at Acme', sourceText,
  });

  const graph = buildMemoryGraph(openMemoryDb(), { entitiesLimit: 50 });
  const edge = graph.edges.find((candidate) => candidate.type === 'related');
  assert.equal(edge?.truth, 'stored');
  assert.equal(edge?.data?.evidenceCount, 1);
  assert.equal((edge?.data?.evidence as Array<{ excerpt: string }>)[0].excerpt, 'Dana works at Acme');
  assert.equal((graph.meta.coverage as { edgeTypeTotals: Record<string, number> }).edgeTypeTotals.related, 1);

  const neighborhood = buildMemoryNeighborhood(openMemoryDb(), `entity:${dana}`, 1);
  assert.ok(neighborhood.nodes.some((node) => node.id === `entity:${acme}`));
  assert.ok(neighborhood.edges.some((candidate) => candidate.type === 'related' && candidate.data?.evidenceCount === 1));
});

test('stored graph replays a canonical person through exact source episodes', () => {
  const dana = upsertEntity({ type: 'person', name: 'Dana Rivera' });
  const episode = recordMemoryEpisode({
    kind: 'user_turn',
    subtype: 'meeting',
    title: 'Dana project review',
    sourceApp: 'Clementine Meetings (In-person)',
    sessionId: 'meeting:local',
    callId: 'dana-review',
    sourceUri: 'meeting://local/dana-review',
    occurredAt: '2026-07-15T17:00:00.000Z',
    content: 'Dana reviewed the project milestones and launch risks.',
  });
  assert.equal(observeEntityFromEpisode({
    entityId: dana,
    episodeId: episode.id,
    sourceUri: 'meeting://local/dana-review',
    sourceKind: 'manual',
    confidence: 0.96,
  }), true);

  const graph = buildMemoryGraph(openMemoryDb(), { entitiesLimit: 50, truthMode: 'stored' });
  const edge = graph.edges.find((candidate) => candidate.type === 'observed');
  assert.equal(edge?.source, `entity:${dana}`);
  assert.equal(edge?.target, `episode:${episode.id}`);
  assert.equal(edge?.label, 'observed in');
  assert.equal(edge?.truth, 'stored');
  assert.equal(edge?.data?.sourceKind, 'manual');
  assert.equal(edge?.data?.confidence, 0.96);
  assert.ok(graph.nodes.some((node) => node.id === `episode:${episode.id}`));
  assert.equal(graph.nodes.find((node) => node.id === `entity:${dana}`)?.data?.observationCount, 1);
  assert.equal(graph.meta.coverage?.edgeTypeTotals?.observed, 1);
  assert.equal(graph.meta.coverage?.visibleEdgeTypes?.observed, 1);

  const fromPerson = buildMemoryNeighborhood(openMemoryDb(), `entity:${dana}`, 1);
  assert.ok(fromPerson.nodes.some((node) => node.id === `episode:${episode.id}`));
  assert.ok(fromPerson.edges.some((candidate) => candidate.type === 'observed' && candidate.truth === 'stored'));
  const fromEpisode = buildMemoryNeighborhood(openMemoryDb(), `episode:${episode.id}`, 1);
  assert.ok(fromEpisode.nodes.some((node) => node.id === `entity:${dana}`));
  assert.ok(fromEpisode.edges.some((candidate) => candidate.type === 'observed' && candidate.truth === 'stored'));
});

test('inferred fact→entity edges carry inferred:true', () => {
  rememberFact({ kind: 'project', content: 'Met with Acme about the renewal.' });
  const acmeId = upsertEntity({ type: 'company', name: 'Acme' });
  const db = openMemoryDb();
  const { edges } = buildMemoryGraph(db, { entitiesLimit: 50, truthMode: 'augmented' });
  const edge = edges.find((e) => e.type === 'entity' && e.target === `entity:${acmeId}`);
  assert.ok(edge, 'expected an entity edge to Acme');
  assert.equal(edge?.inferred, true, 'render-derived entity edges must be flagged inferred');
});

test('stored truth mode never emits inferred or semantic edges', () => {
  upsertEntity({ type: 'company', name: 'Acme' });
  rememberFact({ kind: 'project', content: 'Met with Acme about the renewal.' });

  const { edges, meta } = buildMemoryGraph(openMemoryDb(), {
    entitiesLimit: 50,
    simEdges: 3,
  });

  assert.ok(edges.length > 0, 'stored membership/evidence edges remain visible');
  assert.ok(edges.every((edge) => edge.truth === 'stored'));
  assert.equal((meta.coverage as { edges: { inferred: number; semantic: number } }).edges.inferred, 0);
  assert.equal((meta.coverage as { edges: { inferred: number; semantic: number } }).edges.semantic, 0);
});

test('stored graph projects persisted resources, episodes, policies, and their exact edges', () => {
  const entityId = upsertEntity({ type: 'company', name: 'Acme' });
  const resource = upsertResourcePointer({
    app: 'Salesforce',
    kind: 'opportunity',
    name: 'Acme renewal',
    whatsHere: 'contract terms',
  });
  const fact = rememberFact({
    kind: 'constraint',
    content: 'Always review the Acme renewal before sending a quote.',
  });
  syncFactEntityLinks();
  syncFactResourceLinks();
  setFactEntityLinks(fact.id, [entityId], { linkType: 'stored', confidence: 1 });
  setFactResourceLinks(fact.id, [resource.id], { linkType: 'stored', confidence: 1 });

  const { nodes, edges } = buildMemoryGraph(openMemoryDb(), { factsLimit: 10, entitiesLimit: 50 });
  assert.ok(nodes.some((node) => node.id === `entity:${entityId}`));
  assert.ok(nodes.some((node) => node.id === `resource:${resource.id}`));
  assert.ok(nodes.some((node) => node.type === 'episode'));
  assert.ok(nodes.some((node) => node.id === `policy:${fact.id}`));
  assert.ok(edges.some((edge) => edge.source === `fact:${fact.id}` && edge.target === `resource:${resource.id}` && edge.truth === 'stored'));
  assert.ok(edges.some((edge) => edge.source === `fact:${fact.id}` && edge.type === 'evidence' && edge.truth === 'stored'));
  assert.ok(edges.some((edge) => edge.source === `policy:${fact.id}` && edge.target === `fact:${fact.id}` && edge.truth === 'stored'));
});

test('stored graph shows recent meeting episodes before any facts are extracted from them', () => {
  const episode = recordMemoryEpisode({
    kind: 'tool_result',
    subtype: 'meeting',
    title: 'In-person pricing review',
    sourceApp: 'Clementine Meetings (In-person)',
    sessionId: 'meeting:local',
    callId: 'local-pricing-review',
    sourceUri: 'meeting://local/local-pricing-review',
    occurredAt: '2026-07-15T18:00:00.000Z',
    content: 'Summary: Reviewed enterprise pricing and the August rollout.',
    metadata: { provider: 'local', segmentCount: 8 },
  });

  const graph = buildMemoryGraph(openMemoryDb(), { factsLimit: 10 });
  const node = graph.nodes.find((candidate) => candidate.id === `episode:${episode.id}`);
  assert.ok(node, 'meeting is visible as a stored episode without a fact→evidence edge');
  assert.equal(node?.label, 'In-person pricing review');
  assert.equal(node?.data?.subtype, 'meeting');
  assert.equal(node?.data?.provider, 'local');
  assert.equal(graph.meta.coverage?.totals?.episodes, 1);
  assert.equal(graph.meta.coverage?.visible?.episode, 1);
});

test('stored graph connects a meeting episode to its exact persisted transcript artifact', () => {
  const artifactPath = '/vault/04-Meetings/2026-07-15-in-person_meeting-local-pricing-review.md';
  const artifact = '---\ntype: meeting-transcript\nmeeting_id: local-pricing-review\n---\n## Summary\nReviewed enterprise pricing.';
  openMemoryDb().prepare(`
    INSERT INTO vault_chunks (path, chunk_index, content, title, mtime, byte_size, content_hash)
    VALUES (?, 0, ?, 'Summary', ?, ?, ?)
  `).run(artifactPath, artifact, Date.parse('2026-07-15T19:00:00.000Z'), Buffer.byteLength(artifact), 'graph-exact-artifact');
  const episode = recordMemoryEpisode({
    kind: 'tool_result', subtype: 'meeting', title: 'In-person pricing review',
    sourceApp: 'Clementine Meetings (In-person)', sessionId: 'meeting:local', callId: 'local-pricing-review',
    sourceUri: 'meeting://local/local-pricing-review', occurredAt: '2026-07-15T18:00:00.000Z',
    content: 'Summary: Reviewed enterprise pricing and the August rollout.',
    metadata: { provider: 'local', artifactPath },
  });

  const graph = buildMemoryGraph(openMemoryDb(), { factsLimit: 10, truthMode: 'stored' });
  const edge = graph.edges.find((candidate) => candidate.type === 'artifact');
  assert.equal(edge?.source, `episode:${episode.id}`);
  assert.equal(edge?.target, `file:${artifactPath}`);
  assert.equal(edge?.truth, 'stored');
  assert.equal(edge?.data?.pointer, 'episode.metadata.artifactPath');
  assert.ok(graph.nodes.some((node) => node.id === `file:${artifactPath}`));
  assert.equal(graph.meta.coverage?.edgeTypeTotals?.artifact, 1);
  assert.equal(graph.meta.coverage?.visibleEdgeTypes?.artifact, 1);

  const fromEpisode = buildMemoryNeighborhood(openMemoryDb(), `episode:${episode.id}`, 1);
  assert.ok(fromEpisode.nodes.some((node) => node.id === `file:${artifactPath}`));
  assert.ok(fromEpisode.edges.some((candidate) => candidate.type === 'artifact' && candidate.truth === 'stored'));
  const fromFile = buildMemoryNeighborhood(openMemoryDb(), `file:${artifactPath}`, 1);
  assert.ok(fromFile.nodes.some((node) => node.id === `episode:${episode.id}`));
  assert.ok(fromFile.edges.some((candidate) => candidate.type === 'artifact' && candidate.truth === 'stored'));
});

test('stored graph never guesses an episode artifact from a similar filename', () => {
  const indexedPath = '/vault/04-Meetings/2026-07-15-pricing-review-similar.md';
  const content = 'A similarly named note that is not the persisted artifact.';
  openMemoryDb().prepare(`
    INSERT INTO vault_chunks (path, chunk_index, content, title, mtime, byte_size, content_hash)
    VALUES (?, 0, ?, 'Pricing review', ?, ?, ?)
  `).run(indexedPath, content, Date.now(), Buffer.byteLength(content), 'graph-similar-artifact');
  recordMemoryEpisode({
    kind: 'tool_result', subtype: 'meeting', title: 'Pricing review',
    sourceApp: 'Clementine Meetings (In-person)', sourceUri: 'meeting://local/pricing-review',
    occurredAt: '2026-07-15T18:00:00.000Z', content: 'Summary: Reviewed enterprise pricing.',
    metadata: { artifactPath: '/vault/04-Meetings/missing-exact-artifact.md' },
  });

  const graph = buildMemoryGraph(openMemoryDb(), { factsLimit: 10, truthMode: 'stored' });
  assert.ok(!graph.edges.some((edge) => edge.type === 'artifact'), 'only an exact persisted path may produce a stored artifact edge');
  assert.equal(graph.meta.coverage?.edgeTypeTotals?.artifact, 0);
});

test('stored neighborhood can load a fact omitted from the overview sample', () => {
  const target = rememberFact({ kind: 'project', content: 'Archived tail-memory target.' });
  const old = '2020-01-01T00:00:00.000Z';
  openMemoryDb().prepare('UPDATE consolidated_facts SET created_at = ?, updated_at = ?, valid_from = ? WHERE id = ?')
    .run(old, old, old, target.id);
  for (let i = 0; i < 15; i++) rememberFact({ kind: 'project', content: `Newer overview fact ${i}.` });

  const overview = buildMemoryGraph(openMemoryDb(), { factsLimit: 10 });
  assert.ok(!overview.nodes.some((node) => node.id === `fact:${target.id}`));

  const neighborhood = buildMemoryNeighborhood(openMemoryDb(), `fact:${target.id}`, 1);
  assert.ok(neighborhood.nodes.some((node) => node.id === `fact:${target.id}`));
  assert.ok(neighborhood.edges.every((edge) => edge.truth === 'stored'));
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

test('semantic graph caches invalidate when fact content changes without changing its id', async () => {
  _setEmbeddingProviderForTest(fakeEmbeddingProvider('graph-space-a', 6));
  const facts = [
    rememberFact({ kind: 'project', content: 'Alpha renewal pricing review.' }),
    rememberFact({ kind: 'project', content: 'Bravo renewal pricing review.' }),
    rememberFact({ kind: 'project', content: 'Charlie renewal pricing review.' }),
    rememberFact({ kind: 'project', content: 'Delta renewal pricing review.' }),
  ];
  assert.equal((await embedMissingFacts({ maxChunks: 20 })).embedded, 4);

  const before = buildMemoryGraph(openMemoryDb(), {
    factsLimit: 10,
    truthMode: 'augmented',
    semanticLayout: true,
    simEdges: 3,
    simThreshold: 0.4,
  });
  assert.ok(before.nodes.some((node) => node.type === 'fact' && typeof node.data?.fx === 'number'));
  assert.ok(before.edges.some((edge) => edge.truth === 'semantic'));

  const changed = facts[0];
  assert.equal(updateFact(changed.id, { content: 'A materially different launch-risk claim.' })?.id, changed.id);
  const after = buildMemoryGraph(openMemoryDb(), {
    factsLimit: 10,
    truthMode: 'augmented',
    semanticLayout: true,
    simEdges: 3,
    simThreshold: 0.4,
  });

  const changedNode = after.nodes.find((node) => node.id === `fact:${changed.id}`);
  assert.equal(changedNode?.data?.fx, undefined, 'a stale content-hash vector cannot retain cached PCA coordinates');
  assert.ok(!after.edges.some((edge) => edge.truth === 'semantic'
    && (edge.source === `fact:${changed.id}` || edge.target === `fact:${changed.id}`)),
  'a content change invalidates semantic edges even though the stable fact id is unchanged');
});

test('semantic graph caches invalidate immediately when the active embedding space changes', async () => {
  _setEmbeddingProviderForTest(fakeEmbeddingProvider('graph-space-a', 6));
  for (const label of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
    rememberFact({ kind: 'project', content: `${label} customer launch planning.` });
  }
  assert.equal((await embedMissingFacts({ maxChunks: 20 })).embedded, 4);

  const before = buildMemoryGraph(openMemoryDb(), {
    factsLimit: 10,
    truthMode: 'augmented',
    semanticLayout: true,
    simEdges: 3,
    simThreshold: 0.4,
  });
  assert.ok(before.nodes.some((node) => node.type === 'fact' && typeof node.data?.fx === 'number'));
  assert.ok(before.edges.some((edge) => edge.truth === 'semantic'));

  // Provider selection changes before backfill. The database generation and
  // fact IDs are intentionally unchanged, but old-space geometry is no longer
  // truthful and must disappear until active-space vectors exist.
  _setEmbeddingProviderForTest(fakeEmbeddingProvider('graph-space-b', 9));
  const afterSwitch = buildMemoryGraph(openMemoryDb(), {
    factsLimit: 10,
    truthMode: 'augmented',
    semanticLayout: true,
    simEdges: 3,
    simThreshold: 0.4,
  });
  assert.ok(afterSwitch.nodes
    .filter((node) => node.type === 'fact')
    .every((node) => node.data?.fx === undefined),
  'PCA cache from the old provider/model/dimension is not reused');
  assert.ok(!afterSwitch.edges.some((edge) => edge.truth === 'semantic'),
    'semantic-edge cache from the old provider/model/dimension is not reused');
});
