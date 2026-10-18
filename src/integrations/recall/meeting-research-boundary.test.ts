import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MeetingResearchBoundary } from './meeting-research.js';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-research-boundary-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT: 'off', HARNESS_TOOL_BRACKETS: 'on' });
const log = await import('../../runtime/harness/eventlog.js');
const guard = await import('./meeting-research-boundary.js');
const { wrapToolForHarness, withHarnessRunContext, ToolCallsCounter } = await import('../../runtime/harness/brackets.js');
const { invokeHostToolCall } = await import('../../runtime/harness/host-tool-invocation.js');
test.afterEach(() => guard.installMeetingResearchBoundary(null));
test.after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

function source(research = true, changes: Record<string, unknown> = {}) {
  const session = log.createSession({ kind: 'chat' });
  const text = 'Controlled exact meeting objective and retained evidence.';
  const claim = log.claimRunAttemptLease({ sessionId: session.id, runId: 'controlled-run', ownerId: 'meeting-research-boundary-test', leaseMs: 60_000 });
  assert.ok(claim.attempt); const attempt = claim.attempt!;
  const event = log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
    text, displayText: text, source: research ? 'meeting_research' : 'desktop',
    clientRequestId: 'controlled-request', attemptId: attempt.attemptId, runId: 'controlled-run',
    meetingResearchReference: { meetingId: 'controlled-meeting' },
    meetingResearchInputDigest: createHash('sha256').update(text).digest('hex'), ...changes,
  } });
  const boundary = { job: { privateOriginSessionId: session.id, clientRequestId: 'controlled-request',
    dispatchOwnerPid: process.pid, task: { sourceUserSeq: event.seq, attemptId: attempt.attemptId, runId: 'controlled-run' } } } as MeetingResearchBoundary;
  return { session, event, boundary, attempt };
}
test('only exact research sources require a live host verifier; ordinary tasks retain their tool scope', () => {
  const normal = source(false); const f = source();
  assert.doesNotThrow(() => guard.assertMeetingResearchModelAllowed(normal.session.id, normal.event.seq));
  assert.equal(guard.meetingResearchToolRefusal(normal.session.id, normal.event.seq), undefined);
  assert.throws(() => guard.assertMeetingResearchModelAllowed(f.session.id, f.event.seq), /permission is unavailable/);
  let allowed = true; let checks = 0;
  guard.installMeetingResearchBoundary(() => { checks++; if (!allowed) throw new Error('revoked'); return f.boundary; });
  guard.assertMeetingResearchModelAllowed(f.session.id, f.event.seq);
  allowed = false;
  assert.throws(() => guard.assertMeetingResearchModelAllowed(f.session.id, f.event.seq), /revoked/);
  assert.equal(checks, 2, 'grant is reopened before each model call');
});
test('an ended, expired or foreign-process attempt cannot regain the meeting grant on recovery', () => {
  const ended = source(); guard.installMeetingResearchBoundary(() => ended.boundary);
  log.finishRunAttempt(ended.attempt, 'interrupted');
  assert.throws(() => guard.assertMeetingResearchModelAllowed(ended.session.id, ended.event.seq), /active attempt/);
  const expired = source(); guard.installMeetingResearchBoundary(() => expired.boundary);
  log.openEventLog().prepare('UPDATE run_attempts SET lease_expires_at = ? WHERE attempt_id = ?').run('2000-01-01T00:00:00Z', expired.attempt.attemptId);
  assert.throws(() => guard.assertMeetingResearchModelAllowed(expired.session.id, expired.event.seq), /active attempt/);
  const foreign = source(); guard.installMeetingResearchBoundary(() => ({ ...foreign.boundary,
    job: { ...foreign.boundary.job, dispatchOwnerPid: process.pid + 1 } }));
  assert.throws(() => guard.assertMeetingResearchModelAllowed(foreign.session.id, foreign.event.seq), /active attempt/);
});
test('the exact accepted task, not a borrowed session/request or changed text, owns the model call', () => {
  for (const changes of [{ attemptId: 'wrong' }, { runId: 'wrong' }, { clientRequestId: 'wrong' }, { text: 'changed' }]) {
    const f = source(true, changes);
    guard.installMeetingResearchBoundary(() => f.boundary);
    assert.throws(() => guard.assertMeetingResearchModelAllowed(f.session.id, f.event.seq), /accepted task/);
  }
  const f = source();
  guard.installMeetingResearchBoundary(() => ({ ...f.boundary, job: { ...f.boundary.job,
    task: { ...f.boundary.job.task!, sourceUserSeq: f.event.seq + 1 } } }));
  assert.throws(() => guard.assertMeetingResearchModelAllowed(f.session.id, f.event.seq), /accepted task/);
});
test('real invoke and execute brackets refuse read tools and carriers before any tool body or counter runs', async () => {
  const f = source(); let calls = 0;
  for (const name of ['memory_recall_all', 'run_shell_command', 'call_tool', 'work_call', 'run_worker', 'composio_execute_tool']) {
    for (const kind of ['execute', 'invoke'] as const) {
      const wrapped = wrapToolForHarness(kind === 'execute' ? { name, execute: async () => { calls++; return 'unexpected'; } }
        : { name, invoke: async () => { calls++; return 'unexpected'; } });
      const counter = new ToolCallsCounter(10);
      try {
        const result = await withHarnessRunContext({ sessionId: f.session.id, sourceUserSeq: f.event.seq, counter },
          () => kind === 'execute' ? (wrapped as { execute(): Promise<unknown> }).execute()
            : (wrapped as unknown as { invoke(...args: unknown[]): Promise<unknown> }).invoke(null, '{}', { toolCall: { callId: `call-${name}` } }));
        assert.match(JSON.stringify(result), /Tool execution is not authorized/);
      } catch (error) { assert.match(String(error), /Tool execution is not authorized/); }
      assert.equal(counter.calls, 0);
    }
  }
  assert.equal(calls, 0);
});
test('the physical host boundary also refuses research tools when bracket wrapping is disabled', async () => {
  const f = source(); let calls = 0;
  process.env.HARNESS_TOOL_BRACKETS = 'off';
  try {
    await assert.rejects(() => invokeHostToolCall({ identity: { sessionId: f.session.id, sourceUserSeq: f.event.seq,
      toolName: 'run_shell_command', modelCallId: 'call-controlled', args: { command: 'never run' } },
      execute: async () => { calls++; },
    } as unknown as Parameters<typeof invokeHostToolCall>[0]), /Tool execution is not authorized/);
    assert.equal(calls, 0);
  } finally { process.env.HARNESS_TOOL_BRACKETS = 'on'; }
});
