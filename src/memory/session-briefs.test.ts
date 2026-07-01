/**
 * Run: npx tsx --test src/memory/session-briefs.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-session-briefs-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { refreshSessionBrief, saveSessionManualHandoff } = await import('./session-briefs.js');
const { SessionStore } = await import('./session-store.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('refreshSessionBrief prefers canonical harness turns over same-id legacy ghost', () => {
  resetEventLog();
  const sessionId = 'sess-brief-harness-canonical';
  createSession({ id: sessionId, kind: 'chat', channel: 'discord', userId: 'brief-user', title: 'Harness brief' });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Continue from canonical brief source BRIEF-HARNESS-818.' },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reply: 'BRIEF-HARNESS-818 is the active source.' },
  });
  const ghost = new SessionStore().appendTurn(sessionId, {
    role: 'user',
    text: '[background task brief-ghost completed] synthetic report-back only',
    createdAt: new Date().toISOString(),
  }, 'brief-user', 'desktop');

  const brief = refreshSessionBrief(ghost);

  assert.equal(brief.channel, 'discord');
  assert.match(brief.auto.summary, /BRIEF-HARNESS-818/);
  assert.match(brief.auto.recentUserRequests.join('\n'), /canonical brief source/);
  assert.doesNotMatch(brief.auto.summary, /brief-ghost/);
  assert.doesNotMatch(brief.auto.recentUserRequests.join('\n'), /brief-ghost/);
});

test('saveSessionManualHandoff builds auto summary from canonical harness turns', () => {
  resetEventLog();
  const sessionId = 'sess-brief-manual-harness';
  createSession({ id: sessionId, kind: 'chat', channel: 'discord', userId: 'brief-user', title: 'Harness handoff' });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Keep handoff source BRIEF-HANDOFF-919.' },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reply: 'BRIEF-HANDOFF-919 is saved for resume.' },
  });
  const ghost = new SessionStore().appendTurn(sessionId, {
    role: 'user',
    text: '[background task handoff-ghost completed] synthetic report-back only',
    createdAt: new Date().toISOString(),
  }, 'brief-user', 'desktop');

  const brief = saveSessionManualHandoff({
    session: ghost,
    completed: ['Recorded the canonical handoff source'],
    remaining: ['Resume from BRIEF-HANDOFF-919'],
  });

  assert.equal(brief.channel, 'discord');
  assert.match(brief.auto.summary, /BRIEF-HANDOFF-919/);
  assert.match(brief.auto.recentAssistantActions.join('\n'), /saved for resume/);
  assert.doesNotMatch(brief.auto.summary, /handoff-ghost/);
});
