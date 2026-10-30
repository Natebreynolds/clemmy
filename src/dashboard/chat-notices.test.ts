/**
 * Run: node scripts/run-tests-isolated.mjs src/dashboard/chat-notices.test.ts
 *
 * Archiving or deleting a chat reads the chat's own notices, so Needs you
 * keeps no row for a conversation the owner set aside. A workflow the chat
 * started keeps its notices, and other chats are untouched.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-chat-notices-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { settleNoticesOfSetAsideChats } = await import('./chat-notices.js');
const { addNotification, getNotification } = await import('../runtime/notifications.js');

const notice = (id: string, metadata: Record<string, unknown>) => addNotification({
  id, kind: 'execution', title: 'Clem replied', body: 'Here is what I found.', createdAt: new Date().toISOString(), read: false, metadata,
});

test('a set-aside chat\'s own notices are read; its workflows\' and other chats\' notices stay', () => {
  notice('report-back', { sessionId: 'sess-a' });
  notice('report-back-snake', { session_id: 'sess-a' });
  notice('report-back-asking', { sessionId: 'sess-a', needsAttention: true, foregroundRun: true });
  notice('workflow-it-started', { originSessionId: 'sess-a', workflow: 'Weekly digest' });
  notice('other-chat', { sessionId: 'sess-b' });

  assert.equal(settleNoticesOfSetAsideChats(['sess-a']), 3);
  assert.equal(getNotification('report-back')?.read, true);
  assert.equal(getNotification('report-back-snake')?.read, true);
  assert.equal(getNotification('report-back-asking')?.read, true, 'an ask inside a set-aside chat is answered by setting it aside');
  assert.equal(getNotification('workflow-it-started')?.read, false, 'the workflow lives on after its chat is set aside');
  assert.equal(getNotification('other-chat')?.read, false);
  assert.equal(settleNoticesOfSetAsideChats([]), 0);
});
