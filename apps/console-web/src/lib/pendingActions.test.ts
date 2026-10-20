import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canOfferStandingSendTrust,
  pendingActionPresentationCopy,
  pendingActionRecordPresentation,
  pendingActionTerminalResultUpgrade,
  startPendingActionTerminalResultHydration,
  queuedPendingActionProgress,
  startQueuedPendingActionPolling,
  reconcilePendingActionExecutionFailure,
  resolvePendingActionExecutionPresentation,
  type PendingActionExecuteResult,
  type PendingActionExecutionPresentation,
} from './pendingActions';
import type { PendingActionApprovalView, PendingActionPublicResult } from './types';

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

function publicResult(snapshot = statusSnapshot('executed')): PendingActionPublicResult {
  return {
    version: 1, pendingActionId: snapshot.pendingAction.id, approvalId: snapshot.pendingAction.approvalId,
    payloadHash: snapshot.pendingAction.payloadHash, recordUpdatedAt: snapshot.pendingAction.updatedAt,
    status: 'executed', source: 'terminal', text: 'Done — I ran it.\n\nfixture output', terminal: { eventId: 'terminal-B', sourceUserSeq: 2 },
  };
}

function projectedSnapshot(snapshot = statusSnapshot('executed'), source: 'record' | 'terminal' = 'record') {
  return { ...snapshot, pendingAction: { ...snapshot.pendingAction, publicResult: {
    ...publicResult(snapshot), status: snapshot.status as PendingActionPublicResult['status'], source,
    ...(source === 'record' ? { terminal: undefined, text: 'The approved action completed.' } : {}),
  } } };
}

test('settled queued record is enriched by its later canonical answer without reopening execution or overlapping reads', async () => {
  const queueClock = pollClock();
  const progress: PendingActionExecutionPresentation[] = [];
  const queuedReads = [statusSnapshot('executing'), projectedSnapshot()];
  startQueuedPendingActionPolling(queuedBinding, async () => queuedReads.shift()!,
    (value) => progress.push(value), { schedule: queueClock.schedule });
  queueClock.next(); await finishRead();
  queueClock.next(); await finishRead();
  const settled = progress.at(-1)!;
  assert.equal(settled.phase, 'executed');
  assert.equal(queueClock.scheduled.length, 0, 'execution observation remains terminal-fenced');
  const clock = pollClock();
  const enriched: PendingActionExecutionPresentation[] = [];
  let reads = 0;
  let finish!: (snapshot: ReturnType<typeof projectedSnapshot>) => void;
  startPendingActionTerminalResultHydration(settled, () => {
    reads += 1;
    if (reads === 1) return new Promise<ReturnType<typeof projectedSnapshot>>((resolve) => { finish = resolve; });
    return Promise.resolve(projectedSnapshot(statusSnapshot('executed'), 'terminal'));
  }, (value) => enriched.push(value), { observedExecution: true, schedule: clock.schedule });
  const first = clock.next();
  first.run();
  assert.equal(reads, 1);
  assert.equal(clock.scheduled.length, 0);
  finish(projectedSnapshot()); await finishRead();
  assert.equal(enriched.length, 0, 'record-only copy leaves the settled outcome unchanged');
  clock.next(); await finishRead();
  assert.equal(enriched[0]?.phase, 'executed');
  assert.equal(pendingActionPresentationCopy(enriched[0]).note, publicResult().text);
  assert.equal(pendingActionPresentationCopy(enriched[0]).details, 'Updated 1 record.');
  assert.equal(reads, 2);
  assert.equal(clock.scheduled.length, 0);
  first.run();
  assert.equal(reads, 2, 'retained callbacks cannot restart a finished hydration');
});

test('historical record-only terminal cards do not start a GET hydration burst on mount', () => {
  const settled = queuedPendingActionProgress(projectedSnapshot(), queuedBinding)!;
  const clock = pollClock();
  startPendingActionTerminalResultHydration(settled, async () => assert.fail('history must not poll'),
    () => assert.fail('no history hydration'), { schedule: clock.schedule });
  assert.equal(clock.scheduled.length, 0);
});

test('same-bubble canonical props upgrade a settled fallback at the same revision and never downgrade it', () => {
  const settled = queuedPendingActionProgress(projectedSnapshot(), queuedBinding)!;
  const rich = pendingActionRecordPresentation(projectedSnapshot(statusSnapshot('executed'), 'terminal').pendingAction as PendingActionApprovalView)!;
  assert.equal(settled.phase, 'executed');
  assert.equal(pendingActionTerminalResultUpgrade(settled, rich), rich, 'non-idle phase does not block richer same-record props');
  assert.equal(pendingActionTerminalResultUpgrade(rich, settled), null);
  assert.equal(pendingActionTerminalResultUpgrade(rich, rich), null, 'canonical projection is monotonic');
  for (const change of [
    { id: 'pa-foreign' }, { approvalId: 'apr-other' }, { payloadHash: 'foreign' },
    { updatedAt: '2026-10-19T20:00:02.000Z' }, { status: 'failed' },
    { resultSummary: 'Updated 1 record. ' },
  ]) {
    const action = { ...statusSnapshot('executed').pendingAction, ...change };
    const result: PendingActionPublicResult = { ...publicResult(), pendingActionId: action.id,
      approvalId: action.approvalId, payloadHash: action.payloadHash, recordUpdatedAt: action.updatedAt,
      status: action.status as PendingActionPublicResult['status'] };
    const incoming = pendingActionRecordPresentation({ ...action, publicResult: result } as PendingActionApprovalView)!;
    assert.equal(pendingActionTerminalResultUpgrade(settled, incoming), null, JSON.stringify(change));
  }
});

test('late result hydration is bounded and preserves settled failure on unavailable, foreign, stale or inconsistent reads', async () => {
  const settledSnapshot = projectedSnapshot(statusSnapshot('failed'));
  const settled = queuedPendingActionProgress(settledSnapshot, queuedBinding)!;
  for (const kind of ['unavailable', 'foreign', 'stale', 'changed-raw', 'running', 'missing-proof']) {
    const clock = pollClock();
    let reads = 0;
    startPendingActionTerminalResultHydration(settled, async () => {
      reads += 1;
      if (kind === 'unavailable') throw new Error('read unavailable');
      const snapshot = projectedSnapshot(statusSnapshot('failed'), 'terminal');
      if (kind === 'foreign') snapshot.pendingAction.approvalId = 'apr-other';
      if (kind === 'stale') snapshot.pendingAction.updatedAt = queuedBinding.updatedAt;
      if (kind === 'changed-raw') { snapshot.pendingAction.resultSummary = 'changed'; snapshot.resultSummary = 'changed'; }
      if (kind === 'running') { snapshot.status = 'executing'; snapshot.pendingAction.status = 'executing'; }
      if (kind === 'missing-proof') snapshot.pendingAction.publicResult.terminal = undefined;
      return snapshot;
    }, () => assert.fail('unproven enrichment cannot replace the settled failure'), { observedExecution: true, schedule: clock.schedule });
    for (const delay of [250, 750, 1_500, 3_000, 6_000]) { assert.equal(clock.next().delay, delay); await finishRead(); }
    assert.equal(reads, 5);
    assert.equal(clock.scheduled.length, 0);
    assert.equal(settled.phase, 'failed');
  }
});

test('a canonical failure answer enriches details without turning a partial or uncertain effect into success', async () => {
  const snapshot = projectedSnapshot(statusSnapshot('failed'));
  snapshot.pendingAction.resultSummary = 'Connection ended after dispatch; effect uncertain.';
  snapshot.resultSummary = snapshot.pendingAction.resultSummary;
  const settled = queuedPendingActionProgress(snapshot, queuedBinding)!;
  const canonical = projectedSnapshot({ ...snapshot, pendingAction: { ...snapshot.pendingAction } }, 'terminal');
  canonical.pendingAction.publicResult.text = 'The connection ended after the action began. Check the destination before trying again.';
  const progress: PendingActionExecutionPresentation[] = [];
  const clock = pollClock();
  startPendingActionTerminalResultHydration(settled, async () => canonical,
    (value) => progress.push(value), { observedExecution: true, schedule: clock.schedule });
  clock.next(); await finishRead();
  assert.equal(progress[0]?.phase, 'failed');
  assert.deepEqual(pendingActionPresentationCopy(progress[0]), {
    note: canonical.pendingAction.publicResult.text, details: snapshot.resultSummary,
  });
  assert.equal(clock.scheduled.length, 0);
});

test('late result hydration cleanup fences outstanding responses and already-rich or unbound records schedule no read', async () => {
  const settled = queuedPendingActionProgress(projectedSnapshot(), queuedBinding)!;
  const clock = pollClock();
  let finish!: (snapshot: ReturnType<typeof projectedSnapshot>) => void;
  const stop = startPendingActionTerminalResultHydration(settled,
    () => new Promise<ReturnType<typeof projectedSnapshot>>((resolve) => { finish = resolve; }),
    () => assert.fail('a replaced or unmounted card cannot take a late answer'), { observedExecution: true, schedule: clock.schedule });
  clock.next(); stop();
  finish(projectedSnapshot(statusSnapshot('executed'), 'terminal')); await finishRead();
  assert.equal(clock.scheduled.length, 0);
  const cancelledClock = pollClock();
  const cancel = startPendingActionTerminalResultHydration(settled,
    async () => assert.fail('cleanup cancels an unread timer'), () => assert.fail('no unmounted update'),
    { observedExecution: true, schedule: cancelledClock.schedule });
  cancel();
  assert.equal(cancelledClock.next().cancelled, true);
  for (const presentation of [
    queuedPendingActionProgress(projectedSnapshot(statusSnapshot('executed'), 'terminal'), queuedBinding)!,
    queuedPendingActionProgress(statusSnapshot('executed'), queuedBinding)!,
    { mode: 'durable', phase: 'uncertain' } as const,
  ]) {
    const idleClock = pollClock();
    startPendingActionTerminalResultHydration(presentation, async () => assert.fail('no unbound or redundant read'),
      () => assert.fail('no extra presentation'), { observedExecution: true, schedule: idleClock.schedule });
    assert.equal(idleClock.scheduled.length, 0);
  }
});

test('exact public result is primary card copy while raw executor evidence remains in disclosure', async () => {
  const snapshot = statusSnapshot('executed');
  const action = { ...snapshot.pendingAction, resultSummary: 'Executed the approved call. exit_code: 0 stdout: fixture stderr: warning', publicResult: publicResult(snapshot) };
  const presentation = await resolvePendingActionExecutionPresentation({
    ok: true, status: 'executed', resultSummary: 'Executed the approved call. exit_code: 0 stdout: fixture stderr: warning', record: action,
  }, async () => assert.fail('no extra result read'), { card: queuedBinding });
  assert.equal(presentation.phase, 'executed');
  assert.deepEqual(pendingActionPresentationCopy(presentation), {
    note: action.publicResult.text, details: 'Executed the approved call. exit_code: 0 stdout: fixture stderr: warning',
  });
  const hydrated = pendingActionRecordPresentation(action as PendingActionApprovalView)!;
  assert.equal(pendingActionPresentationCopy(hydrated).note, action.publicResult.text);
});

test('foreign or stale public-result coordinates never become primary card text', () => {
  const snapshot = statusSnapshot('executed');
  for (const change of [
    { pendingActionId: 'pa-foreign' }, { approvalId: 'apr-else' }, { payloadHash: 'different' },
    { recordUpdatedAt: queuedBinding.updatedAt }, { status: 'failed' as const },
    { source: 'terminal' as const, terminal: undefined },
  ]) {
    const progress = queuedPendingActionProgress({ ...snapshot,
      pendingAction: { ...snapshot.pendingAction, publicResult: { ...publicResult(snapshot), ...change } },
    }, queuedBinding)!;
    const copy = pendingActionPresentationCopy(progress);
    assert.match(copy.note ?? '', /approved action completed/i);
    assert.doesNotMatch(copy.note ?? '', /fixture output/);
    assert.equal(copy.details, snapshot.resultSummary);
  }
});

test('an exact card cannot consume a foreign execute response or an unrelated reconciliation result', async () => {
  const foreign = { ...statusSnapshot('executed').pendingAction, id: 'pa-foreign' };
  const presentation = await resolvePendingActionExecutionPresentation({ ok: true, status: 'executed', resultSummary: 'Done', record: foreign },
    async () => assert.fail('a foreign result is not an execution retry'), { card: queuedBinding });
  assert.equal(presentation.phase, 'uncertain');
  const reconciled = await reconcilePendingActionExecutionFailure(async () => ({ ...statusSnapshot('executed'), pendingAction: foreign }),
    { card: queuedBinding, pollDelaysMs: [0], wait: async () => {} });
  assert.equal(reconciled.phase, 'uncertain');
});

test('missing/legacy public copy is truthful, and a rich result never loses a trailing warning to the old 240-character cap', () => {
  const failed = pendingActionPresentationCopy({ mode: 'durable', phase: 'failed', note: 'socket failed after dispatch' });
  assert.match(failed.note ?? '', /check what changed/i);
  assert.equal(failed.details, 'socket failed after dispatch');
  assert.doesNotMatch(failed.note ?? '', /nothing ran|nothing changed/i);
  const snapshot = statusSnapshot('executed');
  const rich = { ...publicResult(snapshot), text: `${'Recorded output. '.repeat(30)}The earlier request still has work to verify.` };
  const progress = queuedPendingActionProgress({ ...snapshot, pendingAction: { ...snapshot.pendingAction, publicResult: rich } }, queuedBinding)!;
  assert.equal(pendingActionPresentationCopy(progress).note, rich.text);
});

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
  // Assert this moment's snapshot without narrowing the callback-owned array
  // to never[] before later asynchronous progress arrives.
  assert.deepEqual([...progress], []);
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
