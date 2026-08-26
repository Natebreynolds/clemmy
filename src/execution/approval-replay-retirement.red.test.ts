/**
 * Run: npx tsx --test src/execution/approval-replay-retirement.red.test.ts
 *
 * Crash containment for the retired legacy approval replay lane. A serialized
 * SDK interruption can disappear across a process restart. The remaining
 * session-wide approval row is not an accepted-source or provider-dispatch
 * capability, so the no-blob resume path must stop before it consumes that row
 * or invokes a provider body.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-approval-replay-retirement-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '@openai/agents';

const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const { closeEventLog, listEvents } = await import('../runtime/harness/eventlog.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const { resumePendingApproval } = await import('../runtime/harness/loop.js');
const { setApprovalReplayDispatchForTest } = await import('./approval-replay.js');

test.after(() => {
  setApprovalReplayDispatchForTest(null);
  try { closeEventLog(); } catch { /* best effort */ }
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('restart with no interrupt blob fails closed before approval claim or provider body', async () => {
  const session = HarnessSession.create({ kind: 'workflow', title: 'lost SDK interrupt' });
  assert.equal(session.loadInterruptState(), null, 'fixture is the post-crash no-blob state');

  const approval = approvalRegistry.register({
    sessionId: session.id,
    subject: 'Send the exact stored Slack message?',
    tool: 'composio_execute_tool',
    args: {
      tool_slug: 'SLACK_SEND_MESSAGE',
      arguments: JSON.stringify({ channel: 'C0CRASH', markdown_text: 'restart proof' }),
      connected_account_id: 'ca_crash_fixture',
    },
  });
  assert.equal(
    approvalRegistry.resolve(approval.approvalId, 'approved', 'restart-fixture-human').ok,
    true,
  );

  let providerBodies = 0;
  setApprovalReplayDispatchForTest(async () => {
    providerBodies += 1;
    return { ok: true, result: { ts: 'must-not-exist' } };
  });

  const agent = new Agent({ name: 'ApprovalReplayRetirement', instructions: 'fixture' });
  const [first, racingDuplicate] = await Promise.all([
    resumePendingApproval({
      agent,
      sessionId: session.id,
      approvalId: approval.approvalId,
      decision: 'approve',
    }),
    resumePendingApproval({
      agent,
      sessionId: session.id,
      approvalId: approval.approvalId,
      decision: 'approve',
    }),
  ]);

  assert.equal(first.status, 'completed');
  assert.equal(racingDuplicate.status, 'completed');
  assert.equal(providerBodies, 0, 'the retired replay lane cannot invoke a provider body');
  assert.equal(
    approvalRegistry.get(approval.approvalId)?.consumedAt,
    null,
    'containment happens before the legacy session-wide approval claim',
  );
  assert.equal(
    listEvents(session.id, { types: ['tool_called', 'tool_returned'] })
      .filter((event) => event.data.source === 'approval-replay').length,
    0,
    'no fake provider lifecycle is emitted for a body that never started',
  );
  const containment = listEvents(session.id, { types: ['guardrail_tripped'] })
    .filter((event) => event.data.kind === 'legacy_approval_replay_retired');
  assert.equal(containment.length, 2, 'each racing no-blob resume records its fail-closed boundary');
  assert.ok(containment.every((event) => event.data.approvalId === approval.approvalId));
  assert.equal(
    listEvents(session.id, { types: ['user_input_received'] })
      .filter((event) => event.data.source === 'approval-replay').length,
    0,
    'containment never injects a false harness-executed result into the next model turn',
  );
});
