/**
 * Run: npx tsx --test src/execution/approval-replay.test.ts
 *
 * The approve→re-ask treadmill fix (2026-07-21): on re-admission the harness
 * claims the session's resolved-approved unconsumed approval and executes the
 * APPROVED payload verbatim — the model never re-composes an approved send.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-approval-replay-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const reg = await import('../runtime/harness/approval-registry.js');
const { createSession, getToolOutput, closeEventLog } = await import('../runtime/harness/eventlog.js');
const {
  replayApprovedActionForSession,
  renderApprovedReplayNote,
  setApprovalReplayDispatchForTest,
} = await import('./approval-replay.js');

test.after(() => {
  try { closeEventLog(); } catch { /* best effort */ }
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('replays the exact approved payload once and records a durable result', async () => {
  const session = createSession({ id: 'sess-replay-exec', kind: 'workflow' });
  const row = reg.register({
    sessionId: session.id,
    subject: 'Run SLACK_SEND_MESSAGE?',
    tool: 'composio_execute_tool',
    args: {
      tool_slug: 'SLACK_SEND_MESSAGE',
      arguments: '{"channel":"C0TEST","markdown_text":"*Team Update*"}',
      connected_account_id: 'ca_123',
    },
  });
  reg.resolve(row.approvalId, 'approved', 'unit-test-human');

  const dispatched: Array<{ slug: string; args: Record<string, unknown>; account?: string }> = [];
  setApprovalReplayDispatchForTest(async (slug, args, opts) => {
    dispatched.push({ slug, args, account: opts.connectedAccountId });
    return { ok: true, result: { ts: '1' } };
  });
  try {
    const outcome = await replayApprovedActionForSession(session.id);
    assert.ok(outcome);
    assert.equal(outcome?.ok, true);
    assert.equal(outcome?.toolSlug, 'SLACK_SEND_MESSAGE');
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0].args, { channel: 'C0TEST', markdown_text: '*Team Update*' });
    assert.equal(dispatched[0].account, 'ca_123');

    // Durable audit: the replay result is recallable like any tool output.
    const stored = getToolOutput(session.id, `approval-replay-${row.approvalId}`);
    assert.ok(stored?.output.includes('ts'));

    // The prompt note tells the model the action is DONE.
    const note = renderApprovedReplayNote(outcome!);
    assert.match(note, /ALREADY EXECUTED/);
    assert.match(note, /Do NOT run or re-propose/);

    // One-shot: a second re-admission has nothing to replay.
    assert.equal(await replayApprovedActionForSession(session.id), null);
  } finally {
    setApprovalReplayDispatchForTest(null);
  }
});

test('a failed replay reports honestly and never claims success', async () => {
  const session = createSession({ id: 'sess-replay-fail', kind: 'workflow' });
  const row = reg.register({
    sessionId: session.id,
    subject: 'Run SLACK_SEND_MESSAGE?',
    tool: 'composio_execute_tool',
    args: { tool_slug: 'SLACK_SEND_MESSAGE', arguments: '{"channel":"C0TEST"}' },
  });
  reg.resolve(row.approvalId, 'approved', 'unit-test-human');
  setApprovalReplayDispatchForTest(async () => { throw new Error('channel_not_found'); });
  try {
    const outcome = await replayApprovedActionForSession(session.id);
    assert.equal(outcome?.ok, false);
    assert.match(outcome!.resultText, /channel_not_found/);
    const note = renderApprovedReplayNote(outcome!);
    assert.match(note, /FAILED/);
    assert.match(note, /Do NOT silently retry/);
  } finally {
    setApprovalReplayDispatchForTest(null);
  }
});

test('sessions with nothing approved are a no-op', async () => {
  const session = createSession({ id: 'sess-replay-noop', kind: 'workflow' });
  assert.equal(await replayApprovedActionForSession(session.id), null);
});
