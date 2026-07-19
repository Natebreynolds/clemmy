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
const { resetMemoryDb, openMemoryDb } = await import('./db.js');
// eslint-disable-next-line import/first
const { rememberFact } = await import('./facts.js');
// eslint-disable-next-line import/first
const { recordMemoryEpisode, linkFactEvidence } = await import('./temporal-memory.js');
// eslint-disable-next-line import/first
const { mergeEntities } = await import('./entity-identity.js');
// eslint-disable-next-line import/first
const { upsertEntity } = await import('./reflection.js');
// eslint-disable-next-line import/first
const { upsertResourcePointer } = await import('./source-map.js');
// eslint-disable-next-line import/first
const {
  syncFactEntityLinks, getFactIdsForEntity, getEntityIdsForFact,
  recordEntityEdge, recordGroundedEntityRelationship, loadEntityEdges,
  resolveEntityIdsForText, loadFactEntityEdges, getNeighborEntityIds,
  setFactEntityLinks, backfillGroundedFactEntityLinks, backfillGroundedEntityRelationships, reconcileMemoryRelationships,
  syncFactResourceLinks, loadFactResourceEdges, backfillGroundedFactResourceLinks,
} = await import('./relations.js');

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => { resetMemoryDb(); });

test('syncFactEntityLinks stores a fact↔entity link by word boundary, not substring', () => {
  const f1 = rememberFact({ kind: 'project', content: 'Kicked off the renewal with Acme this week.' });
  rememberFact({ kind: 'project', content: 'Ran a teamwork retro on Friday.' });
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  upsertEntity({ type: 'company', name: 'team' }); // must NOT match "teamwork"

  const stats = syncFactEntityLinks();
  assert.ok(stats.linksWritten >= 1, 'at least the Acme link is written');

  const factsForAcme = getFactIdsForEntity(acme, 50, undefined, true);
  assert.ok(factsForAcme.includes(f1.id), 'Acme links to the renewal fact');
  assert.equal(getEntityIdsForFact(f1.id).includes(acme), true);

  // No entity links the teamwork fact (no "team" false positive).
  const all = loadFactEntityEdges([f1.id]).concat(loadFactEntityEdges(getFactIdsForEntity(acme, 50, undefined, true)));
  assert.ok(!all.some((e) => e.entityId !== acme), 'only the Acme entity is linked');
});

test('syncFactEntityLinks is idempotent (re-running does not duplicate links)', () => {
  const f = rememberFact({ kind: 'project', content: 'Renewal with Acme.' });
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  syncFactEntityLinks();
  syncFactEntityLinks();
  assert.deepEqual(getEntityIdsForFact(f.id), [acme]);
});

test('direct facts create evidence-backed entity links that inferred sync cannot downgrade', () => {
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const fact = rememberFact({ kind: 'project', content: 'Acme approved the renewal plan.' });
  let edge = loadFactEntityEdges([fact.id])[0];
  assert.equal(edge.truth, 'stored');
  assert.equal(edge.confidence, 1);
  assert.match(edge.evidenceExcerpt ?? '', /Acme approved/);
  syncFactEntityLinks();
  edge = loadFactEntityEdges([fact.id])[0];
  assert.equal(edge.truth, 'stored', 'a later name-match sync never downgrades grounded provenance');
});

test('grounded fact link backfill promotes unique names only when fact and evidence both support them', () => {
  const dana = upsertEntity({ type: 'person', name: 'Dana Smith' });
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const episode = recordMemoryEpisode({
    kind: 'tool_result', sessionId: 'fact-ground-session', callId: 'fact-ground-call',
    occurredAt: '2026-07-01T00:00:00.000Z', content: 'Dana Smith met with Acme about renewal terms.',
  });
  const fact = rememberFact({
    kind: 'project', content: 'Dana Smith met with Acme about renewal terms.',
    derivedFrom: { sessionId: 'fact-ground-session', callId: 'fact-ground-call', tool: 'meeting_lookup' },
  });
  linkFactEvidence({
    factId: fact.id, episodeId: episode.id,
    excerpt: 'Dana Smith met with Acme about renewal terms.',
  });
  syncFactEntityLinks();
  assert.ok(loadFactEntityEdges([fact.id]).every((edge) => edge.truth === 'inferred'));

  const first = backfillGroundedFactEntityLinks();
  const second = backfillGroundedFactEntityLinks();
  assert.equal(first.promoted, 2);
  assert.equal(second.promoted, 0);
  assert.deepEqual(new Set(loadFactEntityEdges([fact.id]).filter((edge) => edge.truth === 'stored').map((edge) => edge.entityId)), new Set([dana, acme]));
  assert.equal((openMemoryDb().prepare('SELECT COUNT(*) AS count FROM entity_observations').get() as { count: number }).count, 2);
  assert.deepEqual(
    (openMemoryDb().prepare('SELECT mention_count FROM entities WHERE id IN (?, ?) ORDER BY id').all(dana, acme) as Array<{ mention_count: number }>).map((row) => row.mention_count),
    [1, 1],
    'historical backfill creates exact observations without double-counting legacy mentions',
  );
});

test('grounded fact link backfill leaves shared first-name matches inferred', () => {
  upsertEntity({ type: 'person', name: 'Alex Adams', aliases: ['Alex'] });
  upsertEntity({ type: 'person', name: 'Alex Alvarez', aliases: ['Alex'] });
  const episode = recordMemoryEpisode({
    kind: 'tool_result', sessionId: 'ambiguous-name-session', callId: 'ambiguous-name-call',
    content: 'Alex attended the customer call.',
  });
  const fact = rememberFact({
    kind: 'project', content: 'Alex attended the customer call.',
    derivedFrom: { sessionId: 'ambiguous-name-session', callId: 'ambiguous-name-call', tool: 'meeting_lookup' },
  });
  linkFactEvidence({ factId: fact.id, episodeId: episode.id, excerpt: 'Alex attended the customer call.' });
  syncFactEntityLinks();

  const stats = backfillGroundedFactEntityLinks();
  assert.equal(stats.promoted, 0);
  assert.ok(stats.ambiguous >= 2);
  assert.ok(loadFactEntityEdges([fact.id]).every((edge) => edge.truth === 'inferred'));
});

test('direct facts ground a unique named resource from durable evidence and inferred sync cannot downgrade it', () => {
  const resource = upsertResourcePointer({
    app: 'Google Drive', kind: 'folder', providerId: 'q3-planning', name: 'Q3 Planning',
  });
  const fact = rememberFact({
    kind: 'project', content: 'The Northstar launch plan is stored in the Q3 Planning folder.',
  });
  let edge = loadFactResourceEdges([fact.id]).find((item) => item.resourceId === resource.id);
  assert.equal(edge?.truth, 'stored');
  assert.equal(edge?.confidence, 1);
  assert.match(edge?.evidenceExcerpt ?? '', /Q3 Planning/);

  syncFactResourceLinks();
  edge = loadFactResourceEdges([fact.id]).find((item) => item.resourceId === resource.id);
  assert.equal(edge?.truth, 'stored', 'a later text-match sync never downgrades grounded resource provenance');
});

test('resource backfill promotes unique specific names and leaves duplicate names inferred', () => {
  const unique = upsertResourcePointer({
    app: 'Google Drive', kind: 'folder', providerId: 'q3-planning', name: 'Q3 Planning',
  });
  const duplicateA = upsertResourcePointer({
    app: 'Google Drive', kind: 'folder', providerId: 'client-files-drive', name: 'Client Files',
  });
  const duplicateB = upsertResourcePointer({
    app: 'Notion', kind: 'database', providerId: 'client-files-notion', name: 'Client Files',
  });
  const oneWord = upsertResourcePointer({
    app: 'Airtable', kind: 'table', providerId: 'fixture-one-word-label', name: 'FixtureLabel',
  });
  const content = 'The Q3 Planning folder links to both Client Files resources and the FixtureLabel table.';
  const episode = recordMemoryEpisode({
    kind: 'tool_result', sessionId: 'resource-ground-session', callId: 'resource-ground-call', content,
  });
  const fact = rememberFact({
    kind: 'reference', content,
    derivedFrom: { sessionId: 'resource-ground-session', callId: 'resource-ground-call', tool: 'drive_search' },
  });
  linkFactEvidence({ factId: fact.id, episodeId: episode.id, excerpt: content });
  syncFactResourceLinks();
  assert.ok(loadFactResourceEdges([fact.id]).every((edge) => edge.truth === 'inferred'));

  const first = backfillGroundedFactResourceLinks();
  const second = backfillGroundedFactResourceLinks();
  assert.equal(first.promoted, 1);
  assert.ok(first.ambiguous >= 2);
  assert.ok(first.ignored >= 1, 'a bare one-word label remains inferred even when unique');
  assert.equal(second.promoted, 0);
  const edges = loadFactResourceEdges([fact.id]);
  assert.equal(edges.find((edge) => edge.resourceId === unique.id)?.truth, 'stored');
  assert.equal(edges.find((edge) => edge.resourceId === duplicateA.id)?.truth, 'inferred');
  assert.equal(edges.find((edge) => edge.resourceId === duplicateB.id)?.truth, 'inferred');
  assert.equal(edges.find((edge) => edge.resourceId === oneWord.id)?.truth, 'inferred');
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

test('grounded relationships require exact evidence and retries do not inflate recurrence', () => {
  const dana = upsertEntity({ type: 'person', name: 'Dana' });
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const sourceText = 'Dana works at Acme and leads the renewal team.';
  const episode = recordMemoryEpisode({
    kind: 'tool_result', sessionId: 's-grounded', callId: 'c-grounded',
    sourceUri: 'tool://s-grounded/c-grounded', occurredAt: '2026-07-01T10:00:00.000Z',
    content: sourceText,
  });
  const input = {
    subjectId: dana,
    predicate: 'employed by',
    objectId: acme,
    evidenceEpisodeId: episode.id,
    evidenceExcerpt: 'Dana works at Acme',
    sourceText,
  };
  assert.equal(recordGroundedEntityRelationship(input).outcome, 'add');
  assert.equal(recordGroundedEntityRelationship(input).reason, 'duplicate_evidence');

  const edge = loadEntityEdges()[0];
  assert.equal(edge.predicate, 'works at', 'predicate aliases converge on a controlled label');
  assert.equal(edge.recurrenceCount, 1, 'an extractor retry is not independent corroboration');
  assert.equal(edge.evidenceCount, 1);
  assert.equal(edge.evidence[0].excerpt, 'Dana works at Acme');
  assert.equal(edge.evidence[0].episodeStatus, 'available');

  const rejected = recordGroundedEntityRelationship({
    ...input,
    predicate: 'is probably connected to',
    evidenceExcerpt: 'words not present in the source',
  });
  assert.equal(rejected.outcome, 'ignore');
  assert.equal(loadEntityEdges().length, 1);

  const cooccurrenceOnly = 'Dana and Acme both appear in this directory.';
  const cooccurrenceEpisode = recordMemoryEpisode({
    kind: 'tool_result', sessionId: 's-cooccurrence', callId: 'c-cooccurrence', content: cooccurrenceOnly,
  });
  const unsupported = recordGroundedEntityRelationship({
    subjectId: dana, predicate: 'works at', objectId: acme,
    evidenceEpisodeId: cooccurrenceEpisode.id,
    evidenceExcerpt: cooccurrenceOnly,
    sourceText: cooccurrenceOnly,
  });
  assert.equal(unsupported.reason, 'evidence_does_not_support_edge');
  assert.equal(loadEntityEdges()[0].recurrenceCount, 1, 'co-occurrence is not corroboration');
});

test('reporting-to grammatical variants ground the canonical reports-to edge', () => {
  const teammate = upsertEntity({ type: 'person', name: 'Bobby Romano' });
  const manager = upsertEntity({ type: 'person', name: 'Nathan Reynolds' });
  const sourceText = 'Bobby Romano is on the active team, reporting directly to Nathan Reynolds.';
  const episode = recordMemoryEpisode({
    kind: 'tool_result',
    sessionId: 's-reporting',
    callId: 'c-reporting',
    content: sourceText,
  });
  const result = recordGroundedEntityRelationship({
    subjectId: teammate,
    predicate: 'reports_to',
    objectId: manager,
    evidenceEpisodeId: episode.id,
    evidenceExcerpt: sourceText,
    sourceText,
  });

  assert.equal(result.outcome, 'add');
  assert.equal(loadEntityEdges()[0]?.predicate, 'reports to');
});

test('independent grounded evidence reinforces once and survives episode evidence reads', () => {
  const dana = upsertEntity({ type: 'person', name: 'Dana' });
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  for (const [index, occurredAt] of ['2026-07-01T10:00:00.000Z', '2026-07-02T10:00:00.000Z'].entries()) {
    const sourceText = index === 0 ? 'Dana works at Acme.' : 'The directory confirms Dana works for Acme.';
    const excerpt = index === 0 ? 'Dana works at Acme' : 'Dana works for Acme';
    const episode = recordMemoryEpisode({
      kind: 'tool_result', sessionId: `s-${index}`, callId: `c-${index}`,
      occurredAt, content: sourceText,
    });
    recordGroundedEntityRelationship({
      subjectId: dana, predicate: index === 0 ? 'works at' : 'works for', objectId: acme,
      evidenceEpisodeId: episode.id, evidenceExcerpt: excerpt, sourceText,
    });
  }
  const edge = loadEntityEdges()[0];
  assert.equal(edge.recurrenceCount, 2);
  assert.equal(edge.evidenceCount, 2);
});

test('explicit relationship supersession answers historical and present-time traversal', () => {
  const dana = upsertEntity({ type: 'person', name: 'Dana' });
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const beta = upsertEntity({ type: 'company', name: 'Beta' });
  const oldSource = 'Dana works at Acme.';
  const oldEpisode = recordMemoryEpisode({
    kind: 'tool_result', sessionId: 'old-s', callId: 'old-c',
    occurredAt: '2026-01-01T00:00:00.000Z', content: oldSource,
  });
  recordGroundedEntityRelationship({
    subjectId: dana, predicate: 'works at', objectId: acme,
    evidenceEpisodeId: oldEpisode.id, evidenceExcerpt: 'Dana works at Acme', sourceText: oldSource,
  });

  const newSource = 'As of July, Dana works at Beta.';
  const newEpisode = recordMemoryEpisode({
    kind: 'tool_result', sessionId: 'new-s', callId: 'new-c',
    occurredAt: '2026-07-01T00:00:00.000Z', content: newSource,
  });
  const result = recordGroundedEntityRelationship({
    subjectId: dana, predicate: 'works at', objectId: beta,
    evidenceEpisodeId: newEpisode.id, evidenceExcerpt: 'Dana works at Beta', sourceText: newSource,
    supersedes: { subjectId: dana, predicate: 'works at', objectId: acme },
  });
  assert.equal(result.outcome, 'supersede');
  assert.deepEqual(getNeighborEntityIds([dana], 10, '2026-06-01T00:00:00.000Z'), [acme]);
  assert.deepEqual(getNeighborEntityIds([dana], 10, '2026-07-02T00:00:00.000Z'), [beta]);
});

test('relationship backfill promotes direct evidence syntax and is idempotent', () => {
  const dana = upsertEntity({ type: 'person', name: 'Dana Smith' });
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const fact = rememberFact({ kind: 'project', content: 'Dana Smith works at Acme.' });
  setFactEntityLinks(fact.id, [dana, acme]);

  const first = backfillGroundedEntityRelationships();
  const second = backfillGroundedEntityRelationships();
  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
  assert.equal(second.ignored, 1);
  const edge = loadEntityEdges()[0];
  assert.equal(edge.predicate, 'works at');
  assert.equal(edge.recurrenceCount, 1);
  assert.equal(edge.evidence[0].sourceFactId, fact.id);
  assert.equal(edge.evidence[0].extractionMethod, 'fact_backfill');
});

test('relationship reconciliation refreshes inferred links but promotes only exact durable evidence', () => {
  rememberFact({ kind: 'project', content: 'Dana Smith works at Acme.' });
  upsertEntity({ type: 'person', name: 'Dana Smith' });
  upsertEntity({ type: 'company', name: 'Acme' });
  rememberFact({ kind: 'project', content: 'Dana Smith and Beta appeared in the same search results.' });
  upsertEntity({ type: 'company', name: 'Beta' });

  const first = reconcileMemoryRelationships({ requireBackup: false });
  const second = reconcileMemoryRelationships({ requireBackup: false });
  assert.equal(first.backupPath, null);
  assert.equal(first.relationships.added, 1);
  assert.equal(second.relationships.added, 0);
  assert.equal(loadEntityEdges().length, 1, 'mere Dana/Beta co-occurrence remains an inferred overlay');
  assert.equal(loadEntityEdges()[0].recurrenceCount, 1, 'reconciliation replay cannot inflate recurrence');
});

test('relationship backfill rejects co-occurrence and indirect grammatical objects', () => {
  const fixturePerson = upsertEntity({ type: 'person', name: 'Taylor Example' });
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const fact = rememberFact({
    kind: 'project',
    content: 'Taylor Example leads the Account Management team at Acme.',
  });
  setFactEntityLinks(fact.id, [fixturePerson, acme]);
  const stats = backfillGroundedEntityRelationships();
  assert.equal(stats.candidates, 0);
  assert.equal(loadEntityEdges().length, 0, 'nearby names are not stored as a guessed edge');
});

test('reviewed entity merges preserve grounded relationship evidence and validity', () => {
  const canonical = upsertEntity({ type: 'person', name: 'Dana Smith' });
  const duplicate = upsertEntity({ type: 'person', name: 'Dana' });
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const sourceText = 'Dana works at Acme.';
  const episode = recordMemoryEpisode({
    kind: 'tool_result', sessionId: 'merge-s', callId: 'merge-c',
    occurredAt: '2026-02-01T00:00:00.000Z', content: sourceText,
  });
  recordGroundedEntityRelationship({
    subjectId: duplicate, predicate: 'works at', objectId: acme,
    evidenceEpisodeId: episode.id, evidenceExcerpt: 'Dana works at Acme', sourceText,
  });

  mergeEntities({ sourceEntityId: duplicate, canonicalEntityId: canonical, reason: 'reviewed duplicate' });
  const edge = loadEntityEdges()[0];
  assert.equal(edge.subjectId, canonical);
  assert.equal(edge.evidenceCount, 1);
  assert.equal(edge.evidence[0].episodeId, episode.id);
  assert.deepEqual(getNeighborEntityIds([canonical], 10, '2026-03-01T00:00:00.000Z'), [acme]);
});

test('resolveEntityIdsForText matches by canonical name and alias (word boundary)', () => {
  const acme = upsertEntity({ type: 'company', name: 'Acme', aliases: ['Acme Corporation'] });
  upsertEntity({ type: 'person', name: 'Dana' });
  const ids = resolveEntityIdsForText('please summarize the Acme renewal');
  assert.ok(ids.includes(acme));
  assert.ok(!resolveEntityIdsForText('nothing relevant here').includes(acme));
});
