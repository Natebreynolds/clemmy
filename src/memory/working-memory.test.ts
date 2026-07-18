/**
 * Run: npx tsx --test src/memory/working-memory.test.ts
 *
 * P2-F — the lightweight between-turn checkpoint. Verifies it writes an
 * in-flight section into the per-session working-memory file, replaces (not
 * duplicates) that section on subsequent calls, preserves any pre-existing
 * content, and never throws (it must never break a turn).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wm-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  checkpointWorkingMemory,
  refreshWorkingMemory,
  refreshWorkingMemoryForSession,
  resolveWorkingMemoryForConsole,
  reapStaleWorkingMemory,
  loadWorkingMemoryForSession,
  workingMemoryPathForSession,
} = await import('./working-memory.js');
const { WORKING_MEMORY_FILE } = await import('./vault.js');
const { existsSync, unlinkSync, utimesSync } = await import('node:fs');
const { SessionStore } = await import('./session-store.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');

function seedChatTurn(sessionId: string, userText: string, replyText: string): void {
  appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: userText } });
  appendEvent({ sessionId, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: replyText } });
}

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('checkpointWorkingMemory writes an in-flight section into the per-session file', () => {
  const sid = 'sess-wm-1';
  checkpointWorkingMemory(sid, { turn: 3, toolCallsTotal: 7, lastText: 'Pulled 10 accounts; drafting next.' });
  const content = readFileSync(workingMemoryPathForSession(sid), 'utf-8');
  assert.ok(content.includes('## In-flight Checkpoint'), 'has the checkpoint section');
  assert.ok(content.includes('Turn: 3'));
  assert.ok(content.includes('Tool calls so far: 7'));
  assert.ok(content.includes('Pulled 10 accounts'), 'captures the latest text');
});

test('checkpointWorkingMemory replaces the section (no duplication) and preserves other content', () => {
  const sid = 'sess-wm-2';
  const file = workingMemoryPathForSession(sid);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '# Working Memory\n\n## Focus\nKeep going.\n');

  checkpointWorkingMemory(sid, { turn: 1, toolCallsTotal: 1 });
  checkpointWorkingMemory(sid, { turn: 4, toolCallsTotal: 9 });

  const content = readFileSync(file, 'utf-8');
  const occurrences = content.split('## In-flight Checkpoint').length - 1;
  assert.equal(occurrences, 1, 'exactly one checkpoint section (replaced, not appended)');
  assert.ok(content.includes('Turn: 4'), 'keeps the latest checkpoint');
  assert.ok(!content.includes('Turn: 1'), 'old checkpoint was replaced');
  assert.ok(content.includes('## Focus') && content.includes('Keep going.'), 'pre-existing content preserved');
});

test('checkpointWorkingMemory is best-effort and never throws', () => {
  assert.doesNotThrow(() => checkpointWorkingMemory('', {}));
  assert.doesNotThrow(() => checkpointWorkingMemory('sess-wm-3', { lastText: undefined, toolCallsTotal: undefined, turn: undefined }));
});

test('refreshWorkingMemory prefers canonical harness turns over same-id legacy ghost', () => {
  resetEventLog();
  const sessionId = 'sess-wm-harness-canonical';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'Harness canonical working memory' });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Use working memory source WM-HARNESS-515.' },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reply: 'WM-HARNESS-515 is now the accepted source.' },
  });
  const ghost = new SessionStore().appendTurn(sessionId, {
    role: 'user',
    text: '[background task wm-ghost completed] synthetic report-back only',
    createdAt: new Date().toISOString(),
  }, 'user-wm', 'desktop');

  refreshWorkingMemory(ghost);

  const content = readFileSync(workingMemoryPathForSession(sessionId), 'utf-8');
  assert.match(content, /WM-HARNESS-515/);
  assert.match(content, /Use working memory source/);
  assert.doesNotMatch(content, /wm-ghost/);
});

test('refreshWorkingMemoryForSession writes the per-session file from the transcript but NEVER the global file', () => {
  resetEventLog();
  if (existsSync(WORKING_MEMORY_FILE)) unlinkSync(WORKING_MEMORY_FILE);
  const sessionId = 'sess-wm-harness-live';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'Live harness turn' });
  seedChatTurn(sessionId, 'Track working memory source WM-LIVE-777.', 'WM-LIVE-777 recorded.');

  // This is what the live harness (loop.ts / claude-agent-brain.ts) calls per turn.
  refreshWorkingMemoryForSession(sessionId, 'desktop');

  const perSession = readFileSync(workingMemoryPathForSession(sessionId), 'utf-8');
  assert.match(perSession, /WM-LIVE-777/, 'per-session working memory reflects the live transcript');
  // The global file is the working_memory tool's scratchpad — the harness path
  // must NOT clobber it (writeGlobal:false).
  assert.equal(existsSync(WORKING_MEMORY_FILE), false, 'harness refresh never writes the global working-memory.md');
});

test('resolveWorkingMemoryForConsole surfaces the freshest user-facing session; internal sessions are skipped', () => {
  resetEventLog();
  if (existsSync(WORKING_MEMORY_FILE)) unlinkSync(WORKING_MEMORY_FILE);
  const chat = 'sess-wm-console-user';
  createSession({ id: chat, kind: 'chat', channel: 'desktop', title: 'User chat' });
  seedChatTurn(chat, 'Console should show WM-CONSOLE-42.', 'ok');
  refreshWorkingMemoryForSession(chat, 'desktop');

  const cron = 'cron:nightly';
  createSession({ id: cron, kind: 'agent', channel: 'cron', title: 'nightly' });
  refreshWorkingMemoryForSession(cron, 'cron');

  const resolved = resolveWorkingMemoryForConsole();
  assert.equal(resolved.source, 'session');
  assert.match(resolved.content, /WM-CONSOLE-42/, 'shows the user-facing session working memory');
  assert.equal(resolved.sessionLabel, 'User chat');
  assert.ok(loadWorkingMemoryForSession(chat)?.includes('WM-CONSOLE-42'));
});

test('resolveWorkingMemoryForConsole never selects a newer workflow checkpoint as the current chat', () => {
  resetEventLog();
  if (existsSync(WORKING_MEMORY_FILE)) unlinkSync(WORKING_MEMORY_FILE);
  const chat = 'sess-wm-console-chat-only';
  createSession({ id: chat, kind: 'chat', channel: 'desktop', title: 'Actual chat' });
  seedChatTurn(chat, 'Keep WM-CHAT-ONLY visible.', 'WM-CHAT-ONLY confirmed.');
  refreshWorkingMemoryForSession(chat, 'desktop');

  const workflow = 'custom-workflow-row-without-internal-prefix';
  createSession({ id: workflow, kind: 'workflow', channel: 'desktop', title: 'Not a chat' });
  checkpointWorkingMemory(workflow, { turn: 9, lastText: 'WM-WORKFLOW-MUST-NOT-WIN' });

  const resolved = resolveWorkingMemoryForConsole();
  assert.equal(resolved.source, 'session');
  assert.equal(resolved.sessionLabel, 'Actual chat');
  assert.match(resolved.content, /WM-CHAT-ONLY/);
  assert.doesNotMatch(resolved.content, /WM-WORKFLOW-MUST-NOT-WIN/);
});

test('refreshWorkingMemory default (writeGlobal:true) still writes the global file for legacy callers', () => {
  resetEventLog();
  if (existsSync(WORKING_MEMORY_FILE)) unlinkSync(WORKING_MEMORY_FILE);
  const sessionId = 'sess-wm-legacy';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'Legacy path' });
  seedChatTurn(sessionId, 'Legacy WM-LEGACY-9 note.', 'ok');
  refreshWorkingMemory({ id: sessionId, channel: 'desktop', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), turns: [] });
  assert.equal(existsSync(WORKING_MEMORY_FILE), true, 'legacy callers keep maintaining the global file');
});

test('reapStaleWorkingMemory removes aged per-session files and keeps fresh ones', () => {
  const fresh = 'sess-wm-gc-fresh';
  const stale = 'sess-wm-gc-stale';
  checkpointWorkingMemory(fresh, { turn: 1, lastText: 'active' });
  checkpointWorkingMemory(stale, { turn: 1, lastText: 'idle' });
  const stalePath = workingMemoryPathForSession(stale);
  const twentyDaysAgo = Date.now() / 1000 - 20 * 24 * 60 * 60;
  utimesSync(stalePath, twentyDaysAgo, twentyDaysAgo);

  const removed = reapStaleWorkingMemory(); // default 14-day TTL
  assert.ok(removed >= 1, 'reaped at least the aged file');
  assert.equal(existsSync(stalePath), false, 'aged file deleted');
  assert.equal(existsSync(workingMemoryPathForSession(fresh)), true, 'fresh file preserved');
  assert.equal(reapStaleWorkingMemory(), 0, 'second sweep is a no-op');
});

test('reapStaleWorkingMemory preserves an aged file while its resumable session row survives', () => {
  resetEventLog();
  const sessionId = 'sess-wm-gc-retained-active';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'Retained active chat' });
  checkpointWorkingMemory(sessionId, { turn: 1, lastText: 'resume me later' });
  const filePath = workingMemoryPathForSession(sessionId);
  const twentyDaysAgo = Date.now() / 1000 - 20 * 24 * 60 * 60;
  utimesSync(filePath, twentyDaysAgo, twentyDaysAgo);

  reapStaleWorkingMemory(14);
  assert.equal(existsSync(filePath), true, 'age alone cannot delete a surviving session snapshot');
});

// (Active Task pin tests removed — the mechanism was deleted in goal-contract
//  Phase 3; the delegation pin is now the goal contract: see goal-contract tests.)
