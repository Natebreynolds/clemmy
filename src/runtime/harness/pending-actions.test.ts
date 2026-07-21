/**
 * Run: npx tsx --test src/runtime/harness/pending-actions.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-pending-actions-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const pending = await import('./pending-actions.js');

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('queuePendingAction persists exact payload metadata and hashes', () => {
  const record = pending.queuePendingAction({
    title: 'Send proof email',
    summary: 'Send one fictional proof email after approval.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    targetSummary: 'proof@example.com',
    preview: 'Subject: Proof pending action',
    risk: 'Would send one email.',
    rollback: 'No undo for sent email.',
    sessionId: 'sess-pending-test',
    payload: {
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: { to: 'proof@example.com', subject: 'Proof pending action', body: 'Hello' },
    },
  });

  assert.match(record.id, /^pa-/);
  assert.equal(record.status, 'queued');
  assert.equal(record.toolName, 'composio_execute_tool');
  assert.equal(record.targetSummary, 'proof@example.com');
  assert.match(record.payloadHash, /^[a-f0-9]{16}$/);
  assert.match(record.idempotencyKey, /^[a-f0-9]{16}$/);

  const fetched = pending.getPendingAction(record.id);
  assert.equal(fetched?.payloadHash, record.payloadHash);
  assert.equal(pending.listPendingActions({ sessionId: 'sess-pending-test' }).length, 1);
});

test('approval and result transitions update status without losing history', () => {
  const record = pending.queuePendingAction({
    title: 'Publish proof',
    summary: 'Publish after approval.',
    kind: 'deployment',
    toolName: 'run_shell_command',
    payload: { command: 'npm run deploy' },
  });

  pending.linkPendingActionApproval(record.id, 'apr-1234');
  assert.equal(pending.getPendingAction(record.id)?.status, 'approval_requested');
  assert.equal(pending.getPendingAction(record.id)?.approvalId, 'apr-1234');

  pending.markPendingActionApprovalResolved(record.id, 'approved', 'apr-1234');
  assert.equal(pending.getPendingAction(record.id)?.status, 'approved');

  pending.recordPendingActionResult(record.id, 'executed', 'Deploy completed.');
  const done = pending.getPendingAction(record.id);
  assert.equal(done?.status, 'executed');
  assert.equal(done?.resultSummary, 'Deploy completed.');
  assert.ok((done?.history.length ?? 0) >= 4);
});

test('human approval provenance cannot be downgraded by later policy bookkeeping', async () => {
  const record = pending.queuePendingAction({
    title: 'Send approved proof',
    summary: 'Send after a real card decision.',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'proof@example.com' } },
  });

  // B4 (2026-07-20): the inferred human claim is now VERIFIED against the
  // registry, so this test uses a REAL approved card (a fabricated id would
  // correctly be refuted to policy — see the B4 tests below).
  const { createSession } = await import('./eventlog.js');
  const registryMod = await import('./approval-registry.js');
  const sess = createSession({ kind: 'chat' });
  const card = registryMod.register({ sessionId: sess.id, subject: 'send proof', tool: 'composio_execute_tool', args: {} });
  registryMod.resolve(card.approvalId, 'approved', 'test');

  pending.markPendingActionApprovalResolved(record.id, 'approved', card.approvalId);
  pending.markPendingActionApprovalResolved(record.id, 'approved', null, {
    by: 'policy',
    evidence: { kind: 'policy', scope: 'yolo' },
  });

  const approved = pending.getPendingAction(record.id);
  assert.equal(approved?.approvedBy, 'human');
  assert.deepEqual(approved?.approvalEvidence, { kind: 'card', approvalId: card.approvalId });
  assert.equal(approved?.approvalId, card.approvalId);
});

test('parsePendingActionPayloadJson rejects malformed JSON with a corrective message', () => {
  assert.throws(
    () => pending.parsePendingActionPayloadJson('{bad json'),
    /payloadJson must be valid JSON/,
  );
});

// ---------------------------------------------------------------------------
// THE-GRANT hardening (2026-07-20 audit B4): inferred human consent is
// VERIFIED against the registry — a dangling/rejected approvalId can never
// read back as human consent.
// ---------------------------------------------------------------------------
import { writeFileSync, mkdirSync } from 'node:fs';
const approvalRegistry = await import('./approval-registry.js');
const { PENDING_ACTIONS_DIR } = pending;

function writeLegacyRecord(id: string, approvalId: string | null): void {
  mkdirSync(PENDING_ACTIONS_DIR, { recursive: true });
  // A pre-consent-fields record: status approved, approvalId present, but NO
  // approvedBy/approvalEvidence — the legacy shape the inference covers.
  writeFileSync(path.join(PENDING_ACTIONS_DIR, `${id}.json`), JSON.stringify({
    id,
    title: 'legacy send',
    summary: 's',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: { x: 1 },
    payloadHash: 'h',
    idempotencyKey: 'k',
    targetSummary: 't',
    preview: 'p',
    risk: 'r',
    rollback: 'r',
    sessionId: null,
    createdBy: 'test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'approved',
    approvalId,
    resultSummary: null,
    history: [],
  }, null, 2));
}

test('B4: a DANGLING approvalId reads back as policy consent (inert for sends), never human', () => {
  writeLegacyRecord('pa_dangling', 'approval-that-never-existed');
  const record = pending.getPendingAction('pa_dangling');
  assert.ok(record);
  assert.equal(record!.approvedBy, 'policy', 'unverifiable consent claim is refuted');
  assert.deepEqual(record!.approvalEvidence, { kind: 'policy', scope: 'unverified-card:approval-that-never-existed' });
});

test('B4: a REJECTED card reads back as policy consent, never human', async () => {
  const { createSession } = await import('./eventlog.js');
  const sess = createSession({ kind: 'chat' });
  const row = approvalRegistry.register({ sessionId: sess.id, subject: 'send x', tool: 't', args: {} });
  approvalRegistry.resolve(row.approvalId, 'rejected', 'test');
  writeLegacyRecord('pa_rejected', row.approvalId);
  const record = pending.getPendingAction('pa_rejected');
  assert.equal(record!.approvedBy, 'policy', 'a rejected card is not consent');
});

test('B4: a genuinely APPROVED card verifies and reads back as human consent', async () => {
  const { createSession } = await import('./eventlog.js');
  const sess = createSession({ kind: 'chat' });
  const row = approvalRegistry.register({ sessionId: sess.id, subject: 'send y', tool: 't', args: {} });
  approvalRegistry.resolve(row.approvalId, 'approved', 'test');
  writeLegacyRecord('pa_real', row.approvalId);
  const record = pending.getPendingAction('pa_real');
  assert.equal(record!.approvedBy, 'human', 'a verified card keeps its human claim');
  assert.deepEqual(record!.approvalEvidence, { kind: 'card', approvalId: row.approvalId });
});

test('B4: markPendingActionApprovalResolved refutes an unverifiable card id at mint time', () => {
  const queued = pending.queuePendingAction({
    title: 'x', summary: 'x', kind: 'external_send', toolName: 't',
    targetSummary: 't', preview: 'p', risk: 'r', rollback: 'r', payload: {},
  });
  const updated = pending.markPendingActionApprovalResolved(queued.id, 'approved', 'no-such-card');
  assert.equal(updated!.approvedBy, 'policy', 'an approved resolution with a dangling card id cannot claim human');
});
