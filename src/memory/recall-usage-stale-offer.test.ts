import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-recall-stale-offer-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_EMBEDDINGS = 'off';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.CLEMMY_AUTO_RECALL_CREDIT = 'on';
const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const { rememberFact, getFact, forgetFact, reactivateFact } = await import('./facts.js');
const { recordRecallRun, recordRecallUse } = await import('./recall-usage.js');
const { autoCreditRecallRuns } = await import('./recall-auto-credit.js');
const { readHygieneAudit } = await import('./hygiene-audit.js');

beforeEach((t) => {
  assert.ok('mock' in t, 'the lifecycle fixture requires an individual test context');
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T12:00:00.000Z') });
  resetMemoryDb();
  rmSync(path.join(testHome, 'state', 'memory-hygiene.jsonl'), { force: true });
});
after(() => rmSync(testHome, { recursive: true, force: true }));

function offer(factId: number, nowIso?: string) {
  return recordRecallRun({
    objective: 'Use the relevant recurring convention.', surface: 'automatic_primer', answerability: 'supported',
    candidateRefs: [{ type: 'fact', id: String(factId) }, { type: 'policy', id: String(factId) }], nowIso,
  });
}

test('real recall → forget → readback → cited reply preserves the retirement and auditable use', (t) => {
  const fact = rememberFact({ kind: 'user', content: 'Recurring explanations use a concise numbered format.' });
  const run = offer(fact.id);
  t.mock.timers.tick(1);
  assert.equal(forgetFact(fact.id), true);
  const retired = getFact(fact.id)!;
  assert.equal(retired.active, false, 'the same canonical readback used by memory tools');
  t.mock.timers.tick(1);
  const input = { recallIds: [run.id], replyText: `Soft-forgot fact:${fact.id}; policy:${fact.id} is inactive.` };
  assert.equal(autoCreditRecallRuns(input)[0]?.credited.length, 2, 'cited use remains recorded, not silently discarded');
  autoCreditRecallRuns(input);
  const afterCredit = getFact(fact.id)!;
  assert.equal(afterCredit.active, false);
  assert.equal(afterCredit.updatedAt, retired.updatedAt);
  assert.equal(afterCredit.utilityCount, 0);
  assert.equal(afterCredit.accessCount, retired.accessCount);
  assert.equal(afterCredit.lastUsedAt, retired.lastUsedAt);
  const uses = openMemoryDb().prepare('SELECT count(*) AS n FROM memory_recall_uses WHERE recall_id = ?').get(run.id) as { n: number };
  const counter = openMemoryDb().prepare('SELECT used_total FROM memory_recall_run_tombstones WHERE day = ?').get(run.createdAt.slice(0, 10)) as { used_total: number };
  assert.equal(uses.n, 2);
  assert.equal(counter.used_total, 1, 'historical used-run credit remains idempotent');
  assert.equal(readHygieneAudit().length, 0, 'no false resurrection receipt');
});

test('a cold-tier fact archived before recall still earns one canonical restore and one credit across aliases', (t) => {
  const fact = rememberFact({ kind: 'project', content: 'The Zephyr review owner is the operations lead.' });
  forgetFact(fact.id);
  t.mock.timers.tick(1);
  const run = offer(fact.id);
  t.mock.timers.tick(1);
  const input = { recallId: run.id, refs: [`fact:${fact.id}`, `policy:${fact.id}`], detail: 'auto:cited' };
  const credited = recordRecallUse(input);
  assert.deepEqual(credited.resurrectedFactIds, [fact.id]);
  assert.deepEqual(credited.utilityFactIds, [fact.id]);
  assert.equal(credited.recorded.length, 2);
  assert.equal(getFact(fact.id)?.active, true);
  assert.equal(getFact(fact.id)?.utilityCount, 1);
  assert.equal(recordRecallUse(input).duplicates.length, 2);
  assert.equal(getFact(fact.id)?.utilityCount, 1);
  assert.deepEqual(readHygieneAudit().map((row) => [row.kind, row.ids]), [['resurrect', [fact.id]]]);
});

test('same-millisecond recall and later forget fail closed even with repeated nowIso', () => {
  const fact = rememberFact({ kind: 'user', content: 'Keep the recurring answer short.' });
  const nowIso = new Date().toISOString();
  const run = offer(fact.id, nowIso);
  forgetFact(fact.id);
  assert.equal(getFact(fact.id)?.updatedAt, run.createdAt);
  const result = recordRecallUse({ recallId: run.id, refs: [`fact:${fact.id}`], nowIso });
  assert.equal(result.recorded.length, 1);
  assert.deepEqual(result.resurrectedFactIds, []);
  assert.equal(getFact(fact.id)?.active, false);
});

test('a fresh deactivation after cold-tier recall overrides the older archive', (t) => {
  const fact = rememberFact({ kind: 'project', content: 'The renewal meeting is Wednesday.' });
  forgetFact(fact.id);
  t.mock.timers.tick(1);
  const run = offer(fact.id);
  t.mock.timers.tick(1);
  forgetFact(fact.id);
  t.mock.timers.tick(1);
  const result = recordRecallUse({ recallId: run.id, refs: [`policy:${fact.id}`] });
  assert.deepEqual(result.resurrectedFactIds, []);
  assert.equal(getFact(fact.id)?.active, false);
});

test('promoting an earlier not-useful receipt cannot revive a fact forgotten after admission', (t) => {
  const fact = rememberFact({ kind: 'reference', content: 'The obsolete resource endpoint is retired.' });
  const run = offer(fact.id);
  recordRecallUse({ recallId: run.id, refs: [`fact:${fact.id}`], outcome: 'not_useful' });
  t.mock.timers.tick(1);
  forgetFact(fact.id);
  t.mock.timers.tick(1);
  const result = recordRecallUse({ recallId: run.id, refs: [`fact:${fact.id}`, `policy:${fact.id}`] });
  assert.equal(result.recorded.length, 2);
  assert.deepEqual(result.utilityFactIds, []);
  assert.equal(getFact(fact.id)?.active, false);
  assert.equal(getFact(fact.id)?.utilityCount, 0);
  const uses = openMemoryDb().prepare("SELECT count(*) AS n FROM memory_recall_uses WHERE recall_id = ? AND outcome = 'used'").get(run.id) as { n: number };
  assert.equal(uses.n, 2);
});

test('canonical explicit restore remains valid despite an old offered ref', (t) => {
  const fact = rememberFact({ kind: 'user', content: 'The user restored the concise answer convention.' });
  const run = offer(fact.id);
  t.mock.timers.tick(1);
  forgetFact(fact.id);
  t.mock.timers.tick(1);
  assert.equal(reactivateFact(fact.id), true);
  const result = recordRecallUse({ recallId: run.id, refs: [`fact:${fact.id}`] });
  assert.deepEqual(result.resurrectedFactIds, [], 'restoration authority came from the explicit restore, not recall credit');
  assert.deepEqual(result.utilityFactIds, [fact.id]);
  assert.equal(getFact(fact.id)?.active, true);
  assert.equal(getFact(fact.id)?.utilityCount, 1);
});

test('superseded cold-tier rows remain inactive even when they predate recall', (t) => {
  const old = rememberFact({ kind: 'project', content: 'The project review closes in April.' });
  const replacement = rememberFact({ kind: 'project', content: 'The project review closes in May.' });
  forgetFact(old.id);
  openMemoryDb().prepare('UPDATE consolidated_facts SET superseded_by_fact_id = ? WHERE id = ?').run(replacement.id, old.id);
  t.mock.timers.tick(1);
  const result = recordRecallUse({ recallId: offer(old.id).id, refs: [`fact:${old.id}`] });
  assert.deepEqual(result.utilityFactIds, []);
  assert.equal(getFact(old.id)?.active, false);
  assert.equal(getFact(replacement.id)?.active, true);
});

for (const [label, value] of [
  ['malformed', 'not-a-timestamp'], ['permissively parsed', '0'],
  ['noncanonical precision', '2026-10-09T11:59:59Z'], ['normalized invalid date', '2026-02-31T11:59:59.000Z'],
] as const) {
  test(`${label} durable timestamps cannot authorize automatic resurrection`, (t) => {
    for (const target of ['recall', 'archive'] as const) {
      const fact = rememberFact({ kind: 'user', content: `A ${target} timestamp must not manufacture restore authority.` });
      forgetFact(fact.id);
      t.mock.timers.tick(1);
      const run = offer(fact.id);
      if (target === 'recall') openMemoryDb().prepare('UPDATE memory_recall_runs SET created_at = ? WHERE id = ?').run(value, run.id);
      if (target === 'archive') openMemoryDb().prepare('UPDATE consolidated_facts SET updated_at = ? WHERE id = ?').run(value, fact.id);
      const result = recordRecallUse({ recallId: run.id, refs: [`fact:${fact.id}`] });
      assert.equal(result.ok, true, 'an unexpired durable run retains its use receipt');
      assert.deepEqual(result.resurrectedFactIds, []);
      assert.equal(getFact(fact.id)?.active, false);
    }
  });
}
