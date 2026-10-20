import assert from 'node:assert/strict';
import test from 'node:test';
import type { PendingActionResultLookup, PendingActionResultRecord } from '@clem/chat-engine';
import { MobileApprovalResultReader } from './chat-approval-result.js';

const owner = { approvalId: 'apr-mobile-result', sessionId: 'sess-card-owner' };
const record: PendingActionResultRecord = {
  id: 'pa-mobile-result', approvalId: owner.approvalId, payloadHash: 'aabbccddeeff0011',
  updatedAt: '2026-10-19T20:00:00.000Z', status: 'executing', resultSummary: 'Dispatch claimed; outcome pending.',
};
const binding = { ...owner, pendingActionId: record.id, payloadHash: record.payloadHash, recordUpdatedAt: record.updatedAt };
const response = (action: PendingActionResultRecord = record) => ({ ...owner, pendingAction: action });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('old-card discovery is explicit, deduplicated while loading, and pins the returned relation', async () => {
  const requests: PendingActionResultLookup[] = [];
  const first = deferred<unknown>();
  const reader = new MobileApprovalResultReader(owner, undefined, async expected => {
    requests.push(expected);
    return requests.length === 1 ? first.promise : response();
  });
  const unsubscribe = reader.subscribe(() => {});
  assert.equal(requests.length, 0, 'rendering a historical card must not fan out reads');
  const loading = reader.refresh();
  await reader.refresh();
  assert.equal(requests.length, 1);
  first.resolve(response());
  await loading;
  assert.deepEqual(reader.snapshot().binding, binding);
  await reader.refresh();
  assert.deepEqual(requests, [owner, binding], 'later reads cannot rediscover a different payload');
  unsubscribe(); reader.dispose();
});

test('a late response after unmount is aborted and cannot publish', async () => {
  const pending = deferred<unknown>();
  let signal: AbortSignal | undefined;
  const reader = new MobileApprovalResultReader(binding, record, async (_expected, requestSignal) => {
    signal = requestSignal;
    return pending.promise;
  });
  const observed: unknown[] = [];
  reader.subscribe(state => observed.push(state));
  const loading = reader.refresh();
  reader.dispose();
  const before = reader.snapshot();
  await loading;
  pending.resolve(response({ ...record, status: 'executed' }));
  await pending.promise;
  await Promise.resolve();
  assert.equal(signal?.aborted, true);
  assert.equal(reader.snapshot(), before);
  assert.equal(observed.length, 2, 'only initial and loading states were published');
});

test('the read deadline clears loading and retains evidence even if transport ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred<unknown>();
  let signal: AbortSignal | undefined;
  const reader = new MobileApprovalResultReader(binding, record, async (_expected, requestSignal) => {
    signal = requestSignal;
    return pending.promise;
  });
  const loading = reader.refresh();
  t.mock.timers.tick(15_000);
  await loading;
  assert.equal(signal?.aborted, true);
  assert.equal(reader.snapshot().loading, false);
  assert.equal(reader.snapshot().record, record);
  assert.match(reader.snapshot().error ?? '', /taking too long/);
  const afterTimeout = reader.snapshot();
  pending.resolve(response({ ...record, status: 'executed' }));
  await pending.promise;
  await Promise.resolve();
  assert.equal(reader.snapshot(), afterTimeout, 'the late answer cannot replace timeout state or evidence');
  reader.dispose();
});

test('revising or changing the card gives it a separate reader; the old response cannot enter it', async () => {
  const pending = deferred<unknown>();
  const oldReader = new MobileApprovalResultReader(binding, record, async () => pending.promise);
  const oldRequest = oldReader.refresh();
  oldReader.dispose();
  const revised = { ...record, id: 'pa-revised', payloadHash: '1122334455667788' };
  const next = new MobileApprovalResultReader({ ...binding, pendingActionId: revised.id, payloadHash: revised.payloadHash }, revised,
    async () => response(revised));
  pending.resolve(response({ ...record, status: 'executed' }));
  await oldRequest;
  assert.equal(next.snapshot().record, revised);
  assert.equal(next.snapshot().loading, false);
  next.dispose();
});

test('foreign or regressive reads retain the known result and disclose refresh failure', async () => {
  const foreign = { ...response(), sessionId: 'sess-different-owner' };
  let value: unknown = foreign;
  const reader = new MobileApprovalResultReader(binding, record, async () => value);
  await reader.refresh();
  assert.equal(reader.snapshot().record, record);
  assert.match(reader.snapshot().error ?? '', /refresh this result/);
  value = response({ ...record, updatedAt: '2026-10-19T19:59:00.000Z' });
  await reader.refresh();
  assert.equal(reader.snapshot().record, record);
  assert.deepEqual(reader.snapshot().binding, binding);
  reader.dispose();
});

test('a result can progress and pin its new revision without another dispatch', async () => {
  const settled = { ...record, status: 'executed', updatedAt: '2026-10-19T20:01:00.000Z', resultSummary: 'Recorded successful result.' };
  const reader = new MobileApprovalResultReader(binding, record, async () => response(settled));
  await reader.refresh();
  assert.equal(reader.snapshot().record?.status, 'executed');
  assert.equal(reader.snapshot().binding?.recordUpdatedAt, settled.updatedAt);
  assert.equal(reader.snapshot().error, null);
  reader.dispose();
});

test('a running record can progress directly to its newly settled terminal answer', async () => {
  const running: PendingActionResultRecord = { ...record, publicResult: {
    version: 1, pendingActionId: record.id, approvalId: owner.approvalId, payloadHash: record.payloadHash,
    recordUpdatedAt: record.updatedAt, status: 'executing', source: 'record', text: 'The outcome is not confirmed yet.',
  } };
  const settled: PendingActionResultRecord = { ...record, status: 'executed', updatedAt: '2026-10-19T20:01:00.000Z',
    resultSummary: 'Raw stdout: fixture', publicResult: {
      version: 1, pendingActionId: record.id, approvalId: owner.approvalId, payloadHash: record.payloadHash,
      recordUpdatedAt: '2026-10-19T20:01:00.000Z', status: 'executed', source: 'terminal', text: 'The fixture completed.',
      terminal: { eventId: 'event-terminal-fixture', sourceUserSeq: 17 },
    } };
  const reader = new MobileApprovalResultReader(binding, running, async () => response(settled));
  await reader.refresh();
  assert.equal(reader.snapshot().record?.publicResult?.text, settled.publicResult?.text);
  assert.equal(reader.snapshot().error, null);
  reader.dispose();
});

test('an error or a same-record fallback cannot replace a known terminal answer', async () => {
  const settled: PendingActionResultRecord = { ...record, status: 'executed', resultSummary: 'Raw stdout: fixture', publicResult: {
    version: 1, pendingActionId: record.id, approvalId: owner.approvalId, payloadHash: record.payloadHash,
    recordUpdatedAt: record.updatedAt, status: 'executed', source: 'terminal', text: 'The fixture completed.',
    terminal: { eventId: 'event-terminal-fixture', sourceUserSeq: 17 },
  } };
  let fail = true;
  const reader = new MobileApprovalResultReader(binding, settled, async () => {
    if (fail) throw new Error('network unavailable');
    return response({ ...settled, publicResult: undefined });
  });
  await reader.refresh();
  assert.equal(reader.snapshot().record, settled);
  assert.ok(reader.snapshot().error);
  fail = false;
  await reader.refresh();
  assert.equal(reader.snapshot().record, settled);
  assert.equal(reader.snapshot().error, null);
  reader.dispose();
});

test('a missing raw owner never starts a result read', async () => {
  let reads = 0;
  const reader = new MobileApprovalResultReader(null, record, async () => { reads += 1; return response(); });
  await reader.refresh();
  assert.equal(reads, 0);
  assert.equal(reader.snapshot().record, record);
  reader.dispose();
});

test('delayed same-card prop evidence cannot downgrade a newer fetched terminal result', async () => {
  const settled = { ...record, status: 'executed', updatedAt: '2026-10-19T20:01:00.000Z', resultSummary: 'Recorded successful result.' };
  const reader = new MobileApprovalResultReader(binding, record, async () => response(settled));
  await reader.refresh();
  reader.reconcile(record, binding);
  assert.equal(reader.snapshot().record?.status, 'executed');
  assert.equal(reader.snapshot().binding?.recordUpdatedAt, settled.updatedAt);
  reader.reconcile({ ...record, payloadHash: 'foreign' }, { ...binding, payloadHash: 'foreign' });
  assert.equal(reader.snapshot().record?.payloadHash, record.payloadHash);
  reader.dispose();
});

test('newer exact prop evidence cancels an outstanding older read before it can publish', async () => {
  const pending = deferred<unknown>();
  const reader = new MobileApprovalResultReader(binding, record, async () => pending.promise);
  const loading = reader.refresh();
  const settled = { ...record, status: 'executed', updatedAt: '2026-10-19T20:01:00.000Z', resultSummary: 'Recorded successful result.' };
  reader.reconcile(settled, { ...binding, recordUpdatedAt: settled.updatedAt });
  await loading;
  assert.equal(reader.snapshot().record?.status, 'executed');
  assert.equal(reader.snapshot().loading, false);
  const before = reader.snapshot();
  pending.resolve(response(record)); await pending.promise; await Promise.resolve();
  assert.equal(reader.snapshot(), before);
  reader.dispose();
});

test('same-revision in-flight enrichment survives a late fallback response or read error', async () => {
  for (const fail of [false, true]) {
    let resolve!: (value: unknown) => void; let reject!: (error: Error) => void;
    const pending = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    const base: PendingActionResultRecord = { ...record, status: 'executed', resultSummary: 'Raw retained fixture.', publicResult: {
      version: 1, pendingActionId: record.id, approvalId: owner.approvalId, payloadHash: record.payloadHash,
      recordUpdatedAt: record.updatedAt, status: 'executed', source: 'record', text: 'The action completed.',
    } };
    const enriched: PendingActionResultRecord = { ...base, publicResult: { ...base.publicResult!, source: 'terminal',
      text: 'Exact retained terminal answer.', terminal: { eventId: 'fixture-final', sourceUserSeq: 15 } } };
    const reader = new MobileApprovalResultReader(binding, base, async () => pending);
    const read = reader.refresh();
    reader.reconcile(enriched, binding);
    if (fail) reject(new Error('Controlled read failure')); else resolve(response(base));
    await read;
    assert.equal(reader.snapshot().record, enriched);
    assert.equal(reader.snapshot().record?.publicResult?.terminal?.eventId, 'fixture-final');
    assert.equal(reader.snapshot().loading, false);
    reader.dispose();
  }
});

function authoredFixture(): PendingActionResultRecord {
  return { ...record, status: 'executed', resultSummary: 'Exact raw retained result.', publicResult: {
    version: 1, pendingActionId: record.id, approvalId: owner.approvalId, payloadHash: record.payloadHash,
    recordUpdatedAt: record.updatedAt, status: 'executed', source: 'authored_projection', text: 'I completed the approved action.',
    terminal: { eventId: 'canonical-approved-terminal', sourceUserSeq: 31 },
    projection: { id: 'projection-mobile-fixture', revision: 1, evidenceDigest: 'a'.repeat(64), textDigest: 'b'.repeat(64), publishedAt: record.updatedAt },
  } };
}
const update = { ...binding, kind: 'approval.result_updated' as const, projectionId: 'projection-mobile-fixture' };
const flushReads = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };

test('one direct-owner live signal enriches an already terminal card; foreign owners and repeats never read', async () => {
  const { subscribeApprovalResultUpdates, publishApprovalResultUpdate } = await import('./approval-result-updates.js');
  const authored = authoredFixture();
  const terminal: PendingActionResultRecord = { ...authored, publicResult: { ...authored.publicResult!, source: 'terminal', projection: undefined, text: 'The approved action completed.' } };
  const reads: PendingActionResultLookup[] = [];
  const reader = new MobileApprovalResultReader(binding, terminal, async expected => { reads.push(expected); return response(authored); });
  const unsubscribe = subscribeApprovalResultUpdates(event => reader.observeResultUpdate(event));
  try {
    assert.equal(reads.length, 0, 'no history-mount fetch');
    publishApprovalResultUpdate({ ...update, sessionId: 'foreign-successor' });
    publishApprovalResultUpdate({ ...update, payloadHash: 'foreign-payload' });
    await flushReads(); assert.equal(reads.length, 0);
    publishApprovalResultUpdate(update); publishApprovalResultUpdate(update);
    await flushReads();
    assert.deepEqual(reads, [binding]);
    assert.deepEqual(reader.snapshot().record, authored);
    publishApprovalResultUpdate(update); await flushReads();
    assert.equal(reads.length, 1, 'the authored tier is settled display evidence, never a poll trigger');
  } finally { unsubscribe(); reader.dispose(); }
});

test('a live projection arriving during an older read gets one follow-up, without a polling loop', async () => {
  const authored = authoredFixture(); const fallback = { ...authored, publicResult: undefined };
  const pending = deferred<unknown>(); let reads = 0;
  const reader = new MobileApprovalResultReader(binding, fallback, async () => ++reads === 1 ? pending.promise : response(authored));
  const explicit = reader.refresh();
  reader.observeResultUpdate(update); reader.observeResultUpdate(update);
  assert.equal(reads, 1);
  pending.resolve(response(fallback)); await explicit; await flushReads();
  assert.equal(reads, 2);
  assert.equal(reader.snapshot().record?.publicResult?.source, 'authored_projection');
  reader.observeResultUpdate(update); await flushReads(); assert.equal(reads, 2);
  reader.dispose();
});

test('failed or mismatched event readback retains the known terminal and never retries automatically', async () => {
  for (const fail of [false, true]) {
    const authored = authoredFixture();
    const terminal: PendingActionResultRecord = { ...authored, publicResult: { ...authored.publicResult!, source: 'terminal', projection: undefined, text: 'The action completed.' } };
    let reads = 0;
    const reader = new MobileApprovalResultReader(binding, terminal, async () => {
      reads++;
      if (fail) throw new Error('Controlled unavailable read');
      return response({ ...authored, publicResult: { ...authored.publicResult!, projection: { ...authored.publicResult!.projection!, id: 'another-projection' } } });
    });
    reader.observeResultUpdate(update); await flushReads(); reader.observeResultUpdate(update); await flushReads();
    assert.equal(reads, 1); assert.equal(reader.snapshot().record, terminal);
    assert.match(reader.snapshot().error ?? '', /refresh this result/);
    reader.dispose();
  }
});
