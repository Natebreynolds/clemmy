/**
 * Run: npx tsx --test src/runtime/harness/reaper.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-reaper-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const reaper = await import('./reaper.js');
const reg = await import('./approval-registry.js');
const { createSession, closeEventLog, openEventLog, updateSession } = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { listNotifications } = await import('../notifications.js');

test.beforeEach(() => {
  const db = openEventLog();
  db.prepare('DELETE FROM pending_approvals').run();
});

test.after(() => {
  reaper.stopApprovalReaper();
  try { closeEventLog(); } catch { /* best effort */ }
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('reapOnce expires past-due approvals and returns them', async () => {
  const session = createSession({ kind: 'chat' });
  const row = reg.register({
    sessionId: session.id,
    subject: 'expire soon',
    ttlMs: 5,
  });
  await new Promise((r) => setTimeout(r, 20));

  const expired = reaper.reapOnce();
  assert.ok(expired.some((e) => e.approvalId === row.approvalId));
  const refetched = reg.get(row.approvalId);
  assert.equal(refetched?.status, 'expired');
});

test('reapOnce clears session interrupt state when an approval expires', async () => {
  const sessionRow = createSession({ kind: 'chat' });
  const session = HarnessSession.load(sessionRow.id)!;
  session.saveInterruptState('{"fake":"sdk state"}');
  assert.ok(session.loadInterruptState(), 'precondition: interrupt state set');

  reg.register({ sessionId: sessionRow.id, subject: 'will expire', ttlMs: 5 });
  await new Promise((r) => setTimeout(r, 20));
  reaper.reapOnce();

  // Reload — markStatus / clearInterruptState write to DB
  const refreshed = HarnessSession.load(sessionRow.id)!;
  assert.equal(refreshed.loadInterruptState(), null);
  assert.equal(refreshed.sessionRow.status, 'cancelled');
});

test('expiring a durable Workspace runner decision does not cancel its Workspace session', async () => {
  const sessionRow = createSession({ id: 'space-durable-runner-expiry', kind: 'chat' });
  const row = reg.register({
    sessionId: sessionRow.id,
    subject: 'Review exact Workspace runner',
    tool: 'space_trust_data_runner',
    ttlMs: 5,
  });
  await new Promise((r) => setTimeout(r, 20));

  reaper.reapOnce();

  assert.equal(reg.get(row.approvalId)?.status, 'expired');
  assert.equal(HarnessSession.load(sessionRow.id)?.sessionRow.status, 'active');
  const note = listNotifications(50).find((item) =>
    (item.metadata as { approvalId?: string } | undefined)?.approvalId === row.approvalId);
  assert.ok(note);
  assert.doesNotMatch(note.body, /session was cancelled/i);
  assert.match(note.body, /runner remains blocked|refresh/i);
});

test('reapOnce posts a user notification per expiry', async () => {
  const session = createSession({ kind: 'chat' });
  const row = reg.register({
    sessionId: session.id,
    subject: 'Save salesforce rule to memory',
    ttlMs: 5,
  });
  await new Promise((r) => setTimeout(r, 20));
  reaper.reapOnce();

  const notes = listNotifications(50);
  const mine = notes.filter((n) =>
    (n.metadata as { approvalId?: string } | undefined)?.approvalId === row.approvalId,
  );
  assert.equal(mine.length, 1);
  assert.equal(mine[0].title, 'Approval expired');
  assert.match(mine[0].body, /Save salesforce rule to memory/);
});

test('reapOnce is idempotent — calling twice does not re-expire or re-notify', async () => {
  const session = createSession({ kind: 'chat' });
  const row = reg.register({ sessionId: session.id, subject: 'idempotent', ttlMs: 5 });
  await new Promise((r) => setTimeout(r, 20));

  const first = reaper.reapOnce();
  const second = reaper.reapOnce();
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);

  const notes = listNotifications(50).filter((n) =>
    (n.metadata as { approvalId?: string } | undefined)?.approvalId === row.approvalId,
  );
  assert.equal(notes.length, 1);
});

test('reapOnce skips approvals that are still in their TTL window', () => {
  const session = createSession({ kind: 'chat' });
  reg.register({ sessionId: session.id, subject: 'still fresh', ttlMs: 60_000 });
  const expired = reaper.reapOnce();
  assert.equal(expired.length, 0);
});

test('dead-session reap preserves exact Workspace runner decisions but still cancels ordinary orphans', () => {
  const session = createSession({ kind: 'chat' });
  const trust = reg.register({
    sessionId: session.id,
    subject: 'Review exact Workspace runner',
    tool: 'space_trust_data_runner',
    ttlMs: 10 * 60_000,
  });
  const ordinary = reg.register({
    sessionId: session.id,
    subject: 'Ordinary orphan',
    tool: 'some_write_tool',
    ttlMs: 10 * 60_000,
  });
  updateSession(session.id, { status: 'cancelled' });
  openEventLog().prepare(
    'UPDATE pending_approvals SET requested_at = ? WHERE approval_id IN (?, ?)',
  ).run('2000-01-01T00:00:00.000Z', trust.approvalId, ordinary.approvalId);

  reaper.reapOnce();

  assert.equal(reg.get(trust.approvalId)?.status, 'pending');
  assert.equal(reg.get(ordinary.approvalId)?.status, 'resolved');
  assert.equal(reg.get(ordinary.approvalId)?.resolution, 'cancelled_by_user');
});

test('startApprovalReaper is idempotent — second start is a no-op', () => {
  const stop1 = reaper.startApprovalReaper({ tickMs: 60_000 });
  const stop2 = reaper.startApprovalReaper({ tickMs: 60_000 });
  // Both should return disposer functions (test that calling twice
  // doesn't throw + leaves the timer alive).
  assert.equal(typeof stop1, 'function');
  assert.equal(typeof stop2, 'function');
  stop1();
  // Second disposer is a no-op since the first already stopped.
  stop2();
});

test('startApprovalReaper sweeps stale approvals immediately on startup', async () => {
  const session = createSession({ kind: 'chat' });
  const row = reg.register({ sessionId: session.id, subject: 'stale on boot', ttlMs: 5 });
  await new Promise((r) => setTimeout(r, 20));

  const stop = reaper.startApprovalReaper({ tickMs: 60_000 });
  stop();

  assert.equal(reg.get(row.approvalId)?.status, 'expired');
});
