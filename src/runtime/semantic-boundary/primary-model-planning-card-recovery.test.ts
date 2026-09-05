/**
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/runtime/semantic-boundary/primary-model-planning-card-recovery.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { RunContext } from '@openai/agents';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-primary-card-recovery-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_SEMANTIC_RECALL = 'off';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-primary-card-recovery\n', 'utf8');

const eventlog = await import('../harness/eventlog.js');
const catalogs = await import('../harness/host-capability-catalog-factory.js');
const manifests = await import('../harness/capability-manifest.js');
const continuityStore = await import('../../memory/task-continuity.js');
const continuityRuntime = await import('../harness/task-continuity-runtime.js');
const semantic = await import('./admit-and-compile-accepted-source.js');
const { buildScopedLocalToolSearch } = await import('../../tools/local-runtime-tools.js');

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

test('a re-prime reaches the same card the in-process same-source disclosure already showed the model', async () => {
  // 9061/9064 class: the frozen initial card replaced the merged card on
  // re-prime, so every same-source tool_search disclosure (all cap:local:*
  // refs) vanished for a resumed source and work_call/plan_task lost their
  // surface. The frozen card stays the base; this source's own durable
  // disclosures extend it under the one repack rule both lanes share.
  const factory = resetFixture();
  registerRead({ factory, slug: 'NEWS_LOOKUP', purpose: 'recent local LLM news research' });
  const session = eventlog.createSession({ id: 'primary-card-same-source-disclosure', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Read my current local user profile.' },
  });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;
  const frozenIds = primed.planning.capabilities.map((entry) => entry.id);
  const ref = 'cap:local:user_profile_read:read';
  assert.equal(frozenIds.includes(ref), false, 'the local ref is not on the pre-disclosure card');

  const search = buildScopedLocalToolSearch(
    new Set(['user_profile_read']),
    'work_call',
    undefined,
    undefined,
    (candidates) => semantic.disclosePrimaryModelPlanningCapabilities({
      authority: primed.planning.authority,
      candidates,
    }),
  );
  const output = await search.invoke(
    new RunContext({ sessionId: session.id }),
    JSON.stringify({ query: 'user_profile_read', role_key: null, limit: 8 }),
  );
  const disclosed = JSON.parse(String(output)) as { results: Array<{ capabilityRef?: string }> };
  assert.equal(disclosed.results[0]?.capabilityRef, ref);
  const inProcess = semantic.snapshotPrimaryModelPlanningContext(primed.planning.authority);
  assert.ok(inProcess);
  assert.ok(inProcess.capabilities.some((entry) => entry.id === ref), 'the in-process lane shows the disclosed ref');
  assert.equal(inProcess.digest, sha256(JSON.stringify(inProcess.capabilities)));

  eventlog.closeEventLog();
  const rePrimed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(rePrimed.ok, true, rePrimed.ok ? '' : rePrimed.reason);
  if (!rePrimed.ok) return;
  assert.equal(
    rePrimed.planning.capabilities.find((entry) => entry.id === ref)?.effect,
    'read',
    'a same-source durable disclosure survives the re-prime with its effect',
  );
  assert.equal(
    rePrimed.planning.digest,
    sha256(JSON.stringify(rePrimed.planning.capabilities)),
    'the digest is bound to exactly the returned rows',
  );
  assert.deepEqual(
    rePrimed.planning.capabilities.map((entry) => entry.id),
    inProcess.capabilities.map((entry) => entry.id),
    'lane parity: the re-prime reaches the card the model was already shown',
  );
  assert.equal(rePrimed.planning.digest, inProcess.digest);
  assert.equal(rePrimed.planning.effectCeiling, inProcess.effectCeiling);
  for (const id of frozenIds) {
    assert.ok(rePrimed.planning.capabilities.some((entry) => entry.id === id), `frozen row ${id} is kept`);
  }

  const snapshots = eventlog.listEvents(session.id, { types: [SNAPSHOT_TYPE] });
  assert.equal(snapshots.length, 1, 'the frozen initial card is never restamped');
  const payload = JSON.parse(String(snapshots[0]!.data.snapshotJson)) as { capabilities: Array<{ id: string }> };
  assert.deepEqual(payload.capabilities.map((entry) => entry.id), frozenIds,
    'the durable initial card still records the pre-disclosure surface');
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

test('a progressed source without a snapshot installs its card late, exactly once, and reuses it', async () => {
  // 8740 class: the card is private presentation data with no execution
  // authority (eventlog.ts recordPrimaryModelPlanningCardSnapshotOnce), so
  // refusing to prime a source that progressed before any card existed made
  // every legacy/in-flight source unresumable. Late install is the outcome.
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

  const late = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(late.ok, true, late.ok ? '' : late.reason);
  if (!late.ok) return;
  assert.deepEqual(late.planning.capabilities.map((entry) => entry.id), ['cap:resolved:news_lookup']);
  const snapshots = eventlog.listEvents(session.id, { types: [SNAPSHOT_TYPE] });
  assert.equal(snapshots.length, 1, 'the late card is installed exactly once');

  const reused = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(reused.ok, true, reused.ok ? '' : reused.reason);
  if (!reused.ok) return;
  assert.equal(reused.planning.digest, late.planning.digest, 'the late-installed card is reused, not restamped');
  assert.equal(eventlog.listEvents(session.id, { types: [SNAPSHOT_TYPE] }).length, 1);
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

test('a first prime whose only card rows are durable same-source disclosures reopens its own card', async () => {
  // Restart class: the process is gone and the card snapshot was never
  // stamped for this source (a pre-card session), but the durable disclosure
  // rows survive. Replay rebuilds the staged identity from current evidence
  // and the first prime freezes that identity into the card. The freeze
  // ceremony must then accept the rows it just wrote: a staged disclosure is
  // current without being a live factory row, so a live-only universe refuses
  // the exact identity the replay rebuilt ("capability drifted") and the
  // source can never be planned again.
  const factory = resetFixture();
  registerRead({ factory, slug: 'NEWS_LOOKUP', purpose: 'recent local LLM news research' });
  const origin = eventlog.createSession({ id: 'primary-card-disclosure-origin', kind: 'chat' });
  const originSource = eventlog.appendEvent({
    sessionId: origin.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Read my current local user profile.' },
  });
  const primed = await semantic.primePrimaryModelPlanningCatalog({
    sessionId: origin.id,
    sourceUserSeq: originSource.seq,
  });
  assert.equal(primed.ok, true, primed.ok ? '' : primed.reason);
  if (!primed.ok) return;
  const ref = 'cap:local:user_profile_read:read';
  const search = buildScopedLocalToolSearch(
    new Set(['user_profile_read']),
    'work_call',
    undefined,
    undefined,
    (candidates) => semantic.disclosePrimaryModelPlanningCapabilities({
      authority: primed.planning.authority,
      candidates,
    }),
  );
  const output = await search.invoke(
    new RunContext({ sessionId: origin.id }),
    JSON.stringify({ query: 'user_profile_read', role_key: null, limit: 8 }),
  );
  const disclosed = JSON.parse(String(output)) as { results: Array<{ capabilityRef?: string }> };
  assert.equal(disclosed.results[0]?.capabilityRef, ref);
  const durableRows = eventlog.listEvents(origin.id, { types: ['capability_discovered'] })
    .flatMap((event) => Array.isArray(event.data.capabilities) ? event.data.capabilities : []);
  assert.ok(durableRows.length > 0, 'the disclosure left durable rows to replay');

  // A source that carries the durable disclosure rows but no card snapshot.
  const restarted = eventlog.createSession({ id: 'primary-card-disclosure-restart', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: restarted.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Read my current local user profile.' },
  });
  eventlog.appendEvent({
    sessionId: restarted.id,
    turn: source.turn,
    role: 'system',
    type: 'capability_discovered',
    data: { sourceUserSeq: source.seq, capabilities: durableRows },
  });
  assert.deepEqual(eventlog.listEvents(restarted.id, { types: [SNAPSHOT_TYPE] }), []);
  eventlog.closeEventLog();

  const identity = { sessionId: restarted.id, sourceUserSeq: source.seq };
  const rePrimed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(rePrimed.ok, true, rePrimed.ok ? '' : rePrimed.reason);
  if (!rePrimed.ok) return;
  assert.equal(
    rePrimed.planning.capabilities.find((entry) => entry.id === ref)?.effect,
    'read',
    'the replayed disclosure is on the first card',
  );
  assert.equal(rePrimed.planning.digest, sha256(JSON.stringify(rePrimed.planning.capabilities)));
  const snapshots = eventlog.listEvents(restarted.id, { types: [SNAPSHOT_TYPE] });
  assert.equal(snapshots.length, 1, 'the first prime stamps the card exactly once');
  const payload = JSON.parse(String(snapshots[0]!.data.snapshotJson)) as { capabilities: Array<{ id: string }> };
  assert.ok(payload.capabilities.some((entry) => entry.id === ref),
    'the frozen card records the replayed disclosure');

  // The frozen card now cites a staged row. A second prime must reopen it
  // unchanged: the row is still not a live factory row and still current.
  eventlog.closeEventLog();
  const again = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.equal(again.ok, true, again.ok ? '' : again.reason);
  if (!again.ok) return;
  assert.deepEqual(
    again.planning.capabilities.map((entry) => entry.id),
    rePrimed.planning.capabilities.map((entry) => entry.id),
  );
  assert.equal(again.planning.digest, rePrimed.planning.digest);
  assert.equal(eventlog.listEvents(restarted.id, { types: [SNAPSHOT_TYPE] }).length, 1);
});
