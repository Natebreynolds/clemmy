import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-source-boundary-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1', CLEMMY_RUN_TOKEN_BUDGET: 'on' });
const log = await import('./eventlog.js');
const { recordModelUsage } = await import('../usage-log.js');
const { captureSourceBudgetPolicy } = await import('./source-budget-policy.js');
const { assertSourceBudgetBeforeModel: check, readReportedTaskUsage: read, SourceBudgetBoundaryError } = await import('./source-budget-boundary.js');
after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

interface FixtureSource { sessionId: string; sourceUserSeq: number; id: string }
function source(sessionId: string, parent?: FixtureSource): FixtureSource {
  if (!log.getSession(sessionId)) log.createSession({ id: sessionId, kind: 'chat' });
  const event = log.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received',
    ...(parent ? { parentEventId: parent.id } : {}), data: { text: 'recording fixture',
      ...(parent ? { delegatedWorker: { parentSessionId: parent.sessionId, parentSourceUserSeq: parent.sourceUserSeq } } : {}) } });
  return { sessionId, sourceUserSeq: event.seq, id: event.id };
}
function worker(parent: ReturnType<typeof source>, child: ReturnType<typeof source>, extra: Record<string, unknown> = {}) {
  return log.appendEvent({ sessionId: parent.sessionId, turn: 1, role: 'system', type: 'worker_started', data: {
    parentSessionId: parent.sessionId, parentSourceUserSeq: parent.sourceUserSeq,
    childSessionId: child.sessionId, childSourceUserSeq: child.sourceUserSeq, ...extra } });
}
function policy(owner: ReturnType<typeof source>, tokens = 100, ms = 0) {
  return captureSourceBudgetPolicy(owner, { maxRunTokens: tokens, maxWallClockMs: ms })!.policy;
}
function record(owner: ReturnType<typeof source>, extra: Partial<Parameters<typeof recordModelUsage>[0]> = {}) {
  recordModelUsage({ ...owner, model: 'recording-budget-model', cacheDialect: 'inclusive',
    inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, role: 'brain', ...extra });
}
const limit = (reason: string, observed?: number) => (error: unknown) => error instanceof SourceBudgetBoundaryError
  && error.reason === reason && (observed === undefined || error.evidence.observed === observed);

test('all recorded lanes and resumed attempts spend the original allowance, not another turn’s', () => {
  const owner = source('budget-lanes');
  const original = policy(owner, 180);
  const unrelated = source(owner.sessionId);
  record(unrelated, { inputTokens: 90_000 });
  for (const role of ['brain', 'worker', 'reviewer', 'router', 'writer', 'memory'] as const) record(owner, { role, attemptId: `attempt-${role}` });
  log.closeEventLog();
  assert.equal(read(owner).uncachedWorkTokens, 180);
  assert.throws(() => check(original, 1), limit('token_budget', 180));
});

test('nested worker receipts count once; unrelated child sources and sessions stay separate', () => {
  const parent = source('budget-parent');
  const p = policy(parent, 90);
  const child = source('budget-child', parent);
  const grandchild = source('budget-grandchild', child);
  worker(parent, child); worker(parent, child); worker(child, grandchild);
  record(parent); record(child); record(grandchild);
  record(source(child.sessionId), { inputTokens: 50_000 });
  record(source('budget-unrelated'), { inputTokens: 50_000 });
  const result = read(parent);
  assert.equal(result.calls, 3);
  assert.equal(result.participants.length, 3);
  assert.deepEqual(result.unknown, []);
  assert.throws(() => check(p, 1), limit('token_budget', 90));
});

test('conflicting or unproven worker links cannot borrow costs or appear complete', () => {
  const parent = source('budget-link-parent');
  const p = policy(parent);
  const foreign = source('budget-link-foreign');
  record(foreign, { inputTokens: 20_000 });
  worker(parent, foreign);
  const child = source('budget-link-child', parent);
  worker(parent, child, { sourceUserSeq: foreign.sourceUserSeq });
  const result = read(parent);
  assert.equal(result.uncachedWorkTokens, 0);
  assert.deepEqual(result.unknown.map(row => row.reason), ['invalid_worker_link', 'invalid_worker_link']);
  assert.throws(() => check(p, 1), limit('budget_usage_unavailable'));
});

test('a failed call with unreported cost does not buy a free bounded retry', () => {
  const owner = source('budget-unknown');
  const p = policy(owner);
  record(owner, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, ok: false });
  assert.throws(() => check(p, 1), limit('budget_usage_unavailable'));
});

test('unlimited or disabled token policy requires no usage read; time remains independently limited', () => {
  const owner = source('budget-disabled');
  const p = policy(owner, 0, 100);
  const db = log.openEventLog();
  db.exec('ALTER TABLE accepted_source_usage_v1 RENAME TO temporarily_unavailable_usage');
  try {
    assert.doesNotThrow(() => check(p, 99));
    assert.doesNotThrow(() => check({ ...p, maxUncachedTokens: 10, tokenEnforcementEnabled: false }, 99));
    assert.throws(() => check(p, 100), limit('wall_clock', 100));
    assert.throws(() => check({ ...p, maxUncachedTokens: 10 }, 99), limit('budget_usage_unavailable'));
  } finally { db.exec('ALTER TABLE temporarily_unavailable_usage RENAME TO accepted_source_usage_v1'); }
});

test('pre-meter sources stay unknown with a configured token limit', () => {
  const owner = source('budget-old');
  const p = policy(owner);
  log.openEventLog().prepare('UPDATE events SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', owner.id);
  assert.throws(() => check(p, 1), limit('budget_usage_unavailable'));
});

test('certified cache credit and conservative unknown dialect charges remain distinct', () => {
  const owner = source('budget-cache');
  const p = policy(owner, 100);
  record(owner);
  assert.doesNotThrow(() => check(p, 1));
  record(owner, { cacheDialect: 'unknown' });
  assert.throws(() => check(p, 1), limit('token_budget', 140));
});
