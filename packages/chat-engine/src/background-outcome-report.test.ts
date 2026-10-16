import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBackgroundOutcomeReport } from './background-outcome-report.js';
import { ChatEngine, foldTranscript, inFlightTurnSince } from './engine.js';
import type { HarnessEvent, ReplayPayload } from './types.js';
import type { StreamConnection, StreamTransport } from './stream.js';

const SESSION = 'background-report-fixture';
const event = (seq: number, type: string, data: Record<string, unknown> = {}): HarnessEvent =>
  ({ seq, type, data, sessionId: SESSION });
const marker = (sourceUserSeq: number, phase: 'passive' | 'report' = 'report') =>
  ({ version: 1, sourceUserSeq, sourceLabel: 'background task', sourceId: 'fixture-task', phase });
const input = (seq: number, phase: 'passive' | 'report' = 'report'): HarnessEvent => ({
  ...event(seq, 'user_input_received', { synthetic: true, source: 'outcome', deliveryPhase: phase,
    backgroundOutcomeReport: marker(seq, phase) }), role: 'user', turn: 0,
});
const terminal = (seq: number, sourceUserSeq: number, text: string, report = false): HarnessEvent => {
  const identity = { sessionId: SESSION, sourceUserSeq, turn: report ? 0 : 1 };
  return event(seq, 'conversation_completed', { sourceUserSeq, reply: text,
    presentation: { version: 1, audience: 'user', phase: 'final', identity,
      status: 'done', kind: 'answer', text, resumable: false },
    turnOutcome: { version: 2, status: 'done', resumable: false },
    ...(report ? { backgroundOutcomeReport: marker(sourceUserSeq) } : {}),
  });
};
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

class ReportTransport implements StreamTransport {
  live: { onEvent(event: HarnessEvent): void } | null = null;
  closeCount = 0;
  async connect(opts: { sessionId: string; sinceSeq: number; onReplay(payload: ReplayPayload): void;
    onEvent(event: HarnessEvent): void; onError(): void }): Promise<StreamConnection> {
    const connection = { onEvent: opts.onEvent };
    this.live = connection;
    queueMicrotask(() => opts.onReplay({ sessionId: opts.sessionId, events: [] }));
    return { close: () => { this.closeCount += 1; if (this.live === connection) this.live = null; } };
  }
  async fetchRecent(): Promise<ReplayPayload> { return { events: [] }; }
}

test('only a closed exact synthetic outcome marker can isolate a report from execution ownership', () => {
  assert.deepEqual(readBackgroundOutcomeReport(input(5), SESSION), marker(5));
  assert.deepEqual(readBackgroundOutcomeReport(input(5, 'passive'), SESSION), marker(5, 'passive'));
  const done = terminal(7, 5, 'The fixture report is ready.', true);
  assert.deepEqual(readBackgroundOutcomeReport(done, SESSION), marker(5));
  for (const invalid of [
    { ...input(5), role: 'assistant' },
    { ...input(5), data: { ...input(5).data, synthetic: false } },
    { ...input(5), data: { ...input(5).data, source: 'approval_resume' } },
    { ...input(5), data: { ...input(5).data, deliveryPhase: 'passive' } },
    { ...input(5), data: { ...input(5).data, backgroundOutcomeReport: marker(6) } },
    { ...input(5), data: { ...input(5).data, backgroundOutcomeReport: { ...marker(5), ownerAttemptId: 'foreign' } } },
    { ...input(5), data: { ...input(5).data, backgroundOutcomeReport: { ...marker(5), version: 2 } } },
    { ...input(5), data: { ...input(5).data, backgroundOutcomeReport: { ...marker(5), sourceId: '' } } },
    { ...input(5), data: { ...input(5).data, backgroundOutcomeReport: { ...marker(5), sourceLabel: 'bad\nlabel' } } },
    { ...input(5), data: { ...input(5).data, backgroundOutcomeReport: { ...marker(5), sourceUserSeq: NaN } } },
    { ...done, seq: 5 },
    { ...done, sessionId: 'another-session' },
    { ...done, data: { ...done.data, sourceUserSeq: 6 } },
    { ...done, data: { ...done.data, backgroundOutcomeReport: marker(5, 'passive') } },
    { ...done, data: { ...done.data, presentation: { ...(done.data!.presentation as object),
      identity: { sessionId: 'another-session', sourceUserSeq: 5 } } } },
    { ...done, data: { ...done.data, turnOutcome: { version: 2, status: 'failed' } } },
    { ...done, data: { ...done.data, presentation: undefined } },
  ]) assert.equal(readBackgroundOutcomeReport(invalid, SESSION), null, JSON.stringify(invalid));
});

test('a completed report appears live beside a streaming human answer and preserves its Stop source', async () => {
  const transport = new ReportTransport();
  const engine = new ChatEngine({ sessionId: SESSION, transport, newIdempotencyKey: () => 'human-stop-key', api: {
    send: async () => ({ sessionId: SESSION, accepted: true }),
    loadSession: async () => ({ events: [], latestSeq: 0 }),
  } });
  try {
    await engine.send('Continue the fixture analysis.');
    await tick();
    transport.live!.onEvent(event(1, 'user_input_received', { text: 'Continue the fixture analysis.' }));
    transport.live!.onEvent(event(0, 'stream_token', { sourceUserSeq: 1, delta: 'Still checking' }));
    const before = engine.snapshot();
    const active = before.messages.find(message => message.role === 'assistant')!;
    transport.live!.onEvent(input(5, 'passive'));
    transport.live!.onEvent(input(6));
    const report = terminal(7, 6, 'The separate fixture report is saved.', true);
    report.data = { ...report.data, review: 'checked', reviewNote: 'The fixture artifact was read back.',
      turnOutcome: { version: 2, status: 'done', resumable: false,
        evidenceRefs: [{ kind: 'artifact', id: 'fixture-artifact' }] } };
    transport.live!.onEvent(report);
    transport.live!.onEvent(report);
    let snapshot = engine.snapshot();
    assert.equal(snapshot.busy, true);
    assert.equal(snapshot.cancelKey, 'human-stop-key');
    assert.equal(snapshot.activeSourceUserSeq, 1);
    assert.deepEqual(snapshot.messages.find(message => message.id === active.id), active);
    const reports = snapshot.messages.filter(message => message.text === 'The separate fixture report is saved.');
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0]?.terminal?.evidenceRefs, [{ kind: 'artifact', id: 'fixture-artifact' }]);
    assert.equal(reports[0]?.terminal?.review, 'checked');
    assert.equal(reports[0]?.terminal?.reviewNote, 'The fixture artifact was read back.');
    assert.equal(transport.closeCount, 0, 'a side report never closes the human stream');
    transport.live!.onEvent(event(0, 'stream_token', { sourceUserSeq: 1, delta: ' the original request.' }));
    transport.live!.onEvent(terminal(8, 1, 'The original fixture analysis is complete.'));
    snapshot = engine.snapshot();
    assert.equal(snapshot.busy, false);
    assert.equal(snapshot.cancelKey, null);
    assert.equal(snapshot.messages.find(message => message.id === active.id)?.text, 'The original fixture analysis is complete.');
    assert.equal(snapshot.messages.filter(message => message.text === 'The separate fixture report is saved.').length, 1);
    assert.equal(transport.closeCount, 1, 'the original source still closes its own stream');
  } finally { engine.dispose(); }
});

test('a side report preserves an existing approval and a steering message still being accepted', async () => {
  const transport = new ReportTransport();
  let acceptSteer!: () => void;
  const steering = new Promise<void>(resolve => { acceptSteer = resolve; });
  let sends = 0;
  const engine = new ChatEngine({ sessionId: SESSION, transport, newIdempotencyKey: () => 'source-stop-key',
    streamTimings: { approvalSettleMs: 60_000 }, api: {
      send: async () => { sends += 1; if (sends > 1) await steering;
        return { sessionId: SESSION, accepted: true, ...(sends > 1 ? { steered: true, noteSeq: 9 } : {}) }; },
      loadSession: async () => ({ events: [], latestSeq: 0 }),
    } });
  let steer: Promise<void> | undefined;
  try {
    await engine.send('Finish the original fixture.');
    await tick();
    transport.live!.onEvent(event(1, 'user_input_received', { text: 'Finish the original fixture.' }));
    steer = engine.send('Keep the original format.');
    transport.live!.onEvent(event(2, 'approval_requested', { approvalId: 'apr-fixture', subject: 'Exact fixture write' }));
    const before = engine.snapshot();
    assert.equal(before.messages.find(message => message.steer)?.pending, 'sending');
    assert.ok(before.messages.find(message => message.approval));
    transport.live!.onEvent(input(5));
    transport.live!.onEvent(terminal(6, 5, 'Another saved task finished.', true));
    const after = engine.snapshot();
    assert.deepEqual(after.messages.filter(message => message.approval || message.steer),
      before.messages.filter(message => message.approval || message.steer));
    assert.equal(after.busy, before.busy);
    assert.equal(after.cancelKey, before.cancelKey);
    assert.equal(after.activeSourceUserSeq, before.activeSourceUserSeq);
    assert.equal(transport.closeCount, 0);
  } finally { acceptSteer(); await steer; engine.dispose(); }
});

test('replay keeps foreground activity and pending questions across separate completed reports', () => {
  const human = event(1, 'user_input_received', { text: 'Check the fixture.' });
  const started = { ...event(2, 'tool_called', { tool: 'http_read', callId: 'fixture-read',
    args: { url: 'https://example.test' } }), createdAt: 2_000 };
  const report = terminal(7, 6, 'The background artifact is ready.', true);
  const events = [human, started, input(5, 'passive'), input(6), report];
  assert.equal(inFlightTurnSince(events), 0, 'a report cannot hide unfinished human work on reopen');
  const foregroundDone = terminal(9, 1, 'The foreground fixture answer.');
  const expected = foldTranscript([human, started, foregroundDone], SESSION).find(message => message.text === 'The foreground fixture answer.');
  assert.ok(expected?.activity?.length, 'the foreground owns a real tool activity row to preserve');
  const folded = foldTranscript([...events, foregroundDone], SESSION);
  assert.deepEqual(folded.find(message => message.text === 'The foreground fixture answer.'), expected);
  assert.equal(folded.filter(message => message.text === 'The background artifact is ready.').length, 1);
  assert.equal(inFlightTurnSince([...events, foregroundDone]), null);
  const question = event(3, 'awaiting_user_input', { sourceUserSeq: 1, question: 'Which fixture account?' });
  const questionDone = { ...terminal(9, 1, 'Which fixture account?'), data: { sourceUserSeq: 1,
    reply: 'Which fixture account?', awaitingUser: true, reason: 'awaiting_user_input' } };
  const withQuestion = foldTranscript([human, question, input(6), report, questionDone], SESSION);
  assert.equal(withQuestion.filter(message => message.text === 'Which fixture account?').length, 1);
  assert.equal(withQuestion.filter(message => message.text === 'The background artifact is ready.').length, 1);
});

test('reopening after a side report resumes the still-running human source and later settles it', async () => {
  const transport = new ReportTransport();
  const events = [event(1, 'user_input_received', { text: 'The original fixture request.' }),
    input(5, 'passive'), input(6), terminal(7, 6, 'The background fixture report.', true)];
  const engine = new ChatEngine({ sessionId: SESSION, transport, api: {
    send: async () => ({ sessionId: SESSION, accepted: true }),
    loadSession: async () => ({ events, latestSeq: 7 }),
  } });
  try {
    await engine.open();
    await tick();
    assert.equal(engine.snapshot().busy, true);
    assert.equal(engine.snapshot().activeSourceUserSeq, 1);
    assert.equal(engine.snapshot().messages.filter(message => message.text === 'The background fixture report.').length, 1);
    transport.live!.onEvent(terminal(8, 1, 'The original fixture finished.'));
    assert.equal(engine.snapshot().busy, false);
    assert.equal(engine.snapshot().messages.filter(message => message.text === 'The background fixture report.').length, 1);
    assert.equal(engine.snapshot().messages.find(message => message.text === 'The original fixture finished.')?.status, 'complete');
  } finally { engine.dispose(); }
});

test('a copied or mismatched report marker cannot turn an ordinary human completion into a side report', async () => {
  const transport = new ReportTransport();
  const engine = new ChatEngine({ sessionId: SESSION, transport, api: {
    send: async () => ({ sessionId: SESSION, accepted: true }),
    loadSession: async () => ({ events: [], latestSeq: 0 }),
  } });
  try {
    await engine.send('An ordinary fixture turn.');
    await tick();
    const human = event(1, 'user_input_received', { text: 'An ordinary fixture turn.', backgroundOutcomeReport: marker(1) });
    transport.live!.onEvent(human);
    assert.equal(engine.snapshot().activeSourceUserSeq, 1);
    const done = terminal(3, 1, 'The ordinary fixture answer.');
    done.data = { ...done.data, backgroundOutcomeReport: marker(2) };
    transport.live!.onEvent(done);
    assert.equal(engine.snapshot().busy, false);
    assert.equal(engine.snapshot().messages.find(message => message.text === 'The ordinary fixture answer.')?.status, 'complete');
    assert.equal(transport.closeCount, 1);
    assert.equal(inFlightTurnSince([human, done]), null);
  } finally { engine.dispose(); }
});
