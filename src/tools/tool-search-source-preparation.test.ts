import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSelectedToolSearchSources } from './tool-search-source-preparation.js';
import type { ToolSearchBrokerCandidate, ToolSearchCandidateSource } from './tool-search-tool.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function candidate(name: string): ToolSearchBrokerCandidate {
  return { name, summary: `Read controlled ${name} records`, carrier: 'work_call',
    schema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } };
}

function source(kind: ToolSearchCandidateSource['kind'], prepareCandidates: NonNullable<ToolSearchCandidateSource['prepareCandidates']>): ToolSearchCandidateSource {
  return { kind, search: async () => { throw new Error('preparation must not rediscover'); }, prepareCandidates };
}

test('the second selected source starts before the first is released, and results keep source order', { timeout: 5_000 }, async () => {
  const releaseFirst = deferred();
  const secondStarted = deferred();
  const starts: string[] = [];
  const observations: Array<{ deadlineAt: number; query: string; reuse: boolean; candidates: readonly ToolSearchBrokerCandidate[] }> = [];
  const firstCandidate = candidate('alpha');
  const secondCandidate = candidate('beta');
  const first = source('authorized_external_mcp', async input => {
    starts.push('first');
    observations.push({ deadlineAt: input.deadlineAt, query: input.query, reuse: input.reuseSearchPreparation, candidates: input.candidates });
    await releaseFirst.promise;
    return [firstCandidate];
  });
  const second = source('authorized_composio', async input => {
    starts.push('second');
    observations.push({ deadlineAt: input.deadlineAt, query: input.query, reuse: input.reuseSearchPreparation, candidates: input.candidates });
    secondStarted.resolve();
    return [secondCandidate];
  });
  const brokerDeadlineAt = Date.now() + 1_000;
  const pending = prepareSelectedToolSearchSources({
    selections: [{ source: first, candidates: [firstCandidate] }, { source: second, candidates: [secondCandidate] }],
    query: 'read controlled records', reuseSearchPreparation: false, brokerDeadlineAt, preparationBudgetMs: 10_000,
  });
  try {
    await secondStarted.promise;
    assert.deepEqual(starts, ['first', 'second']);
    assert.equal(observations[0]!.deadlineAt, brokerDeadlineAt);
    assert.equal(observations[1]!.deadlineAt, brokerDeadlineAt, 'both adapters consume the same broker deadline');
    assert.deepEqual(observations.map(row => [row.query, row.reuse]), [['read controlled records', false], ['read controlled records', false]]);
    assert.deepEqual(observations.map(row => row.candidates), [[firstCandidate], [secondCandidate]]);
  } finally { releaseFirst.resolve(); }
  const outcomes = await pending;
  assert.deepEqual(outcomes, [
    { source: first, prepared: [firstCandidate], expired: false },
    { source: second, prepared: [secondCandidate], expired: false },
  ]);
});

test('one source failure preserves the other exact definition without rediscovery', async () => {
  const exact = candidate('healthy');
  const failed = source('authorized_external_mcp', async () => { throw new Error('definition unavailable'); });
  const healthy = source('authorized_composio', async () => [exact]);
  const outcomes = await prepareSelectedToolSearchSources({
    selections: [{ source: failed, candidates: [candidate('failed')] }, { source: healthy, candidates: [exact] }],
    query: 'read controlled records', reuseSearchPreparation: true,
    brokerDeadlineAt: Date.now() + 10_000, preparationBudgetMs: 1_000,
  });
  assert.deepEqual(outcomes, [
    { source: failed, prepared: [], expired: false },
    { source: healthy, prepared: [exact], expired: false },
  ]);
});

test('the shared deadline aborts outstanding reads and rejects their late publication', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const started = deferred();
  const releaseLate = deferred();
  const lateFinished = deferred();
  const healthySettled = deferred();
  let lateSignal: AbortSignal | undefined;
  let publications = 0;
  const exact = candidate('late');
  const slow = source('authorized_external_mcp', async ({ signal, deadlineAt }) => {
    lateSignal = signal;
    started.resolve();
    await releaseLate.promise;
    if (!signal?.aborted && Date.now() < deadlineAt) publications++;
    lateFinished.resolve();
    return [exact];
  });
  const healthy = source('authorized_composio', async ({ signal }) => {
    signal!.addEventListener('abort', () => healthySettled.resolve(), { once: true });
    return [candidate('healthy')];
  });
  const pending = prepareSelectedToolSearchSources({
    selections: [{ source: slow, candidates: [exact] }, { source: healthy, candidates: [candidate('healthy')] }],
    query: 'read controlled records', reuseSearchPreparation: true,
    brokerDeadlineAt: Date.now() + 100, preparationBudgetMs: 1_000,
  });
  await started.promise;
  await healthySettled.promise;
  t.mock.timers.tick(100);
  const outcomes = await pending;
  assert.equal(lateSignal?.aborted, true);
  assert.deepEqual(outcomes[0], { source: slow, prepared: [], expired: true });
  assert.deepEqual(outcomes[1], { source: healthy, prepared: [candidate('healthy')], expired: false });
  releaseLate.resolve();
  await lateFinished.promise;
  assert.equal(publications, 0, 'a detached read cannot publish after its deadline');
  assert.deepEqual(outcomes[0]!.prepared, [], 'late returned definitions never enter the accepted page');
});

test('owner cancellation reaches every selected source and their late returns remain empty', async () => {
  const owner = new AbortController();
  const bothStarted = deferred();
  const release = deferred();
  const bothFinished = deferred();
  const signals: AbortSignal[] = [];
  let finished = 0;
  const prepare: NonNullable<ToolSearchCandidateSource['prepareCandidates']> = async ({ signal }) => {
    signals.push(signal!);
    if (signals.length === 2) bothStarted.resolve();
    await release.promise;
    if (++finished === 2) bothFinished.resolve();
    return [candidate('cancelled')];
  };
  const first = source('authorized_external_mcp', prepare);
  const second = source('authorized_composio', prepare);
  const pending = prepareSelectedToolSearchSources({
    selections: [{ source: first, candidates: [candidate('first')] }, { source: second, candidates: [candidate('second')] }],
    query: 'read controlled records', reuseSearchPreparation: false,
    brokerDeadlineAt: Date.now() + 10_000, preparationBudgetMs: 1_000, signal: owner.signal,
  });
  await bothStarted.promise;
  owner.abort('owner ended this invocation');
  const outcomes = await pending;
  assert.equal(signals.every(signal => signal.aborted), true);
  assert.deepEqual(outcomes, [
    { source: first, prepared: [], expired: true }, { source: second, prepared: [], expired: true },
  ]);
  release.resolve();
  await bothFinished.promise;
  assert.equal(outcomes.every(outcome => outcome.prepared.length === 0), true);
});

test('an exhausted or cancelled broker never starts preparation', async () => {
  let calls = 0;
  const selected = source('authorized_external_mcp', async () => { calls++; return [candidate('unused')]; });
  const selection = { source: selected, candidates: [candidate('unused')] };
  const owner = new AbortController();
  owner.abort();
  for (const signal of [undefined, owner.signal]) {
    const outcomes = await prepareSelectedToolSearchSources({
      selections: [selection], query: 'read controlled records', reuseSearchPreparation: false,
      brokerDeadlineAt: signal ? Date.now() + 10_000 : Date.now(), preparationBudgetMs: 1_000, signal,
    });
    assert.deepEqual(outcomes, [{ source: selected, prepared: [], expired: true }]);
  }
  assert.equal(calls, 0);
});

test('cancellation before the scheduled reads begin does not invoke an adapter', async () => {
  const owner = new AbortController();
  let calls = 0;
  const selected = source('authorized_external_mcp', async () => { calls++; return [candidate('unused')]; });
  const pending = prepareSelectedToolSearchSources({
    selections: [{ source: selected, candidates: [candidate('unused')] }],
    query: 'read controlled records', reuseSearchPreparation: false,
    brokerDeadlineAt: Date.now() + 10_000, preparationBudgetMs: 1_000, signal: owner.signal,
  });
  owner.abort();
  assert.deepEqual(await pending, [{ source: selected, prepared: [], expired: true }]);
  assert.equal(calls, 0);
});

test('adapters sharing a source namespace retain their ordered preparation boundary', { timeout: 5_000 }, async () => {
  const releaseFirst = deferred();
  const independentStarted = deferred();
  const starts: string[] = [];
  const first = source('authorized_external_mcp', async () => {
    starts.push('first');
    await releaseFirst.promise;
    return [candidate('first')];
  });
  const sameKind = source('authorized_external_mcp', async () => { starts.push('same-kind'); return [candidate('same-kind')]; });
  const independent = source('authorized_composio', async () => {
    starts.push('independent');
    independentStarted.resolve();
    return [candidate('independent')];
  });
  const pending = prepareSelectedToolSearchSources({
    selections: [first, sameKind, independent].map(source => ({ source, candidates: [candidate(source.kind)] })),
    query: 'read controlled records', reuseSearchPreparation: true,
    brokerDeadlineAt: Date.now() + 10_000, preparationBudgetMs: 10_000,
  });
  try {
    await independentStarted.promise;
    assert.deepEqual(starts, ['first', 'independent']);
  } finally { releaseFirst.resolve(); }
  const outcomes = await pending;
  assert.deepEqual(starts, ['first', 'independent', 'same-kind']);
  assert.deepEqual(outcomes.map(outcome => outcome.source), [first, sameKind, independent]);
});
