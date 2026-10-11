import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

// The runner provides an outer disposable home before any imports. This file
// additionally confines all route/auth/event fixtures to its own temporary dir.
const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-native-voice-idle-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const { createMobileRouter, MOBILE_SESSION_COOKIE } = await import('./mobile-routes.js');
const { setPin } = await import('../runtime/mobile-pin.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const { commitTurnOutcome } = await import('../runtime/harness/delivery-committer.js');
const { turnOutcomeId } = await import('../runtime/harness/turn-outcome.js');

let providerCalls = 0;
const stateDir = path.join(fixtureHome, 'mobile');
const app = express();
app.use(express.json());
app.use('/m', createMobileRouter({ stateDir, isAdminAuthorized: () => false, assistant: {
  respond: async () => { providerCalls += 1; throw new Error('Provider calls are forbidden in the native voice fixture'); },
} as never }));
const server = createServer(app);
let base = '';
let firstDevice = '';
let secondDevice = '';

test.before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await setPin('TestPin1!', { stateDir });
  firstDevice = await login('Native voice fixture one');
  secondDevice = await login('Native voice fixture two');
});
test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  eventlog.closeEventLog();
  rmSync(fixtureHome, { recursive: true, force: true });
  assert.equal(providerCalls, 0);
});

async function login(deviceLabel: string) {
  const response = await fetch(`${base}/m/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: 'TestPin1!', deviceLabel }) });
  assert.equal(response.status, 200);
  const raw = response.headers.get('set-cookie') ?? '';
  return `${MOBILE_SESSION_COOKIE}=${raw.slice(raw.indexOf('=') + 1).split(';')[0]}`;
}

async function send(key: string, body: Record<string, unknown>, cookie = firstDevice) {
  const response = await fetch(`${base}/m/api/chat/send`, { method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'Idempotency-Key': key }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function status(key: string, cookie = firstDevice) {
  const response = await fetch(`${base}/m/api/chat/native-voice-status?requestId=${encodeURIComponent(key)}`,
    { headers: cookie ? { cookie } : {} });
  return { status: response.status, body: await response.json() as Record<string, unknown>,
    cache: response.headers.get('cache-control') };
}

async function finishCommand(key: string, sessionId?: string, cookie = firstDevice) {
  const response = await send(key, { message: 'tasks', async: true, voice: true, requireIdle: true,
    ...(sessionId ? { sessionId } : {}) }, cookie);
  assert.equal(response.status, 202, JSON.stringify(response.body));
  assert.equal(response.body.accepted, true);
  let observed = await status(key, cookie);
  for (let tries = 0; tries < 150 && observed.body.state === 'working'; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    observed = await status(key, cookie);
  }
  assert.equal(observed.status, 200, JSON.stringify(observed.body));
  assert.equal(observed.body.state, 'answered', JSON.stringify(observed.body));
  return { sessionId: String(response.body.sessionId), observed };
}

for (const recovering of [false, true]) {
  test(`native voice refuses ${recovering ? 'an expired unfinished' : 'a live'} run without a steer or receipt`, async () => {
    const { sessionId } = await finishCommand(randomUUID());
    const before = eventlog.listEvents(sessionId).length;
    const lease = eventlog.claimRunAttemptLease({ sessionId, runId: `fixture-busy-${randomUUID()}`,
      ownerId: 'native-voice-fixture', leaseMs: recovering ? 1_000 : 60_000 });
    assert.equal(lease.claimed, true);
    const session = HarnessSession.load(sessionId);
    assert.ok(session);
    if (recovering) {
      session.setRunInFlight();
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    }
    const key = randomUUID();
    try {
      const refused = await send(key, { message: 'tasks', sessionId, async: true, voice: true, requireIdle: true });
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(refused.body.error, 'VOICE_REQUIRES_IDLE_CHAT');
      assert.equal(eventlog.listEvents(sessionId, { types: ['user_steer_note'] }).length, 0);
      assert.equal(eventlog.listEvents(sessionId).length, before, 'a rejected widget request creates no chat events');
      assert.equal((await status(key)).status, 404, 'no durable receipt is minted for a rejected request');
    } finally { eventlog.finishRunAttempt(lease.attempt, 'completed'); session.clearRunInFlight(); }

    // Only after the old run ends may this exact key enter as one ordinary turn.
    await finishCommand(key, sessionId);
    assert.equal(eventlog.listEvents(sessionId, { types: ['user_input_received'] }).length, 2);
    assert.equal(eventlog.listEvents(sessionId, { types: ['user_steer_note'] }).length, 0);
    const replay = await send(key, { message: 'tasks', sessionId, async: true, voice: true, requireIdle: true });
    assert.equal(replay.status, 202, JSON.stringify(replay.body));
    assert.equal(eventlog.listEvents(sessionId, { types: ['user_input_received'] }).length, 2);
  });
}

test('native typed controls refuse before mutating the target conversation', async () => {
  const { sessionId } = await finishCommand(randomUUID());
  const before = eventlog.listEvents(sessionId).length;
  for (const message of ['cancel', 'continue', 'new', 'approve apr-native-voice-fixture']) {
    const key = randomUUID();
    const refused = await send(key, { message, sessionId, async: true, voice: true, requireIdle: true });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, 'VOICE_CONTROL_REQUIRES_CHAT');
    assert.equal((await status(key)).status, 404);
  }
  assert.equal(eventlog.listEvents(sessionId).length, before);
});

test('native request status authenticates and binds missing or committed receipts to the exact device', async () => {
  const key = randomUUID();
  assert.equal((await status(key, '')).status, 401);
  assert.equal((await status('invalid/path')).status, 400);
  assert.equal((await status(key)).status, 404);
  const first = await finishCommand(key);
  assert.equal(first.observed.cache, 'no-store');
  assert.equal(first.observed.body.sessionId, first.sessionId);
  assert.equal(first.observed.body.canResumeVoice, true);
  const source = eventlog.listEvents(first.sessionId, { types: ['user_input_received'] })[0];
  assert.equal(first.observed.body.sourceUserSeq, source.seq);

  const hidden = await status(key, secondDevice);
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.sessionId, undefined);
  assert.equal(hidden.body.text, undefined);

  // Same raw key on another authenticated device names a separate request.
  const second = await finishCommand(key, undefined, secondDevice);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal((await status(key)).body.sessionId, first.sessionId);
  assert.equal((await status(key, secondDevice)).body.sessionId, second.sessionId);

  // Later conversation work must not substitute its terminal for this receipt.
  await finishCommand(randomUUID(), first.sessionId);
  const old = await status(key);
  assert.equal(old.body.sourceUserSeq, source.seq);
  assert.equal(old.body.text, first.observed.body.text);
});

test('authenticated status resumes an ordinary canonical question but never an approval confirmation', async () => {
  const auth = await fetch(`${base}/m/auth/status`, { headers: { cookie: firstDevice } });
  const authBody = await auth.json() as { deviceId: string };
  assert.equal(auth.status, 200);
  assert.ok(authBody.deviceId);

  for (const boundary of ['ordinary', 'source-control', 'terminal-control', 'awaiting-approval'] as const) {
    const key = randomUUID();
    const digest = createHash('sha256').update(authBody.deviceId).update('\0').update(key).digest('hex');
    const requestId = `mobile:${digest}`;
    const runId = `run-mobile-${digest}`;
    const session = eventlog.createSession({ kind: 'chat', channel: 'mobile', userId: authBody.deviceId,
      title: 'Native question fixture', metadata: { source: 'mobile' } });
    eventlog.claimHarnessChatRequest({ requestId, runId, sessionId: session.id, inputHash: 'controlled-question', sinceSeq: 0 });
    const attempt = eventlog.beginRunAttempt(session.id, { runId });
    const source = eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
      text: 'Controlled native clarification fixture', source: 'gateway:mobile', runId,
      ...(boundary === 'source-control' ? { liveApprovalControl: { version: 1 } } : {}),
    } });
    if (boundary === 'awaiting-approval') {
      eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'awaiting_user_input',
        data: { sourceUserSeq: source.seq, approvalId: 'apr-question-fixture', reason: 'approval_confirmation_required' } });
    }
    const identity = { sessionId: session.id, turn: 1, sourceUserSeq: source.seq };
    const committed = commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'needs_input', resumable: true,
      needs: { kind: 'input' }, presentation: { kind: 'question', text: 'Which option should I use?' } },
    // Arbitrary terminal metadata is deliberately discarded by the committer.
    // Exercise a machine marker that is actually retained on the stored row.
    boundary === 'terminal-control' ? { legacyReason: 'approval_confirmation_required' } : {});
    if (boundary === 'terminal-control') {
      assert.equal(committed.event.data.reason, 'approval_confirmation_required');
    }
    eventlog.finishRunAttempt(attempt, 'completed');

    const observed = await status(key);
    assert.equal(observed.status, 200, JSON.stringify(observed.body));
    assert.equal(observed.body.sourceUserSeq, source.seq);
    assert.equal(observed.body.text, 'Which option should I use?');
    assert.equal(observed.body.canResumeVoice, boundary === 'ordinary', boundary);
    assert.equal(observed.body.state, boundary === 'ordinary' ? 'answered' : 'needs_app', boundary);
    assert.equal((await status(key, secondDevice)).status, 404);
  }
});
