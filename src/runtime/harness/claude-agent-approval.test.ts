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
type Perm = (name: string, input: Record<string, unknown>, o: unknown) => Promise<{ behavior: string; message?: string; updatedInput?: Record<string, unknown>; interrupt?: boolean }>;

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

test('gated permission does not claim a tool executed before the SDK stream reports tool_use', async () => {
  const sess = createSession({ kind: 'chat' });
  const perm = buildGatedToolPermission(sess.id, ['memory_read']) as unknown as Perm;
  await perm('mcp__clementine-local__memory_read', { query: 'x' }, { signal: new AbortController().signal, toolUseID: 'toolu_visible_1' });

  const events = listEvents(sess.id, { types: ['tool_called'] });
  assert.equal(events.length, 0);
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

test('workflow park mode interrupts promptly, reuses one exact approval after restart, and consumes it once', async () => {
  const sess = createSession({ kind: 'workflow' });
  const command = { command: 'git push origin main' };
  const boundaries: Array<{ approvalId: string; state: string }> = [];
  const build = (): Perm => buildGatedToolPermission(sess.id, ['memory_read'], {
    approvalMode: 'park',
    onApprovalBoundary: (boundary) => boundaries.push({ approvalId: boundary.approvalId, state: boundary.state }),
  }) as unknown as Perm;

  const first = await build()('mcp__clementine-local__run_shell_command', command, opts());
  assert.equal(first.behavior, 'deny');
  assert.equal(first.interrupt, true, 'the SDK query is interrupted instead of awaiting the human');
  const pending = approvalRegistry.listPending({ sessionId: sess.id });
  assert.equal(pending.length, 1);
  assert.equal(listEvents(sess.id, { types: ['approval_requested'] }).length, 1, 'one concrete card/event');

  // Re-entering before resolution must find the same durable row, not mint a
  // duplicate card (covers drain retry / daemon restart while still pending).
  const stillPending = await build()('mcp__clementine-local__run_shell_command', command, opts());
  assert.equal(stillPending.interrupt, true);
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id }).length, 1);
  assert.equal(listEvents(sess.id, { types: ['approval_requested'] }).length, 1);

  approvalRegistry.resolve(pending[0].approvalId, 'approved', 'unit-test-human');
  const resumed = await build()('mcp__clementine-local__run_shell_command', command, opts());
  assert.equal(resumed.behavior, 'allow');
  assert.deepEqual(resumed.updatedInput, command, 'the approved payload is reused byte-for-byte');
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id, status: 'any' }).length, 1, 'resume minted no second card');
  assert.ok(approvalRegistry.get(pending[0].approvalId)?.consumedAt);

  // The one-shot grant is spent AND the action already executed under it. A
  // later identical call must NOT re-surface a card — that would ask the human to
  // re-approve an already-sent action (a duplicate irreversible send), or livelock
  // if they decline. It is terminal-done: deny without parking and mint no
  // replacement card, so a from-scratch replay skips the done send and proceeds to
  // its next still-ungranted action.
  const replay = await build()('mcp__clementine-local__run_shell_command', command, opts());
  assert.equal(replay.behavior, 'deny');
  assert.equal(replay.interrupt, false, 'a consumed grant is done, not parked — the run continues past it');
  assert.match(String((replay as { message?: string }).message ?? ''), /already .*(approved|executed)/i, 'message marks it already-done, not a fresh request');
  assert.equal(approvalRegistry.listPending({ sessionId: sess.id, status: 'any' }).length, 1, 'no duplicate card minted for the already-executed send');
  assert.equal(boundaries.filter((boundary) => boundary.state === 'pending').length, 2, 'the consumed replay fires no new pending boundary');
});

test('workflow park mode treats rejected and expired exact decisions as terminal, without a replacement card', async () => {
  for (const resolution of ['rejected', 'expired'] as const) {
    const sess = createSession({ kind: 'workflow' });
    const command = { command: `git push origin ${resolution}` };
    let lastState = '';
    const build = (): Perm => buildGatedToolPermission(sess.id, ['memory_read'], {
      approvalMode: 'park',
      onApprovalBoundary: (boundary) => { lastState = boundary.state; },
    }) as unknown as Perm;

    await build()('mcp__clementine-local__run_shell_command', command, opts());
    const row = approvalRegistry.listPending({ sessionId: sess.id })[0];
    assert.ok(row);
    approvalRegistry.resolve(row.approvalId, resolution, 'unit-test-human');

    const denied = await build()('mcp__clementine-local__run_shell_command', command, opts());
    assert.equal(denied.behavior, 'deny');
    assert.equal(denied.interrupt, true);
    assert.match(denied.message ?? '', new RegExp(resolution));
    assert.equal(lastState, resolution);
    assert.equal(approvalRegistry.listPending({ sessionId: sess.id, status: 'any' }).length, 1, 'no replacement approval after terminal decision');
  }
});

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
});
