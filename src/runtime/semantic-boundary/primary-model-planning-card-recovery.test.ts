/**
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/runtime/semantic-boundary/primary-model-planning-card-recovery.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-primary-card-recovery-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_SEMANTIC_RECALL = 'off';

const eventlog = await import('../harness/eventlog.js');
const catalogs = await import('../harness/host-capability-catalog-factory.js');
const manifests = await import('../harness/capability-manifest.js');
const continuityStore = await import('../../memory/task-continuity.js');
const continuityRuntime = await import('../harness/task-continuity-runtime.js');
const semantic = await import('./admit-and-compile-accepted-source.js');

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const SNAPSHOT_TYPE = 'primary_model_planning_card_snapshot' as const;

function registerRead(input: {
  factory: ReturnType<typeof catalogs.createHostCapabilityCatalogFactory>;
  slug: string;
  purpose: string;
  fingerprint?: string;
}) {
  const fingerprint = input.fingerprint ?? sha256(`definition:${input.slug}`);
  const manifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:resolved:${input.slug.toLowerCase()}`,
    providerKind: 'reviewed_cli',
    operationId: input.slug,
    providerIdentity: `/usr/bin/${input.slug.toLowerCase()}`,
    providerVersion: '1',
    operationVersion: '1',
    definitionFingerprint: fingerprint,
    effect: 'read',
    accountId: 'host:runtime',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-31T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: [input.purpose],
  });
  const entry = {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    destination: manifest.destination,
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({ records: [{ title: input.purpose }], has_more: false }),
  };
  input.factory.register(entry);
  return entry;
}

function freshSource(label: string, turn = 1) {
  const session = eventlog.createSession({
    id: `primary-card-${label}`,
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Research the newest local LLM processing news.' },
  });
  return { session, source };
}

function resetFixture() {
  eventlog.resetEventLog();
  const factory = catalogs.createHostCapabilityCatalogFactory();
  catalogs.installHostCapabilityCatalogFactory(factory);
  return factory;
}

after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('same-source recovery reopens the exact initial card after new live capabilities appear', async () => {
  const factory = resetFixture();
  registerRead({ factory, slug: 'NEWS_LOOKUP', purpose: 'recent local LLM news research' });
  const { session, source } = freshSource('stable');

  const first = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(first.ok, true, first.ok ? '' : first.reason);
  if (!first.ok) return;
  assert.deepEqual(first.planning.capabilities.map((entry) => entry.id), [
    'cap:resolved:news_lookup',
  ]);
  const exactFirst = {
    capabilities: first.planning.capabilities,
    digest: first.planning.digest,
    effectCeiling: first.planning.effectCeiling,
    withheld: first.planning.withheld,
  };

  // This is the real drift class: same-turn discovery can add a more highly
  // ranked current row after the model was already armed. A fresh authority
  // must repopulate staging from current/durable facts without repacking the
  // displayed initial card.
  registerRead({ factory, slug: 'LOCAL_LLM_BREAKING_NEWS', purpose: 'newest local LLM processing news' });
  eventlog.closeEventLog();
  const replay = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(replay.ok, true, replay.ok ? '' : replay.reason);
  if (!replay.ok) return;
  assert.deepEqual({
    capabilities: replay.planning.capabilities,
    digest: replay.planning.digest,
    effectCeiling: replay.planning.effectCeiling,
    withheld: replay.planning.withheld,
  }, exactFirst);
  assert.equal(eventlog.listEvents(session.id, { types: [SNAPSHOT_TYPE] }).length, 1,
    'one immutable initial card survives repeated/fresh-store priming');
});

test('a one-byte A continuation freezes and ranks against the durable parent Q/A/B objective', async () => {
  const factory = resetFixture();
  for (const prefix of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH', 'III']) {
    registerRead({ factory, slug: `${prefix}_GENERIC_LOOKUP`, purpose: 'generic unrelated records' });
  }
  registerRead({
    factory,
    slug: 'ZZZ_LOCAL_LLM_NEWS',
    purpose: 'top recent news about local LLM processing',
  });
  const session = eventlog.createSession({ id: 'primary-card-one-byte-a', kind: 'chat' });
  const parentText = 'Research top recent news about local LLM processing, write five social posts, and put the calendar in a workspace.';
  const parent = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: parentText },
  });
  continuityStore.createTaskContinuityPacket({
    sessionId: session.id,
    originatingSourceUserSeq: parent.seq,
    pause: {
      kind: 'clarification',
      question: 'A) Accept the recommended technical-builder strategy, Q) explain it, or B) customize it?',
      options: [],
    },
    capabilities: [],
  });
  const answer = eventlog.appendEvent({
    sessionId: session.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'A', displayText: 'A' },
  });
  const enriched = await continuityRuntime.enrichAcceptedRequestWithTaskContinuity({
    sessionId: session.id,
    sourceUserSeq: answer.seq,
    message: 'A',
  }, answer.seq, { typedClassification: { disposition: 'affirmed' } });
  assert.equal(enriched.taskContinuationResolved, true);
  assert.ok(enriched.taskContinuation?.retrievalQuery.startsWith('[task-continuation:v2]'));

  const primed = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: answer.seq,
  });
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok || !enriched.taskContinuation) return;
  assert.ok(primed.planning.capabilities.some((entry) => entry.id === 'cap:resolved:zzz_local_llm_news'),
    'the parent task—not the literal one-byte answer—drives bounded retrieval ranking');
  const snapshot = eventlog.listEvents(session.id, { types: [SNAPSHOT_TYPE] })
    .find((event) => event.data.sourceUserSeq === answer.seq);
  assert.ok(snapshot);
  const payload = JSON.parse(String(snapshot.data.snapshotJson)) as { objectiveDigest?: string };
  assert.equal(payload.objectiveDigest, sha256(enriched.taskContinuation.retrievalQuery),
    'the immutable surface is bound to the same canonical Q/A/B semantic text as graph compilation');
});

test('missing snapshot after same-source progress is held instead of minted from a changed catalog', async () => {
  const factory = resetFixture();
  registerRead({ factory, slug: 'NEWS_LOOKUP', purpose: 'recent local LLM news research' });
  const { session, source } = freshSource('missing');
  eventlog.appendEvent({
    sessionId: session.id,
    turn: source.turn,
    role: 'system',
    type: 'capability_discovered',
    data: { sourceUserSeq: source.seq, capabilities: [] },
  });

  const replay = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.match(replay.reason, /snapshot is missing after this accepted source already progressed/);
  assert.equal(eventlog.listEvents(session.id, { types: [SNAPSHOT_TYPE] }).length, 0);
});

test('content-consistent corruption and a foreign source snapshot both fail closed', async () => {
  const factory = resetFixture();
  registerRead({ factory, slug: 'NEWS_LOOKUP', purpose: 'recent local LLM news research' });
  const { session, source } = freshSource('corrupt');
  const first = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(first.ok, true, first.ok ? '' : first.reason);
  const db = eventlog.openEventLog();
  const snapshot = db.prepare(`
    SELECT * FROM events WHERE session_id = ? AND type = ?
  `).get(session.id, SNAPSHOT_TYPE) as {
    id: string;
    data_json: string;
  };
  const envelope = JSON.parse(snapshot.data_json) as Record<string, unknown>;
  const corruptedPayload = JSON.stringify({ version: 1 });
  envelope.snapshotJson = corruptedPayload;
  envelope.snapshotDigest = sha256(corruptedPayload);
  db.prepare('UPDATE events SET data_json = ? WHERE id = ?').run(JSON.stringify(envelope), snapshot.id);
  const corruptReplay = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(corruptReplay.ok, false);
  if (!corruptReplay.ok) assert.match(corruptReplay.reason, /planning card identity is invalid/);

  const foreignSession = eventlog.createSession({ id: 'primary-card-foreign', kind: 'chat' });
  const foreignSource = eventlog.appendEvent({
    sessionId: foreignSession.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Research the newest local LLM processing news.' },
  });
  db.prepare(`
    INSERT INTO events
      (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES (?, ?, 1, 'system', ?, ?, ?, ?)
  `).run(
    'foreign-primary-planning-card',
    foreignSession.id,
    SNAPSHOT_TYPE,
    foreignSource.id,
    snapshot.data_json,
    '2026-08-31T00:00:01.000Z',
  );
  const foreignReplay = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: foreignSession.id,
    sourceUserSeq: foreignSource.seq,
  });
  assert.equal(foreignReplay.ok, false);
  if (!foreignReplay.ok) assert.match(foreignReplay.reason, /lost its exact source or content identity/);
});

test('same-id current manifest drift cannot be hidden behind the stored card digest', async () => {
  const factory = resetFixture();
  registerRead({ factory, slug: 'NEWS_LOOKUP', purpose: 'recent local LLM news research' });
  const { session, source } = freshSource('drift');
  const first = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(first.ok, true, first.ok ? '' : first.reason);

  registerRead({
    factory,
    slug: 'NEWS_LOOKUP',
    purpose: 'recent local LLM news research',
    fingerprint: sha256('drifted-news-definition'),
  });
  const replay = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.match(replay.reason, /capability drifted: cap:resolved:news_lookup/);
});
