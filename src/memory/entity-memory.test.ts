import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-entity-memory-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resetMemoryDb, openMemoryDb } = await import('./db.js');
const { rememberFact } = await import('./facts.js');
const { recordMemoryEpisode, linkFactEvidence } = await import('./temporal-memory.js');
const { upsertEntity, mergeEntities } = await import('./entity-identity.js');
const {
  addFactEntityLinks,
  recordGroundedEntityRelationship,
  syncFactEntityLinks,
} = await import('./relations.js');
const { getEntityMemoryDetail } = await import('./entity-memory.js');

test('entity memory detail includes only grounded claims with durable evidence', () => {
  resetMemoryDb();
  const sourceText = 'The directory confirms Dana Smith leads Acme.';
  const episode = recordMemoryEpisode({
    kind: 'tool_result',
    sessionId: 'entity-detail-session',
    callId: 'entity-detail-call',
    occurredAt: '2026-07-10T15:00:00.000Z',
    sourceUri: 'directory://people/dana-smith',
    title: 'Company directory',
    content: sourceText,
  });
  const dana = upsertEntity({
    type: 'person', name: 'Dana Smith', aliases: ['Dana'],
    identifiers: [{ scheme: 'email', value: 'dana@acme.example' }],
    evidenceEpisodeId: episode.id, sourceUri: 'directory://people/dana-smith',
  });
  const acme = upsertEntity({
    type: 'company', name: 'Acme', evidenceEpisodeId: episode.id,
    sourceUri: 'directory://people/dana-smith',
  });
  const grounded = rememberFact({
    kind: 'project', content: 'Dana Smith leads Acme.',
    derivedFrom: { sessionId: 'entity-detail-session', callId: 'entity-detail-call', tool: 'directory_lookup' },
  });
  linkFactEvidence({
    factId: grounded.id, episodeId: episode.id,
    excerpt: 'Dana Smith leads Acme.', sourceUri: 'directory://people/dana-smith',
  });
  addFactEntityLinks(grounded.id, [dana, acme], {
    linkType: 'extracted', confidence: 0.97, evidenceEpisodeId: episode.id,
    evidenceExcerpt: 'Dana Smith leads Acme.',
  });
  const inferredOnly = rememberFact({
    kind: 'project', content: 'Dana Smith was merely mentioned beside Beta.',
    derivedFrom: { sessionId: 'other-session', callId: 'other-call', tool: 'directory_lookup' },
  });
  syncFactEntityLinks();
  recordGroundedEntityRelationship({
    subjectId: dana, predicate: 'leads', objectId: acme,
    evidenceEpisodeId: episode.id, evidenceExcerpt: 'Dana Smith leads Acme',
    sourceText, sourceFactId: grounded.id, confidence: 0.97,
    validFrom: '2026-07-10T15:00:00.000Z',
  });

  const detail = getEntityMemoryDetail(dana, { asOf: '2026-07-15T00:00:00.000Z' });
  assert.equal(detail.entity.canonicalName, 'Dana Smith');
  assert.deepEqual(detail.claims.map((claim) => claim.factId), [grounded.id]);
  assert.ok(!detail.claims.some((claim) => claim.factId === inferredOnly.id));
  assert.equal(detail.claims[0]?.evidence[0]?.excerpt, 'Dana Smith leads Acme.');
  assert.equal(detail.relationships.length, 1);
  assert.equal(detail.relationships[0]?.current, true);
  assert.equal(detail.relationships[0]?.otherEntity.canonicalName, 'Acme');
  assert.equal(detail.relationships[0]?.evidence[0]?.excerpt, 'Dana Smith leads Acme');
  assert.equal(detail.episodes.length, 1, 'the same episode is one observation despite multiple extraction paths');
  assert.equal(detail.stats.sourceEpisodes, 1);
  assert.equal(detail.entity.identifiers[0]?.value, 'dana@acme.example');
});

test('entity detail retains historical relationships and evaluates them as-of time', () => {
  resetMemoryDb();
  const sourceText = 'Dana Smith advises Legacy Co.';
  const episode = recordMemoryEpisode({
    kind: 'tool_result', sessionId: 'entity-history-session', callId: 'entity-history-call',
    occurredAt: '2020-01-01T00:00:00.000Z', content: sourceText,
  });
  const dana = upsertEntity({ type: 'person', name: 'Dana Smith', evidenceEpisodeId: episode.id });
  const legacy = upsertEntity({ type: 'company', name: 'Legacy Co', evidenceEpisodeId: episode.id });
  recordGroundedEntityRelationship({
    subjectId: dana, predicate: 'advises', objectId: legacy,
    evidenceEpisodeId: episode.id, evidenceExcerpt: 'Dana Smith advises Legacy Co',
    sourceText, validFrom: '2020-01-01T00:00:00.000Z', validTo: '2021-01-01T00:00:00.000Z',
  });

  assert.equal(getEntityMemoryDetail(dana, { asOf: '2020-06-01T00:00:00.000Z' }).relationships[0]?.current, true);
  const present = getEntityMemoryDetail(dana, { asOf: '2026-07-15T00:00:00.000Z' });
  assert.equal(present.relationships[0]?.current, false);
  assert.equal(present.stats.currentRelationships, 0);
  assert.equal(present.relationships[0]?.validityIntervals[0]?.validTo, '2021-01-01T00:00:00.000Z');
});

test('entity detail flags source-backed one-off requests instead of presenting them as accepted identity knowledge', () => {
  resetMemoryDb();
  const episode = recordMemoryEpisode({
    kind: 'user_turn', sessionId: 'entity-quality-session', callId: 'entity-quality-call',
    occurredAt: '2026-07-11T00:00:00.000Z', content: 'Quick task: analyze one client and email me the result.',
  });
  const person = upsertEntity({ type: 'person', name: 'Alexander Chen', evidenceEpisodeId: episode.id });
  const request = rememberFact({
    kind: 'user', content: 'Quick task: analyze one client and email me the result.',
    sessionId: 'entity-quality-session',
  });
  linkFactEvidence({ factId: request.id, episodeId: episode.id, excerpt: 'Quick task: analyze one client and email me the result.' });
  addFactEntityLinks(request.id, [person], {
    linkType: 'extracted', evidenceEpisodeId: episode.id,
    evidenceExcerpt: 'Quick task: analyze one client and email me the result.',
  });

  const detail = getEntityMemoryDetail(person);
  assert.equal(detail.claims[0]?.quality, 'needs_review');
  assert.match(detail.claims[0]?.reviewReason ?? '', /one-time command/i);
  assert.equal(detail.stats.groundedClaims, 1, 'the stored association remains truthfully visible');
  assert.equal(detail.stats.currentClaims, 0, 'review candidates do not count as accepted current knowledge');
  assert.equal(detail.stats.reviewClaims, 1);
});

test('merging identities unions source episodes without inflating mentions', () => {
  resetMemoryDb();
  const episode = recordMemoryEpisode({
    kind: 'tool_result', sessionId: 'entity-merge-session', callId: 'entity-merge-call',
    occurredAt: '2026-07-12T12:00:00.000Z', content: 'Dana Smith, also listed as D. Smith.',
  });
  const canonical = upsertEntity({
    type: 'person', name: 'Dana Smith',
    identifiers: [{ scheme: 'email', value: 'dana.one@example.test' }],
    evidenceEpisodeId: episode.id,
  });
  const duplicate = upsertEntity({
    type: 'person', name: 'D. Smith',
    identifiers: [{ scheme: 'email', value: 'dana.two@example.test' }],
    evidenceEpisodeId: episode.id,
  });
  assert.notEqual(canonical, duplicate);
  mergeEntities({ sourceEntityId: duplicate, canonicalEntityId: canonical, reason: 'reviewed duplicate' });

  const detail = getEntityMemoryDetail(duplicate);
  assert.equal(detail.identity.canonicalId, canonical);
  assert.equal(detail.identity.redirectedFrom[0]?.id, duplicate);
  assert.equal(detail.episodes.length, 1);
  assert.equal(detail.entity.legacyMentionCount, 1, 'overlapping episode is not summed as a second mention');
  assert.equal((openMemoryDb().prepare('SELECT COUNT(*) AS count FROM entity_observations WHERE entity_id = ?').get(canonical) as { count: number }).count, 1);
});
