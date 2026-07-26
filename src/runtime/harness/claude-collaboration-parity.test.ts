/**
 * Run: npx tsx --test src/runtime/harness/claude-collaboration-parity.test.ts
 *
 * Runtime proof—not just source wiring—that the Claude Agent SDK lane reaches
 * the same provider-neutral collaborative continuity hook as the standard
 * harness loop.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-claude-collaboration-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.AUTH_MODE = 'claude_oauth';
process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN = 'read_only';
process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE = 'off';
process.env.CLEMMY_TOOL_JIT = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  respondViaClaudeAgentSdkBrain,
  setClaudeAgentSdkBrainRunForTest,
  setClaudeAgentSdkBrainUnifiedPrimerForTest,
} = await import('./claude-agent-brain.js');
const { closeEventLog, resetEventLog } = await import('./eventlog.js');
const { resetMemoryDb } = await import('../../memory/db.js');
const { getActiveFocus, getFocusWorkstate } = await import('../../memory/focus.js');

after(() => {
  setClaudeAgentSdkBrainRunForTest(null);
  setClaudeAgentSdkBrainUnifiedPrimerForTest(null);
  closeEventLog();
  delete process.env.CLEMMY_CLAUDE_AGENT_SDK_BRAIN;
  delete process.env.CLEMMY_CLAUDE_SDK_COMPLETION_JUDGE;
  delete process.env.CLEMMY_TOOL_JIT;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('Claude chat turns auto-focus the same sustained conversation as every other brain', async () => {
  closeEventLog();
  resetEventLog();
  resetMemoryDb();
  setClaudeAgentSdkBrainUnifiedPrimerForTest(async (query) => ({
    objective: query,
    hits: [],
    perStore: {},
    answerability: 'insufficient',
    diagnostics: { candidates: 0, stores: [], elapsedMs: 0 },
  }));

  let call = 0;
  const replies = [
    'Let’s compare a few easy vegetarian dinners before choosing.',
    'Black bean tacos would work well on Monday.',
    'We have tacos and a mild curry in consideration.',
  ];
  setClaudeAgentSdkBrainRunForTest(async () => ({
    text: replies[call++] ?? 'Still comparing meals.',
    sessionId: 'sdk-fixture',
    model: 'claude-sonnet-fixture',
    toolUses: [],
  }));

  const sessionId = 'claude-discord-meal-thread';
  for (const [index, message] of [
    'Help me compare easy vegetarian dinners for next week.',
    'What about black bean tacos on Monday?',
    'I like that, and I also want a mild curry.',
  ].entries()) {
    const response = await respondViaClaudeAgentSdkBrain('discord', {
      message,
      sessionId,
      channel: 'discord:meal-planning',
      userId: 'fixture-user',
      runId: `meal-turn-${index + 1}`,
    });
    assert.equal(response.stoppedReason, 'success');
    if (index < 2) assert.equal(getActiveFocus(), null, 'the harness lets the conversation breathe');
  }

  const focus = getActiveFocus();
  assert.ok(focus, 'the connected third turn is now resumable on the Claude lane');
  assert.equal(focus?.resource_ref, `session:${sessionId}`);
  assert.equal(focus?.related_session_id, sessionId);
  assert.equal(getFocusWorkstate(focus), null, 'continuity does not invent a workflow or plan');
});
