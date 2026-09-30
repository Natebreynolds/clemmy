import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-source-budget-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1',
  HARNESS_BUDGET_PRESET: 'unlimited', HARNESS_MAX_CONVERSATION_WALL_MINUTES: '0',
  HARNESS_MAX_RUN_TOKENS: '0', CLEMMY_RUN_TOKEN_BUDGET: 'on' });
const log = await import('./eventlog.js');
const budgets = await import('./source-budget-policy.js');
after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

function source(sessionId: string) {
  if (!log.getSession(sessionId)) log.createSession({ id: sessionId, kind: 'chat' });
  const event = log.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'recording fixture' } });
  return { sessionId, sourceUserSeq: event.seq };
}

test('a source keeps its original explicit policy across changed options and database reopen', () => {
  const owner = source('budget-original');
  const original = budgets.captureSourceBudgetPolicy(owner, { maxWallClockMs: 42_000, maxRunTokens: 1234 })!;
  log.closeEventLog();
  const resumed = budgets.captureSourceBudgetPolicy(owner, { maxWallClockMs: 0, maxRunTokens: 900_000 });
  assert.deepEqual(resumed, original);
  assert.deepEqual(original.policy, { version: 1, ...owner, maxActiveMs: 42_000, maxUncachedTokens: 1234, tokenEnforcementEnabled: true });
  assert.equal(log.listEvents(owner.sessionId, { types: ['accepted_source_budget'] }).length, 1);
});

test('unlimited and the existing token enforcement setting remain exact policies', () => {
  const before = process.env.CLEMMY_RUN_TOKEN_BUDGET;
  process.env.CLEMMY_RUN_TOKEN_BUDGET = 'off';
  try {
    const owner = source('budget-unlimited');
    const original = budgets.captureSourceBudgetPolicy(owner, { maxWallClockMs: 0, maxRunTokens: 0 })!;
    process.env.CLEMMY_RUN_TOKEN_BUDGET = 'on';
    assert.equal(budgets.captureSourceBudgetPolicy(owner)!.policy.tokenEnforcementEnabled, false);
    assert.equal(original.policy.maxActiveMs, 0);
    assert.equal(original.policy.maxUncachedTokens, 0);
    const next = source(owner.sessionId);
    assert.equal(budgets.captureSourceBudgetPolicy(next)!.policy.tokenEnforcementEnabled, true);
  } finally { process.env.CLEMMY_RUN_TOKEN_BUDGET = before; }
});

test('a mismatched source or budget reference cannot borrow another task policy', () => {
  const one = source('budget-one');
  const two = source('budget-two');
  const captured = budgets.captureSourceBudgetPolicy(one)!;
  budgets.captureSourceBudgetPolicy(two)!;
  assert.throws(() => budgets.captureSourceBudgetPolicy({ ...two, sourceUserSeq: one.sourceUserSeq }), /exact accepted source/);
  assert.throws(() => budgets.readSourceBudgetPolicy(two, captured), /inconsistent/);
  assert.throws(() => budgets.readSourceBudgetPolicy(one, { ...captured, digest: 'bad' }), /reference is invalid/);
});

test('older started work without a captured policy remains unknown', () => {
  const owner = source('budget-historical');
  log.appendEvent({ sessionId: owner.sessionId, turn: 1, role: 'system', type: 'turn_started', data: { input: 'legacy shape without source' } });
  assert.equal(budgets.captureSourceBudgetPolicy(owner, { maxRunTokens: 200 }), null);
  assert.equal(budgets.readSourceBudgetPolicy(owner), null);
  const next = source(owner.sessionId);
  assert.equal(budgets.captureSourceBudgetPolicy(next, { maxRunTokens: 200 })!.policy.maxUncachedTokens, 200);
});

test('invalid time settings cannot persist a bogus unlimited policy', () => {
  const owner = source('budget-invalid');
  for (const maxWallClockMs of [NaN, Infinity, -1, 0.5]) {
    assert.throws(() => budgets.captureSourceBudgetPolicy(owner, { maxWallClockMs }), /settings are invalid/);
  }
  assert.equal(budgets.readSourceBudgetPolicy(owner), null);
});

test('duplicate policy evidence is refused, not resolved by choosing the newest default', () => {
  const owner = source('budget-ambiguous');
  budgets.captureSourceBudgetPolicy(owner)!;
  const first = log.listEvents(owner.sessionId, { types: ['accepted_source_budget'] })[0]!;
  log.appendEvent({ sessionId: owner.sessionId, turn: first.turn, role: 'system', type: 'accepted_source_budget',
    parentEventId: first.parentEventId, data: first.data });
  assert.throws(() => budgets.readSourceBudgetPolicy(owner), /ambiguous/);
});
