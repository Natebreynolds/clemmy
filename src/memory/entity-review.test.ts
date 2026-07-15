import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-entity-review';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { resetMemoryDb, openMemoryDb } = await import('./db.js');
const {
  dismissEntityDuplicateCandidate,
  listEntityDuplicateCandidates,
  restoreDismissedEntityDuplicateCandidates,
} = await import('./entity-review.js');

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

beforeEach(() => resetMemoryDb());

function insertEntity(type: 'person' | 'company', name: string, mentions = 1): number {
  const now = '2026-07-15T00:00:00.000Z';
  return Number(openMemoryDb().prepare(`
    INSERT INTO entities
      (entity_type, canonical_name, canonical_name_lc, aliases_json, first_seen_at, last_seen_at, mention_count)
    VALUES (?, ?, ?, '[]', ?, ?, ?)
  `).run(type, name, name.toLowerCase(), now, now, mentions).lastInsertRowid);
}

function addAlias(entityId: number, alias: string): void {
  const now = '2026-07-15T00:00:00.000Z';
  openMemoryDb().prepare(`
    INSERT INTO entity_aliases
      (entity_id, alias, alias_lc, confidence, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, 0.9, ?, ?)
  `).run(entityId, alias, alias.toLowerCase(), now, now);
}

function addEmail(entityId: number, email: string): void {
  const now = '2026-07-15T00:00:00.000Z';
  openMemoryDb().prepare(`
    INSERT INTO entity_identifiers
      (entity_id, scheme, value, value_norm, confidence, first_seen_at, last_seen_at)
    VALUES (?, 'email', ?, ?, 0.95, ?, ?)
  `).run(entityId, email, email.toLowerCase(), now, now);
}

test('punctuation-equivalent canonical names form a review-only cluster with a suggested canonical record', () => {
  const canonical = insertEntity('person', 'Nathan Reynolds', 100);
  const duplicate = insertEntity('person', 'nathan.reynolds', 1);
  const crossType = insertEntity('company', 'Nathan Reynolds', 50);

  const result = listEntityDuplicateCandidates({ type: 'person' });
  assert.equal(result.total, 1);
  assert.deepEqual(new Set(result.candidates[0].entities.map((entity) => entity.id)), new Set([canonical, duplicate]));
  assert.equal(result.candidates[0].suggestedCanonicalId, canonical);
  assert.equal(result.candidates[0].confidence, 'high');
  assert.ok(result.candidates[0].matches.some((match) => match.basis === 'canonical_equivalent'));
  assert.ok(!result.candidates[0].entities.some((entity) => entity.id === crossType), 'cross-type collisions are never merge candidates');
  assert.match(result.candidates[0].cautions.join(' '), /No shared stable identifier/i);
});

test('canonical aliases and cautious nickname variants connect historical person rows', () => {
  const nathan = insertEntity('person', 'Nathan Reynolds', 20);
  const nate = insertEntity('person', 'Nate Reynolds', 4);
  const nateMiddle = insertEntity('person', 'Nate B Reynolds', 1);
  addAlias(nathan, 'Nate Reynolds');
  const michael = insertEntity('person', 'Michael Nadimi', 3);
  const mike = insertEntity('person', 'Mike Nadimi', 2);
  insertEntity('person', 'Morgan Nadimi', 10);

  const result = listEntityDuplicateCandidates({ type: 'person' });
  const reynolds = result.candidates.find((candidate) => candidate.entities.some((entity) => entity.id === nathan));
  assert.ok(reynolds);
  assert.deepEqual(new Set(reynolds!.entities.map((entity) => entity.id)), new Set([nathan, nate, nateMiddle]));
  assert.ok(reynolds!.matches.some((match) => match.basis === 'canonical_alias'));
  assert.ok(reynolds!.matches.some((match) => match.basis === 'person_name_variant' || match.basis === 'person_nickname'));

  const nadimi = result.candidates.find((candidate) => candidate.entities.some((entity) => entity.id === michael));
  assert.ok(nadimi);
  assert.deepEqual(new Set(nadimi!.entities.map((entity) => entity.id)), new Set([michael, mike]));
  assert.ok(nadimi!.matches.some((match) => match.basis === 'person_nickname'));
  assert.ok(!nadimi!.entities.some((entity) => entity.name === 'Morgan Nadimi'));
});

test('shared identifiers strengthen review evidence while conflicting emails remain an explicit caution', () => {
  const first = insertEntity('person', 'Dana Smith', 3);
  const second = insertEntity('person', 'D. Smith', 2);
  addAlias(second, 'Dana Smith');
  addEmail(first, 'dana@work.example');
  addEmail(second, 'dana@personal.example');

  let candidate = listEntityDuplicateCandidates({ type: 'person' }).candidates[0];
  assert.ok(candidate);
  assert.match(candidate.cautions.join(' '), /different email addresses/i);

  addEmail(second, 'dana@work.example');
  candidate = listEntityDuplicateCandidates({ type: 'person' }).candidates[0];
  assert.ok(candidate.matches.some((match) => match.basis === 'shared_identifier' && match.score === 0.99));
});

test('dismissed candidate groups stay hidden across reads and can be restored without changing identities', () => {
  const canonical = insertEntity('person', 'Nathan Reynolds', 10);
  const duplicate = insertEntity('person', 'nathan.reynolds', 1);
  assert.equal(listEntityDuplicateCandidates({ type: 'person' }).total, 1);

  assert.equal(dismissEntityDuplicateCandidate([duplicate, canonical], 'reviewed as different people'), 1);
  const hidden = listEntityDuplicateCandidates({ type: 'person' });
  assert.equal(hidden.total, 0);
  assert.equal(hidden.dismissedCount, 1);
  assert.equal((openMemoryDb().prepare('SELECT COUNT(*) AS count FROM entity_redirects').get() as { count: number }).count, 0);

  assert.equal(restoreDismissedEntityDuplicateCandidates(), 1);
  assert.equal(listEntityDuplicateCandidates({ type: 'person' }).total, 1);
});
