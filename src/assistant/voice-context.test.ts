/**
 * Run: npx tsx --test src/assistant/voice-context.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-voice-context-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildRealtimeVoiceInstructions } = await import('./voice-context.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');
const { SessionStore } = await import('../memory/session-store.js');
const { refreshSessionBrief } = await import('../memory/session-briefs.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('voice instructions use canonical harness history when no session brief exists', () => {
  resetEventLog();
  const session = createSession({ id: 'voice-harness-session', kind: 'chat', channel: 'discord', title: 'Voice handoff' });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Keep the voice handoff tied to CLIENT-VOICE-42.' },
  });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reply: 'Got it, CLIENT-VOICE-42 is the active reference.' },
  });

  const instructions = buildRealtimeVoiceInstructions(session.id);

  assert.match(instructions, /## Session Continuity/);
  assert.match(instructions, /CLIENT-VOICE-42/);
  assert.match(instructions, /USER: Keep the voice handoff/);
  assert.match(instructions, /YOU: Got it/);
});

test('voice instructions include canonical harness history even when a same-id stale brief exists', () => {
  resetEventLog();
  const sessionId = 'voice-harness-with-stale-brief';
  createSession({ id: sessionId, kind: 'chat', channel: 'discord', title: 'Voice canonical handoff' });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Keep using canonical voice source VOICE-HARNESS-99.' },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reply: 'VOICE-HARNESS-99 remains the approved source.' },
  });
  const ghost = new SessionStore().appendTurn(sessionId, {
    role: 'user',
    text: '[background task voice-ghost completed] synthetic report-back only',
    createdAt: new Date().toISOString(),
  }, 'voice-user', 'desktop');
  refreshSessionBrief(ghost);

  const instructions = buildRealtimeVoiceInstructions(sessionId);

  assert.match(instructions, /Canonical harness history/);
  assert.match(instructions, /VOICE-HARNESS-99/);
  assert.match(instructions, /USER: Keep using canonical voice source/);
  assert.match(instructions, /YOU: VOICE-HARNESS-99 remains/);
});
