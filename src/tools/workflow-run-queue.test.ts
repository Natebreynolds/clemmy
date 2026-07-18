/**
 * Run: npx tsx --test src/tools/workflow-run-queue.test.ts
 *
 * Deterministic core of ask-then-resume: queueWorkflowRun (queue + dedupe) and
 * resumeWorkflowRun (lookup + validate missing inputs + queue). No model calls.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, utimesSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wf-queue-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const {
  queueWorkflowRun,
  queueWorkflowDryRun,
  resumeWorkflowRun,
  requeueWorkflowFromRun,
  requeueWorkflowFailedItemsFromRun,
  queueWorkflowCreationTest,
  readWorkflowTriggerReceiptAcceptance,
  readWorkflowRunOriginSessionIds,
  WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
} = await import('./workflow-run-queue.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { appendWorkflowEvent } = await import('../execution/workflow-events.js');
const {
  executeWorkflowCallMutation,
  WorkflowCallMutationAmbiguousError,
  WorkflowCallMutationProvenFailureError,
} = await import('../execution/workflow-call-receipts.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('./shared.js');

function writeAuditWorkflow(enabled = true): void {
  writeWorkflow('audit-brief', {
    name: 'audit-brief',
    description: 'Audit a site from a URL.',
    enabled,
    trigger: { manual: true },
    steps: [
      { id: 'normalize', prompt: 'Normalize the prospect: {{input.url}}.' },
      { id: 'blast', prompt: 'Analyze this prospect.', dependsOn: ['normalize'], forEach: 'normalize', sideEffect: 'read' },
      { id: 'blast_one', prompt: 'Run the first read-only analysis.', dependsOn: ['normalize'], forEach: 'normalize', sideEffect: 'read' },
      { id: 'blast_two', prompt: 'Run the second read-only analysis.', dependsOn: ['normalize'], forEach: 'normalize', sideEffect: 'read' },
    ],
  });
}

function runFiles(): string[] {
  try { return readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith('.json')); }
  catch { return []; }
}

async function waitForPath(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const QUEUE_MODULE_URL = pathToFileURL(path.join(process.cwd(), 'src/tools/workflow-run-queue.ts')).href;

function launchQueueChild(
  url: string,
  resultFile: string,
  extraEnv: Record<string, string> = {},
) {
  const childCode = `
    import { writeFileSync } from 'node:fs';
    const mod = await import(process.env.CLEM_QUEUE_MODULE_URL);
    try {
      const result = mod.queueWorkflowRun('audit-brief', { url: process.env.CLEM_QUEUE_URL }, {
        ...(process.env.CLEM_QUEUE_ORIGIN ? { originSessionId: process.env.CLEM_QUEUE_ORIGIN } : {}),
        ...(process.env.CLEM_QUEUE_RECEIPT ? { triggerReceiptId: process.env.CLEM_QUEUE_RECEIPT } : {}),
      });
      writeFileSync(process.env.CLEM_QUEUE_RESULT, JSON.stringify(result));
    } catch (error) {
      writeFileSync(process.env.CLEM_QUEUE_RESULT, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childCode], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      CLEM_QUEUE_MODULE_URL: QUEUE_MODULE_URL,
      CLEM_QUEUE_URL: url,
      CLEM_QUEUE_RESULT: resultFile,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function launchReaperChild(
  resultFile: string,
  beforeLockReady: string,
  beforeLockRelease: string,
) {
  const schedulerModuleUrl = pathToFileURL(path.join(process.cwd(), 'src/execution/workflow-scheduler.ts')).href;
  const childCode = `
    import { existsSync, writeFileSync } from 'node:fs';
    const mod = await import(process.env.CLEM_SCHEDULER_MODULE_URL);
    const wait = new Int32Array(new SharedArrayBuffer(4));
    mod._setWorkflowRunReaperBeforeLockForTests(() => {
      writeFileSync(process.env.CLEM_REAPER_BEFORE_LOCK_READY, 'ready', 'utf-8');
      while (!existsSync(process.env.CLEM_REAPER_BEFORE_LOCK_RELEASE)) Atomics.wait(wait, 0, 0, 10);
    });
    try {
      writeFileSync(process.env.CLEM_REAPER_RESULT, JSON.stringify(mod.reapStaleWorkflowRuns()), 'utf-8');
    } catch (error) {
      writeFileSync(process.env.CLEM_REAPER_RESULT, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), 'utf-8');
    }
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childCode], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      CLEM_SCHEDULER_MODULE_URL: schedulerModuleUrl,
      CLEM_REAPER_RESULT: resultFile,
      CLEM_REAPER_BEFORE_LOCK_READY: beforeLockReady,
      CLEM_REAPER_BEFORE_LOCK_RELEASE: beforeLockRelease,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

beforeEach(() => {
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
});

test('queueWorkflowRun: writes a queued run and dedupes identical inputs', () => {
  const first = queueWorkflowRun('audit-brief', { url: 'https://x.com' });
  assert.equal(first.status, 'queued');
  // Fire-and-forget hand-off wording (A): names the workflow + says background + report-back.
  assert.match(first.message, /Queued "audit-brief"/);
  assert.match(first.message, /BACKGROUND/);
  assert.match(first.message, /report back/i);
  assert.match(first.message, /do NOT (wait|poll)/i);
  assert.equal(runFiles().length, 1);
  const record = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8')) as {
    mutationReceiptProtocolVersion?: unknown;
  };
  assert.equal(record.mutationReceiptProtocolVersion, WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION);

  const second = queueWorkflowRun('audit-brief', { url: 'https://x.com' });
  assert.equal(second.status, 'duplicate');
  assert.match(second.message, /No duplicate was queued/);
  assert.match(second.message, /running in the background/i);
  assert.equal(runFiles().length, 1);
});

test('queue writers use create-only installs and never replace a colliding canonical run id', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const cases: Array<{ forcedId: string; queue: () => { status: string; id?: string } }> = [
    {
      forcedId: 'forced-production-collision',
      queue: () => queueWorkflowRun('audit-brief', { url: 'https://collision-production.test' }, { dedupe: false }),
    },
    {
      forcedId: 'forced-dry-run-collision',
      queue: () => queueWorkflowDryRun('audit-brief', { url: 'https://collision-dry.test' }),
    },
    {
      forcedId: 'forced-creation-test-collision',
      queue: () => queueWorkflowCreationTest('audit-brief', { url: 'https://collision-creation.test' }),
    },
  ];

  for (const { forcedId, queue } of cases) {
    const sentinel = {
      id: forcedId,
      workflow: 'do-not-replace',
      status: 'completed',
      sentinel: `${forcedId}-original`,
    };
    const sentinelFile = path.join(WORKFLOW_RUNS_DIR, `${forcedId}.json`);
    writeFileSync(sentinelFile, JSON.stringify(sentinel), 'utf-8');
    process.env.CLEMENTINE_TEST_QUEUE_RUN_ID_ONCE = forcedId;
    let result: { status: string; id?: string };
    try {
      result = queue();
    } finally {
      delete process.env.CLEMENTINE_TEST_QUEUE_RUN_ID_ONCE;
    }
    assert.equal(result.status, 'queued');
    assert.notEqual(result.id, forcedId);
    assert.deepEqual(JSON.parse(readFileSync(sentinelFile, 'utf-8')), sentinel);
  }
  assert.equal(runFiles().length, 6);
});

test('queueWorkflowRun: a paused creator cannot enter a replacement lock generation (cross-process ABA)', async () => {
  writeAuditWorkflow();
  const prefix = path.join(TMP_HOME, 'dedupe-aba');
  const aReady = `${prefix}-a-mkdir`;
  const aRelease = `${prefix}-a-release`;
  const aLost = `${prefix}-a-lost`;
  const aResult = `${prefix}-a-result`;
  const bOwned = `${prefix}-b-owned`;
  const bRelease = `${prefix}-b-release`;
  const bResult = `${prefix}-b-result`;
  for (const file of [aReady, aRelease, aLost, aResult, bOwned, bRelease, bResult]) rmSync(file, { force: true });
  const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/tools/workflow-run-queue.ts')).href;
  const childCode = `
    import { writeFileSync } from 'node:fs';
    const mod = await import(process.env.CLEM_QUEUE_MODULE_URL);
    const result = mod.queueWorkflowRun('audit-brief', { url: 'https://aba.test' });
    writeFileSync(process.env.CLEM_QUEUE_RESULT, JSON.stringify(result));
  `;
  const launch = (result: string, extraEnv: Record<string, string>) => spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', childCode],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLEMENTINE_HOME: TMP_HOME,
        HOME: TMP_HOME,
        CLEM_QUEUE_MODULE_URL: moduleUrl,
        CLEM_QUEUE_RESULT: result,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const a = launch(aResult, {
    CLEMENTINE_TEST_DEDUPE_LOCK_MKDIR_READY: aReady,
    CLEMENTINE_TEST_DEDUPE_LOCK_MKDIR_RELEASE: aRelease,
    CLEMENTINE_TEST_DEDUPE_LOCK_GENERATION_LOST: aLost,
  });
  await waitForPath(aReady);
  const lockRoot = path.join(WORKFLOW_RUNS_DIR, '.dedupe-locks');
  const [oldGeneration] = readdirSync(lockRoot);
  assert.ok(oldGeneration);
  utimesSync(path.join(lockRoot, oldGeneration), new Date(0), new Date(0));

  const b = launch(bResult, {
    CLEMENTINE_TEST_DEDUPE_LOCK_OWNED_READY: bOwned,
    CLEMENTINE_TEST_DEDUPE_LOCK_OWNED_RELEASE: bRelease,
  });
  await waitForPath(bOwned);
  writeFileSync(aRelease, 'go');
  await waitForPath(aLost);
  writeFileSync(bRelease, 'go');

  const [[aCode], [bCode]] = await Promise.all([once(a, 'close'), once(b, 'close')]) as [[number | null], [number | null]];
  assert.equal(aCode, 0);
  assert.equal(bCode, 0);
  const outcomes = [aResult, bResult]
    .map((file) => JSON.parse(readFileSync(file, 'utf-8')) as { status: string });
  assert.deepEqual(outcomes.map((entry) => entry.status).sort(), ['duplicate', 'queued']);
  assert.equal(runFiles().length, 1);
});

test('queueWorkflowRun: corrupt live-owner evidence fails closed instead of being age-reclaimed', async (t) => {
  writeAuditWorkflow();
  const prefix = path.join(TMP_HOME, 'dedupe-corrupt-live');
  const ownerReady = `${prefix}-owned`;
  const ownerRelease = `${prefix}-release`;
  const ownerResult = `${prefix}-owner-result`;
  const contenderResult = `${prefix}-contender-result`;
  const url = 'https://corrupt-live-owner.test';
  const owner = launchQueueChild(url, ownerResult, {
    CLEMENTINE_TEST_DEDUPE_LOCK_OWNED_READY: ownerReady,
    CLEMENTINE_TEST_DEDUPE_LOCK_OWNED_RELEASE: ownerRelease,
  });
  t.after(() => {
    try { writeFileSync(ownerRelease, 'release'); } catch { /* best-effort child cleanup */ }
    if (owner.exitCode === null) owner.kill('SIGKILL');
  });
  const ownerClosed = once(owner, 'close');
  await waitForPath(ownerReady);

  const lockRoot = path.join(WORKFLOW_RUNS_DIR, '.dedupe-locks');
  const [lockName] = readdirSync(lockRoot);
  assert.ok(lockName);
  const lockDir = path.join(lockRoot, lockName);
  const [ownerName] = readdirSync(lockDir).filter((entry) => entry.startsWith('owner-'));
  assert.ok(ownerName);
  const ownerFile = path.join(lockDir, ownerName);
  writeFileSync(ownerFile, '{', 'utf-8');
  utimesSync(lockDir, new Date(0), new Date(0));

  const contender = launchQueueChild(url, contenderResult, {
    CLEMENTINE_TEST_DEDUPE_LOCK_TIMEOUT_MS: '250',
  });
  const contenderClosed = once(contender, 'close');
  await waitForPath(contenderResult);
  await contenderClosed;
  const contenderOutcome = JSON.parse(readFileSync(contenderResult, 'utf-8')) as { error?: string };
  assert.match(contenderOutcome.error ?? '', /unreadable owner record|refusing to reclaim/i);
  assert.equal(existsSync(ownerFile), true, 'contender did not unlink corrupt evidence owned by a live holder');
  assert.equal(runFiles().length, 0);

  writeFileSync(ownerRelease, 'release');
  await waitForPath(ownerResult);
  await ownerClosed;
  assert.equal((JSON.parse(readFileSync(ownerResult, 'utf-8')) as { status?: string }).status, 'queued');
  assert.equal(runFiles().length, 1);
  assert.equal(existsSync(ownerFile), true, 'holder release also leaves replaced/corrupt owner evidence fail-closed');
});

test('queueWorkflowRun: an old lock with malformed filename evidence is not mistaken for an empty pre-owner crash', async () => {
  writeAuditWorkflow();
  const prefix = path.join(TMP_HOME, 'dedupe-malformed-filename');
  const ready = `${prefix}-ready`;
  const release = `${prefix}-release-never`;
  const ownerResult = `${prefix}-owner-result-never`;
  const contenderResult = `${prefix}-contender-result`;
  const url = 'https://malformed-owner-filename.test';
  const creator = launchQueueChild(url, ownerResult, {
    CLEMENTINE_TEST_DEDUPE_LOCK_MKDIR_READY: ready,
    CLEMENTINE_TEST_DEDUPE_LOCK_MKDIR_RELEASE: release,
  });
  const creatorClosed = once(creator, 'close');
  await waitForPath(ready);
  const lockRoot = path.join(WORKFLOW_RUNS_DIR, '.dedupe-locks');
  const [lockName] = readdirSync(lockRoot);
  assert.ok(lockName);
  const lockDir = path.join(lockRoot, lockName);
  const malformedEvidence = path.join(lockDir, 'unexpected-owner-evidence.json');
  writeFileSync(malformedEvidence, JSON.stringify({ pid: creator.pid }), 'utf-8');
  creator.kill('SIGKILL');
  await creatorClosed;
  utimesSync(lockDir, new Date(0), new Date(0));

  const contender = launchQueueChild(url, contenderResult, {
    CLEMENTINE_TEST_DEDUPE_LOCK_TIMEOUT_MS: '250',
  });
  const contenderClosed = once(contender, 'close');
  await waitForPath(contenderResult);
  await contenderClosed;
  const outcome = JSON.parse(readFileSync(contenderResult, 'utf-8')) as { error?: string };
  assert.match(outcome.error ?? '', /invalid owner record|refusing to reclaim/i);
  assert.equal(existsSync(malformedEvidence), true);
  assert.equal(runFiles().length, 0);
});

test('queueWorkflowRun: an old empty generation from a pre-owner crash remains reclaimable', async () => {
  writeAuditWorkflow();
  const prefix = path.join(TMP_HOME, 'dedupe-empty-crash');
  const ready = `${prefix}-ready`;
  const release = `${prefix}-release-never`;
  const resultFile = `${prefix}-result-never`;
  const url = 'https://empty-owner-crash.test';
  const creator = launchQueueChild(url, resultFile, {
    CLEMENTINE_TEST_DEDUPE_LOCK_MKDIR_READY: ready,
    CLEMENTINE_TEST_DEDUPE_LOCK_MKDIR_RELEASE: release,
  });
  const creatorClosed = once(creator, 'close');
  await waitForPath(ready);
  creator.kill('SIGKILL');
  await creatorClosed;

  const lockRoot = path.join(WORKFLOW_RUNS_DIR, '.dedupe-locks');
  const [lockName] = readdirSync(lockRoot);
  assert.ok(lockName);
  const lockDir = path.join(lockRoot, lockName);
  assert.deepEqual(readdirSync(lockDir), []);
  utimesSync(lockDir, new Date(0), new Date(0));

  const recovered = queueWorkflowRun('audit-brief', { url });
  assert.equal(recovered.status, 'queued');
  assert.equal(runFiles().length, 1);
});

test('queueWorkflowRun: a valid dead owner is reclaimed without treating it as corruption', async () => {
  writeAuditWorkflow();
  const prefix = path.join(TMP_HOME, 'dedupe-dead-owner');
  const ready = `${prefix}-owned`;
  const release = `${prefix}-release-never`;
  const resultFile = `${prefix}-result-never`;
  const url = 'https://dead-owner.test';
  const creator = launchQueueChild(url, resultFile, {
    CLEMENTINE_TEST_DEDUPE_LOCK_OWNED_READY: ready,
    CLEMENTINE_TEST_DEDUPE_LOCK_OWNED_RELEASE: release,
  });
  const creatorClosed = once(creator, 'close');
  await waitForPath(ready);
  creator.kill('SIGKILL');
  await creatorClosed;

  const lockRoot = path.join(WORKFLOW_RUNS_DIR, '.dedupe-locks');
  const [lockName] = readdirSync(lockRoot);
  assert.ok(lockName);
  assert.equal(readdirSync(path.join(lockRoot, lockName)).filter((entry) => entry.startsWith('owner-')).length, 1);

  const recovered = queueWorkflowRun('audit-brief', { url });
  assert.equal(recovered.status, 'queued');
  assert.equal(runFiles().length, 1);
});

test('queueWorkflowRun: writes originSessionId when provided (Gap E)', () => {
  const r = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, { originSessionId: 'sess-chat-1' });
  assert.equal(r.status, 'queued');
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.equal(rec.originSessionId, 'sess-chat-1');
});

test('queueWorkflowRun: duplicate attaches the current origin so report-back can still land here', () => {
  const first = queueWorkflowRun('audit-brief', { url: 'https://x.com' });
  assert.equal(first.status, 'queued');

  const second = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, { originSessionId: 'sess-chat-dup' });
  assert.equal(second.status, 'duplicate');

  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.ok(!('originSessionId' in rec), 'live run record is not rewritten by a duplicate observer');
  assert.deepEqual(readWorkflowRunOriginSessionIds(first.id!), ['sess-chat-dup']);
});

test('queueWorkflowRun: duplicate preserves primary origin and adds secondary origin observers', () => {
  const first = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, { originSessionId: 'sess-chat-a' });
  assert.equal(first.status, 'queued');

  const second = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, { originSessionId: 'sess-chat-b' });
  assert.equal(second.status, 'duplicate');

  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.equal(rec.originSessionId, 'sess-chat-a');
  assert.ok(!('originSessionIds' in rec), 'the runner-owned record remains immutable');
  assert.deepEqual(readWorkflowRunOriginSessionIds(first.id!), ['sess-chat-b']);

  queueWorkflowRun('audit-brief', { url: 'https://x.com' }, { originSessionId: 'sess-chat-b' });
  assert.deepEqual(readWorkflowRunOriginSessionIds(first.id!), ['sess-chat-b'], 'duplicate observer is not repeated');
});

test('queueWorkflowRun: late observer installation wins its record lock before retention can reap the acknowledged run', async () => {
  writeAuditWorkflow();
  const receiptId = 'receipt-late-observer-reaper-race';
  const first = queueWorkflowRun('audit-brief', { url: 'https://late-observer.test' }, {
    triggerReceiptId: receiptId,
    originSessionId: 'sess-original',
  });
  assert.equal(first.status, 'queued');
  const file = path.join(WORKFLOW_RUNS_DIR, `${first.id}.json`);
  const oldFinishedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString();
  const queued = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({
    ...queued,
    status: 'completed',
    finishedAt: oldFinishedAt,
    notifiedAt: oldFinishedAt,
    reportBackAcknowledgedAt: oldFinishedAt,
    reportBack: {
      version: 1,
      workflowName: 'audit-brief',
      outcome: 'done',
      detail: 'Original terminal result',
      acknowledgedOriginSessionIds: ['sess-original'],
    },
  }), 'utf-8');

  const prefix = path.join(TMP_HOME, 'late-observer-reaper-race');
  const attachOwned = `${prefix}-attach-owned`;
  const attachRelease = `${prefix}-attach-release`;
  const attachResult = `${prefix}-attach-result`;
  const reaperBeforeLock = `${prefix}-reaper-before-lock`;
  const reaperRelease = `${prefix}-reaper-release`;
  const reaperResult = `${prefix}-reaper-result`;
  const observer = launchQueueChild('https://late-observer.test', attachResult, {
    CLEM_QUEUE_ORIGIN: 'sess-late',
    CLEM_QUEUE_RECEIPT: receiptId,
    CLEMENTINE_TEST_RUN_RECORD_LOCK_OWNED_READY: attachOwned,
    CLEMENTINE_TEST_RUN_RECORD_LOCK_OWNED_RELEASE: attachRelease,
  });
  const observerClosed = once(observer, 'close') as Promise<[number | null]>;
  let reaper: ReturnType<typeof launchReaperChild> | undefined;
  try {
    await waitForPath(attachOwned);
    reaper = launchReaperChild(reaperResult, reaperBeforeLock, reaperRelease);
    const reaperClosed = once(reaper, 'close') as Promise<[number | null]>;
    await waitForPath(reaperBeforeLock);
    // The reaper has selected the old terminal record. Let it approach the
    // linearization lock while the observer owns that lock but has not yet
    // installed its sidecar, then release the observer to commit first.
    writeFileSync(reaperRelease, 'continue', 'utf-8');
    writeFileSync(attachRelease, 'continue', 'utf-8');
    const [[observerCode], [reaperCode]] = await Promise.all([
      observerClosed,
      reaperClosed,
    ]);
    assert.equal(observerCode, 0);
    assert.equal(reaperCode, 0);
    assert.equal((JSON.parse(readFileSync(attachResult, 'utf-8')) as { status?: string }).status, 'duplicate');
    assert.deepEqual(JSON.parse(readFileSync(reaperResult, 'utf-8')), { scanned: 1, deleted: 0 });
    assert.equal(existsSync(file), true, 'retention preserves the record until the late observer is acknowledged');
    assert.deepEqual(readWorkflowRunOriginSessionIds(first.id!), ['sess-late']);
  } finally {
    if (observer.exitCode === null) observer.kill('SIGKILL');
    if (reaper?.exitCode === null) reaper.kill('SIGKILL');
  }
});

test('queueWorkflowRun: distinct durable trigger receipts each own a run; same receipt retries do not duplicate', () => {
  const first = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, { triggerReceiptId: 'receipt-a' });
  assert.equal(first.status, 'queued');

  const second = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, { triggerReceiptId: 'receipt-b' });
  assert.equal(second.status, 'queued');

  assert.equal(readWorkflowTriggerReceiptAcceptance('receipt-a'), first.id);
  assert.equal(readWorkflowTriggerReceiptAcceptance('receipt-b'), second.id);
  assert.equal(runFiles().length, 2, 'distinct events are not silently coalesced merely because mapped inputs match');

  const retry = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, { triggerReceiptId: 'receipt-a' });
  assert.equal(retry.status, 'duplicate');
  assert.equal(retry.id, first.id);
  assert.equal(runFiles().length, 2);
});

test('queueWorkflowRun: v2 trigger acceptance survives normal terminal run-file retention', () => {
  const queued = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, { triggerReceiptId: 'receipt-retained-proof' });
  assert.equal(queued.status, 'queued');
  unlinkSync(path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`));
  assert.equal(
    readWorkflowTriggerReceiptAcceptance('receipt-retained-proof'),
    queued.id,
    'post-run marker remains terminal acceptance after the run record is reaped',
  );
});

test('queueWorkflowRun: a verified legacy v1 marker is promoted before its run can be reaped', () => {
  const receiptId = 'legacy-v1-receipt';
  const queued = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, { triggerReceiptId: receiptId });
  assert.equal(queued.status, 'queued');
  const markerFile = path.join(
    WORKFLOW_RUNS_DIR,
    '.trigger-receipts',
    `${createHash('sha256').update(receiptId).digest('hex')}.json`,
  );
  const marker = JSON.parse(readFileSync(markerFile, 'utf-8')) as Record<string, unknown>;
  writeFileSync(markerFile, JSON.stringify({ ...marker, version: 1 }), 'utf-8');

  assert.equal(readWorkflowTriggerReceiptAcceptance(receiptId), queued.id);
  assert.equal((JSON.parse(readFileSync(markerFile, 'utf-8')) as { version: number }).version, 2);
  unlinkSync(path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`));
  assert.equal(readWorkflowTriggerReceiptAcceptance(receiptId), queued.id);
});

test('queueWorkflowRun: omits originSessionId when absent for notification-only runs (Gap E)', () => {
  queueWorkflowRun('audit-brief', { url: 'https://y.com' });
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.ok(!('originSessionId' in rec), 'no origin → field is not written (notification-only run)');
});

test('queueWorkflowRun: source and targetStepId metadata do not collide with full-run dedupe', () => {
  const full = queueWorkflowRun('audit-brief', { url: 'https://x.com' });
  assert.equal(full.status, 'queued');

  const stepTry = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, {
    source: 'console',
    targetStepId: 'normalize',
  });
  assert.equal(stepTry.status, 'queued');
  assert.equal(runFiles().length, 2, 'a TRY run is distinct from a full run with the same inputs');

  const duplicateTry = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, {
    source: 'console',
    targetStepId: 'normalize',
  });
  assert.equal(duplicateTry.status, 'duplicate');
  assert.equal(runFiles().length, 2);

  const records = runFiles().map((file) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>);
  const tryRecord = records.find((record) => record.targetStepId === 'normalize');
  assert.equal(tryRecord?.source, 'console');
  assert.deepEqual(tryRecord?.recoveryIntent, {
    kind: 'step_try',
    createdAt: tryRecord?.createdAt,
    sourceStepId: 'normalize',
    requestedFrom: 'console',
    reason: 'single-step try run',
  });
});

test('queueWorkflowRun: dedupe false queues fresh scheduled-style records with a prefix', () => {
  const first = queueWorkflowRun('audit-brief', {}, { source: 'schedule', idPrefix: 'sched', dedupe: false });
  const second = queueWorkflowRun('audit-brief', {}, { source: 'schedule', idPrefix: 'sched', dedupe: false });
  assert.equal(first.status, 'queued');
  assert.equal(second.status, 'queued');
  assert.equal(runFiles().length, 2);

  const records = runFiles().map((file) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>);
  assert.ok(records.every((record) => typeof record.id === 'string' && record.id.startsWith('sched-')));
  assert.ok(records.every((record) => record.source === 'schedule'));
});

test('queueWorkflowRun: persists execution optimization recovery intent', () => {
  const result = queueWorkflowRun('audit-brief', { url: 'https://x.com' }, {
    source: 'board',
    dedupe: false,
    recoveryIntent: {
      kind: 'execution_optimize',
      sourceRunId: 'source-run',
      sourceStepId: 'process_each',
      requestedFrom: 'graph_execution_drift',
      reason: 'graph execution optimization rerun: fanout_underused',
    },
  });
  assert.equal(result.status, 'queued');
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8')) as {
    createdAt?: string;
    recoveryIntent?: {
      kind?: string;
      createdAt?: string;
      sourceRunId?: string;
      sourceStepId?: string;
      requestedFrom?: string;
      reason?: string;
    };
  };
  assert.deepEqual(rec.recoveryIntent, {
    kind: 'execution_optimize',
    createdAt: rec.createdAt,
    sourceRunId: 'source-run',
    sourceStepId: 'process_each',
    requestedFrom: 'graph_execution_drift',
    reason: 'graph execution optimization rerun: fanout_underused',
  });
});

test('queueWorkflowRun: blocks production runs when required workflow capabilities are missing', () => {
  writeWorkflow('missing-script-flow', {
    name: 'missing-script-flow',
    description: 'Needs a deterministic helper.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'merge', prompt: 'Merge evidence.', deterministic: { runner: 'missing.py' } }],
  });

  const result = queueWorkflowRun('missing-script-flow', {});
  assert.equal(result.status, 'blocked_readiness');
  assert.match(result.message, /missing\.py/);
  assert.equal(runFiles().length, 0);
  assert.equal(result.readiness?.ok, false);
  assert.equal(result.readiness?.blockers[0]?.kind, 'script');
  assert.equal(result.readiness?.blockers[0]?.name, 'missing.py');
});

test('queueWorkflowRun: readiness-blocked trigger receipts remain unbound and later each recover exactly once', () => {
  writeWorkflow('pending-trigger-flow', {
    name: 'pending-trigger-flow',
    description: 'Waits for its deterministic helper.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'merge', prompt: 'Merge evidence.', deterministic: { runner: 'missing.py' } }],
  });

  const blockedA = queueWorkflowRun('pending-trigger-flow', {}, { triggerReceiptId: 'pending-receipt-a' });
  const blockedB = queueWorkflowRun('pending-trigger-flow', {}, { triggerReceiptId: 'pending-receipt-b' });
  assert.equal(blockedA.status, 'blocked_readiness');
  assert.equal(blockedB.status, 'blocked_readiness');
  assert.equal(readWorkflowTriggerReceiptAcceptance('pending-receipt-a'), null);
  assert.equal(readWorkflowTriggerReceiptAcceptance('pending-receipt-b'), null);
  assert.equal(runFiles().length, 0);

  const scriptsDir = path.join(WORKFLOWS_DIR, 'pending-trigger-flow', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(path.join(scriptsDir, 'missing.py'), 'print("ready")\n', 'utf-8');

  const first = queueWorkflowRun('pending-trigger-flow', {}, { triggerReceiptId: 'pending-receipt-a' });
  const second = queueWorkflowRun('pending-trigger-flow', {}, { triggerReceiptId: 'pending-receipt-b' });
  assert.equal(first.status, 'queued');
  assert.equal(second.status, 'queued');
  assert.equal(runFiles().length, 2);
  assert.equal(readWorkflowTriggerReceiptAcceptance('pending-receipt-a'), first.id);
  assert.equal(readWorkflowTriggerReceiptAcceptance('pending-receipt-b'), second.id);
});

test('queueWorkflowRun: allows unknown Composio slugs as warnings when the broker exists', () => {
  writeWorkflow('unknown-composio-flow', {
    name: 'unknown-composio-flow',
    description: 'Uses a connected-app slug resolved at runtime.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'fetch', prompt: 'Fetch CRM records.', call: { tool: 'SALESFORCE_GET_RECORDS', args: {} } }],
  });

  const result = queueWorkflowRun('unknown-composio-flow', {});
  assert.equal(result.status, 'queued');
  assert.equal(result.readiness?.ok, true);
  assert.equal(result.readiness?.warnings[0]?.name, 'SALESFORCE_GET_RECORDS');
  assert.equal(runFiles().length, 1);
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8')) as {
    readiness?: {
      ok?: boolean;
      scope?: string;
      warnings?: Array<{ name?: string; sources?: string[]; evidence?: Array<{ kind?: string; name?: string; status?: string }> }>;
      toolReadiness?: { unknownCount?: number; items?: Array<{ name?: string; status?: string; evidence?: Array<{ kind?: string; name?: string; status?: string }> }> };
    };
  };
  assert.equal(rec.readiness?.ok, true);
  assert.equal(rec.readiness?.scope, 'run');
  assert.equal(rec.readiness?.warnings?.[0]?.name, 'SALESFORCE_GET_RECORDS');
  assert.deepEqual(rec.readiness?.warnings?.[0]?.sources, ['step_call']);
  assert.ok(rec.readiness?.warnings?.[0]?.evidence?.some((entry) => entry.kind === 'composio_broker' && entry.name === 'composio_execute_tool' && entry.status === 'ready'));
  assert.equal(rec.readiness?.toolReadiness?.unknownCount, 1);
});

test('queueWorkflowRun: step TRY readiness only checks the selected step', () => {
  writeWorkflow('try-readiness-flow', {
    name: 'try-readiness-flow',
    description: 'Has one safe step and one missing script.',
    enabled: false,
    trigger: { manual: true },
    steps: [
      { id: 'safe', prompt: 'Read local notes.', allowedTools: ['read_file'] },
      { id: 'broken', prompt: 'Merge evidence.', deterministic: { runner: 'missing.py' } },
    ],
  });

  const safe = queueWorkflowRun('try-readiness-flow', {}, { targetStepId: 'safe', dedupe: false });
  assert.equal(safe.status, 'queued');
  const safeRecord = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8')) as {
    readiness?: { ok?: boolean; scope?: string; targetStepId?: string; blockers?: unknown[]; toolReadiness?: { missingCount?: number } };
  };
  assert.equal(safeRecord.readiness?.ok, true);
  assert.equal(safeRecord.readiness?.scope, 'step');
  assert.equal(safeRecord.readiness?.targetStepId, 'safe');
  assert.deepEqual(safeRecord.readiness?.blockers, []);
  assert.equal(safeRecord.readiness?.toolReadiness?.missingCount, 1, 'full plan evidence is kept even when TRY readiness is scoped');
  const broken = queueWorkflowRun('try-readiness-flow', {}, { targetStepId: 'broken', dedupe: false });
  assert.equal(broken.status, 'blocked_readiness');
  assert.match(broken.message, /missing\.py/);
  assert.equal(runFiles().length, 1);
});

test('queueWorkflowDryRun: writes fresh dry_run records with console metadata', () => {
  const first = queueWorkflowDryRun('audit-brief', { url: 'https://x.com' }, { source: 'console' });
  const second = queueWorkflowDryRun('audit-brief', { url: 'https://x.com' }, { source: 'console' });
  assert.equal(first.status, 'queued');
  assert.equal(second.status, 'queued');
  assert.equal(runFiles().length, 2);

  const records = runFiles().map((file) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>);
  assert.ok(records.every((record) => record.status === 'dry_run'));
  assert.ok(records.every((record) => record.source === 'console'));
  assert.ok(records.every((record) =>
    record.mutationReceiptProtocolVersion === WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION));
});

test('resumeWorkflowRun: carries originSessionId through to the queued run (Gap E ask-then-resume)', () => {
  writeAuditWorkflow();
  const result = resumeWorkflowRun('audit-brief', { url: 'https://revill.co.uk' }, { originSessionId: 'sess-chat-2' });
  assert.equal(result.status, 'queued');
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.equal(rec.originSessionId, 'sess-chat-2');
});

test('resumeWorkflowRun: missing required input → missing_inputs, no queue', () => {
  writeAuditWorkflow();
  const result = resumeWorkflowRun('audit-brief', {});
  assert.equal(result.status, 'missing_inputs');
  assert.deepEqual(result.missing, ['url']);
  assert.equal(runFiles().length, 0);
});

test('resumeWorkflowRun: all inputs supplied → queues the run', () => {
  writeAuditWorkflow();
  const result = resumeWorkflowRun('audit-brief', { url: 'https://revill.co.uk' });
  assert.equal(result.status, 'queued');
  assert.match(result.message, /Queued "audit-brief"/);
  assert.equal(runFiles().length, 1);
});

test('resumeWorkflowRun: url alias (website) normalizes to satisfy url', () => {
  writeAuditWorkflow();
  const result = resumeWorkflowRun('audit-brief', { website: 'https://revill.co.uk' });
  assert.equal(result.status, 'queued');
  assert.equal(runFiles().length, 1);
});

test('resumeWorkflowRun: unknown workflow → not_found', () => {
  const result = resumeWorkflowRun('does-not-exist', { url: 'https://x.com' });
  assert.equal(result.status, 'not_found');
  assert.equal(runFiles().length, 0);
});

test('resumeWorkflowRun: disabled workflow → disabled', () => {
  writeAuditWorkflow(false);
  const result = resumeWorkflowRun('audit-brief', { url: 'https://x.com' });
  assert.equal(result.status, 'disabled');
  assert.equal(runFiles().length, 0);
});

test('requeueWorkflowFromRun re-queues a failed run with its original inputs (build→fix→re-run loop)', () => {
  writeAuditWorkflow();
  // Simulate a prior FAILED run record (terminal → not a dedupe target).
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-failed-run';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://revill.co.uk' }, status: 'error' }),
    'utf-8',
  );
  const rq = requeueWorkflowFromRun(origId);
  assert.equal(rq.status, 'queued');
  // A NEW queued run exists for the same workflow + inputs.
  const queued = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as {
      workflow: string;
      inputs: Record<string, string>;
      status: string;
      createdAt?: string;
      requeuedFromRunId?: string;
      recoveryIntent?: { kind?: string; createdAt?: string; sourceRunId?: string; reason?: string };
    });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].workflow, 'audit-brief');
  assert.equal(queued[0].inputs.url, 'https://revill.co.uk');
  assert.equal(queued[0].status, 'queued');
  assert.equal(queued[0].requeuedFromRunId, origId);
  assert.deepEqual(queued[0].recoveryIntent, {
    kind: 'manual_requeue',
    createdAt: queued[0].createdAt,
    sourceRunId: origId,
    reason: 'whole-run requeue',
  });
});

test('requeueWorkflowFromRun refuses to overlap a source run that is still executing', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-still-running';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://x.co' }, status: 'running' }),
    'utf-8',
  );

  const result = requeueWorkflowFromRun(origId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /not terminal|still dispatch/i);
  assert.deepEqual(runFiles(), [`${origId}.json`]);
});

function writeMutationRequeueFixture(runId: string, receiptProtocol = false): void {
  writeWorkflow('mutation-requeue', {
    name: 'mutation-requeue',
    description: 'Creates a record before downstream work.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'create', prompt: 'Create the record.', sideEffect: 'write', call: { tool: 'AIRTABLE_CREATE_RECORD', args: { table: 'Prospects' } } },
      { id: 'finish', prompt: 'Summarize it.', dependsOn: ['create'] },
    ],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'mutation-requeue',
    inputs: {},
    status: 'error',
    ...(receiptProtocol
      ? {
          mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
          mutationContractSnapshot: {
            version: 1,
            steps: { create: 'structured_call_receipt' },
          },
        }
      : {}),
  }), 'utf-8');
}

function mutationReceiptInput(runId: string) {
  return {
    workflowSlug: 'mutation-requeue',
    runId,
    stepId: 'create',
    tool: 'AIRTABLE_CREATE_RECORD',
    account: { connectionId: 'ca-airtable' },
    args: { table: 'Prospects', fields: { name: 'Ada' } },
  };
}

function writeStructuredFanoutRequeueFixture(runId: string, receiptProtocol = false): void {
  writeWorkflow('structured-fanout-requeue', {
    name: 'structured-fanout-requeue',
    description: 'Creates one external record per source item.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'source', prompt: 'Read source items.', sideEffect: 'read' },
      {
        id: 'create_each',
        prompt: 'Create this item.',
        dependsOn: ['source'],
        forEach: 'source',
        sideEffect: 'write',
        call: { tool: 'AIRTABLE_CREATE_RECORD', args: { table: 'Prospects' } },
      },
    ],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'structured-fanout-requeue',
    inputs: { batch: runId },
    status: 'completed_with_errors',
    ...(receiptProtocol
      ? {
          mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
          mutationContractSnapshot: {
            version: 1,
            steps: { create_each: 'structured_call_receipt' },
          },
        }
      : {}),
  }), 'utf-8');
  appendWorkflowEvent('structured-fanout-requeue', runId, {
    kind: 'item_failed',
    stepId: 'create_each',
    itemKey: 'item-a',
    error: 'provider response unavailable',
  });
}

function structuredFanoutReceiptInput(runId: string) {
  return {
    workflowSlug: 'structured-fanout-requeue',
    runId,
    stepId: 'create_each',
    itemKey: 'item-a',
    tool: 'AIRTABLE_CREATE_RECORD',
    account: { connectionId: 'ca-airtable' },
    args: { table: 'Prospects', fields: { name: 'Ada' } },
  };
}

test('requeueWorkflowFromRun: current unreceipted mutations fail closed with empty or completed lifecycle telemetry', () => {
  writeWorkflow('unreceipted-mutation-requeue', {
    name: 'unreceipted-mutation-requeue',
    description: 'Mutates through an unstructured prompt step.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'update', prompt: 'Update the CRM record.', sideEffect: 'write' }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  for (const runId of ['unreceipted-empty-source', 'unreceipted-completed-source']) {
    writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
      id: runId,
      workflow: 'unreceipted-mutation-requeue',
      inputs: {},
      status: 'error',
      mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
    }), 'utf-8');
  }
  appendWorkflowEvent('unreceipted-mutation-requeue', 'unreceipted-completed-source', {
    kind: 'step_completed',
    stepId: 'update',
    output: { updated: true },
  });

  const empty = requeueWorkflowFromRun('unreceipted-empty-source');
  const completed = requeueWorkflowFromRun('unreceipted-completed-source');

  assert.equal(empty.status, 'ambiguous');
  assert.equal(completed.status, 'ambiguous');
  // The empty-telemetry source carries no step events, so its history cannot
  // bound the run's progress — the reach gate fails closed first because empty
  // telemetry is not proof the unreceipted mutation was never reached (this
  // fires before the downstream snapshot gate; both refuse).
  assert.match(empty.message, /without a structured direct-call receipt|reached that step|repeat/i);
  // The completed source has step-reach evidence (step_completed on the mutating
  // step), so the reach-conditioned unreceipted gate refuses.
  assert.match(completed.message, /without a structured direct-call receipt|reached that step|repeat/i);
  assert.equal(runFiles().length, 2);
});

test('requeueWorkflowFromRun: empty (lost) telemetry on a non-protocol source blocks an unreceipted mutation', () => {
  // The event log is best-effort (appendWorkflowEvent swallows disk failures),
  // so an EMPTY history on a run that actually executed is LOST telemetry, not
  // proof the mutation was never reached. A source with no receipt-protocol
  // marker skips the snapshot gate, so the reach gate must fail closed when the
  // history cannot bound progress at all — absence of telemetry is not proof of
  // absence of effect (2026-07-17 final-wave review P0).
  writeWorkflow('unreceipted-lost-telemetry', {
    name: 'unreceipted-lost-telemetry',
    description: 'Sends via an unstructured prompt step.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'notify', prompt: 'Send the summary email to the client.', sideEffect: 'send' }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runId = 'lost-telemetry-source';
  // status:'error' (terminal, so it executed) + NO mutationReceiptProtocolVersion
  // (pre-protocol / legacy) + NO events written at all (empty history).
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'unreceipted-lost-telemetry',
    inputs: {},
    status: 'error',
  }), 'utf-8');

  const rq = requeueWorkflowFromRun(runId);

  assert.equal(rq.status, 'ambiguous', 'lost telemetry must not authorize repeating an unreceipted mutation');
  assert.match(rq.message, /without a structured direct-call receipt|reached that step|repeat/i);
  assert.equal(runFiles().length, 1, 'no fresh run was queued');
});

test('requeueWorkflowFromRun: an unreceipted mutation the prior run never reached does not block the requeue', () => {
  // A read-first workflow whose LATER prompt step is an unreceipted send. The
  // prior run failed at the early read step (step_started only, then step_failed
  // with no completion), so the send never dispatched. The reach-conditioned
  // gate must NOT refuse: a fresh whole-run retry cannot repeat a send that
  // never happened. (Regression: any current unreceipted-mutation step used to
  // block every whole-run requeue regardless of what the prior run reached.)
  writeWorkflow('read-then-send', {
    name: 'read-then-send',
    description: 'Read the inbox, then draft and send the weekly summary email.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'read_inbox', prompt: 'Read the latest inbox items.', sideEffect: 'read' },
      { id: 'send_summary', prompt: 'Draft and send the weekly summary email.', dependsOn: ['read_inbox'], sideEffect: 'send' },
    ],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runId = 'read-fail-before-send';
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'read-then-send',
    inputs: {},
    status: 'error',
  }), 'utf-8');
  // Prior run only ever started+failed the read step; the send was never reached.
  appendWorkflowEvent('read-then-send', runId, { kind: 'step_started', stepId: 'read_inbox' });
  appendWorkflowEvent('read-then-send', runId, { kind: 'step_failed', stepId: 'read_inbox', error: 'inbox fetch failed' });

  const rq = requeueWorkflowFromRun(runId);

  assert.equal(rq.status, 'queued');
  const queued = runFiles()
    .filter((f) => f !== `${runId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as { workflow: string; status: string });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].workflow, 'read-then-send');
  assert.equal(queued[0].status, 'queued');
});

test('requeueWorkflowFromRun: an unreceipted mutation the prior run completed still refuses', () => {
  // Same read-then-send shape, but the prior run reached AND completed the send.
  // Reach evidence (step_completed on the mutating step) means a fresh whole-run
  // retry could repeat the send, so the gate fails closed.
  writeWorkflow('read-then-send-done', {
    name: 'read-then-send-done',
    description: 'Read the inbox, then draft and send the weekly summary email.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'read_inbox', prompt: 'Read the latest inbox items.', sideEffect: 'read' },
      { id: 'send_summary', prompt: 'Draft and send the weekly summary email.', dependsOn: ['read_inbox'], sideEffect: 'send' },
    ],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runId = 'send-completed-then-failed';
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'read-then-send-done',
    inputs: {},
    status: 'error',
  }), 'utf-8');
  appendWorkflowEvent('read-then-send-done', runId, { kind: 'step_completed', stepId: 'read_inbox', output: { items: 3 } });
  appendWorkflowEvent('read-then-send-done', runId, { kind: 'step_completed', stepId: 'send_summary', output: { sent: true } });

  const rq = requeueWorkflowFromRun(runId);

  assert.equal(rq.status, 'ambiguous');
  assert.match(rq.message, /without a structured direct-call receipt|reached that step/i);
  assert.deepEqual(runFiles(), [`${runId}.json`]);
});

test('requeueWorkflowFromRun: legacy structured mutation with no exact ledger fails closed on an empty lifecycle log', () => {
  const runId = 'mutation-legacy-empty-source';
  writeMutationRequeueFixture(runId);

  const result = requeueWorkflowFromRun(runId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /no matching source mutation contract|empty best-effort lifecycle/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFromRun: positive legacy completion evidence blocks a structured mutation without a ledger', () => {
  const runId = 'mutation-legacy-completed-source';
  writeMutationRequeueFixture(runId);
  appendWorkflowEvent('mutation-requeue', runId, {
    kind: 'step_completed',
    stepId: 'create',
    output: { id: 'legacy-record' },
  });

  const result = requeueWorkflowFromRun(runId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /completed mutating direct-call step|legacy mutation/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFromRun: protocol-marked structured mutation may retry when its exact ledger is empty', () => {
  const runId = 'mutation-protocol-empty-source';
  writeMutationRequeueFixture(runId, true);

  const result = requeueWorkflowFromRun(runId);

  assert.equal(result.status, 'queued');
  assert.equal(runFiles().length, 2);
});

test('requeueWorkflowFromRun: protocol marker without its admission-time contract snapshot fails closed', () => {
  const runId = 'mutation-protocol-missing-snapshot';
  writeMutationRequeueFixture(runId);
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const record = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({
    ...record,
    mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
  }), 'utf-8');

  const result = requeueWorkflowFromRun(runId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /no valid mutation-contract snapshot|protocol marker alone/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFromRun: plain-to-structured definition drift cannot turn a source unreceipted mutation into marker authority', () => {
  writeWorkflow('mutation-drift', {
    name: 'mutation-drift',
    description: 'Current definition uses a structured update.',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'update',
      prompt: 'Update the CRM.',
      sideEffect: 'write',
      call: { tool: 'AIRTABLE_UPDATE_RECORD', args: { table: 'Prospects' } },
    }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runId = 'plain-to-structured-drift';
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'mutation-drift',
    inputs: {},
    status: 'error',
    mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
    mutationContractSnapshot: {
      version: 1,
      steps: { update: 'unreceipted_mutation' },
    },
  }), 'utf-8');

  const result = requeueWorkflowFromRun(runId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /definition drift|unreceipted_mutation/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFromRun: removing a source mutating step does not erase its admission-time risk', () => {
  writeWorkflow('removed-mutation-drift', {
    name: 'removed-mutation-drift',
    description: 'Current definition removed the old external write.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'summarize', prompt: 'Summarize local evidence.', sideEffect: 'read' }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runId = 'removed-mutation-source';
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: 'removed-mutation-drift',
    inputs: {},
    status: 'error',
    mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
    mutationContractSnapshot: {
      version: 1,
      steps: { old_write: 'unreceipted_mutation' },
    },
  }), 'utf-8');

  const result = requeueWorkflowFromRun(runId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /old_write|definition drift/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFromRun: ambiguous external mutation refuses a fresh run id', async () => {
  const runId = 'mutation-ambiguous-source';
  writeMutationRequeueFixture(runId);
  await assert.rejects(
    executeWorkflowCallMutation(mutationReceiptInput(runId), async () => {
      throw new Error('response lost after submit');
    }),
    (err: unknown) => err instanceof WorkflowCallMutationAmbiguousError,
  );

  const result = requeueWorkflowFromRun(runId);
  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /No rerun was queued|no rerun was queued/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFromRun: committed external mutation is not repeated by an apply-fix style rerun', async () => {
  const runId = 'mutation-committed-source';
  writeMutationRequeueFixture(runId);
  await executeWorkflowCallMutation(mutationReceiptInput(runId), async () => ({ id: 'rec-created' }));

  const result = requeueWorkflowFromRun(runId);
  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /committed/);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFromRun: durable proven-no-commit failure may start one fresh attempt', async () => {
  const runId = 'mutation-proven-failure-source';
  writeMutationRequeueFixture(runId);
  await assert.rejects(
    executeWorkflowCallMutation(
      mutationReceiptInput(runId),
      async () => ({ successful: false, error: 'invalid required field' }),
      { classifyFailure: (result) => ({ summary: result.error, provenNoCommit: true }) },
    ),
    (err: unknown) => err instanceof WorkflowCallMutationProvenFailureError,
  );
  // Best-effort lifecycle evidence may disagree after a crash. Exact durable
  // no-commit proof remains authoritative and therefore retryable.
  appendWorkflowEvent('mutation-requeue', runId, {
    kind: 'step_completed',
    stepId: 'create',
    output: { stale: true },
  });

  const result = requeueWorkflowFromRun(runId);
  assert.equal(result.status, 'queued');
  assert.equal(runFiles().length, 2);
});

test('requeueWorkflowFromRun: missing original run → not_found (best-effort, no throw)', () => {
  assert.equal(requeueWorkflowFromRun('does-not-exist').status, 'not_found');
});

test('requeueWorkflowFromRun carries originSessionId from the prior run (re-run re-enters the chat)', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-with-origin';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://x.co' }, status: 'completed', originSessionId: 'sess-abc' }),
    'utf-8',
  );
  requeueWorkflowFromRun(origId);
  const fresh = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as { originSessionId?: string });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].originSessionId, 'sess-abc');
});

test('requeueWorkflowFromRun preserves duplicate observer origins from the prior run', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-with-multi-origin';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://x.co' }, status: 'completed', originSessionId: 'sess-a', originSessionIds: ['sess-a', 'sess-b'] }),
    'utf-8',
  );

  requeueWorkflowFromRun(origId);
  const fresh = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as { originSessionId?: string; originSessionIds?: string[] });

  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].originSessionId, 'sess-a');
  assert.deepEqual(fresh[0].originSessionIds, ['sess-a', 'sess-b']);
});

test('requeueWorkflowFailedItemsFromRun queues lineage for only final failed forEach items', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-partial-failure';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://x.co' }, status: 'completed_with_errors', originSessionId: 'sess-failed-items' }),
    'utf-8',
  );
  appendWorkflowEvent('audit-brief', origId, { kind: 'step_completed', stepId: 'normalize', output: ['a', 'b', 'c'] });
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_completed', stepId: 'blast', itemKey: 'a', output: 'done-a' });
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_failed', stepId: 'blast', itemKey: 'b', error: 'temporary b failure' });
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_failed', stepId: 'blast', itemKey: 'c', error: 'temporary c failure' });
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_completed', stepId: 'blast', itemKey: 'c', output: 'recovered-c' });

  const rq = requeueWorkflowFailedItemsFromRun(origId);
  assert.equal(rq.status, 'queued');
  assert.deepEqual(rq.failedItems?.map((item) => item.itemKey), ['b']);
  const fresh = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as {
      createdAt?: string;
      retryFailedItemsFromRunId?: string;
      retryFailedItemsStepId?: string;
      retryFailedItemKeys?: string[];
      originSessionId?: string;
      recoveryIntent?: { kind?: string; createdAt?: string; sourceRunId?: string; sourceStepId?: string; reason?: string };
    });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].retryFailedItemsFromRunId, origId);
  assert.equal(fresh[0].retryFailedItemsStepId, 'blast');
  assert.deepEqual(fresh[0].retryFailedItemKeys, ['b']);
  assert.equal(fresh[0].originSessionId, 'sess-failed-items');
  assert.deepEqual(fresh[0].recoveryIntent, {
    kind: 'failed_items',
    createdAt: fresh[0].createdAt,
    sourceRunId: origId,
    sourceStepId: 'blast',
    reason: 'retry final failed forEach items',
  });
});

test('requeueWorkflowFailedItemsFromRun blocks unreceipted mutating fan-out with absent or unreadable external-write telemetry', async (t) => {
  const { HARNESS_DB_PATH, closeEventLog, resetEventLog } = await import('../runtime/harness/eventlog.js');
  t.after(() => {
    closeEventLog();
    rmSync(HARNESS_DB_PATH, { recursive: true, force: true });
    resetEventLog();
  });
  resetEventLog();
  writeWorkflow('unreceipted-fanout-requeue', {
    name: 'unreceipted-fanout-requeue',
    description: 'Mutates each item through an unstructured prompt.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'source', prompt: 'Read source items.', sideEffect: 'read' },
      {
        id: 'update_each',
        prompt: 'Update this CRM record.',
        dependsOn: ['source'],
        forEach: 'source',
        sideEffect: 'write',
      },
    ],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const writeSource = (runId: string): void => {
    writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
      id: runId,
      workflow: 'unreceipted-fanout-requeue',
      inputs: { batch: runId },
      status: 'completed_with_errors',
      mutationReceiptProtocolVersion: WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION,
    }), 'utf-8');
    appendWorkflowEvent('unreceipted-fanout-requeue', runId, {
      kind: 'item_failed',
      stepId: 'update_each',
      itemKey: 'item-a',
      error: 'response unavailable',
    });
  };

  writeSource('unreceipted-fanout-no-telemetry');
  const absent = requeueWorkflowFailedItemsFromRun('unreceipted-fanout-no-telemetry');
  assert.equal(absent.status, 'ambiguous');
  assert.match(absent.message, /without per-item structured direct-call receipts|missing/i);

  writeSource('unreceipted-fanout-unreadable-telemetry');
  closeEventLog();
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(HARNESS_DB_PATH + suffix, { recursive: true, force: true });
  }
  mkdirSync(path.dirname(HARNESS_DB_PATH), { recursive: true });
  mkdirSync(HARNESS_DB_PATH);
  const unreadable = requeueWorkflowFailedItemsFromRun('unreceipted-fanout-unreadable-telemetry');
  assert.equal(unreadable.status, 'ambiguous');
  assert.match(unreadable.message, /unreadable external-write telemetry|no retry was queued/i);
  assert.equal(runFiles().length, 2);
});

test('requeueWorkflowFailedItemsFromRun: legacy structured failed item needs an exact ledger', () => {
  const runId = 'structured-fanout-legacy-empty';
  writeStructuredFanoutRequeueFixture(runId);

  const result = requeueWorkflowFailedItemsFromRun(runId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /no matching source mutation contract|no exact ledger/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFailedItemsFromRun: protocol marker makes empty exact item ledger authoritative', () => {
  const runId = 'structured-fanout-protocol-empty';
  writeStructuredFanoutRequeueFixture(runId, true);

  const result = requeueWorkflowFailedItemsFromRun(runId);

  assert.equal(result.status, 'queued');
  assert.deepEqual(result.failedItems?.map((item) => item.itemKey), ['item-a']);
  assert.equal(runFiles().length, 2);
});

test('requeueWorkflowFailedItemsFromRun: legacy exact proven-no-commit item ledger remains retryable', async () => {
  const runId = 'structured-fanout-proven-failure';
  writeStructuredFanoutRequeueFixture(runId);
  await assert.rejects(
    executeWorkflowCallMutation(
      structuredFanoutReceiptInput(runId),
      async () => ({ successful: false, error: 'invalid required field' }),
      { classifyFailure: (result) => ({ summary: result.error, provenNoCommit: true }) },
    ),
    (err: unknown) => err instanceof WorkflowCallMutationProvenFailureError,
  );

  const result = requeueWorkflowFailedItemsFromRun(runId);

  assert.equal(result.status, 'queued');
  assert.equal(runFiles().length, 2);
});

test('requeueWorkflowFailedItemsFromRun: later exact ledger cannot erase a source unreceipted fan-out contract', async () => {
  const runId = 'structured-fanout-source-was-unreceipted';
  writeStructuredFanoutRequeueFixture(runId, true);
  const sourceFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const source = JSON.parse(readFileSync(sourceFile, 'utf-8')) as Record<string, unknown>;
  writeFileSync(sourceFile, JSON.stringify({
    ...source,
    mutationContractSnapshot: {
      version: 1,
      steps: { create_each: 'unreceipted_mutation' },
    },
  }), 'utf-8');
  await assert.rejects(
    executeWorkflowCallMutation(
      structuredFanoutReceiptInput(runId),
      async () => ({ successful: false, error: 'invalid required field' }),
      { classifyFailure: (result) => ({ summary: result.error, provenNoCommit: true }) },
    ),
    (err: unknown) => err instanceof WorkflowCallMutationProvenFailureError,
  );

  const result = requeueWorkflowFailedItemsFromRun(runId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /executed.*as an unreceipted mutation|source agentic mutation/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFailedItemsFromRun: committed exact item receipt blocks inconsistent failed-item telemetry', async () => {
  const runId = 'structured-fanout-committed';
  writeStructuredFanoutRequeueFixture(runId, true);
  await executeWorkflowCallMutation(
    structuredFanoutReceiptInput(runId),
    async () => ({ id: 'rec-created' }),
  );

  const result = requeueWorkflowFailedItemsFromRun(runId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /committed external mutation receipt|may already have committed/i);
  assert.equal(runFiles().length, 1);
});

test('requeueWorkflowFailedItemsFromRun refuses to overlap a live fan-out', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-live-fanout';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: {}, status: 'running' }),
    'utf-8',
  );
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_failed', stepId: 'blast', itemKey: 'b', error: 'temporary b failure' });

  const result = requeueWorkflowFailedItemsFromRun(origId);

  assert.equal(result.status, 'ambiguous');
  assert.match(result.message, /not terminal|still be processing/i);
  assert.deepEqual(runFiles(), [`${origId}.json`]);
});

test('requeueWorkflowFailedItemsFromRun asks for a step when multiple fan-outs failed', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-multi-failure';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://x.co' }, status: 'completed_with_errors' }),
    'utf-8',
  );
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_failed', stepId: 'blast_one', itemKey: 'a', error: 'a failed' });
  appendWorkflowEvent('audit-brief', origId, { kind: 'item_failed', stepId: 'blast_two', itemKey: 'b', error: 'b failed' });

  const ambiguous = requeueWorkflowFailedItemsFromRun(origId);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.match(ambiguous.message, /more than one step/);

  const scoped = requeueWorkflowFailedItemsFromRun(origId, { stepId: 'blast_two' });
  assert.equal(scoped.status, 'queued');
  assert.deepEqual(scoped.failedItems?.map((item) => item.itemKey), ['b']);
});

test('self-heal lineage: requeue bumps + persists selfHealAttempt (bound counter survives run→run)', () => {
  writeAuditWorkflow();
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const origId = 'orig-heal';
  writeFileSync(
    path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: 'audit-brief', inputs: { url: 'https://x.co' }, status: 'completed' }),
    'utf-8',
  );
  requeueWorkflowFromRun(origId, { selfHealAttempt: 1 });
  const fresh = readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as {
      createdAt?: string;
      requeuedFromRunId?: string;
      selfHealAttempt?: number;
      recoveryIntent?: { kind?: string; createdAt?: string; sourceRunId?: string; reason?: string };
    });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].requeuedFromRunId, origId);
  assert.equal(fresh[0].selfHealAttempt, 1);
  assert.deepEqual(fresh[0].recoveryIntent, {
    kind: 'self_heal',
    createdAt: fresh[0].createdAt,
    sourceRunId: origId,
    reason: 'self-heal verification requeue',
  });
});

test('queueWorkflowRun omits selfHealAttempt when 0/absent', () => {
  writeAuditWorkflow();
  queueWorkflowRun('audit-brief', { url: 'https://x.co' });
  const rec = runFiles().map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as Record<string, unknown>)[0];
  assert.equal('selfHealAttempt' in rec, false);
});

test('queueWorkflowCreationTest: writes a creation_test run record (Part B authoring test)', () => {
  const r = queueWorkflowCreationTest('audit-brief', { url: 'https://x.com' }, { originSessionId: 'sess-create' });
  assert.equal(r.status, 'queued');
  assert.match(r.message, /creation test/i);
  assert.match(r.message, /DISABLED/);
  assert.equal(runFiles().length, 1);
  const rec = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, runFiles()[0]), 'utf-8'));
  assert.equal(rec.status, 'creation_test');
  assert.equal(rec.workflow, 'audit-brief');
  assert.equal(rec.inputs.url, 'https://x.com');
  assert.equal(rec.originSessionId, 'sess-create');
  assert.equal(rec.mutationReceiptProtocolVersion, WORKFLOW_MUTATION_RECEIPT_PROTOCOL_VERSION);
});

test('queueWorkflowCreationTest: does NOT dedupe (each authoring test is fresh)', () => {
  queueWorkflowCreationTest('audit-brief', { url: 'https://x.com' });
  queueWorkflowCreationTest('audit-brief', { url: 'https://x.com' });
  assert.equal(runFiles().length, 2);
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});
