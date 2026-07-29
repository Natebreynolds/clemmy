/**
 * Run: npx tsx --test src/execution/pending-action-executor.test.ts
 *
 * P0c: an APPROVED single-call pending action fires the EXACT stored payload
 * server-side (the model can't swap it), records the outcome, and gates on
 * approval / run_batch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-pae-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  getPendingAction,
  markPendingActionApprovalResolved,
  pendingActionPayloadHash,
  queuePendingAction,
} = await import('../runtime/harness/pending-actions.js');
const { executeApprovedPendingActionCall } = await import('./pending-action-executor.js');
const { pendingActionApprovalView } = await import('../runtime/harness/pending-action-view.js');
const { createSession } = await import('../runtime/harness/eventlog.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));
createSession({ id: 'sess-pae', kind: 'chat' });

/** B4 (2026-07-20): human-consent claims are VERIFIED against the registry, so
 *  these tests mint REAL approved cards (a fabricated id would be refuted). */
function realApprovedCardId(
  record: ReturnType<typeof queuePendingAction>,
  subject: string,
): string {
  const card = approvalRegistry.register({
    sessionId: record.sessionId!,
    subject,
    tool: 'request_approval',
    args: {
      pendingActionId: record.id,
      pendingAction: pendingActionApprovalView(record),
    },
  });
  approvalRegistry.resolve(card.approvalId, 'approved', 'test');
  return card.approvalId;
}

function queueSingleCall() {
  return queuePendingAction({
    title: "Judge couldn't verify: c@firm.example",
    summary: 'goal-fidelity judge outage — queued for one-tap approval',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: { tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL', arguments: JSON.stringify({ to_email: 'c@firm.example', subject: 's', body: 'hello' }) },
    sessionId: 'sess-pae',
    createdBy: 'judge_fail_approval',
  });
}

test('approved single-call executes the EXACT stored payload via the dispatcher', async () => {
  const record = queueSingleCall();
  // Human card consent (I1): an external_send executes only on a real card
  // decision — grant-invariants.test.ts pins the policy-consent refusal.
  markPendingActionApprovalResolved(record.id, 'approved', realApprovedCardId(record, 'single call'));

  const dispatched: Array<{ toolName: string; payload: unknown; certifiedBatch: unknown }> = [];
  const res = await executeApprovedPendingActionCall(record.id, {
    sessionId: 'sess-pae',
    dispatch: async (toolName, payload, _sessionId, certifiedBatch) => {
      dispatched.push({ toolName, payload, certifiedBatch });
      return 'OK sent';
    },
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 'executed');
  assert.equal(dispatched.length, 1, 'fired exactly once');
  assert.equal(dispatched[0].toolName, 'composio_execute_tool', 'the exact stored tool');
  assert.deepEqual(dispatched[0].payload, record.payload, 'the byte-identical stored payload — not reconstructed');
  // The dispatch carries the payloadHash so the write boundary skips the (failed) judge.
  assert.equal((dispatched[0].certifiedBatch as { payloadHash?: string }).payloadHash, record.payloadHash);
  assert.equal(getPendingAction(record.id)?.status, 'executed', 'the card is marked executed');
  assert.match(res.resultSummary, /Authoritative tool result:\s*OK sent/, 'the caller can verify without a redundant pending_action_get');
  assert.match(res.resultSummary, /Outcome is already recorded.*Do not call pending_action_get or pending_action_record_result/);
});

test('a payload changed after approval is terminally refused before dispatch', async () => {
  const record = queueSingleCall();
  markPendingActionApprovalResolved(record.id, 'approved', realApprovedCardId(record, 'tamper proof'));
  const file = path.join(TMP_HOME, 'pending-actions', `${record.id}.json`);
  const tampered = JSON.parse(readFileSync(file, 'utf8')) as {
    payload: unknown;
    payloadHash: string;
  };
  tampered.payload = {
    tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    arguments: JSON.stringify({
      to_email: 'swapped@example.com',
      subject: 'changed after approval',
      body: 'must never dispatch',
    }),
  };
  writeFileSync(file, JSON.stringify(tampered), 'utf8');

  let dispatched = 0;
  const result = await executeApprovedPendingActionCall(record.id, {
    sessionId: 'sess-pae',
    dispatch: async () => {
      dispatched += 1;
      return 'must never happen';
    },
  });

  assert.equal(dispatched, 0, 'hash-mismatched approval authority never crosses the provider boundary');
  assert.equal(result.status, 'failed');
  assert.match(result.resultSummary, /integrity|payload hash|changed after approval/i);
  assert.equal(getPendingAction(record.id)?.status, 'failed', 'the corrupt grant is terminal, not retryable');
});

test('re-hashing a changed record cannot outrun the independent approval-card snapshot', async () => {
  const record = queueSingleCall();
  markPendingActionApprovalResolved(record.id, 'approved', realApprovedCardId(record, 'independent card proof'));
  const file = path.join(TMP_HOME, 'pending-actions', `${record.id}.json`);
  const tampered = JSON.parse(readFileSync(file, 'utf8')) as {
    toolName: string;
    payload: unknown;
    payloadHash: string;
  };
  tampered.payload = {
    tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    arguments: JSON.stringify({
      to_email: 'rehashed-swap@example.com',
      subject: 'changed and rehashed',
      body: 'must never dispatch',
    }),
  };
  tampered.payloadHash = pendingActionPayloadHash(tampered.toolName, tampered.payload);
  writeFileSync(file, JSON.stringify(tampered), 'utf8');

  let dispatched = 0;
  const result = await executeApprovedPendingActionCall(record.id, {
    sessionId: 'sess-pae',
    dispatch: async () => {
      dispatched += 1;
      return 'must never happen';
    },
  });

  assert.equal(dispatched, 0);
  assert.equal(result.status, 'failed');
  assert.match(result.resultSummary, /approval-authority|approval card|snapshot|does not pin/i);
  assert.equal(getPendingAction(record.id)?.status, 'failed');
});

test('five concurrent executors claim once, dispatch exactly once, and an executed retry stays inert', async () => {
  const record = queueSingleCall();
  markPendingActionApprovalResolved(record.id, 'approved', realApprovedCardId(record, 'concurrent single call'));

  let dispatchCount = 0;
  const dispatch = async () => {
    dispatchCount += 1;
    // Keep the winning attempt in EXECUTING long enough for every losing
    // Promise to observe the durable claim.
    await new Promise((resolve) => setTimeout(resolve, 25));
    return 'OK one authoritative send';
  };
  const results = await Promise.all(
    Array.from({ length: 5 }, () => executeApprovedPendingActionCall(record.id, {
      sessionId: 'sess-pae',
      dispatch,
    })),
  );

  assert.equal(dispatchCount, 1, 'the approved payload crossed the dispatcher exactly once');
  assert.equal(results.filter((result) => result.status === 'executed').length, 1, 'one caller owns the result');
  const losers = results.filter((result) => result.status === 'skipped');
  assert.equal(losers.length, 4, 'all concurrent losers are truthful skips');
  for (const loser of losers) {
    assert.match(loser.resultSummary, /execution claim|in progress|uncertain/i);
    assert.match(loser.resultSummary, /no second dispatch|not be retried automatically/i);
  }
  assert.equal(getPendingAction(record.id)?.status, 'executed');

  let retryDispatchCount = 0;
  const retry = await executeApprovedPendingActionCall(record.id, {
    sessionId: 'sess-pae',
    dispatch: async () => {
      retryDispatchCount += 1;
      return 'must never happen';
    },
  });
  assert.equal(retry.status, 'skipped');
  assert.equal(retryDispatchCount, 0, 'an executed action is never dispatched again');
  assert.match(retry.resultSummary, /already executed|must be APPROVED/i);
});

test('a NOT-approved pending action is not executed', async () => {
  const record = queueSingleCall(); // status stays 'queued'
  let fired = false;
  const res = await executeApprovedPendingActionCall(record.id, {
    sessionId: 'sess-pae',
    dispatch: async () => { fired = true; return 'x'; },
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'skipped');
  assert.equal(fired, false, 'never dispatched without approval');
});

test('an approved action cannot execute through a foreign or unscoped session owner', async () => {
  const record = queueSingleCall();
  markPendingActionApprovalResolved(record.id, 'approved', realApprovedCardId(record, 'owner-bound single call'));
  let fired = false;
  const foreign = await executeApprovedPendingActionCall(record.id, {
    sessionId: 'sess-foreign',
    dispatch: async () => { fired = true; return 'must never happen'; },
  });
  assert.equal(foreign.status, 'skipped');
  assert.match(foreign.resultSummary, /different session/i);
  assert.equal(fired, false);
  assert.equal(getPendingAction(record.id)?.status, 'approved', 'the real owner can still consume its grant');

  const omitted = await executeApprovedPendingActionCall(record.id, {
    dispatch: async () => { fired = true; return 'must never happen'; },
  });
  assert.equal(omitted.status, 'skipped');
  assert.match(omitted.resultSummary, /different session|session authority/i);
  assert.equal(fired, false, 'omitting owner authority cannot bypass the boundary');

  const legacy = queuePendingAction({
    title: 'Unscoped legacy action',
    summary: 'An active harness session must not inherit an unscoped action.',
    kind: 'external_write',
    toolName: 'proof__write',
    payload: { value: 'legacy' },
  });
  markPendingActionApprovalResolved(legacy.id, 'approved', null, {
    by: 'policy',
    evidence: { kind: 'policy', scope: 'test' },
  });
  const unscoped = await executeApprovedPendingActionCall(legacy.id, {
    sessionId: 'sess-active',
    dispatch: async () => { fired = true; return 'must never happen'; },
  });
  assert.equal(unscoped.status, 'skipped');
  assert.match(unscoped.resultSummary, /different session/i);
  assert.equal(fired, false);
});

test('a run_batch pending action defers to the run_batch executor', async () => {
  const record = queuePendingAction({
    title: 'Batch send', summary: 'run_batch plan', kind: 'external_send',
    toolName: 'run_batch', payload: { tool: 'composio_execute_tool', items: [] }, sessionId: 'sess-pae',
  });
  // Human card consent — this test is about the run_batch deferral, and an
  // irreversible send without human consent is now refused before it (I1).
  markPendingActionApprovalResolved(record.id, 'approved', realApprovedCardId(record, 'batch defer'));
  let fired = false;
  const res = await executeApprovedPendingActionCall(record.id, {
    sessionId: 'sess-pae',
    dispatch: async () => { fired = true; return 'x'; },
  });
  assert.equal(res.status, 'skipped');
  assert.equal(fired, false, 'run_batch is not fired by the single-call executor');
  assert.match(res.resultSummary, /run_batch action=execute/);
});

test('a mislabeled stored send still requires human approval at execution', async () => {
  const record = queuePendingAction({
    title: 'Mislabeled send',
    summary: 'The stored canonical call is an irreversible send.',
    kind: 'external_write',
    toolName: 'composio_execute_tool',
    payload: {
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: { to: 'proof@example.com', subject: 'Proof', body: 'Exact.' },
    },
    sessionId: 'sess-pae',
  });
  markPendingActionApprovalResolved(record.id, 'approved', null, {
    by: 'policy',
    evidence: { kind: 'policy', scope: 'test' },
  });
  let fired = false;
  const result = await executeApprovedPendingActionCall(record.id, {
    sessionId: 'sess-pae',
    dispatch: async () => { fired = true; return 'must never happen'; },
  });
  assert.equal(result.status, 'skipped');
  assert.match(result.resultSummary, /approved by POLICY/i);
  assert.equal(fired, false);
});

test('returned refusal marker is FAILED/uncertain, never proof of no provider commit', async () => {
  const { dispatchOutputIndicatesRefusal } = await import('./pending-action-executor.js');
  // A local gate commonly returns this shape, but a provider can echo the exact
  // same text. Returned prose therefore cannot authorize a replay.
  const record = queueSingleCall();
  markPendingActionApprovalResolved(record.id, 'approved', realApprovedCardId(record, 'blocked call'));
  const res = await executeApprovedPendingActionCall(record.id, {
    sessionId: 'sess-pae',
    dispatch: async () => '[provider-dispatch:not-started:constraint]\n🛑 SEND BLOCKED — standing sender constraint enforced. Nothing was sent.',
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'failed');
  assert.match(res.resultSummary, /text alone cannot prove|uncertain/i);
  assert.match(res.resultSummary, /no automatic retry is safe/i);
  assert.equal(getPendingAction(record.id)?.status, 'failed', 'the durable record tells the truth');
  assert.match(getPendingAction(record.id)?.resultSummary ?? '', /uncertain|no retry is safe/i);

  // Classifier detects the suspicious shape, but does not establish provenance.
  assert.equal(dispatchOutputIndicatesRefusal('{"successful": true, "data": {"message": "Email sent successfully."}}'), false);
  assert.equal(dispatchOutputIndicatesRefusal('OK sent'), false);
  assert.equal(dispatchOutputIndicatesRefusal('Tool call refused by harness: DUPLICATE_EXTERNAL_WRITE (REFUSED): already sent'), true);
  assert.equal(dispatchOutputIndicatesRefusal('[provider-dispatch:not-started:execution_wrap]'), true);
  // A provider message that merely MENTIONS a block deep in content stays success.
  assert.equal(dispatchOutputIndicatesRefusal('{"data": {"text": "' + 'x'.repeat(700) + ' SEND BLOCKED — standing sender constraint"}}'), false);
});

test('only a nominal local pre-dispatch error can prove an approved call never reached the provider', async () => {
  const { PendingActionPreDispatchError } = await import('./pending-action-executor.js');
  const record = queueSingleCall();
  markPendingActionApprovalResolved(record.id, 'approved', realApprovedCardId(record, 'local pre-dispatch refusal'));

  const res = await executeApprovedPendingActionCall(record.id, {
    sessionId: 'sess-pae',
    dispatch: async () => {
      throw new PendingActionPreDispatchError('local standing constraint refused before invoking dispatch');
    },
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 'failed');
  assert.match(res.resultSummary, /refused locally before the provider call started/i);
  assert.match(res.resultSummary, /No provider commit occurred/i);
  assert.equal(getPendingAction(record.id)?.status, 'failed');
});

test('a structured provider failure is recorded FAILED, never executed', async () => {
  const record = queueSingleCall();
  markPendingActionApprovalResolved(record.id, 'approved', realApprovedCardId(record, 'provider failed call'));

  const res = await executeApprovedPendingActionCall(record.id, {
    sessionId: 'sess-pae',
    dispatch: async () => ({
      success: false,
      error: 'provider rejected the request before creating the resource',
    }),
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 'failed');
  assert.match(res.resultSummary, /provider reported|provider rejected/i);
  assert.equal(getPendingAction(record.id)?.status, 'failed', 'the durable action must not claim a failed provider result executed');
  assert.match(getPendingAction(record.id)?.resultSummary ?? '', /provider rejected/i);
});
