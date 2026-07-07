import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-agent-approval-test-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });
process.env.CLEMMY_APPROVAL_POLL_MS = '15'; // fast poll for the test

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createSession, listEvents } = await import('./eventlog.js');
const approvalRegistry = await import('./approval-registry.js');
const { buildGatedToolPermission } = await import('./claude-agent-approval.js');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const opts = (): unknown => ({ signal: new AbortController().signal, toolUseID: 't' });
type Perm = (name: string, input: Record<string, unknown>, o: unknown) => Promise<{ behavior: string; message?: string; updatedInput?: Record<string, unknown> }>;

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
  const res = await perm('mcp__clementine-local__memory_read', { query: 'x' }, opts());
  assert.equal(res.behavior, 'allow');
  assert.deepEqual(res.updatedInput, { query: 'x' }, 'the CLI control protocol requires updatedInput on EVERY allow');
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 0, 'a read never registers an approval');
});

test('gated permission: tool_called event carries the SDK toolUseID for UI correlation', async () => {
  const sess = createSession({ kind: 'chat' });
  const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
  await perm('mcp__clementine-local__memory_read', { query: 'x' }, { signal: new AbortController().signal, toolUseID: 'toolu_visible_1' });

  const events = listEvents(sess.id, { types: ['tool_called'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.tool, 'memory_read');
  assert.equal(events[0].data.callId, 'toolu_visible_1');
});

test('gated permission: auto-approved mutating tool (no human needed) also carries updatedInput', async () => {
  const sess = createSession({ kind: 'chat' });
  const perm = buildGatedToolPermission(sess.id, ['memory_read', 'task_hygiene']) as unknown as Perm;
  // task_hygiene is in the fast-allow list here; the regression this pins is the
  // ALLOW SHAPE — a bare {behavior:'allow'} fails the CLI's Zod parse
  // ("updatedInput expected record, received undefined" — 2026-07-02 end-of-day).
  const res = await perm('mcp__clementine-local__task_hygiene', { mode: 'ledger' }, opts());
  assert.equal(res.behavior, 'allow');
  assert.deepEqual(res.updatedInput, { mode: 'ledger' });
});

test('gated permission: a DESTRUCTIVE shell command registers + AWAITS + ALLOWS on approve', async () => {
  const sess = createSession({ kind: 'chat' });
  const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
  const p = perm('mcp__clementine-local__run_shell_command', { command: 'git push origin main' }, opts());
  const approvalId = await waitForPending(sess.id);
  // The permission promise is still pending (awaiting the human) until we resolve.
  approvalRegistry.resolve(approvalId, 'approved', 'test');
  const res = await p;
  assert.equal(res.behavior, 'allow', 'approve → allow');
  assert.deepEqual(res.updatedInput, { command: 'git push origin main' }, 'human-approved allow must echo updatedInput too');
});

test('gated permission: DENIES on reject', async () => {
  const sess = createSession({ kind: 'chat' });
  const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
  const p = perm('mcp__clementine-local__run_shell_command', { command: 'git push origin main' }, opts());
  const approvalId = await waitForPending(sess.id);
  approvalRegistry.resolve(approvalId, 'rejected', 'test');
  const res = await p;
  assert.equal(res.behavior, 'deny', 'reject → deny');
});

test('gated permission: "Bash is bash" — a read-shaped shell command auto-allows with NO approval', async () => {
  const sess = createSession({ kind: 'chat' });
  const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
  const res = await perm('mcp__clementine-local__run_shell_command', { command: 'ls -la && sf data query --query "SELECT Id FROM Opportunity"' }, opts());
  assert.equal(res.behavior, 'allow');
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 0, 'reads never park for approval');
});

test('gated permission: sf data create record is a CRM write → requires approval even though run_shell_command is in the profile allowlist', async () => {
  const sess = createSession({ kind: 'chat' });
  // run_shell_command deliberately in the fastAllow list — the execution trio
  // must run the smart per-command gate FIRST (the 2026-07-02 silent-CRM-write
  // class: profile advertise list reused as blanket fast-allow).
  const perm = buildGatedToolPermission(sess.id, ['memory_read', 'run_shell_command']) as unknown as Perm;
  const p = perm(
    'mcp__clementine-local__run_shell_command',
    { command: "sf data create record --sobject Task --values \"Subject='x'\" --target-org me@org.com" },
    opts(),
  );
  const approvalId = await waitForPending(sess.id);
  approvalRegistry.resolve(approvalId, 'rejected', 'test');
  const res = await p;
  assert.equal(res.behavior, 'deny', 'unapproved CRM write must not run');
});

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
});
