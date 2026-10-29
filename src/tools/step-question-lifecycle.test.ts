/** A pending owner question is one accepted step submission, not a second stale store.
 * Run only through scripts/run-tests-isolated.mjs; no model or write checker runs here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1');
assert.equal(process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS, '1');
assert.ok(process.env.CLEMENTINE_HOME);
const subject = await import('./step-result-tool.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
type Handler = (args: { data: string; ask_owner?: string }) => Promise<unknown>;
function registeredHandler(): Handler {
  let captured: Handler | undefined;
  const registrationOnlyServer = {
    tool(name: string, _description: string, _schema: unknown, handler: Handler) {
      assert.equal(name, 'workflow_step_result'); captured = handler;
    },
  };
  subject.registerStepResultTool(registrationOnlyServer as unknown as Parameters<typeof subject.registerStepResultTool>[0]);
  assert.ok(captured); return captured;
}
const text = (reply: unknown) => (reply as { content?: Array<{ text?: string }> })?.content?.map(item => item.text ?? '').join('\n') ?? '';
const sourceUserSeq = 101;
async function ask(handler: Handler, sessionId: string, question: string, partialData: unknown = { draft: 'controlled partial' }) {
  const reply = await withToolOutputContext({ sessionId, sourceUserSeq,
    runScopeId: 'controlled-step-question-lifecycle', toolName: 'workflow_step_result' }, () =>
    handler({ data: JSON.stringify(partialData), ask_owner: question }));
  assert.match(text(reply), /waits for their answer/);
  assert.deepEqual(subject.peekStepResult(sessionId), { found: false, value: undefined }, 'a question is not a completed deliverable');
}
function cleanup(sessionId: string) {
  subject.takeStepQuestion(sessionId); subject.clearStepResult(sessionId); subject.clearStepContract(sessionId);
}

test('registered ask handler produces one pending question consumed once', async () => {
  const sessionId = 'controlled-question-ask-once';
  try {
    await ask(registeredHandler(), sessionId, 'Choose copper or silver?');
    assert.equal(subject.takeStepQuestion(sessionId), 'Choose copper or silver?');
    assert.equal(subject.takeStepQuestion(sessionId), undefined);
  } finally { cleanup(sessionId); }
});

test('later accepted structured result supersedes the earlier live question', async () => {
  const sessionId = 'controlled-question-accepted-result';
  try {
    await ask(registeredHandler(), sessionId, 'Which label should this step use?');
    const completed = { selected: 'copper', complete: true };
    // The registered handler calls this real setter only after its acceptance
    // gates. Those unrelated write checks are not part of this store regression.
    withToolOutputContext({ sessionId, sourceUserSeq, toolName: 'workflow_step_result' }, () => subject.recordStepResult(sessionId, completed));
    assert.deepEqual(subject.peekStepResult(sessionId), { found: true, value: completed });
    assert.equal(subject.takeStepQuestion(sessionId), undefined, 'a stale question must not park an accepted final result');
    assert.deepEqual(subject.takeStepResult(sessionId), { found: true, value: completed });
  } finally { cleanup(sessionId); }
});

test('clearing step capture removes the prior source question', async () => {
  const sessionId = 'controlled-question-reset';
  try {
    await ask(registeredHandler(), sessionId, 'A question belonging only to the prior source?');
    subject.clearStepResult(sessionId);
    assert.deepEqual(subject.peekStepResult(sessionId), { found: false, value: undefined });
    assert.equal(subject.takeStepQuestion(sessionId), undefined, 'the next source must not inherit a reset question');
  } finally { cleanup(sessionId); }
});

test('contract-refused plain submission preserves the genuine pending question', async () => {
  const sessionId = 'controlled-question-rejected-result';
  const handler = registeredHandler();
  try {
    subject.registerStepContract(sessionId, { type: 'object', required_keys: ['selected'] });
    await ask(handler, sessionId, 'Which selection is required?');
    const reply = await withToolOutputContext({ sessionId, sourceUserSeq,
      runScopeId: 'controlled-step-question-lifecycle', toolName: 'workflow_step_result' }, () => handler({ data: '{}' }));
    assert.match(text(reply), /REJECTED \(not captured\)/);
    assert.equal(subject.peekStepResult(sessionId).found, false);
    assert.equal(subject.takeStepQuestion(sessionId), 'Which selection is required?');
  } finally { cleanup(sessionId); }
});

test('unbound submission cannot erase another step question', async () => {
  const sessionId = 'controlled-question-unbound-result';
  const handler = registeredHandler();
  try {
    await ask(handler, sessionId, 'Does this question remain owned by its step?');
    const reply = await handler({ data: '{"selected":"silver"}' });
    assert.match(text(reply), /no step context/);
    assert.equal(subject.takeStepQuestion(sessionId), 'Does this question remain owned by its step?');
  } finally { cleanup(sessionId); }
});

test('later genuine question replaces a prior result without destructive false-result queries', async () => {
  const sessionId = 'controlled-question-replaces-result';
  try {
    withToolOutputContext({ sessionId, sourceUserSeq, toolName: 'workflow_step_result' }, () => subject.recordStepResult(sessionId, { selected: 'old' }));
    await ask(registeredHandler(), sessionId, 'Which replacement selection is correct?');
    assert.deepEqual(subject.takeStepResult(sessionId), { found: false, value: undefined }, 'taking a non-result must not consume the question');
    assert.equal(subject.takeStepQuestion(sessionId), 'Which replacement selection is correct?');
  } finally { cleanup(sessionId); }
});

for (const [format, transcript] of [
  ['function', 'workflow_step_result({"selected":"invented by prose"})'],
  ['xml', '<function_calls><invoke name="workflow_step_result"><parameter name="selected">invented by prose</parameter></invoke></function_calls>'],
] as const) test(`pending genuine question refuses ${format} transcript salvage`, async () => {
  const sessionId = `controlled-question-protect-${format}`;
  try {
    await ask(registeredHandler(), sessionId, 'Only the owner can choose this selection.');
    assert.equal(subject.recordStepResultFromTranscript(sessionId, transcript), false, 'prose is not a later accepted tool submission');
    assert.equal(subject.peekStepResult(sessionId).found, false);
    assert.equal(subject.takeStepQuestion(sessionId), 'Only the owner can choose this selection.');
  } finally { cleanup(sessionId); }
});


test('shared capture peek retains full question control and filters exact sources without consuming it', async () => {
  const sessionId = 'controlled-question-shared-peek';
  const question = 'Which controlled selection should be used?';
  const partialData = { draft: 'full partial data', text: 'retain-'.repeat(1_500) };
  try {
    await ask(registeredHandler(), sessionId, question, partialData);
    type Capture = { found: boolean; value: unknown; control?: { kind: 'ask_owner'; question: string; partialData: unknown } };
    const peek = (subject as unknown as { peekStepCapture?: (id: string, allowed?: ReadonlySet<number>) => Capture }).peekStepCapture;
    assert.equal(typeof peek, 'function', 'the real loop and runner need one shared non-consuming capture view');
    assert.deepEqual(peek!(sessionId, new Set([sourceUserSeq + 1])), { found: false, value: undefined });
    assert.deepEqual(peek!(sessionId, new Set()), { found: false, value: undefined });
    assert.deepEqual(peek!(sessionId, new Set([sourceUserSeq])), {
      found: true, value: { blocked: true, reason: question }, control: { kind: 'ask_owner', question, partialData },
    });
    assert.equal(subject.takeStepResult(sessionId).found, false);
    assert.equal(subject.takeStepQuestion(sessionId), question, 'failed result reads and wrong-source peeks did not consume the question');
    subject.recordStepResult(sessionId, null);
    assert.equal(subject.takeStepQuestion(sessionId), undefined);
    assert.deepEqual(subject.peekStepResult(sessionId), { found: true, value: null }, 'normal legacy public result shapes stay unchanged');
    assert.deepEqual(subject.takeStepResult(sessionId), { found: true, value: null });
  } finally { cleanup(sessionId); }
});


test('an unbound normal setter cannot displace a newer owned question', async () => {
  const sessionId = 'controlled-question-unbound-setter';
  try {
    await ask(registeredHandler(), sessionId, 'This owned question remains pending.');
    subject.recordStepResult(sessionId, { selected: 'unbound stale result' });
    assert.equal(subject.peekStepResult(sessionId).found, false);
    assert.equal(subject.takeStepQuestion(sessionId), 'This owned question remains pending.');
  } finally { cleanup(sessionId); }
});

test('a delayed accepted normal handler cannot overwrite a newer source question after its write check', { timeout: 10_000 }, async () => {
  const sessionId = 'controlled-question-delayed-old-normal';
  const handler = registeredHandler();
  const authority = await import('../runtime/harness/authored-workflow-write-authority.js');
  let markEntered: () => void = () => {};
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let oldSubmission: Promise<unknown> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  authority._setWorkflowMutationReviewerForTests(async () => {
    markEntered(); await gate;
    return { verdict: 'compatible', reason: 'Controlled writes match the authored step.', proposalDigest: 'controlled-older-source' };
  });
  try {
    authority._queueStepWriteForTests({ receipt: { workflowName: 'controlled-delayed-normal', workflowRunId: 'controlled-delayed-normal-run', stepId: 'main' },
      stepPrompt: 'Store the controlled copper label.', sessionId, sourceUserSeq: 100,
      tool: 'controlled_fixture_write', args: { selected: 'copper' } });
    oldSubmission = withToolOutputContext({ sessionId, sourceUserSeq: 100, toolName: 'workflow_step_result' }, () =>
      handler({ data: '{"selected":"old copper result"}' }));
    await Promise.race([entered, new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('controlled write-check barrier was not reached')), 3_000);
    })]);
    if (deadline) clearTimeout(deadline);
    await ask(handler, sessionId, 'The newer source must choose its own label.');
    release();
    const reply = await oldSubmission;
    assert.match(text(reply), /not recorded/i, 'a source-ownership refusal must not return a captured-result ACK');
    assert.doesNotMatch(text(reply), /^Step result captured/);
    assert.equal(subject.peekStepResult(sessionId).found, false);
    assert.equal(subject.takeStepQuestion(sessionId), 'The newer source must choose its own label.');
  } finally {
    if (deadline) clearTimeout(deadline);
    release();
    if (oldSubmission) await oldSubmission.catch(() => undefined);
    authority._setWorkflowMutationReviewerForTests(null); authority._resetStepWriteChecksForTests();
    cleanup(sessionId);
  }
});

test('a late old-source question cannot replace an accepted newer-source normal result', async () => {
  const sessionId = 'controlled-question-late-old-ask';
  const handler = registeredHandler();
  const value = { selected: 'new silver result' };
  try {
    const accepted = await withToolOutputContext({ sessionId, sourceUserSeq: 102, toolName: 'workflow_step_result' }, () =>
      handler({ data: JSON.stringify(value) }));
    assert.match(text(accepted), /^Step result captured/);
    const stale = await withToolOutputContext({ sessionId, sourceUserSeq: 101, toolName: 'workflow_step_result' }, () =>
      handler({ data: '{"draft":"old"}', ask_owner: 'An old source cannot take over the new result.' }));
    assert.match(text(stale), /not recorded/i);
    assert.doesNotMatch(text(stale), /question is with the owner/i);
    assert.equal(subject.takeStepQuestion(sessionId), undefined);
    assert.deepEqual(subject.takeStepResult(sessionId), { found: true, value });
  } finally { cleanup(sessionId); }
});


test('source-aware cleanup and takes cannot consume another source question', async () => {
  const sessionId = 'controlled-question-filtered-cleanup';
  const takeQuestion = subject.takeStepQuestion as (id: string, allowed?: ReadonlySet<number>) => string | undefined;
  const takeResult = subject.takeStepResult as (id: string, allowed?: ReadonlySet<number>) => { found: boolean; value: unknown };
  const clear = subject.clearStepResult as (id: string, allowed?: ReadonlySet<number>) => void;
  try {
    await ask(registeredHandler(), sessionId, 'This source owns its pending question.');
    clear(sessionId, new Set([sourceUserSeq - 1]));
    assert.deepEqual(takeResult(sessionId, new Set([sourceUserSeq - 1])), { found: false, value: undefined });
    assert.equal(takeQuestion(sessionId, new Set([sourceUserSeq - 1])), undefined, 'a losing source may not take the newer question');
    assert.equal(takeQuestion(sessionId, new Set([sourceUserSeq])), 'This source owns its pending question.');
  } finally { cleanup(sessionId); }
});

test('source-aware cleanup and takes cannot consume another source normal result', () => {
  const sessionId = 'controlled-question-filtered-normal';
  const takeResult = subject.takeStepResult as (id: string, allowed?: ReadonlySet<number>) => { found: boolean; value: unknown };
  const clear = subject.clearStepResult as (id: string, allowed?: ReadonlySet<number>) => void;
  const value = { selected: 'owned copper result' };
  try {
    withToolOutputContext({ sessionId, sourceUserSeq, toolName: 'workflow_step_result' }, () => subject.recordStepResult(sessionId, value));
    assert.deepEqual(takeResult(sessionId, new Set([sourceUserSeq - 1])), { found: false, value: undefined });
    clear(sessionId, new Set([sourceUserSeq - 1]));
    assert.deepEqual(subject.peekStepResult(sessionId), { found: true, value });
    assert.deepEqual(takeResult(sessionId, new Set([sourceUserSeq])), { found: true, value });
  } finally { cleanup(sessionId); }
});


test('a delayed old normal submission stays refused after the newer accepted question was consumed', { timeout: 15_000 }, async () => {
  const sessionId = 'controlled-question-consumed-new-owner';
  const handler = registeredHandler();
  const authority = await import('../runtime/harness/authored-workflow-write-authority.js');
  const eventlog = await import('../runtime/harness/eventlog.js');
  eventlog.createSession({ id: sessionId, kind: 'workflow' });
  const firstSource = eventlog.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Complete the first controlled workflow request.' } });
  let markEntered: () => void = () => {};
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let oldSubmission: Promise<unknown> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  authority._setWorkflowMutationReviewerForTests(async () => {
    markEntered(); await gate;
    return { verdict: 'compatible', reason: 'Controlled writes match the first authored step.', proposalDigest: 'controlled-consumed-source' };
  });
  try {
    authority._queueStepWriteForTests({ receipt: { workflowName: 'controlled-consumed-owner', workflowRunId: 'controlled-consumed-owner-run', stepId: 'main' },
      stepPrompt: 'Store the first controlled copper label.', sessionId, sourceUserSeq: firstSource.seq,
      tool: 'controlled_fixture_write', args: { selected: 'copper' } });
    oldSubmission = withToolOutputContext({ sessionId, sourceUserSeq: firstSource.seq, toolName: 'workflow_step_result' }, () =>
      handler({ data: '{"selected":"old copper result"}' }));
    await Promise.race([entered, new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('controlled old submission did not reach its write-check barrier')), 3_000);
    })]);
    if (deadline) clearTimeout(deadline);
    const secondSource = eventlog.appendEvent({ sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'The newer controlled request needs its own owner selection.' } });
    assert.ok(secondSource.seq > firstSource.seq);
    const question = 'Which label belongs to the newer controlled request?';
    const accepted = await withToolOutputContext({ sessionId, sourceUserSeq: secondSource.seq, toolName: 'workflow_step_result' }, () =>
      handler({ data: '{"draft":"new controlled source"}', ask_owner: question }));
    assert.match(text(accepted), /waits for their answer/);
    const takeQuestion = subject.takeStepQuestion as (id: string, allowed?: ReadonlySet<number>) => string | undefined;
    assert.equal(takeQuestion(sessionId, new Set([secondSource.seq])), question, 'the current runner legitimately consumed the newer question');
    assert.equal(subject.peekStepResult(sessionId).found, false);
    release();
    const oldReply = await oldSubmission;
    assert.match(text(oldReply), /not recorded/i, 'consuming S2 must not restore S1 authority after its awaited check');
    assert.doesNotMatch(text(oldReply), /^Step result captured/);
    assert.equal(subject.peekStepResult(sessionId).found, false, 'no old result reappears after the newer submission is consumed');
    const peek = (subject as unknown as { peekStepCapture: (id: string, allowed?: ReadonlySet<number>) => { found: boolean; value: unknown } }).peekStepCapture;
    assert.deepEqual(peek(sessionId, new Set([firstSource.seq, secondSource.seq])), { found: false, value: undefined });
    assert.equal(subject.takeStepQuestion(sessionId), undefined);
    subject.recordStepResult(sessionId, null);
    assert.deepEqual(subject.takeStepResult(sessionId), { found: true, value: null },
      'once pending handlers finish, the empty fence is gone and legacy public storage keeps its original behavior');
  } finally {
    if (deadline) clearTimeout(deadline);
    release();
    if (oldSubmission) await oldSubmission.catch(() => undefined);
    authority._setWorkflowMutationReviewerForTests(null); authority._resetStepWriteChecksForTests();
    cleanup(sessionId); eventlog.closeEventLog();
  }
});
