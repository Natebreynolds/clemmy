import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canOfferStandingSendTrust,
  queuedPendingActionProgress,
  startQueuedPendingActionPolling,
  reconcilePendingActionExecutionFailure,
  resolvePendingActionExecutionPresentation,
  type PendingActionExecuteResult,
} from './pendingActions';

const queuedBinding = {
  id: 'pa-one', approvalId: 'apr-one', payloadHash: 'sha256:one', updatedAt: '2026-10-19T20:00:00.000Z',
};

function statusSnapshot(status: string, updatedAt = '2026-10-19T20:00:01.000Z') {
  const resultSummary = status === 'executed' ? 'Updated 1 record.' : null;
  return { ok: true, status, resultSummary, pendingAction: { ...queuedBinding, status, updatedAt, resultSummary } };
}

function pollClock() {
  const scheduled: { run: () => void; delay: number; cancelled: boolean }[] = [];
  return {
    scheduled,
    schedule(run: () => void, delay: number) {
      const tick = { run, delay, cancelled: false };
      scheduled.push(tick);
      return () => { tick.cancelled = true; };
    },
    next() {
      const tick = scheduled.shift();
      assert.ok(tick, 'a next read must be scheduled');
      if (!tick.cancelled) tick.run();
      return tick;
    },
  };
}

async function finishRead() { await Promise.resolve(); await Promise.resolve(); }

test('queued status cannot attach a different action result to this card', () => {
  const snapshot = statusSnapshot('executed');
  snapshot.pendingAction.id = 'pa-foreign';
  assert.equal(queuedPendingActionProgress(snapshot, queuedBinding), null);
});

test('queued polling serializes slow reads and fences a terminal before another read can start', async () => {
  const clock = pollClock();
  const progress: unknown[] = [];
  let reads = 0;
  let finish!: (snapshot: ReturnType<typeof statusSnapshot>) => void;
  const stop = startQueuedPendingActionPolling(queuedBinding, () => {
    reads += 1;
    return new Promise<ReturnType<typeof statusSnapshot>>((resolve) => { finish = resolve; });
  }, (value) => progress.push(value), { schedule: clock.schedule });
  const firstTick = clock.next();
  firstTick.run();
  assert.equal(reads, 1);
  assert.equal(clock.scheduled.length, 0, 'no timer can overlap the unresolved read');
  finish(statusSnapshot('executed'));
  await finishRead();
  assert.deepEqual(progress, [{ mode: 'durable', phase: 'executed', note: 'Updated 1 record.' }]);
  assert.equal(clock.scheduled.length, 0, 'terminal truth is latched before React cleans up');
  firstTick.run();
  assert.equal(reads, 1, 'even a retained callback cannot read after the terminal');
  stop();
});

test('queued progress requires the exact action, approval, payload, revision and consistent durable fields', () => {
  const variants = [
    { pendingAction: undefined },
    { ok: false },
    { pendingAction: { ...statusSnapshot('executed').pendingAction, id: 'pa-foreign' } },
    { pendingAction: { ...statusSnapshot('executed').pendingAction, approvalId: 'apr-other' } },
    { pendingAction: { ...statusSnapshot('executed').pendingAction, payloadHash: 'sha256:changed' } },
    { pendingAction: { ...statusSnapshot('executed').pendingAction, updatedAt: '2026-10-19T19:59:59.999Z' } },
    { pendingAction: { ...statusSnapshot('executed').pendingAction, updatedAt: 'not-a-revision' } },
    { pendingAction: { ...statusSnapshot('executed').pendingAction, status: 'executing' } },
    { pendingAction: { ...statusSnapshot('executed').pendingAction, resultSummary: 'Foreign receipt.' } },
  ];
  for (const variant of variants) {
    assert.equal(queuedPendingActionProgress({ ...statusSnapshot('executed'), ...variant }, queuedBinding), null);
  }
  for (const status of ['executed', 'failed', 'rejected', 'expired', 'cancelled'] as const) {
    assert.equal(queuedPendingActionProgress(statusSnapshot(status), queuedBinding)?.phase, status);
  }
});

test('queued polling refuses older revisions and impossible pre-dispatch states after seeing an execution claim', async () => {
  const clock = pollClock();
  const progress: { phase: string }[] = [];
  const reads = [
    statusSnapshot('executing', '2026-10-19T20:00:02.000Z'),
    statusSnapshot('executed', '2026-10-19T20:00:01.000Z'),
    statusSnapshot('rejected', '2026-10-19T20:00:03.000Z'),
    statusSnapshot('executed', '2026-10-19T20:00:04.000Z'),
  ];
  startQueuedPendingActionPolling(queuedBinding, async () => reads.shift()!, (value) => progress.push(value), { schedule: clock.schedule });
  for (let i = 0; i < 3; i += 1) { clock.next(); await finishRead(); }
  assert.deepEqual(progress, [{ mode: 'durable', phase: 'running' }]);
  clock.next(); await finishRead();
  assert.equal(progress.at(-1)?.phase, 'executed');
  assert.equal(clock.scheduled.length, 0);
});

test('queued polling backs off failed reads, recovers from durable truth, and never changes an unavailable read into failure', async () => {
  const clock = pollClock();
  const progress: { phase: string }[] = [];
  let reads = 0;
  startQueuedPendingActionPolling(queuedBinding, async () => {
    reads += 1;
    if (reads === 1) throw new Error('read unavailable');
    return statusSnapshot(reads === 2 ? 'executing' : 'failed');
  }, (value) => progress.push(value), { schedule: clock.schedule });
  assert.equal(clock.next().delay, 2_500); await finishRead();
  assert.deepEqual(progress, []);
  assert.equal(clock.next().delay, 5_000); await finishRead();
  assert.equal(progress.at(-1)?.phase, 'running');
  assert.equal(clock.next().delay, 2_500); await finishRead();
  assert.equal(progress.at(-1)?.phase, 'failed');
  assert.equal(reads, 3);
  assert.equal(clock.scheduled.length, 0);
});

test('unavailable or foreign queued reads end as bounded unconfirmed truth without any second dispatch', async () => {
  for (const foreign of [false, true]) {
    const clock = pollClock();
    const progress: { phase: string; note?: string }[] = [];
    let reads = 0;
    startQueuedPendingActionPolling(queuedBinding, async () => {
      reads += 1;
      if (!foreign) throw new Error('read unavailable');
      const snapshot = statusSnapshot('executed');
      snapshot.pendingAction.payloadHash = 'sha256:foreign';
      return snapshot;
    }, (value) => progress.push(value), { schedule: clock.schedule });
    for (const delay of [2_500, 5_000, 10_000]) { assert.equal(clock.next().delay, delay); await finishRead(); }
    assert.equal(reads, 3);
    assert.equal(progress.length, 1);
    assert.equal(progress[0].phase, 'uncertain');
    assert.match(progress[0].note ?? '', /do not retry/i);
    assert.equal(clock.scheduled.length, 0);
  }
});

test('unmount cancels queued timers and ignores an outstanding response after a card is replaced', async () => {
  const oldClock = pollClock();
  const progress: unknown[] = [];
  let finish!: (snapshot: ReturnType<typeof statusSnapshot>) => void;
  const stop = startQueuedPendingActionPolling(queuedBinding,
    () => new Promise<ReturnType<typeof statusSnapshot>>((resolve) => { finish = resolve; }),
    (value) => progress.push(value), { schedule: oldClock.schedule });
  oldClock.next();
  stop();
  const newClock = pollClock();
  const replacement = { ...queuedBinding, approvalId: 'apr-revised', payloadHash: 'sha256:revised' };
  const stopReplacement = startQueuedPendingActionPolling(replacement,
    async () => ({ ...statusSnapshot('failed'), pendingAction: { ...statusSnapshot('failed').pendingAction, ...replacement } }),
    (value) => progress.push(value), { schedule: newClock.schedule });
  newClock.next(); await finishRead();
  finish(statusSnapshot('executed')); await finishRead();
  assert.deepEqual(progress, [{ mode: 'durable', phase: 'failed' }]);
  assert.equal(oldClock.scheduled.length, 0);
  stopReplacement();

  let reads = 0;
  const clock = pollClock();
  const cancel = startQueuedPendingActionPolling(queuedBinding, async () => { reads += 1; return statusSnapshot('executed'); },
    () => assert.fail('an unmounted timer cannot update the card'), { schedule: clock.schedule });
  cancel();
  assert.equal(clock.next().cancelled, true);
  assert.equal(reads, 0);
});

test('missing card identity or revision remains unconfirmed without starting an unbound read', () => {
  for (const binding of [
    { ...queuedBinding, approvalId: null }, { ...queuedBinding, id: '' },
    { ...queuedBinding, payloadHash: '' }, { ...queuedBinding, updatedAt: '' },
  ]) {
    const clock = pollClock();
    const progress: { phase: string }[] = [];
    startQueuedPendingActionPolling(binding, async () => assert.fail('no unbound read'),
      (value) => progress.push(value), { schedule: clock.schedule });
    assert.equal(progress[0]?.phase, 'uncertain');
    assert.equal(clock.scheduled.length, 0);
  }
});

test('standing send trust is offered only for recipient-scoped external sends', () => {
  assert.equal(canOfferStandingSendTrust({ kind: 'external_send' }), true);
  assert.equal(canOfferStandingSendTrust({ kind: 'external_write' }), false);
  assert.equal(canOfferStandingSendTrust({ kind: 'deploy' }), false);
  assert.equal(canOfferStandingSendTrust(undefined), false);
});

function skipped(status: string, resultSummary: string | null = null): PendingActionExecuteResult {
  return {
    ok: false,
    status: 'skipped',
    resultSummary: `No second dispatch for ${status}.`,
    record: {
      id: 'pa-one',
      status,
      resultSummary,
      payloadHash: 'sha256:one',
    },
  };
}

test('pending-action UI refreshes a competing execution claim and never asks the model to approve again', async () => {
  let refreshes = 0;
  const presentation = await resolvePendingActionExecutionPresentation(
    skipped('executing'),
    async () => {
      refreshes += 1;
      return {
        ok: true,
        status: 'executed',
        resultSummary: 'Durable provider receipt: message-42.',
      };
    },
  );

  assert.equal(refreshes, 1);
  assert.equal(presentation.mode, 'durable');
  assert.equal(presentation.phase, 'executed');
  assert.equal(presentation.note, 'Durable provider receipt: message-42.');
});

test('pending-action UI treats skipped executed/failed records as durable truth, not conversational follow-ups', async () => {
  for (const [status, phase] of [
    ['executed', 'executed'],
    ['failed', 'failed'],
  ] as const) {
    const presentation = await resolvePendingActionExecutionPresentation(
      skipped(status, `Stored ${status} result.`),
      async () => {
        throw new Error('refresh unavailable');
      },
    );
    assert.equal(presentation.mode, 'durable', `${status} must suppress onApprove`);
    assert.equal(presentation.phase, phase);
    assert.equal(presentation.note, `Stored ${status} result.`);
  }
});

test('pending-action UI preserves the conversational path only for a genuinely non-executable queued card', async () => {
  let refreshes = 0;
  const presentation = await resolvePendingActionExecutionPresentation(
    skipped('queued'),
    async () => {
      refreshes += 1;
      return { ok: true, status: 'queued', resultSummary: null };
    },
  );
  assert.equal(refreshes, 0);
  assert.deepEqual(presentation, { mode: 'conversational', phase: 'idle' });
});

test('pending-action UI polls a competing execution claim until durable terminal truth arrives', async () => {
  const statuses = ['executing', 'executing', 'executed'] as const;
  let refreshes = 0;
  const presentation = await resolvePendingActionExecutionPresentation(
    skipped('executing'),
    async () => ({
      ok: true,
      status: statuses[refreshes++] ?? 'executed',
      resultSummary: refreshes >= 3 ? 'Durable receipt: provider-99.' : null,
    }),
    { pollDelaysMs: [0, 0, 0], wait: async () => {} },
  );

  assert.equal(refreshes, 3);
  assert.deepEqual(presentation, {
    mode: 'durable',
    phase: 'executed',
    note: 'Durable receipt: provider-99.',
  });
});

test('pending-action UI ends bounded executing reconciliation as explicit uncertainty, never a refusal', async () => {
  let refreshes = 0;
  const presentation = await resolvePendingActionExecutionPresentation(
    skipped('executing'),
    async () => {
      refreshes += 1;
      return { ok: true, status: 'executing', resultSummary: null };
    },
    { pollDelaysMs: [0, 0], wait: async () => {} },
  );

  assert.equal(refreshes, 2);
  assert.equal(presentation.mode, 'durable');
  assert.equal(presentation.phase, 'uncertain');
  assert.match(presentation.note ?? '', /outcome is not confirmed/i);
  assert.match(presentation.note ?? '', /do not retry/i);
  assert.doesNotMatch(presentation.note ?? '', /refused|didn.t send/i);
});

test('rejected, expired, and cancelled actions are terminal and never re-enter conversational approval', async () => {
  for (const status of ['rejected', 'expired', 'cancelled'] as const) {
    let refreshes = 0;
    const presentation = await resolvePendingActionExecutionPresentation(
      skipped(status, `Durable ${status}.`),
      async () => {
        refreshes += 1;
        return { ok: true, status, resultSummary: `Durable ${status}.` };
      },
    );
    assert.equal(refreshes, 0);
    assert.deepEqual(presentation, {
      mode: 'durable',
      phase: status,
      note: `Durable ${status}.`,
    });
  }
});

test('terminal rejection does not echo an executor suggestion to approve again', async () => {
  const presentation = await resolvePendingActionExecutionPresentation(
    skipped('rejected'),
    async () => {
      throw new Error('terminal decisions do not refresh');
    },
  );
  assert.deepEqual(presentation, { mode: 'durable', phase: 'rejected' });
});

test('lost approve-execute response reconciles durable execution rather than claiming it did not send', async () => {
  const presentation = await reconcilePendingActionExecutionFailure(
    async () => ({
      ok: true,
      status: 'executed',
      resultSummary: 'Recovered durable receipt: provider-101.',
    }),
    { pollDelaysMs: [0], wait: async () => {} },
  );
  assert.deepEqual(presentation, {
    mode: 'durable',
    phase: 'executed',
    note: 'Recovered durable receipt: provider-101.',
  });
});

test('lost approve-execute response with unavailable durable truth is bounded uncertainty', async () => {
  let refreshes = 0;
  const presentation = await reconcilePendingActionExecutionFailure(
    async () => {
      refreshes += 1;
      throw new Error('connection lost');
    },
    { pollDelaysMs: [0, 0, 0], wait: async () => {} },
  );
  assert.equal(refreshes, 3);
  assert.equal(presentation.phase, 'uncertain');
  assert.match(presentation.note ?? '', /do not retry/i);
  assert.doesNotMatch(presentation.note ?? '', /refused|didn.t send/i);
});

test('a card queued behind a live run shows that and never sends the decision again as chat', async () => {
  // Windows tester 2026-10-19: a skipped answer fell back to chat text, which
  // started a model turn that looped on refused executes.
  let refreshes = 0;
  const presentation = await resolvePendingActionExecutionPresentation({
    ok: true,
    status: 'queued',
    resultSummary: 'Approved. It runs once the current work in this chat ends.',
    record: { id: 'pa-one', status: 'approved', resultSummary: null, payloadHash: 'sha256:one' },
  }, async () => { refreshes += 1; return { ok: true, status: 'approved', resultSummary: null }; });
  assert.deepEqual(presentation, { mode: 'durable', phase: 'queued', note: 'Approved. It runs once the current work in this chat ends.' });
  assert.equal(refreshes, 0);

  assert.equal(queuedPendingActionProgress(statusSnapshot('approved'), queuedBinding), null);
  assert.deepEqual(queuedPendingActionProgress(statusSnapshot('executing'), queuedBinding), { mode: 'durable', phase: 'running' });
  assert.deepEqual(queuedPendingActionProgress(statusSnapshot('executed'), queuedBinding),
    { mode: 'durable', phase: 'executed', note: 'Updated 1 record.' });
});
