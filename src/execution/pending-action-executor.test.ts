/**
 * Run: npx tsx --test src/execution/pending-action-executor.test.ts
 *
 * P0c: an APPROVED single-call pending action fires the EXACT stored payload
 * server-side (the model can't swap it), records the outcome, and gates on
 * approval / run_batch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-pae-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { queuePendingAction, markPendingActionApprovalResolved, getPendingAction } = await import('../runtime/harness/pending-actions.js');
const { executeApprovedPendingActionCall } = await import('./pending-action-executor.js');
const { createSession } = await import('../runtime/harness/eventlog.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

/** B4 (2026-07-20): human-consent claims are VERIFIED against the registry, so
 *  these tests mint REAL approved cards (a fabricated id would be refuted). */
function realApprovedCardId(subject: string): string {
  const sess = createSession({ kind: 'chat' });
  const card = approvalRegistry.register({ sessionId: sess.id, subject, tool: 'composio_execute_tool', args: {} });
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
  markPendingActionApprovalResolved(record.id, 'approved', realApprovedCardId('single call'));

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
});

test('a NOT-approved pending action is not executed', async () => {
  const record = queueSingleCall(); // status stays 'queued'
  let fired = false;
  const res = await executeApprovedPendingActionCall(record.id, { dispatch: async () => { fired = true; return 'x'; } });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'skipped');
  assert.equal(fired, false, 'never dispatched without approval');
});

test('a run_batch pending action defers to the run_batch executor', async () => {
  const record = queuePendingAction({
    title: 'Batch send', summary: 'run_batch plan', kind: 'external_send',
    toolName: 'run_batch', payload: { tool: 'composio_execute_tool', items: [] }, sessionId: 'sess-pae',
  });
  // Human card consent — this test is about the run_batch deferral, and an
  // irreversible send without human consent is now refused before it (I1).
  markPendingActionApprovalResolved(record.id, 'approved', realApprovedCardId('batch defer'));
  let fired = false;
  const res = await executeApprovedPendingActionCall(record.id, { dispatch: async () => { fired = true; return 'x'; } });
  assert.equal(res.status, 'skipped');
  assert.equal(fired, false, 'run_batch is not fired by the single-call executor');
  assert.match(res.resultSummary, /run_batch action=execute/);
});

test('a gate-refused dispatch is recorded FAILED, never executed (2026-07-22 false-success class)', async () => {
  const { dispatchOutputIndicatesRefusal } = await import('./pending-action-executor.js');
  // The live shape: constraint block RETURNED as a string, provider never called.
  const record = queueSingleCall();
  markPendingActionApprovalResolved(record.id, 'approved', realApprovedCardId('blocked call'));
  const res = await executeApprovedPendingActionCall(record.id, {
    sessionId: 'sess-pae',
    dispatch: async () => '[provider-dispatch:not-started:constraint]\n🛑 SEND BLOCKED — standing sender constraint enforced. Nothing was sent.',
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 'failed');
  assert.match(res.resultSummary, /refused/i);
  assert.equal(getPendingAction(record.id)?.status, 'failed', 'the durable record tells the truth');
  assert.match(getPendingAction(record.id)?.resultSummary ?? '', /SEND BLOCKED|refused/i);

  // Classifier boundaries: genuine results never match; refusal shapes always do.
  assert.equal(dispatchOutputIndicatesRefusal('{"successful": true, "data": {"message": "Email sent successfully."}}'), false);
  assert.equal(dispatchOutputIndicatesRefusal('OK sent'), false);
  assert.equal(dispatchOutputIndicatesRefusal('Tool call refused by harness: DUPLICATE_EXTERNAL_WRITE (REFUSED): already sent'), true);
  assert.equal(dispatchOutputIndicatesRefusal('[provider-dispatch:not-started:execution_wrap]'), true);
  // A provider message that merely MENTIONS a block deep in content stays success.
  assert.equal(dispatchOutputIndicatesRefusal('{"data": {"text": "' + 'x'.repeat(700) + ' SEND BLOCKED — standing sender constraint"}}'), false);
});
