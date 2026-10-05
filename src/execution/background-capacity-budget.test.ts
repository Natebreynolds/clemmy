import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBackgroundBudgetGrant } from './background-budget-grant.js';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-capacity-budget-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_RUN_TOKEN_BUDGET = 'on';
const bg = await import('./background-tasks.js');
const { createSession, appendEvent, listEvents, accrueSessionTokens, getSessionTokensUsed } = await import('../runtime/harness/eventlog.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const { AgentRuntimeCancelledError } = await import('../runtime/provider.js');
const { getRun } = await import('../runtime/run-events.js');
const realNow = Date.now;
bg._setBackgroundResponseExecutorForTests((assistant, request) => assistant.respond(request));
afterEach(() => { bg._setBackgroundTaskSettlementCasHookForTests(null); Date.now = realNow; for (const task of bg.listBackgroundTasks()) bg.archiveBackgroundTask(task.id); });
after(() => { bg._setBackgroundResponseExecutorForTests(null); rmSync(home, { recursive: true, force: true }); });
const drain = (respond: (request: any) => Promise<any>) => bg.processBackgroundTasks({ getRuntime() { return {} as never; }, respond } as any, 1);
const readyRetry = (id: string) => {
  const task = bg.getBackgroundTask(id)!;
  assert.equal(task.status, 'pending');
  bg.updateBackgroundTask(id, { transientRetry: { ...task.transientRetry!, notBefore: new Date(Date.now() - 1).toISOString() } });
  return task;
};

test('capacity retry retains original deadline and token baseline, settled receipt and replay session; owner Continue grants separately', async () => {
  let clock = realNow(); Date.now = () => clock;
  const task = bg.createBackgroundTask({ title: 'Budget retry fixture', prompt: 'Continue the named fixture from saved progress.', maxMinutes: 10, maxTokens: 100_000 });
  createSession({ id: task.runSessionId, kind: 'workflow' });
  accrueSessionTokens(task.runSessionId, 5_000);
  let calls = 0;
  await drain(async request => {
    calls++;
    assert.equal(request.runTokenBaseline, 5_000);
    const reservation = appendEvent({ sessionId: request.sessionId, turn: 1, role: 'system', type: 'external_write',
      data: { preDispatch: true, callId: 'fixture-write', canonicalCallId: 'fixture-write', shapeKey: 'CREATE_FIXTURE', targets: ['fixture:one'] } });
    appendEvent({ sessionId: request.sessionId, turn: 1, role: 'system', type: 'external_write_succeeded', parentEventId: reservation.id, data: reservation.data });
    HarnessSession.load(request.sessionId)!.updateConversationSnapshot([{ role: 'user', content: 'Fixture receipt saved; do not repeat its effect.' }]);
    accrueSessionTokens(request.sessionId, 30_000);
    throw new Error('529 overloaded');
  });
  const pending = readyRetry(task.id);
  const grant = pending.budgetGrant!;
  assert.equal(grant.runTokenBaseline, 5_000);
  assert.equal(grant.wallClockDeadlineMs, clock + 10 * 60_000);
  clock += 7 * 60_000;
  await drain(async request => {
    calls++;
    assert.equal(request.sessionId, task.runSessionId);
    assert.equal(request.runTokenBaseline, 5_000);
    assert.equal(request.maxRunTokens, 100_000);
    assert.equal(request.maxWallClockMs, 3 * 60_000);
    assert.equal(listEvents(request.sessionId, { types: ['external_write_succeeded'] }).length, 1);
    assert.match(JSON.stringify(HarnessSession.load(request.sessionId)!.toInputItems()), /do not repeat/);
    accrueSessionTokens(request.sessionId, 70_000);
    return { text: 'Fixture progress retained.', sessionId: request.sessionId, stoppedReason: 'max-turns-with-grace' };
  });
  assert.equal(calls, 2);
  const parked = bg.getBackgroundTask(task.id)!;
  assert.equal(parked.status, 'awaiting_continue');
  assert.deepEqual(parked.budgetGrant, grant);
  assert.equal(listEvents(task.runSessionId, { types: ['external_write'] }).length, 1, 'retry never dispatches an old effect itself');
  assert.equal(getSessionTokensUsed(task.runSessionId), 105_000);
  const continued = bg.queueBackgroundTaskContinue(task.id)!;
  assert.equal(continued.budgetGrant, undefined);
  assert.equal(continued.transientRetry, undefined);
  await drain(async request => {
    assert.equal(request.runTokenBaseline, 105_000, 'explicit owner continuation has a fresh baseline, without resetting lifetime spend');
    assert.equal(listEvents(request.sessionId, { types: ['external_write_succeeded'] }).length, 1);
    return { text: 'Fixture paused again.', sessionId: request.sessionId, stoppedReason: 'token-budget' };
  });
  assert.equal(bg.getBackgroundTask(task.id)!.budgetGrant!.wallClockDeadlineMs, clock + 10 * 60_000);
  assert.equal(getSessionTokensUsed(task.runSessionId), 105_000);
});

test('capacity backoff that exhausts the original time grant parks before another provider call', async () => {
  let clock = realNow(); Date.now = () => clock;
  const task = bg.createBackgroundTask({ title: 'Deadline fixture', prompt: 'Read fixture progress.', maxMinutes: 1, maxTokens: 100_000 });
  await drain(async () => { throw new Error('529 overloaded'); });
  const grant = readyRetry(task.id).budgetGrant!;
  clock = grant.wallClockDeadlineMs + 1;
  let called = false;
  await drain(async () => { called = true; throw new Error('must not dispatch'); });
  assert.equal(called, false);
  const parked = bg.getBackgroundTask(task.id)!;
  assert.equal(parked.status, 'awaiting_continue');
  assert.match(parked.error!, /time budget/);
  assert.deepEqual(parked.budgetGrant, grant);
});

test('in-flight deadline pauses without entering user cancellation, and real Stop wins on either side of the deadline', async () => {
  let clock = realNow(); Date.now = () => clock;
  for (const stop of ['none', 'before', 'after'] as const) {
    const task = bg.createBackgroundTask({ title: `In-flight deadline ${stop}`, prompt: 'Read fixture progress.', maxMinutes: 1 });
    await drain(async request => {
      if (stop === 'before') bg.cancelBackgroundTask(task.id, 'Owner stopped the fixture.');
      clock += 60_001;
      assert.equal(request.shouldCancel(), true, 'the provider still receives its cancellation signal');
      assert.equal(bg.getBackgroundTask(task.id)!.status, stop === 'before' ? 'cancelling' : 'running');
      if (stop === 'after') bg.cancelBackgroundTask(task.id, 'Owner stopped the fixture.');
      throw new AgentRuntimeCancelledError();
    });
    const settled = bg.getBackgroundTask(task.id)!;
    assert.equal(settled.status, stop === 'none' ? 'awaiting_continue' : 'aborted');
    if (stop !== 'none') assert.match(settled.error!, /Owner stopped/);
    bg.archiveBackgroundTask(task.id);
  }
});

test('owner Stop winning the budget-park CAS settles cancellation instead of advertising a resumable pause', async () => {
  let clock = realNow(); Date.now = () => clock;
  for (const budget of ['missing', 'tokens', 'deadline'] as const) {
    const task = bg.createBackgroundTask({ title: `Budget CAS ${budget}`, prompt: 'Read fixture progress.', maxMinutes: 1, maxTokens: 100_000 });
    if (budget !== 'missing') {
      bg.markBackgroundTaskRunning(task.id);
      if (budget === 'tokens') accrueSessionTokens(task.runSessionId, 100_000);
      else clock += 60_001;
    }
    bg.updateBackgroundTask(task.id, { status: 'pending', transientRetry: { attempts: 1, notBefore: new Date(0).toISOString(), lastError: '529 overloaded' } });
    bg._setBackgroundTaskSettlementCasHookForTests(() => {
      bg._setBackgroundTaskSettlementCasHookForTests(null);
      bg.cancelBackgroundTask(task.id, 'Owner stopped at budget transition.');
    });
    let calls = 0;
    await drain(async () => { calls++; throw new Error('must not dispatch'); });
    assert.equal(calls, 0);
    assert.equal(bg.getBackgroundTask(task.id)!.status, 'aborted');
    assert.match(bg.getBackgroundTask(task.id)!.error!, /Owner stopped/);
    assert.equal(getRun(`run-${task.id}`)!.status, 'cancelled');
    assert.doesNotMatch(JSON.stringify(getRun(`run-${task.id}`)), /resumable with progress preserved/);
    bg.archiveBackgroundTask(task.id);
  }
});

test('spent tokens and legacy missing grants cannot reopen allowance through capacity retry', async () => {
  const task = bg.createBackgroundTask({ title: 'Spent retry fixture', prompt: 'Read fixture progress.', maxMinutes: 60, maxTokens: 100_000 });
  await drain(async request => { accrueSessionTokens(request.sessionId, 100_000); throw new Error('529 overloaded'); });
  readyRetry(task.id);
  let called = false;
  await drain(async () => { called = true; throw new Error('must not dispatch'); });
  assert.equal(called, false);
  assert.equal(bg.getBackgroundTask(task.id)!.status, 'awaiting_continue');
  bg.archiveBackgroundTask(task.id);
  const legacy = bg.createBackgroundTask({ title: 'Legacy retry fixture', prompt: 'Read fixture progress.' });
  bg.updateBackgroundTask(legacy.id, { transientRetry: { attempts: 1, lastError: '529 overloaded', notBefore: new Date(0).toISOString() } });
  await drain(async () => { called = true; throw new Error('must not dispatch'); });
  assert.equal(called, false);
  assert.equal(bg.getBackgroundTask(legacy.id)!.status, 'awaiting_continue');
  assert.equal(bg.getBackgroundTask(legacy.id)!.budgetGrant, undefined);
  assert.match(bg.getBackgroundTask(legacy.id)!.result!, /no retained task budget/);
});

test('automatic continuation retains the grant while manual Resume replaces it in place', () => {
  const task = bg.createBackgroundTask({ title: 'Grant ownership fixture', prompt: 'Read fixture progress.' });
  bg.markBackgroundTaskRunning(task.id);
  const grant = { version: 1 as const, runSessionId: task.runSessionId, grantedAtMs: 1, wallClockDeadlineMs: 61_000, runTokenBaseline: 0, runTokenCeiling: 100_000 };
  bg.updateBackgroundTask(task.id, { budgetGrant: grant });
  bg.markBackgroundTaskAwaitingContinue(task.id, 'fixture pause', 'Saved fixture progress.');
  assert.deepEqual(bg.queueBackgroundTaskContinue(task.id, { auto: true })!.budgetGrant, grant);
  bg.markBackgroundTaskRunning(task.id);
  bg.markBackgroundTaskFailed(task.id, 'fixture outage', 'failed');
  const resumed = bg.resumeBackgroundTask(task.id)!;
  assert.equal(resumed.id, task.id);
  assert.equal(resumed.runSessionId, task.runSessionId);
  assert.equal(resumed.budgetGrant, undefined);
});

test('accepted owner input and approval resolutions grant a new window after a long human wait', () => {
  let clock = realNow(); Date.now = () => clock;
  for (const kind of ['input', 'approval'] as const) {
    const task = bg.createBackgroundTask({ title: `Owner ${kind} fixture`, prompt: 'Read fixture progress.', maxMinutes: 1 });
    const running = bg.markBackgroundTaskRunning(task.id)!;
    assert.ok(running.budgetGrant, 'grant and running claim are persisted together');
    accrueSessionTokens(task.runSessionId, 50);
    if (kind === 'input') bg.markBackgroundTaskAwaitingInput(task.id, 'fixture-question', 'Which fixture?');
    else bg.markBackgroundTaskAwaitingApproval(task.id, 'fixture-approval', 'Fixture progress saved.');
    clock += 24 * 60 * 60_000;
    const queued = kind === 'input'
      ? bg.queueBackgroundTaskInputResolution('fixture-question', 'Use the named fixture.')
      : bg.queueBackgroundTaskApprovalResolution('fixture-approval', true);
    assert.equal(queued?.budgetGrant, undefined);
    const resumed = bg.markBackgroundTaskRunning(task.id)!;
    assert.equal(resumed.budgetGrant!.grantedAtMs, clock);
    assert.equal(resumed.budgetGrant!.wallClockDeadlineMs, clock + 60_000);
    assert.equal(resumed.budgetGrant!.runTokenBaseline, 50);
    bg.archiveBackgroundTask(task.id);
  }
});

test('grant validation refuses corrupted ownership/counters and preserves an unlimited token allowance', () => {
  const input = { retained: undefined as unknown, runSessionId: 'fixture-run', requiresRetainedGrant: false, nowMs: 10, maxMinutes: 1, tokensUsed: 40, tokenCeiling: 0 };
  const opened = resolveBackgroundBudgetGrant(input);
  assert.ok('grant' in opened);
  const g = opened.grant;
  assert.equal(g.runTokenCeiling, 0);
  assert.deepEqual(resolveBackgroundBudgetGrant({ ...input, retained: g, tokenCeiling: 20, nowMs: 30, tokensUsed: 100 }), { grant: g });
  for (const retained of [null, {}, { ...g, runSessionId: 'foreign' }, { ...g, runTokenBaseline: 999 }, { ...g, wallClockDeadlineMs: NaN }, { ...g, runTokenCeiling: -1 }]) {
    assert.ok('reason' in resolveBackgroundBudgetGrant({ ...input, retained }));
  }
});
