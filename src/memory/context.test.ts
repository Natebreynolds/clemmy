/**
 * Run: npx tsx --test src/memory/context.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-memory-context-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { assemblePromptContextAsync } = await import('./context.js');
const { SessionStore } = await import('./session-store.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('prompt context prior-session seed can come from a recent same-user harness session', async () => {
  resetEventLog();
  const store = new SessionStore();
  store.appendTurn('desktop-current', {
    role: 'user',
    text: 'new desktop chat',
    createdAt: new Date().toISOString(),
  }, 'user-ctx-1', 'desktop');
  const prior = createSession({
    id: 'harness-prior',
    kind: 'chat',
    channel: 'discord',
    userId: 'user-ctx-1',
    title: 'Prior Discord context',
  });
  appendEvent({
    sessionId: prior.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Use the approved client sheet SHEET-CTX-123.' },
  });
  appendEvent({
    sessionId: prior.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reply: 'I pinned SHEET-CTX-123 as the working source.' },
  });

  const ctx = await assemblePromptContextAsync('desktop-current', 'what can you do', '');

  assert.match(ctx.memoryContext.sessionBrief ?? '', /Prior session/);
  assert.match(ctx.memoryContext.sessionBrief ?? '', /SHEET-CTX-123/);
  assert.doesNotMatch(ctx.memoryContext.sessionBrief ?? '', /new desktop chat/);
});

test('prompt context prior-session seed prefers harness transcript over same-id legacy ghost', async () => {
  resetEventLog();
  const store = new SessionStore();
  store.appendTurn('desktop-current-ghost', {
    role: 'user',
    text: 'new desktop chat',
    createdAt: new Date().toISOString(),
  }, 'user-ctx-ghost', 'desktop');
  const prior = createSession({
    id: 'same-prior-ghost',
    kind: 'chat',
    channel: 'discord',
    userId: 'user-ctx-ghost',
    title: 'Canonical prior context',
  });
  appendEvent({
    sessionId: prior.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Use canonical harness source HARNESS-CTX-777.' },
  });
  appendEvent({
    sessionId: prior.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reply: 'HARNESS-CTX-777 is the approved source.' },
  });
  store.appendTurn(prior.id, {
    role: 'user',
    text: '[background task prior-ghost completed] synthetic report-back only',
    createdAt: new Date().toISOString(),
  }, 'user-ctx-ghost', 'desktop');

  const ctx = await assemblePromptContextAsync('desktop-current-ghost', 'what can you do', '');

  assert.match(ctx.memoryContext.sessionBrief ?? '', /HARNESS-CTX-777/);
  assert.doesNotMatch(ctx.memoryContext.sessionBrief ?? '', /prior-ghost/);
});

test('prompt context prior-session seed uses harness user identity over same-id legacy ghost', async () => {
  resetEventLog();
  const store = new SessionStore();
  createSession({
    id: 'current-same-id-user',
    kind: 'chat',
    channel: 'discord',
    userId: 'canonical-user',
    title: 'Canonical current context',
  });
  store.appendTurn('current-same-id-user', {
    role: 'user',
    text: 'stale desktop current chat',
    createdAt: new Date().toISOString(),
  }, 'ghost-user', 'desktop');
  const prior = createSession({
    id: 'canonical-user-prior',
    kind: 'chat',
    channel: 'discord',
    userId: 'canonical-user',
    title: 'Canonical prior context',
  });
  appendEvent({
    sessionId: prior.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Use canonical user seed CANON-USER-SEED-333.' },
  });
  appendEvent({
    sessionId: prior.id,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reply: 'CANON-USER-SEED-333 is the approved handoff source.' },
  });
  store.appendTurn('ghost-user-prior', {
    role: 'user',
    text: 'Use stale ghost seed GHOST-USER-SEED.',
    createdAt: new Date().toISOString(),
  }, 'ghost-user', 'desktop');

  const ctx = await assemblePromptContextAsync('current-same-id-user', 'what can you do', '');

  assert.match(ctx.memoryContext.sessionBrief ?? '', /CANON-USER-SEED-333/);
  assert.doesNotMatch(ctx.memoryContext.sessionBrief ?? '', /GHOST-USER-SEED/);
});

test('prompt context prior-session seed suppresses empty-harness same-id outcome ghosts', async () => {
  resetEventLog();
  const store = new SessionStore();
  store.appendTurn('desktop-current-empty-harness-ghost', {
    role: 'user',
    text: 'new desktop chat',
    createdAt: new Date().toISOString(),
  }, 'user-empty-harness-ghost', 'desktop');
  createSession({
    id: 'empty-harness-prior-ghost',
    kind: 'chat',
    channel: 'discord',
    userId: 'user-empty-harness-ghost',
    title: 'Empty harness prior context',
  });
  store.appendTurn('empty-harness-prior-ghost', {
    role: 'user',
    text: '[background task bg-empty-prior completed] stale desktop outcome GHOST-EMPTY-SEED-444',
    createdAt: new Date().toISOString(),
  }, 'user-empty-harness-ghost', 'desktop');

  const ctx = await assemblePromptContextAsync('desktop-current-empty-harness-ghost', 'what can you do', '');

  assert.doesNotMatch(ctx.memoryContext.sessionBrief ?? '', /GHOST-EMPTY-SEED-444/);
  assert.doesNotMatch(ctx.memoryContext.sessionBrief ?? '', /Prior session/);
});
