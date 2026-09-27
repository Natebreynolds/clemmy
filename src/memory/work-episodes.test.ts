/**
 * Work episodes: finished work is remembered like a cache, surfaces with its
 * age, loses its handles after the fresh window, and is deleted after the
 * summary window.
 *
 * Run: node scripts/run-tests-isolated.mjs src/memory/work-episodes.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-work-episodes-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';
delete process.env.OPENAI_API_KEY;
const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const work = await import('./work-episodes.js');
const { recallEverything } = await import('./unified-recall.js');
const retention = await import('./conversation-retention.js');
const { recordMemoryEpisode } = await import('./temporal-memory.js');

after(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });

test('a finished plan is remembered with its revision, surfaces for the same request with its age, then decays', async () => {
  resetMemoryDb();
  const finishedAt = '2026-09-26T16:00:00.000Z';
  const recorded = work.recordWorkEpisode({
    kind: 'plan', sessionId: 'sess-plan-a', sourceUserSeq: 41,
    objective: 'Can we scrape 10 DUI law firms in Austin and draft outreach emails?',
    outcome: 'A ready plan: find firms via DataForSEO, verify sites, draft five emails.',
    finishedAt,
    plan: { planId: 'plan-7f', revision: 3, digest: 'a'.repeat(64), readiness: 'ready' },
  });
  assert.ok(recorded);
  const row = openMemoryDb().prepare('SELECT * FROM memory_episodes WHERE id = ?').get(recorded!.id) as Record<string, unknown>;
  assert.equal(row.subtype, 'completed_work');
  assert.equal(row.title, 'Completed plan: Can we scrape 10 DUI law firms in Austin and draft outreach emails?');
  assert.match(String(row.evidence_excerpt), /Planned at 2026-09-26T16:00:00.000Z/);
  assert.match(String(row.evidence_excerpt), /publish_plan with base_ref_json=\{"planId":"plan-7f","revision":3,"digest":"a{64}"\}/);
  assert.equal(row.raw_retained_until, '2026-10-03T16:00:00.000Z', 'fresh for seven days');
  assert.deepEqual(JSON.parse(String(row.metadata_json)).plan, { planId: 'plan-7f', revision: 3, digest: 'a'.repeat(64), readiness: 'ready' });

  // Recording the same request again updates the same row.
  const again = work.recordWorkEpisode({ kind: 'plan', sessionId: 'sess-plan-a', sourceUserSeq: 41, objective: 'Can we scrape 10 DUI law firms in Austin and draft outreach emails?', outcome: 'revised', finishedAt, plan: { planId: 'plan-7f', revision: 4, digest: 'b'.repeat(64), readiness: 'ready' } });
  assert.equal(again!.id, recorded!.id);
  assert.equal((openMemoryDb().prepare("SELECT COUNT(*) AS n FROM memory_episodes WHERE subtype = 'completed_work'").get() as { n: number }).n, 1);

  // The next request for the same work finds it, dated.
  const recall = await recallEverything('scrape 10 DUI law firms in Austin', { limit: 10 });
  const hit = recall.hits.find((h) => h.type === 'episode' && /Completed plan/.test(h.title));
  assert.ok(hit, `the primer offers the finished plan: ${JSON.stringify(recall.hits.map((h) => [h.type, h.title]))}`);
  assert.equal(hit!.validFrom, finishedAt, 'its age is shown');
  assert.match(hit!.snippet, /base_ref_json/, 'and how to reuse it');

  // Fresh window over: the handles go, the memory stays.
  const summarized = work.decayWorkEpisodes({ now: '2026-10-04T00:00:00.000Z' });
  assert.deepEqual(summarized, { summarized: 1, deleted: 0 });
  const later = openMemoryDb().prepare('SELECT status, evidence_excerpt, metadata_json FROM memory_episodes WHERE id = ?').get(recorded!.id) as Record<string, string>;
  assert.equal(later.status, 'partial');
  assert.doesNotMatch(later.evidence_excerpt, /base_ref_json/);
  assert.match(later.evidence_excerpt, /handles expired/);
  assert.deepEqual(JSON.parse(later.metadata_json), { workKind: 'plan', finishedAt, handlesExpired: true });
  assert.deepEqual(work.decayWorkEpisodes({ now: '2026-10-05T00:00:00.000Z' }), { summarized: 0, deleted: 0 }, 'summarized once');

  // Summary window over: gone.
  assert.deepEqual(work.decayWorkEpisodes({ now: '2026-10-27T00:00:00.000Z' }), { summarized: 0, deleted: 1 });
  assert.equal((openMemoryDb().prepare("SELECT COUNT(*) AS n FROM memory_episodes WHERE subtype = 'completed_work'").get() as { n: number }).n, 0);
});

test('an answer remembers where its results live; other episodes are never decayed by the work sweep', () => {
  resetMemoryDb();
  const recorded = work.recordWorkEpisode({
    kind: 'answer', sessionId: 'sess-audit', sourceUserSeq: 9,
    objective: 'Quick SEO audit of tobinlawoffice.com: keyword footprint and top money terms.',
    outcome: 'Footprint 1,318 keywords; top money terms table.',
    finishedAt: '2026-09-26T20:53:00.000Z',
    resultHandleIds: ['rh_1', 'rh_2', 'rh_3'], toolsUsed: ['dataforseo__api_request'],
  });
  assert.ok(recorded);
  const row = openMemoryDb().prepare('SELECT evidence_excerpt, metadata_json FROM memory_episodes WHERE id = ?').get(recorded!.id) as Record<string, string>;
  assert.match(row.evidence_excerpt, /3 retained results in session sess-audit/);
  assert.match(row.evidence_excerpt, /reuse them only with their age stated/);
  assert.deepEqual(JSON.parse(row.metadata_json).resultHandleIds, ['rh_1', 'rh_2', 'rh_3']);
  // An unrelated old episode of another subtype is untouched by the work sweep.
  recordMemoryEpisode({ kind: 'import', subtype: 'meeting', title: 'Old meeting', content: 'notes', occurredAt: '2020-01-01T00:00:00.000Z', sessionId: 'meeting:x', callId: 'm1' });
  assert.deepEqual(work.decayWorkEpisodes({ now: '2026-12-31T00:00:00.000Z' }), { summarized: 0, deleted: 1 });
  assert.equal((openMemoryDb().prepare("SELECT COUNT(*) AS n FROM memory_episodes WHERE subtype = 'meeting'").get() as { n: number }).n, 1);
});

test('the retention pass decays work episodes by default, and no sooner than the configured session policy allows', () => {
  resetMemoryDb();
  work.recordWorkEpisode({ kind: 'answer', sessionId: 's', sourceUserSeq: 1, objective: 'old work', outcome: 'done', finishedAt: '2020-01-01T00:00:00.000Z' });
  const reaped = retention.reapConfiguredConversationHistory({ policy: retention.automaticConversationRetentionPolicy({}) });
  assert.equal(reaped.workEpisodes, 1, 'a work episode is a cache entry: it decays without an operator policy');
});
