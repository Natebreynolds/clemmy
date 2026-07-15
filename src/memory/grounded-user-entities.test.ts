import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-grounded-user-entities';
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const { rememberFact } = await import('./facts.js');
const { recordMemoryEpisode } = await import('./temporal-memory.js');
const { extractGroundedUserPeople, attachGroundedUserPeople } = await import('./grounded-user-entities.js');

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => { resetMemoryDb(); });

test('extracts only explicitly related people, not capitalized projects or companies', () => {
  assert.deepEqual(
    extractGroundedUserPeople('My CFO is Dana Wilson and my contract reviewer is Sarah Chen.'),
    [
      { name: 'Dana Wilson', identifiers: [], confidence: 0.92, grounding: 'possessive_role' },
      { name: 'Sarah Chen', identifiers: [], confidence: 0.92, grounding: 'possessive_role' },
    ],
  );
  assert.deepEqual(extractGroundedUserPeople('Jordan Lee is my attorney.'), [
    { name: 'Jordan Lee', identifiers: [], confidence: 0.92, grounding: 'reverse_role' },
  ]);
  assert.deepEqual(extractGroundedUserPeople('I work with Priya Nair on Atlas.'), [
    { name: 'Priya Nair', identifiers: [], confidence: 0.92, grounding: 'durable_collaboration' },
  ]);
  assert.deepEqual(extractGroundedUserPeople('My project is Northstar Launch.'), []);
  assert.deepEqual(extractGroundedUserPeople('My client is Acme Corporation.'), []);
  assert.deepEqual(extractGroundedUserPeople('Speaker 3 joined with Guest User.'), []);
});
test('a literally associated personal email becomes a strong identity key', () => {
  const people = extractGroundedUserPeople('My CFO is Dana Wilson (dana.wilson@acme.example).');
  assert.equal(people.length, 1);
  assert.equal(people[0]?.name, 'Dana Wilson');
  assert.deepEqual(people[0]?.identifiers, [
    { scheme: 'email', value: 'dana.wilson@acme.example', confidence: 0.98 },
  ]);
  assert.equal(people[0]?.confidence, 0.98);
});

test('grounded user people create exact replay-safe episode and fact links', () => {
  const source = 'My CFO is Dana Wilson (dana.wilson@acme.example).';
  const episode = recordMemoryEpisode({
    kind: 'user_turn', sessionId: 'people-chat', callId: 'turn:1',
    sourceUri: 'conversation://people-chat/turn:1', content: source,
  });
  const fact = rememberFact({
    kind: 'user', content: source,
    evidence: { episodeId: episode.id, excerpt: source, sourceUri: episode.source_uri },
  });
  const first = attachGroundedUserPeople({
    factId: fact.id, episodeId: episode.id, sourceText: source, sourceUri: episode.source_uri,
  });
  const replay = attachGroundedUserPeople({
    factId: fact.id, episodeId: episode.id, sourceText: source, sourceUri: episode.source_uri,
  });
  assert.equal(first.observed, 1);
  assert.equal(first.linked, 1);
  assert.deepEqual(replay.entityIds, first.entityIds);
  const db = openMemoryDb();
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM entities WHERE entity_type = 'person'").get() as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT mention_count FROM entities WHERE id = ?').get(first.entityIds[0]) as { mention_count: number }).mention_count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM entity_observations').get() as { count: number }).count, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM fact_entities WHERE fact_id = ? AND link_type = 'extracted'").get(fact.id) as { count: number }).count, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM entity_identifiers WHERE scheme = 'email' AND value_norm = 'dana.wilson@acme.example'").get() as { count: number }).count, 1);
});

test('an observed person is not linked to a resolver rewrite that no longer names them', () => {
  const source = 'My contract reviewer is Sarah Chen.';
  const episode = recordMemoryEpisode({ kind: 'user_turn', content: source });
  const fact = rememberFact({ kind: 'user', content: 'The contract review workflow has an assigned reviewer.' });
  const attached = attachGroundedUserPeople({ factId: fact.id, episodeId: episode.id, sourceText: source });
  assert.equal(attached.observed, 1, 'the source episode truthfully observed Sarah');
  assert.equal(attached.linked, 0, 'the rewritten fact does not claim Sarah by name');
  const db = openMemoryDb();
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM entity_observations').get() as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM fact_entities').get() as { count: number }).count, 0);
});
