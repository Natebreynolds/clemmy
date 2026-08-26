import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-worker-batch-'));

const eventlog = await import('../runtime/harness/eventlog.js');
const dispatch = await import('../runtime/harness/dispatch-lease.js');
const batchExecution = await import('./worker-batch-execution.js');

const item = (name: string) => ({ item: name, packetKey: `packet:${name}`, input: name });

test.afterEach(() => {
  batchExecution._resetWorkerBatchExecutionsForTest();
});

test.after(() => {
  eventlog.closeEventLog();
});

test('ordinary batch identity is source-bound and never aliases session-only work', () => {
  const packetKeys = ['packet:a', 'packet:b'];
  const first = batchExecution.workerBatchKey({
    sessionId: 'one-session',
    sourceUserSeq: 11,
    packetKeys,
  });
  const second = batchExecution.workerBatchKey({
    sessionId: 'one-session',
    sourceUserSeq: 12,
    packetKeys,
  });
  assert.notEqual(first, second, 'identical batches under two accepted sources cannot alias');
  assert.throws(
    () => batchExecution.workerBatchKey({ sessionId: 'one-session', packetKeys }),
    batchExecution.WorkerBatchIdentityError,
  );
});

test('existing dispatch ledger CAS never steals by time and boot reconciliation fences crash recovery', () => {
  const sessionId = 'worker-batch-durable-cas';
  eventlog.createSession({ id: sessionId, kind: 'execution' });
  const priorAttempt = eventlog.beginRunAttempt(sessionId, { runId: 'worker-batch-prior-process' });
  const priorParent = dispatch.activateDispatchLease({
    sessionId,
    scopeId: `${sessionId}:prior-parent`,
    runAttemptId: priorAttempt.attemptId,
  });
  const priorOwner = { sessionId, parentLease: priorParent };
  const first = batchExecution.claimWorkerBatchDurableOwnership('batch-cas', priorOwner);

  // Even an arbitrarily old timestamp is not evidence of process death.
  eventlog.openEventLog().prepare(`
    UPDATE run_dispatch_leases SET activated_at = ?
     WHERE scope_id = ? AND lease_id = ?
  `).run('1970-01-01T00:00:00.000Z', first.scopeId, first.leaseId);
  assert.throws(
    () => batchExecution.claimWorkerBatchDurableOwnership('batch-cas', priorOwner),
    batchExecution.WorkerBatchOwnershipConflictError,
  );

  // Terminal state alone also cannot silently steal from a body that might
  // still be unwinding. Only the explicit daemon-boot recovery sweep carries
  // the process-death authority needed to revoke this exact prior attempt.
  eventlog.finishRunAttempt(priorAttempt, 'interrupted');
  const successorAttempt = eventlog.beginRunAttempt(sessionId, { runId: 'worker-batch-successor-process' });
  const successorParent = dispatch.activateDispatchLease({
    sessionId,
    scopeId: `${sessionId}:successor-parent`,
    runAttemptId: successorAttempt.attemptId,
  });
  const successorOwner = { sessionId, parentLease: successorParent };
  assert.throws(
    () => batchExecution.claimWorkerBatchDurableOwnership('batch-cas', successorOwner),
    batchExecution.WorkerBatchOwnershipConflictError,
  );
  assert.equal(batchExecution.reconcileWorkerBatchDurableOwnershipAtBoot(25_001), 1);
  const recovered = batchExecution.claimWorkerBatchDurableOwnership('batch-cas', successorOwner);
  assert.equal(dispatch.isDispatchLeaseCurrent(first), false);
  assert.equal(dispatch.isDispatchLeaseCurrent(recovered), true);
  batchExecution.releaseWorkerBatchDurableOwnership(recovered);
  dispatch.revokeDispatchLease(priorParent);
  dispatch.revokeDispatchLease(successorParent);
  eventlog.finishRunAttempt(successorAttempt, 'completed');
});

test('a second process cannot enter an ordinary batch while the first durable owner is live', async () => {
  const sessionId = 'worker-batch-cross-process';
  eventlog.createSession({ id: sessionId, kind: 'execution' });
  const attempt = eventlog.beginRunAttempt(sessionId, { runId: 'worker-batch-cross-process-owner' });
  const parent = dispatch.activateDispatchLease({
    sessionId,
    scopeId: `${sessionId}:parent`,
    runAttemptId: attempt.attemptId,
  });
  const owner = { sessionId, parentLease: parent };
  const code = `
    const batch = await import('./src/agents/worker-batch-execution.ts');
    const owner = JSON.parse(process.env.CLEMMY_TEST_BATCH_OWNER);
    const lease = batch.claimWorkerBatchDurableOwnership('cross-process-batch', owner);
    process.stdout.write('READY\\n');
    process.stdin.once('data', () => {
      batch.releaseWorkerBatchDurableOwnership(lease);
      process.exit(0);
    });
    process.stdin.resume();
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', code],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLEMMY_TEST_BATCH_OWNER: JSON.stringify(owner),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('READY\n')) resolve();
    });
    child.once('error', reject);
    child.once('exit', (codeValue) => {
      if (!stdout.includes('READY\n')) {
        reject(new Error(`batch owner child exited ${codeValue}: ${stderr}`));
      }
    });
  });

  assert.throws(
    () => batchExecution.claimWorkerBatchDurableOwnership('cross-process-batch', owner),
    batchExecution.WorkerBatchOwnershipConflictError,
  );
  child.stdin.end('release\n');
  await new Promise<void>((resolve, reject) => {
    child.once('exit', (codeValue) => {
      if (codeValue === 0) resolve();
      else reject(new Error(`batch owner child exited ${codeValue}: ${stderr}`));
    });
    child.once('error', reject);
  });

  const successor = batchExecution.claimWorkerBatchDurableOwnership('cross-process-batch', owner);
  batchExecution.releaseWorkerBatchDurableOwnership(successor);
  dispatch.revokeDispatchLease(parent);
  eventlog.finishRunAttempt(attempt, 'completed');
});

test('exact in-process re-entry drains the superseded generation before a successor starts', async () => {
  let firstActive = 0;
  let secondStartedWhileFirstActive = false;
  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
  const first = batchExecution.runResumableWorkerBatch({
    batchKey: 'batch-reentry',
    items: [item('a')],
    maxConcurrency: 1,
    execute: async (_spec, lease) => {
      firstActive += 1;
      firstEntered();
      try {
        await new Promise<void>((_resolve, reject) => {
          const stop = () => reject(lease.signal.reason);
          lease.signal.addEventListener('abort', stop, { once: true });
        });
        return 'unreachable';
      } finally {
        firstActive -= 1;
      }
    },
    failed: () => false,
  });
  const firstRejection = assert.rejects(
    first,
    (error) => error instanceof batchExecution.WorkerBatchGenerationCancelledError
      && error.kind === 'superseded',
  );
  await entered;

  const second = batchExecution.runResumableWorkerBatch({
    batchKey: 'batch-reentry',
    items: [item('a')],
    maxConcurrency: 1,
    execute: async () => {
      secondStartedWhileFirstActive = firstActive > 0;
      return 'new generation result';
    },
    failed: () => false,
  });
  await firstRejection;
  const result = await second;
  assert.equal(result.status, 'complete');
  assert.equal(secondStartedWhileFirstActive, false);
});

test('an abort-ignoring body withholds typed remainder and fails closed after the outer deadline', async () => {
  const sessionId = 'worker-batch-ignore-abort';
  eventlog.createSession({ id: sessionId, kind: 'execution' });
  const attempt = eventlog.beginRunAttempt(sessionId, { runId: 'worker-batch-ignore-abort-owner' });
  const parent = dispatch.activateDispatchLease({
    sessionId,
    scopeId: `${sessionId}:parent`,
    runAttemptId: attempt.attemptId,
  });
  const durableOwner = { sessionId, parentLease: parent };
  let now = 0;
  type Timer = { at: number; active: boolean; fn: () => void };
  const timers: Timer[] = [];
  batchExecution._setWorkerBatchRuntimeForTest({
    now: () => now,
    setTimer: (fn, delayMs) => {
      const timer = { at: now + delayMs, active: true, fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: (raw) => { (raw as Timer).active = false; },
  });
  let releaseBody!: () => void;
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
  const run = batchExecution.runResumableWorkerBatch({
    batchKey: 'batch-ignore-abort',
    items: [item('a')],
    maxConcurrency: 1,
    deadlineAt: 100,
    durableOwner,
    execute: async () => {
      bodyStarted();
      await new Promise<void>((resolve) => { releaseBody = resolve; });
      return 'late result';
    },
    failed: () => false,
  });
  await started;
  now = 99;
  for (const timer of timers) {
    if (timer.active && timer.at <= now) {
      timer.active = false;
      timer.fn();
    }
  }
  const early = await Promise.race([
    run.then(() => 'typed', () => 'rejected'),
    new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
  ]);
  assert.equal(early, 'pending', 'no typed no-orphan remainder can precede body settlement');

  // A body that has ignored its abort remains the durable owner forever; age
  // cannot convert its live claim into successor authority.
  eventlog.openEventLog().prepare(`
    UPDATE run_dispatch_leases SET activated_at = ?
     WHERE scope_id = ? AND revoked_at IS NULL
  `).run('1970-01-01T00:00:00.000Z', 'worker-batch:v1:batch-ignore-abort');
  assert.throws(
    () => batchExecution.claimWorkerBatchDurableOwnership('batch-ignore-abort', durableOwner),
    batchExecution.WorkerBatchOwnershipConflictError,
  );

  now = 100;
  releaseBody();
  await assert.rejects(
    run,
    (error) => error instanceof batchExecution.WorkerBatchGenerationCancelledError
      && error.kind === 'deadline'
      && /withheld/.test(error.message),
  );
  assert.equal(batchExecution._workerBatchObservationCountForTest(), 0);
  dispatch.revokeDispatchLease(parent);
  eventlog.finishRunAttempt(attempt, 'completed');
});

test('deadline parking aborts and drains an admitted body before returning exact pending state', async () => {
  let now = 0;
  type Timer = { at: number; active: boolean; fn: () => void };
  const timers: Timer[] = [];
  batchExecution._setWorkerBatchRuntimeForTest({
    now: () => now,
    setTimer: (fn, delayMs) => {
      const timer = { at: now + delayMs, active: true, fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: (raw) => { (raw as Timer).active = false; },
  });
  let activeBodies = 0;
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
  const run = batchExecution.runResumableWorkerBatch({
    batchKey: 'batch-cooperative-abort',
    items: [item('a')],
    maxConcurrency: 1,
    deadlineAt: 100,
    execute: async (_spec, lease) => {
      activeBodies += 1;
      bodyStarted();
      try {
        await new Promise<void>((_resolve, reject) => {
          const stop = () => reject(lease.signal.reason);
          lease.signal.addEventListener('abort', stop, { once: true });
        });
        return 'unreachable';
      } finally {
        activeBodies -= 1;
      }
    },
    failed: () => false,
  });
  await started;
  now = 99;
  for (const timer of timers) {
    if (timer.active && timer.at <= now) {
      timer.active = false;
      timer.fn();
    }
  }
  const result = await run;
  assert.equal(result.status, 'parked');
  assert.deepEqual(result.remainder, {
    version: 1,
    batchKey: 'batch-cooperative-abort',
    generationId: result.generationId,
    settled: [],
    failed: [],
    in_flight: [],
    pending: ['a'],
  });
  assert.equal(activeBodies, 0, 'typed park follows transport/body settlement');
});

test('observed item requirements retain only a bounded parked LRU and evict on completion', async () => {
  batchExecution._setWorkerBatchRuntimeForTest({
    now: () => 0,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  for (let index = 0; index < 260; index += 1) {
    const result = await batchExecution.runResumableWorkerBatch({
      batchKey: `parked-${index}`,
      items: [item(`item-${index}`)],
      maxConcurrency: 1,
      deadlineAt: 10,
      declaredItemRequirementMs: 20,
      execute: async () => 'must not start',
      failed: () => false,
    });
    assert.equal(result.status, 'parked');
  }
  assert.equal(batchExecution._workerBatchObservationCountForTest(), 256);

  const completed = await batchExecution.runResumableWorkerBatch({
    batchKey: 'parked-259',
    items: [item('item-259')],
    maxConcurrency: 1,
    execute: async () => 'done',
    failed: () => false,
  });
  assert.equal(completed.status, 'complete');
  assert.equal(batchExecution._workerBatchObservationCountForTest(), 255);
});
