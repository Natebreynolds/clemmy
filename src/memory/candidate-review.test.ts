import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-candidate-review';
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
delete process.env.OPENAI_API_KEY;

const { closeMemoryDb, openMemoryDb, resetMemoryDb } = await import('./db.js');
const { recordMemoryEpisode } = await import('./temporal-memory.js');
const { recordReflectionCandidate } = await import('./reflection-candidates.js');
const { rememberFact } = await import('./facts.js');
const {
  promoteReflectionCandidateById,
  rejectReflectionCandidateById,
  rejectReflectionCandidateClusterById,
  reconcileKnownPendingCandidates,
} = await import('./candidate-review.js');

beforeEach(() => resetMemoryDb());
after(() => {
  closeMemoryDb();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function meetingCandidate(source: string, text: string): number {
  const episode = recordMemoryEpisode({
    kind: 'tool_result', subtype: 'meeting', title: `Meeting ${source}`,
    sourceApp: 'Clementine Meetings (In-person)',
    sessionId: `meeting:${source}`, callId: source,
    sourceUri: `meeting://local/${source}`,
    occurredAt: '2026-07-15T17:00:00.000Z',
    content: `Decisions: ${text}`,
  });
  return recordReflectionCandidate({
    episodeId: episode.id, sessionId: `meeting:${source}`, callId: source,
    kind: 'project', text, importance: 7, sourceType: 'meeting_analysis',
    intakeReason: 'structured meeting decision', trustLevel: 0.82,
    authority: 'derived', sourceUri: episode.source_uri,
  });
}

test('owner-approved meeting proposals consolidate repeats and preserve every source', async () => {
  const text = 'Decision from Orchid launch review (2026-07-15): Launch the migration on Friday';
  const firstId = meetingCandidate('orchid-a', text);
  const first = await promoteReflectionCandidateById(firstId);
  assert.equal(first?.action, 'add');
  assert.ok(first?.factId);

  const secondId = meetingCandidate('orchid-b', text);
  const second = await promoteReflectionCandidateById(secondId);
  assert.equal(second?.action, 'reinforce');
  assert.equal(second?.factId, first?.factId, 'a repeated decision reinforces the canonical claim');

  const db = openMemoryDb();
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM consolidated_facts WHERE active = 1').get() as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM fact_evidence WHERE fact_id = ?').get(first?.factId) as { count: number }).count, 2,
    'both meeting episodes remain attached as independent evidence');
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM memory_reflection_candidates WHERE status = 'promoted'").get() as { count: number }).count, 2);
  assert.equal(await promoteReflectionCandidateById(secondId), null, 'replaying owner approval cannot promote twice');
});

test('one approval coalesces an exact pending cluster and fans in every durable source', async () => {
  const text = 'Decision from Orchid launch review (2026-07-15): Launch the migration on Friday';
  const firstId = meetingCandidate('orchid-cluster-a', text);
  const secondId = meetingCandidate('orchid-cluster-b', text);

  const approved = await promoteReflectionCandidateById(firstId);
  assert.equal(approved?.action, 'add');
  assert.deepEqual(approved?.coalescedCandidateIds, [secondId]);
  assert.equal(approved?.evidenceSourcesAdded, 2);
  assert.ok(approved?.factId);

  const db = openMemoryDb();
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM consolidated_facts WHERE active = 1').get() as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM fact_evidence WHERE fact_id = ?').get(approved?.factId) as { count: number }).count, 2);
  const rows = db.prepare(`
    SELECT id, status, resulting_fact_id, reason
    FROM memory_reflection_candidates ORDER BY id ASC
  `).all() as Array<{ id: number; status: string; resulting_fact_id: number; reason: string }>;
  assert.deepEqual(rows.map((row) => ({ id: row.id, status: row.status, factId: row.resulting_fact_id })), [
    { id: firstId, status: 'promoted', factId: approved?.factId },
    { id: secondId, status: 'promoted', factId: approved?.factId },
  ]);
  assert.match(rows[1]?.reason ?? '', /^owner_approved_exact_cluster:/);
  assert.equal(await promoteReflectionCandidateById(secondId), null);
});

test('one rejection resolves an exact pending cluster without deleting source history', () => {
  const text = 'Decision from Orchid review: Defer the migration';
  const firstId = meetingCandidate('orchid-reject-cluster-a', text);
  const secondId = meetingCandidate('orchid-reject-cluster-b', text);
  const rejected = rejectReflectionCandidateClusterById(firstId);
  assert.deepEqual(rejected?.rejectedCandidateIds, [firstId, secondId]);
  assert.equal(rejectReflectionCandidateClusterById(secondId), null);
  const db = openMemoryDb();
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM memory_reflection_candidates WHERE status = 'rejected'").get() as { count: number }).count, 2);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM memory_episodes').get() as { count: number }).count, 2);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM consolidated_facts').get() as { count: number }).count, 0);
});

test('maintenance automatically attaches evidence for exact already-known claims only', () => {
  const text = 'The Orchid launch is approved for Friday.';
  const fact = rememberFact({ kind: 'project', content: text, importance: 5, trustLevel: 1 });
  const firstId = meetingCandidate('orchid-known-a', text);
  const secondId = meetingCandidate('orchid-known-b', `  ${text}  `);
  const novelId = meetingCandidate('orchid-novel', 'The Orchid launch requires a new security review.');

  const result = reconcileKnownPendingCandidates({ limit: 20, now: '2026-07-15T22:00:00.000Z' });
  assert.equal(result.matched, 2);
  assert.equal(result.resolved, 2);
  assert.equal(result.failed, 0);

  const db = openMemoryDb();
  const canonical = db.prepare(`
    SELECT score, importance, trust_level FROM consolidated_facts WHERE id = ?
  `).get(fact.id) as { score: number; importance: number; trust_level: number };
  assert.deepEqual(canonical, { score: 1, importance: 5, trust_level: 1 },
    'evidence reconciliation must not increase popularity, importance, or trust');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM fact_evidence WHERE fact_id = ?').get(fact.id) as { count: number }).count, 3,
    'the original manual source and both new meeting sources remain independent evidence');
  const candidates = db.prepare(`
    SELECT id, status, reason, resulting_fact_id
    FROM memory_reflection_candidates ORDER BY id
  `).all() as Array<{ id: number; status: string; reason: string | null; resulting_fact_id: number | null }>;
  assert.deepEqual(candidates.map((row) => ({ id: row.id, status: row.status, factId: row.resulting_fact_id })), [
    { id: firstId, status: 'promoted', factId: fact.id },
    { id: secondId, status: 'promoted', factId: fact.id },
    { id: novelId, status: 'pending', factId: null },
  ]);
  assert.equal(candidates[0]?.reason, 'automatic_exact_reinforce');
  assert.equal(candidates[1]?.reason, 'automatic_exact_reinforce');
});

test('owner rejection resolves only the proposal and leaves its source episode intact', () => {
  const id = meetingCandidate('orchid-reject', 'Decision from Orchid review: Defer the migration');
  assert.equal(rejectReflectionCandidateById(id), true);
  assert.equal(rejectReflectionCandidateById(id), false);
  const db = openMemoryDb();
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM consolidated_facts').get() as { count: number }).count, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM memory_episodes').get() as { count: number }).count, 1);
});
