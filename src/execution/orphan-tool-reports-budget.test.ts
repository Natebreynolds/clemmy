/**
 * Run: npx tsx --test src/execution/orphan-tool-reports-budget.test.ts
 *
 * The stranded-tool report limiter is completion-aware, not tick-aware:
 * unresolved report turns keep their process slots across daemon sweeps.
 * A session is drained only after a slot is available, and every completed
 * orphan from that session is aggregated into ONE truthful report turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _testOnly_createOrphanReportCoordinator,
  _testOnly_ORPHAN_REPORT_DIRECTIVE_MAX_CHARS,
  sweepOrphanedToolReports,
} from './orphan-tool-reports.js';
import type { OrphanedToolReport } from '../runtime/harness/loop.js';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeQueue(perSession: Record<string, number>): {
  drain: (sessionId: string) => OrphanedToolReport[];
  drainCalls: (sessionId: string) => number;
  remaining: () => Record<string, number>;
} {
  const queue = new Map(Object.entries(perSession));
  const calls = new Map<string, number>();
  return {
    drain: (sessionId) => {
      calls.set(sessionId, (calls.get(sessionId) ?? 0) + 1);
      const n = queue.get(sessionId) ?? 0;
      queue.delete(sessionId);
      return Array.from({ length: n }, (_, i) => ({
        callId: `${sessionId}-call-${i}`,
        toolName: `tool-${i}`,
        directive: `Report exact outcome ${i} for ${sessionId}; durable detail=${sessionId}-detail-${i}.`,
      }));
    },
    drainCalls: (sessionId) => calls.get(sessionId) ?? 0,
    remaining: () => Object.fromEntries(queue),
  };
}

test('100 completed orphans drain through bounded serial chunks without losing detail', async () => {
  const coordinator = _testOnly_createOrphanReportCoordinator(2);
  const q = makeQueue({ big: 100 });
  const fired: OrphanedToolReport[] = [];
  const deps = {
    now: () => Date.now(),
    recentSessionIds: () => ['big'],
    drain: q.drain,
    fire: async (_sessionId: string, report: OrphanedToolReport) => {
      fired.push(report);
    },
  };

  const first = sweepOrphanedToolReports(deps, coordinator);
  assert.equal(first.fired, 1, 'only one chunk for a session is admitted at once');
  assert.equal(first.inFlight, 1);
  assert.equal(fired.length, 1);
  assert.equal(q.drainCalls('big'), 1);
  assert.equal(Object.keys(q.remaining()).length, 0, 'the admitted session is drained atomically');
  await settle();
  for (let pass = 0; pass < 10 && coordinator.snapshot().pending > 0; pass += 1) {
    const next = sweepOrphanedToolReports(deps, coordinator);
    assert.equal(next.fired, 1, 'remaining chunks advance one at a time');
    await settle();
  }

  assert.equal(fired.length, 5, 'the count cap bounds 100 outcomes to five serial turns');
  assert.ok(
    fired.every((report) => report.directive.length <= _testOnly_ORPHAN_REPORT_DIRECTIVE_MAX_CHARS),
    'every model input stays under the hard character cap',
  );
  const retained = fired.map((report) => report.directive).join('\n');
  for (let i = 0; i < 100; i += 1) {
    assert.match(retained, new RegExp(`big-detail-${i}(?:\\D|$)`));
  }
  assert.equal(coordinator.snapshot().inFlight, 0);
  assert.equal(coordinator.snapshot().pending, 0);
});

test('character-heavy evidence is split below the hard cap and every detail marker survives', async () => {
  const coordinator = _testOnly_createOrphanReportCoordinator(1);
  const detailMarkers = Array.from({ length: 80 }, (_, index) => `heavy-detail-${index}`);
  const reports = detailMarkers.map((marker, index) => ({
    callId: `heavy-call-${index}`,
    toolName: 'heavy-tool',
    directive: `${marker}:${'x'.repeat(700)}`,
  }));
  let drained = false;
  const fired: OrphanedToolReport[] = [];
  const deps = {
    now: () => Date.now(),
    recentSessionIds: () => ['heavy'],
    drain: () => {
      if (drained) return [];
      drained = true;
      return reports;
    },
    fire: async (_sessionId: string, report: OrphanedToolReport) => {
      fired.push(report);
    },
  };

  for (let pass = 0; pass < 20 && (pass === 0 || coordinator.snapshot().pending > 0); pass += 1) {
    assert.equal(sweepOrphanedToolReports(deps, coordinator).fired, 1);
    await settle();
  }
  assert.ok(fired.length > 4, 'the character cap, not only the count cap, forced chunking');
  assert.ok(fired.every(({ directive }) => directive.length <= _testOnly_ORPHAN_REPORT_DIRECTIVE_MAX_CHARS));
  const retained = fired.map(({ directive }) => directive).join('\n');
  for (const marker of detailMarkers) assert.match(retained, new RegExp(`${marker}:`));
  assert.deepEqual(coordinator.snapshot(), { inFlight: 0, pending: 0 });
});

test('unresolved turns hold process-level capacity across repeated sweeps; later sessions drain on completion', async () => {
  const coordinator = _testOnly_createOrphanReportCoordinator(2);
  const q = makeQueue({ s1: 1, s2: 1, s3: 1, s4: 1 });
  const turns = new Map<string, Deferred>();
  const fired: string[] = [];
  const deps = {
    now: () => Date.now(),
    recentSessionIds: () => ['s1', 's2', 's3', 's4'],
    drain: q.drain,
    fire: (sessionId: string) => {
      fired.push(sessionId);
      const turn = deferred();
      turns.set(sessionId, turn);
      return turn.promise;
    },
  };

  const first = sweepOrphanedToolReports(deps, coordinator);
  assert.deepEqual(fired, ['s1', 's2']);
  assert.deepEqual(first, { fired: 2, inFlight: 2, pending: 2 });
  assert.equal(q.drainCalls('s3'), 0, 'work beyond capacity is not consumed or acknowledged');
  assert.equal(q.drainCalls('s4'), 0);

  for (let tick = 0; tick < 5; tick += 1) {
    const repeated = sweepOrphanedToolReports(deps, coordinator);
    assert.equal(repeated.fired, 0, 'a new daemon tick cannot accumulate more live turns');
    assert.equal(repeated.inFlight, 2);
  }
  assert.deepEqual(fired, ['s1', 's2']);
  assert.equal(q.drainCalls('s3'), 0);

  turns.get('s1')!.resolve();
  await settle();
  const afterOneCompletion = sweepOrphanedToolReports(deps, coordinator);
  assert.equal(afterOneCompletion.fired, 1);
  assert.deepEqual(fired, ['s1', 's2', 's3']);
  assert.equal(afterOneCompletion.inFlight, 2, 'the released slot admits exactly one later session');
  assert.equal(q.drainCalls('s4'), 0);

  turns.get('s2')!.resolve();
  turns.get('s3')!.resolve();
  await settle();
  const finalAdmission = sweepOrphanedToolReports(deps, coordinator);
  assert.equal(finalAdmission.fired, 1);
  assert.deepEqual(fired, ['s1', 's2', 's3', 's4']);

  turns.get('s4')!.resolve();
  await settle();
  assert.deepEqual(coordinator.snapshot(), { inFlight: 0, pending: 0 });
  assert.equal(sweepOrphanedToolReports(deps, coordinator).fired, 0, 'the drained backlog never re-fires');
});

test('a failed report chunk waits for persisted backoff and retries when due after restart', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'clem-orphan-report-backoff-'));
  const outboxFile = path.join(tmp, 'state', 'orphan-tool-report-outbox.json');
  let coordinator = _testOnly_createOrphanReportCoordinator(1, outboxFile);
  const q = makeQueue({ retry: 3 });
  const attempts: OrphanedToolReport[] = [];
  let now = 1_000_000;
  let fail = true;
  const deps = {
    now: () => now,
    // The failed batch must remain retryable even if the source session falls
    // outside the recent-session query before the next sweep.
    recentSessionIds: () => attempts.length === 0 ? ['retry'] : [],
    drain: q.drain,
    fire: async (_sessionId: string, report: OrphanedToolReport) => {
      attempts.push(report);
      if (fail) throw new Error('brain lane temporarily unavailable');
    },
  };

  assert.equal(sweepOrphanedToolReports(deps, coordinator).fired, 1);
  await settle();
  assert.deepEqual(coordinator.snapshot(), { inFlight: 0, pending: 1 });
  assert.equal(q.drainCalls('retry'), 1);

  const persisted = JSON.parse(readFileSync(outboxFile, 'utf-8')) as {
    batches: Array<{ chunks: Array<{ attempts: number; nextAttemptAtMs: number }> }>;
  };
  assert.equal(persisted.batches[0].chunks[0].attempts, 1);
  assert.equal(persisted.batches[0].chunks[0].nextAttemptAtMs, now + 30_000);

  coordinator = _testOnly_createOrphanReportCoordinator(1, outboxFile);
  fail = false;
  assert.equal(sweepOrphanedToolReports(deps, coordinator).fired, 0, 'restart cannot bypass the persisted retry time');
  now += 29_999;
  assert.equal(sweepOrphanedToolReports(deps, coordinator).fired, 0, 'the chunk does not retry before it is due');
  now += 1;
  assert.equal(sweepOrphanedToolReports(deps, coordinator).fired, 1, 'the exact retained chunk retries when due');
  await settle();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].directive, attempts[0].directive, 'retry reports the exact retained evidence');
  assert.equal(q.drainCalls('retry'), 1, 'retry never re-drains already acknowledged orphan rows');
  assert.deepEqual(coordinator.snapshot(), { inFlight: 0, pending: 0 });
});

test('retry delay doubles deterministically and caps at fifteen minutes', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'clem-orphan-report-backoff-cap-'));
  const outboxFile = path.join(tmp, 'state', 'orphan-tool-report-outbox.json');
  const coordinator = _testOnly_createOrphanReportCoordinator(1, outboxFile);
  const q = makeQueue({ capped: 1 });
  let now = 2_000_000;
  const expectedDelays = [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000];
  const deps = {
    now: () => now,
    recentSessionIds: () => ['capped'],
    drain: q.drain,
    fire: async () => {
      throw new Error('persistent provider outage');
    },
  };

  for (const [index, expectedDelay] of expectedDelays.entries()) {
    assert.equal(sweepOrphanedToolReports(deps, coordinator).fired, 1);
    await settle();
    const persisted = JSON.parse(readFileSync(outboxFile, 'utf-8')) as {
      batches: Array<{ chunks: Array<{ attempts: number; nextAttemptAtMs: number }> }>;
    };
    const chunk = persisted.batches[0].chunks[0];
    assert.equal(chunk.attempts, index + 1);
    assert.equal(chunk.nextAttemptAtMs, now + expectedDelay);
    assert.equal(sweepOrphanedToolReports(deps, coordinator).fired, 0, 'same-tick retries stay blocked');
    now = chunk.nextAttemptAtMs;
  }
  assert.equal(q.drainCalls('capped'), 1);
});

test('a production claim is acknowledged only after every chunk is present in the outbox', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'clem-orphan-report-claim-order-'));
  const outboxFile = path.join(tmp, 'state', 'orphan-tool-report-outbox.json');
  const coordinator = _testOnly_createOrphanReportCoordinator(1, outboxFile);
  const reports = Array.from({ length: 25 }, (_, index) => ({
    callId: `claimed-${index}`,
    toolName: 'claimed-tool',
    directive: `claimed-detail-${index}`,
  }));
  let acknowledgements = 0;
  const turn = deferred();
  const result = sweepOrphanedToolReports({
    now: () => Date.now(),
    recentSessionIds: () => ['claimed'],
    claim: () => ({
      reports,
      sourceCallIds: reports.map(({ callId }) => callId),
      expiredCallIds: [],
      acknowledge: () => {
        acknowledgements += 1;
        const durable = readFileSync(outboxFile, 'utf-8');
        assert.match(durable, /claimed-detail-0/);
        assert.match(durable, /claimed-detail-24/);
      },
    }),
    fire: () => turn.promise,
  }, coordinator);

  assert.equal(result.fired, 1);
  assert.equal(acknowledgements, 1);
  assert.equal(coordinator.snapshot().inFlight, 1);
  assert.equal(sweepOrphanedToolReports({
    now: () => Date.now(),
    recentSessionIds: () => ['claimed'],
    claim: () => {
      throw new Error('an in-flight session must not be reclaimed');
    },
    fire: () => {
      throw new Error('a second chunk must not overlap');
    },
  }, coordinator).fired, 0);
  assert.equal(acknowledgements, 1);
  turn.resolve();
  await settle();
});

test('a drained aggregate survives daemon restart in the durable outbox and is deleted only after success', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'clem-orphan-report-outbox-'));
  const outboxFile = path.join(tmp, 'state', 'orphan-tool-report-outbox.json');
  const q = makeQueue({ restart: 4 });
  const neverSettles = deferred();

  const beforeCrash = _testOnly_createOrphanReportCoordinator(1, outboxFile);
  const first = sweepOrphanedToolReports({
    now: () => Date.now(),
    recentSessionIds: () => ['restart'],
    drain: q.drain,
    fire: () => neverSettles.promise,
  }, beforeCrash);
  assert.equal(first.fired, 1);
  assert.equal(q.drainCalls('restart'), 1);
  const persistedBeforeCrash = readFileSync(outboxFile, 'utf-8');
  assert.match(persistedBeforeCrash, /restart-detail-0/);
  assert.match(persistedBeforeCrash, /restart-detail-3/);

  // A fresh coordinator models a restarted daemon: no source rows are visible
  // now because the original drain durably acknowledged them. The outbox alone
  // must recover the exact aggregate and retry it.
  const afterRestart = _testOnly_createOrphanReportCoordinator(1, outboxFile);
  const retried: OrphanedToolReport[] = [];
  const recovered = sweepOrphanedToolReports({
    now: () => Date.now(),
    recentSessionIds: () => [],
    drain: () => {
      throw new Error('restart recovery must not re-drain acknowledged source rows');
    },
    fire: async (_sessionId, report) => {
      retried.push(report);
    },
  }, afterRestart);
  assert.equal(recovered.fired, 1);
  await settle();
  assert.equal(retried.length, 1);
  assert.match(retried[0].directive, /restart-detail-0/);
  assert.match(retried[0].directive, /restart-detail-3/);
  assert.deepEqual(afterRestart.snapshot(), { inFlight: 0, pending: 0 });

  const persistedAfterSuccess = JSON.parse(readFileSync(outboxFile, 'utf-8')) as { batches?: unknown[] };
  assert.deepEqual(persistedAfterSuccess.batches, [], 'successful report atomically removes its outbox entry');
});

test('an outbox write failure stops the sweep before any later session is consumed', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'clem-orphan-report-outbox-fail-'));
  const notADirectory = path.join(tmp, 'not-a-directory');
  writeFileSync(notADirectory, 'blocks mkdir');
  const coordinator = _testOnly_createOrphanReportCoordinator(
    2,
    path.join(notADirectory, 'outbox.json'),
  );
  const q = makeQueue({ s1: 1, s2: 1 });
  let persistenceFailures = 0;

  const result = sweepOrphanedToolReports({
    now: () => Date.now(),
    recentSessionIds: () => ['s1', 's2'],
    drain: q.drain,
    fire: () => {
      throw new Error('an unpersisted report must never launch');
    },
    onOutboxFailure: () => { persistenceFailures += 1; },
  }, coordinator);

  assert.equal(result.fired, 0);
  assert.equal(persistenceFailures, 1);
  assert.equal(q.drainCalls('s1'), 1, 'the first consuming drain is retained in process memory');
  assert.equal(q.drainCalls('s2'), 0, 'the sweep stops before consuming work it cannot persist');
  assert.deepEqual(coordinator.snapshot(), { inFlight: 0, pending: 1 });
});
