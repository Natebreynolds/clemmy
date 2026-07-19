import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-temporal-memory';
process.env.CLEMENTINE_HOME = TEST_HOME;
delete process.env.OPENAI_API_KEY;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const { getFact, getFactAt, getFactValidityIntervals, reactivateFact, rememberFact, supersedeFact } = await import('./facts.js');
const {
  backfillTemporalEvidence,
  countUnreconciledFactEvidence,
  getFactEvidence,
  readTemporalEvidenceHealth,
  reconcileTemporalEvidence,
  recordMemoryEpisode,
} = await import('./temporal-memory.js');
const { recallMemory } = await import('./recall-memory.js');
const {
  createSession,
  getToolOutput,
  openEventLog,
  resetEventLog,
  writeToolOutput,
} = await import('../runtime/harness/eventlog.js');

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => {
  resetMemoryDb();
  resetEventLog();
});

test('every new direct fact receives durable, exact evidence', () => {
  const fact = rememberFact({ kind: 'user', content: 'My preferred timezone is America/Los_Angeles.' });
  const evidence = getFactEvidence(fact.id);

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].excerpt, fact.content);
  assert.equal(evidence[0].status, 'available');
});

test('derived fact evidence survives raw tool-output expiry', () => {
  const session = createSession({ kind: 'chat' });
  writeToolOutput({
    sessionId: session.id,
    callId: 'call-evidence',
    tool: 'crm_lookup',
    output: 'CRM record: Acme renewal closes on September 30. Owner: Dana.',
  });
  const fact = rememberFact({
    kind: 'project',
    content: 'The Acme renewal closes on September 30.',
    derivedFrom: { sessionId: session.id, callId: 'call-evidence', tool: 'crm_lookup' },
    sourceApp: 'CRM',
  });
  const beforeExpiry = getFactEvidence(fact.id);
  assert.equal(beforeExpiry.length, 1);
  assert.match(beforeExpiry[0].excerpt, /September 30/);

  openEventLog().prepare('DELETE FROM tool_outputs WHERE session_id = ? AND call_id = ?')
    .run(session.id, 'call-evidence');
  assert.equal(getToolOutput(session.id, 'call-evidence'), null);

  const afterExpiry = getFactEvidence(fact.id);
  assert.deepEqual(afterExpiry, beforeExpiry, 'bounded evidence is independent of raw-output retention');
  const episode = openMemoryDb().prepare('SELECT status FROM memory_episodes WHERE id = ?')
    .get(afterExpiry[0].episodeId) as { status: string };
  assert.equal(episode.status, 'available');
});

test('delayed promotion reuses a pending episode excerpt after raw output is gone', () => {
  recordMemoryEpisode({
    kind: 'tool_result',
    sessionId: 'delayed-session',
    callId: 'delayed-call',
    sourceUri: 'tool://delayed-session/delayed-call',
    occurredAt: '2026-07-01T10:00:00.000Z',
    content: 'CRM record: Dana Smith is the billing contact for Acme.',
    status: 'pending',
  });
  assert.equal(getToolOutput('delayed-session', 'delayed-call'), null);

  const fact = rememberFact({
    kind: 'reference',
    content: 'Dana Smith is the billing contact for Acme.',
    derivedFrom: { sessionId: 'delayed-session', callId: 'delayed-call', tool: 'crm_lookup' },
  });
  const evidence = getFactEvidence(fact.id);
  assert.equal(evidence.length, 1);
  assert.match(evidence[0].excerpt, /Dana Smith is the billing contact for Acme/);
  assert.equal(evidence[0].status, 'available');
  const episode = openMemoryDb().prepare(`
    SELECT status, evidence_excerpt FROM memory_episodes
    WHERE session_id = 'delayed-session' AND call_id = 'delayed-call'
  `).get() as { status: string; evidence_excerpt: string | null };
  assert.equal(episode.status, 'available');
  assert.match(episode.evidence_excerpt ?? '', /Dana Smith/);
});

test('missing derived provenance is linked as unavailable without fabricating an excerpt', async () => {
  const fact = rememberFact({
    kind: 'project',
    content: 'The unavailable CRM source claimed the renewal was delayed.',
    derivedFrom: { sessionId: 'missing-session', callId: 'missing-call', tool: 'crm_lookup' },
  });
  const evidence = getFactEvidence(fact.id);
  assert.equal(evidence.length, 1, 'the unavailable episode remains linked to its fact');
  assert.equal(evidence[0].status, 'missing');
  assert.equal(evidence[0].excerpt, '', 'the claim text is never substituted for missing source evidence');
  assert.deepEqual(readTemporalEvidenceHealth(), {
    evidenceAvailable: 0,
    evidenceUnavailable: 1,
    unreconciledEvidence: 0,
    unreconciledDerivedEvidence: 0,
    unavailableDerivedEvidence: 1,
    brokenEvidence: 1,
    missingEpisodes: 1,
    evidenceCoverage: 1,
  });

  const recall = await recallMemory('unavailable CRM renewal delayed', { stores: ['fact'], graphDepth: 0 });
  const hit = recall.hits.find((item) => item.ref.type === 'fact' && item.ref.id === String(fact.id));
  assert.ok(hit);
  assert.deepEqual(hit?.evidence, [], 'unavailable provenance cannot support an answer');
  assert.equal(recall.answerability, 'partial');
});

test('health classifies a fact with usable and missing provenance as usable only', () => {
  const fact = rememberFact({ kind: 'project', content: 'The launch date is October 12.' });
  const db = openMemoryDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO memory_episodes
      (id, kind, occurred_at, ingested_at, content_hash, status)
    VALUES ('missing-secondary-source', 'import', ?, ?, 'missing', 'missing')
  `).run(now, now);
  db.prepare(`
    INSERT INTO fact_evidence (fact_id, episode_id, excerpt, ordinal, created_at)
    VALUES (?, 'missing-secondary-source', '', 1, ?)
  `).run(fact.id, now);

  const health = readTemporalEvidenceHealth();
  assert.equal(health.evidenceAvailable, 1);
  assert.equal(health.evidenceUnavailable, 0, 'health categories must not double-count the fact');
  assert.equal(health.evidenceCoverage, 1);
});

test('bounded evidence backfill always advances past unavailable legacy sources', () => {
  const facts = Array.from({ length: 4 }, (_, index) => rememberFact({
    kind: 'project',
    content: `Legacy derived claim ${index}.`,
    derivedFrom: { sessionId: `legacy-session-${index}`, callId: `legacy-call-${index}`, tool: 'legacy_tool' },
  }));
  const db = openMemoryDb();
  db.prepare('DELETE FROM fact_evidence').run();
  db.prepare('DELETE FROM memory_episodes').run();
  assert.equal(countUnreconciledFactEvidence(), 4);

  const first = backfillTemporalEvidence(2);
  assert.equal(first.scanned, 2);
  assert.equal(first.linked + first.missing, 2);
  assert.equal(first.remaining, 2);
  const firstIds = new Set((db.prepare('SELECT fact_id FROM fact_evidence').all() as Array<{ fact_id: number }>).map((row) => row.fact_id));

  const second = backfillTemporalEvidence(2);
  assert.equal(second.scanned, 2);
  assert.equal(second.linked + second.missing, 2);
  assert.equal(second.remaining, 0);
  assert.equal(countUnreconciledFactEvidence(), 0);
  assert.ok(facts.some((fact) => !firstIds.has(fact.id)), 'the second batch processes different facts');
});

test('operator reconciliation creates a backup and returns a complete audit report', () => {
  const fact = rememberFact({ kind: 'user', content: 'Legacy direct fact awaiting provenance reconciliation.' });
  const db = openMemoryDb();
  db.prepare('DELETE FROM fact_evidence WHERE fact_id = ?').run(fact.id);
  assert.equal(countUnreconciledFactEvidence(), 1);

  const report = reconcileTemporalEvidence({ maxFacts: 10, batchSize: 2, requireBackup: true });
  assert.equal(report.before, 1);
  assert.equal(report.processed, 1);
  assert.equal(report.available, 1);
  assert.equal(report.unavailable, 0);
  assert.equal(report.remaining, 0);
  assert.equal(report.complete, true);
  assert.ok(report.backupPath && existsSync(report.backupPath));
});

test('supersession returns the current claim now and the old claim historically', async () => {
  const old = rememberFact({
    kind: 'project',
    content: 'The quarterly revenue target is one million dollars.',
    occurredAt: '2025-01-01T00:00:00.000Z',
  });
  const replacement = supersedeFact(old.id, {
    content: 'The quarterly revenue target is two million dollars.',
    occurredAt: '2025-02-01T00:00:00.000Z',
  });
  assert.ok(replacement);
  assert.equal(getFact(old.id)?.validTo, '2025-02-01T00:00:00.000Z');
  assert.equal(getFact(old.id)?.supersededByFactId, replacement?.id);

  const historical = await recallMemory('quarterly revenue target', {
    stores: ['fact'],
    asOf: '2025-01-15T00:00:00.000Z',
    graphDepth: 0,
  });
  assert.equal(historical.hits[0]?.ref.id, String(old.id));
  assert.match(historical.hits[0]?.text ?? '', /one million/);

  const current = await recallMemory('quarterly revenue target', {
    stores: ['fact'],
    graphDepth: 0,
  });
  assert.equal(current.hits[0]?.ref.id, String(replacement?.id));
  assert.match(current.hits[0]?.text ?? '', /two million/);
});

test('repeatable validity preserves true → false → true without duplicate rows', async () => {
  const dana = rememberFact({
    kind: 'project',
    content: 'Dana owns the Orchid launch.',
    occurredAt: '2025-01-01T00:00:00.000Z',
  });
  const priya = supersedeFact(dana.id, {
    content: 'Priya owns the Orchid launch.',
    occurredAt: '2025-02-01T00:00:00.000Z',
  });
  assert.ok(priya);
  const danaAgain = supersedeFact(priya!.id, {
    content: 'Dana owns the Orchid launch.',
    occurredAt: '2025-03-01T00:00:00.000Z',
  });
  assert.equal(danaAgain?.id, dana.id, 'exact recurring content reuses the canonical claim row');
  assert.equal(getFact(dana.id)?.active, true);
  assert.equal(getFact(dana.id)?.validFrom, '2025-03-01T00:00:00.000Z');
  assert.equal(getFact(dana.id)?.validTo, null);
  assert.equal(getFact(dana.id)?.supersededByFactId, null);
  assert.deepEqual(
    getFactValidityIntervals(dana.id).map((interval) => [interval.validFrom, interval.validTo]),
    [
      ['2025-03-01T00:00:00.000Z', null],
      ['2025-01-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z'],
    ],
  );
  assert.equal(getFactAt(dana.id, '2025-02-15T00:00:00.000Z'), null, 'Dana claim is not valid during Priya period');

  const january = await recallMemory('who owns the Orchid launch', { stores: ['fact'], asOf: '2025-01-15T00:00:00.000Z', graphDepth: 0 });
  const february = await recallMemory('who owns the Orchid launch', { stores: ['fact'], asOf: '2025-02-15T00:00:00.000Z', graphDepth: 0 });
  const march = await recallMemory('who owns the Orchid launch', { stores: ['fact'], asOf: '2025-03-15T00:00:00.000Z', graphDepth: 0 });
  assert.match(january.hits[0]?.text ?? '', /Dana/);
  assert.match(february.hits[0]?.text ?? '', /Priya/);
  assert.match(march.hits[0]?.text ?? '', /Dana/);
});

test('manual restore opens a new validity interval and clears stale supersession fields', () => {
  const old = rememberFact({ kind: 'user', content: 'Alexander prefers Tuesday reviews.', occurredAt: '2025-01-01T00:00:00.000Z' });
  const replacement = supersedeFact(old.id, { content: 'Alexander prefers Wednesday reviews.', occurredAt: '2025-02-01T00:00:00.000Z' });
  assert.ok(replacement);
  assert.equal(reactivateFact(old.id), true);
  const restored = getFact(old.id)!;
  assert.equal(restored.validTo, null);
  assert.equal(restored.supersededByFactId, null);
  assert.equal(getFactValidityIntervals(old.id).length, 2);
});
