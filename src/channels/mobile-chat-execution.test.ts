import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-mobile-preaccept-'));
process.env.CLEMENTINE_HOME = fixtureHome;
const log = await import('../runtime/harness/eventlog.js');
const { createMobileChatAdmission, prepareAndDispatchMobileChat } = await import('./mobile-chat-execution.js');
test.beforeEach(() => log.resetEventLog());
test.after(() => { log.closeEventLog(); rmSync(fixtureHome, { recursive: true, force: true }); });

test('mobile Stop during asynchronous setup prevents the first accepted source and dispatch', async () => {
  const sessionId = 'phone-preaccept';
  log.createSession({ id: sessionId, kind: 'chat', userId: 'test-phone' });
  log.claimHarnessChatRequest({ requestId: 'phone-request', sessionId, runId: 'phone-run', inputHash: 'input', sinceSeq: 0 });
  let release!: () => void;
  const setup = new Promise<void>(resolve => { release = resolve; });
  let dispatches = 0;
  const pending = prepareAndDispatchMobileChat({ requestId: 'phone-request', prepare: () => setup, dispatch: async () => {
    dispatches++;
    const attempt = log.beginRunAttempt(sessionId, { runId: 'phone-run' });
    log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: 'The requested work.' } });
  } });
  const admission = createMobileChatAdmission();
  admission.observe(pending);
  log.requestHarnessChatCancellation('phone-request', 'Stop while setup waits');
  log.closeEventLog();
  release();
  await assert.rejects(admission.wait, /CHAT_REQUEST_CANCELLED/);
  assert.equal(dispatches, 0);
  assert.equal(log.getActiveRunAttempt(sessionId), null);
  assert.equal(log.listEvents(sessionId, { types: ['user_input_received'] }).length, 0);
});

test('uncancelled setup dispatches once and propagates its result', async () => {
  let prepared = false;
  let calls = 0;
  const result = await prepareAndDispatchMobileChat({ requestId: 'uncancelled',
    prepare: async () => { prepared = true; }, dispatch: async () => { assert.equal(prepared, true); calls++; return 'completed'; } });
  assert.equal(result, 'completed');
  assert.equal(calls, 1);
});

test('admission waits for accepted turn without waiting for execution completion', async () => {
  const admission = createMobileChatAdmission();
  let finish!: () => void;
  const execution = new Promise<void>(resolve => { finish = resolve; });
  admission.observe(execution);
  let admitted = false;
  void admission.wait.then(() => { admitted = true; });
  await Promise.resolve();
  assert.equal(admitted, false);
  admission.accepted();
  await admission.wait;
  assert.equal(admitted, true);
  finish();
  await execution;
});

test('a completed replay admits mobile work without a new accepted turn', async () => {
  const admission = createMobileChatAdmission();
  admission.observe(Promise.resolve({ runId: 'existing-run' }));
  assert.equal(await admission.wait, undefined);
});

test('failure before admission is retained even when observed before the HTTP caller awaits', async () => {
  const admission = createMobileChatAdmission();
  const failure = new Error('CONNECTION_SOURCE_CHANGED');
  admission.observe(Promise.reject(failure));
  await new Promise<void>(resolve => { setImmediate(resolve); });
  admission.accepted();
  await assert.rejects(admission.wait, error => error === failure);
});

test('execution rejection after acceptance is consumed without changing the admitted result', async () => {
  const admission = createMobileChatAdmission();
  let fail!: (error: Error) => void;
  const execution = new Promise<void>((_resolve, reject) => { fail = reject; });
  admission.observe(execution);
  admission.accepted();
  await admission.wait;
  fail(new Error('Execution failed after its accepted turn'));
  // Let Node observe any unhandled rejection from the execution or its observer.
  await new Promise<void>(resolve => { setImmediate(resolve); });
  await admission.wait;
});
