/**
 * Run: npx tsx --test src/memory/reflection.test.ts
 *
 * Tests for the Phase 1 brain-architecture reflection layer:
 *   - DB layer: entity upsert + episodic pointer storage round-trip
 *   - facts: rememberFact populates derived_from_* fields, trust_level
 *     defaults to 0.6 for derived / 1.0 for direct, listRecentlyLearnedFacts
 *     returns only derived facts ordered by extracted_at DESC
 *   - reflection: scheduleReflection swallows extractor failures so it
 *     never throws from the hook caller; threshold gate short-circuits
 *     tiny outputs
 *
 * Does NOT call the real summarizer model. The extractor path is mocked
 * via CLEMMY_REFLECTION=off so we exercise the threshold + dedup gates
 * deterministically. Wire-level integration is verified via the existing
 * facts.test.ts roundtrip — see also harness/compaction.test.ts for the
 * tool_outputs storage that recall_tool_result reads from.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-reflection-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resetMemoryDb, openMemoryDb, closeMemoryDb } = await import('./db.js');
const {
  upsertEntity,
  storeEpisodicPointer,
  listRecentEpisodicPointers,
  reflectOnToolReturn,
  scheduleReflection,
  _testOnly_reflectionPending,
  isSelfReferentialTool,
  REFLECTION_MIN_CONTENT_CHARS,
  EXTRACTOR_MAX_FACTS,
  getReflectionThreshold,
  runRecursiveReflection,
  consolidateActiveFacts,
  consolidateFact,
  getResolverStats,
  readReflectionReplayHealth,
  _resetResolverStatsForTest,
  _testOnly_peekSessionImportance,
  _testOnly_resetAllSessionImportance,
  _testOnly_setReflectionExtractor,
  _testOnly_sanitizeExtractionOutput,
  _testOnly_sanitizeRecursivePatternOutput,
  _testOnly_sanitizeConflictDecision,
  _testOnly_reflectorRoute,
} = await import('./reflection.js');
const { rememberFact, getFact, setFactPinned, listRecentlyLearnedFacts, renderRecentlyLearnedForInstructions } = await import('./facts.js');
const { getFactEvidence, recordMemoryEpisode, reapExpiredPendingReflections } = await import('./temporal-memory.js');
const { readReflectionCandidateHealth } = await import('./reflection-candidates.js');
const { vectorToBuffer, _setEmbeddingProviderForTest } = await import('./embeddings.js');
const {
  mergeEntities, resolveCanonicalEntityId, listEntityIdentityConflicts,
  autoReconcileStrongEntityIdentifiers, isStrongPersonalEmail,
} = await import('./entity-identity.js');
const {
  setFactEntityLinks, getFactIdsForEntity, resolveEntityIdsForText,
  loadEntityEdges, loadFactEntityEdges, loadFactResourceEdges,
} = await import('./relations.js');

function factContentHash(id: number): string {
  const row = openMemoryDb().prepare('SELECT content_hash FROM consolidated_facts WHERE id = ?').get(id) as { content_hash: string };
  return row.content_hash;
}

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const prior = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test.afterEach(() => {
  _setEmbeddingProviderForTest(undefined);
  _testOnly_setReflectionExtractor(null);
});

test('reflection extractor binds to the active provider instead of a gpt-shaped global model string', () => {
  const common = {
    CLEMMY_JUDGE_CROSS_FAMILY: 'off',
    CLEMMY_MODEL_ROLES: undefined,
    CLEMMY_BOUNDARY_JUDGE_CLAUDE_MODEL: undefined,
    CLEMMY_BOUNDARY_JUDGE_CODEX_MODEL: undefined,
    BYO_PROVIDERS: undefined,
  };
  withEnv({
    ...common,
    AUTH_MODE: 'claude_oauth',
    MODEL_ROUTING_MODE: 'off',
    BYO_MODEL_BASE_URL: undefined,
    BYO_MODEL_API_KEY: undefined,
    BYO_MODEL_ID: undefined,
  }, () => {
    assert.deepEqual(_testOnly_reflectorRoute(), {
      modelId: 'claude-haiku-4-5',
      provider: 'claude',
      transport: 'claude_subscription',
    });
  });

  withEnv({
    ...common,
    AUTH_MODE: 'claude_oauth',
    MODEL_ROUTING_MODE: 'all_in',
    BYO_MODEL_BASE_URL: 'https://byo.example.test/v1',
    BYO_MODEL_API_KEY: 'byo-key',
    BYO_MODEL_ID: 'gpt-shaped-reflector',
    BYO_MODEL_JUDGE_ID: 'gpt-shaped-reflector-judge',
  }, () => {
    assert.deepEqual(_testOnly_reflectorRoute(), {
      modelId: 'gpt-shaped-reflector-judge',
      provider: 'byo',
      transport: 'byo_openai_compatible',
    });
  });
});

test('entities: upsert is idempotent + merges aliases', () => {
  resetMemoryDb();
  const id1 = upsertEntity({ type: 'person', name: 'Marlow Smith', aliases: ['Marlow'] });
  const id2 = upsertEntity({ type: 'person', name: 'Marlow Smith', aliases: ['marlow@acme.example'] });
  assert.equal(id1, id2, 'same canonical+type returns same row');

  const id3 = upsertEntity({ type: 'company', name: 'Marlow Smith' });
  assert.notEqual(id1, id3, 'different type is a different entity even with same name');
});

test('entities: case-insensitive matching on canonical name', () => {
  resetMemoryDb();
  const id1 = upsertEntity({ type: 'person', name: 'Marlow Smith' });
  const id2 = upsertEntity({ type: 'person', name: 'MARLOW SMITH' });
  assert.equal(id1, id2);
});

test('entities: one durable episode increments identity observation only once', () => {
  resetMemoryDb();
  const episode = recordMemoryEpisode({
    kind: 'tool_result',
    sessionId: 'entity-observation-session',
    callId: 'entity-observation-call',
    occurredAt: '2026-07-01T10:00:00.000Z',
    sourceUri: 'meeting://entity-observation',
    content: 'Dana Smith joined the meeting.',
  });
  const first = upsertEntity({
    type: 'person', name: 'Dana Smith', evidenceEpisodeId: episode.id,
    sourceUri: 'meeting://entity-observation',
  });
  const replay = upsertEntity({
    type: 'person', name: 'Dana Smith', aliases: ['Dana'], evidenceEpisodeId: episode.id,
    sourceUri: 'meeting://entity-observation',
  });
  assert.equal(replay, first);
  const row = openMemoryDb().prepare(`
    SELECT mention_count, first_seen_at, last_seen_at,
      (SELECT COUNT(*) FROM entity_observations eo WHERE eo.entity_id = entities.id) AS observations
    FROM entities WHERE id = ?
  `).get(first) as { mention_count: number; first_seen_at: string; last_seen_at: string; observations: number };
  assert.deepEqual(row, {
    mention_count: 1,
    first_seen_at: '2026-07-01T10:00:00.000Z',
    last_seen_at: '2026-07-01T10:00:00.000Z',
    observations: 1,
  });
});

test('entities: observation time follows source occurrence and does not move backward on replay', () => {
  resetMemoryDb();
  const older = recordMemoryEpisode({
    kind: 'tool_result', sessionId: 'entity-time-session', callId: 'older',
    occurredAt: '2026-06-01T10:00:00.000Z', content: 'Dana Smith attended.',
  });
  const newer = recordMemoryEpisode({
    kind: 'tool_result', sessionId: 'entity-time-session', callId: 'newer',
    occurredAt: '2026-07-01T10:00:00.000Z', content: 'Dana Smith attended again.',
  });
  const id = upsertEntity({ type: 'person', name: 'Dana Smith', evidenceEpisodeId: newer.id });
  upsertEntity({ type: 'person', name: 'Dana Smith', evidenceEpisodeId: older.id });
  upsertEntity({ type: 'person', name: 'Dana Smith', evidenceEpisodeId: older.id });
  const row = openMemoryDb().prepare(`
    SELECT mention_count, first_seen_at, last_seen_at,
      (SELECT COUNT(*) FROM entity_observations eo WHERE eo.entity_id = entities.id) AS observations
    FROM entities WHERE id = ?
  `).get(id) as { mention_count: number; first_seen_at: string; last_seen_at: string; observations: number };
  assert.deepEqual(row, {
    mention_count: 2,
    first_seen_at: '2026-06-01T10:00:00.000Z',
    last_seen_at: '2026-07-01T10:00:00.000Z',
    observations: 2,
  });
});

test('entities: a stable email converges different names into one canonical person', () => {
  resetMemoryDb();
  const id1 = upsertEntity({
    type: 'person',
    name: 'Alexander Chen',
    aliases: ['alex@corp.example'],
    evidenceEpisodeId: undefined,
  });
  const id2 = upsertEntity({
    type: 'person',
    name: 'Alex Chen',
    aliases: ['alex@corp.example'],
  });
  assert.equal(id2, id1, 'the shared stable identifier prevents a duplicate person row');

  const row = openMemoryDb().prepare('SELECT aliases_json FROM entities WHERE id = ?').get(id1) as { aliases_json: string };
  assert.ok(JSON.parse(row.aliases_json).includes('Alex Chen'), 'the alternate display name is retained as an alias');
});

test('entities: historical exact personal-email duplicates reconcile to the strongest canonical person', () => {
  resetMemoryDb();
  const canonical = upsertEntity({
    type: 'person', name: 'Alexander Chen', aliases: ['alex@corp.example'],
  });
  const db = openMemoryDb();
  const now = '2026-01-01T00:00:00.000Z';
  const duplicate = Number(db.prepare(`
    INSERT INTO entities
      (entity_type, canonical_name, canonical_name_lc, aliases_json, first_seen_at, last_seen_at, mention_count)
    VALUES ('person', 'Alex', 'alex', '[]', ?, ?, 1)
  `).run(now, now).lastInsertRowid);
  db.prepare(`
    INSERT INTO entity_identifiers
      (entity_id, scheme, value, value_norm, confidence, evidence_episode_id, source_uri, first_seen_at, last_seen_at)
    VALUES (?, 'email', 'alex@corp.example', 'alex@corp.example', 0.99, NULL, NULL, ?, ?)
  `).run(duplicate, now, now);

  const result = autoReconcileStrongEntityIdentifiers();
  assert.equal(result.groupsMerged, 1);
  assert.equal(result.entitiesRedirected, 1);
  assert.equal(resolveCanonicalEntityId(duplicate), canonical);
  assert.equal(upsertEntity({ type: 'person', name: 'Alex Chen', aliases: ['alex@corp.example'] }), canonical);
});

test('entities: shared inboxes and cross-type email reuse never auto-merge identities', () => {
  resetMemoryDb();
  const amy = upsertEntity({ type: 'person', name: 'Amy Adams', aliases: ['sales@example.com'] });
  const alex = upsertEntity({ type: 'person', name: 'Alex Alvarez', aliases: ['sales@example.com'] });
  const company = upsertEntity({ type: 'company', name: 'Example Co', aliases: ['amy@example.com'] });
  const person = upsertEntity({ type: 'person', name: 'Amy Person', aliases: ['amy@example.com'] });
  assert.notEqual(amy, alex, 'a generic shared inbox is review-only evidence');
  assert.notEqual(company, person, 'identifiers never merge across entity types');
  assert.deepEqual(listEntityIdentityConflicts(), [], 'neither case is presented as a safe duplicate-person merge');
  assert.equal(isStrongPersonalEmail('no-reply@example.com'), false);
  assert.equal(isStrongPersonalEmail('customer.service@example.com'), false);
  assert.equal(isStrongPersonalEmail('operations@example.com'), false);
});

test('entities: low-confidence personal email remains review evidence and cannot authorize a merge', () => {
  resetMemoryDb();
  const first = upsertEntity({
    type: 'person', name: 'Jordan North',
    identifiers: [{ scheme: 'email', value: 'jordan@example.com', confidence: 0.5 }],
  });
  const second = upsertEntity({
    type: 'person', name: 'J. North',
    identifiers: [{ scheme: 'email', value: 'jordan@example.com', confidence: 0.5 }],
  });
  assert.notEqual(first, second);
  assert.deepEqual(autoReconcileStrongEntityIdentifiers(), {
    groupsScanned: 0,
    groupsMerged: 0,
    entitiesRedirected: 0,
  });
  assert.equal(listEntityIdentityConflicts().length, 1, 'uncertain identifier collision stays reviewable');
});

test('entities: identical names with conflicting personal emails remain distinct', () => {
  resetMemoryDb();
  const first = upsertEntity({ type: 'person', name: 'Jordan Lee', aliases: ['jordan.one@example.com'] });
  const second = upsertEntity({ type: 'person', name: 'Jordan Lee', aliases: ['jordan.two@example.com'] });
  assert.notEqual(first, second, 'a name collision must not combine two strongly distinct people');

  const replay = upsertEntity({ type: 'person', name: 'J. Lee', aliases: ['jordan.two@example.com'] });
  assert.equal(replay, second, 'the stable identifier must select the correct same-name person');
});

test('entities: a shared phone is evidence but never an automatic person merge key', () => {
  resetMemoryDb();
  const first = upsertEntity({
    type: 'person', name: 'Avery North', identifiers: [{ scheme: 'phone', value: '+1 555 010 2200' }],
  });
  const second = upsertEntity({
    type: 'person', name: 'Blake North', identifiers: [{ scheme: 'phone', value: '+1 555 010 2200' }],
  });
  assert.notEqual(first, second, 'family or office phone reuse cannot authorize an identity merge');
});

test('entities: a shared single-token nickname is not enough to auto-merge people', () => {
  resetMemoryDb();
  const first = upsertEntity({ type: 'person', name: 'Amy Adams', aliases: ['Amy'] });
  const second = upsertEntity({ type: 'person', name: 'Amy Alvarez', aliases: ['Amy'] });
  assert.notEqual(first, second, 'ambiguous nicknames remain distinct');
});

test('entities: reviewed merge redirects history and retrieval without deleting the source row', () => {
  resetMemoryDb();
  const canonical = upsertEntity({ type: 'person', name: 'Alexander Chen', aliases: ['Alexander'] });
  const duplicate = upsertEntity({ type: 'person', name: 'Alex' });
  const fact = rememberFact({ kind: 'user', content: 'Alex owns the weekly client review.' });
  setFactEntityLinks(fact.id, [duplicate]);

  assert.equal(mergeEntities({
    sourceEntityId: duplicate,
    canonicalEntityId: canonical,
    reason: 'user-reviewed duplicate',
  }), canonical);
  assert.equal(resolveCanonicalEntityId(duplicate), canonical);
  assert.ok(getFactIdsForEntity(duplicate).includes(fact.id), 'old ids replay through the canonical identity');
  assert.deepEqual(resolveEntityIdsForText('What did Alex own?'), [canonical], 'the old name resolves once, to the canonical person');
  assert.ok(openMemoryDb().prepare('SELECT id FROM entities WHERE id = ?').get(duplicate), 'the historical source entity remains queryable');
  assert.deepEqual(listEntityIdentityConflicts(), []);
});

test('episodic_pointers: round-trip per session', () => {
  resetMemoryDb();
  const sessionId = 'sess-test-1';
  storeEpisodicPointer({
    sessionId,
    callId: 'call_abc',
    label: 'the pricing convo',
    tool: 'composio.outlook',
    sourceUri: 'outlook:thread:xyz',
  });
  storeEpisodicPointer({
    sessionId,
    callId: 'call_def',
    label: 'q2 roadmap doc',
    tool: 'composio.drive',
    sourceUri: null,
  });
  const out = listRecentEpisodicPointers(sessionId, 10);
  assert.equal(out.length, 2);
  // DESC order — newest first
  assert.equal(out[0].label, 'q2 roadmap doc');
  assert.equal(out[1].label, 'the pricing convo');
  assert.equal(out[0].source_uri, null);
  assert.equal(out[1].source_uri, 'outlook:thread:xyz');
});

test('rememberFact: direct fact defaults to trust_level=1.0, no extracted_at', () => {
  resetMemoryDb();
  const fact = rememberFact({
    kind: 'user',
    content: 'User prefers terse replies',
  });
  assert.equal(fact.trustLevel, 1.0);
  assert.equal(fact.extractedAt, null);
  assert.equal(fact.derivedFrom, undefined);
});

test('rememberFact: derived fact gets trust=0.6, populates derived_from + extracted_at', () => {
  resetMemoryDb();
  const fact = rememberFact({
    kind: 'reference',
    content: 'Acme contract runs through Q4 2026',
    sessionId: 'sess-test-2',
    derivedFrom: {
      sessionId: 'sess-test-2',
      callId: 'call_xyz',
      tool: 'composio.outlook',
    },
  });
  assert.equal(fact.trustLevel, 0.6);
  assert.ok(fact.extractedAt);
  assert.equal(fact.derivedFrom?.callId, 'call_xyz');
  assert.equal(fact.derivedFrom?.tool, 'composio.outlook');
});

test('rememberFact: direct write SUPERSEDES prior derived trust on conflict', () => {
  resetMemoryDb();
  // First, the reflection layer extracts a low-confidence fact.
  rememberFact({
    kind: 'user',
    content: 'User probably prefers Tuesday afternoons',
    derivedFrom: { sessionId: 'sess-x', callId: 'call_x', tool: 'outlook' },
  });
  // Then the user states it directly.
  const direct = rememberFact({
    kind: 'user',
    content: 'User probably prefers Tuesday afternoons',
  });
  assert.equal(direct.trustLevel, 1.0, 'direct write must lift trust to 1.0');
});

test('listRecentlyLearnedFacts: returns only derived facts ordered by extracted_at DESC', () => {
  resetMemoryDb();
  rememberFact({ kind: 'user', content: 'direct fact A' });
  rememberFact({
    kind: 'reference',
    content: 'derived fact A',
    derivedFrom: { sessionId: 's', callId: 'c1', tool: 't' },
  });
  rememberFact({
    kind: 'reference',
    content: 'derived fact B',
    derivedFrom: { sessionId: 's', callId: 'c2', tool: 't' },
  });
  const recent = listRecentlyLearnedFacts({ sinceHours: 1, limit: 10 });
  assert.equal(recent.length, 2, 'direct facts excluded');
  // Most recent first
  assert.equal(recent[0].content, 'derived fact B');
  assert.equal(recent[1].content, 'derived fact A');
});

test('renderRecentlyLearnedForInstructions: includes call_id refs for recall', () => {
  resetMemoryDb();
  rememberFact({
    kind: 'reference',
    content: 'Acme contract runs through Q4',
    derivedFrom: { sessionId: 's', callId: 'call_abc123', tool: 'outlook' },
  });
  const rendered = renderRecentlyLearnedForInstructions(24, 10);
  assert.match(rendered, /Acme contract/);
  assert.match(rendered, /\[call_abc123\]/);
  assert.match(rendered, /\(from outlook\)/);
});

test('reflectOnToolReturn: short outputs skip extraction entirely', async () => {
  resetMemoryDb();
  const result = await reflectOnToolReturn({
    sessionId: 'sess-skip',
    callId: 'call_short',
    tool: 'noop',
    output: 'tiny',
  });
  assert.equal(result.skipped, 'too_short');
  assert.equal(result.factsWritten, 0);
});

test('reflectOnToolReturn: disabled via CLEMMY_REFLECTION=off', async () => {
  resetMemoryDb();
  const prev = process.env.CLEMMY_REFLECTION;
  process.env.CLEMMY_REFLECTION = 'off';
  try {
    const result = await reflectOnToolReturn({
      sessionId: 'sess-disabled',
      callId: 'call_x',
      tool: 't',
      output: 'x'.repeat(REFLECTION_MIN_CONTENT_CHARS + 1),
    });
    assert.equal(result.skipped, 'disabled');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_REFLECTION;
    else process.env.CLEMMY_REFLECTION = prev;
  }
});

test('REFLECTION_MIN_CONTENT_CHARS: gate constant exposed for hooks.ts use', () => {
  assert.ok(REFLECTION_MIN_CONTENT_CHARS >= 200, 'threshold should be high enough to skip pings/acks');
  assert.ok(REFLECTION_MIN_CONTENT_CHARS <= 2000, 'threshold should not exclude typical tool returns');
});

test('EXTRACTOR_MAX_FACTS: bounds facts-per-return to a small cap (intake throttle)', () => {
  assert.ok(EXTRACTOR_MAX_FACTS >= 1 && EXTRACTOR_MAX_FACTS <= 6, 'a few facts per tool return, not a dump');
  assert.ok(EXTRACTOR_MAX_FACTS < 8, 'tighter than the legacy 8 ceiling so the low-value tail is trimmed');
});

test('getReflectionThreshold: default is Stanford/2 (75), env override accepted', () => {
  const prev = process.env.CLEMMY_REFLECTION_THRESHOLD;
  try {
    delete process.env.CLEMMY_REFLECTION_THRESHOLD;
    assert.equal(getReflectionThreshold(), 75);
    process.env.CLEMMY_REFLECTION_THRESHOLD = '150';
    assert.equal(getReflectionThreshold(), 150, 'Stanford default available via env');
    process.env.CLEMMY_REFLECTION_THRESHOLD = '0';
    assert.equal(getReflectionThreshold(), 0, '0 disables the gate');
    process.env.CLEMMY_REFLECTION_THRESHOLD = 'garbage';
    assert.equal(getReflectionThreshold(), 75, 'invalid input falls back to default');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_REFLECTION_THRESHOLD;
    else process.env.CLEMMY_REFLECTION_THRESHOLD = prev;
  }
});

test('session importance counter: accumulate + reset', () => {
  _testOnly_resetAllSessionImportance();
  resetMemoryDb();
  const sid = 'sess-importance-1';
  assert.equal(_testOnly_peekSessionImportance(sid), 0);
  // accumulateImportance is internal — exercise via the reflection path
  // is covered by the integration check below. Here we verify the peek
  // helper returns 0 for an unknown session.
  assert.equal(_testOnly_peekSessionImportance('never-seen'), 0);
});

test('reflectOnToolReturn: low-importance extractions persist and commit together when the threshold crosses', async () => {
  resetMemoryDb();
  _testOnly_resetAllSessionImportance();
  const prevReflect = process.env.CLEMMY_REFLECTION;
  const prevThreshold = process.env.CLEMMY_REFLECTION_THRESHOLD;
  delete process.env.CLEMMY_REFLECTION;
  process.env.CLEMMY_REFLECTION_THRESHOLD = '10';
  const sessionId = 'sess-pending-reflection';
  try {
    _testOnly_setReflectionExtractor(async (prompt) => {
      if (prompt.includes('call-low')) {
        return {
          facts: [{ kind: 'reference', text: 'Quorvex amber docket anchors the retention proof', importance: 4 }],
          entities: [{ type: 'project', name: 'Quorvex Docket' }],
          pointers: [],
        };
      }
      return {
        facts: [{ kind: 'reference', text: 'Zentara blue ledger closes the threshold proof', importance: 6 }],
        entities: [],
        pointers: [{ label: 'zentara blue ledger' }],
      };
    });

    const first = await reflectOnToolReturn({
      sessionId,
      callId: 'call-low',
      tool: 'read_file',
      output: 'first durable output '.repeat(80),
    });
    assert.equal(first.skipped, 'low_importance');
    assert.equal(first.factsWritten, 0);
    assert.equal(first.pointersStored, 1, 'pointer is stored even while fact commit is delayed');
    assert.equal(_testOnly_peekSessionImportance(sessionId), 4);
    const bufferedHealth = readReflectionCandidateHealth();
    assert.equal(bufferedHealth.total, 1);
    assert.equal(bufferedHealth.pending, 1);
    assert.equal(bufferedHealth.orphanedPending, 0);
    assert.ok(bufferedHealth.oldestPending);
    assert.equal(
      (openMemoryDb().prepare('SELECT COUNT(*) AS n FROM consolidated_facts').get() as { n: number }).n,
      0,
      'below-threshold facts are delayed, not committed immediately',
    );
    const firstPointer = listRecentEpisodicPointers(sessionId, 10)[0];
    assert.equal(firstPointer?.call_id, 'call-low');
    assert.match(firstPointer?.label ?? '', /derived_fact_source/);

    const second = await reflectOnToolReturn({
      sessionId,
      callId: 'call-cross',
      tool: 'read_file',
      output: 'second durable output '.repeat(80),
    });
    assert.equal(second.skipped, undefined);
    assert.equal(second.factsWritten, 2, 'crossing the threshold commits current and pending facts');
    assert.equal(second.entitiesUpserted, 1, 'pending entities commit with their delayed batch');
    assert.equal(second.sumImportance, 10);
    assert.equal(_testOnly_peekSessionImportance(sessionId), 0, 'pending threshold window resets after commit');
    const promotedHealth = readReflectionCandidateHealth();
    assert.equal(promotedHealth.pending, 0);
    assert.equal(promotedHealth.promoted, 2);
    assert.equal(promotedHealth.promotionRate, 1);

    const rows = openMemoryDb().prepare(`
      SELECT content, derived_from_call_id
      FROM consolidated_facts
      ORDER BY derived_from_call_id
    `).all() as Array<{ content: string; derived_from_call_id: string | null }>;
    assert.deepEqual(
      rows.map((r) => [r.derived_from_call_id, r.content]),
      [
        ['call-cross', 'Zentara blue ledger closes the threshold proof'],
        ['call-low', 'Quorvex amber docket anchors the retention proof'],
      ],
    );
    assert.equal(
      (openMemoryDb().prepare('SELECT COUNT(*) AS n FROM reflection_pending_extractions').get() as { n: number }).n,
      0,
      'pending rows are cleared only after the delayed facts commit',
    );
  } finally {
    if (prevReflect === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prevReflect;
    if (prevThreshold === undefined) delete process.env.CLEMMY_REFLECTION_THRESHOLD; else process.env.CLEMMY_REFLECTION_THRESHOLD = prevThreshold;
  }
});

test('reflectOnToolReturn: task-shaped extractor noise is rejected before canonical fact memory', async () => {
  resetMemoryDb();
  _testOnly_resetAllSessionImportance();
  const priorThreshold = process.env.CLEMMY_REFLECTION_THRESHOLD;
  const priorEmbed = process.env.CLEMMY_EMBED_AT_WRITE;
  process.env.CLEMMY_REFLECTION_THRESHOLD = '0';
  process.env.CLEMMY_EMBED_AT_WRITE = 'off';
  try {
    _testOnly_setReflectionExtractor(async () => ({
      facts: [
        { kind: 'reference', text: 'Clementine searched the CRM for Dana.', importance: 4 },
        { kind: 'reference', text: 'Dana Smith is the billing contact for Acme.', importance: 6 },
      ],
      entities: [{ type: 'person', name: 'Dana Smith' }, { type: 'company', name: 'Acme' }],
      pointers: [],
    }));
    const result = await reflectOnToolReturn({
      sessionId: 'sess-quality-filter',
      callId: 'call-quality-filter',
      tool: 'crm_lookup',
      output: `CRM directory record: Dana Smith is the billing contact for Acme. ${'authoritative directory context '.repeat(50)}`,
    });
    assert.equal(result.factsWritten, 1);
    const facts = openMemoryDb().prepare('SELECT content FROM consolidated_facts').all() as Array<{ content: string }>;
    assert.deepEqual(facts.map((row) => row.content), ['Dana Smith is the billing contact for Acme.']);
    const candidates = openMemoryDb().prepare(`
      SELECT text, status, reason, resulting_fact_id
      FROM memory_reflection_candidates ORDER BY text
    `).all() as Array<{ text: string; status: string; reason: string; resulting_fact_id: number | null }>;
    assert.deepEqual(candidates.map((row) => [row.text, row.status, row.reason, row.resulting_fact_id != null]), [
      ['Clementine searched the CRM for Dana.', 'rejected', 'assistant_action_history', false],
      ['Dana Smith is the billing contact for Acme.', 'promoted', 'consolidation:add', true],
    ]);
    const health = readReflectionCandidateHealth();
    assert.equal(health.promoted, 1);
    assert.equal(health.rejected, 1);
    assert.equal(health.rejectionReasons.assistant_action_history, 1);
  } finally {
    if (priorThreshold === undefined) delete process.env.CLEMMY_REFLECTION_THRESHOLD; else process.env.CLEMMY_REFLECTION_THRESHOLD = priorThreshold;
    if (priorEmbed === undefined) delete process.env.CLEMMY_EMBED_AT_WRITE; else process.env.CLEMMY_EMBED_AT_WRITE = priorEmbed;
  }
});

test('the same person fact from a later episode reinforces one canonical memory with both sources', async () => {
  resetMemoryDb();
  _testOnly_resetAllSessionImportance();
  const priorThreshold = process.env.CLEMMY_REFLECTION_THRESHOLD;
  const priorEmbed = process.env.CLEMMY_EMBED_AT_WRITE;
  process.env.CLEMMY_REFLECTION_THRESHOLD = '0';
  process.env.CLEMMY_EMBED_AT_WRITE = 'off';
  try {
    _testOnly_setReflectionExtractor(async () => ({
      facts: [{ kind: 'reference', text: 'Dana Smith is the billing contact for Acme.', importance: 6 }],
      entities: [{ type: 'person', name: 'Dana Smith' }, { type: 'company', name: 'Acme' }],
      pointers: [],
    }));
    const first = await reflectOnToolReturn({
      sessionId: 'sess-person-reinforcement', callId: 'call-directory', tool: 'crm_lookup',
      output: `CRM directory: Dana Smith is the billing contact for Acme. ${'directory context '.repeat(80)}`,
    });
    const second = await reflectOnToolReturn({
      sessionId: 'sess-person-reinforcement', callId: 'call-meeting', tool: 'meeting_transcript',
      output: `Meeting transcript: Dana Smith is the billing contact for Acme. ${'meeting context '.repeat(80)}`,
    });
    assert.equal(first.factsWritten, 1);
    assert.equal(second.factsWritten, 0);
    assert.equal(second.factsNoop, 1);
    const db = openMemoryDb();
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM consolidated_facts').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n, 2);
    assert.equal((db.prepare('SELECT SUM(mention_count) AS n FROM entities').get() as { n: number }).n, 4);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM fact_evidence').get() as { n: number }).n, 2);
    const candidates = db.prepare(`
      SELECT status, reason FROM memory_reflection_candidates ORDER BY call_id
    `).all() as Array<{ status: string; reason: string }>;
    assert.deepEqual(candidates, [
      { status: 'promoted', reason: 'consolidation:add' },
      { status: 'promoted', reason: 'consolidation:reinforce' },
    ]);
  } finally {
    if (priorThreshold === undefined) delete process.env.CLEMMY_REFLECTION_THRESHOLD; else process.env.CLEMMY_REFLECTION_THRESHOLD = priorThreshold;
    if (priorEmbed === undefined) delete process.env.CLEMMY_EMBED_AT_WRITE; else process.env.CLEMMY_EMBED_AT_WRITE = priorEmbed;
  }
});

test('expired reflection candidates settle their buffered receipts instead of remaining pending forever', async () => {
  resetMemoryDb();
  _testOnly_resetAllSessionImportance();
  const priorThreshold = process.env.CLEMMY_REFLECTION_THRESHOLD;
  process.env.CLEMMY_REFLECTION_THRESHOLD = '10';
  try {
    _testOnly_setReflectionExtractor(async () => ({
      facts: [{ kind: 'reference', text: 'The amber archive belongs to Project Quorvex.', importance: 4 }],
      entities: [],
      pointers: [],
    }));
    const input = {
      sessionId: 'sess-expired-candidate',
      callId: 'call-expired-candidate',
      tool: 'read_file',
      output: `Project record: the amber archive belongs to Project Quorvex. ${'archive context '.repeat(80)}`,
    };
    assert.equal((await reflectOnToolReturn(input)).skipped, 'low_importance');
    const db = openMemoryDb();
    db.prepare(`
      UPDATE reflection_pending_extractions SET expires_at = '2026-07-01T00:00:00.000Z'
      WHERE session_id = ? AND call_id = ?
    `).run(input.sessionId, input.callId);
    assert.equal(reapExpiredPendingReflections('2026-07-02T00:00:00.000Z'), 1);
    const candidate = db.prepare(`
      SELECT status, reason FROM memory_reflection_candidates
      WHERE session_id = ? AND call_id = ?
    `).get(input.sessionId, input.callId) as { status: string; reason: string };
    assert.deepEqual(candidate, { status: 'expired', reason: 'threshold_expired' });
    const receipt = db.prepare(`
      SELECT status, completed_at, result_json FROM memory_reflection_receipts
      WHERE session_id = ? AND call_id = ?
    `).get(input.sessionId, input.callId) as { status: string; completed_at: string | null; result_json: string | null };
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.completed_at, '2026-07-02T00:00:00.000Z');
    assert.deepEqual(JSON.parse(receipt.result_json ?? '{}'), { lifecycle: 'expired', reason: 'threshold_expired' });
    const health = readReflectionCandidateHealth('2026-07-02T00:00:00.000Z');
    assert.equal(health.pending, 0);
    assert.equal(health.expired, 1);
    assert.equal(health.orphanedPending, 0);
  } finally {
    if (priorThreshold === undefined) delete process.env.CLEMMY_REFLECTION_THRESHOLD; else process.env.CLEMMY_REFLECTION_THRESHOLD = priorThreshold;
  }
});

test('reflectOnToolReturn: extractor failure still leaves a recallable pointer', async () => {
  resetMemoryDb();
  _testOnly_resetAllSessionImportance();
  const prevReflect = process.env.CLEMMY_REFLECTION;
  delete process.env.CLEMMY_REFLECTION;
  try {
    _testOnly_setReflectionExtractor(async () => null);
    const result = await reflectOnToolReturn({
      sessionId: 'sess-extractor-fail',
      callId: 'call-extractor-fail',
      tool: 'composio_execute_tool',
      output: 'large connector output with potentially useful rows '.repeat(80),
    });
    assert.equal(result.skipped, 'extractor_failed');
    assert.equal(result.pointersStored, 1);
    const pointers = listRecentEpisodicPointers('sess-extractor-fail', 5);
    assert.equal(pointers.length, 1);
    assert.equal(pointers[0].call_id, 'call-extractor-fail');
    assert.match(pointers[0].label, /extractor_failed/);
  } finally {
    if (prevReflect === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prevReflect;
  }
});

test('reflection receipts suppress identical replay after a database reopen', async () => {
  resetMemoryDb();
  const priorThreshold = process.env.CLEMMY_REFLECTION_THRESHOLD;
  const priorEmbed = process.env.CLEMMY_EMBED_AT_WRITE;
  process.env.CLEMMY_REFLECTION_THRESHOLD = '0';
  process.env.CLEMMY_EMBED_AT_WRITE = 'off';
  let extractorCalls = 0;
  const input = {
    sessionId: 'sess-durable-replay',
    callId: 'call-durable-replay',
    tool: 'directory_lookup',
    output: `Dana works at Acme. ${'durable directory evidence '.repeat(50)}`,
  };
  try {
    _testOnly_setReflectionExtractor(async () => {
      extractorCalls += 1;
      return {
        facts: [{ kind: 'reference', text: 'Dana works at Acme', importance: 4 }],
        entities: [{ type: 'person', name: 'Dana' }, { type: 'company', name: 'Acme' }],
        pointers: [{ label: 'Dana directory record' }],
        relationships: [{
          subject: 'Dana', predicate: 'works at', object: 'Acme',
          evidence_excerpt: 'Dana works at Acme', confidence: 0.95,
        }],
      };
    });
    const first = await reflectOnToolReturn(input);
    assert.equal(first.skipped, undefined);
    closeMemoryDb();
    openMemoryDb();
    const replay = await reflectOnToolReturn(input);
    assert.equal(replay.skipped, 'already_reflected');
    assert.equal(extractorCalls, 1, 'the replay never reaches the extractor');
    const db = openMemoryDb();
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM consolidated_facts').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n, 2);
    assert.equal((db.prepare('SELECT SUM(mention_count) AS n FROM entities').get() as { n: number }).n, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM entity_edge_evidence').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM episodic_pointers').get() as { n: number }).n, 1);
    assert.deepEqual(readReflectionReplayHealth(), {
      total: 1, processing: 0, buffered: 0, completed: 1, failed: 0, retried: 0, staleProcessing: 0,
    });
  } finally {
    if (priorThreshold === undefined) delete process.env.CLEMMY_REFLECTION_THRESHOLD; else process.env.CLEMMY_REFLECTION_THRESHOLD = priorThreshold;
    if (priorEmbed === undefined) delete process.env.CLEMMY_EMBED_AT_WRITE; else process.env.CLEMMY_EMBED_AT_WRITE = priorEmbed;
  }
});

test('failed reflection receipts are retryable without duplicating fallback pointers', async () => {
  resetMemoryDb();
  const priorThreshold = process.env.CLEMMY_REFLECTION_THRESHOLD;
  process.env.CLEMMY_REFLECTION_THRESHOLD = '0';
  let extractorCalls = 0;
  const input = {
    sessionId: 'sess-retryable-reflection',
    callId: 'call-retryable-reflection',
    tool: 'composio_execute_tool',
    output: 'retryable connector output '.repeat(80),
  };
  try {
    _testOnly_setReflectionExtractor(async () => {
      extractorCalls += 1;
      if (extractorCalls === 1) return null;
      return { facts: [], entities: [], pointers: [] };
    });
    assert.equal((await reflectOnToolReturn(input)).skipped, 'extractor_failed');
    assert.equal((await reflectOnToolReturn(input)).skipped, undefined);
    assert.equal(extractorCalls, 2, 'a failed receipt grants a new processing attempt');
    assert.equal(
      (openMemoryDb().prepare('SELECT COUNT(*) AS n FROM episodic_pointers').get() as { n: number }).n,
      1,
      'the retry reuses the same deterministic fallback pointer',
    );
    assert.deepEqual(readReflectionReplayHealth(), {
      total: 1, processing: 0, buffered: 0, completed: 1, failed: 0, retried: 1, staleProcessing: 0,
    });
  } finally {
    if (priorThreshold === undefined) delete process.env.CLEMMY_REFLECTION_THRESHOLD; else process.env.CLEMMY_REFLECTION_THRESHOLD = priorThreshold;
  }
});

test('buffered low-importance reflection is not extracted twice after restart', async () => {
  resetMemoryDb();
  const priorThreshold = process.env.CLEMMY_REFLECTION_THRESHOLD;
  process.env.CLEMMY_REFLECTION_THRESHOLD = '10';
  let extractorCalls = 0;
  const input = {
    sessionId: 'sess-buffered-replay',
    callId: 'call-buffered-replay',
    tool: 'read_file',
    output: 'low importance durable content '.repeat(80),
  };
  try {
    _testOnly_setReflectionExtractor(async () => {
      extractorCalls += 1;
      return {
        facts: [{ kind: 'reference', text: 'The amber replay fixture remains pending', importance: 4 }],
        entities: [{ type: 'project', name: 'Amber Replay' }],
        pointers: [],
      };
    });
    assert.equal((await reflectOnToolReturn(input)).skipped, 'low_importance');
    closeMemoryDb();
    openMemoryDb();
    assert.equal((await reflectOnToolReturn(input)).skipped, 'already_reflected');
    assert.equal(extractorCalls, 1);
    const db = openMemoryDb();
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM reflection_pending_extractions').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM consolidated_facts').get() as { n: number }).n, 0);
    assert.equal(readReflectionReplayHealth().buffered, 1);
  } finally {
    if (priorThreshold === undefined) delete process.env.CLEMMY_REFLECTION_THRESHOLD; else process.env.CLEMMY_REFLECTION_THRESHOLD = priorThreshold;
  }
});

test('reflection extractor sanitizer preserves signal from schema-drifted JSON', () => {
  const extraction = _testOnly_sanitizeExtractionOutput('```json\n' + JSON.stringify({
    facts: [
      { kind: 'memory', text: 'User prefers CRM exports grouped by account owner.', importance: '8' },
      { kind: 'project', text: 'Acme renewal outreach uses the Q3 pipeline sheet.', importance: 6 },
    ],
    entities: [
      { type: 'organization', name: 'Acme Legal', aliases: [null, 'Acme'] },
      { type: 'account', name: 'Q3 Pipeline' },
      { type: 'person', name: '' },
    ],
    pointers: null,
    resources: [
      { kind: 'sheet', name: 'Q3 pipeline sheet', whats_here: 'renewal outreach rows' },
      { kind: 'folder', ref: 'drive:missing-name' },
    ],
  }) + '\n```', { withResources: true });

  assert.ok(extraction);
  assert.deepEqual(extraction.facts.map((fact) => [fact.kind, fact.importance]), [['user', 8], ['project', 6]]);
  assert.deepEqual(extraction.entities.map((entity) => [entity.type, entity.name]), [['company', 'Acme Legal'], ['company', 'Q3 Pipeline']]);
  assert.deepEqual(extraction.entities[0].aliases, ['Acme']);
  assert.deepEqual(extraction.pointers, []);
  assert.deepEqual(extraction.resources, [
    { kind: 'sheet', name: 'Q3 pipeline sheet', whats_here: 'renewal outreach rows' },
  ]);
});

test('reflection schema-drift recovery classifies configured user-name facts without hardcoded identities', () => {
  const extraction = _testOnly_sanitizeExtractionOutput({
    facts: [
      { kind: 'memory', text: 'Jordan Rivera prefers concise weekly summaries.', importance: 7 },
      { kind: 'memory', text: "Jordan Rivera's timezone is America/Los_Angeles.", importance: 5 },
    ],
    entities: [],
    pointers: [],
  }, { userNames: ['Jordan Rivera'] });

  assert.deepEqual(extraction?.facts.map((fact) => fact.kind), ['user', 'user']);
});

test('reflection relationship sanitizer requires a bounded evidence quote', () => {
  const extraction = _testOnly_sanitizeExtractionOutput({
    facts: [],
    entities: [
      { type: 'person', name: 'Dana' },
      { type: 'company', name: 'Acme' },
    ],
    pointers: [],
    relationships: [
      { subject: 'Dana', predicate: 'works at', object: 'Acme' },
      { subject: 'Dana', relation: 'works at', object: 'Acme', quote: 'Dana works at Acme', confidence: 3 },
    ],
  }, { withRelationships: true });
  assert.equal(extraction?.relationships?.length, 1, 'an ungrounded relationship is dropped at the contract boundary');
  assert.deepEqual(extraction?.relationships?.[0], {
    subject: 'Dana', predicate: 'works at', object: 'Acme',
    evidence_excerpt: 'Dana works at Acme', confidence: 1,
  });
});

test('reflection stores only source-grounded relationships from the same extraction episode', async () => {
  resetMemoryDb();
  _testOnly_resetAllSessionImportance();
  const priorThreshold = process.env.CLEMMY_REFLECTION_THRESHOLD;
  const priorEdges = process.env.CLEMMY_ENTITY_EDGES;
  process.env.CLEMMY_REFLECTION_THRESHOLD = '0';
  delete process.env.CLEMMY_ENTITY_EDGES;
  const output = `Directory record: Dana works at Acme. ${'durable directory context '.repeat(50)}`;
  try {
    _testOnly_setReflectionExtractor(async () => ({
      facts: [{ kind: 'reference', text: 'Dana works at Acme', importance: 4 }],
      entities: [{ type: 'person', name: 'Dana' }, { type: 'company', name: 'Acme' }],
      pointers: [],
      relationships: [{
        subject: 'Dana', predicate: 'employed by', object: 'Acme',
        evidence_excerpt: 'Dana works at Acme', confidence: 0.92,
      }],
    }));
    await reflectOnToolReturn({
      sessionId: 'relationship-session', callId: 'relationship-call', tool: 'directory_lookup', output,
    });
    const edge = loadEntityEdges()[0];
    assert.equal(edge.predicate, 'works at');
    assert.equal(edge.evidenceCount, 1);
    assert.equal(edge.evidence[0].excerpt, 'Dana works at Acme');
    assert.equal(edge.evidence[0].episodeId, edge.evidenceEpisodeId);
    const factRow = openMemoryDb().prepare("SELECT id FROM consolidated_facts WHERE content = 'Dana works at Acme'").get() as { id: number };
    const factLinks = loadFactEntityEdges([factRow.id]);
    assert.equal(factLinks.length, 2);
    assert.ok(factLinks.every((link) => link.truth === 'stored' && link.evidenceEpisodeId === edge.evidenceEpisodeId));
  } finally {
    _testOnly_setReflectionExtractor(null);
    if (priorThreshold === undefined) delete process.env.CLEMMY_REFLECTION_THRESHOLD; else process.env.CLEMMY_REFLECTION_THRESHOLD = priorThreshold;
    if (priorEdges === undefined) delete process.env.CLEMMY_ENTITY_EDGES; else process.env.CLEMMY_ENTITY_EDGES = priorEdges;
  }
});

test('reflection grounds a uniquely named source-map resource from the same durable episode', async () => {
  resetMemoryDb();
  _testOnly_resetAllSessionImportance();
  const priorThreshold = process.env.CLEMMY_REFLECTION_THRESHOLD;
  const priorSourceMap = process.env.CLEMMY_SOURCE_MAP;
  const priorSourceTrust = process.env.CLEMMY_SOURCE_TRUST;
  const priorEmbed = process.env.CLEMMY_EMBED_AT_WRITE;
  process.env.CLEMMY_REFLECTION_THRESHOLD = '0';
  process.env.CLEMMY_SOURCE_MAP = 'on';
  process.env.CLEMMY_SOURCE_TRUST = 'on';
  process.env.CLEMMY_EMBED_AT_WRITE = 'off';
  const output = `Drive result: The Northstar launch plan is stored in the Q3 Planning folder. ${'durable source context '.repeat(50)}`;
  try {
    _testOnly_setReflectionExtractor(async () => ({
      facts: [{ kind: 'reference', text: 'The Northstar launch plan is stored in the Q3 Planning folder.', importance: 7 }],
      entities: [],
      pointers: [],
      resources: [{
        kind: 'folder', name: 'Q3 Planning', ref: 'folder-q3-planning',
        whats_here: 'Northstar launch plans', when_to_use: 'launch planning',
      }],
    }));
    const result = await reflectOnToolReturn({
      sessionId: 'resource-reflection-session',
      callId: 'resource-reflection-call',
      tool: 'google_drive_search',
      output,
    });
    assert.equal(result.factsWritten, 1);
    const fact = openMemoryDb().prepare(`
      SELECT id FROM consolidated_facts
      WHERE content = 'The Northstar launch plan is stored in the Q3 Planning folder.'
    `).get() as { id: number };
    const edges = loadFactResourceEdges([fact.id]);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].truth, 'stored');
    assert.ok(edges[0].evidenceEpisodeId);
    assert.match(edges[0].evidenceExcerpt ?? '', /Q3 Planning/);
  } finally {
    _testOnly_setReflectionExtractor(null);
    if (priorThreshold === undefined) delete process.env.CLEMMY_REFLECTION_THRESHOLD; else process.env.CLEMMY_REFLECTION_THRESHOLD = priorThreshold;
    if (priorSourceMap === undefined) delete process.env.CLEMMY_SOURCE_MAP; else process.env.CLEMMY_SOURCE_MAP = priorSourceMap;
    if (priorSourceTrust === undefined) delete process.env.CLEMMY_SOURCE_TRUST; else process.env.CLEMMY_SOURCE_TRUST = priorSourceTrust;
    if (priorEmbed === undefined) delete process.env.CLEMMY_EMBED_AT_WRITE; else process.env.CLEMMY_EMBED_AT_WRITE = priorEmbed;
  }
});

test('recursive reflection sanitizer accepts schema-drifted pattern output', () => {
  const extraction = _testOnly_sanitizeRecursivePatternOutput('```json\n' + JSON.stringify({
    patterns: [
      { summary: 'User repeatedly asks for harness changes that keep model output from being discarded.', importance: '11' },
      { text: 'ok', importance: 7 },
      { pattern: 'Clementine work increasingly centers on long-horizon recovery and durable memory.', score: '6' },
    ],
  }) + '\n```');

  assert.ok(extraction);
  assert.deepEqual(extraction.patterns, [
    { text: 'User repeatedly asks for harness changes that keep model output from being discarded.', importance: 10 },
    { text: 'Clementine work increasingly centers on long-horizon recovery and durable memory.', importance: 6 },
  ]);
  assert.deepEqual(_testOnly_sanitizeRecursivePatternOutput('{"patterns":null}')?.patterns, []);
  assert.deepEqual(_testOnly_sanitizeRecursivePatternOutput('[{"text":"Top-level array pattern","importance":4}]')?.patterns, [
    { text: 'Top-level array pattern', importance: 4 },
  ]);
});

test('conflict resolver sanitizer accepts schema-drifted JSON', () => {
  const decision = _testOnly_sanitizeConflictDecision('```json\n' + JSON.stringify({
    verdict: 'update',
    targetId: '42',
    replacement: 'User now prefers concise Friday pipeline summaries.',
    rationale: 'The candidate is a newer user preference.',
  }) + '\n```');
  assert.deepEqual(decision, {
    decision: 'UPDATE',
    target_id: 42,
    rewrite: 'User now prefers concise Friday pipeline summaries.',
    reason: 'The candidate is a newer user preference.',
  });
  assert.equal(_testOnly_sanitizeConflictDecision('{"decision":"MERGE"}'), null);
});

test('runRecursiveReflection: disabled via CLEMMY_REFLECTION=off returns cancelled', async () => {
  resetMemoryDb();
  const prev = process.env.CLEMMY_REFLECTION;
  process.env.CLEMMY_REFLECTION = 'off';
  try {
    const result = await runRecursiveReflection();
    assert.equal(result.patternsWritten, 0);
    assert.equal(result.groupsProcessed, 0);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_REFLECTION;
    else process.env.CLEMMY_REFLECTION = prev;
  }
});

test('runRecursiveReflection: groups with <5 facts are skipped (no extractor call)', async () => {
  resetMemoryDb();
  // Seed exactly 4 facts in one kind — below the 5-fact minimum. With
  // CLEMMY_REFLECTION on but no real extractor wired, this still must
  // NOT hit the network: the group-size gate fires first.
  for (let i = 0; i < 4; i += 1) {
    rememberFact({
      kind: 'user',
      content: `User preference ${i}: terse replies on workdays`,
      importance: 5,
    });
  }
  const result = await runRecursiveReflection();
  assert.equal(result.groupsSkipped, 4, 'all 4 kinds skip (each has <5 facts)');
  assert.equal(result.groupsProcessed, 0);
  assert.equal(result.factsConsidered, 0);
});

test('depth/provenance: rememberFact persists derivationDepth + derivedFromFactIds', () => {
  resetMemoryDb();
  const source = rememberFact({ kind: 'user', content: 'User likes Tuesdays' });
  const pattern = rememberFact({
    kind: 'user',
    content: 'User has a consistent mid-week meeting preference',
    derivationDepth: 1,
    derivedFromFactIds: [source.id],
    importance: 7,
  });
  assert.equal(pattern.derivationDepth, 1);
  assert.deepEqual(pattern.derivedFromFactIds, [source.id]);
  assert.equal(pattern.importance, 7);
});

test('recursive reflection CONSOLIDATES: rolled-up depth-0 sources are demoted (derived only; user-trust + pinned protected)', async () => {
  resetMemoryDb();
  const prev = process.env.CLEMMY_REFLECTION;
  delete process.env.CLEMMY_REFLECTION; // reflection ENABLED
  try {
    // 5 derived (trust 0.6) depth-0 sources at the default importance 5 → demotable.
    const derived = [];
    for (let i = 0; i < 5; i += 1) {
      derived.push(rememberFact({ kind: 'user', content: `Derived signal number ${i} observed from a tool return`, importance: 5, trustLevel: 0.6 }));
    }
    // A user-STATED fact (trust 1.0) and a pinned source must NOT be demoted.
    const userStated = rememberFact({ kind: 'user', content: 'User explicitly stated a standing preference here', importance: 5, trustLevel: 1.0 });
    const pinnedSrc = rememberFact({ kind: 'user', content: 'A pinned standing-rule source fact', importance: 5, trustLevel: 0.6 });
    setFactPinned(pinnedSrc.id, true);

    // Deterministic extractor → one higher-order pattern, token-disjoint from the
    // sources so findSimilarFacts returns nothing → resolveConflict ADDs (no network).
    const stub = async () => ({ patterns: [{ text: 'ZZZ QQQ XYZZY consolidated rollup token', importance: 7 }] });
    const result = await runRecursiveReflection({ extractor: stub as never });

    assert.ok(result.patternsWritten >= 1, 'a higher-order pattern was written');
    assert.equal(result.sourcesDemoted, 5, 'only the 5 derived depth-0 sources are demoted');
    for (const f of derived) assert.equal(getFact(f.id)?.importance, 3, 'derived source clamped down to 3');
    assert.equal(getFact(userStated.id)?.importance, 5, 'user-stated (trust 1.0) source untouched');
    assert.equal(getFact(pinnedSrc.id)?.importance, 5, 'pinned source untouched');
    const rollup = openMemoryDb().prepare("SELECT id, derivation_depth, derived_from_fact_ids FROM consolidated_facts WHERE content = 'ZZZ QQQ XYZZY consolidated rollup token'")
      .get() as { id: number; derivation_depth: number; derived_from_fact_ids: string } | undefined;
    assert.ok(rollup);
    assert.equal(rollup!.derivation_depth, 1);
    assert.deepEqual(
      (JSON.parse(rollup!.derived_from_fact_ids) as number[]).sort((a, b) => a - b),
      [...derived.map((fact) => fact.id), userStated.id, pinnedSrc.id].sort((a, b) => a - b),
    );
    const evidence = getFactEvidence(rollup!.id);
    assert.equal(evidence.length, 1);
    assert.match(evidence[0].excerpt, new RegExp(`\\[fact:${derived[0].id}\\] Derived signal number 0`));
    assert.doesNotMatch(evidence[0].excerpt, /ZZZ QQQ XYZZY/, 'the generated pattern is never used as its own evidence');
    const lifecycle = openMemoryDb().prepare(`
      SELECT status, reason, resulting_fact_id FROM memory_reflection_candidates
      WHERE text = 'ZZZ QQQ XYZZY consolidated rollup token'
    `).get() as { status: string; reason: string; resulting_fact_id: number } | undefined;
    assert.deepEqual(lifecycle, { status: 'promoted', reason: 'consolidation:add', resulting_fact_id: rollup!.id });
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prev;
  }
});

test('consolidateFact: semantic NOOP keeps one canonical fact and attaches the new source episode', async () => {
  resetMemoryDb();
  const originalEpisode = recordMemoryEpisode({
    kind: 'tool_result', sessionId: 'noop-evidence', callId: 'crm', sourceUri: 'crm://contact/dana',
    content: 'Dana Smith is the billing contact for Acme.',
  });
  const original = rememberFact({
    kind: 'project', content: 'Dana Smith is Acme’s billing contact.',
    derivedFrom: { sessionId: 'noop-evidence', callId: 'crm', tool: 'crm_lookup' },
  });
  assert.equal(getFactEvidence(original.id)[0]?.episodeId, originalEpisode.id);

  const meetingEpisode = recordMemoryEpisode({
    kind: 'tool_result', sessionId: 'noop-evidence', callId: 'meeting', sourceUri: 'recording://local/acme-review',
    content: 'In today’s meeting, Dana Smith was confirmed as the Acme billing contact.',
  });
  const outcome = await consolidateFact({
    kind: 'project', text: 'The billing contact at Acme is Dana Smith.', trustLevel: 0.8, authority: 'derived',
  }, {
    sessionId: 'noop-evidence',
    derivedFrom: { sessionId: 'noop-evidence', callId: 'meeting', tool: 'meeting_transcript' },
  }, {
    resolver: async () => ({ decision: 'NOOP', target_id: original.id }),
  });

  assert.equal(outcome.action, 'ignore');
  assert.equal(outcome.factId, original.id);
  assert.equal((openMemoryDb().prepare('SELECT COUNT(*) AS count FROM consolidated_facts WHERE active = 1').get() as { count: number }).count, 1);
  const evidence = getFactEvidence(original.id);
  assert.deepEqual(new Set(evidence.map((item) => item.episodeId)), new Set([
    originalEpisode.id, meetingEpisode.id,
  ]));
  assert.ok(evidence.some((item) => /today’s meeting/.test(item.excerpt)));
  assert.ok(evidence.some((item) => item.episodeId === meetingEpisode.id && item.sourceUri === 'recording://local/acme-review'));
  assert.equal(getFact(original.id)?.trustLevel, 0.8);
});

test('isSelfReferentialTool: denies Clementine introspective tools, keeps real-data tools', () => {
  // Self/introspective → denied (no reflection).
  for (const t of [
    'memory_read', 'memory_recall', 'memory_search', 'memory_search_facts',
    'memory_list_facts', 'memory_remember', 'memory_forget',
    'recall_tool_result', 'tool_output_query', 'draft_plan',
    'task_list', 'task_get', 'task_create', 'task_update',
    'workflow_get', 'workflow_list', 'workflow_schedule', 'workflow_step',
    'background_task_status', 'execution_get', 'execution_list',
    'unified_recall',
    'goal_get', 'goal_list', 'goal_status',
    'space_get', 'space_get_runner', 'space_get_view', 'attempt_record',
    // Clem's own scratchpad + ephemeral status pollers.
    'focus_get', 'focus_set', 'focus_park', 'browser_harness_status',
    'MEMORY_READ', // case-insensitive
    'FOCUS_GET',   // case-insensitive
  ]) {
    assert.equal(isSelfReferentialTool(t), true, `${t} should be denied`);
  }
  // Real user/external data → kept reflectable.
  for (const t of [
    'read_file', 'run_shell_command', 'skill_read', 'workflow_run',
    'firecrawl_search', 'OUTLOOK_SEND_EMAIL', 'SALESFORCE_GET_RECORD',
    'composio_execute_tool',
    // goal_create / goal_draft carry the user's STATED goal text — reflectable.
    'goal_create', 'goal_draft',
    null, undefined, '',
  ]) {
    assert.equal(isSelfReferentialTool(t as string | null | undefined), false, `${t} should be reflectable`);
  }
});

test('reflectOnToolReturn: a self-tool return is skipped before the extractor (no fact written)', async () => {
  resetMemoryDb();
  const prevReflect = process.env.CLEMMY_REFLECTION;
  const prevSelf = process.env.CLEMMY_REFLECT_SELF_TOOLS;
  delete process.env.CLEMMY_REFLECTION;        // reflection ENABLED
  delete process.env.CLEMMY_REFLECT_SELF_TOOLS; // filter at default (ON)
  try {
    // Output is well over REFLECTION_MIN_CONTENT_CHARS so only the self-tool
    // gate (not the too_short gate) can produce the skip — and it returns
    // BEFORE runExtractor, so no model call happens.
    const longOutput = 'recalled fact: '.repeat(40);
    const res = await reflectOnToolReturn({
      sessionId: 'sess-self-tool',
      callId: 'call-1',
      tool: 'memory_read',
      output: longOutput,
    });
    assert.equal(res.skipped, 'self_tool', 'memory_read return must short-circuit as self_tool');
    assert.equal(res.factsWritten, 0, 'no fact written from a self-tool reflection');
  } finally {
    if (prevReflect === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prevReflect;
    if (prevSelf === undefined) delete process.env.CLEMMY_REFLECT_SELF_TOOLS; else process.env.CLEMMY_REFLECT_SELF_TOOLS = prevSelf;
  }
});

test('reflectOnToolReturn: a focus_get return is skipped before the extractor (no model call)', async () => {
  resetMemoryDb();
  const prevReflect = process.env.CLEMMY_REFLECTION;
  const prevSelf = process.env.CLEMMY_REFLECT_SELF_TOOLS;
  delete process.env.CLEMMY_REFLECTION;
  delete process.env.CLEMMY_REFLECT_SELF_TOOLS;
  try {
    // focus_get returns the full plan/focus blob — well over the too_short gate,
    // so ONLY the self_tool gate can produce the skip, and it returns BEFORE
    // runExtractor (no model call, no 12-27s stall).
    const longFocusBlob = 'plan step: gather data before validate. '.repeat(30);
    const res = await reflectOnToolReturn({
      sessionId: 'sess-focus',
      callId: 'call-focus-1',
      tool: 'focus_get',
      output: longFocusBlob,
    });
    assert.equal(res.skipped, 'self_tool', 'focus_get must short-circuit as self_tool before the extractor');
    assert.equal(res.factsWritten, 0, 'no fact written from a focus_get reflection');
  } finally {
    if (prevReflect === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prevReflect;
    if (prevSelf === undefined) delete process.env.CLEMMY_REFLECT_SELF_TOOLS; else process.env.CLEMMY_REFLECT_SELF_TOOLS = prevSelf;
  }
});

test('scheduleReflection: serial queue drains self-tool returns without concurrent extractor calls', async () => {
  resetMemoryDb();
  const prevReflect = process.env.CLEMMY_REFLECTION;
  const prevSerial = process.env.CLEMMY_REFLECTION_SERIAL;
  const prevSelf = process.env.CLEMMY_REFLECT_SELF_TOOLS;
  delete process.env.CLEMMY_REFLECTION;
  delete process.env.CLEMMY_REFLECTION_SERIAL; // serial ON (default)
  delete process.env.CLEMMY_REFLECT_SELF_TOOLS;
  try {
    // Enqueue several self-tool reflections. They short-circuit (self_tool) so
    // no real model call fires, but they still exercise the FIFO chain: each
    // increments pending on enqueue and decrements as the chain drains. After a
    // microtask flush the queue must be fully drained (pending back to 0).
    const longBlob = 'recalled fact: '.repeat(40);
    for (let i = 0; i < 5; i += 1) {
      scheduleReflection({ sessionId: 'sess-serial', callId: `c-${i}`, tool: 'focus_get', output: longBlob });
    }
    assert.ok(_testOnly_reflectionPending() > 0, 'reflections should be queued synchronously on enqueue');
    // Let the serial chain drain.
    for (let i = 0; i < 10 && _testOnly_reflectionPending() > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(_testOnly_reflectionPending(), 0, 'serial queue must fully drain');
  } finally {
    if (prevReflect === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prevReflect;
    if (prevSerial === undefined) delete process.env.CLEMMY_REFLECTION_SERIAL; else process.env.CLEMMY_REFLECTION_SERIAL = prevSerial;
    if (prevSelf === undefined) delete process.env.CLEMMY_REFLECT_SELF_TOOLS; else process.env.CLEMMY_REFLECT_SELF_TOOLS = prevSelf;
  }
});


test('consolidateActiveFacts (stored embeddings): full-coverage pairwise dedup keeps the higher-scored fact', async () => {
  resetMemoryDb();
  _setEmbeddingProviderForTest({
    name: 'test',
    model: 'test',
    dim: 4,
    async embed(texts) {
      return texts.map(() => new Float32Array(4));
    },
  });
  const db = openMemoryDb();
  const embed = db.prepare(`INSERT INTO fact_embeddings (fact_id, model, dim, vector, content_hash, created_at)
                            VALUES (?, 'test', 4, ?, ?, datetime('now'))`);
  const setVec = (id: number, arr: number[]) => embed.run(id, vectorToBuffer(Float32Array.from(arr)), factContentHash(id));

  // A and B are near-duplicates (identical vector); B has the higher score → A is dropped.
  const a = rememberFact({ kind: 'project', content: 'Quarterly revenue target is 2M.', score: 1.0 });
  const b = rememberFact({ kind: 'project', content: 'The quarterly revenue goal is two million.', score: 1.5 });
  const c = rememberFact({ kind: 'project', content: 'Office relocation planned for spring.', score: 1.0 });
  setVec(a.id, [1, 0, 0, 0]);
  setVec(b.id, [1, 0, 0, 0]);
  setVec(c.id, [0, 1, 0, 0]);

  const res = await consolidateActiveFacts({ useStoredEmbeddings: true, simThreshold: 0.95 });
  assert.ok(res.merged >= 1, 'at least one near-duplicate is folded');
  assert.ok(res.ids.includes(a.id), 'the lower-scored duplicate (A) is dropped');
  assert.equal(getFact(a.id)?.active, false, 'A is soft-deleted');
  assert.equal(getFact(b.id)?.active, true, 'the higher-scored B is kept');
  assert.equal(getFact(c.id)?.active, true, 'the distinct fact C is untouched');
});

test('consolidateActiveFacts (entity guard): never folds two facts about DISTINCT entities even at cosine 1.0', async () => {
  resetMemoryDb();
  _setEmbeddingProviderForTest({
    name: 'test',
    model: 'test',
    dim: 4,
    async embed(texts) {
      return texts.map(() => new Float32Array(4));
    },
  });
  const db = openMemoryDb();
  const embed = db.prepare(`INSERT INTO fact_embeddings (fact_id, model, dim, vector, content_hash, created_at)
                            VALUES (?, 'test', 4, ?, ?, datetime('now'))`);
  const setVec = (id: number, arr: number[]) => embed.run(id, vectorToBuffer(Float32Array.from(arr)), factContentHash(id));

  // Two distinct fictional organizations with identical phrasing and vectors
  // reproduce the cross-client data-loss class without customer identity.
  // Without the entity guard the older fact ties on score and is soft-deleted,
  // corrupting recall for one client. The
  // guard (extractAnchors/canMergeEntitySafe, shared with the paraphrase merge)
  // must keep BOTH.
  const exampleLegal = rememberFact({ kind: 'project', content: 'Example Legal Group ranks #3 for PI Birmingham.', score: 1.0 });
  const sampleLaw = rememberFact({ kind: 'project', content: 'Sample Law Partners ranks #3 for PI Birmingham.', score: 1.0 });
  setVec(exampleLegal.id, [1, 0, 0, 0]);
  setVec(sampleLaw.id, [1, 0, 0, 0]);

  const res = await consolidateActiveFacts({ useStoredEmbeddings: true, simThreshold: 0.95 });
  assert.equal(res.merged, 0, 'distinct-entity facts are NOT folded despite cosine 1.0');
  assert.equal(getFact(exampleLegal.id)?.active, true, 'Example Legal survives');
  assert.equal(getFact(sampleLaw.id)?.active, true, 'Sample Law survives');
});

test('consolidateActiveFacts (stored embeddings): makes ZERO new embed API calls (uses stored vectors)', async () => {
  resetMemoryDb();
  const db = openMemoryDb();
  // No OPENAI key in this test env + no stored vectors for these facts → the
  // stored path simply finds nothing to compare and never calls the API.
  rememberFact({ kind: 'user', content: 'A fact with no embedding yet.' });
  const res = await consolidateActiveFacts({ useStoredEmbeddings: true });
  assert.equal(res.merged, 0, 'un-embedded facts are skipped, not re-embedded');
});


test('runRecursiveReflection: a FAILING extractor is counted as groupsFailed (not a silent quiet week)', async () => {
  resetMemoryDb();
  const prev = process.env.CLEMMY_REFLECTION; delete process.env.CLEMMY_REFLECTION;
  try {
    for (let i = 0; i < 6; i += 1) rememberFact({ kind: 'project', content: `Distinct roadmap signal number ${i} for synthesis.` });
    const res = await runRecursiveReflection({ extractor: async () => null }); // simulate broken synthesizer
    assert.ok(res.groupsFailed >= 1, 'a null extractor return is a FAILED group, not low-signal');
    assert.equal(res.patternsWritten, 0);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prev;
  }
});

test('runRecursiveReflection: an EMPTY extractor is a low-signal week (processed, 0 failed)', async () => {
  resetMemoryDb();
  const prev = process.env.CLEMMY_REFLECTION; delete process.env.CLEMMY_REFLECTION;
  try {
    for (let i = 0; i < 6; i += 1) rememberFact({ kind: 'project', content: `Distinct low-signal fact number ${i}.` });
    const res = await runRecursiveReflection({ extractor: async () => ({ patterns: [] }) });
    assert.equal(res.groupsFailed, 0, 'an empty-but-successful extractor is NOT a failure');
    assert.ok(res.groupsProcessed >= 1, 'the group was processed (ran fine, nothing to synthesize)');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prev;
  }
});


test('getResolverStats: a novel fact tallies as an ADD (resolver observability)', async () => {
  resetMemoryDb();
  _resetResolverStatsForTest();
  const prev = process.env.CLEMMY_REFLECTION; delete process.env.CLEMMY_REFLECTION;
  try {
    // A novel fact (no similar existing facts) takes the novelty fast-path → ADD,
    // no LLM resolver call — deterministic in the test env.
    const out = await consolidateFact({ kind: 'user', text: 'Alexander keeps a standing 9am Monday review.' });
    assert.equal(out.written, 1, 'novel fact is added');
    const stats = getResolverStats();
    assert.ok(stats.add >= 1, 'the ADD decision is tallied');
    assert.equal(stats.update + stats.delete + stats.noop, 0, 'no update/delete/noop for a novel add');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_REFLECTION; else process.env.CLEMMY_REFLECTION = prev;
  }
});

test('consolidateFact: resolver DELETE on a pinned fact is blocked — fact stays active, candidate ADDed', async () => {
  resetMemoryDb();
  const prot = rememberFact({ kind: 'feedback', content: 'Never send Acme mail from legacy-mail.example.' });
  setFactPinned(prot.id, true);
  const out = await consolidateFact(
    { kind: 'feedback', text: 'Sending Acme mail from legacy-mail.example is fine now.' },
    {},
    { resolver: async () => ({ decision: 'DELETE', target_id: prot.id }) },
  );
  const reloaded = getFact(prot.id);
  assert.equal(reloaded?.active, true, 'pinned fact survives a resolver DELETE');
  assert.equal(reloaded?.pinned, true, 'still pinned');
  assert.equal(out.deleted, 0, 'no delete tallied');
  assert.equal(out.written, 1, 'candidate falls through to the conservative ADD');
});

test('consolidateFact: resolver UPDATE on a pinned fact is blocked — content unchanged, candidate ADDed', async () => {
  resetMemoryDb();
  const content = 'Always route Acme sends through corp.example.';
  const prot = rememberFact({ kind: 'feedback', content });
  setFactPinned(prot.id, true);
  const out = await consolidateFact(
    { kind: 'feedback', text: 'Acme sends can route through any connection.' },
    {},
    { resolver: async () => ({ decision: 'UPDATE', target_id: prot.id, rewrite: 'Acme sends can route through any connection.' }) },
  );
  assert.equal(getFact(prot.id)?.content, content, 'pinned content is untouched');
  assert.equal(out.updated, 0, 'no update tallied');
  assert.equal(out.written, 1, 'candidate falls through to the conservative ADD');
});

test('consolidateFact: an explicit user correction supersedes pinned policy and preserves history', async () => {
  resetMemoryDb();
  const original = rememberFact({
    kind: 'constraint',
    content: 'Always send Atlas updates from the legacy@example.com Outlook mailbox.',
    occurredAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(getFact(original.id)?.pinned, true);

  const out = await consolidateFact(
    {
      kind: 'constraint',
      text: 'Always send Atlas updates from the operations@example.com Outlook mailbox.',
      trustLevel: 1,
      authority: 'user',
      occurredAt: '2026-07-15T00:00:00.000Z',
      pin: true,
    },
    { sessionId: 'user-correction' },
    {
      resolver: async () => ({
        decision: 'UPDATE',
        target_id: original.id,
        rewrite: 'Always send Atlas updates from the operations@example.com Outlook mailbox.',
      }),
    },
  );

  assert.equal(out.action, 'supersede');
  assert.equal(out.supersededFactId, original.id);
  assert.equal(getFact(original.id)?.active, false, 'the stale policy remains historical');
  assert.equal(getFact(original.id)?.supersededByFactId, out.factId);
  const replacement = getFact(out.factId!);
  assert.equal(replacement?.active, true);
  assert.equal(replacement?.pinned, true, 'standing protection transfers to the corrected policy');
  const policy = openMemoryDb().prepare('SELECT policy_type, enforcement FROM memory_policies WHERE fact_id = ?')
    .get(out.factId!) as { policy_type: string; enforcement: string };
  assert.deepEqual(policy, { policy_type: 'hard_constraint', enforcement: 'dispatch' });
});

test('consolidateFact: oversized resolver rewrite falls back to candidate text', async () => {
  resetMemoryDb();
  const target = rememberFact({ kind: 'project', content: 'Quarterly revenue target is 1M.' });
  const out = await consolidateFact(
    { kind: 'project', text: 'Quarterly revenue target is 2M.' },
    {},
    { resolver: async () => ({ decision: 'UPDATE', target_id: target.id, rewrite: 'x'.repeat(501) }) },
  );
  assert.equal(out.updated, 1, 'unpinned target is updated');
  const historical = getFact(target.id);
  assert.equal(historical?.content, 'Quarterly revenue target is 1M.', 'old claim is preserved for historical recall');
  assert.equal(historical?.active, false, 'old claim is closed');
  assert.ok(historical?.supersededByFactId, 'old claim points to its replacement');
  assert.equal(getFact(historical!.supersededByFactId!)?.content, 'Quarterly revenue target is 2M.', 'cap rejects the 501-char rewrite in favor of a new temporal claim');
});

// Cleanup
process.on('exit', () => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('replayFailedReflections re-runs failed receipts from durable tool_outputs raw', async () => {
  resetMemoryDb();
  const { replayFailedReflections, setReflectionExtractorPauseForTest } = await import('./reflection.js');
  const { writeToolOutput, createSession: createHarnessSession } = await import('../runtime/harness/eventlog.js');
  const priorThreshold = process.env.CLEMMY_REFLECTION_THRESHOLD;
  process.env.CLEMMY_REFLECTION_THRESHOLD = '0';
  let extractorCalls = 0;
  const input = {
    sessionId: 'sess-replay-drain',
    callId: 'call-replay-drain',
    tool: 'composio_execute_tool',
    output: 'durable connector output worth learning from '.repeat(40),
  };
  try {
    setReflectionExtractorPauseForTest(null);
    // Seed the durable raw exactly as the harness does at tool return.
    try { createHarnessSession({ id: input.sessionId, kind: 'chat' }); } catch { /* may exist */ }
    writeToolOutput({ sessionId: input.sessionId, callId: input.callId, tool: input.tool, output: input.output });
    // First pass fails (extractor down) → failed receipt.
    _testOnly_setReflectionExtractor(async () => { extractorCalls += 1; return null; });
    assert.equal((await reflectOnToolReturn(input)).skipped, 'extractor_failed');
    assert.equal(readReflectionReplayHealth().failed, 1);

    // Extractor recovers → the maintenance drain replays it to completion.
    _testOnly_setReflectionExtractor(async () => { extractorCalls += 1; return { facts: [], entities: [], pointers: [] }; });
    const result = await replayFailedReflections();
    assert.equal(result.scanned, 1);
    assert.equal(result.replayed, 1);
    assert.equal(result.rawGone, 0);
    assert.equal(extractorCalls, 2);
    assert.equal(readReflectionReplayHealth().failed, 0, 'the failed receipt was recovered');
    assert.equal(readReflectionReplayHealth().completed, 1);
  } finally {
    _testOnly_setReflectionExtractor(null);
    setReflectionExtractorPauseForTest(null);
    if (priorThreshold === undefined) delete process.env.CLEMMY_REFLECTION_THRESHOLD; else process.env.CLEMMY_REFLECTION_THRESHOLD = priorThreshold;
  }
});

test('replayFailedReflections terminalizes receipts whose raw has expired', async () => {
  resetMemoryDb();
  const { replayFailedReflections, setReflectionExtractorPauseForTest } = await import('./reflection.js');
  const priorThreshold = process.env.CLEMMY_REFLECTION_THRESHOLD;
  process.env.CLEMMY_REFLECTION_THRESHOLD = '0';
  const input = {
    sessionId: 'sess-replay-gone',
    callId: 'call-replay-gone',
    tool: 'composio_execute_tool',
    output: 'output that will not be durably stored '.repeat(40),
  };
  try {
    setReflectionExtractorPauseForTest(null);
    let calls = 0;
    _testOnly_setReflectionExtractor(async () => { calls += 1; return null; });
    assert.equal((await reflectOnToolReturn(input)).skipped, 'extractor_failed');
    // No tool_outputs row was written → the drain terminalizes, never replays.
    _testOnly_setReflectionExtractor(async () => { calls += 1; return { facts: [], entities: [], pointers: [] }; });
    const result = await replayFailedReflections();
    assert.equal(result.rawGone, 1);
    assert.equal(result.replayed, 0);
    assert.equal(calls, 1, 'no extractor call without raw input');
    const again = await replayFailedReflections();
    assert.equal(again.scanned, 0, 'terminalized receipt is not rescanned');
  } finally {
    _testOnly_setReflectionExtractor(null);
    setReflectionExtractorPauseForTest(null);
    if (priorThreshold === undefined) delete process.env.CLEMMY_REFLECTION_THRESHOLD; else process.env.CLEMMY_REFLECTION_THRESHOLD = priorThreshold;
  }
});

test('the extractor backoff window short-circuits both reflection and the replay drain', async () => {
  resetMemoryDb();
  const { replayFailedReflections, setReflectionExtractorPauseForTest, reflectionExtractorAvailable } = await import('./reflection.js');
  try {
    setReflectionExtractorPauseForTest(Date.now() + 60_000);
    assert.equal(reflectionExtractorAvailable(), false);
    const result = await replayFailedReflections();
    assert.deepEqual(result, { scanned: 0, replayed: 0, rawGone: 0 }, 'drain no-ops during the pause');
  } finally {
    setReflectionExtractorPauseForTest(null);
  }
});
