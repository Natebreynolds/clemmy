import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-target-review-policy-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(home, 'state'), { recursive: true });
const events = await import('../runtime/harness/eventlog.js');
const { captureEffectiveCompletionPolicyOnce, readCapturedCompletionPolicy } = await import('../runtime/harness/host-turn-runner.js');
const { captureWorkflowTargetReviewPolicy, parseWorkflowTargetReviewPolicy, workflowTargetReviewPolicyFromOriginCaptures }
  = await import('./workflow-target-review-policy.js');
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

const selection = { status: 'unavailable' as const, reason: 'fixture' };
type Capture = ReturnType<typeof readCapturedCompletionPolicy>;
const captured = (policy: { enabled: boolean; ownerEnabled?: boolean }): Capture => ({ status: 'captured',
  policy: { ...policy, judgeSelection: selection } });

function withOwnerSwitch<T>(value: 'on' | 'off', run: () => T): T {
  const previous = process.env.CLEMMY_COMPLETION_REVIEW;
  process.env.CLEMMY_COMPLETION_REVIEW = value;
  try { return run(); } finally {
    if (previous === undefined) delete process.env.CLEMMY_COMPLETION_REVIEW;
    else process.env.CLEMMY_COMPLETION_REVIEW = previous;
  }
}

test('a scheduled run with no originating request follows the owner\'s switch', () => {
  const on = withOwnerSwitch('on', () => workflowTargetReviewPolicyFromOriginCaptures([]));
  assert.equal(on.status, 'captured');
  assert.equal(on.status === 'captured' && on.enabled, true);
  const off = withOwnerSwitch('off', () => workflowTargetReviewPolicyFromOriginCaptures([]));
  assert.equal(off.status === 'captured' && off.enabled, false);
});

test('an origin surface that left its own in-loop review off has deferred the review to the run, not switched it off', () => {
  // A chat surface that reviews in its own loop: its combined value is the owner's.
  const chat = workflowTargetReviewPolicyFromOriginCaptures([captured({ enabled: true, ownerEnabled: true })]);
  assert.equal(chat.status === 'captured' && chat.enabled, true);
  // A surface whose own loop never reviews (the run's target review owns it)
  // while the owner's switch is on: the run reviews.
  const deferred = workflowTargetReviewPolicyFromOriginCaptures([captured({ enabled: false, ownerEnabled: true })]);
  assert.equal(deferred.status === 'captured' && deferred.enabled, true);
  // The owner's switch off is the owner's decision, on every surface.
  const ownerOff = workflowTargetReviewPolicyFromOriginCaptures([captured({ enabled: false, ownerEnabled: false })]);
  assert.equal(ownerOff.status === 'captured' && ownerOff.enabled, false);
  // A row captured before the two were told apart carries only the combined value.
  const legacy = workflowTargetReviewPolicyFromOriginCaptures([captured({ enabled: false })]);
  assert.equal(legacy.status === 'captured' && legacy.enabled, false);
});

test('an unreadable or disagreeing origin capture leaves the run\'s optional review unavailable, never defaulted', () => {
  const unreadable = workflowTargetReviewPolicyFromOriginCaptures([captured({ enabled: true, ownerEnabled: true }), { status: 'unreadable' }]);
  assert.equal(unreadable.status, 'unavailable');
  const joined = workflowTargetReviewPolicyFromOriginCaptures([captured({ enabled: true, ownerEnabled: true }), captured({ enabled: false, ownerEnabled: false })]);
  assert.equal(joined.status, 'unavailable');
  // An absent capture (a legacy origin with no stamp) contributes nothing; the
  // owner's switch decides, as for a scheduled run.
  const absent = withOwnerSwitch('on', () => workflowTargetReviewPolicyFromOriginCaptures([{ status: 'absent' }]));
  assert.equal(absent.status === 'captured' && absent.enabled, true);
});

test('the policy a step\'s own session captured says the surface deferred, and the run record says enabled', () => {
  // A workflow step session is captured with review off (its surface never
  // reviews in its own loop) while the owner's switch is on; the run itself
  // captures enabled, and the two records agree on whose rule each is.
  const session = events.createSession({ id: 'workflow:policy-run-1:work', kind: 'workflow',
    metadata: { workflowRunId: 'policy-run-1', stepId: 'work' } });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Read the file.', workflowRunId: 'policy-run-1', stepId: 'work' } });
  withOwnerSwitch('on', () => {
    captureEffectiveCompletionPolicyOnce({ sessionId: session.id, sourceUserSeq: source.seq, enabled: false, ownerEnabled: true });
    const step = readCapturedCompletionPolicy({ sessionId: session.id, sourceUserSeq: source.seq });
    assert.equal(step.status, 'captured');
    assert.equal(step.status === 'captured' && step.policy.enabled, false);
    assert.equal(step.status === 'captured' && step.policy.ownerEnabled, true);
    const dir = path.join(home, 'workflows', 'runs');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'policy-run-1.json');
    writeFileSync(file, JSON.stringify({ id: 'policy-run-1', workflow: 'example', status: 'queued' }));
    const run = captureWorkflowTargetReviewPolicy(file, 'policy-run-1');
    assert.equal(run.status === 'captured' && run.enabled, true);
    assert.deepEqual(parseWorkflowTargetReviewPolicy(run), run);
  });
});
