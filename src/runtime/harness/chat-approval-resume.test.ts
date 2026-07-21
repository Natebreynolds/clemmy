/**
 * Run: npx tsx --test src/runtime/harness/chat-approval-resume.test.ts
 * Fail-closed approval park, resume half (2026-07-20): a PARKED chat approval
 * that is later APPROVED re-drives the session exactly once; rejections,
 * non-parked approvals, and in-flight sessions never dispatch.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-chat-approval-resume-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { createSession, appendEvent } = await import('./eventlog.js');
const approvalRegistry = await import('./approval-registry.js');
const { HarnessSession } = await import('./session.js');
const {
  handleResolvedApprovalForChatResume,
  startChatApprovalResume,
  chatApprovalResumeDirective,
  _resetChatApprovalResumeForTest,
} = await import('./chat-approval-resume.js');

test.after(() => rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => _resetChatApprovalResumeForTest());

function parkApproval(sessionId: string, tool = 'run_shell_command'): approvalRegistry.PendingApprovalRow {
  const row = approvalRegistry.register({ sessionId, subject: 'push the release', tool, args: { command: 'git push' } });
  appendEvent({ sessionId, turn: 0, role: 'system', type: 'approval_parked', data: { approvalId: row.approvalId, tool, subject: 'push the release' } });
  return row;
}

test('an approved PARKED chat approval dispatches the resume directive exactly once', async () => {
  const sess = createSession({ kind: 'chat' });
  const row = parkApproval(sess.id);
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'test');
  assert.ok(resolved.ok && resolved.row);

  const dispatched: Array<{ sessionId: string; directive: string }> = [];
  const dispatch = async (sessionId: string, directive: string): Promise<void> => { dispatched.push({ sessionId, directive }); };

  assert.equal(await handleResolvedApprovalForChatResume(resolved.row!, dispatch), true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].sessionId, sess.id);
  assert.match(dispatched[0].directive, /APPROVED/);
  assert.match(dispatched[0].directive, /exact same arguments/i, 'the directive routes through the one-shot claim');

  // One-shot: the same resolution never re-drives.
  assert.equal(await handleResolvedApprovalForChatResume(resolved.row!, dispatch), false);
  assert.equal(dispatched.length, 1);
});

test('a REJECTED parked approval never resumes; a non-parked approval never resumes', async () => {
  const sess = createSession({ kind: 'chat' });
  const rejected = parkApproval(sess.id);
  const rejectedRes = approvalRegistry.resolve(rejected.approvalId, 'rejected', 'test');
  const nonParked = approvalRegistry.register({ sessionId: sess.id, subject: 'other', tool: 'x', args: {} });
  const nonParkedRes = approvalRegistry.resolve(nonParked.approvalId, 'approved', 'test');

  let calls = 0;
  const dispatch = async (): Promise<void> => { calls += 1; };
  assert.equal(await handleResolvedApprovalForChatResume(rejectedRes.row!, dispatch), false, 'a declined action can never come back on its own');
  assert.equal(await handleResolvedApprovalForChatResume(nonParkedRes.row!, dispatch), false, 'a live wait loop owned this one');
  assert.equal(calls, 0);
});

test('a session with a run IN FLIGHT is never double-driven', async () => {
  const sess = createSession({ kind: 'chat' });
  const row = parkApproval(sess.id);
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'test');
  const live = HarnessSession.load(sess.id);
  live?.setRunInFlight();
  let calls = 0;
  assert.equal(await handleResolvedApprovalForChatResume(resolved.row!, async () => { calls += 1; }), false);
  assert.equal(calls, 0, 'the running turn owns the resolution');
});

test('wired end-to-end: startChatApprovalResume fires through the registry hook', async () => {
  const sess = createSession({ kind: 'chat' });
  const row = parkApproval(sess.id);
  const dispatched: string[] = [];
  startChatApprovalResume(async (sessionId) => { dispatched.push(sessionId); });
  approvalRegistry.resolve(row.approvalId, 'approved', 'test');
  // The hook dispatches on a microtask; give it a beat.
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(dispatched, [sess.id]);
});

test('a dispatch failure is swallowed (the grant stays consumable for a manual continue)', async () => {
  const sess = createSession({ kind: 'chat' });
  const row = parkApproval(sess.id);
  const resolved = approvalRegistry.resolve(row.approvalId, 'approved', 'test');
  const ok = await handleResolvedApprovalForChatResume(resolved.row!, async () => { throw new Error('daemon busy'); });
  assert.equal(ok, false, 'failure reported, never thrown');
  assert.match(chatApprovalResumeDirective('s', 't'), /approval-resume/);
});
