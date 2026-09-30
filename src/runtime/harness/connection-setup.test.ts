/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/connection-setup.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-connection-setup-'));
process.env.CLEMENTINE_HOME = testHome;

// Every provider observation is injected below. An accidental real request
// fails locally rather than reaching a user's account or an external service.
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts += 1;
  throw new Error('Network is forbidden in connection setup fixture tests.');
};

const eventlog = await import('./eventlog.js');
const dependencies = await import('./dependency-request.js');
const setup = await import('./connection-setup.js');

type Verification = NonNullable<Parameters<typeof setup.verifyConnectionSetup>[1]>;
type VerificationResult = Awaited<ReturnType<Verification>>;
type Selection = Parameters<Verification>[0][number];

const subject = {
  kind: 'exact_capability_connection' as const,
  provider: 'authorized_composio' as const,
  toolkit: 'fixturecrm',
  capability: 'FIXTURECRM_LIST_RECORDS',
  capabilityRef: 'cap:resolved:fixturecrm_list_records',
  discoveryQuery: 'List records from the controlled fixture account',
  discoveryRole: 'source',
  continueOptionId: 'opt-1',
  continueOptionLabel: 'Continue this same fixture task',
};

function parkedTask(sessionId: string) {
  eventlog.createSession({ id: sessionId, kind: 'chat', userId: 'fixture-owner' });
  const source = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'List the records from the controlled fixture account.' },
  });
  const dependency = dependencies.parkDependencyRequest({
    sessionId,
    sourceUserSeq: source.seq,
    turn: 1,
    kind: 'connection_missing',
    connectionSubject: subject,
  });
  const context = { sessionId, connectionRequestId: dependency.requestId };
  return { source, dependency, context };
}

function newerSource(sessionId: string): void {
  eventlog.appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Leave that task parked and work on this different request.' },
  });
}

function dependencyStatus(requestId: string): string {
  const row = eventlog.openEventLog().prepare(
    'SELECT status FROM dependency_requests WHERE request_id = ?',
  ).get(requestId) as { status: string } | undefined;
  assert.ok(row, 'the parked dependency must still exist');
  return row.status;
}

function delayedVerification() {
  let release!: (result: VerificationResult) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const result = new Promise<VerificationResult>((resolve) => { release = resolve; });
  const selections: Selection[] = [];
  const verify: Verification = async (input) => {
    selections.push(...input);
    markStarted();
    return result;
  };
  return { verify, release, started, selections };
}

beforeEach(() => {
  eventlog.resetEventLog();
  networkAttempts = 0;
});

afterEach(() => {
  assert.equal(networkAttempts, 0, 'all provider observations must use the injected verifier');
});

after(() => {
  eventlog.closeEventLog();
  globalThis.fetch = originalFetch;
  rmSync(testHome, { recursive: true, force: true });
});

test('setup context accepts only the current exact session, request and toolkit', () => {
  const original = parkedTask('setup-owner');
  const other = parkedTask('setup-other-owner');
  assert.deepEqual(setup.requireConnectionSetupContext(original.context, subject.toolkit), original.context);
  assert.throws(() => setup.requireConnectionSetupContext({
    ...original.context, sessionId: other.context.sessionId,
  }, subject.toolkit), /no longer belongs/);
  assert.throws(() => setup.requireConnectionSetupContext(original.context, 'different_app'), /no longer belongs/);
  assert.throws(() => setup.requireConnectionSetupContext({
    ...original.context, connectionRequestId: other.dependency.requestId,
  }, subject.toolkit), /no longer belongs/);
  assert.throws(() => setup.requireConnectionSetupContext({
    connectionRequestId: original.dependency.requestId,
  }, subject.toolkit), /incomplete/);
  assert.equal(setup.requireConnectionSetupContext({}, subject.toolkit), undefined);
});

test('a newer accepted source rejects the old setup and cannot record its late account result', async () => {
  const { context, dependency } = parkedTask('setup-stale-source');
  newerSource(context.sessionId);
  assert.throws(() => setup.requireConnectionSetupContext(context, subject.toolkit), /no longer belongs/);
  assert.equal(setup.readConnectionSetup(context.sessionId, dependency.requestId), null);
  setup.recordConnectionSetupResult(context, { connectionId: 'ca_late_stale_fixture' });
  let calls = 0;
  const result = await setup.verifyConnectionSetup(context, async () => {
    calls += 1;
    return { ok: true };
  });
  assert.equal(result.ready, false);
  assert.equal(result.request, null);
  assert.equal(calls, 0, 'a stale task must not start provider verification');
  assert.equal(dependencyStatus(dependency.requestId), 'open');
});

test('a result associated with another session cannot arm this task', async () => {
  const { context } = parkedTask('setup-result-owner');
  const other = parkedTask('setup-result-other');
  setup.recordConnectionSetupResult({ ...context, sessionId: other.context.sessionId }, {
    connectionId: 'ca_wrong_session_fixture',
  });
  assert.equal(setup.readConnectionSetup(context.sessionId)?.awaitingSignIn, false);
  let calls = 0;
  const result = await setup.verifyConnectionSetup(context, async () => {
    calls += 1;
    return { ok: true };
  });
  assert.equal(result.ready, false);
  assert.equal(calls, 0);
});

test('verification needs a provider-returned connection id, not just a successful setup-shaped result', async () => {
  const { context } = parkedTask('setup-account-required');
  for (const result of [null, { ok: true }, { connectionId: '' }, { connectionId: '  ' }, { connectionId: 42 }]) {
    setup.recordConnectionSetupResult(context, result);
  }
  let calls = 0;
  const result = await setup.verifyConnectionSetup(context, async () => {
    calls += 1;
    return { ok: true };
  });
  assert.equal(result.ready, false);
  assert.equal(result.request?.awaitingSignIn, false);
  assert.equal(calls, 0);
});

test('the exact returned account survives database reopen and is verified with the exact capability', async () => {
  const { context, dependency } = parkedTask('setup-durable-account');
  const first = setup.readConnectionSetup(context.sessionId);
  assert.ok(first);
  setup.recordConnectionSetupResult(context, {
    ok: true, authConfigId: 'ac_fixture', connectionId: 'ca_provider_returned_fixture',
  });
  eventlog.closeEventLog();
  const reopened = setup.readConnectionSetup(context.sessionId, dependency.requestId);
  assert.ok(reopened);
  assert.equal(reopened.awaitingSignIn, true);
  assert.equal(reopened.clientRequestId, first.clientRequestId);
  assert.equal(reopened.sourceUserSeq, first.sourceUserSeq);
  const observed: Selection[] = [];
  const result = await setup.verifyConnectionSetup(context, async (selections) => {
    observed.push(...selections);
    return { ok: true };
  });
  assert.deepEqual(observed, [{
    identifier: subject.capability,
    connectionId: 'ca_provider_returned_fixture',
  }]);
  assert.equal(result.ready, true);
  assert.equal(result.request?.clientRequestId, first.clientRequestId);
  assert.equal(dependencyStatus(dependency.requestId), 'open', 'setup readiness is not callable-capability attestation');
});

test('reopening setup keeps one resume clientRequestId while another task receives a different identity', () => {
  const first = parkedTask('setup-resume-identity');
  const before = setup.readConnectionSetup(first.context.sessionId);
  assert.ok(before?.clientRequestId);
  eventlog.closeEventLog();
  const afterReopen = setup.readConnectionSetup(first.context.sessionId, first.dependency.requestId);
  assert.equal(afterReopen?.clientRequestId, before.clientRequestId);
  setup.recordConnectionSetupResult(first.context, { connectionId: 'ca_resume_fixture' });
  const afterConnection = setup.readConnectionSetup(first.context.sessionId);
  assert.equal(afterConnection?.clientRequestId, before.clientRequestId);
  const second = parkedTask('setup-other-resume-identity');
  assert.notEqual(setup.readConnectionSetup(second.context.sessionId)?.clientRequestId, before.clientRequestId);
});

test('desktop acceptance and a phone retry share one durable continuation receipt', () => {
  const { context, source } = parkedTask('setup-cross-surface-receipt');
  const request = setup.readConnectionSetup(context.sessionId);
  assert.ok(request);
  const text = 'Continue this same fixture task.';
  const desktop = { ...context, text, clientRequestId: request.clientRequestId };
  const desktopIdentity = setup.connectionContinuationIdentity(desktop, desktop.text, desktop.clientRequestId);
  const first = eventlog.claimHarnessChatRequest({
    ...desktopIdentity, sessionId: context.sessionId,
    runId: 'desktop:controlled-connection-continuation', sinceSeq: source.seq,
  });
  assert.equal(first.inserted, true);

  // The phone supplies its transport key, but this contextual flow does not
  // incorporate a device id or surface name into the durable task identity.
  eventlog.closeEventLog();
  const mobile = {
    ...context, message: text, idempotencyKey: request.clientRequestId,
    deviceId: 'controlled-paired-phone',
  };
  const mobileIdentity = setup.connectionContinuationIdentity(mobile, mobile.message, mobile.idempotencyKey);
  assert.deepEqual(mobileIdentity, desktopIdentity);
  const prior = eventlog.getHarnessChatRequestReceipt(mobileIdentity.requestId);
  assert.ok(prior);
  const replay = eventlog.claimHarnessChatRequest({
    ...mobileIdentity, sessionId: prior.sessionId,
    runId: prior.runId, sinceSeq: prior.sinceSeq,
  });
  assert.equal(replay.inserted, false);
  assert.deepEqual(replay.receipt, first.receipt);
  const count = eventlog.openEventLog().prepare(
    'SELECT count(*) AS total FROM harness_chat_requests WHERE request_id = ?',
  ).get(desktopIdentity.requestId) as { total: number };
  assert.equal(count.total, 1);
});

test('continuation identity rejects a foreign client key and conflicts on changed session or text', () => {
  const { context, source } = parkedTask('setup-receipt-conflicts');
  const other = parkedTask('setup-receipt-other-session');
  const request = setup.readConnectionSetup(context.sessionId);
  assert.ok(request);
  const text = 'Continue this same fixture task.';
  assert.throws(() => setup.connectionContinuationIdentity(context, text, 'foreign-client-key'), /does not match/);
  const identity = setup.connectionContinuationIdentity(context, text, request.clientRequestId);
  const claim = {
    ...identity, sessionId: context.sessionId,
    runId: 'desktop:controlled-receipt-conflict', sinceSeq: source.seq,
  };
  eventlog.claimHarnessChatRequest(claim);

  for (const changed of [
    { context, text: 'A different task must not inherit the accepted receipt.' },
    { context: { ...context, sessionId: other.context.sessionId }, text },
  ]) {
    const changedIdentity = setup.connectionContinuationIdentity(changed.context, changed.text, request.clientRequestId);
    assert.equal(changedIdentity.requestId, identity.requestId);
    assert.notEqual(changedIdentity.inputHash, identity.inputHash);
    assert.throws(() => eventlog.claimHarnessChatRequest({
      ...claim, ...changedIdentity, sessionId: changed.context.sessionId,
    }), /different chat request/);
  }
  assert.deepEqual(eventlog.getHarnessChatRequestReceipt(identity.requestId)?.inputHash, identity.inputHash);
});

test('missing, changed or inactive provider accounts are never ready', async () => {
  const { context, dependency } = parkedTask('setup-provider-not-ready');
  setup.recordConnectionSetupResult(context, { connectionId: 'ca_unusable_fixture' });
  for (const reason of ['missing_or_changed', 'inactive_or_suppressed'] as const) {
    const result = await setup.verifyConnectionSetup(context, async (selections) => {
      assert.deepEqual(selections, [{ identifier: subject.capability, connectionId: 'ca_unusable_fixture' }]);
      return { ok: false, identifier: subject.capability, reason };
    });
    assert.equal(result.ready, false, reason);
    assert.equal(dependencyStatus(dependency.requestId), 'open');
  }
});

test('provider rejection cannot be converted into ready or satisfy the dependency', async () => {
  const { context, dependency } = parkedTask('setup-provider-error');
  setup.recordConnectionSetupResult(context, { connectionId: 'ca_provider_error_fixture' });
  await assert.rejects(setup.verifyConnectionSetup(context, async () => {
    throw new Error('Fixture provider unavailable');
  }), /Fixture provider unavailable/);
  assert.equal(dependencyStatus(dependency.requestId), 'open');
});

test('the setup receipt exposes only the exact verified account label, without persisting it in chat', async () => {
  const { context, dependency } = parkedTask('setup-account-display');
  setup.recordConnectionSetupResult(context, { connectionId: 'ca_display_fixture' });
  const account = { connectionId: 'ca_display_fixture', toolkit: subject.toolkit, label: 'work@example.test' };
  const result = await setup.verifyConnectionSetup(context, async (_selections, options) => {
    assert.equal(options?.includeAccountDisplay, true);
    return { ok: true, accounts: [
      { connectionId: 'ca_other_fixture', toolkit: subject.toolkit, label: 'other@example.test' },
      { ...account, ownerUserId: 'private-dispatch-entity', state: { access_token: 'fixture-secret' } },
    ] };
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.verifiedAccount, { label: 'work@example.test' });
  assert.equal(dependencyStatus(dependency.requestId), 'open', 'display metadata grants no callable authority');
  const events = JSON.stringify(eventlog.listEvents(context.sessionId));
  assert.equal(events.includes('work@example.test'), false);
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(result).includes('private-dispatch-entity'), false);
  for (const changed of [{ ...account, connectionId: 'ca_other_fixture' }, { ...account, toolkit: 'other_app' }]) {
    const unmatched = await setup.verifyConnectionSetup(context, async () => ({ ok: true, accounts: [changed] }));
    assert.deepEqual(unmatched.verifiedAccount, { label: null }, 'never guess a label from a different account/toolkit');
  }
});

test('a newer source arriving during provider verification prevents old readiness', async () => {
  const { context, dependency } = parkedTask('setup-new-source-race');
  setup.recordConnectionSetupResult(context, { connectionId: 'ca_source_race_fixture' });
  const delayed = delayedVerification();
  const pending = setup.verifyConnectionSetup(context, delayed.verify);
  await delayed.started;
  newerSource(context.sessionId);
  delayed.release({ ok: true, accounts: [{ connectionId: 'ca_source_race_fixture', toolkit: subject.toolkit, label: 'stale@example.test' }] });
  const result = await pending;
  assert.equal(result.ready, false);
  assert.equal(result.request, null);
  assert.equal(result.verifiedAccount, undefined, 'retired task must not receive an account receipt');
  assert.equal(dependencyStatus(dependency.requestId), 'open');
});

test('an account replacement during verification cannot inherit the first account readiness', async () => {
  const { context, dependency } = parkedTask('setup-account-race');
  setup.recordConnectionSetupResult(context, { connectionId: 'ca_first_fixture' });
  const delayed = delayedVerification();
  const pending = setup.verifyConnectionSetup(context, delayed.verify);
  await delayed.started;
  setup.recordConnectionSetupResult(context, { connectionId: 'ca_replacement_fixture' });
  delayed.release({ ok: true, accounts: [{ connectionId: 'ca_first_fixture', toolkit: subject.toolkit, label: 'stale@example.test' }] });
  const staleResult = await pending;
  assert.deepEqual(delayed.selections, [{ identifier: subject.capability, connectionId: 'ca_first_fixture' }]);
  assert.equal(staleResult.ready, false);
  assert.equal(staleResult.verifiedAccount, undefined, 'replaced account must not receive a stale display receipt');
  const replacement = await setup.verifyConnectionSetup(context, async (selections) => {
    assert.deepEqual(selections, [{ identifier: subject.capability, connectionId: 'ca_replacement_fixture' }]);
    return { ok: true };
  });
  assert.equal(replacement.ready, true);
  assert.equal(dependencyStatus(dependency.requestId), 'open');
});

test('cancelling or stopping the exact attempt during verification cannot revive its parked task', async () => {
  for (const stop of ['cancelled', 'kill-requested'] as const) {
    const { context, dependency, source } = parkedTask(`setup-stopped-${stop}`);
    const attempt = eventlog.beginRunAttempt(context.sessionId);
    eventlog.recordRunAttemptUserInput(attempt, {
      turn: 1, role: 'user', data: source.data,
    }, { existingEventSeq: source.seq });
    setup.recordConnectionSetupResult(context, { connectionId: `ca_stopped_${stop}` });
    const delayed = delayedVerification();
    const pending = setup.verifyConnectionSetup(context, delayed.verify);
    await delayed.started;
    if (stop === 'cancelled') eventlog.finishRunAttempt(attempt, 'cancelled');
    else eventlog.requestKill(context.sessionId, 'Stopped by the fixture owner', { attemptId: attempt.attemptId });
    delayed.release({ ok: true });
    const result = await pending;
    assert.equal(result.ready, false, stop);
    assert.equal(result.request, null, stop);
    assert.equal(setup.readConnectionSetup(context.sessionId), null, stop);
    assert.equal(dependencyStatus(dependency.requestId), 'open');
  }
});


test('mobile Stop resolves only a host-issued setup key for its exact session before and after acknowledgement', () => {
  const { context, source } = parkedTask('setup-mobile-stop');
  const other = parkedTask('setup-other-stop');
  setup.recordConnectionSetupResult(context, { connectionId: 'ca_stop_fixture' });
  const request = setup.readConnectionSetup(context.sessionId)!;
  assert.equal(setup.connectionContinuationCancellationId(context.sessionId, request.clientRequestId), request.clientRequestId);
  assert.equal(setup.connectionContinuationCancellationId(other.context.sessionId, request.clientRequestId), null);
  assert.equal(setup.connectionContinuationCancellationId(context.sessionId, 'connection-00000000000000000000000000000000'), null);
  const identity = setup.connectionContinuationIdentity(context, request.continueLabel, request.clientRequestId);
  eventlog.requestHarnessChatCancellation(request.clientRequestId, 'fixture stopped before ack');
  assert.ok(eventlog.getHarnessChatCancellation(identity.requestId), 'send and Stop share the same pre-ack latch');
  assert.equal(setup.readConnectionSetup(context.sessionId), null, 'returning from sign-in cannot automatically resume a stopped request');
  assert.throws(() => eventlog.claimHarnessChatRequest({ ...identity, sessionId: context.sessionId, runId: 'fixture-stop-run', sinceSeq: source.seq }), /cancelled before acceptance/);
  // A different uncancelled acceptance proves the post-ack branch.
  const accepted = parkedTask('setup-mobile-stop-accepted');
  setup.recordConnectionSetupResult(accepted.context, { connectionId: 'ca_stop_accepted_fixture' });
  const acceptedRequest = setup.readConnectionSetup(accepted.context.sessionId)!;
  const acceptedIdentity = setup.connectionContinuationIdentity(accepted.context, acceptedRequest.continueLabel, acceptedRequest.clientRequestId);
  eventlog.claimHarnessChatRequest({ ...acceptedIdentity, sessionId: accepted.context.sessionId, runId: 'fixture-stop-accepted', sinceSeq: accepted.source.seq });
  newerSource(context.sessionId);
  newerSource(accepted.context.sessionId);
  assert.equal(setup.readConnectionSetup(context.sessionId), null);
  assert.equal(setup.connectionContinuationCancellationId(accepted.context.sessionId, acceptedRequest.clientRequestId), acceptedRequest.clientRequestId,
    'an accepted request remains stoppable after its original question is consumed');
  assert.equal(setup.connectionContinuationCancellationId(other.context.sessionId, request.clientRequestId), null);
});


test('a legitimate needs-input interruption remains connectable and inherits Plan rather than the current composer', async () => {
  const { context, source } = parkedTask('setup-plan-paused');
  const data = { ...source.data, taskMode: { version: 1, kind: 'plan' } };
  eventlog.openEventLog().prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(JSON.stringify(data), source.seq);
  const attempt = eventlog.beginRunAttempt(context.sessionId);
  eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data }, { existingEventSeq: source.seq });
  eventlog.finishRunAttempt(attempt, 'interrupted');
  assert.ok(setup.readConnectionSetup(context.sessionId));
  assert.deepEqual(setup.connectionContinuationTaskMode(context), { version: 1, kind: 'plan' });
  setup.recordConnectionSetupResult(context, { connectionId: 'ca_plan_fixture' });
  assert.equal((await setup.verifyConnectionSetup(context, async () => ({ ok: true }))).ready, true);
});

test('reviewed Execute is not silently converted into an ordinary auto continuation', async () => {
  const { context, source } = parkedTask('setup-reviewed-execution');
  const taskMode = { version: 1, kind: 'execute', executeRef: { planId: 'plan-fixture', revision: 2, digest: 'a'.repeat(64) } };
  eventlog.openEventLog().prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(JSON.stringify({ ...source.data, taskMode }), source.seq);
  setup.recordConnectionSetupResult(context, { connectionId: 'ca_execute_fixture' });
  assert.deepEqual(setup.connectionContinuationTaskMode(context), taskMode);
  const verified = await setup.verifyConnectionSetup(context, async () => ({ ok: true }));
  assert.equal(verified.ready, false);
  assert.equal(verified.connectionVerified, true);
  assert.match(verified.request!.continuationBlocker!, /reviewed execution is still paused/);
  const unverified = await setup.verifyConnectionSetup(context, async () => ({ ok: false, reason: 'fixture account unavailable' }));
  assert.equal(unverified.ready, false);
  assert.equal(unverified.connectionVerified, undefined, 'a paused execution is not evidence of a verified account');
});

test('first admission rejects an account replaced after verification and never executes the claim callback', async () => {
  const { context } = parkedTask('setup-admission-rebind');
  setup.recordConnectionSetupResult(context, { connectionId: 'ca_original_fixture' });
  const checked = await setup.verifyConnectionSetup(context, async () => ({ ok: true }));
  assert.ok(checked.verificationBinding);
  const proof = { sourceUserSeq: checked.request!.sourceUserSeq, binding: checked.verificationBinding };
  setup.recordConnectionSetupResult(context, { connectionId: 'ca_replacement_fixture' });
  let claims = 0;
  assert.throws(() => setup.withConnectionContinuationAdmission(context, proof, () => { claims++; }), /account changed/);
  assert.equal(claims, 0);
  const fresh = await setup.verifyConnectionSetup(context, async () => ({ ok: true }));
  setup.withConnectionContinuationAdmission(context, { sourceUserSeq: fresh.request!.sourceUserSeq, binding: fresh.verificationBinding! }, () => { claims++; });
  assert.equal(claims, 1);
});
