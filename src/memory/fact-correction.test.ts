import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const oldHome = process.env.CLEMENTINE_HOME;
const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-exact-fact-correction-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.CLEMMY_EMBED_AT_WRITE = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';
const { openMemoryDb, closeMemoryDb, resetMemoryDb } = await import('./db.js');
const { rememberFact, moveFactToScope, setFactPinned, updateFact, forgetFact, recordFactUtility } = await import('./facts.js');
const { recordMemoryEpisode, getFactEvidence } = await import('./temporal-memory.js');
const { withMemoryReadScope, withMemorySettledFor } = await import('./memory-scope.js');
const { parseFactObservation, applyExactFactPatches } = await import('./fact-observation.js');
const { correctFactExact, readFactObservation, readFactCorrectionProof } = await import('./fact-correction.js');
const { upsertEntity } = await import('./entity-identity.js');
const { setFactEntityLinks } = await import('./relations.js');
import type { CorrectFactExactInput } from './fact-correction.js';

const PROJECT = { projectId: 'prj_exact_correction', agentKey: null };
const AGENT = { projectId: 'prj_exact_correction', agentKey: 'agent@fixture' };
const original = 'For synthetic project Copper, report heading is TOPAZ HARBOR and footnote is COPPER KITE.';
const revised = original.replace('TOPAZ HARBOR', 'JADE SUMMIT');
const ownerText = 'Correction: the report heading is now JADE SUMMIT, replacing TOPAZ HARBOR. The footnote is unchanged.';
const owner = { sessionId: 'exact-correction-session', sourceUserSeq: 101,
  sourceEventId: 'exact-correction-owner', sourceContextDigest: 'a'.repeat(64), logicalToolCallId: 'correction-call',
  argumentsDigest: 'b'.repeat(64), assessmentDigest: 'c'.repeat(64), ownerText, occurredAt: '2026-02-01T00:00:00.000Z' };

beforeEach(() => resetMemoryDb());
after(() => {
  closeMemoryDb(); rmSync(fixtureHome, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.CLEMENTINE_HOME; else process.env.CLEMENTINE_HOME = oldHome;
});
function seed(kind: 'project' | 'constraint' = 'project') {
  const episode = withMemorySettledFor(PROJECT, () => recordMemoryEpisode({ kind: 'user_turn', sessionId: owner.sessionId,
    callId: 'baseline', occurredAt: '2026-01-01T00:00:00.000Z', content: original }));
  const fact = rememberFact({ kind, content: original, scope: PROJECT, sessionId: owner.sessionId,
    occurredAt: '2026-01-01T00:00:00.000Z', evidence: { episodeId: episode.id, excerpt: original } });
  return fact;
}
function request(id: number): CorrectFactExactInput {
  const observed = readFactObservation(id); assert.ok(observed);
  return { targetId: id, expectedObservationDigest: observed.digest,
    patches: [{ before: 'TOPAZ HARBOR', after: 'JADE SUMMIT' }], owner: { ...owner } };
}
function snapshot() {
  const db = openMemoryDb();
  return Object.fromEntries(['consolidated_facts','fact_evidence','memory_episodes','memory_scopes','memory_policies',
    'fact_entities','entity_observations','fact_resources','fact_validity_intervals'].map(name =>
    [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
}

test('observation is complete, strict and stable through usage/score churn', () => {
  const fact = seed(); const before = readFactObservation(fact.id)!;
  recordFactUtility(fact.id);
  rememberFact({ kind: 'project', content: original, scope: PROJECT, sessionId: owner.sessionId });
  const after = readFactObservation(fact.id)!;
  assert.equal(after.digest, before.digest);
  assert.equal(after.content, original); assert.deepEqual(after.scope, PROJECT);
  assert.deepEqual(parseFactObservation(before), before);
  assert.throws(() => parseFactObservation({ ...before, content: 'short projection' }));
  assert.throws(() => parseFactObservation({ ...before, extra: 'model assertion' }));
  const { provenance: _missing, ...partial } = before;
  assert.throws(() => parseFactObservation(partial));
});

test('exact patches are simultaneous, bounded, unique and preserve all untouched text', () => {
  const value = applyExactFactPatches('A OLD B KEEP C', [{ before: 'OLD', after: 'NEW' }, { before: 'KEEP', after: 'OLD' }]);
  assert.equal(value.content, 'A NEW B OLD C');
  assert.throws(() => applyExactFactPatches('OLD OLD', [{ before: 'OLD', after: 'NEW' }]));
  assert.throws(() => applyExactFactPatches('ABC', [{ before: 'AB', after: 'X' }, { before: 'BC', after: 'Y' }]));
  assert.throws(() => applyExactFactPatches('ABC', []));
  assert.throws(() => applyExactFactPatches('ABC', Array.from({ length: 9 }, () => ({ before: 'A', after: 'B' }))));
  assert.throws(() => applyExactFactPatches('x😀z', [{ before: '\ud83d', after: 'q' }]));
  assert.throws(() => applyExactFactPatches('x😀z', [{ before: '😀', after: '\ud83d' }]));
  assert.equal(applyExactFactPatches('x😀z', [{ before: '😀', after: '🌲' }]).content, 'x🌲z');
});

test('project-only target correction retains neighbor, scope, evidence and source proof under agent ambient', () => {
  const fact = seed(); const req = request(fact.id); const priorEvidence = getFactEvidence(fact.id);
  const result = withMemoryReadScope(AGENT, () => correctFactExact(req));
  assert.equal(result.status, 'corrected'); if (result.status !== 'corrected') return;
  assert.equal(result.currentStateMatches, true); assert.equal(result.proof.after.content, revised);
  assert.deepEqual(result.proof.after.scope, PROJECT); assert.deepEqual(result.proof.before.scope, PROJECT);
  const old = readFactObservation(fact.id)!;
  assert.equal(old.active, false); assert.equal(old.content, original);
  assert.equal(old.validTo, owner.occurredAt); assert.equal(old.supersededByFactId, result.proof.after.id);
  assert.deepEqual(getFactEvidence(fact.id), priorEvidence);
  assert.deepEqual(result.proof.after.provenance.derivedFromFactIds, [fact.id]);
  assert.ok(result.proof.preservedEvidenceRefs.some(ref => ref.factId === fact.id));
  assert.equal(result.proof.owner.assessmentDigest, owner.assessmentDigest);
  assert.equal(getFactEvidence(result.proof.after.id)[0]?.excerpt, ownerText);
  assert.deepEqual(readFactCorrectionProof(result.proof.episodeId), result.proof);
});

test('stale content, scope and pin observations refuse without writes', () => {
  for (const change of ['content','scope','pin'] as const) {
    resetMemoryDb(); const fact = seed(); const req = request(fact.id);
    if (change === 'content') updateFact(fact.id, { content: original + ' Preserve this condition.' });
    if (change === 'scope') moveFactToScope(fact.id, AGENT);
    if (change === 'pin') setFactPinned(fact.id, true);
    const before = snapshot(); const result = correctFactExact(req);
    assert.deepEqual(result, { status: 'refused', reason: 'stale_observation' });
    assert.deepEqual(snapshot(), before);
  }
});

test('second reader loses target CAS; no fresh-call reuse or successor adoption', () => {
  const fact = seed(); const req = request(fact.id); const first = correctFactExact(req);
  assert.equal(first.status, 'corrected'); const before = snapshot();
  const result = correctFactExact({ ...req, owner: { ...owner, logicalToolCallId: 'another-call' } });
  assert.deepEqual(result, { status: 'refused', reason: 'stale_observation' });
  assert.deepEqual(snapshot(), before);
});

test('same exact call reopens committed episode after DB reopen without another effect', () => {
  const fact = seed(); const req = request(fact.id); const first = correctFactExact(req);
  assert.equal(first.status, 'corrected'); const before = snapshot(); closeMemoryDb();
  const replay = correctFactExact(req);
  assert.equal(replay.status, 'replayed'); if (replay.status !== 'replayed' || first.status !== 'corrected') return;
  assert.deepEqual(replay.proof, first.proof); assert.equal(replay.currentStateMatches, true);
  assert.deepEqual(snapshot(), before);
  const mismatch = correctFactExact({ ...req, owner: { ...owner, assessmentDigest: 'd'.repeat(64) } });
  assert.deepEqual(mismatch, { status: 'refused', reason: 'correction_call_identity_conflict' });
  assert.deepEqual(snapshot(), before);
});

test('historical replay does not claim current state after successor scope drift', () => {
  const fact = seed(); const req = request(fact.id); const first = correctFactExact(req);
  assert.equal(first.status, 'corrected'); if (first.status !== 'corrected') return;
  moveFactToScope(first.proof.after.id, AGENT); const before = snapshot();
  const replay = correctFactExact(req); assert.equal(replay.status, 'replayed');
  if (replay.status === 'replayed') assert.equal(replay.currentStateMatches, false);
  assert.deepEqual(snapshot(), before);
});

test('case-only and preexisting active/inactive destination hashes refuse without reactivation', () => {
  for (const mode of ['case','active','inactive'] as const) {
    resetMemoryDb(); const fact = seed(); const req = request(fact.id);
    if (mode === 'case') req.patches = [{ before: 'TOPAZ HARBOR', after: 'Topaz Harbor' }];
    else {
      const other = rememberFact({ kind: 'project', content: revised, scope: PROJECT });
      if (mode === 'inactive') forgetFact(other.id);
    }
    const before = snapshot();
    assert.deepEqual(correctFactExact(req), { status: 'refused', reason: 'canonical_identity_collision' });
    assert.deepEqual(snapshot(), before);
  }
});

test('protected targets require host grant, preserve pin and synchronize policy', () => {
  const fact = seed('constraint'); const req = request(fact.id); const before = snapshot();
  assert.deepEqual(correctFactExact(req), { status: 'refused', reason: 'protected_target_requires_host_authority' });
  assert.deepEqual(snapshot(), before);
  const result = correctFactExact({ ...req, allowProtectedCorrection: true });
  assert.equal(result.status, 'corrected'); if (result.status !== 'corrected') return;
  assert.equal(result.proof.after.pinned, true); assert.equal(result.proof.after.kind, 'constraint');
  assert.equal(openMemoryDb().prepare('SELECT 1 FROM memory_policies WHERE fact_id=?').get(fact.id), undefined);
  assert.ok(openMemoryDb().prepare('SELECT 1 FROM memory_policies WHERE fact_id=?').get(result.proof.after.id));
});

test('required evidence failure rolls back replacement, scope, history and original evidence', () => {
  const fact = seed(); const req = request(fact.id); const db = openMemoryDb();
  db.exec(`CREATE TRIGGER deny_correction_evidence BEFORE INSERT ON fact_evidence
    WHEN NEW.fact_id <> ${fact.id} BEGIN SELECT RAISE(ABORT,'fixture evidence failure'); END;`);
  const before = snapshot(); assert.throws(() => correctFactExact(req), /fixture evidence failure/);
  assert.deepEqual(snapshot(), before);
});

test('required proof failure after retirement rolls back the entire memory transaction', () => {
  const fact = seed(); const req = request(fact.id); const db = openMemoryDb();
  db.exec("CREATE TRIGGER deny_correction_proof BEFORE UPDATE OF metadata_json ON memory_episodes WHEN NEW.subtype='fact_correction_v1' BEGIN SELECT RAISE(ABORT,'fixture proof failure'); END;");
  const before = snapshot(); assert.throws(() => correctFactExact(req), /fixture proof failure/);
  assert.deepEqual(snapshot(), before);
});

test('correction carries grounded unchanged identity only, without observing shared entity again', () => {
  const fact = seed(); const episode = getFactEvidence(fact.id)[0]!;
  const entityId = upsertEntity({ type: 'project', name: 'Copper', evidenceEpisodeId: episode.episodeId });
  setFactEntityLinks(fact.id, [entityId], { linkType: 'stored', evidenceEpisodeId: episode.episodeId, evidenceExcerpt: original });
  const db = openMemoryDb();
  const before = { entity: db.prepare('SELECT * FROM entities WHERE id=?').get(entityId),
    observations: db.prepare('SELECT * FROM entity_observations WHERE entity_id=? ORDER BY episode_id').all(entityId),
    oldLinks: db.prepare('SELECT * FROM fact_entities WHERE fact_id=?').all(fact.id) };
  const result = correctFactExact(request(fact.id)); assert.equal(result.status, 'corrected'); if (result.status !== 'corrected') return;
  assert.equal(result.proof.retainedEntityLinkCount, 1);
  assert.deepEqual(db.prepare('SELECT * FROM entities WHERE id=?').get(entityId), before.entity);
  assert.deepEqual(db.prepare('SELECT * FROM entity_observations WHERE entity_id=? ORDER BY episode_id').all(entityId), before.observations);
  assert.deepEqual(db.prepare('SELECT * FROM fact_entities WHERE fact_id=?').all(fact.id), before.oldLinks);
});

test('foreign invisible target and malformed proof cannot become current success', () => {
  const fact = seed(); const req = request(fact.id); const before = snapshot();
  assert.deepEqual(withMemoryReadScope({ projectId: 'other', agentKey: null }, () => correctFactExact(req)),
    { status: 'refused', reason: 'target_unavailable' });
  assert.deepEqual(snapshot(), before);
  const result = correctFactExact(req); assert.equal(result.status, 'corrected'); if (result.status !== 'corrected') return;
  openMemoryDb().prepare('UPDATE memory_episodes SET metadata_json=? WHERE id=?').run('{}', result.proof.episodeId);
  assert.throws(() => readFactCorrectionProof(result.proof.episodeId));
});


test('host lease check runs inside the locked transaction before writes; replay is read-only', () => {
  const fact = seed(); const req = request(fact.id); const db = openMemoryDb(); const before = snapshot();
  let checks = 0;
  assert.throws(() => correctFactExact({ ...req, assertCurrent: () => {
    checks += 1; assert.equal(db.inTransaction, true); assert.deepEqual(snapshot(), before);
    throw new Error('fixture revoked lease');
  } }), /fixture revoked lease/);
  assert.equal(checks, 1); assert.deepEqual(snapshot(), before);
  const first = correctFactExact({ ...req, assertCurrent: () => { checks += 1; assert.equal(db.inTransaction, true); } });
  assert.equal(first.status, 'corrected'); const committed = snapshot();
  const replay = correctFactExact({ ...req, assertCurrent: () => { throw new Error('must not reauthorize replay'); } });
  assert.equal(replay.status, 'replayed'); assert.equal(checks, 2); assert.deepEqual(snapshot(), committed);
});

test('backwards validity and unavailable stored scope cannot admit a correction', () => {
  const fact = seed(); const req = request(fact.id); const before = snapshot();
  assert.deepEqual(correctFactExact({ ...req, owner: { ...owner, occurredAt: '2025-12-31T00:00:00.000Z' } }),
    { status: 'refused', reason: 'invalid_correction_boundary' });
  assert.deepEqual(snapshot(), before);
  const db = openMemoryDb(); db.exec('DROP TABLE memory_scopes');
  const facts = db.prepare('SELECT * FROM consolidated_facts ORDER BY id').all();
  assert.throws(() => correctFactExact(req), /scope is unavailable/);
  assert.deepEqual(db.prepare('SELECT * FROM consolidated_facts ORDER BY id').all(), facts);
});


test('external-derived original keeps its evidence while successor attributes the owner correction', () => {
  const ancestor = seed();
  const episode = withMemorySettledFor(PROJECT, () => recordMemoryEpisode({ kind: 'tool_result',
    sessionId: 'historical-external-session', callId: 'historical-external-read',
    occurredAt: '2026-01-01T00:00:00.000Z', content: original }));
  const fact = rememberFact({ kind: 'reference', content: original, scope: PROJECT,
    sessionId: 'historical-external-session', sourceApp: 'SyntheticExternalStore',
    derivedFrom: { sessionId: 'historical-external-session', callId: 'historical-external-read', tool: 'synthetic_read' },
    trustLevel: 0.6, derivationDepth: 1, derivedFromFactIds: [ancestor.id],
    occurredAt: '2026-01-01T00:00:00.000Z', evidence: { episodeId: episode.id, excerpt: original } });
  const before = readFactObservation(fact.id)!; const evidence = getFactEvidence(fact.id);
  const result = correctFactExact(request(fact.id)); assert.equal(result.status, 'corrected');
  if (result.status !== 'corrected') return;
  assert.deepEqual(readFactObservation(fact.id)!.provenance, before.provenance);
  assert.deepEqual(getFactEvidence(fact.id), evidence);
  const after = result.proof.after;
  assert.equal(after.provenance.sourceApp, 'Conversation');
  assert.equal(after.provenance.sourceSessionId, owner.sessionId);
  assert.equal(after.provenance.sourcePath, `conversation://${owner.sessionId}/user-source:${owner.sourceUserSeq}`);
  assert.equal(after.provenance.derivedFromSessionId, null); assert.equal(after.provenance.derivedFromCallId, null);
  assert.equal(after.provenance.derivedFromTool, null); assert.equal(after.provenance.extractedAt, after.createdAt);
  assert.equal(after.provenance.trustLevel, before.provenance.trustLevel);
  assert.equal(after.provenance.confidence, before.provenance.confidence);
  assert.equal(after.provenance.derivationDepth, before.provenance.derivationDepth);
  assert.deepEqual(after.provenance.derivedFromFactIds, [ancestor.id, fact.id]);
  assert.deepEqual(after.scope, before.scope); assert.equal(after.content, revised);
});
