import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-replay-consumers-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const log = await import('../runtime/harness/eventlog.js');
const { registerConsoleRoutes } = await import('./console-routes.js');
const { runHarnessStream, watchForLateCompletion } = await import('../../apps/console-web/src/lib/chat.js');
const { createInboxOutcomeCursor, pollInboxOutcomeEvents } = await import('../../apps/console-web/src/lib/useChat.js');
const { createReplayCursor, pollRecentReplayPages } = await import('../../apps/console-web/src/lib/replay-cursor.js');

let brainCalls = 0;
const app = express();
registerConsoleRoutes(app, () => true, {
  respond: async () => { brainCalls += 1; throw new Error('A read must never execute the assistant'); },
  getRuntime: () => ({ listPendingApprovals: () => [] }),
} as never, { serveLegacyAtRoot: false });
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const realFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalEventSource = globalThis.EventSource;
Object.assign(globalThis, { window: { __CLEM_BOOTSTRAP__: { token: 'test-only', flags: {} } } });

test.after(async () => {
  Object.assign(globalThis, { fetch: realFetch, window: originalWindow, EventSource: originalEventSource });
  await new Promise<void>(resolve => server.close(() => resolve()));
  log.closeEventLog(); rmSync(home, { recursive: true, force: true });
});

function privateRows(sessionId: string, count: number): void {
  for (let index = 0; index < count; index += 1) log.appendEvent({ sessionId, turn: 1, role: 'system', type: 'guardrail_tripped', data: { prompt: `never-publish-private-${index}` } });
}
function user(sessionId: string, text: string, extra: Record<string, unknown> = {}) {
  return log.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text, ...extra } });
}
function answer(sessionId: string, reply: string) {
  return log.appendEvent({ sessionId, turn: 1, role: 'Clem', type: 'conversation_completed', data: { reply } });
}
async function page(url: string) {
  const response = await realFetch(base + url);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.page.version, 1);
  assert.doesNotMatch(JSON.stringify(body), /never-publish-private/);
  return body;
}

class FakeEventSource {
  static active: FakeEventSource;
  listeners = new Map<string, (event: { data: string }) => void>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) { FakeEventSource.active = this; }
  addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, listener); }
  close() { this.closed = true; }
  emit(type: string, payload: unknown) { this.listeners.get(type)?.({ data: JSON.stringify(payload) }); }
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Replay did not settle')), 3000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

test('real recent route recovers a terminal beyond private pages without a later live event skipping earlier public history', async () => {
  const session = log.createSession({ kind: 'chat' });
  const start = user(session.id, 'Review the accounts');
  privateRows(session.id, 501);
  const earlier = user(session.id, 'Keep these existing values');
  privateRows(session.id, 501);
  const later = user(session.id, 'This later live frame must not advance raw coverage');
  const terminal = answer(session.id, 'The account review is ready.');
  const requested: URL[] = [];
  Object.assign(globalThis, { EventSource: FakeEventSource });
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    requested.push(new URL(String(url), base));
    return realFetch(new URL(String(url), base), init);
  }) as typeof fetch;
  const delivered: number[] = [];
  const stream = runHarnessStream(session.id, { sinceSeq: start.seq, onEvent: event => delivered.push(event.seq) });
  try {
    FakeEventSource.active.emit('event', later);
    FakeEventSource.active.onerror?.();
    assert.deepEqual(await within(stream.promise), { ok: true, error: null });
    assert.deepEqual(delivered, [later.seq, earlier.seq, terminal.seq]);
    assert.equal(requested[0]?.searchParams.get('sinceSeq'), String(start.seq));
    assert.ok(requested.length > 1 && requested.length <= 4);
    assert.equal(requested[1]?.searchParams.get('throughSeq'), String(terminal.seq));
    assert.equal(stream.getReplayCursor().scanSeq, terminal.seq);
    assert.equal(brainCalls, 0);
  } finally { stream.stop(); globalThis.fetch = realFetch; }
});

test('idle inbox keeps the first-poll watermark but continues private pages across bounded polls and preserves split delivery pairing', async () => {
  const session = log.createSession({ kind: 'chat' });
  user(session.id, 'old report', { synthetic: true, source: 'outcome', sourceId: 'old' });
  const old = answer(session.id, 'Already read');
  const cursor = createInboxOutcomeCursor(session.id);
  assert.deepEqual(await pollInboxOutcomeEvents(cursor, { fetchPage: page, active: () => true }), []);
  assert.equal(cursor.seq, old.seq);
  privateRows(session.id, 801);
  user(session.id, 'new report', { synthetic: true, source: 'outcome', sourceId: 'new', deliveryPhase: 'directive' });
  privateRows(session.id, 201);
  const terminal = answer(session.id, 'New account report');
  const requests: URL[] = [];
  const fetchPage = async (url: string) => { requests.push(new URL(url, base)); return page(url); };
  assert.deepEqual(await pollInboxOutcomeEvents(cursor, { fetchPage, active: () => true }), []);
  assert.equal(requests.length, 4, 'one poll has a finite request budget');
  assert.ok(cursor.seq < terminal.seq, 'latestSeq cannot claim unread rows were delivered');
  assert.equal(cursor.snapshotSeq, terminal.seq);
  const rows = await pollInboxOutcomeEvents(cursor, { fetchPage, active: () => true });
  assert.equal(requests[4]?.searchParams.get('throughSeq'), String(terminal.seq));
  assert.equal(rows.length, 1); assert.equal(rows[0]?.text, 'New account report');
  assert.equal(cursor.seq, terminal.seq);
  assert.deepEqual(await pollInboxOutcomeEvents(cursor, { fetchPage, active: () => true }), []);
  assert.equal(brainCalls, 0);
});

test('a cancelled inbox fetch turn consumes no hidden earlier report; later transport failure retains already-presentable pages', async () => {
  const session = log.createSession({ kind: 'chat' });
  const start = user(session.id, 'old');
  const cursor = createInboxOutcomeCursor(session.id); cursor.seq = start.seq;
  user(session.id, 'new report', { synthetic: true, source: 'outcome', sourceId: 'cancelled-fetch', deliveryPhase: 'directive' });
  const terminal = answer(session.id, 'Recoverable report'); privateRows(session.id, 201);
  let active = true; let calls = 0;
  const cancelled = await pollInboxOutcomeEvents(cursor, { active: () => active, fetchPage: async url => { calls += 1; const result = await page(url); if (calls === 2) active = false; return result; } });
  assert.deepEqual(cancelled, []); assert.equal(cursor.seq, start.seq); assert.deepEqual(cursor.deliveries, []);
  calls = 0;
  const recovered = await pollInboxOutcomeEvents(cursor, { active: () => true, fetchPage: async url => { calls += 1; if (calls === 2) throw new Error('network lost after a usable page'); return page(url); } });
  assert.equal(recovered.length, 1); assert.equal(recovered[0]?.text, 'Recoverable report');
  assert.ok(cursor.seq >= terminal.seq); assert.ok(cursor.snapshotSeq);
});

test('late-completion watch and bounded cursor keep a frozen traversal across an all-private page', async () => {
  const session = log.createSession({ kind: 'chat' });
  const start = user(session.id, 'Continue the report');
  privateRows(session.id, 501); const terminal = answer(session.id, 'Late answer');
  const cursor = createReplayCursor(start.seq);
  await pollRecentReplayPages({ sessionId: session.id, cursor, fetchPage: page, onEvent: () => assert.fail('first page is private'), active: () => true, maxPages: 1 });
  assert.equal(cursor.snapshotSeq, terminal.seq); assert.ok(cursor.scanSeq < terminal.seq);
  let resolve: (() => void) | undefined;
  const seen: number[] = []; const done = new Promise<void>(r => { resolve = r; });
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => realFetch(new URL(String(url), base), init)) as typeof fetch;
  const watch = watchForLateCompletion(session.id, start.seq, event => { seen.push(event.seq); resolve?.(); }, { intervalMs: 1, maxAttempts: 2, replayCursor: cursor });
  try { await within(done); assert.deepEqual(seen, [terminal.seq]); assert.equal(brainCalls, 0); }
  finally { watch.cancel(); globalThis.fetch = realFetch; }
});
