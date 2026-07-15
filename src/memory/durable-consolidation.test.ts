import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-durable-consolidation';
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.CLEMMY_EMBED_AT_WRITE = 'off';
delete process.env.OPENAI_API_KEY;

const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const {
  drainDurableConsolidationCandidates,
  enqueueAutoCaptureCandidates,
} = await import('./durable-consolidation.js');
const { getFactEvidence } = await import('./temporal-memory.js');
const { readReflectionCandidateHealth } = await import('./reflection-candidates.js');
const { buildMemoryNeighborhood } = await import('../dashboard/memory-graph.js');

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => { resetMemoryDb(); });

test('auto capture durably records the exact source and replay payload before consolidation', () => {
  const queued = enqueueAutoCaptureCandidates({
    message: 'My preferred contract reviewer is Sarah Chen.',
    sessionId: 'chat-intake',
    sourceEventId: 'turn:7',
    occurredAt: '2026-07-15T17:00:00.000Z',
    candidates: [{
      kind: 'user',
      content: 'My preferred contract reviewer is Sarah Chen.',
      reason: 'durable first-person declarative',
    }],
  });

  assert.ok(queued.episodeId);
  assert.equal(queued.candidateIds.length, 1);
  const db = openMemoryDb();
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM consolidated_facts').get() as { count: number }).count, 0);
  const candidate = db.prepare(`
    SELECT status, source_type, intake_reason, attempt_count
    FROM memory_reflection_candidates WHERE id = ?
  `).get(queued.candidateIds[0]) as {
    status: string; source_type: string; intake_reason: string; attempt_count: number;
  };
  assert.deepEqual(candidate, {
    status: 'pending',
    source_type: 'auto_capture',
    intake_reason: 'durable first-person declarative',
    attempt_count: 0,
  });
  const episode = db.prepare(`
    SELECT evidence_excerpt, subtype, source_uri FROM memory_episodes WHERE id = ?
  `).get(queued.episodeId) as { evidence_excerpt: string; subtype: string; source_uri: string };
  assert.equal(episode.evidence_excerpt, 'My preferred contract reviewer is Sarah Chen.');
  assert.equal(episode.subtype, 'auto_capture');
  assert.match(episode.source_uri, /^conversation:\/\//);
  assert.equal(readReflectionCandidateHealth().orphanedPending, 0, 'episode-backed queued work is not orphaned');
});

test('maintenance replay promotes one canonical fact with the original user-turn evidence', async () => {
  const queued = enqueueAutoCaptureCandidates({
    message: 'My preferred contract reviewer is Sarah Chen.',
    sessionId: 'chat-replay',
    sourceEventId: 'turn:3',
    occurredAt: '2026-07-15T18:00:00.000Z',
    candidates: [{
      kind: 'user',
      content: 'My preferred contract reviewer is Sarah Chen.',
      reason: 'durable first-person declarative',
    }],
  });

  const replay = await drainDurableConsolidationCandidates({ ids: queued.candidateIds });
  assert.equal(replay.promoted, 1);
  const db = openMemoryDb();
  const candidate = db.prepare(`
    SELECT status, reason, resulting_fact_id FROM memory_reflection_candidates WHERE id = ?
  `).get(queued.candidateIds[0]) as { status: string; reason: string; resulting_fact_id: number };
  assert.equal(candidate.status, 'promoted');
  assert.equal(candidate.reason, 'consolidation:add;people_observed=1;person_links=1;person_failures=0');
  const evidence = getFactEvidence(candidate.resulting_fact_id);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.episodeId, queued.episodeId);
  assert.equal(evidence[0]?.excerpt, 'My preferred contract reviewer is Sarah Chen.');
  const person = db.prepare("SELECT id FROM entities WHERE entity_type = 'person'").get() as { id: number };
  assert.ok(person.id);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM entities WHERE entity_type = 'person'").get() as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM entity_observations WHERE episode_id = ?').get(queued.episodeId) as { count: number }).count, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM fact_entities WHERE fact_id = ? AND link_type = 'extracted'").get(candidate.resulting_fact_id) as { count: number }).count, 1);

  const neighborhood = buildMemoryNeighborhood(db, `entity:${person.id}`, 1);
  assert.ok(neighborhood.nodes.some((node) => node.id === `fact:${candidate.resulting_fact_id}`));
  assert.ok(neighborhood.nodes.some((node) => node.id === `episode:${queued.episodeId}`));
  assert.ok(neighborhood.edges.some((edge) => (
    edge.source === `fact:${candidate.resulting_fact_id}`
    && edge.target === `entity:${person.id}`
    && edge.type === 'entity'
    && edge.truth === 'stored'
  )));
  assert.ok(neighborhood.edges.some((edge) => (
    edge.source === `entity:${person.id}`
    && edge.target === `episode:${queued.episodeId}`
    && edge.type === 'observed'
    && edge.truth === 'stored'
  )));
  assert.ok(neighborhood.edges.every((edge) => edge.truth === 'stored'));
});

test('redelivery and worker replay are idempotent at both candidate and fact layers', async () => {
  const input = {
    message: 'We use Outlook for client calendar work.',
    sessionId: 'chat-idempotent',
    sourceEventId: 'turn:11',
    candidates: [{
      kind: 'reference' as const,
      content: 'Connected-app context: We use Outlook for client calendar work.',
      reason: 'connected app access or setup signal',
    }],
  };
  const first = enqueueAutoCaptureCandidates(input);
  assert.equal((await drainDurableConsolidationCandidates({ ids: first.candidateIds })).promoted, 1);
  const redelivery = enqueueAutoCaptureCandidates(input);
  assert.deepEqual(redelivery.candidateIds, first.candidateIds);
  assert.equal((await drainDurableConsolidationCandidates({ ids: redelivery.candidateIds })).selected, 0);
  const db = openMemoryDb();
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM memory_reflection_candidates').get() as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM consolidated_facts').get() as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM fact_evidence').get() as { count: number }).count, 1);
});

test('a failed immediate resolver remains visible and succeeds on bounded replay', async () => {
  const queued = enqueueAutoCaptureCandidates({
    message: 'I prefer weekly summaries on Friday afternoons.',
    sessionId: 'chat-retry',
    sourceEventId: 'turn:4',
    candidates: [{
      kind: 'user',
      content: 'I prefer weekly summaries on Friday afternoons.',
      reason: 'explicit user preference or feedback',
    }],
  });
  const failed = await drainDurableConsolidationCandidates({
    ids: queued.candidateIds,
    now: '2026-07-15T19:00:00.000Z',
    resolver: async () => { throw new Error('temporary resolver outage'); },
  });
  assert.equal(failed.retried, 1);
  let row = openMemoryDb().prepare(`
    SELECT status, attempt_count, last_error, next_attempt_at
    FROM memory_reflection_candidates WHERE id = ?
  `).get(queued.candidateIds[0]) as {
    status: string; attempt_count: number; last_error: string; next_attempt_at: string;
  };
  assert.equal(row.status, 'pending');
  assert.equal(row.attempt_count, 1);
  assert.match(row.last_error, /temporary resolver outage/);
  assert.equal(row.next_attempt_at, '2026-07-15T19:00:15.000Z');
  assert.equal(readReflectionCandidateHealth().failedPending, 1);

  const recovered = await drainDurableConsolidationCandidates({
    ids: queued.candidateIds,
    now: '2026-07-15T19:00:16.000Z',
    resolver: async () => ({ decision: 'ADD' as const }),
  });
  assert.equal(recovered.promoted, 1);
  row = openMemoryDb().prepare(`
    SELECT status, attempt_count, last_error, next_attempt_at
    FROM memory_reflection_candidates WHERE id = ?
  `).get(queued.candidateIds[0]) as typeof row;
  assert.equal(row.status, 'promoted');
  assert.equal(row.attempt_count, 2);
  assert.equal(row.last_error, null);
  assert.equal(row.next_attempt_at, null);
});
