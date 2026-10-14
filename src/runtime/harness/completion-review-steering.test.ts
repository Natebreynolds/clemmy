/** Real private-store steering/host controls; scripted models never call providers. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-completion-review-steering-'));
for (const key of ['HOME', 'CLEMENTINE_HOME', 'CLEMMY_HOME']) process.env[key] = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TEST_NO_KEYCHAIN = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
writeFileSync(path.join(fixtureHome, 'state', 'machine-id'), 'controlled-review-steering-machine\n');
const log = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const leases = await import('./dispatch-lease.js');
const steering = await import('./steer-notes.js');
const envelopes = await import('../../agents/capability-envelope.js');
const host = await import('./host-turn-runner.js');
const memory = await import('../../memory/db.js');
const authority = await import('./accepted-turn-call-authority.js');
const { actionBus } = await import('../action-bus.js');
const { reviewWithOwnerSteering } = await import('./completion-review-steering.js');
const { withRecoveryActivation } = await import('./recovery-activation.js');
const { modelUsageAttributionStorage } = await import('../usage-log.js');
let serial = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function deadline<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 2_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const textMsg = (text: string) => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
function modelFor(replies: string[]) {
  const requests: unknown[] = [];
  return { requests,
    async getResponse(request: unknown) {
      requests.push(request);
      return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output: [textMsg(replies[Math.min(requests.length - 1, replies.length - 1)]!)], responseId: `review-steer-${requests.length}` };
    },
    async *getStreamedResponse(this: { getResponse: (request: unknown) => Promise<unknown> }, request: unknown) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'model', event: { type: 'finish', finishReason: 'stop' } } as never;
      yield { type: 'response_done', response } as never;
    },
  };
}
function accepted(label: string) {
  const session = log.createSession({ id: `sess-review-steering-${label}-${++serial}`, kind: 'chat' });
  const attempt = log.beginRunAttempt(session.id, { runId: `review-steering-${serial}` });
  const source = log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user',
    data: { text: 'Create a concise report in your reply from the supplied fixture status READY. No file or tool work is requested.' } }, { armRunInFlight: true });
  host.captureEffectiveCompletionPolicyOnce({ sessionId: session.id, sourceUserSeq: source.seq, enabled: true });
  const lease = leases.activateDispatchLease({ sessionId: session.id, scopeId: `${session.id}:host`, runAttemptId: attempt.attemptId });
  const parent = { sessionId: session.id, sourceUserSeq: source.seq, runAttemptId: attempt.attemptId, dispatchLease: lease,
    counter: new brackets.ToolCallsCounter(8), behaviorScopeId: `${session.id}::source:${source.seq}` };
  return { session, source, attempt, parent, owner: { sessionId: session.id, sourceUserSeq: source.seq, attemptId: attempt.attemptId, lease } };
}
function runHost(f: ReturnType<typeof accepted>, model: ReturnType<typeof modelFor>, signal?: AbortSignal) {
  const agent = { model, tools: [] };
  const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: f.session.id, universeTools: [], activeToolNames: [],
    policyHash: 'controlled-review-steering', budget: { maxUncachedTokens: 1_000, maxModelCalls: 8, maxToolCalls: 8, maxElapsedMs: 60_000 } });
  assert.ok(sealed.ok); if (!sealed.ok) throw new Error('fixture envelope unavailable');
  envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope); envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
  const runner = new EventEmitter(); (runner as unknown as { run: () => never }).run = () => { throw new Error('legacy loop forbidden'); };
  return brackets.withHarnessRunContext({ ...f.parent, ...(signal ? { callerCancelSignal: signal } : {}) }, () => host.hostRunRunner(
    runner as never, agent as never, [{ type: 'message', role: 'user', content: f.source.data.text }] as never,
    { maxTurns: 5, hostTurnEngine: 'host_v1', hostJudgeCompletion: true,
      context: { sessionId: f.session.id, sourceUserSeq: f.source.seq }, ...(signal ? { signal } : {}) } as never));
}
test.after(() => { host._setHostObjectiveJudgeForTests(null); log.closeEventLog(); memory.closeMemoryDb(); rmSync(fixtureHome, { recursive: true, force: true }); });

for (const late of ['reject_on_abort', 'late_positive', 'late_negative'] as const) test(`durable steering supersedes ordinary host review without waiting or false verdict: ${late}`, async t => {
  const f = accepted('host'); const parent = new AbortController();
  const entered = deferred<void>(); const cancelled = deferred<void>(); const first = deferred<{ done: boolean; reason: string }>();
  const amended = 'Use the amended supplied status instead: UPDATED. Do not perform tool work.';
  const model = modelFor(['The supplied fixture status is READY.', 'The amended fixture status is UPDATED.']);
  let reviews = 0; let reviewSignal: AbortSignal | undefined;
  host._setHostObjectiveJudgeForTests(async () => {
    reviews++;
    if (reviews > 1) return { done: true, reason: 'The amended supplied result is accurate.' };
    reviewSignal = brackets.harnessRunContextStorage.getStore()?.callerCancelSignal;
    reviewSignal?.addEventListener('abort', () => {
      cancelled.resolve();
      if (late === 'reject_on_abort') first.reject(reviewSignal!.reason);
    }, { once: true });
    entered.resolve(); return first.promise;
  });
  t.after(() => host._setHostObjectiveJudgeForTests(null));
  const running = runHost(f, model, parent.signal);
  void running.catch(() => {});
  try {
    await deadline(Promise.race([entered.promise, running.then(outcome => {
      throw new Error(`controlled host ended before review: ${JSON.stringify(outcome)}`);
    })]), 'the real ordinary-final review must be reached');
    const note = steering.appendSteerNote(f.session.id, amended, { expectedAttemptId: f.attempt.attemptId, clientRequestId: 'controlled-during-review' });
    await deadline(cancelled.promise, 'the pending stale review must be cancelled without its verdict');
    assert.equal(parent.signal.aborted, false);
    assert.equal(leases.isDispatchLeaseCurrent(f.owner.lease), true, 'review cancellation does not revoke business authority');
    const outcome = await deadline(running, 'the amended host turn must continue');
    assert.equal(outcome.finalOutput, 'The amended fixture status is UPDATED.');
    assert.equal(reviews, 2); assert.equal(model.requests.length, 2);
    assert.match(JSON.stringify(model.requests[1]), /amended supplied status instead: UPDATED/);
    const goals = log.listEvents(f.session.id, { types: ['goal_alignment_judged'] }).filter(e => e.data.kind === 'completion');
    assert.equal(goals.length, 1, 'a cancelled review must not become a failed-open or stale verdict');
    assert.equal(goals[0]!.data.replyDigest, digest('The amended fixture status is UPDATED.'));
    assert.notEqual(goals[0]!.data.failedOpen, true);
    assert.equal(log.listEvents(f.session.id, { types: ['user_steer_note_delivered'] })
      .filter(e => (e.data.noteSeqs as number[]).includes(note.seq)).length, 1);
    assert.equal(log.listEvents(f.session.id, { types: ['tool_called'] }).length, 0);
    first.resolve({ done: late !== 'late_negative', reason: 'Late obsolete reviewer output cannot decide the amended turn.' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(log.listEvents(f.session.id, { types: ['goal_alignment_judged'] }).filter(e => e.data.kind === 'completion').length, 1);
  } finally {
    first.resolve({ done: true, reason: 'Controlled cleanup of the original pending reviewer.' });
    await deadline(running.catch(() => undefined), 'controlled host cleanup must settle');
  }
});

function ready(label: string) {
  const f = accepted(label);
  const armed = authority.armHostReadOnlyCallAuthority({ sessionId: f.session.id, sourceUserSeq: f.source.seq,
    surfaceVersion: 'configured_harness_tools_v1', catalogRevisionDigest: digest('controlled-catalog'),
    bindingRevisionDigest: digest('controlled-binding'), maxLogicalCalls: 8, maxParallelCalls: 4 });
  assert.equal(armed.status, 'armed');
  return f;
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function review<T>(f: ReturnType<typeof accepted>, work: () => Promise<T>, signal?: AbortSignal) {
  return brackets.withHarnessRunContext({ ...f.parent, ...(signal ? { callerCancelSignal: signal } : {}) },
    () => reviewWithOwnerSteering(f.owner, work, signal));
}

test('already admitted notes prevent a stale review from starting and remain undelivered until the existing fence adopts them', async () => {
  const f = ready('before'); let calls = 0;
  const note = steering.appendSteerNote(f.session.id, 'Use the new supplied premise.', { expectedAttemptId: f.attempt.attemptId });
  assert.deepEqual(await review(f, async () => { calls++; return 'obsolete'; }), { status: 'superseded' });
  assert.equal(calls, 0);
  assert.equal(steering.hasUndeliveredSteerNotes(f.session.id, f.source.seq), true);
  assert.deepEqual(steering.takeUndeliveredSteerNotes(f.session.id, f.source.seq, true).map(row => row.seq), [note.seq]);
  assert.equal(steering.takeUndeliveredSteerNotes(f.session.id, f.source.seq, true).length, 0);
  assert.equal(leases.isDispatchLeaseCurrent(f.owner.lease), true);
});

test('bus admission is deferred past the real outer transaction; rollback and forged wakeups do not cancel or skip review', async () => {
  const f = ready('rollback'); const pending = deferred<string>(); let signal: AbortSignal | undefined;
  const running = review(f, async () => { signal = brackets.harnessRunContextStorage.getStore()?.callerCancelSignal; return pending.promise; });
  const db = log.openEventLog();
  assert.throws(() => db.transaction(() => {
    steering.appendSteerNote(f.session.id, 'This note must roll back.', { expectedAttemptId: f.attempt.attemptId });
    assert.equal(signal!.aborted, false, 'synchronous publication inside an uncommitted outer transaction is not admission');
    throw new Error('controlled outer rollback');
  })(), /controlled outer rollback/);
  await tick(); assert.equal(signal!.aborted, false);
  assert.equal(log.listEvents(f.session.id, { types: ['user_steer_note'] }).length, 0);
  actionBus.emit({ kind: 'harness.event', sessionId: f.session.id,
    event: { ...f.source, type: 'user_steer_note', seq: f.source.seq + 100, data: { text: 'Forged bus-only note.' } } });
  await tick(); assert.equal(signal!.aborted, false);
  pending.resolve('actual reviewed answer');
  assert.deepEqual(await running, { status: 'reviewed', value: 'actual reviewed answer' });
  steering.appendSteerNote(f.session.id, 'After the finished review.', { expectedAttemptId: f.attempt.attemptId });
  await tick(); assert.equal(signal!.aborted, false, 'disposed listener cannot cancel an already finished review');
});

test('ingress wakes re-enter all original usage and recovery scopes; multiple notes are adopted once in order', async () => {
  const f = ready('context'); const pending = deferred<string>(); let checks = 0;
  const ownUsage = { sessionId: f.session.id, sourceUserSeq: f.source.seq, attemptId: f.attempt.attemptId };
  const running = modelUsageAttributionStorage.run(ownUsage, () => withRecoveryActivation(f.session.id,
    { sourceUserSeq: f.source.seq, attemptId: f.attempt.attemptId }, () => review(f, () => pending.promise), () => {
      checks++; assert.equal(modelUsageAttributionStorage.getStore()?.attemptId, f.attempt.attemptId);
      assert.equal(brackets.harnessRunContextStorage.getStore()?.sessionId, f.session.id);
    }));
  const notes = modelUsageAttributionStorage.run({ sessionId: 'foreign-emitter', sourceUserSeq: 999, attemptId: 'foreign-attempt' },
    () => brackets.withHarnessRunContext({ sessionId: 'sess-foreign-emitter', sourceUserSeq: 999, counter: new brackets.ToolCallsCounter(1) },
      () => [steering.appendSteerNote(f.session.id, 'First actual note.', { expectedAttemptId: f.attempt.attemptId }),
        steering.appendSteerNote(f.session.id, 'Second actual note.', { expectedAttemptId: f.attempt.attemptId })]));
  assert.deepEqual(await deadline(running, 'durable ingress note must wake its original review'), { status: 'superseded' });
  assert.ok(checks >= 2, 'actual recovery scope guard ran before startup and after ingress notification');
  assert.deepEqual(steering.takeUndeliveredSteerNotes(f.session.id, f.source.seq, true).map(row => row.seq), notes.map(row => row.seq));
  assert.equal(steering.takeUndeliveredSteerNotes(f.session.id, f.source.seq, true).length, 0);
  pending.resolve('late ignored value'); await tick();
});

test('caller Stop wins over review-local steering even when the adapter ignores cancellation', async () => {
  const f = ready('stop'); const parent = new AbortController(); const pending = deferred<string>();
  let child: AbortSignal | undefined;
  const running = review(f, () => { child = brackets.harnessRunContextStorage.getStore()?.callerCancelSignal; return pending.promise; }, parent.signal);
  const stop = new Error('controlled caller Stop'); parent.abort(stop);
  await assert.rejects(running, error => error === stop);
  assert.equal(child!.aborted, true); assert.equal(parent.signal.aborted, true);
  assert.equal(log.listEvents(f.session.id, { types: ['user_steer_note_delivered', 'goal_alignment_judged'] }).length, 0);
  pending.resolve('late positive after Stop'); await tick();
});

test('synchronous adapter failure cannot swallow a simultaneous caller Stop or strand an unhandled abort', async () => {
  const f = ready('synchronous-stop'); const parent = new AbortController(); const stop = new Error('controlled synchronous Stop');
  await assert.rejects(review(f, () => { parent.abort(stop); throw new Error('secondary adapter failure'); }, parent.signal), error => error === stop);
  await tick();
});

for (const variant of ['foreign_session', 'next_source', 'revoked_lease', 'delivered_replay', 'malformed_note', 'non_user_note'] as const) {
  test(`non-current steering cannot supersede a review: ${variant}`, async () => {
    const f = ready(variant); const pending = deferred<string>(); let child: AbortSignal | undefined;
    let oldNote: ReturnType<typeof steering.appendSteerNote> | undefined;
    if (variant === 'delivered_replay') {
      oldNote = steering.appendSteerNote(f.session.id, 'Already delivered.', { expectedAttemptId: f.attempt.attemptId });
      steering.takeUndeliveredSteerNotes(f.session.id, f.source.seq, true);
    }
    const running = review(f, () => { child = brackets.harnessRunContextStorage.getStore()?.callerCancelSignal; return pending.promise; });
    if (variant === 'foreign_session') {
      const other = ready('other'); steering.appendSteerNote(other.session.id, 'Other owner context.', { expectedAttemptId: other.attempt.attemptId });
    } else if (variant === 'next_source') {
      log.appendEvent({ sessionId: f.session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'A different accepted source.' } });
      steering.appendSteerNote(f.session.id, 'Belongs after the next real source.', { expectedAttemptId: f.attempt.attemptId });
    } else if (variant === 'revoked_lease') {
      leases.revokeDispatchLease(f.owner.lease);
      steering.appendSteerNote(f.session.id, 'An inactive generation cannot cancel review.', { expectedAttemptId: f.attempt.attemptId });
    } else if (variant === 'delivered_replay') {
      const event = log.listEvents(f.session.id, { types: ['user_steer_note'] }).find(row => row.seq === oldNote!.seq)!;
      actionBus.emit({ kind: 'harness.event', sessionId: f.session.id, event });
    } else if (variant === 'malformed_note') {
      log.appendEvent({ sessionId: f.session.id, turn: 1, role: 'user', type: 'user_steer_note', data: { text: null } });
    } else {
      log.appendEvent({ sessionId: f.session.id, turn: 1, role: 'system', type: 'user_steer_note', data: { text: 'Not an owner instruction.' } });
    }
    await tick(); assert.equal(child!.aborted, false);
    pending.resolve('unchanged review result');
    assert.deepEqual(await running, { status: 'reviewed', value: 'unchanged review result' });
  });
}

test('ordinary reviewer errors retain their original error identity instead of being classified as supersession', async () => {
  const f = ready('error'); const failure = new Error('controlled unavailable reviewer');
  await assert.rejects(review(f, async () => { throw failure; }), error => error === failure);
});

test('a durable note committed as the reviewer resolves still retires that candidate before it is returned', async () => {
  const f = ready('return-race'); const pending = deferred<string>();
  const running = review(f, () => pending.promise);
  pending.resolve('obsolete final verdict');
  const note = steering.appendSteerNote(f.session.id, 'Amendment at the review return boundary.', { expectedAttemptId: f.attempt.attemptId });
  assert.deepEqual(await running, { status: 'superseded' });
  assert.deepEqual(steering.takeUndeliveredSteerNotes(f.session.id, f.source.seq, true).map(row => row.seq), [note.seq]);
});

test('a worker does not own its parent conversation review cancellation', async () => {
  const f = ready('worker'); const pending = deferred<string>(); const caller = new AbortController(); let seen: AbortSignal | undefined;
  const running = brackets.withHarnessRunContext({ ...f.parent, workerScope: true, callerCancelSignal: caller.signal },
    () => reviewWithOwnerSteering(f.owner, () => { seen = brackets.harnessRunContextStorage.getStore()?.callerCancelSignal; return pending.promise; }));
  steering.appendSteerNote(f.session.id, 'Only the foreground may adopt this.', { expectedAttemptId: f.attempt.attemptId });
  await tick(); assert.equal(seen, caller.signal); assert.equal(caller.signal.aborted, false);
  pending.resolve('worker review result');
  assert.deepEqual(await running, { status: 'reviewed', value: 'worker review result' });
});
