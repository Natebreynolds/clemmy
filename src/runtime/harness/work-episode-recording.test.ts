/**
 * The two recording moments read the accepted request from the eventlog and
 * leave a work episode; an unaccepted source leaves nothing.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/work-episode-recording.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-work-recording-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.EMBEDDINGS_DISABLED = 'true';
delete process.env.OPENAI_API_KEY;
const log = await import('./eventlog.js');
const { openMemoryDb, resetMemoryDb } = await import('../../memory/db.js');
const recording = await import('./work-episode-recording.js');
const { WORK_EPISODE_SUBTYPE } = await import('../../memory/work-episodes.js');

after(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });

function workEpisodes(): Array<{ title: string; evidence_excerpt: string; metadata_json: string }> {
  return openMemoryDb().prepare('SELECT title, evidence_excerpt, metadata_json FROM memory_episodes WHERE subtype = ? ORDER BY title')
    .all(WORK_EPISODE_SUBTYPE) as Array<{ title: string; evidence_excerpt: string; metadata_json: string }>;
}

test('a published plan and a committed answer each leave a work episode keyed to the accepted request', () => {
  log.resetEventLog();
  resetMemoryDb();
  const session = log.createSession({ id: 'work-episodes', kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Scrape 10 DUI law firms in Austin and draft outreach emails.' } });

  recording.recordPlanWorkEpisode({
    version: 1, sessionId: session.id, principalId: 'owner', sourceUserSeq: source.seq, sourceEventId: source.id,
    sourceDigest: 'c'.repeat(64), createdAt: '2026-09-26T18:00:00.000Z', fullText: '1. Find firms. 2. Verify sites. 3. Draft emails.',
    readiness: 'ready', missingPrerequisites: [], planId: 'plan-1', revision: 2, digest: 'd'.repeat(64),
  });
  // The plan turn's own reply presents the plan: no second episode for the same request.
  recording.recordAnswerWorkEpisode({ sessionId: session.id, sourceUserSeq: source.seq, text: 'Here is the plan.', finishedAt: '2026-09-26T18:01:00.000Z' });
  const answerSource = log.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Run it.' } });
  recording.recordAnswerWorkEpisode({ sessionId: session.id, sourceUserSeq: answerSource.seq, text: 'Here are the 10 firms and five drafts.', finishedAt: '2026-09-26T18:05:00.000Z' });

  const rows = workEpisodes();
  assert.deepEqual(rows.map(r => r.title), [
    'Completed answer: Run it.',
    'Completed plan: Scrape 10 DUI law firms in Austin and draft outreach emails.',
  ]);
  const plan = JSON.parse(rows[1].metadata_json);
  assert.deepEqual(plan.plan, { planId: 'plan-1', revision: 2, digest: 'd'.repeat(64), readiness: 'ready' });
  assert.match(rows[1].evidence_excerpt, /Ready plan, revision 2: 1\. Find firms/);
  assert.match(rows[1].evidence_excerpt, /base_ref_json=\{"planId":"plan-1","revision":2/);
  assert.match(rows[0].evidence_excerpt, /Answered at 2026-09-26T18:05:00.000Z: Here are the 10 firms/);
  assert.equal(JSON.parse(rows[0].metadata_json).resultHandleIds, undefined, 'no retained results, no handle list');

  // A source that is not an accepted user event in this session records nothing.
  recording.recordAnswerWorkEpisode({ sessionId: session.id, sourceUserSeq: answerSource.seq + 7, text: 'orphan' });
  assert.equal(workEpisodes().length, 2);
});
