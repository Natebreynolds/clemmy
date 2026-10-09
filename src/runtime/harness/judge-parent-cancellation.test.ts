import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withJudgeHedge } from './judge-family.js';

const abortReason = () => new DOMException('fixture caller cancellation', 'AbortError');

test('an already cancelled parent starts neither judge transport', async () => {
  const parent = new AbortController();
  const reason = abortReason();
  parent.abort(reason);
  let calls = 0;
  await assert.rejects(withJudgeHedge(async () => { calls++; return 'primary'; },
    async () => { calls++; return 'hedge'; }, { lane: 'completion', signal: parent.signal }), error => error === reason);
  assert.equal(calls, 0);
});

test('parent cancellation stops the primary and clears the delayed hedge', async () => {
  const parent = new AbortController();
  const reason = abortReason();
  let primarySignal: AbortSignal | undefined;
  let hedgeCalls = 0;
  const pending = withJudgeHedge(signal => {
    primarySignal = signal;
    return new Promise<string>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, async () => { hedgeCalls++; return 'hedge'; },
  { lane: 'completion', signal: parent.signal, hedgeDelayMs: 25, timeoutMs: 500 });
  const rejection = assert.rejects(pending, error => error === reason);
  parent.abort(reason);
  await rejection;
  assert.equal(primarySignal?.aborted, true);
  assert.equal(primarySignal?.reason, reason);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(hedgeCalls, 0, 'neither cancellation nor a late hedge timer launches a reviewer');
});

test('parent cancellation aborts both started transports and ignores late answers', async () => {
  const prior = process.env.CLEMMY_JUDGE_HEDGE;
  process.env.CLEMMY_JUDGE_HEDGE = 'on';
  try {
    const parent = new AbortController();
    const reason = abortReason();
    const signals: AbortSignal[] = [];
    const lateAnswers: Array<(value: string) => void> = [];
    let hedgeStarted!: () => void;
    const started = new Promise<void>(resolve => { hedgeStarted = resolve; });
    const attempt = (signal?: AbortSignal) => new Promise<string>(resolve => {
      signals.push(signal!); lateAnswers.push(resolve);
      if (signals.length === 2) hedgeStarted();
    });
    const pending = withJudgeHedge(attempt, attempt, { lane: 'completion', signal: parent.signal, hedgeDelayMs: 5, timeoutMs: 500 });
    const rejection = assert.rejects(pending, error => error === reason);
    await started;
    parent.abort(reason);
    await rejection;
    assert.equal(signals.length, 2);
    assert.ok(signals.every(signal => signal.aborted && signal.reason === reason));
    lateAnswers.forEach(resolve => resolve('late DONE'));
    await Promise.resolve();
    await assert.rejects(pending, error => error === reason, 'late success cannot change caller cancellation into acceptance');
  } finally {
    if (prior === undefined) delete process.env.CLEMMY_JUDGE_HEDGE;
    else process.env.CLEMMY_JUDGE_HEDGE = prior;
  }
});

test('a settled verdict removes its parent listener and remains unchanged after later cancellation', async () => {
  const parent = new AbortController();
  let winnerSignal: AbortSignal | undefined;
  const result = await withJudgeHedge(async signal => { winnerSignal = signal; return 'already reviewed'; }, null,
    { lane: 'completion', signal: parent.signal, timeoutMs: 500 });
  parent.abort(abortReason());
  assert.deepEqual(result, { value: 'already reviewed', winner: 'primary', hedgeFired: false, errors: [] });
  assert.equal(winnerSignal?.aborted, false, 'cancellation cannot rewrite or cancel the completed winning attempt');
});
