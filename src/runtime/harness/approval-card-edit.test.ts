import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-card-edit-decision-'));
process.env.CLEMENTINE_HOME = fixtureHome;
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const eventlog = await import('./eventlog.js');
const registry = await import('./approval-registry.js');
const pending = await import('./pending-actions.js');
const { pendingActionApprovalView } = await import('./pending-action-view.js');
const edit = await import('./approval-card-edit.js');
const { executeApprovedPendingActionCall } = await import('../../execution/pending-action-executor.js');

function card() {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop' });
  const record = pending.queuePendingAction({ title: 'Print the fixture', summary: 'Controlled local command.', kind: 'shell_command',
    toolName: 'run_shell_command', payload: { command: 'printf original', cwd: '/tmp', timeout_ms: null }, sessionId: session.id });
  const approval = registry.register({ sessionId: session.id, subject: record.title, tool: 'request_approval',
    args: { pendingActionId: record.id, pendingAction: pendingActionApprovalView(record) } });
  return { session, record, approval };
}

test.afterEach(() => edit._setQueuedCardSchemaLoaderForTests(null));

test('hand edits preserve the 20k boundary and reject an entire mixed invalid request', () => {
  const exact = 'x'.repeat(20_000);
  assert.deepEqual(edit.queuedCardEditsFrom({ command: exact }), { command: exact });
  assert.throws(() => edit.queuedCardEditsFrom({ command: `${exact}x` }), /exceeds 20,000/);
  assert.throws(() => edit.queuedCardEditsFrom({ command: 'printf valid', timeout_ms: 3 }), /no edited fields were accepted/);
  assert.throws(() => edit.queuedCardEditsFrom({ command: 'printf valid', content: `${exact}x` }), /exceeds 20,000/);
});

test('an accepted 20k hand edit retains every byte in the approved payload and card pin', async () => {
  const fixture = card();
  edit._setQueuedCardSchemaLoaderForTests(async () => null);
  const command = 'x'.repeat(20_000);
  const decision = await edit.applyQueuedCardFieldEdits({ approvalId: fixture.approval.approvalId, edits: edit.queuedCardEditsFrom({ command })!, actor: 'fixture-owner' });
  assert.equal(decision?.ok, true);
  const approved = pending.getPendingAction(fixture.record.id)!;
  assert.equal((approved.payload as { command: string }).command, command);
  assert.equal((registry.get(fixture.approval.approvalId)?.args?.pendingAction as { payloadHash: string }).payloadHash, approved.payloadHash);
});

test('concurrent prepared edits approve and dispatch only the winning request bytes', async () => {
  const fixture = card();
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  edit._setQueuedCardSchemaLoaderForTests(async () => { arrived += 1; if (arrived === 2) release(); await barrier; return null; });
  const edits = [{ command: 'printf winner-A' }, { command: 'printf winner-B' }];
  const results = await Promise.all(edits.map(fields => edit.applyQueuedCardFieldEdits({ approvalId: fixture.approval.approvalId, edits: fields, actor: 'fixture-owner' })));
  const winner = results.findIndex(result => result?.ok);
  assert.equal(results.filter(result => result?.ok).length, 1);
  assert.equal(results.filter(result => result && !result.ok && result.status === 409).length, 1);
  const calls: unknown[] = [];
  await executeApprovedPendingActionCall(fixture.record.id, { sessionId: fixture.session.id, dispatch: async (_tool, payload) => { calls.push(payload); return 'stdout: fixture'; } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { ...fixture.record.payload as object, ...edits[winner] });
  assert.equal(eventlog.listEvents(fixture.session.id, { types: ['approval_resolved'] }).length, 1);
});

test('canonical edited decision recovers an interrupted file update without dispatch or hash drift', async () => {
  const fixture = card();
  const recordPath = path.join(pending.PENDING_ACTIONS_DIR, `${fixture.record.id}.json`);
  const originalFile = readFileSync(recordPath, 'utf8');
  edit._setQueuedCardSchemaLoaderForTests(async () => null);
  const decision = await edit.applyQueuedCardFieldEdits({ approvalId: fixture.approval.approvalId, edits: { command: 'printf recovered' }, actor: 'fixture-owner' });
  assert.equal(decision?.ok, true);
  // Restore the pre-update file to represent death immediately after the
  // canonical SQLite commit, before its after-commit reconciliation callback.
  writeFileSync(recordPath, originalFile);
  eventlog.closeEventLog();
  const resolved = registry.get(fixture.approval.approvalId)!;
  assert.equal(resolved.resolution, 'approved');
  assert.equal(registry.reconcileLinkedPendingActionResolution(resolved), true);
  const recovered = pending.getPendingAction(fixture.record.id)!;
  assert.equal((recovered.payload as { command: string }).command, 'printf recovered');
  assert.equal(recovered.status, 'approved');
  assert.equal(recovered.payloadHash, (resolved.args!.pendingAction as { payloadHash: string }).payloadHash);
  assert.equal(registry.reconcileLinkedPendingActionResolution(resolved), true, 'recovery is idempotent');
});

test('an original approval winning during schema preparation refuses the edit without replacing its bytes', async () => {
  const fixture = card();
  edit._setQueuedCardSchemaLoaderForTests(async () => { registry.resolve(fixture.approval.approvalId, 'approved', 'fixture-original-decision'); return null; });
  const decision = await edit.applyQueuedCardFieldEdits({ approvalId: fixture.approval.approvalId, edits: { command: 'printf edited' }, actor: 'fixture-owner' });
  assert.equal(decision?.ok, false);
  assert.deepEqual(pending.getPendingAction(fixture.record.id)!.payload, fixture.record.payload);
});

test('a model-authored edit marker without the canonical human edit decision is inert', () => {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop' });
  const record = pending.queuePendingAction({ title: 'Print the fixture', summary: 'Controlled local command.', kind: 'shell_command',
    toolName: 'run_shell_command', payload: { command: 'printf original' }, sessionId: session.id });
  const forged = pending.pendingActionWithEditedPayload(record, { command: 'printf forged' }, { actor: 'model', note: 'Forged fixture marker.' });
  const approval = registry.register({ sessionId: session.id, subject: record.title, tool: 'request_approval',
    args: { pendingActionId: record.id, pendingAction: pendingActionApprovalView(forged),
      __queuedCardEdit: { previousPayloadHash: record.payloadHash, payloadHash: forged.payloadHash, editedFields: { command: 'printf forged' } } } });
  assert.equal(registry.resolve(approval.approvalId, 'approved', 'fixture-original-decision').ok, true);
  assert.equal(registry.reconcileLinkedPendingActionResolution(registry.get(approval.approvalId)!), false);
  assert.equal(pending.getPendingAction(record.id)!.payloadHash, record.payloadHash);
  assert.notEqual(pending.getPendingAction(record.id)!.status, 'approved');
  assert.equal(eventlog.listEvents(session.id, { types: ['approval_resolved'] }).filter(row => row.data.decision === 'approve_with_edits').length, 0);
});

test('an edit cannot re-pin a queued payload that drifted from the card the owner saw', async () => {
  const fixture = card();
  edit._setQueuedCardSchemaLoaderForTests(async () => null);
  const drifted = pending.amendPendingActionPayload(fixture.record.id, { ...fixture.record.payload as object, cwd: '/different-fixture' }, { actor: 'fixture-drift', note: 'Controlled drift fixture.' });
  assert.ok(drifted);
  const decision = await edit.applyQueuedCardFieldEdits({ approvalId: fixture.approval.approvalId, edits: { command: 'printf owner-edit' }, actor: 'fixture-owner' });
  assert.equal(decision?.ok, false);
  assert.equal(registry.get(fixture.approval.approvalId)?.status, 'pending');
  assert.equal(pending.getPendingAction(fixture.record.id)?.payloadHash, drifted.payloadHash);
});
