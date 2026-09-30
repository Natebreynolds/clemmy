/** Run: node scripts/run-tests-isolated.mjs src/gateway/connection-continuation.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import type { GatewayRequest } from './router.js';
import type { TaskMode } from '../runtime/harness/task-mode.js';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-gateway-connection-'));
process.env.CLEMENTINE_HOME = fixtureHome;
// Exercise real gateway acceptance and routing, then stop at the disabled
// runtime boundary. These fixtures cannot acquire a provider or model lane.
process.env.CLEMMY_HARNESS_WEBHOOK = 'off';
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts += 1;
  throw new Error('Network is forbidden in gateway connection fixtures.');
};

const log = await import('../runtime/harness/eventlog.js');
const setup = await import('../runtime/harness/connection-setup.js');
const { parkDependencyRequest } = await import('../runtime/harness/dependency-request.js');
const { ClementineGateway } = await import('./router.js');
const { getRun } = await import('../runtime/run-events.js');
const background = await import('../execution/background-tasks.js');

type Audience = { userId?: string; conversationKey?: string };
let fixtureNumber = 0;

async function connectionFixture(input: { audience?: Audience; mode?: TaskMode; text?: string } = {}) {
  const serial = ++fixtureNumber;
  const sessionId = `gateway-connection-${serial}`;
  log.createSession({
    id: sessionId, kind: 'chat', channel: input.audience ? 'mobile' : 'desktop',
    userId: input.audience?.userId ?? 'desktop-owner',
    metadata: { channelId: `original-conversation-${serial}` },
  });
  const source = log.appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: {
      text: 'Read the controlled fixture records for this task.',
      ...input.audience,
      ...(input.mode ? { taskMode: input.mode } : {}),
    },
  });
  const text = input.text ?? 'I’ve connected Fixture CRM — continue this same task';
  const dependency = parkDependencyRequest({
    sessionId, sourceUserSeq: source.seq, turn: 1, kind: 'connection_missing',
    connectionSubject: {
      kind: 'exact_capability_connection', provider: 'authorized_composio',
      toolkit: 'fixturecrm', capability: 'FIXTURECRM_LIST_RECORDS',
      capabilityRef: 'cap:resolved:fixturecrm_list_records',
      discoveryQuery: 'Read controlled fixture records', discoveryRole: 'source',
      continueOptionId: 'opt-1', continueOptionLabel: text,
    },
  });
  const context = { sessionId, connectionRequestId: dependency.requestId };
  setup.recordConnectionSetupResult(context, { connectionId: `ca_controlled_fixture_${serial}` });
  const request = setup.readConnectionSetup(sessionId);
  assert.ok(request);
  const checked = await setup.verifyConnectionSetup(context, async selections => {
    assert.deepEqual(selections, [{ identifier: 'FIXTURECRM_LIST_RECORDS', connectionId: `ca_controlled_fixture_${serial}` }]);
    return { ok: true };
  });
  assert.equal(checked.ready, true);
  assert.ok(checked.request && checked.verificationBinding);
  const verification = { sourceUserSeq: checked.request.sourceUserSeq, binding: checked.verificationBinding };
  const identity = setup.connectionContinuationIdentity(context, text, request.clientRequestId);
  const runId = `run-connection-gateway-${serial}`;
  const receipt = log.claimHarnessChatRequest({ ...identity, sessionId, runId, sinceSeq: source.seq });
  assert.equal(receipt.inserted, true);
  return { context, source, text, runId, request, verification };
}

function fakeGateway() {
  let assistantCalls = 0;
  const gateway = new ClementineGateway({
    async respond() {
      assistantCalls += 1;
      throw new Error('The fixture runtime is disabled; no assistant may run.');
    },
  } as never, {
    terminalDeliveryJudgePort: {
      async resolveRoute() { throw new Error('The fixture must not request a judge.'); },
      async run() { throw new Error('The fixture must not run a judge.'); },
    },
  });
  return { gateway, assistantCalls: () => assistantCalls };
}

function phoneRequest(fixture: Awaited<ReturnType<typeof connectionFixture>>): GatewayRequest {
  return {
    sessionId: fixture.context.sessionId, runId: fixture.runId,
    message: fixture.text, userId: 'different-paired-phone', channel: 'mobile', source: 'mobile',
    connectionContinuation: fixture.context,
    connectionContinuationVerification: fixture.verification,
  };
}

function acceptedContinuation(fixture: Awaited<ReturnType<typeof connectionFixture>>) {
  const sources = log.listEvents(fixture.context.sessionId, { types: ['user_input_received'] });
  assert.ok(sources.some(source => source.seq === fixture.source.seq));
  const continuations = sources.filter(source => source.data.runId === fixture.runId);
  assert.equal(continuations.length, 1, 'one continuation must be accepted in the original session');
  const accepted = continuations[0]!;
  assert.equal(accepted.data.runId, fixture.runId);
  assert.equal(accepted.data.text, fixture.text);
  return accepted;
}

function assertForegroundReached(runId: string): void {
  assert.ok(getRun(runId)?.events.some(event => event.type === 'model_started'),
    'gateway must reach its foreground runtime boundary before the fixture blocks model access');
}

beforeEach(() => {
  log.resetEventLog();
  networkAttempts = 0;
});
afterEach(async () => {
  // Background needs-input publication is a fire-and-forget local relay.
  // Let its queued import/publication settle before the next DB reset.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(networkAttempts, 0, 'no fixture may attempt a provider or model request');
});
after(() => {
  log.closeEventLog();
  globalThis.fetch = originalFetch;
  delete process.env.CLEMMY_HARNESS_WEBHOOK;
  rmSync(fixtureHome, { recursive: true, force: true });
});

test('a desktop task continued from phone retains absent original audience fields', async () => {
  const fixture = await connectionFixture();
  const { gateway, assistantCalls } = fakeGateway();
  assert.deepEqual(setup.connectionContinuationAudience(fixture.context, fixture.runId, fixture.text), {});
  const result = await gateway.handleMessage(phoneRequest(fixture));
  const accepted = acceptedContinuation(fixture);
  assert.equal(Object.hasOwn(accepted.data, 'userId'), false, 'phone identity must not replace an absent desktop audience');
  assert.equal(Object.hasOwn(accepted.data, 'conversationKey'), false);
  assert.equal(result.sessionId, fixture.context.sessionId);
  assert.equal(result.handledControl, undefined);
  assertForegroundReached(fixture.runId);
  assert.equal(assistantCalls(), 0);
});

test('the receipt-bound audience helper preserves a phone task when desktop resumes it', async () => {
  const audience = { userId: 'original-phone-owner', conversationKey: 'mobile:original-private-conversation' };
  const fixture = await connectionFixture({ audience });
  log.closeEventLog();
  assert.deepEqual(setup.connectionContinuationAudience(fixture.context, fixture.runId, fixture.text), audience);
  const { gateway, assistantCalls } = fakeGateway();
  const result = await gateway.handleMessage({
    ...phoneRequest(fixture), userId: 'desktop-owner', channel: 'desktop', source: 'webhook',
  });
  const accepted = acceptedContinuation(fixture);
  assert.equal(accepted.data.userId, audience.userId);
  assert.equal(accepted.data.conversationKey, audience.conversationKey);
  assert.equal(result.sessionId, fixture.context.sessionId);
  assertForegroundReached(fixture.runId);
  assert.equal(assistantCalls(), 0);
});

test('an unrelated parked background question cannot intercept a proven connection continuation', async () => {
  const fixture = await connectionFixture();
  const task = background.createBackgroundTask({
    title: 'Unrelated fixture background question', prompt: 'Wait for a separate segment choice.',
    originSessionId: fixture.context.sessionId, channel: 'mobile', source: 'mobile',
  });
  background.markBackgroundTaskAwaitingInput(task.id, 'fixture-unrelated-question', 'Which unrelated segment?');
  const { gateway, assistantCalls } = fakeGateway();
  const result = await gateway.handleMessage(phoneRequest(fixture));
  assert.equal(result.handledControl, undefined);
  assert.equal(result.queuedTaskId, undefined);
  assert.doesNotMatch(result.text, /Want me to send your message|Which unrelated segment/);
  assert.equal(background.getBackgroundTask(task.id)?.status, 'awaiting_input');
  assert.equal(background.getBackgroundTask(task.id)?.inputResolution, undefined);
  acceptedContinuation(fixture);
  assertForegroundReached(fixture.runId);
  assert.equal(assistantCalls(), 0);
});

test('the host-derived original Plan mode survives gateway source acceptance', async () => {
  const mode = { version: 1, kind: 'plan' } as const;
  const fixture = await connectionFixture({ mode });
  const originalMode = setup.connectionContinuationTaskMode(fixture.context);
  assert.deepEqual(originalMode, mode);
  const { gateway, assistantCalls } = fakeGateway();
  // Even an unrelated current composer mode cannot downgrade the original
  // source. The proven server context derives its own mode at admission.
  await gateway.handleMessage({ ...phoneRequest(fixture), taskMode: { version: 1, kind: 'normal' } });
  assert.deepEqual(acceptedContinuation(fixture).data.taskMode, mode);
  assertForegroundReached(fixture.runId);
  assert.equal(assistantCalls(), 0);
});

test('connection audience cannot be borrowed by a different session, run or message', async () => {
  const fixture = await connectionFixture({ audience: { userId: 'original-phone-owner', conversationKey: 'mobile:fixture' } });
  assert.throws(() => setup.connectionContinuationAudience(
    { ...fixture.context, sessionId: 'different-session' }, fixture.runId, fixture.text,
  ), /matching accepted receipt/);
  assert.throws(() => setup.connectionContinuationAudience(fixture.context, 'another-run', fixture.text), /matching accepted receipt/);
  assert.throws(() => setup.connectionContinuationAudience(fixture.context, fixture.runId, 'Different task'), /matching accepted receipt/);
});

test('a phone retry cannot dispatch or fail a continuation already leased by desktop', async () => {
  for (const acceptedAlready of [false, true]) {
    const fixture = await connectionFixture();
    const desktop = log.claimRunAttemptLease({
      sessionId: fixture.context.sessionId, runId: fixture.runId,
      ownerId: 'controlled-desktop-owner', leaseMs: 90_000,
    });
    assert.equal(desktop.claimed, true);
    if (acceptedAlready) {
      log.recordRunAttemptUserInput(desktop.attempt, {
        turn: 2, role: 'user', data: { text: fixture.text, runId: fixture.runId },
      });
    }
    const before = log.listEvents(fixture.context.sessionId);
    const { gateway, assistantCalls } = fakeGateway();
    let acceptedCallbacks = 0;
    const replay = phoneRequest(fixture);
    delete replay.connectionContinuationVerification;
    const response = await gateway.handleMessage({
      ...replay, failClosedOnUnsettledReplay: true,
      onAcceptedTurn: () => { acceptedCallbacks += 1; },
    });
    assert.equal(response.runId, fixture.runId);
    assert.equal(response.sessionId, fixture.context.sessionId);
    assert.equal(response.terminal, undefined);
    assert.equal(acceptedCallbacks, 0);
    assert.deepEqual(log.listEvents(fixture.context.sessionId), before, 'no input, model edge or terminal may be added by the sibling');
    const active = log.getLatestRunAttemptByRunId(fixture.context.sessionId, fixture.runId);
    assert.equal(active?.attemptId, desktop.attempt.attemptId);
    assert.equal(active?.status, 'active');
    assert.equal(active?.leaseOwner, 'controlled-desktop-owner');
    assert.equal(getRun(fixture.runId), undefined);
    assert.equal(assistantCalls(), 0);
  }
});

test('an interrupted input pause remains an eligible connection task', async () => {
  const fixture = await connectionFixture();
  const originalAttempt = log.beginRunAttempt(fixture.context.sessionId, { runId: 'controlled-paused-original' });
  log.recordRunAttemptUserInput(originalAttempt, {
    turn: fixture.source.turn, role: 'user', data: fixture.source.data,
  }, { existingEventSeq: fixture.source.seq });
  log.finishRunAttempt(originalAttempt, 'interrupted');
  assert.equal(log.getRunAttemptBySourceUserSeq(fixture.context.sessionId, fixture.source.seq)?.status, 'interrupted');
  assert.equal(setup.readConnectionSetup(fixture.context.sessionId)?.requestId, fixture.context.connectionRequestId);
  const checked = await setup.verifyConnectionSetup(fixture.context, async selections => {
    assert.equal(selections[0]?.identifier, 'FIXTURECRM_LIST_RECORDS');
    return { ok: true };
  });
  assert.equal(checked.ready, true);
});

test('a passive background report-back cannot replace the real user source that owns setup', async () => {
  const fixture = await connectionFixture();
  const task = background.createBackgroundTask({
    title: 'Passive fixture report-back', prompt: 'Wait for a separate choice.',
    originSessionId: fixture.context.sessionId, channel: 'mobile', source: 'mobile',
  });
  background.markBackgroundTaskAwaitingInput(task.id, 'fixture-passive-question', 'Which separate choice?');
  const laterSources = log.listEvents(fixture.context.sessionId, {
    types: ['user_input_received'], sinceSeq: fixture.source.seq,
  });
  assert.ok(laterSources.length > 0, 'the actual background pause should publish its passive report-back');
  assert.ok(laterSources.every(source => source.data.synthetic === true));
  const current = setup.readConnectionSetup(fixture.context.sessionId);
  assert.equal(current?.requestId, fixture.context.connectionRequestId);
  assert.equal(current?.sourceUserSeq, fixture.source.seq);
});

test('a receipt without a continuation source cannot overtake a newer real user request', async () => {
  const fixture = await connectionFixture();
  const newer = log.claimRunAttemptLease({
    sessionId: fixture.context.sessionId, runId: 'run-controlled-newer-request',
    ownerId: 'controlled-newer-owner', leaseMs: 90_000,
  });
  assert.equal(newer.claimed, true);
  log.recordRunAttemptUserInput(newer.attempt, {
    turn: 2, role: 'user', data: { text: 'Work on this different task instead.' },
  });
  const before = log.listEvents(fixture.context.sessionId);
  const { gateway, assistantCalls } = fakeGateway();
  await assert.rejects(gateway.handleMessage(phoneRequest(fixture)));
  assert.deepEqual(log.listEvents(fixture.context.sessionId), before);
  assert.equal(log.getLatestRunAttemptByRunId(fixture.context.sessionId, fixture.runId), null);
  const active = log.getLatestRunAttemptByRunId(fixture.context.sessionId, 'run-controlled-newer-request');
  assert.equal(active?.attemptId, newer.attempt.attemptId);
  assert.equal(active?.status, 'active', 'rejected setup must not supersede the newer task');
  assert.equal(active?.leaseOwner, 'controlled-newer-owner');
  assert.equal(getRun(fixture.runId), undefined);
  assert.equal(assistantCalls(), 0);
});

test('an account replacement after verification invalidates first source admission', async () => {
  const fixture = await connectionFixture();
  setup.recordConnectionSetupResult(fixture.context, { connectionId: 'ca_unverified_replacement_fixture' });
  const before = log.listEvents(fixture.context.sessionId);
  const { gateway, assistantCalls } = fakeGateway();
  await assert.rejects(gateway.handleMessage(phoneRequest(fixture)));
  assert.deepEqual(log.listEvents(fixture.context.sessionId), before);
  assert.equal(log.getLatestRunAttemptByRunId(fixture.context.sessionId, fixture.runId), null);
  assert.equal(getRun(fixture.runId), undefined);
  assert.equal(assistantCalls(), 0);
  assert.equal(setup.readConnectionSetup(fixture.context.sessionId)?.requestId, fixture.context.connectionRequestId,
    'the task remains available for a fresh verification of its replacement account');
});
