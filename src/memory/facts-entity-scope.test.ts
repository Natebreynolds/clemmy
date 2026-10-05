import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const priorHome = process.env.CLEMENTINE_HOME;
const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-direct-fact-entity-scope-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.CLEMMY_EMBED_AT_WRITE = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';

const { closeMemoryDb, openMemoryDb, resetMemoryDb } = await import('./db.js');
const { rememberFact, factScope, moveFactToScope } = await import('./facts.js');
const { upsertEntity } = await import('./entity-identity.js');
const { recordMemoryEpisode, getFactEvidence } = await import('./temporal-memory.js');
const { EVERYWHERE, withMemorySettledFor } = await import('./memory-scope.js');

const LOCAL = { projectId: 'prj_entity_scope_fixture', agentKey: null };
const content = 'For this synthetic project, the standing report heading is TOPAZ HARBOR and the footnote label is COPPER KITE.';

beforeEach(() => resetMemoryDb());
after(() => {
  closeMemoryDb();
  rmSync(testHome, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = priorHome;
});

function source(callId: string, text: string, occurredAt: string) {
  return recordMemoryEpisode({ kind: 'user_turn', sessionId: 'entity-scope-fixture',
    callId, content: text, occurredAt });
}

function existingCopper() {
  const episode = source('existing-copper', 'Copper is an established global project.', '2026-01-01T00:00:00.000Z');
  return upsertEntity({ type: 'project', name: 'copper', evidenceEpisodeId: episode.id });
}

function entityState(entityId: number) {
  const db = openMemoryDb();
  return {
    entity: db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId),
    observations: db.prepare('SELECT * FROM entity_observations WHERE entity_id = ? ORDER BY episode_id').all(entityId),
    links: db.prepare('SELECT * FROM fact_entities WHERE entity_id = ? ORDER BY fact_id').all(entityId),
  };
}

test('direct local fact insert preserves existing global entity despite a contained canonical name', () => {
  const entityId = existingCopper();
  const before = entityState(entityId);
  const episode = source('local-insert', content, '2026-02-01T00:00:00.000Z');
  // Explicit stored scope wins even while the ambient settlement is global.
  const fact = withMemorySettledFor(EVERYWHERE, () => rememberFact({ kind: 'project', content,
    sessionId: 'entity-scope-fixture', scope: LOCAL,
    evidence: { episodeId: episode.id, excerpt: content } }));
  assert.equal(fact.active, true);
  assert.equal(fact.content, content);
  assert.deepEqual(factScope(fact.id), LOCAL);
  assert.ok(getFactEvidence(fact.id).some(row => row.episodeId === episode.id && row.excerpt === content));
  assert.deepEqual(entityState(entityId), before,
    'a scoped fact must not add an unscoped identity observation, link, or aggregate update');
});

test('direct local fact update preserves historical entity links without adding a new observation', () => {
  const entityId = existingCopper();
  const original = source('historical-global', content, '2026-02-01T00:00:00.000Z');
  const fact = rememberFact({ kind: 'project', content, scope: EVERYWHERE,
    evidence: { episodeId: original.id, excerpt: content } });
  assert.equal(entityState(entityId).links.length, 1, 'fixture starts with a genuine existing grounded link');
  assert.ok(moveFactToScope(fact.id, LOCAL));
  const before = entityState(entityId);
  const latest = source('local-update', content, '2026-03-01T00:00:00.000Z');
  const updated = withMemorySettledFor(EVERYWHERE, () => rememberFact({ kind: 'project', content,
    sessionId: 'entity-scope-fixture', scope: LOCAL,
    evidence: { episodeId: latest.id, excerpt: content } }));
  assert.equal(updated.id, fact.id, 'this exercises the existing-row update path');
  assert.equal(updated.active, true);
  assert.deepEqual(factScope(updated.id), LOCAL);
  assert.ok(getFactEvidence(updated.id).some(row => row.episodeId === latest.id && row.excerpt === content));
  assert.deepEqual(entityState(entityId), before,
    'local reinforcement retains historical links verbatim and does not observe the new source globally');
});

test('direct global fact still enriches a genuinely named existing entity under local ambient context', () => {
  const entityId = existingCopper();
  const before = entityState(entityId);
  const text = 'Copper is the owner\'s active global project.';
  const episode = source('global-control', text, '2026-02-01T00:00:00.000Z');
  const fact = withMemorySettledFor(LOCAL, () => rememberFact({ kind: 'project', content: text,
    sessionId: 'entity-scope-fixture', scope: EVERYWHERE,
    evidence: { episodeId: episode.id, excerpt: text } }));
  assert.deepEqual(factScope(fact.id), EVERYWHERE);
  const after = entityState(entityId);
  assert.equal(after.links.length, before.links.length + 1);
  assert.equal(after.observations.length, before.observations.length + 1);
  const entity = after.entity as { last_seen_at: string; mention_count: number };
  assert.equal(entity.last_seen_at, '2026-02-01T00:00:00.000Z');
  assert.equal(entity.mention_count, (before.entity as { mention_count: number }).mention_count + 1);
  assert.ok(getFactEvidence(fact.id).some(row => row.episodeId === episode.id));
});
