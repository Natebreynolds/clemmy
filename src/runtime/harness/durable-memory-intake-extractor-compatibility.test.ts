/** Retained legacy extraction survives unchanged disposable stores and current readers.
 * Ordinary test runs seed the explicit legacy edition with a missing-edition identity.
 * A separately pinned historical supervisor can supply the actual 0ad producer.
 * Neither path invokes a model, provider, asynchronous drain, or live home.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { AutoMemoryCandidate } from '../../memory/auto-capture.js';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-intake-extractor-compat-'));
Object.assign(process.env, { CLEMENTINE_HOME: fixtureHome, CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_LOCAL_EMBEDDINGS: 'off', CLEMMY_EMBED_AT_WRITE: 'off', EMBEDDINGS_DISABLED: 'true' });
interface Fixture { label: string; sessionId: string; sourceUserSeq: number; sourceEventId: string; projectId: string;
  candidateId: number; episodeId: string; factId: number | null; oldCandidate: AutoMemoryCandidate;
  oldReceiptStatus: string; receiptId: string | null; candidateRow: Record<string, unknown>; receiptRow: Record<string, unknown> | null }
let fixtures: Fixture[] | undefined;
if (process.env.CLEM_TEST_INTAKE_BASELINE_ROOT || process.env.CLEM_TEST_INTAKE_BASELINE_PRODUCER) {
  assert.ok(process.env.CLEM_TEST_INTAKE_BASELINE_ROOT, 'historical mode requires the pinned archive');
  assert.ok(process.env.CLEM_TEST_INTAKE_BASELINE_PRODUCER, 'historical mode requires the pinned producer helper');
  const old = spawnSync(process.execPath, ['--import', 'tsx', process.env.CLEM_TEST_INTAKE_BASELINE_PRODUCER], {
    env: { ...process.env }, encoding: 'utf8', timeout: 90_000,
  });
  assert.equal(old.status, 0, `historical fixture setup failed: ${old.stderr}\n${old.stdout}`);
  const resultLine = old.stdout.split('\n').find(line => line.startsWith('CLEM_COMPAT_RESULT='));
  assert.ok(resultLine, 'historical fixture returned its exact controlled identities');
  const produced = JSON.parse(resultLine.slice('CLEM_COMPAT_RESULT='.length)) as { producerHash: string; fixtures: Fixture[] };
  assert.equal(produced.producerHash, '6ee6f9a38310c7a4dc90bc9761e8569b1d391f5c254ddef2535902b0f1e89f3c');
  fixtures = produced.fixtures;
}
const events = await import('./eventlog.js');
const memory = await import('../../memory/db.js');
const receipts = await import('./durable-memory-intake-receipt.js');
const capture = await import('../../memory/auto-capture.js');
const destinations = await import('../../memory/memory-destination.js');
const scopes = await import('../../memory/memory-scope.js');
const contexts = await import('./source-session-context.js');
const contextScopes = await import('./source-session-context-scope.js');
const queue = await import('../../memory/durable-consolidation.js');
const projects = await import('../../projects/project-record.js');
after(() => { memory.closeMemoryDb(); events.closeEventLog(); projects._closeProjectStoreForTests();
  rmSync(fixtureHome, { recursive: true, force: true }); });
fixtures ??= await seedLegacyFixtures();
const fixture = (label: string) => { const found = fixtures!.find(value => value.label === label); assert.ok(found); return found; };
const candidateRow = (value: Fixture) => memory.openMemoryDb().prepare('SELECT * FROM memory_reflection_candidates WHERE id=?').get(value.candidateId);
const receiptRow = (value: Fixture) => events.openEventLog().prepare('SELECT * FROM durable_memory_intake_receipts WHERE session_id=?').get(value.sessionId) ?? null;
const contextRow = (value: Pick<Fixture, 'sessionId' | 'sourceUserSeq'>) => events.openEventLog()
  .prepare('SELECT identity_json, identity_digest FROM source_session_contexts_v1 WHERE session_id=? AND source_user_seq=?')
  .get(value.sessionId, value.sourceUserSeq) as { identity_json: string; identity_digest: string };
const source = (value: Fixture) => { const found = events.listEvents(value.sessionId, { types: ['user_input_received'] })
  .find(row => row.seq === value.sourceUserSeq); assert.ok(found); return found; };
function withoutMutation(value: Fixture, read: () => void) {
  const beforeCandidate = candidateRow(value); const beforeReceipt = receiptRow(value);
  const beforeContext = contextRow(value);
  const beforeCount = memory.openMemoryDb().prepare('SELECT count(*) n FROM memory_reflection_candidates').get();
  try { read(); } finally {
    assert.deepEqual(candidateRow(value), beforeCandidate, 'consumer cannot rewrite the historical candidate');
    assert.deepEqual(receiptRow(value), beforeReceipt, 'consumer cannot rewrite the historical receipt');
    assert.deepEqual(contextRow(value), beforeContext, 'consumer cannot rewrite the retained source identity');
    assert.deepEqual(memory.openMemoryDb().prepare('SELECT count(*) n FROM memory_reflection_candidates').get(), beforeCount,
      'consumer cannot create a replacement candidate under the latest extractor');
  }
}

async function seedLegacyFixtures(): Promise<Fixture[]> {
  const shadow = await import('../graph/turn-graph-shadow.js');
  const authority = await import('./accepted-task-authority.js');
  const contracts = await import('./expected-work-contract.js');
  const activation = await import('./action-expected-work-boundary.js');
  const facts = await import('../../memory/facts.js');
  const links = await import('../../memory/temporal-memory.js');
  const sessionProjects = await import('../../projects/session-project.js');
  mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
  writeFileSync(path.join(fixtureHome, 'state/machine-id'), 'memory-extractor-compatibility\n');
  const claim = 'all four of these distinct synthetic facts in this project only. '
    + ['record A has heading AMBER TRACE.', 'record B has heading COBALT WAVE.',
      'record C has heading SILVER DUNE.', 'record D has heading INDIGO FIELD.']
      .map(fact => `For synthetic fixture CLEM-EXTRACTOR-COMPAT, ${fact}`).join(' ');
  const tail = 'Preserve every existing memory. Confirm what you actually saved, and say clearly if any requested fact remains unsaved or unverified. '
    + 'Do not change settings, run workflows, write files, contact external services, edit another project, or reset or clean up memory. '
    + 'This is a normal controlled framework memory-retention check.';
  const seeded: Fixture[] = [];
  for (const label of ['changed-saved', 'changed-pending', 'row-tamper', 'source-tamper', 'scope-tamper',
    'coherent-prefix-rewrite', 'unbound-prefix', 'old-receipt']) {
    const message = label === 'old-receipt'
      ? 'Remember this: Cedar is Cedar-41. A natural acknowledgement is enough.' : `Remember ${claim} ${tail}`;
    const sessionId = `memory-extractor-compat-${label}`;
    events.createSession({ id: sessionId, kind: 'chat' });
    const project = projects.createProject({ name: `Extractor compatibility ${label}`, context: 'Disposable framework fixture.' });
    assert.ok(project.ok);
    assert.ok(sessionProjects.setSessionProject(sessionId, project.project.id, { by: 'owner' }).ok);
    const template = events.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received',
      data: { text: 'Establish the controlled project context.' } });
    assert.ok(contexts.captureFreshSourceSessionContext({ sessionId, sourceUserSeq: template.seq }));
    const source = events.appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: message } });
    const identity = { sessionId, sourceUserSeq: source.seq };
    // Insert a separate immutable historical identity; never rewrite an accepted one.
    // Its missing edition exercises the same retained protocol as the actual 0ad run.
    const stored = events.openEventLog().prepare('SELECT identity_json FROM source_session_contexts_v1 WHERE session_id=? AND source_user_seq=?')
      .get(sessionId, template.seq) as { identity_json: string };
    const legacy = JSON.parse(stored.identity_json);
    legacy.sourceUserSeq = source.seq; delete legacy.memoryCaptureEdition;
    const json = JSON.stringify(legacy); const digest = createHash('sha256').update(json).digest('hex');
    events.openEventLog().prepare('INSERT INTO source_session_contexts_v1 (session_id,source_user_seq,identity_json,identity_digest) VALUES (?,?,?,?)')
      .run(sessionId, source.seq, json, digest);
    const reopened = contexts.readSourceSessionContext(identity, digest); assert.ok(reopened);
    assert.equal(contextScopes.sourceMemoryCaptureEdition(reopened), 'legacy_v1');
    assert.ok(shadow.recordTurnGraphShadow({ identity: { ...identity, turn: 2 } }));
    assert.equal(authority.armAcceptedTaskAuthority(identity).status, 'armed');
    assert.deepEqual(contracts.requireKnownExpectedWorkContract(identity), { status: 'action_deferred' });
    assert.equal(activation.requireActionExpectedWorkActivation(identity).status, 'action_active');
    const input = { message, sessionId, sourceEventId: `user-source:${source.seq}`, occurredAt: source.createdAt,
      sourceProvenance: capture.autoCaptureProvenanceFromAcceptedEvent(source) };
    const selected = capture.selectAutoMemoryCandidates(message, 3, contextScopes.sourceMemoryCaptureEdition(reopened));
    assert.equal(selected.length, 1);
    const origins = capture.automaticMemoryOriginsForCapture(input, selected);
    assert.equal(origins[0]!.claimMode, 'complete');
    if (label !== 'old-receipt') assert.equal(selected[0]!.content, `${claim} ${tail}`);
    const queued = queue.enqueueAutoCaptureCandidates({ ...input, candidates: selected, origins });
    assert.equal(queued.candidateIds.length, 1); assert.ok(queued.episodeId);
    const candidateId = queued.candidateIds[0]!; const db = memory.openMemoryDb();
    let factId: number | null = null;
    if (label !== 'changed-pending') {
      const row = db.prepare('SELECT * FROM memory_reflection_candidates WHERE id=?').get(candidateId) as
        { id: number; kind: AutoMemoryCandidate['kind']; destination_json: string; episode_id: string; source_uri: string };
      const original = destinations.parseAutomaticMemoryEnvelope(row.destination_json); assert.ok(original.origin);
      const phrase = 'in this project only'; const start = message.indexOf(phrase);
      const envelope = destinations.withAutomaticMemoryDecision(original, { durability: 'standing', claim: original.origin.claim,
        destination: label === 'old-receipt' ? 'kind_default' : 'current_project',
        destinationSpans: label === 'old-receipt' ? [] : [{ start, end: start + phrase.length }],
        reason: 'Controlled canonical storage outcome; no semantic model.' });
      const target = destinations.resolveAutomaticMemoryDestination(envelope); assert.equal(target.status, 'resolved');
      if (target.status !== 'resolved') throw new Error('fixture destination not resolved');
      const fact = scopes.withMemorySettledFor(target.scope, () => facts.rememberFact({ kind: row.kind, content: target.claimText, sessionId }));
      scopes.stampMemoryScope('fact', fact.id, target.scope, { sessionId });
      links.linkFactEvidence({ factId: fact.id, episodeId: row.episode_id, sourceUri: row.source_uri, excerpt: target.claimText });
      db.prepare("UPDATE memory_reflection_candidates SET destination_json=?,status='promoted',resulting_fact_id=? WHERE id=?")
        .run(JSON.stringify(envelope), fact.id, row.id);
      factId = fact.id;
    }
    const issued = receipts.issueDurableMemoryIntakeReceipt(identity);
    assert.equal(issued.status, label === 'old-receipt' ? 'issued' : 'ineligible', 'do not invent acknowledgement-only eligibility');
    seeded.push({ label, ...identity, sourceEventId: source.id, projectId: project.project.id, candidateId,
      episodeId: queued.episodeId, factId, oldCandidate: selected[0]!, oldReceiptStatus: issued.status,
      receiptId: 'receiptId' in issued ? issued.receiptId : null,
      candidateRow: db.prepare('SELECT * FROM memory_reflection_candidates WHERE id=?').get(candidateId) as Record<string, unknown>,
      receiptRow: events.openEventLog().prepare('SELECT * FROM durable_memory_intake_receipts WHERE session_id=?').get(sessionId) as Record<string, unknown> ?? null });
  }
  return seeded;
}

test('historical extractor: old q11 canonical save still produces a verified saved notice', () => {
  const value = fixture('changed-saved');
  assert.deepEqual(candidateRow(value), value.candidateRow);
  assert.equal(value.oldReceiptStatus, 'ineligible', 'q11 never had acknowledgement-only completion authority');
  assert.notEqual(capture.selectAutoMemoryCandidates(String(source(value).data.text))[0]?.content, value.oldCandidate.content,
    'the new pure extractor really differs from this retained intake');
  withoutMutation(value, () => assert.match(receipts.verifiedMemoryIntakeContext(value) ?? '', /durably SAVED/));
});

test('historical extractor: old q11 storage evidence keeps exact content and source linkage', () => {
  const value = fixture('changed-saved');
  withoutMutation(value, () => {
    const evidence = receipts.verifiedMemoryConsolidationEvidence(value);
    assert.equal(evidence?.length, 1);
    assert.equal(evidence[0]!.candidateId, value.candidateId);
    assert.equal(evidence[0]!.verified, true);
    assert.equal(evidence[0]!.sourceLinked, true);
    assert.equal(evidence[0]!.scopeMatches, true);
    assert.equal(evidence[0]!.fact?.content, value.oldCandidate.content, 'history remains honest about old task-text contamination');
    assert.equal(evidence[0]!.fact?.contentComplete, true);
    assert.equal(receipts.readMemoryConsolidationStatusEvidence(value).status, 'ok');
  });
});

test('historical extractor: old pending intake retains its pending duplicate-save notice', () => {
  const value = fixture('changed-pending');
  withoutMutation(value, () => assert.match(receipts.verifiedMemoryIntakeContext(value) ?? '', /durably queued/));
});

test('historical extractor: an actually issued old V2 host receipt redeems without replacement', () => {
  const value = fixture('old-receipt');
  assert.equal(value.oldReceiptStatus, 'issued');
  assert.deepEqual(receiptRow(value), value.receiptRow);
  withoutMutation(value, () => {
    const redeemed = receipts.redeemDurableMemoryIntakeReceipt(value);
    assert.equal(redeemed.status, 'redeemed', JSON.stringify(redeemed));
    if (redeemed.status !== 'redeemed') throw new Error('receipt not redeemed');
    assert.equal(redeemed.receiptId, value.receiptId);
    const replayed = receipts.issueDurableMemoryIntakeReceipt(value);
    assert.equal(replayed.status, 'replayed');
  });
});

test('retained extractor: producer replay reuses original candidate and full episode after reopen', () => {
  const value = fixture('changed-saved');
  const storedIdentity = contextRow(value);
  assert.equal(Object.hasOwn(JSON.parse(storedIdentity.identity_json), 'memoryCaptureEdition'), false);
  const episodeSnapshot = () => memory.openMemoryDb().prepare('SELECT * FROM memory_episodes WHERE id=?').get(value.episodeId);
  const priorEpisode = episodeSnapshot();
  const priorEpisodeHash = createHash('sha256').update(JSON.stringify(priorEpisode)).digest('hex');
  memory.closeMemoryDb(); events.closeEventLog();
  withoutMutation(value, () => {
    const retained = contexts.readSourceSessionContext(value, storedIdentity.identity_digest); assert.ok(retained);
    const edition = contextScopes.sourceMemoryCaptureEdition(retained); assert.equal(edition, 'legacy_v1');
    const accepted = source(value);
    const input = { message: String(accepted.data.text), sessionId: value.sessionId,
      sourceEventId: `user-source:${value.sourceUserSeq}`, occurredAt: accepted.createdAt,
      sourceProvenance: capture.autoCaptureProvenanceFromAcceptedEvent(accepted) };
    const candidates = capture.selectAutoMemoryCandidates(input.message, 3, edition);
    assert.deepEqual(candidates, [value.oldCandidate]);
    const origins = capture.automaticMemoryOriginsForCapture(input, candidates);
    const replay = queue.enqueueAutoCaptureCandidates({ ...input, candidates, origins });
    assert.deepEqual(replay.candidateIds, [value.candidateId]);
    assert.equal(replay.episodeId, value.episodeId);
    assert.deepEqual(episodeSnapshot(), priorEpisode);
    assert.equal(createHash('sha256').update(JSON.stringify(episodeSnapshot())).digest('hex'), priorEpisodeHash);
    assert.match(receipts.verifiedMemoryIntakeContext(value) ?? '', /durably SAVED/);
  });
});

for (const label of ['row-tamper', 'source-tamper', 'scope-tamper', 'unbound-prefix']) test(`historical extractor: ${label} cannot qualify as verified storage`, () => {
  const value = fixture(label); const db = memory.openMemoryDb();
  if (label === 'row-tamper') db.prepare("UPDATE memory_reflection_candidates SET text=text || ' altered' WHERE id=?").run(value.candidateId);
  if (label === 'source-tamper') {
    const accepted = source(value);
    events.openEventLog().prepare('UPDATE events SET data_json=? WHERE id=?').run(JSON.stringify({ ...accepted.data,
      text: `${accepted.data.text} The source changed.` }), value.sourceEventId);
  }
  if (label === 'scope-tamper') scopes.stampMemoryScope('fact', value.factId!, { projectId: 'foreign-fixture-project', agentKey: null }, { sessionId: value.sessionId });
  if (label === 'unbound-prefix') db.prepare('UPDATE memory_reflection_candidates SET text=?,destination_json=NULL WHERE id=?')
    .run(capture.selectAutoMemoryCandidates(String(source(value).data.text))[0]!.content, value.candidateId);
  withoutMutation(value, () => {
    assert.notEqual(receipts.hostVerifiedStatedRetention(value), true);
    assert.ok(!receipts.verifiedMemoryConsolidationEvidence(value)?.some(row => row.verified));
    assert.notEqual(receipts.redeemDurableMemoryIntakeReceipt(value).status, 'redeemed');
  });
});

test('historical extractor: current clean prefix cannot silently replace an old source-bound capture', () => {
  const value = fixture('coherent-prefix-rewrite'); const accepted = source(value);
  const input = { message: String(accepted.data.text), sessionId: value.sessionId, sourceEventId: `user-source:${value.sourceUserSeq}`,
    sourceProvenance: capture.autoCaptureProvenanceFromAcceptedEvent(accepted) };
  const selected = capture.selectAutoMemoryCandidates(input.message); assert.equal(selected.length, 1);
  assert.notEqual(selected[0]!.content, value.oldCandidate.content);
  const origin = capture.automaticMemoryOriginsForCapture(input, selected)[0]; assert.ok(origin);
  const previous = destinations.parseAutomaticMemoryEnvelope(String(value.candidateRow.destination_json));
  assert.ok(previous.decision);
  const rewritten = destinations.withAutomaticMemoryDecision(destinations.createAutomaticMemoryEnvelope(origin), {
    ...previous.decision, claim: origin.claim,
  });
  const db = memory.openMemoryDb();
  db.prepare('UPDATE memory_reflection_candidates SET candidate_hash=?,text=?,destination_json=? WHERE id=?')
    .run(destinations.automaticMemoryCandidateIdentity(origin), selected[0]!.content, JSON.stringify(rewritten), value.candidateId);
  db.prepare('UPDATE consolidated_facts SET content=? WHERE id=?').run(selected[0]!.content, value.factId);
  db.prepare('UPDATE fact_evidence SET excerpt=? WHERE fact_id=? AND episode_id=?').run(selected[0]!.content, value.factId, value.episodeId);
  withoutMutation(value, () => {
    assert.equal(receipts.verifiedMemoryIntakeContext(value), null, 'latest extraction is not historical admission authority');
    assert.equal(receipts.verifiedMemoryConsolidationEvidence(value), null);
  });
});
