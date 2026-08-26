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
  assert.equal(reg.get(ordinary.approvalId)?.status, 'cancelled');
  assert.equal(reg.get(ordinary.approvalId)?.resolution, 'cancelled_by_system');
  assert.equal(reg.get(ordinary.approvalId)?.resolver, 'reaper-dead-session');
  const cleanupNote = listNotifications(50).find((item) => (
    item.metadata?.approvalId === ordinary.approvalId
    && item.metadata?.approvalResolution === 'cancelled_by_system'
  ));
  assert.ok(cleanupNote, 'desktop/mobile generic notification projection records the system outcome');
  assert.equal(cleanupNote.title, 'Approval closed with its ended session');
  assert.match(cleanupNote.body, /system cleanup, not a user decision/i);
  assert.doesNotMatch(cleanupNote.body, /expired without a reply/i);
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

// ── B7b regression pins (gauntlet 2026-08-26): the approval-reaper rescanned 5
// durably-held revoked invocations every 60s forever (108+ warns, still firing
// after the gauntlet) — recovery could neither settle nor abandon. Bounded
// rescans must give the permanently-held a terminal disposition: quarantined
// durably, surfaced ONCE, re-probed slowly instead of every tick.
test('permanently-held revoked invocations get a terminal disposition after bounded rescans (no eternal 60s scan)', () => {
  reaper.__recoveryTest__.reset();
  let sweeps = 0;
  const heldRecord = (id: string) => ({
    sessionId: 'sess-held', sourceUserSeq: 71310, logicalToolCallId: id,
    leaseScopeId: 'scope-a', leaseId: `lease-${id}`, status: 'held' as const,
    reason: 'Tool attempt could not settle durably (closed): accepted-turn call authority is conflict',
  });
  reaper.__recoveryTest__.setSweepForTests({
    sweep: () => {
      sweeps += 1;
      return { scanned: 2, settled: 0, held: 2, records: [heldRecord('call-a'), heldRecord('call-b')] };
    },
    candidateCount: () => 2,
  });

  const max = reaper.__recoveryTest__.maxRescans();
  for (let i = 0; i < max; i++) reaper.reapOnce();
  assert.equal(sweeps, max, 'every rescan up to the bound actually re-attempted recovery');
  assert.equal(reaper.__recoveryTest__.quarantinedKeys().length, 2, 'both permanently-held records were quarantined');

  const notes = listNotifications().filter((n) => n.id.startsWith('revoked-recovery-abandoned-'));
  assert.ok(notes.length >= 1, 'the terminal disposition was surfaced to the user');

  // Quarantined + no new candidates ⇒ the reaper stops re-attempting each tick.
  reaper.reapOnce();
  reaper.reapOnce();
  assert.equal(sweeps, max, 'no further recovery attempts while all held candidates are quarantined');

  // A NEW revoked candidate appears ⇒ the sweep resumes immediately.
  reaper.__recoveryTest__.setSweepForTests({
    sweep: () => {
      sweeps += 1;
      return { scanned: 3, settled: 0, held: 2, records: [heldRecord('call-a'), heldRecord('call-b')] };
    },
    candidateCount: () => 3,
  });
  reaper.reapOnce();
  assert.equal(sweeps, max + 1, 'a new candidate re-opens the recovery sweep despite the quarantine pause');
  reaper.__recoveryTest__.reset();
});

test('a quarantined record that finally settles is released from quarantine', () => {
  reaper.__recoveryTest__.reset();
  const held = {
    sessionId: 'sess-heal', sourceUserSeq: 9, logicalToolCallId: 'call-heal',
    leaseScopeId: 'scope-h', leaseId: 'lease-heal', status: 'held' as const, reason: 'conflict',
  };
  reaper.__recoveryTest__.setSweepForTests({
    sweep: () => ({ scanned: 1, settled: 0, held: 1, records: [held] }),
    candidateCount: () => 1,
  });
  for (let i = 0; i < reaper.__recoveryTest__.maxRescans(); i++) reaper.reapOnce();
  assert.equal(reaper.__recoveryTest__.quarantinedKeys().length, 1);

  reaper.__recoveryTest__.setSweepForTests({
    sweep: () => ({ scanned: 1, settled: 1, held: 0, records: [{ ...held, status: 'settled' as const, reason: undefined }] }),
    candidateCount: () => 1,
  });
  // Quarantine pauses the sweep; the slow re-probe (default hourly) is when a
  // healed record gets noticed — simulate that clock.
  reaper.reapOnce({ nowMs: Date.now() + 2 * 60 * 60_000 });
  assert.equal(reaper.__recoveryTest__.quarantinedKeys().length, 0, 'settlement clears the quarantine entry at the re-probe');
  reaper.__recoveryTest__.reset();
});

// ── B7a wiring: the periodic reaper OWNS the accepted-input liveness sweep and
// surfaces every terminalized silent session to the user.
test('reapOnce terminalizes a silent accepted-input session and notifies the user', async () => {
  reaper.__recoveryTest__.reset();
  reaper.__recoveryTest__.setSweepForTests({
    sweep: () => ({ scanned: 0, settled: 0, held: 0, records: [] }),
    candidateCount: () => 0,
  });
  const { appendEvent, claimRunAttemptLease, finishRunAttempt, getSession } = await import('./eventlog.js');
  const zombie = createSession({ id: 'sess-reaper-zombie-1', kind: 'chat', channel: 'desktop' });
  const claim = claimRunAttemptLease({ sessionId: zombie.id, runId: 'desktop:rz-1', ownerId: 'console-test', leaseMs: 60_000 });
  appendEvent({ sessionId: zombie.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'continue' } });
  if (claim.attempt) finishRunAttempt(claim.attempt, 'completed');

  reaper.reapOnce({ nowMs: Date.now() + 11 * 60_000 });

  assert.equal(getSession(zombie.id)?.status, 'failed', 'the silent session got its durable liveness terminal');
  const note = listNotifications().find((n) => n.id === `liveness-no-turn-${zombie.id}`);
  assert.ok(note, 'the silent no-reply was surfaced to the user, not just the ledger');
  reaper.__recoveryTest__.reset();
});
