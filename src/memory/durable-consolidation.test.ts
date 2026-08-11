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
const { extractAutoMemoryCandidates } = await import('./auto-capture.js');
const { getFactEvidence } = await import('./temporal-memory.js');
const { readReflectionCandidateHealth } = await import('./reflection-candidates.js');
const { buildMemoryNeighborhood } = await import('../dashboard/memory-graph.js');
const { getFact, getFactAt } = await import('./facts.js');
const { stableContextGeneration } = await import('../runtime/stable-context-generation.js');

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

test('compound explicit memory queues only the isolated claim while retaining the exact source episode', async () => {
  const message = 'Remember this: Cedar is Cedar-17. Also give me three launch ideas. Just confirm.';
  const candidates = extractAutoMemoryCandidates(message);
  assert.deepEqual(candidates, [{
    kind: 'user',
    content: 'Cedar is Cedar-17.',
    reason: 'explicit remember request',
  }]);

  const queued = enqueueAutoCaptureCandidates({
    message,
    sessionId: 'chat-compound-memory-isolation',
    sourceEventId: 'turn:compound',
    occurredAt: '2026-08-09T01:00:00.000Z',
    candidates,
  });
  const db = openMemoryDb();
  const episode = db.prepare(`
    SELECT evidence_excerpt FROM memory_episodes WHERE id = ?
  `).get(queued.episodeId) as { evidence_excerpt: string };
  const candidate = db.prepare(`
    SELECT text FROM memory_reflection_candidates WHERE id = ?
  `).get(queued.candidateIds[0]) as { text: string };
  assert.equal(episode.evidence_excerpt, message, 'audit evidence keeps the complete conversational turn');
  assert.equal(candidate.text, 'Cedar is Cedar-17.', 'only the memory clause enters the durable replay queue');

  assert.equal((await drainDurableConsolidationCandidates({
    ids: queued.candidateIds,
    resolver: async () => ({ decision: 'ADD' as const }),
  })).promoted, 1);
  const fact = db.prepare(`
    SELECT content FROM consolidated_facts WHERE active = 1
  `).get() as { content: string };
  assert.equal(fact.content, 'Cedar is Cedar-17.', 'secondary live work cannot reach canonical memory');
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

test('explicit durable memory bumps the stable-context generation only after canonical commit', async () => {
  const startGeneration = stableContextGeneration();
  const implicit = enqueueAutoCaptureCandidates({
    message: 'My preferred launch color is orange.',
    sessionId: 'chat-stable-generation',
    sourceEventId: 'turn:implicit',
    candidates: [{
      kind: 'user',
      content: 'My preferred launch color is orange.',
      reason: 'durable first-person declarative',
    }],
  });
  assert.equal(stableContextGeneration(), startGeneration, 'durable enqueue alone never invalidates a canonical snapshot');
  assert.equal((await drainDurableConsolidationCandidates({
    ids: implicit.candidateIds,
    resolver: async () => ({ decision: 'ADD' as const }),
  })).promoted, 1);
  assert.equal(stableContextGeneration(), startGeneration, 'incidental reflection churn remains deferred');

  const remembered = enqueueAutoCaptureCandidates({
    message: 'Remember this: Cedar is Cedar-12.',
    sessionId: 'chat-stable-generation',
    sourceEventId: 'turn:remember',
    occurredAt: '2026-08-09T00:45:05.000Z',
    candidates: [{
      kind: 'user',
      content: 'Cedar is Cedar-12.',
      reason: 'explicit remember request',
    }],
  });
  assert.equal(stableContextGeneration(), startGeneration, 'explicit intake still waits for canonical commit');
  assert.equal((await drainDurableConsolidationCandidates({
    ids: remembered.candidateIds,
    resolver: async () => ({ decision: 'ADD' as const }),
  })).promoted, 1);
  assert.equal(stableContextGeneration(), startGeneration + 1, 'an explicit ADD invalidates every frozen stable prefix');

  const correction = enqueueAutoCaptureCandidates({
    message: 'Small correction for later: Cedar is Cedar-17. Cedar-12 is retired and must not be used as current.',
    sessionId: 'chat-stable-generation',
    sourceEventId: 'turn:correction',
    occurredAt: '2026-08-09T00:45:40.000Z',
    candidates: [{
      kind: 'user',
      content: 'Small correction for later: Cedar is Cedar-17. Cedar-12 is retired and must not be used as current.',
      reason: 'explicit durable correction',
    }],
  });
  assert.equal((await drainDurableConsolidationCandidates({
    ids: correction.candidateIds,
    resolver: async () => ({ decision: 'ADD' as const }),
  })).promoted, 1);
  assert.equal(stableContextGeneration(), startGeneration + 2, 'an explicit SUPERSEDE invalidates every frozen stable prefix');

  const redelivery = enqueueAutoCaptureCandidates({
    message: 'Small correction for later: Cedar is Cedar-17. Cedar-12 is retired and must not be used as current.',
    sessionId: 'chat-stable-generation',
    sourceEventId: 'turn:correction',
    occurredAt: '2026-08-09T00:45:40.000Z',
    candidates: [{
      kind: 'user',
      content: 'Small correction for later: Cedar is Cedar-17. Cedar-12 is retired and must not be used as current.',
      reason: 'explicit durable correction',
    }],
  });
  assert.deepEqual(redelivery.candidateIds, correction.candidateIds);
  assert.equal((await drainDurableConsolidationCandidates({ ids: redelivery.candidateIds })).selected, 0);
  assert.equal(stableContextGeneration(), startGeneration + 2, 'idempotent replay cannot churn the stable prefix');
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

test('an older overlapping capture cannot resurrect after a newer explicit cross-kind correction', async () => {
  const sessionId = 'chat-causal-correction';
  const stale = enqueueAutoCaptureCandidates({
    message: 'For later: my project access code is Zubrowka-7741.',
    sessionId,
    sourceEventId: 'turn:old',
    occurredAt: '2026-07-15T19:10:00.000Z',
    candidates: [{
      kind: 'project',
      content: 'For later: my project access code is Zubrowka-7741.',
      reason: 'explicit remember request',
      pin: true,
    }],
  });
  const correction = enqueueAutoCaptureCandidates({
    message: 'Correction — I gave you the wrong one. My project access code is actually Marzipan-9214. Zubrowka-7741 is stale, do not use it again.',
    sessionId,
    sourceEventId: 'turn:new',
    occurredAt: '2026-07-15T19:10:09.000Z',
    candidates: [{
      // The live classifier legitimately chose a different kind for the
      // correction. Causality cannot depend on that heuristic label matching.
      kind: 'user',
      content: 'Correction — I gave you the wrong one. My project access code is actually Marzipan-9214. Zubrowka-7741 is stale, do not use it again.',
      reason: 'durable first-person declarative',
    }],
  });

  let releaseOlder!: () => void;
  const holdOlder = new Promise<void>((resolve) => { releaseOlder = resolve; });
  let olderResolverStarted!: () => void;
  const olderStarted = new Promise<void>((resolve) => { olderResolverStarted = resolve; });
  const olderDrain = drainDurableConsolidationCandidates({
    ids: stale.candidateIds,
    resolver: async () => {
      olderResolverStarted();
      await holdOlder;
      return { decision: 'ADD' as const };
    },
  });

  await olderStarted;
  const newerDrain = await drainDurableConsolidationCandidates({
    ids: correction.candidateIds,
    resolver: async () => ({ decision: 'ADD' as const }),
  });
  assert.equal(newerDrain.promoted, 1, 'the newer source event commits while the older resolver is still in flight');
  releaseOlder();
  assert.equal((await olderDrain).promoted, 1, 'the older source evidence is preserved, not dropped');

  const rows = openMemoryDb().prepare(`
    SELECT id, content, active, pinned, valid_to, superseded_by_fact_id
    FROM consolidated_facts ORDER BY id ASC
  `).all() as Array<{
    id: number; content: string; active: number; pinned: number;
    valid_to: string | null; superseded_by_fact_id: number | null;
  }>;
  const staleFact = rows.find((row) => row.content.includes('Zubrowka-7741') && !row.content.includes('Marzipan-9214'));
  const correctedFact = rows.find((row) => row.content.includes('Marzipan-9214'));
  assert.ok(staleFact);
  assert.ok(correctedFact);
  assert.equal(staleFact.active, 0, 'finish order cannot make the causally older value current');
  assert.equal(staleFact.superseded_by_fact_id, correctedFact.id);
  assert.equal(staleFact.valid_to, '2026-07-15T19:10:09.000Z', 'the validity boundary is the correction source time');
  assert.equal(correctedFact.pinned, 1, 'a late stale pin transfers to the proven correction instead of disappearing');
  assert.equal(getFact(correctedFact.id)?.active, true);
  assert.ok(getFactAt(staleFact.id, '2026-07-15T19:10:05.000Z'), 'the older fact remains historically queryable');
  assert.equal(getFactAt(staleFact.id, '2026-07-15T19:10:10.000Z'), null, 'the stale fact is not valid after the correction');
});

test('a normal-order explicit cross-kind correction deterministically retires the quoted stale value', async () => {
  const sessionId = 'chat-cross-kind-correction';
  const stale = enqueueAutoCaptureCandidates({
    message: 'For later: my project access code is Zubrowka-7741.',
    sessionId,
    sourceEventId: 'turn:old',
    occurredAt: '2026-07-15T19:20:00.000Z',
    candidates: [{
      kind: 'project',
      content: 'For later: my project access code is Zubrowka-7741.',
      reason: 'explicit remember request',
    }],
  });
  assert.equal((await drainDurableConsolidationCandidates({
    ids: stale.candidateIds,
    resolver: async () => ({ decision: 'ADD' as const }),
  })).promoted, 1);

  const correction = enqueueAutoCaptureCandidates({
    message: 'Correction — I gave you the wrong one. My project access code is actually Marzipan-9214. Zubrowka-7741 is stale, do not use it again.',
    sessionId,
    sourceEventId: 'turn:new',
    occurredAt: '2026-07-15T19:20:09.000Z',
    candidates: [{
      kind: 'user',
      content: 'Correction — I gave you the wrong one. My project access code is actually Marzipan-9214. Zubrowka-7741 is stale, do not use it again.',
      reason: 'durable first-person declarative',
    }],
  });
  assert.equal((await drainDurableConsolidationCandidates({
    ids: correction.candidateIds,
    // A same-kind-only implementation would never surface the project row to
    // this resolver and would therefore leave both values active.
    resolver: async () => ({ decision: 'ADD' as const }),
  })).promoted, 1);

  const rows = openMemoryDb().prepare(`
    SELECT id, kind, content, active, valid_to, superseded_by_fact_id
    FROM consolidated_facts ORDER BY id
  `).all() as Array<{
    id: number; kind: string; content: string; active: number;
    valid_to: string | null; superseded_by_fact_id: number | null;
  }>;
  const staleFact = rows.find((row) => row.content.includes('Zubrowka-7741') && !row.content.includes('Marzipan-9214'));
  const correctedFact = rows.find((row) => row.content.includes('Marzipan-9214'));
  assert.ok(staleFact);
  assert.ok(correctedFact);
  assert.equal(staleFact.active, 0);
  assert.equal(staleFact.valid_to, '2026-07-15T19:20:09.000Z');
  assert.equal(staleFact.superseded_by_fact_id, correctedFact.id);
  assert.equal(correctedFact.active, 1);
  assert.equal(correctedFact.kind, 'project', 'the correction inherits the claim family it corrected');
});

test('a real future-reference correction survives admission and deterministically supersedes stale memory', async () => {
  const sessionId = 'chat-future-reference-correction';
  const staleMessage = "Please remember for later that Cedar's current release number is Cedar-12. A natural acknowledgement is enough.";
  const staleCandidates = extractAutoMemoryCandidates(staleMessage);
  assert.equal(staleCandidates.length, 1);
  const stale = enqueueAutoCaptureCandidates({
    message: staleMessage,
    sessionId,
    sourceEventId: 'turn:teach',
    occurredAt: '2026-08-09T00:45:05.000Z',
    candidates: staleCandidates,
  });
  assert.equal((await drainDurableConsolidationCandidates({
    ids: stale.candidateIds,
    resolver: async () => ({ decision: 'ADD' as const }),
  })).promoted, 1);

  const correctionMessage = "Small correction for later: Cedar's current release number is Cedar-17. Cedar-12 is retired and must not be used as current. A natural acknowledgement is enough.";
  const correctionContent = "Small correction for later: Cedar's current release number is Cedar-17. Cedar-12 is retired and must not be used as current.";
  const correctionCandidates = extractAutoMemoryCandidates(correctionMessage);
  assert.deepEqual(correctionCandidates, [{
    kind: 'user',
    content: correctionContent,
    reason: 'explicit durable correction',
  }]);
  const correction = enqueueAutoCaptureCandidates({
    message: correctionMessage,
    sessionId,
    sourceEventId: 'turn:correct',
    occurredAt: '2026-08-09T00:45:40.000Z',
    candidates: correctionCandidates,
  });
  let resolverCalls = 0;
  assert.equal((await drainDurableConsolidationCandidates({
    ids: correction.candidateIds,
    resolver: async () => {
      resolverCalls += 1;
      return { decision: 'ADD' as const };
    },
  })).promoted, 1);
  assert.equal(resolverCalls, 0, 'one evidence-backed correction uses the deterministic transition');

  const rows = openMemoryDb().prepare(`
    SELECT id, content, active, valid_to, superseded_by_fact_id
    FROM consolidated_facts ORDER BY id
  `).all() as Array<{
    id: number; content: string; active: number;
    valid_to: string | null; superseded_by_fact_id: number | null;
  }>;
  const staleFact = rows.find((row) => row.content.includes('Cedar-12') && !row.content.includes('Cedar-17'));
  const correctedFact = rows.find((row) => row.content.includes('Cedar-17'));
  assert.ok(staleFact);
  assert.ok(correctedFact);
  assert.equal(staleFact.active, 0);
  assert.equal(staleFact.valid_to, '2026-08-09T00:45:40.000Z');
  assert.equal(staleFact.superseded_by_fact_id, correctedFact.id);
  assert.equal(correctedFact.active, 1);
  assert.equal(correctedFact.content, correctionContent, 'the cue and both values remain canonical evidence without reply framing');
  assert.equal(rows.filter((row) => row.active === 1 && row.content.includes('Cedar')).length, 1);
  const correctionEpisode = openMemoryDb().prepare(`
    SELECT evidence_excerpt FROM memory_episodes WHERE id = ?
  `).get(correction.episodeId) as { evidence_excerpt: string };
  assert.equal(correctionEpisode.evidence_excerpt, correctionMessage, 'the exact correction turn remains durable source evidence');
  assert.ok(
    getFactEvidence(correctedFact.id).some((evidence) => evidence.episodeId === correction.episodeId),
    'the active correction links to its exact authoritative user-turn episode',
  );
});

test('a quoted retired identifier cannot cross conflicting claim subjects', async () => {
  const stale = enqueueAutoCaptureCandidates({
    message: "Bob's Project Atlas access code is Zubrowka-7741.",
    sessionId: 'chat-cross-kind-subject-scope',
    sourceEventId: 'turn:bob',
    occurredAt: '2026-07-15T19:30:00.000Z',
    candidates: [{
      kind: 'project',
      content: "Bob's Project Atlas access code is Zubrowka-7741.",
      reason: 'durable first-person declarative',
    }],
  });
  assert.equal((await drainDurableConsolidationCandidates({
    ids: stale.candidateIds,
    resolver: async () => ({ decision: 'ADD' as const }),
  })).promoted, 1);

  const correction = enqueueAutoCaptureCandidates({
    message: "Correction: Alice's Project Atlas access code is Marzipan-9214. Zubrowka-7741 is stale.",
    sessionId: 'chat-cross-kind-subject-scope',
    sourceEventId: 'turn:alice',
    occurredAt: '2026-07-15T19:31:00.000Z',
    candidates: [{
      kind: 'user',
      content: "Correction: Alice's Project Atlas access code is Marzipan-9214. Zubrowka-7741 is stale.",
      reason: 'durable first-person declarative',
    }],
  });
  assert.equal((await drainDurableConsolidationCandidates({
    ids: correction.candidateIds,
    resolver: async () => ({ decision: 'ADD' as const }),
  })).promoted, 1);

  const active = openMemoryDb().prepare(`
    SELECT kind, content FROM consolidated_facts WHERE active = 1 ORDER BY id
  `).all() as Array<{ kind: string; content: string }>;
  assert.equal(active.length, 2, 'a shared old identifier does not merge different people');
  assert.ok(active.some((row) => row.content.includes("Bob's Project Atlas access code")));
  assert.ok(active.some((row) => row.kind === 'user' && row.content.includes("Alice's Project Atlas access code")));
});

test('a split identifier alone is not enough to prove an otherwise unanchored correction relation', async () => {
  const stale = enqueueAutoCaptureCandidates({
    message: 'The Foxtrot server access code is Zubrowka-7741.',
    sessionId: 'chat-cross-kind-identifier-scope',
    sourceEventId: 'turn:foxtrot',
    occurredAt: '2026-07-15T19:35:00.000Z',
    candidates: [{
      kind: 'project',
      content: 'The Foxtrot server access code is Zubrowka-7741.',
      reason: 'durable declarative',
    }],
  });
  assert.equal((await drainDurableConsolidationCandidates({
    ids: stale.candidateIds,
    resolver: async () => ({ decision: 'ADD' as const }),
  })).promoted, 1);

  const correction = enqueueAutoCaptureCandidates({
    message: 'Correction: the Echo database access code is Marzipan-9214. Zubrowka-7741 is stale.',
    sessionId: 'chat-cross-kind-identifier-scope',
    sourceEventId: 'turn:echo',
    occurredAt: '2026-07-15T19:36:00.000Z',
    candidates: [{
      kind: 'user',
      content: 'Correction: the Echo database access code is Marzipan-9214. Zubrowka-7741 is stale.',
      reason: 'durable declarative',
    }],
  });
  assert.equal((await drainDurableConsolidationCandidates({
    ids: correction.candidateIds,
    resolver: async () => ({ decision: 'ADD' as const }),
  })).promoted, 1);

  const active = openMemoryDb().prepare(`
    SELECT kind, content FROM consolidated_facts WHERE active = 1 ORDER BY id
  `).all() as Array<{ kind: string; content: string }>;
  assert.equal(active.length, 2, 'identifier-only overlap falls through instead of guessing');
  assert.ok(active.some((row) => row.content.includes('Foxtrot server')));
  assert.ok(active.some((row) => row.kind === 'user' && row.content.includes('Echo database')));
});

test('a correction rechecks older targets after its resolver wait before committing', async () => {
  const sessionId = 'chat-causal-correction-opposite';
  const correction = enqueueAutoCaptureCandidates({
    message: 'Correction — I gave you the wrong one. My project access code is actually Marzipan-9214. Zubrowka-7741 is stale, do not use it again.',
    sessionId,
    sourceEventId: 'turn:new',
    occurredAt: '2026-07-15T19:40:09.000Z',
    candidates: [{
      kind: 'user',
      content: 'Correction — I gave you the wrong one. My project access code is actually Marzipan-9214. Zubrowka-7741 is stale, do not use it again.',
      reason: 'durable first-person declarative',
    }],
  });
  const stale = enqueueAutoCaptureCandidates({
    message: 'For later: my project access code is Zubrowka-7741.',
    sessionId,
    sourceEventId: 'turn:old',
    occurredAt: '2026-07-15T19:40:00.000Z',
    candidates: [{
      kind: 'project',
      content: 'For later: my project access code is Zubrowka-7741.',
      reason: 'explicit remember request',
      pin: true,
    }],
  });

  let releaseCorrection!: () => void;
  const holdCorrection = new Promise<void>((resolve) => { releaseCorrection = resolve; });
  let correctionResolverStarted!: () => void;
  const correctionStarted = new Promise<void>((resolve) => { correctionResolverStarted = resolve; });
  const correctionDrain = drainDurableConsolidationCandidates({
    ids: correction.candidateIds,
    resolver: async () => {
      correctionResolverStarted();
      await holdCorrection;
      return { decision: 'ADD' as const };
    },
  });

  await correctionStarted;
  assert.equal((await drainDurableConsolidationCandidates({
    ids: stale.candidateIds,
    resolver: async () => ({ decision: 'ADD' as const }),
  })).promoted, 1, 'the older source commits while the newer resolver is waiting');
  releaseCorrection();
  assert.equal((await correctionDrain).promoted, 1);

  const rows = openMemoryDb().prepare(`
    SELECT id, kind, content, active, pinned, valid_to, superseded_by_fact_id
    FROM consolidated_facts ORDER BY id ASC
  `).all() as Array<{
    id: number; kind: string; content: string; active: number; pinned: number;
    valid_to: string | null; superseded_by_fact_id: number | null;
  }>;
  const staleFact = rows.find((row) => row.content.includes('Zubrowka-7741') && !row.content.includes('Marzipan-9214'));
  const correctedFact = rows.find((row) => row.content.includes('Marzipan-9214'));
  assert.ok(staleFact);
  assert.ok(correctedFact);
  assert.equal(staleFact.active, 0, 'the resolver interleaving cannot leave the older value current');
  assert.equal(staleFact.valid_to, '2026-07-15T19:40:09.000Z');
  assert.equal(staleFact.superseded_by_fact_id, correctedFact.id);
  assert.equal(correctedFact.active, 1);
  assert.equal(correctedFact.kind, 'project', 'the correction still inherits the corrected claim family');
  assert.equal(correctedFact.pinned, 1, 'the standing pin transfers at the final commit boundary');
  assert.ok(getFactAt(staleFact.id, '2026-07-15T19:40:05.000Z'));
  assert.equal(getFactAt(staleFact.id, '2026-07-15T19:40:10.000Z'), null);
});

test('an explicit correction does not collapse an unrelated cross-kind fact', async () => {
  const unrelated = enqueueAutoCaptureCandidates({
    message: 'Project Atlas launch owner is Marina.',
    sessionId: 'chat-cross-kind-scope',
    sourceEventId: 'turn:atlas',
    occurredAt: '2026-07-15T20:00:00.000Z',
    candidates: [{
      kind: 'project',
      content: 'Project Atlas launch owner is Marina.',
      reason: 'durable first-person declarative',
    }],
  });
  assert.equal((await drainDurableConsolidationCandidates({
    ids: unrelated.candidateIds,
    resolver: async () => ({ decision: 'ADD' as const }),
  })).promoted, 1);

  const correction = enqueueAutoCaptureCandidates({
    message: 'Correction: Project Beacon launch owner is Theo; the prior value was wrong.',
    sessionId: 'chat-cross-kind-scope',
    sourceEventId: 'turn:beacon',
    occurredAt: '2026-07-15T20:01:00.000Z',
    candidates: [{
      kind: 'user',
      content: 'Correction: Project Beacon launch owner is Theo; the prior value was wrong.',
      reason: 'durable first-person declarative',
    }],
  });
  assert.equal((await drainDurableConsolidationCandidates({
    ids: correction.candidateIds,
    resolver: async () => ({ decision: 'ADD' as const }),
  })).promoted, 1);

  const active = openMemoryDb().prepare(`
    SELECT content FROM consolidated_facts WHERE active = 1 ORDER BY id
  `).all() as Array<{ content: string }>;
  assert.equal(active.length, 2);
  assert.ok(active.some((row) => row.content.includes('Project Atlas')));
  assert.ok(active.some((row) => row.content.includes('Project Beacon')));
});
