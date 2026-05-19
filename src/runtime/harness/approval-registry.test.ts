/**
 * Run: npx tsx --test src/runtime/harness/approval-registry.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-approval-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const reg = await import('./approval-registry.js');
const { createSession, closeEventLog, openEventLog } = await import('./eventlog.js');

test.beforeEach(() => {
  // Tests share one DB across the file; wipe the registry rows so each
  // test starts from a known state instead of inheriting leftovers from
  // prior tests. The sessions stay (cheap, FK target for the registry).
  const db = openEventLog();
  db.prepare('DELETE FROM pending_approvals').run();
});

test.after(() => {
  try { closeEventLog(); } catch { /* best effort */ }
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('register returns a row with an apr- prefixed id and pending status', () => {
  const session = createSession({ kind: 'chat' });
  const row = reg.register({
    sessionId: session.id,
    subject: 'Save Salesforce CLI rule to memory',
    tool: 'request_approval',
    args: { destructive: false },
    channel: 'discord',
    channelId: 'C1',
  });
  assert.match(row.approvalId, /^apr-[a-z0-9]{4}$/);
  assert.equal(row.sessionId, session.id);
  assert.equal(row.subject, 'Save Salesforce CLI rule to memory');
  assert.equal(row.status, 'pending');
  assert.equal(row.channel, 'discord');
  assert.equal(row.channelId, 'C1');
  assert.deepEqual(row.args, { destructive: false });
});

test('get returns the registered row by id', () => {
  const session = createSession({ kind: 'chat' });
  const registered = reg.register({ sessionId: session.id, subject: 'test' });
  const fetched = reg.get(registered.approvalId);
  assert.ok(fetched);
  assert.equal(fetched.approvalId, registered.approvalId);
  assert.equal(fetched.subject, 'test');
});

test('listPending filters by session and channel', () => {
  const sA = createSession({ kind: 'chat' });
  const sB = createSession({ kind: 'chat' });
  reg.register({ sessionId: sA.id, subject: 'one', channelId: 'C1' });
  reg.register({ sessionId: sA.id, subject: 'two', channelId: 'C2' });
  reg.register({ sessionId: sB.id, subject: 'three', channelId: 'C1' });

  const bySessionA = reg.listPending({ sessionId: sA.id });
  assert.equal(bySessionA.length, 2);

  const byChannelC1 = reg.listPending({ channelId: 'C1' });
  // Includes rows from both sessions, only the C1 ones.
  assert.equal(byChannelC1.length, 2);
  assert.ok(byChannelC1.every((row) => row.channelId === 'C1'));
});

test('hasPending is true while there is at least one pending row for the session', () => {
  const session = createSession({ kind: 'chat' });
  assert.equal(reg.hasPending(session.id), false);

  const r = reg.register({ sessionId: session.id, subject: 'pending check' });
  assert.equal(reg.hasPending(session.id), true);

  reg.resolve(r.approvalId, 'approved', 'unit-test');
  assert.equal(reg.hasPending(session.id), false);
});

test('resolve is atomic — only one of two racing resolves wins', () => {
  const session = createSession({ kind: 'chat' });
  const r = reg.register({ sessionId: session.id, subject: 'race' });

  const first = reg.resolve(r.approvalId, 'approved', 'user-A');
  const second = reg.resolve(r.approvalId, 'rejected', 'user-B');

  assert.equal(first.ok, true);
  assert.equal(first.row?.resolution, 'approved');
  assert.equal(first.row?.resolver, 'user-A');

  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already_resolved');
  // Second's row reflects the winning resolution.
  assert.equal(second.row?.resolution, 'approved');
});

test('resolve reports not_found for unknown ids', () => {
  const result = reg.resolve('apr-xxxx', 'approved', 'whoever');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
});

test('expireStaleApprovals marks past-due rows expired and returns them', async () => {
  const session = createSession({ kind: 'chat' });
  // 5ms TTL — guaranteed expired on the next reaper tick.
  const r = reg.register({ sessionId: session.id, subject: 'will expire', ttlMs: 5 });

  // Wait for the TTL to elapse.
  await new Promise((res) => setTimeout(res, 20));

  const expired = reg.expireStaleApprovals(new Date());
  assert.ok(expired.some((row) => row.approvalId === r.approvalId));
  assert.equal(expired.find((row) => row.approvalId === r.approvalId)?.resolution, 'expired');
  assert.equal(expired.find((row) => row.approvalId === r.approvalId)?.status, 'expired');

  // hasPending now returns false.
  assert.equal(reg.hasPending(session.id), false);
});

test('expireStaleApprovals is idempotent — second call is a no-op', async () => {
  const session = createSession({ kind: 'chat' });
  reg.register({ sessionId: session.id, subject: 'expire me', ttlMs: 5 });
  await new Promise((res) => setTimeout(res, 20));

  const firstPass = reg.expireStaleApprovals();
  const secondPass = reg.expireStaleApprovals();
  assert.ok(firstPass.length >= 1);
  assert.equal(secondPass.length, 0);
});

test('listPending status:any includes resolved rows for history', () => {
  const session = createSession({ kind: 'chat' });
  const r = reg.register({ sessionId: session.id, subject: 'will resolve' });
  reg.resolve(r.approvalId, 'approved', 'tester');

  const pending = reg.listPending({ sessionId: session.id, status: 'pending' });
  assert.equal(pending.find((row) => row.approvalId === r.approvalId), undefined);

  const all = reg.listPending({ sessionId: session.id, status: 'any' });
  assert.ok(all.some((row) => row.approvalId === r.approvalId));
});
