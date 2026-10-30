/**
 * Run: node scripts/run-tests-isolated.mjs src/channels/conversation-asks.test.ts
 *
 * A conversation is waiting on the owner exactly while Clem's ask is newer
 * than the owner's last message, and the phone's list says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clemmy-conversation-asks-'));
process.env.CLEMENTINE_HOME = TMP_ROOT;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP_ROOT, 'state'), { recursive: true });

const eventlog = await import('../runtime/harness/eventlog.js');
const { ownerAskWaiting } = await import('./conversation-asks.js');

test.after(() => {
  eventlog.closeEventLog();
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('Clem\'s ask is waiting until the owner answers it', () => {
  const chat = eventlog.createSession({ kind: 'chat', channel: 'mobile', title: 'Weekday inbox summary' });
  const say = (role: string, type: string, data: Record<string, unknown>) =>
    eventlog.appendEvent({ sessionId: chat.id, turn: 1, role, type, data });
  assert.equal(ownerAskWaiting(chat.id), null, 'a new conversation waits on no one');
  say('user', 'user_input_received', { text: 'Email me a summary every weekday at 8.' });
  assert.equal(ownerAskWaiting(chat.id), null, 'Clem is the one working');
  say('Clem', 'awaiting_user_input', { question: 'Does 8:00 AM Pacific from your work inbox match?', options: ['Yes, set that up'] });
  assert.deepEqual(ownerAskWaiting(chat.id), { question: 'Does 8:00 AM Pacific from your work inbox match?' });
  say('user', 'user_input_received', { text: 'Yes, set that up' });
  assert.equal(ownerAskWaiting(chat.id), null, 'the answer settles it');
});

test('the phone\'s list carries the ask, and only for a conversation that is not running', () => {
  const routes = readFileSync(new URL('./mobile-routes.ts', import.meta.url), 'utf8');
  assert.match(routes, /waitingOnYou: running \|\| session\.kind !== 'chat' \? null : ownerAskWaiting\(session\.id\)/);
});
