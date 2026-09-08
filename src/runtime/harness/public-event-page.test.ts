import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-public-page-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const log = await import('./eventlog.js');
const { readPublicHarnessEventPage } = await import('./public-event-page.js');
test.after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

test('private raw pages advance to the real public answer without exposing private rows', () => {
  const session = log.createSession({ kind: 'chat' });
  const hidden = Array.from({ length: 7 }, (_, i) => log.appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'guardrail_tripped', data: { prompt: `private-${i}` } }));
  const answer = log.appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'conversation_completed', data: { reply: 'The account review is ready.' } });
  const first = readPublicHarnessEventPage(session.id, { limit: 3 });
  assert.deepEqual(first.events, []);
  assert.equal(first.page.hasMore, true);
  assert.equal(first.page.scannedThroughSeq, hidden[2]!.seq);
  const second = readPublicHarnessEventPage(session.id, { limit: 3, sinceSeq: first.page.scannedThroughSeq, throughSeq: first.page.snapshotSeq });
  assert.deepEqual(second.events, []);
  assert.equal(second.page.hasMore, true);
  const last = readPublicHarnessEventPage(session.id, { limit: 3, sinceSeq: second.page.scannedThroughSeq, throughSeq: second.page.snapshotSeq });
  assert.deepEqual(last.events.map(event => event.seq), [answer.seq]);
  assert.equal(last.events[0]?.data.reply, 'The account review is ready.');
  assert.equal(last.page.hasMore, false);
  assert.equal(last.page.scannedThroughSeq, answer.seq);
  assert.doesNotMatch(JSON.stringify([first, second, last]), /private-/);
});

test('stable frontier excludes new rows until next traversal and ignores foreign-session gaps', () => {
  const session = log.createSession({ kind: 'chat' });
  const foreign = log.createSession({ kind: 'chat' });
  const append = (sessionId: string, text: string) => log.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  const one = append(session.id, 'first');
  append(foreign.id, 'private foreign request');
  const two = append(session.id, 'second');
  const first = readPublicHarnessEventPage(session.id, { limit: 1 });
  assert.deepEqual(first.events.map(event => event.seq), [one.seq]);
  assert.equal(first.page.snapshotSeq, two.seq);
  const three = append(session.id, 'arrived while paging');
  const second = readPublicHarnessEventPage(session.id, { sinceSeq: first.page.scannedThroughSeq, throughSeq: first.page.snapshotSeq, limit: 1 });
  assert.deepEqual(second.events.map(event => event.seq), [two.seq]);
  assert.equal(second.page.hasMore, false);
  assert.equal(second.latestSeq, three.seq);
  const next = readPublicHarnessEventPage(session.id, { sinceSeq: second.page.scannedThroughSeq });
  assert.deepEqual(next.events.map(event => event.seq), [three.seq]);
  assert.doesNotMatch(JSON.stringify([first, second, next]), /private foreign/);
});

test('trailing private rows and empty sessions finish a bounded traversal without moving backwards', () => {
  const session = log.createSession({ kind: 'chat' });
  const empty = readPublicHarnessEventPage(session.id, { sinceSeq: 20 });
  assert.deepEqual(empty.page, { version: 1, scannedThroughSeq: 20, snapshotSeq: 20, hasMore: false });
  const tail = log.appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'guardrail_tripped', data: {} });
  const page = readPublicHarnessEventPage(session.id);
  assert.deepEqual(page.events, []);
  assert.equal(page.page.scannedThroughSeq, tail.seq);
  assert.equal(page.page.hasMore, false);
});

test('invalid cursors cannot trigger unbounded SQL or a non-progressing traversal', () => {
  const session = log.createSession({ kind: 'chat' });
  for (const value of ['1.5', '-1', 'NaN', 'Infinity', ['1'], {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => readPublicHarnessEventPage(session.id, { sinceSeq: value }), RangeError);
  }
  assert.throws(() => readPublicHarnessEventPage(session.id, { sinceSeq: 10, throughSeq: 9 }), RangeError);
  for (let i = 0; i < 502; i += 1) log.appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'guardrail_tripped', data: {} });
  const page = readPublicHarnessEventPage(session.id, { limit: 100_000 });
  assert.equal(page.page.hasMore, true);
  const remaining = log.listEvents(session.id, { sinceSeq: page.page.scannedThroughSeq });
  assert.equal(remaining.length, 2);
});
