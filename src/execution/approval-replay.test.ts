/**
 * Run: npx tsx --test src/execution/approval-replay.test.ts
 *
 * The legacy approve→re-admit replay lane is retired. A registry row records a
 * human decision but does not own an accepted source, logical call, physical
 * dispatch, or settlement. Even direct stale imports must remain body-free and
 * leave the approval unconsumed for honest recovery.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-approval-replay-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const reg = await import('../runtime/harness/approval-registry.js');
const { createSession, closeEventLog, listEvents } = await import('../runtime/harness/eventlog.js');
const {
  replayApprovedActionForSession,
  renderApprovedReplayNote,
  setApprovalReplayDispatchForTest,
} = await import('./approval-replay.js');

test.after(() => {
  try { closeEventLog(); } catch { /* best effort */ }
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('a stale direct replay import cannot claim an approval or invoke a provider body', async () => {
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

  let providerBodies = 0;
  setApprovalReplayDispatchForTest(async () => {
    providerBodies += 1;
    return { ok: true, result: { ts: '1' } };
  });
  try {
    const outcome = await replayApprovedActionForSession(session.id);
    assert.equal(outcome, null);
    assert.equal(providerBodies, 0);
    assert.equal(reg.get(row.approvalId)?.consumedAt, null);
    assert.equal(
      listEvents(session.id, { types: ['tool_called', 'tool_returned'] })
        .filter((event) => event.data.source === 'approval-replay').length,
      0,
    );
  } finally {
    setApprovalReplayDispatchForTest(null);
  }
});

test('the compatibility note cannot claim that the approved action executed', () => {
  const note = renderApprovedReplayNote({
    approvalId: 'apr-retired',
    toolSlug: 'SLACK_SEND_MESSAGE',
    ok: true,
    resultText: 'provider-looking success text',
  });
  assert.match(note, /NOT EXECUTED/);
  assert.doesNotMatch(note, /ALREADY EXECUTED/);
});

test('the retired module and no-blob loop contain no raw claim or Composio dispatch edge', () => {
  const replaySource = readFileSync(new URL('./approval-replay.ts', import.meta.url), 'utf8');
  const loopSource = readFileSync(new URL('../runtime/harness/loop.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(replaySource, /claimApprovedUnconsumedForSession\s*\(/);
  assert.doesNotMatch(replaySource, /dispatchComposioTool|composio-tools\.js/);
  assert.doesNotMatch(loopSource, /replayApprovedActionForSession\s*\(/);
});

test('sessions with nothing approved are a no-op', async () => {
  const session = createSession({ id: 'sess-replay-noop', kind: 'workflow' });
  assert.equal(await replayApprovedActionForSession(session.id), null);
});
