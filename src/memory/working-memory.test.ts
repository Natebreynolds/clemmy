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
  workingMemoryPathForSession,
} = await import('./working-memory.js');
const { SessionStore } = await import('./session-store.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');

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

// (Active Task pin tests removed — the mechanism was deleted in goal-contract
//  Phase 3; the delegation pin is now the goal contract: see goal-contract tests.)
