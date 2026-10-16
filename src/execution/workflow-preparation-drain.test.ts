/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-preparation-drain.test.ts
 *
 * Preparation is part of a queued run's lifecycle. An unavailable reading or
 * exact-run Stop must settle before execution, rather than leave a queued run
 * that spends another reading every time the real drain ticks.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-preparation-drain-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMENTINE_WORKFLOW_CANCEL_POLL_MS = '20';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-preparation-drain-fixture\n');

const runner = await import('./workflow-runner.js');
const reading = await import('./workflow-step-effect-reading.js');
const { requestWorkflowRunCancellation } = await import('./workflow-run-cancellation.js');
const { readWorkflow, writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { loadNotifications } = await import('../runtime/notifications.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');

test.afterEach(() => {
  reading._setWorkflowStepEffectReaderForTests(null);
  runner._setWorkflowHarnessLoopImplsForTests();
  runner._setWorkflowVoiceRewriteForTests(null);
  runner._setWorkflowWatcherForTests(null);
  runner._setWorkflowDiagnosisForTests(null);
});
test.after(() => {
  closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function queuedFixture(slug: string) {
  const name = `FRAMEWORK-TEST Preparation ${slug}`;
  const step = {
    id: 'prepare_note',
    prompt: `Create a controlled unsent draft for the ${slug} fixture.`,
    allowedTools: ['task_list'],
  };
  const saved = writeWorkflow(`framework-test-preparation-${slug}`, {
    name,
    description: 'Disposable queued-run effect preparation fixture.',
    enabled: true,
    trigger: { manual: true },
    steps: [step],
  });
  const definitionBefore = readWorkflow(saved.name)!.data;
  const runId = `framework-test-preparation-${slug}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: runId, workflow: name, status: 'queued', inputs: {}, createdAt: new Date().toISOString(),
  }));
  let executions = 0;
  const executionForbidden = async () => {
    executions++;
    throw new Error('Preparation must settle before any step or provider dispatch.');
  };
  runner._setWorkflowHarnessLoopImplsForTests({
    configureRuntime: executionForbidden as never,
    runConversation: executionForbidden as never,
    runConversationFromResume: executionForbidden as never,
    prepareExternalCatalog: executionForbidden as never,
  });
  // Failures must not accidentally reach a report rewrite or diagnostic model.
  runner._setWorkflowVoiceRewriteForTests(async body => {
    executions++;
    return { message: body, nothingHappened: false };
  });
  runner._setWorkflowWatcherForTests(async () => {
    executions++;
    return { onTrack: true, miss: '', steer: '' };
  });
  runner._setWorkflowDiagnosisForTests(async () => { executions++; return null; });
  const drain = () => runner.processWorkflowRuns({ respond: executionForbidden } as never);
  const record = () => JSON.parse(readFileSync(runFile, 'utf8')) as Record<string, any>;
  const notices = () => loadNotifications().filter(row => row.metadata?.runId === runId);
  return { step, saved, runId, runFile, definitionBefore, drain, record, notices, executions: () => executions };
}

test('unavailable queued preparation settles once and later real drain ticks spend no further reading', async () => {
  reading._resetWorkflowStepEffectReadingsForTests();
  const fixture = queuedFixture('unavailable');
  let reads = 0;
  reading._setWorkflowStepEffectReaderForTests(async () => {
    reads++;
    throw new Error('Controlled classification unavailable.');
  });

  await fixture.drain();
  const terminal = fixture.record();
  assert.equal(reads, 1, 'the fixture reached the semantic preparation once');
  assert.equal(terminal.id, fixture.runId);
  assert.equal(terminal.status, 'error');
  assert.ok(terminal.finishedAt);
  assert.match(terminal.error, /could not be checked before execution/);
  assert.match(terminal.error, /Test this saved version again/);
  assert.equal(terminal.needsAttention, true);
  assert.equal(terminal.blockedSteps[0].stepId, '(preparation)');
  assert.equal(fixture.notices().length, 1, 'the exact failed run has one useful outcome');
  const settledBytes = readFileSync(fixture.runFile, 'utf8');

  // A now-healthy reader cannot silently retry a terminal occurrence.
  reading._setWorkflowStepEffectReaderForTests(async () => { reads++; return { effect: 'read' }; });
  await fixture.drain();
  await fixture.drain();
  assert.equal(reads, 1);
  assert.equal(reading.workflowStepEffectReadsMade(), 1);
  assert.equal(fixture.executions(), 0);
  assert.equal(reading.savedStepEffect(fixture.step), undefined);
  assert.equal(readFileSync(fixture.runFile, 'utf8'), settledBytes, 'later ticks do not rewrite terminal truth');
  assert.equal(fixture.notices().length, 1);
  assert.deepEqual(readWorkflow(fixture.saved.name)!.data, fixture.definitionBefore);
});

test('Stop during queued preparation settles the exact run and ignores a late reading on repeated ticks', { timeout: 20_000 }, async () => {
  reading._resetWorkflowStepEffectReadingsForTests();
  const fixture = queuedFixture('stopped');
  const entered = deferred<void>();
  const answer = deferred<unknown>();
  let reads = 0;
  let producerSignal: AbortSignal | undefined;
  reading._setWorkflowStepEffectReaderForTests(async (_user, controls) => {
    reads++;
    producerSignal = controls.signal;
    entered.resolve();
    return answer.promise; // Deliberately ignores abort, like a late SDK reply.
  });
  const draining = fixture.drain();
  try {
    await entered.promise;
    const stop = requestWorkflowRunCancellation(fixture.runId, 'Controlled Stop during effect preparation.', 'framework-test');
    await draining;
    const terminal = fixture.record();
    assert.equal(terminal.id, fixture.runId);
    assert.equal(terminal.status, 'cancelled');
    assert.equal(terminal.cancelledAt, stop.requestedAt);
    assert.equal(terminal.finishedAt, stop.requestedAt);
    assert.equal(terminal.error, stop.reason);
    assert.equal(producerSignal?.aborted, true);
    assert.equal(fixture.notices().length, 1);
    assert.equal(fixture.notices()[0]!.metadata?.status, 'cancelled');
    const settledBytes = readFileSync(fixture.runFile, 'utf8');

    answer.resolve({ effect: 'read' });
    await tick(); await tick();
    await fixture.drain();
    await fixture.drain();
    assert.equal(reads, 1);
    assert.equal(reading.workflowStepEffectReadsMade(), 1);
    assert.equal(reading.savedStepEffect(fixture.step), undefined, 'a late stopped producer cannot cache permission-like planning data');
    assert.equal(fixture.executions(), 0);
    assert.equal(readFileSync(fixture.runFile, 'utf8'), settledBytes);
    assert.equal(fixture.notices().length, 1);
    assert.deepEqual(readWorkflow(fixture.saved.name)!.data, fixture.definitionBefore);
  } finally {
    answer.resolve({ effect: 'read' });
    await draining;
  }
});
