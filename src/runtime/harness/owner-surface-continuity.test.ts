/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/owner-surface-continuity.test.ts
 *
 * Owner 2026-10-30: "Users should be able to continue chats between desktop
 * and mobile." A message from the phone into a conversation the desktop
 * started (and the other way round) continues that conversation in the same
 * session, with its history; it never splits into an empty principal root.
 * Shared channels keep one principal per person, and two different phones
 * stay separate as before.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-owner-surfaces-'));
process.env.CLEMENTINE_HOME = TMP;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const { claimSessionForAcceptedSource } = await import('./accepted-source-session-branch.js');

test.after(() => {
  eventlog.closeEventLog();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

let serial = 0;
const claim = (entrySessionId: string, continuity: { provider: string; scopeId: string | null; conversationId: string; audienceId: string }) => {
  const run = `owner-surface-run-${++serial}`;
  return claimSessionForAcceptedSource({ kind: 'ordinary', entrySessionId, durableSourceId: run, continuity,
    receipt: { requestId: `${run}-request`, runId: run, inputHash: run } }).selection;
};

test('the phone continues a conversation the desktop started, and the desktop continues one the phone started', () => {
  const desktop = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'Started on the Mac',
    metadata: { source: 'desktop', channelId: 'desk-root', userId: 'desktop' } });
  eventlog.updateSession(desktop.id, { metadata: { source: 'desktop', channelId: desktop.id, userId: 'desktop' } });
  const first = claim(desktop.id, { provider: 'desktop', scopeId: null, conversationId: desktop.id, audienceId: 'desktop' });
  const asked = eventlog.appendEvent({ sessionId: first.sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Move my 2pm with Dana to Thursday.' } });
  eventlog.appendEvent({ sessionId: first.sessionId, turn: 1, role: 'Clem', type: 'conversation_completed',
    data: { sourceUserSeq: asked.seq, reply: 'Thursday at 2 works for Dana. Want me to send the update?', reason: 'success' } });
  const fromPhone = claim(desktop.id, { provider: 'mobile', scopeId: null, conversationId: desktop.id, audienceId: 'dev-phone-a' });
  assert.notEqual(fromPhone.disposition, 'identity_split', 'the owner on the phone is not a stranger to their own desktop chat');
  assert.equal(fromPhone.rootSessionId, first.rootSessionId, 'the same conversation');
  // Same session, or a successor that carries the conversation forward: the
  // phone's next turn sees what was asked and answered on the desktop.
  const carried = fromPhone.sessionId === first.sessionId
    || eventlog.listEvents(fromPhone.sessionId, { types: ['cross_session_prefix'] }).length > 0;
  assert.ok(carried, 'the phone sees the desktop exchange');

  const phone = eventlog.createSession({ kind: 'chat', channel: 'mobile', title: 'Started on the phone', userId: 'dev-phone-a',
    metadata: { source: 'mobile', ingressProvider: 'mobile', channelId: 'phone-root', userId: 'dev-phone-a' } });
  const started = claim(phone.id, { provider: 'mobile', scopeId: null, conversationId: 'phone-root', audienceId: 'dev-phone-a' });
  const fromDesktop = claim(phone.id, { provider: 'desktop', scopeId: null, conversationId: phone.id, audienceId: 'desktop' });
  assert.notEqual(fromDesktop.disposition, 'identity_split');
  assert.equal(fromDesktop.rootSessionId, started.rootSessionId);
});

test('shared channels and two different phones keep their own principals', () => {
  const channel = eventlog.createSession({ kind: 'chat', channel: 'discord', title: 'Team channel', userId: 'person-a',
    metadata: { source: 'discord', ingressProvider: 'discord', channelId: 'chan-1', userId: 'person-a', guildId: 'guild-1' } });
  claim(channel.id, { provider: 'discord', scopeId: 'guild-1', conversationId: 'chan-1', audienceId: 'person-a' });
  const other = claim(channel.id, { provider: 'discord', scopeId: 'guild-1', conversationId: 'chan-1', audienceId: 'person-b' });
  assert.equal(other.disposition, 'identity_split', 'another person in a shared channel never reads this conversation');

  const phoneA = eventlog.createSession({ kind: 'chat', channel: 'mobile', title: 'Phone A', userId: 'dev-a',
    metadata: { source: 'mobile', ingressProvider: 'mobile', channelId: 'a-root', userId: 'dev-a' } });
  claim(phoneA.id, { provider: 'mobile', scopeId: null, conversationId: 'a-root', audienceId: 'dev-a' });
  const phoneB = claim(phoneA.id, { provider: 'mobile', scopeId: null, conversationId: 'a-root', audienceId: 'dev-b' });
  assert.equal(phoneB.disposition, 'identity_split', 'a second phone is unchanged by this rule');
});
