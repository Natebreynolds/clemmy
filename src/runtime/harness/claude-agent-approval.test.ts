import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-agent-approval-test-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });
process.env.CLEMMY_APPROVAL_POLL_MS = '15'; // fast poll for the test

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createSession } = await import('./eventlog.js');
const approvalRegistry = await import('./approval-registry.js');
const { buildGatedToolPermission } = await import('./claude-agent-approval.js');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const opts = (): unknown => ({ signal: new AbortController().signal, toolUseID: 't' });
type Perm = (name: string, input: Record<string, unknown>, o: unknown) => Promise<{ behavior: string; message?: string }>;

async function waitForPending(sessionId: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const rows = approvalRegistry.listPending({ sessionId });
    if (rows.length > 0) return rows[0].approvalId;
    await sleep(10);
  }
  throw new Error('approval was never registered');
}

test('gated permission: read/local tools fast-allow, no approval registered', async () => {
  const sess = createSession({ kind: 'chat' });
  const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
  const res = await perm('mcp__clementine-local__memory_read', {}, opts());
  assert.equal(res.behavior, 'allow');
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 0, 'a read never registers an approval');
});

test('gated permission: a mutating tool registers + AWAITS + ALLOWS on approve', async () => {
  const sess = createSession({ kind: 'chat' });
  const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
  const p = perm('mcp__clementine-local__run_shell_command', { command: 'echo hi' }, opts());
  const approvalId = await waitForPending(sess.id);
  // The permission promise is still pending (awaiting the human) until we resolve.
  approvalRegistry.resolve(approvalId, 'approved', 'test');
  const res = await p;
  assert.equal(res.behavior, 'allow', 'approve → allow');
});

test('gated permission: DENIES on reject', async () => {
  const sess = createSession({ kind: 'chat' });
  const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
  const p = perm('mcp__clementine-local__run_shell_command', { command: 'echo hi' }, opts());
  const approvalId = await waitForPending(sess.id);
  approvalRegistry.resolve(approvalId, 'rejected', 'test');
  const res = await p;
  assert.equal(res.behavior, 'deny', 'reject → deny');
});

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
});
