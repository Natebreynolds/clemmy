/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/owner-choice.test.ts
 *
 * A tapped Home choice reaches the consent gate only through a host-minted,
 * one-time token the bridge writes into the accepted source's own event.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-owner-choice-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
const eventlog = await import('./eventlog.js');
const { mintOwnerChoiceToken, redeemOwnerChoiceToken, ownerChoiceForSource } = await import('./owner-choice.js');
after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

const tapped = { rowKey: 'notif:calendar-watch:invite_unanswered:abc', voiceDigest: 'v1', said: 'Want me to accept it?', facts: 'Reply needed: Q4 prep', choice: 'Accept', ref: { eventId: 'evt-1' } };

test('a token redeems once, and only for the host that minted it', () => {
  const token = mintOwnerChoiceToken(tapped);
  const redeemed = redeemOwnerChoiceToken(token);
  assert.equal(redeemed?.choice, 'Accept');
  assert.deepEqual(redeemed?.ref, { eventId: 'evt-1' });
  assert.equal(redeemOwnerChoiceToken(token), null, 'spent');
  assert.equal(redeemOwnerChoiceToken('f'.repeat(48)), null, 'never minted');
  assert.equal(redeemOwnerChoiceToken(undefined), null);
  const stale = mintOwnerChoiceToken(tapped, Date.now() - 11 * 60_000);
  assert.equal(redeemOwnerChoiceToken(stale), null, 'stale');
});

test('the consent gate reads the tap from the accepted source\'s own event, and nothing else', () => {
  const session = eventlog.createSession({ id: `owner-choice-${Date.now()}`, kind: 'chat' });
  const withChoice = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Accept', ownerChoice: { version: 1, ...tapped, tappedAt: new Date().toISOString() } } });
  assert.equal(ownerChoiceForSource(session.id, withChoice.seq)?.choice, 'Accept');
  const typed = eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Accept' } });
  assert.equal(ownerChoiceForSource(session.id, typed.seq), null, 'typed words are an ordinary reply');
  const forged = eventlog.appendEvent({ sessionId: session.id, turn: 3, role: 'user', type: 'user_input_received',
    data: { text: 'Accept', ownerChoice: { version: 2, choice: 'Accept' } } });
  assert.equal(ownerChoiceForSource(session.id, forged.seq), null, 'a malformed marker is nothing');
});
