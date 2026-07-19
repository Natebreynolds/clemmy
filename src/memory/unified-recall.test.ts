/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-test-unified npx tsx --test src/memory/unified-recall.test.ts
 *
 * WS4 — unified recall facade. One objective fans out to facts, vault, entities,
 * resources, and tool-recall, ranked together. No embedding provider in the test
 * (no key, local absent) so facts/vault use their lexical paths — deterministic.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-unified';
process.env.CLEMENTINE_HOME = TEST_HOME;
delete process.env.OPENAI_API_KEY;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off'; // force lexical, fully offline + deterministic

// eslint-disable-next-line import/first
const { openMemoryDb, resetMemoryDb } = await import('./db.js');
// eslint-disable-next-line import/first
const { rememberFact, supersedeFact } = await import('./facts.js');
// eslint-disable-next-line import/first
const { upsertEntity } = await import('./reflection.js');
// eslint-disable-next-line import/first
const { upsertResourcePointer } = await import('./source-map.js');
// eslint-disable-next-line import/first
const { rememberToolChoice } = await import('./tool-choice-store.js');
// eslint-disable-next-line import/first
const { recallEverything, formatUnifiedRecall, visibleUnifiedRecallHits } = await import('./unified-recall.js');
// eslint-disable-next-line import/first
const { recallMemory, recallUtilityBonus } = await import('./recall-memory.js');
// eslint-disable-next-line import/first
const { recordRecallRun, recordRecallUse } = await import('./recall-usage.js');
// eslint-disable-next-line import/first
const { setFactEntityLinks, setFactResourceLinks } = await import('./relations.js');
// eslint-disable-next-line import/first
const { linkFactEvidence, recordMemoryEpisode } = await import('./temporal-memory.js');

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => { resetMemoryDb(); });

test('recallEverything fans out across stores and ranks them together', async () => {
  rememberFact({ kind: 'project', content: 'The Acme renewal closes at the end of the quarter.' });
  upsertEntity({ type: 'company', name: 'Acme' });
  upsertResourcePointer({ app: 'Salesforce', kind: 'object', name: 'Acme renewal opportunity', whatsHere: 'the Acme renewal deal record' });
  rememberToolChoice({ intent: 'query salesforce opportunities', choice: { kind: 'cli', identifier: 'sf', testedAt: new Date().toISOString() } });

  const result = await recallEverything('Acme renewal in salesforce', { limit: 20 });
  const types = new Set(result.hits.map((h) => h.type));
  assert.ok(types.has('fact'), 'a fact hit');
  assert.ok(types.has('entity'), 'an entity hit (Acme)');
  assert.ok(types.has('resource'), 'a resource hit (the SF opportunity)');
  // Hits are sorted by fused score descending.
  for (let i = 1; i < result.hits.length; i++) {
    assert.ok(result.hits[i - 1].score >= result.hits[i].score, 'descending fused score');
  }
  assert.ok((result.perStore.entity ?? 0) >= 1);
});

test('empty objective returns no hits', async () => {
  rememberFact({ kind: 'user', content: 'Something.' });
  const result = await recallEverything('   ');
  assert.equal(result.hits.length, 0);
});

test('stores filter restricts which stores participate', async () => {
  rememberFact({ kind: 'project', content: 'Acme renewal note.' });
  upsertEntity({ type: 'company', name: 'Acme' });
  const result = await recallEverything('Acme renewal', { stores: ['entity'] });
  assert.ok(result.hits.every((h) => h.type === 'entity'), 'only entity hits');
  assert.equal(result.perStore.fact, undefined, 'facts store not consulted');
});

test('formatUnifiedRecall produces a tagged, bounded block', async () => {
  upsertEntity({ type: 'company', name: 'Acme' });
  const result = await recallEverything('Acme', { stores: ['entity'] });
  const block = formatUnifiedRecall(result);
  assert.match(block, /RELEVANT MEMORY/);
  assert.match(block, /\[WHO\/WHAT\] \[ref entity:\d+\] Acme/);
});

test('visibleUnifiedRecallHits excludes candidates clipped from the bounded tool result', () => {
  const result = {
    objective: 'bounded refs',
    recallId: 'mr-test',
    perStore: { fact: 2 },
    answerability: 'supported' as const,
    hits: [
      { type: 'fact' as const, ref: '1', title: 'First', snippet: 'A'.repeat(80), score: 1 },
      { type: 'fact' as const, ref: '2', title: 'Second', snippet: 'B'.repeat(80), score: 0.9 },
    ],
  };
  const firstOnlyLimit = formatUnifiedRecall({ ...result, hits: [result.hits[0]] }).length;
  const visible = visibleUnifiedRecallHits(result, firstOnlyLimit);
  assert.deepEqual(visible.map((hit) => hit.ref), ['1']);
  assert.doesNotMatch(formatUnifiedRecall({ ...result, hits: visible }, firstOnlyLimit), /ref fact:2/);
});

test('recallMemory traverses persisted entity links, not text guesses', async () => {
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const linked = rememberFact({ kind: 'project', content: 'The renewal closes on September 30.' });
  setFactEntityLinks(linked.id, [acme]);

  const result = await recallMemory('Acme', { stores: ['fact', 'entity'], graphDepth: 1, limit: 10 });
  const hit = result.hits.find((item) => item.ref.type === 'fact' && item.ref.id === String(linked.id));
  assert.ok(hit, 'the fact is recalled through its stored entity edge despite not naming Acme');
  assert.ok(hit?.whyRecalled.includes('stored graph traversal'));
});

test('recallMemory does not graduate persisted text-match links into graph truth', async () => {
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const guessed = rememberFact({ kind: 'project', content: 'The renewal closes on October 15.' });
  setFactEntityLinks(guessed.id, [acme], { linkType: 'inferred_text', confidence: 0.55 });

  const result = await recallMemory('Acme', { stores: ['fact', 'entity'], graphDepth: 1, limit: 10 });
  const hit = result.hits.find((item) => item.ref.type === 'fact' && item.ref.id === String(guessed.id));
  assert.ok(!hit?.whyRecalled.includes('stored graph traversal'), 'a saved text guess is never explained or ranked as a stored relation');
});

test('a recalled fact expands back to its stored people, resources, and evidence episode', async () => {
  const person = upsertEntity({ type: 'person', name: 'Dana Whitlock' });
  const resource = upsertResourcePointer({
    app: 'Drive',
    kind: 'folder',
    name: 'Executive decision archive',
    whatsHere: 'signed launch decisions',
  });
  const fact = rememberFact({ kind: 'project', content: 'Waypoint-771 launch decision is approved.' });
  const episode = recordMemoryEpisode({
    kind: 'import',
    title: 'Launch decision record',
    sourceApp: 'In-person recorder',
    sourceUri: '/vault/meetings/waypoint-approval.md',
    occurredAt: '2026-07-10T18:00:00.000Z',
    content: 'Dana Whitlock approved the Waypoint-771 launch decision and filed it in the executive archive.',
  });
  linkFactEvidence({ factId: fact.id, episodeId: episode.id, excerpt: episode.evidence_excerpt ?? '', sourceUri: episode.source_uri });
  setFactEntityLinks(fact.id, [person], {
    linkType: 'extracted',
    confidence: 0.94,
    evidenceEpisodeId: episode.id,
    evidenceExcerpt: episode.evidence_excerpt ?? '',
  });
  setFactResourceLinks(fact.id, [resource.id], {
    linkType: 'extracted',
    confidence: 0.9,
    evidenceEpisodeId: episode.id,
    evidenceExcerpt: episode.evidence_excerpt ?? '',
  });

  const result = await recallMemory('What is the Waypoint-771 launch decision?', { graphDepth: 1, limit: 20 });
  const entity = result.hits.find((hit) => hit.ref.type === 'entity' && hit.ref.id === person);
  const resourceHit = result.hits.find((hit) => hit.ref.type === 'resource' && hit.ref.id === resource.id);
  const episodeHit = result.hits.find((hit) => hit.ref.type === 'episode' && hit.ref.id === episode.id);
  assert.ok(entity?.whyRecalled.includes('stored fact-to-entity relationship'));
  assert.ok(resourceHit?.whyRecalled.includes('stored fact-to-resource relationship'));
  assert.ok(episodeHit?.whyRecalled.includes('stored fact-to-evidence relationship'));
  assert.equal(entity?.evidence[0]?.episodeId, episode.id);
  assert.equal(resourceHit?.evidence[0]?.episodeId, episode.id);
});

test('a scoped entity/resource recall can use facts as invisible graph bridges', async () => {
  const person = upsertEntity({ type: 'person', name: 'Morgan Vale' });
  const resource = upsertResourcePointer({ app: 'Notion', kind: 'database', name: 'Executive approvals' });
  const fact = rememberFact({ kind: 'project', content: 'Aurora-cipher launch has final authorization.' });
  setFactEntityLinks(fact.id, [person], { linkType: 'stored' });
  setFactResourceLinks(fact.id, [resource.id], { linkType: 'stored' });

  const result = await recallMemory('Aurora-cipher launch authorization', {
    stores: ['entity', 'resource'],
    graphDepth: 1,
    limit: 10,
  });
  assert.ok(result.hits.some((hit) => hit.ref.type === 'entity' && hit.ref.id === person));
  assert.ok(result.hits.some((hit) => hit.ref.type === 'resource' && hit.ref.id === resource.id));
  assert.ok(result.hits.every((hit) => hit.ref.type === 'entity' || hit.ref.type === 'resource'));
});

test('fact-outward recall never traverses inferred text links', async () => {
  const guessedPerson = upsertEntity({ type: 'person', name: 'Taylor Guessed' });
  const guessedResource = upsertResourcePointer({ app: 'Drive', kind: 'folder', name: 'Guessed archive' });
  const fact = rememberFact({ kind: 'project', content: 'Nebula-884 launch decision is pending.' });
  setFactEntityLinks(fact.id, [guessedPerson], { linkType: 'inferred_text', confidence: 0.55 });
  setFactResourceLinks(fact.id, [guessedResource.id], { linkType: 'inferred_text', confidence: 0.55 });

  const result = await recallMemory('Nebula-884 launch decision', { graphDepth: 1, limit: 20 });
  assert.ok(!result.hits.some((hit) => hit.ref.type === 'entity' && hit.ref.id === guessedPerson));
  assert.ok(!result.hits.some((hit) => hit.ref.type === 'resource' && hit.ref.id === guessedResource.id));
});

test('two-hop graph recall reaches another fact through a shared stored entity', async () => {
  const company = upsertEntity({ type: 'company', name: 'Northstar Holdings' });
  const seed = rememberFact({ kind: 'project', content: 'Maple-cipher initiative begins Monday.' });
  const related = rememberFact({ kind: 'project', content: 'ZXQ-909 ledger authorization is complete.' });
  setFactEntityLinks(seed.id, [company], { linkType: 'stored' });
  setFactEntityLinks(related.id, [company], { linkType: 'stored' });

  const oneHop = await recallMemory('Maple-cipher initiative', { stores: ['fact'], graphDepth: 1, limit: 20 });
  const twoHop = await recallMemory('Maple-cipher initiative', { stores: ['fact'], graphDepth: 2, limit: 20 });
  assert.ok(!oneHop.hits.some((hit) => hit.ref.type === 'fact' && hit.ref.id === String(related.id)));
  assert.ok(twoHop.hits.some((hit) => hit.ref.type === 'fact' && hit.ref.id === String(related.id)));
});

test('resource recall reaches a relevant pointer beyond the former 500-row pool', async () => {
  const target = upsertResourcePointer({
    app: 'Drive',
    kind: 'folder',
    name: 'Zephyr quartz archive',
    whatsHere: 'the TAIL-RESOURCE-7782 recovery records',
  });
  for (let i = 0; i < 510; i++) {
    upsertResourcePointer({ app: 'Drive', kind: 'folder', name: `Recent unrelated folder ${i}` });
  }

  const result = await recallMemory('TAIL-RESOURCE-7782 recovery records', {
    stores: ['resource'],
    graphDepth: 0,
    limit: 5,
  });
  assert.ok(result.hits.some((hit) => hit.ref.type === 'resource' && hit.ref.id === target.id));
});

test('explicit material use breaks close cross-store ties without overpowering relevance', async () => {
  const first = upsertResourcePointer({
    app: 'Drive', kind: 'folder', name: 'Cobalt launch archive alpha',
    whatsHere: 'Cobalt launch archive alpha records',
  });
  const proven = upsertResourcePointer({
    app: 'Drive', kind: 'folder', name: 'Cobalt launch archive beta',
    whatsHere: 'Cobalt launch archive beta records',
  });
  const before = await recallMemory('Cobalt launch archive', {
    stores: ['resource'], graphDepth: 0, limit: 5,
  });
  assert.equal(before.hits[0]?.ref.type, 'resource');
  const baselineIds = before.hits
    .filter((hit) => hit.ref.type === 'resource')
    .map((hit) => hit.ref.id);
  assert.ok(baselineIds.includes(first.id));
  assert.ok(baselineIds.includes(proven.id));
  const targetId = baselineIds[0] === first.id ? proven.id : first.id;
  assert.notEqual(baselineIds[0], targetId, 'the target begins behind the incidental tie winner');
  const run = recordRecallRun({
    objective: 'Cobalt launch archive', surface: 'test', answerability: 'partial',
    candidateRefs: [{ type: 'resource', id: String(targetId) }],
  });
  recordRecallUse({ recallId: run.id, refs: [`resource:${targetId}`] });

  const result = await recallMemory('Cobalt launch archive', {
    stores: ['resource'], graphDepth: 0, limit: 5,
  });
  assert.equal(result.hits[0]?.ref.type, 'resource');
  assert.equal(result.hits[0]?.ref.id, targetId, 'proven utility breaks an otherwise equal relevance tie');
  assert.ok(result.hits[0]?.whyRecalled.includes('proven useful in 1 attributed recall'));
  assert.equal(result.diagnostics.utilityAdjusted, 1);

  const maxBonus = recallUtilityBonus({
    used: 1_000_000,
    notUseful: 0,
    lastUsedAt: new Date().toISOString(),
  });
  assert.equal(maxBonus, 0.08, 'utility can only nudge close results');
  assert.ok(
    recallUtilityBonus({ used: 10, notUseful: 10, lastUsedAt: new Date().toISOString() }) <
      recallUtilityBonus({ used: 10, notUseful: 0, lastUsedAt: new Date().toISOString() }),
    'explicit not-useful outcomes dampen but never invert the bonus',
  );
});

test('recallMemory considers a relevant fact beyond the former 500-row recency pool', async () => {
  const target = rememberFact({
    kind: 'reference',
    content: 'The zephyr-quartz recovery token is TAIL-7782.',
    occurredAt: '2020-01-01T00:00:00.000Z',
  });
  const db = openMemoryDb();
  const insert = db.prepare(`
    INSERT INTO consolidated_facts
      (kind, content, content_hash, score, active, created_at, updated_at,
       importance, valid_from, confidence)
    VALUES ('project', ?, ?, 1, 1, ?, ?, 5, ?, 1)
  `);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (let i = 0; i < 510; i++) {
      insert.run(`Recent unrelated filler ${i}.`, `filler-hash-${i}`, now, now, now);
    }
  });
  tx();

  const result = await recallMemory('zephyr quartz recovery token', {
    stores: ['fact'],
    graphDepth: 0,
    limit: 5,
  });
  assert.ok(result.hits.some((hit) => hit.ref.type === 'fact' && hit.ref.id === String(target.id)));
  assert.ok(result.diagnostics.candidates >= 1);
});

test('unified recall identifies constraints as dispatch-enforced policy memory', async () => {
  const rule = rememberFact({ kind: 'constraint', content: 'Always send Outlook email from legal@example.com.' });
  const result = await recallMemory('send Outlook email legal mailbox', { limit: 10 });
  const policy = result.hits.find((hit) => hit.ref.type === 'policy' && hit.ref.id === String(rule.id));
  assert.ok(policy);
  assert.ok(policy?.whyRecalled.includes('hard_constraint'));
  assert.ok(policy?.whyRecalled.includes('dispatch-enforced'));
  assert.ok(result.diagnostics.stores.includes('episode'));
  assert.ok(result.diagnostics.stores.includes('policy'));
});

test('uncompiled natural-language constraints stay prompt-only and out of the dispatch guard', async () => {
  const rule = rememberFact({ kind: 'constraint', content: 'Client reports should use plain-language vendor labels.' });
  const policy = openMemoryDb().prepare(`
    SELECT policy_type, enforcement, applies_to_json FROM memory_policies WHERE fact_id = ?
  `).get(rule.id) as { policy_type: string; enforcement: string; applies_to_json: string };
  assert.deepEqual(
    { policy_type: policy.policy_type, enforcement: policy.enforcement },
    { policy_type: 'standing_preference', enforcement: 'prompt' },
  );
  assert.equal(JSON.parse(policy.applies_to_json).deterministic, false);
});

test('unified recall searches every public memory store in one evidence pack', async () => {
  rememberFact({ kind: 'project', content: 'Orchid launch owner is Dana.' });
  rememberFact({ kind: 'constraint', content: 'Orchid publishing requires legal approval.' });
  upsertEntity({ type: 'project', name: 'Orchid' });
  upsertResourcePointer({ app: 'Drive', kind: 'folder', name: 'Orchid creative folder', whatsHere: 'campaign assets' });
  rememberToolChoice({ intent: 'review orchid campaign', choice: { kind: 'mcp', identifier: 'orchid__review_campaign', testedAt: new Date().toISOString() } });
  const note = 'Orchid meeting notes contain the creative brief and launch checklist.';
  openMemoryDb().prepare(`
    INSERT INTO vault_chunks (path, chunk_index, content, title, mtime, byte_size, content_hash)
    VALUES (?, 0, ?, ?, ?, ?, ?)
  `).run('/vault/projects/orchid.md', note, 'Orchid brief', Date.now(), Buffer.byteLength(note), 'orchid-note-hash');

  const result = await recallMemory('Orchid launch publishing legal creative campaign review', { limit: 30 });
  const types = new Set(result.hits.map((hit) => hit.ref.type));
  for (const type of ['fact', 'note', 'entity', 'resource', 'episode', 'policy', 'procedure'] as const) {
    assert.ok(types.has(type), `unified search includes ${type}`);
  }
});

test('unified recall promotes the exact recorded meeting for the two observed failed queries', async () => {
  rememberFact({ kind: 'project', content: 'User attends recurring in-person leadership meetings and offsites.' });
  const db = openMemoryDb();
  const meetingPath = '/vault/04-Meetings/2026-07-14-in-person_meeting-local-review.md';
  const insert = db.prepare(`
    INSERT INTO vault_chunks (path, chunk_index, content, title, mtime, byte_size, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const mtime = Date.parse('2026-07-14T17:17:50.000Z');
  const metadata = `---
type: meeting-transcript
source: local whisper (base.en)
recording_id: recording-in-person-review
title: Acme Partnership Revenue and Legal Data Integration Review
started_at: 2026-07-14T20:24:09.442Z
ended_at: 2026-07-14T21:10:00.000Z
---`;
  const summary = '## Summary\nInternal Acme team meeting reviewing partnership revenue against 2026 goals and legal data integration gaps.';
  insert.run(meetingPath, 0, metadata, null, mtime, Buffer.byteLength(metadata), 'meeting-metadata');
  insert.run(meetingPath, 1, summary, 'Summary', mtime, Buffer.byteLength(summary), 'meeting-summary');

  for (const query of [
    'What was the inperson meeting I had today about?',
    'I recorded a meeting today what was that',
  ]) {
    const result = await recallMemory(query, {
      limit: 8,
      now: '2026-07-15T01:25:12.839Z',
      timeZone: 'America/Los_Angeles',
    });
    const hit = result.hits[0];
    assert.equal(hit?.ref.type, 'note');
    assert.equal(hit?.ref.id, meetingPath);
    assert.equal(hit?.title, 'Acme Partnership Revenue and Legal Data Integration Review');
    assert.ok(hit?.whyRecalled.includes('exact temporal match'));
    assert.ok(hit?.whyRecalled.includes('recorded meeting source'));
    if (query.includes('inperson')) assert.ok(hit?.whyRecalled.includes('in-person capture match'));
    assert.equal(hit?.evidence[0]?.sourceUri, meetingPath);
    assert.match(hit?.text ?? '', /partnership revenue/);
  }
});

test('unified recall collapses a vault transcript and episode for the same recording', async () => {
  const db = openMemoryDb();
  const meetingId = 'local-logical-meeting-42';
  const meetingPath = `/vault/04-Meetings/2026-07-18-in-person_meeting-${meetingId}.md`;
  const metadata = `---
type: meeting-transcript
source: local whisper (base.en)
provider: local
meeting_id: ${meetingId}
title: Cobalt migration room review
started_at: 2026-07-18T20:24:00.000Z
---`;
  const summary = '## Summary\nThe team approved the Cobalt migration for Friday and assigned Dana to verify the customer data import before launch.';
  const insert = db.prepare(`
    INSERT INTO vault_chunks (path, chunk_index, content, title, mtime, byte_size, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(meetingPath, 0, metadata, null, Date.parse('2026-07-18T21:00:00.000Z'), Buffer.byteLength(metadata), 'logical-meeting-metadata');
  insert.run(meetingPath, 1, summary, 'Summary', Date.parse('2026-07-18T21:00:00.000Z'), Buffer.byteLength(summary), 'logical-meeting-summary');
  const episode = recordMemoryEpisode({
    kind: 'tool_result',
    subtype: 'meeting',
    title: 'Cobalt migration room review',
    sourceApp: 'Clementine Meetings (In-person)',
    sessionId: 'meeting:local',
    callId: meetingId,
    sourceUri: `meeting://local/${meetingId}`,
    occurredAt: '2026-07-18T20:24:00.000Z',
    content: 'Meeting: Cobalt migration room review\nCapture: In-person recording\nTranscript: The team approved the Cobalt migration for Friday and Dana will verify the customer data import before launch.',
  });

  const result = await recallMemory('What was the in-person meeting I had today about?', {
    now: '2026-07-18T23:00:00.000Z',
    timeZone: 'America/Los_Angeles',
    limit: 10,
  });
  const matching = result.hits.filter((hit) => hit.title === 'Cobalt migration room review');
  assert.equal(matching.length, 1, 'one logical recording occupies one result slot');
  assert.equal(matching[0]?.ref.type, 'episode', 'the first-class episode is the canonical representation');
  assert.equal(matching[0]?.ref.id, episode.id);
  assert.ok(matching[0]?.whyRecalled.includes('cross-store meeting representations collapsed'));
  assert.ok(matching[0]?.evidence.some((item) => item.sourceUri === meetingPath), 'vault artifact remains attached as evidence');
  assert.ok(matching[0]?.evidence.some((item) => item.sourceUri === `meeting://local/${meetingId}`), 'episode source remains attached as evidence');
  assert.equal(result.answerability, 'supported');
});

test('relative meeting episode filtering uses the requested user timezone end to end', async () => {
  const episode = recordMemoryEpisode({
    kind: 'import',
    subtype: 'meeting',
    title: 'Tokyo live recording review',
    sourceApp: 'In-person recorder',
    sourceUri: '/vault/04-Meetings/2026-07-15-tokyo-live-review.md',
    occurredAt: '2026-07-15T00:30:00.000Z',
    content: 'Reviewed the Tokyo launch, revenue target, and legal integration.',
  });

  const result = await recallMemory('What was my recorded meeting today about?', {
    stores: ['episode'],
    graphDepth: 0,
    limit: 5,
    now: '2026-07-15T01:30:00.000Z',
    timeZone: 'Asia/Tokyo',
  });
  assert.equal(result.hits[0]?.ref.type, 'episode');
  assert.equal(result.hits[0]?.ref.id, episode.id);
  assert.ok(result.hits[0]?.whyRecalled.includes('exact temporal match'));
  assert.ok(result.hits[0]?.whyRecalled.includes('in-person capture match'));
});

test('temporal meeting recall excludes same-day non-meeting distractors and abstains when no meeting exists', async () => {
  for (let index = 0; index < 6; index += 1) {
    recordMemoryEpisode({
      kind: 'manual',
      title: `Same-day project reflection ${index}`,
      occurredAt: `2026-07-15T1${index}:00:00.000Z`,
      content: `Project reflection ${index}: reviewed outbound operations and legal prospect research.`,
    });
  }
  const meeting = recordMemoryEpisode({
    kind: 'tool_result',
    subtype: 'meeting',
    title: 'Partnership revenue room review',
    sourceApp: 'Clementine Meetings (In-person)',
    sourceUri: 'meeting://local/partnership-room-review',
    occurredAt: '2026-07-15T20:24:00.000Z',
    content: 'Meeting: Partnership revenue room review\nCapture: In-person recording\nSummary: The team reviewed partnership revenue against annual targets and gaps in legal case-management data integrations.',
  });

  const found = await recallMemory('What was the meeting I had today about?', {
    limit: 10,
    now: '2026-07-15T23:00:00.000Z',
    timeZone: 'America/Los_Angeles',
  });
  assert.equal(found.answerability, 'supported');
  assert.equal(found.hits[0]?.ref.type, 'episode');
  assert.equal(found.hits[0]?.ref.id, meeting.id);
  assert.ok(found.hits.every((hit) => hit.whyRecalled.includes('exact temporal match')));
  assert.ok(found.hits.every((hit) => !hit.text.includes('outbound operations')));

  const absent = await recallMemory('What was the meeting I had today about?', {
    limit: 10,
    now: '2026-07-16T23:00:00.000Z',
    timeZone: 'America/Los_Angeles',
  });
  assert.equal(absent.answerability, 'insufficient');
  assert.deepEqual(absent.hits, []);
});

test('a same-day meeting with no usable transcript is partial, not falsely supported', async () => {
  recordMemoryEpisode({
    kind: 'tool_result',
    subtype: 'meeting',
    title: 'Untranscribed in-person meeting',
    sourceApp: 'Clementine Meetings (In-person)',
    sourceUri: 'meeting://local/untranscribed-room',
    occurredAt: '2026-07-17T20:24:00.000Z',
    content: 'Meeting: Untranscribed in-person meeting\nCapture: In-person recording\nSummary: Transcript too short to analyze.\nTranscript: You You',
  });
  const result = await recallMemory('What was the meeting I had today about?', {
    stores: ['episode'], graphDepth: 0,
    now: '2026-07-17T23:00:00.000Z', timeZone: 'America/Los_Angeles',
  });
  assert.equal(result.hits.length, 1, 'meeting existence remains visible');
  assert.equal(result.answerability, 'partial', 'insufficient content cannot support a topic answer');
  assert.ok(result.hits[0]?.whyRecalled.includes('recording exists; topic unavailable'));

  const existence = await recallMemory('Did I have a meeting today?', {
    stores: ['episode'], graphDepth: 0,
    now: '2026-07-17T23:00:00.000Z', timeZone: 'America/Los_Angeles',
  });
  assert.equal(existence.answerability, 'supported', 'the recording still proves that a meeting occurred');
});

test('topic recall ranks usable discussion above a later empty recording', async () => {
  const useful = recordMemoryEpisode({
    kind: 'tool_result', subtype: 'meeting', title: 'Cobalt launch review',
    sourceApp: 'Clementine Meetings (In-person)', sourceUri: 'meeting://local/cobalt-launch-review',
    occurredAt: '2026-07-19T18:00:00.000Z',
    content: 'Meeting: Cobalt launch review\nCapture: In-person recording\nSummary: The team approved the Friday launch and assigned Dana to validate the customer migration before release.',
  });
  recordMemoryEpisode({
    kind: 'tool_result', subtype: 'meeting', title: 'Later empty recorder test',
    sourceApp: 'Clementine Meetings (In-person)', sourceUri: 'meeting://local/later-empty-test',
    occurredAt: '2026-07-19T21:00:00.000Z',
    content: 'Meeting: Later empty recorder test\nCapture: In-person recording\nSummary: Transcript contained no discussion.',
  });

  const result = await recallMemory('What was my meeting today about?', {
    stores: ['episode'], graphDepth: 0,
    now: '2026-07-19T23:00:00.000Z', timeZone: 'America/Los_Angeles',
  });
  assert.equal(result.hits[0]?.ref.type, 'episode');
  assert.equal(result.hits[0]?.ref.id, useful.id);
  assert.equal(result.answerability, 'supported');
});

test('general episode recall filters yesterday in the user timezone', async () => {
  const yesterday = recordMemoryEpisode({
    kind: 'user_turn',
    title: 'Dana project note',
    sourceApp: 'Conversation',
    occurredAt: '2026-07-15T01:00:00.000Z', // July 14, 6pm in Los Angeles
    content: 'Dana said the Cobalt rollout needs a legal review.',
  });
  const today = recordMemoryEpisode({
    kind: 'user_turn',
    title: 'Dana follow-up',
    sourceApp: 'Conversation',
    occurredAt: '2026-07-15T16:00:00.000Z', // July 15, 9am in Los Angeles
    content: 'Dana said the Cobalt rollout is ready to publish.',
  });

  const result = await recallMemory('What did Dana tell me yesterday?', {
    stores: ['episode'],
    graphDepth: 0,
    limit: 10,
    now: '2026-07-15T17:00:00.000Z',
    timeZone: 'America/Los_Angeles',
  });
  assert.ok(result.hits.some((hit) => hit.ref.type === 'episode' && hit.ref.id === yesterday.id));
  assert.ok(!result.hits.some((hit) => hit.ref.type === 'episode' && hit.ref.id === today.id));
  assert.ok(result.hits[0]?.whyRecalled.includes('temporal window match: yesterday'));
});

test('relative as-of queries resolve fact history in the user timezone', async () => {
  const original = rememberFact({
    kind: 'project',
    content: 'The Cobalt rollout status is waiting for legal review.',
    occurredAt: '2026-07-13T18:00:00.000Z',
  });
  const current = supersedeFact(original.id, {
    content: 'The Cobalt rollout status is approved for publishing.',
    occurredAt: '2026-07-15T08:00:00.000Z', // July 15, 1am in Los Angeles
  });
  assert.ok(current);

  const result = await recallMemory('What was the Cobalt rollout status as of yesterday?', {
    stores: ['fact'],
    graphDepth: 0,
    limit: 10,
    now: '2026-07-15T17:00:00.000Z',
    timeZone: 'America/Los_Angeles',
  });
  assert.ok(result.hits.some((hit) => hit.ref.type === 'fact' && hit.ref.id === String(original.id)));
  assert.ok(!result.hits.some((hit) => hit.ref.type === 'fact' && hit.ref.id === String(current!.id)));
});

test('stored graph traversal respects fact validity for historical entity queries', async () => {
  const acme = upsertEntity({ type: 'company', name: 'Acme' });
  const old = rememberFact({
    kind: 'project',
    content: 'The renewal target was one million dollars.',
    occurredAt: '2025-01-01T00:00:00.000Z',
  });
  setFactEntityLinks(old.id, [acme]);
  const current = supersedeFact(old.id, {
    content: 'The renewal target is two million dollars.',
    occurredAt: '2025-02-01T00:00:00.000Z',
  });
  assert.ok(current);
  setFactEntityLinks(current!.id, [acme]);

  const result = await recallMemory('What did we know about Acme as of 2025-01-15?', {
    stores: ['fact', 'entity'],
    graphDepth: 1,
    limit: 10,
  });
  assert.ok(result.hits.some((hit) => hit.ref.type === 'fact' && hit.ref.id === String(old.id)));
  assert.ok(!result.hits.some((hit) => hit.ref.type === 'fact' && hit.ref.id === String(current!.id)));
});
