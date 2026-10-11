/**
 * Run: node scripts/run-tests-isolated.mjs src/channels/mobile-chat-running-routes.test.ts
 *
 * The phone's conversation list says which conversations have work in flight
 * right now, so a reply that keeps going after the owner leaves the thread is
 * still visible as running from the menu and the list. The signal is the
 * run attempt the engine itself keeps open while it works.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mobile-running-'));
process.env.CLEMENTINE_HOME = TMP_ROOT;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP_ROOT, 'state'), { recursive: true });

const { createMobileRouter, MOBILE_SESSION_COOKIE } = await import('./mobile-routes.js');
const { setPin } = await import('../runtime/mobile-pin.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const { claimSessionForAcceptedSource } = await import('../runtime/harness/accepted-source-session-branch.js');

test.after(() => {
  eventlog.closeEventLog();
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('the phone keeps one Stop/Continue conversation while history and control cursors stay with their exact execution heads', async () => {
  const stateDir = path.join(TMP_ROOT, 'continuity-case');
  const app = express();
  app.use(express.json());
  app.use('/m', createMobileRouter({ stateDir, isAdminAuthorized: () => false }));
  const server: Server = await new Promise(resolve => {
    const s = createServer(app); s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/m`;
  const identity = { provider: 'mobile', scopeId: null, conversationId: 'fixture-phone-chat', audienceId: 'fixture-owner' };
  const root = eventlog.createSession({ kind: 'chat', channel: 'mobile', userId: identity.audienceId,
    title: 'Named stopped phone fixture', metadata: { source: 'mobile', channelId: identity.conversationId, userId: identity.audienceId } });
  const claim = (entrySessionId: string, run: string, continuity = identity) => claimSessionForAcceptedSource({
    kind: 'ordinary', entrySessionId, durableSourceId: run, continuity,
    receipt: { requestId: `${run}-request`, runId: run, inputHash: run } });
  claim(root.id, 'phone-root');
  const rootAttempt = eventlog.beginRunAttempt(root.id, { runId: 'phone-root' });
  const rootSource = eventlog.recordRunAttemptUserInput(rootAttempt, { turn: 1, role: 'user', data: { text: 'Keep this phone fixture draft.' } });
  eventlog.appendEvent({ sessionId: root.id, turn: 1, role: 'Clem', type: 'conversation_completed',
    data: { sourceUserSeq: rootSource.seq, reason: 'cancelled', reply: 'I stopped the phone fixture.' } });
  eventlog.finishRunAttempt(rootAttempt, 'cancelled');
  eventlog.updateSession(root.id, { status: 'cancelled' });
  const head = claim(root.id, 'phone-continue').selection.sessionId;
  const headAttempt = eventlog.beginRunAttempt(head, { runId: 'phone-continue' });
  const headSource = eventlog.recordRunAttemptUserInput(headAttempt, { turn: 1, role: 'user', data: { text: 'Continue the retained phone fixture.' } });
  const other = claim(root.id, 'phone-other-owner', { ...identity, audienceId: 'another-owner' }).selection.sessionId;
  eventlog.appendEvent({ sessionId: other, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Other owner private fixture.' } });
  try {
    await setPin('TestPin1!', { stateDir });
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!', deviceLabel: 'Continuity fixture phone' }) });
    assert.equal(login.status, 200);
    const raw = login.headers.get('set-cookie') ?? '';
    const cookie = `${MOBILE_SESSION_COOKIE}=${raw.slice(raw.indexOf('=') + 1).split(';')[0]}`;
    const get = async (url: string) => (await (await fetch(`${base}${url}`, { headers: { cookie } })).json()) as any;
    const listed = (await get('/api/chat/sessions')).sessions;
    const matches = listed.filter((row: { id: string }) => row.id === root.id || row.id === head);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, root.id);
    assert.equal(matches[0].executionSessionId, head);
    assert.equal(matches[0].running, true);
    const detail = await get(`/api/chat/sessions/${root.id}?limit=1`);
    assert.equal(detail.session.id, root.id);
    assert.equal(detail.session.executionSessionId, head);
    assert.ok(detail.events.every((event: { sessionId: string }) => event.sessionId === head));
    assert.deepEqual(detail.history.map((group: { sessionId: string }) => group.sessionId), [root.id]);
    assert.equal(detail.history[0].page.hasMore, true, 'history has its own raw cursor, even when the first row is private');
    const ownHead = await get(`/api/chat/sessions/${head}`);
    assert.equal(ownHead.session.id, root.id);
    assert.equal(ownHead.latestSeq, eventlog.getLatestEventSeq(head));
    assert.equal((await get(`/api/chat/sessions/${root.id}/control?sourceUserSeq=${rootSource.seq}`)).activeRun, null,
      'a public root is not the new attempt');
    assert.equal((await get(`/api/chat/sessions/${head}/control?sourceUserSeq=${headSource.seq}`)).activeRun.attemptId, headAttempt.attemptId);
    assert.equal((await get(`/api/chat/sessions/${head}/control?sourceUserSeq=${rootSource.seq}`)).activeRun, null);
    const separated = await get(`/api/chat/sessions/${other}`);
    assert.equal(separated.history, undefined);
    assert.equal(separated.session.id, other);
    assert.doesNotMatch(JSON.stringify(detail), /Other owner private fixture/);
    assert.equal(eventlog.getSession(root.id)?.status, 'cancelled');
  } finally {
    eventlog.finishRunAttempt(headAttempt, 'cancelled');
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('the phone list marks a conversation running while its run is in flight, and only then', async () => {
  const stateDir = path.join(TMP_ROOT, 'case');
  const app = express();
  app.use(express.json());
  app.use('/m', createMobileRouter({ stateDir, isAdminAuthorized: () => false }));
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await setPin('TestPin1!', { stateDir });
    const login = await fetch(`${url}/m/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: 'TestPin1!', deviceLabel: 'Running phone' }),
    });
    assert.equal(login.status, 200);
    const raw = login.headers.get('set-cookie') ?? '';
    const cookie = `${MOBILE_SESSION_COOKIE}=${raw.slice(raw.indexOf('=') + 1).split(';')[0]}`;
    const list = async () => (await (await fetch(`${url}/m/api/chat/sessions`, { headers: { cookie } })).json()) as {
      sessions: Array<{ id: string; running: boolean }>;
    };

    const busy = eventlog.createSession({ kind: 'chat', title: 'Fixture still working' });
    const quiet = eventlog.createSession({ kind: 'chat', title: 'Fixture finished' });
    const attempt = eventlog.beginRunAttempt(busy.id, { runId: 'fixture-running-reply' });
    const done = eventlog.beginRunAttempt(quiet.id, { runId: 'fixture-finished-reply' });
    eventlog.finishRunAttempt(done, 'completed');

    const during = await list();
    assert.equal(during.sessions.find((s) => s.id === busy.id)?.running, true);
    assert.equal(during.sessions.find((s) => s.id === quiet.id)?.running, false);

    eventlog.finishRunAttempt(attempt, 'completed');
    const after = await list();
    assert.equal(after.sessions.find((s) => s.id === busy.id)?.running, false, 'the mark ends when the work does');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
