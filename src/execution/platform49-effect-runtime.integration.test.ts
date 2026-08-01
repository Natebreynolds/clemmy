/**
 * Run:
 *   npx tsx --test --test-concurrency=1 \
 *     src/execution/platform49-effect-runtime.integration.test.ts
 *
 * Durable Platform 49 effect/idempotency proof.
 *
 * Unlike platform49-effect-matrix.integration.test.ts (the pure ledger
 * characterization), this file drives the production run queue, workflow
 * runner, Composio gateway, CLI client, exact-call receipt store, cross-run
 * watermark, report envelope, notification, and terminal journal. The only
 * fake is a local provider process. It never calls a live account.
 *
 * The provider identifiers are deliberately opaque strings. In particular,
 * `1785000000.000500` must never pass through a numeric type: doing so changes
 * the destination identity to `1785000000.0005`.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-platform49-effect-runtime-'));
const PROVIDER_STATE_FILE = path.join(TMP_HOME, 'provider-state.json');
const PROVIDER_SHIM_FILE = path.join(TMP_HOME, 'platform49-provider-shim.mjs');

const FINAL_PAGE_ITEM_ID = '1785000000.000499';
const NEW_ITEM_ID = '1785000000.000500';
const NOOP_CURSOR = 'platform49:1785000000.000499';

interface ProviderRecord {
  id: string;
  value: string;
}

interface ProviderInvocation {
  slug: string;
  args: Record<string, unknown>;
}

interface ProviderState {
  destination: Record<string, ProviderRecord>;
  source: Record<string, ProviderRecord>;
  counters: {
    append: number;
    update: number;
    readback: number;
    scan: number;
    sourceMutation: number;
    orphan: number;
  };
  invocations: ProviderInvocation[];
}

function initialProviderState(): ProviderState {
  const destination: Record<string, ProviderRecord> = {};
  for (let index = 0; index < 500; index += 1) {
    const id = `1785000000.${String(index).padStart(6, '0')}`;
    destination[id] = { id, value: `baseline-${index}` };
  }
  return {
    destination,
    source: {
      [FINAL_PAGE_ITEM_ID]: { id: FINAL_PAGE_ITEM_ID, value: 'source-baseline' },
    },
    counters: {
      append: 0,
      update: 0,
      readback: 0,
      scan: 0,
      sourceMutation: 0,
      orphan: 0,
    },
    invocations: [],
  };
}

mkdirSync(TMP_HOME, { recursive: true });
writeFileSync(PROVIDER_STATE_FILE, JSON.stringify(initialProviderState(), null, 2), 'utf-8');
writeFileSync(PROVIDER_SHIM_FILE, `
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  console.log('platform49-provider-shim 1.0.0');
  process.exit(0);
}
if (argv[0] === 'whoami') {
  console.log('sanitized-platform49-operator');
  process.exit(0);
}
if (argv[0] !== 'execute') {
  console.error('unsupported provider shim command');
  process.exit(2);
}

const stateFile = process.env.CLEMENTINE_PLATFORM49_PROVIDER_STATE;
if (!stateFile) throw new Error('missing provider state path');
const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
const slug = String(argv[1] ?? '');
const args = JSON.parse(String(argv[3] ?? '{}'));
state.invocations.push({ slug, args });

const exactId = () => {
  const value = args.item_id ?? args.cursor;
  if (typeof value !== 'string' || !value) throw new Error('provider requires an exact string identity');
  return value;
};
const persist = () => writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');

if (slug === 'DESTPROOF_APPEND_RECORD') {
  const id = exactId();
  state.counters.append += 1;
  if (state.destination[id]) {
    persist();
    console.log(JSON.stringify({ successful: false, error: 'duplicate destination identity' }));
    process.exit(0);
  }
  state.destination[id] = { id, value: String(args.value ?? '') };
  persist();
  console.log(JSON.stringify(state.destination[id]));
  process.exit(0);
}

if (slug === 'DESTPROOF_UPDATE_RECORD') {
  const id = exactId();
  state.counters.update += 1;
  if (!state.destination[id]) {
    persist();
    console.log(JSON.stringify({ successful: false, error: 'destination identity not found' }));
    process.exit(0);
  }
  state.destination[id] = { id, value: String(args.value ?? '') };
  persist();
  console.log(JSON.stringify(state.destination[id]));
  process.exit(0);
}

if (slug === 'DESTPROOF_GET_RECORD') {
  const id = exactId();
  state.counters.readback += 1;
  const record = state.destination[id];
  persist();
  console.log(JSON.stringify(record ? [record] : []));
  process.exit(0);
}

if (slug === 'DESTPROOF_GET_SCAN_CURSOR') {
  const cursor = exactId();
  state.counters.scan += 1;
  persist();
  console.log(JSON.stringify([{ id: cursor, kind: 'scan_cursor' }]));
  process.exit(0);
}

if (slug === 'SOURCEPROOF_UPDATE_RECORD') {
  const id = exactId();
  state.counters.sourceMutation += 1;
  state.source[id] = { id, value: String(args.value ?? '') };
  persist();
  console.log(JSON.stringify(state.source[id]));
  process.exit(0);
}

if (slug === 'ORPHANPROOF_APPEND_RECORD') {
  const id = exactId();
  state.counters.orphan += 1;
  state.destination[id] = { id, value: String(args.value ?? '') };
  persist();
  console.error('response channel closed after provider commit');
  process.exit(41);
}

persist();
console.error('unknown provider shim tool: ' + slug);
process.exit(3);
`, 'utf-8');
chmodSync(PROVIDER_SHIM_FILE, 0o755);

process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMENTINE_PLATFORM49_PROVIDER_STATE = PROVIDER_STATE_FILE;
process.env.COMPOSIO_BACKEND = 'cli';
process.env.COMPOSIO_CLI_PATH = PROVIDER_SHIM_FILE;
process.env.CLEMMY_WATCHER_JUDGE = 'off';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.WORKFLOW_USE_HARNESS = 'off';
process.env.CLEMMY_HARNESS_WORKFLOW = 'off';
process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
// A release proof must not reach a real model or provider account. The workflow
// voice pass fails open immediately at the shared transport boundary.
process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
process.env.OPENAI_API_KEY = '';
delete process.env.COMPOSIO_API_KEY;

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const {
  queueWorkflowRun,
  requeueWorkflowFromRun,
  readWorkflowTriggerReceiptAcceptance,
} = await import('../tools/workflow-run-queue.js');
const {
  processWorkflowRuns,
  resumeCapabilityBlockedWorkflowRun,
} = await import('./workflow-runner.js');
const { readWorkflowEvents } = await import('./workflow-events.js');
const {
  executeWorkflowCallMutation,
  inspectWorkflowCallMutation,
  workflowCallMutationFingerprint,
  workflowCallMutationSlotHasLedger,
  WorkflowCallMutationAmbiguousError,
} = await import('./workflow-call-receipts.js');
const { readSeenItemKeys } = await import('./workflow-watermark-store.js');
const { loadNotifications } = await import('../runtime/notifications.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');
const {
  grantComposioCliDefaultAccountAuthority,
  revokeComposioCliDefaultAccountAuthority,
} = await import('../integrations/composio/cli-default-account-authority.js');
const { resetComposioClient } = await import('../integrations/composio/client.js');

type RunRecord = {
  id: string;
  workflow: string;
  status?: string;
  terminalOutcome?: string;
  reportBack?: {
    version?: number;
    outcome?: string;
    detail?: string;
    acknowledgedOriginSessionIds?: string[];
  };
  capabilityBlock?: {
    stepId?: string;
    tool?: string;
    toolkit?: string;
    reason?: string;
    provenNoDispatch?: boolean;
    state?: string;
  };
};

function readProviderState(): ProviderState {
  return JSON.parse(readFileSync(PROVIDER_STATE_FILE, 'utf-8')) as ProviderState;
}

function readRun(runId: string): RunRecord {
  return JSON.parse(
    readFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), 'utf-8'),
  ) as RunRecord;
}

function runFiles(): string[] {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return [];
  return readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json'));
}

function workflowNotifications(runId: string) {
  return loadNotifications().filter((item) => item.metadata?.runId === runId);
}

function terminalJournalCount(workflowSlug: string, runId: string): number {
  return readWorkflowEvents(workflowSlug, runId)
    .filter((event) => event.kind === 'run_completed' || event.kind === 'run_failed' || event.kind === 'run_cancelled')
    .length;
}

function assertOneSuccessfulTerminal(workflowSlug: string, runId: string): RunRecord {
  const run = readRun(runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.terminalOutcome, 'succeeded');
  assert.equal(run.reportBack?.version, 1);
  assert.equal(run.reportBack?.outcome, 'done');
  assert.equal(terminalJournalCount(workflowSlug, runId), 1, 'one canonical terminal journal event');
  assert.equal(
    workflowNotifications(runId).filter((item) => item.id === `workflow-${runId}-completed`).length,
    1,
    'one terminal workflow notification',
  );
  return run;
}

async function drainUntil(
  runId: string,
  accepted: (run: RunRecord) => boolean,
  maxDrains = 12,
): Promise<RunRecord> {
  for (let attempt = 0; attempt < maxDrains; attempt += 1) {
    await processWorkflowRuns({
      respond: async () => ({ text: 'legacy model path must not run in this structured-call proof' }),
    } as never);
    const run = readRun(runId);
    if (accepted(run)) return run;
  }
  throw new Error(`workflow run ${runId} did not reach the expected state`);
}

async function waitForPath(file: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

const QUEUE_MODULE_URL = pathToFileURL(
  path.join(process.cwd(), 'src/tools/workflow-run-queue.ts'),
).href;

function launchQueueClaim(input: {
  workflowName: string;
  receiptId: string;
  readyFile: string;
  releaseFile: string;
  resultFile: string;
}) {
  const childCode = `
    import { existsSync, writeFileSync } from 'node:fs';
    const wait = new Int32Array(new SharedArrayBuffer(4));
    writeFileSync(process.env.CLEM_READY_FILE, 'ready', 'utf-8');
    while (!existsSync(process.env.CLEM_RELEASE_FILE)) Atomics.wait(wait, 0, 0, 10);
    const queue = await import(process.env.CLEM_QUEUE_MODULE_URL);
    try {
      const result = queue.queueWorkflowRun(process.env.CLEM_WORKFLOW_NAME, {}, {
        source: 'schedule',
        triggerReceiptId: process.env.CLEM_TRIGGER_RECEIPT,
      });
      writeFileSync(process.env.CLEM_RESULT_FILE, JSON.stringify(result), 'utf-8');
    } catch (error) {
      writeFileSync(process.env.CLEM_RESULT_FILE, JSON.stringify({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }), 'utf-8');
    }
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childCode], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TMP_HOME,
      CLEM_QUEUE_MODULE_URL: QUEUE_MODULE_URL,
      CLEM_WORKFLOW_NAME: input.workflowName,
      CLEM_TRIGGER_RECEIPT: input.receiptId,
      CLEM_READY_FILE: input.readyFile,
      CLEM_RELEASE_FILE: input.releaseFile,
      CLEM_RESULT_FILE: input.resultFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function raceScheduleAdmission(workflowName: string, receiptId: string) {
  const raceDir = mkdtempSync(path.join(TMP_HOME, 'admission-race-'));
  const releaseFile = path.join(raceDir, 'release');
  const claims = [0, 1].map((index) => ({
    readyFile: path.join(raceDir, `ready-${index}`),
    resultFile: path.join(raceDir, `result-${index}.json`),
  }));
  const children = claims.map((claim) => launchQueueClaim({
    workflowName,
    receiptId,
    readyFile: claim.readyFile,
    releaseFile,
    resultFile: claim.resultFile,
  }));
  try {
    await Promise.all(claims.map((claim) => waitForPath(claim.readyFile)));
    writeFileSync(releaseFile, 'go', 'utf-8');
    const closes = await Promise.all(children.map((child) => once(child, 'close') as Promise<[number | null]>));
    for (const [code] of closes) assert.equal(code, 0, 'queue claimant process exits cleanly');
    return claims.map((claim) => JSON.parse(readFileSync(claim.resultFile, 'utf-8')) as {
      status?: string;
      id?: string;
      message?: string;
    });
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}

function mutationInput(
  workflowSlug: string,
  runId: string,
  stepId: string,
  tool: string,
  args: Record<string, unknown>,
) {
  return {
    workflowSlug,
    runId,
    stepId,
    tool,
    account: {},
    args,
  };
}

function assertCommittedMutationPhases(input: ReturnType<typeof mutationInput>): void {
  const fingerprint = workflowCallMutationFingerprint(input);
  assert.equal(inspectWorkflowCallMutation(input).status, 'committed');
  const phaseDir = path.join(
    WORKFLOWS_DIR,
    input.workflowSlug,
    'runs',
    input.runId,
    'call-mutations',
    fingerprint,
  );
  const phases = new Set(readdirSync(phaseDir));
  for (const phase of ['intent.json', 'started.json', 'receipt.json', 'commit.json']) {
    assert.equal(phases.has(phase), true, `durable mutation phase ${phase}`);
  }
}

test.after(async () => {
  for (const toolkit of ['destproof', 'sourceproof', 'orphanproof']) {
    try { await revokeComposioCliDefaultAccountAuthority(toolkit); } catch { /* best effort */ }
  }
  try { resetComposioClient(); } catch { /* best effort */ }
  try { closeEventLog(); } catch { /* best effort */ }
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('racing schedule admission creates one run, one append, verified readback, checkpoint, report, and terminal', async () => {
  const workflowSlug = 'platform49-new-runtime';
  const receiptId = 'workflow-schedule:v1:platform49-new-runtime:1785000060000';
  await grantComposioCliDefaultAccountAuthority({
    toolkit: 'destproof',
    label: 'sanitized Platform 49 destination',
    grantedBy: 'test',
  });
  writeWorkflow(workflowSlug, {
    name: workflowSlug,
    description: 'Append one new opaque item, verify it, then checkpoint it.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      {
        id: 'append_destination',
        prompt: 'Append the exact destination item.',
        sideEffect: 'write',
        call: {
          tool: 'DESTPROOF_APPEND_RECORD',
          args: { item_id: NEW_ITEM_ID, value: 'new-item-value' },
        },
      },
      {
        id: 'verify_destination',
        prompt: 'Read the exact destination item back.',
        dependsOn: ['append_destination'],
        sideEffect: 'read',
        call: {
          tool: 'DESTPROOF_GET_RECORD',
          args: { item_id: NEW_ITEM_ID },
        },
      },
      {
        id: 'checkpoint_verified_item',
        prompt: 'Verify each exact item before checkpointing it.',
        dependsOn: ['verify_destination'],
        forEach: 'verify_destination',
        forEachNewOnly: true,
        sideEffect: 'read',
        call: {
          tool: 'DESTPROOF_GET_RECORD',
          args: { item_id: '{{item.id}}' },
        },
      },
    ],
  });

  const before = readProviderState();
  const claims = await raceScheduleAdmission(workflowSlug, receiptId);
  assert.deepEqual(
    claims.map((claim) => claim.status).sort(),
    ['duplicate', 'queued'],
    claims.map((claim) => claim.message).join('\n'),
  );
  assert.equal(claims[0]?.id, claims[1]?.id, 'both schedule claimants resolve to one logical run');
  const runId = claims[0]!.id!;
  assert.equal(readWorkflowTriggerReceiptAcceptance(receiptId), runId);
  assert.equal(
    runFiles().filter((file) => {
      const run = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as { triggerReceiptId?: string };
      return run.triggerReceiptId === receiptId;
    }).length,
    1,
    'one durable run record owns the schedule receipt',
  );

  await drainUntil(runId, (run) => run.status === 'completed');
  assertOneSuccessfulTerminal(workflowSlug, runId);

  const after = readProviderState();
  assert.equal(after.counters.append - before.counters.append, 1, 'exactly one destination append');
  assert.equal(after.counters.update - before.counters.update, 0);
  assert.equal(after.counters.readback - before.counters.readback, 2, 'verification plus checkpoint readback');
  assert.deepEqual(after.destination[NEW_ITEM_ID], { id: NEW_ITEM_ID, value: 'new-item-value' });
  assert.equal(Object.hasOwn(after.destination, String(Number(NEW_ITEM_ID))), false, 'numeric normalization never creates a second identity');
  assert.deepEqual([...readSeenItemKeys(workflowSlug, 'checkpoint_verified_item')], [NEW_ITEM_ID]);

  assertCommittedMutationPhases(mutationInput(
    workflowSlug,
    runId,
    'append_destination',
    'DESTPROOF_APPEND_RECORD',
    { item_id: NEW_ITEM_ID, value: 'new-item-value' },
  ));

  await processWorkflowRuns({ respond: async () => ({ text: 'must not run' }) } as never);
  const afterReplayTick = readProviderState();
  assert.deepEqual(afterReplayTick.counters, after.counters, 'a later drain cannot repeat a terminal effect');
  assert.equal(terminalJournalCount(workflowSlug, runId), 1);
  assert.equal(workflowNotifications(runId).filter((item) => item.id === `workflow-${runId}-completed`).length, 1);
});

test('a no-op poll performs no mutation and checkpoints one exact scan cursor', async () => {
  const workflowSlug = 'platform49-noop-runtime';
  writeWorkflow(workflowSlug, {
    name: workflowSlug,
    description: 'Read a no-change scan cursor and checkpoint the verified cursor.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      {
        id: 'scan_no_changes',
        prompt: 'Read the exact no-change scan cursor.',
        sideEffect: 'read',
        call: {
          tool: 'DESTPROOF_GET_SCAN_CURSOR',
          args: { cursor: NOOP_CURSOR },
        },
      },
      {
        id: 'checkpoint_scan_cursor',
        prompt: 'Verify and checkpoint the exact scan cursor.',
        dependsOn: ['scan_no_changes'],
        forEach: 'scan_no_changes',
        forEachNewOnly: true,
        sideEffect: 'read',
        call: {
          tool: 'DESTPROOF_GET_SCAN_CURSOR',
          args: { cursor: '{{item.id}}' },
        },
      },
    ],
  });

  const before = readProviderState();
  assert.equal(readSeenItemKeys(workflowSlug, 'checkpoint_scan_cursor').size, 0);
  const queued = queueWorkflowRun(workflowSlug, {}, {
    source: 'schedule',
    triggerReceiptId: 'workflow-schedule:v1:platform49-noop-runtime:1785000120000',
  });
  assert.equal(queued.status, 'queued', queued.message);
  await drainUntil(queued.id!, (run) => run.status === 'completed');
  assertOneSuccessfulTerminal(workflowSlug, queued.id!);

  const after = readProviderState();
  assert.equal(after.counters.append, before.counters.append);
  assert.equal(after.counters.update, before.counters.update);
  assert.equal(after.counters.sourceMutation, before.counters.sourceMutation);
  assert.equal(after.counters.orphan, before.counters.orphan);
  assert.equal(after.counters.scan - before.counters.scan, 2, 'scan plus cursor verification');
  assert.deepEqual([...readSeenItemKeys(workflowSlug, 'checkpoint_scan_cursor')], [NOOP_CURSOR]);

  const nextBefore = readProviderState();
  const next = queueWorkflowRun(workflowSlug, {}, {
    source: 'schedule',
    triggerReceiptId: 'workflow-schedule:v1:platform49-noop-runtime:1785000180000',
  });
  assert.equal(next.status, 'queued', next.message);
  await drainUntil(next.id!, (run) => run.status === 'completed');
  assertOneSuccessfulTerminal(workflowSlug, next.id!);
  const nextAfter = readProviderState();
  assert.equal(nextAfter.counters.scan - nextBefore.counters.scan, 1, 'the known cursor is scanned but not reprocessed');
  assert.equal(nextAfter.counters.append, nextBefore.counters.append);
  assert.equal(nextAfter.counters.update, nextBefore.counters.update);
  assert.ok(readWorkflowEvents(workflowSlug, next.id!).some((event) =>
    event.kind === 'step_skipped'
    && event.stepId === 'checkpoint_scan_cursor'
    && event.meta?.reason === 'forEach-no-new-items'));
});

test('a changed record at item 499 updates its exact destination identity and never appends', async () => {
  const workflowSlug = 'platform49-final-page-update-runtime';
  writeWorkflow(workflowSlug, {
    name: workflowSlug,
    description: 'Update the changed item on the final source page, verify, and checkpoint it.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      {
        id: 'update_destination',
        prompt: 'Update the exact existing destination item.',
        sideEffect: 'write',
        call: {
          tool: 'DESTPROOF_UPDATE_RECORD',
          args: { item_id: FINAL_PAGE_ITEM_ID, value: 'changed-at-record-499' },
        },
      },
      {
        id: 'verify_destination',
        prompt: 'Read the updated destination item back.',
        dependsOn: ['update_destination'],
        sideEffect: 'read',
        call: {
          tool: 'DESTPROOF_GET_RECORD',
          args: { item_id: FINAL_PAGE_ITEM_ID },
        },
      },
      {
        id: 'checkpoint_updated_item',
        prompt: 'Verify each updated item before checkpointing it.',
        dependsOn: ['verify_destination'],
        forEach: 'verify_destination',
        forEachNewOnly: true,
        sideEffect: 'read',
        call: {
          tool: 'DESTPROOF_GET_RECORD',
          args: { item_id: '{{item.id}}' },
        },
      },
    ],
  });

  const before = readProviderState();
  const destinationCountBefore = Object.keys(before.destination).length;
  const queued = queueWorkflowRun(workflowSlug, {}, {
    source: 'schedule',
    triggerReceiptId: 'workflow-schedule:v1:platform49-final-page-update-runtime:1785000240000',
  });
  assert.equal(queued.status, 'queued', queued.message);
  await drainUntil(queued.id!, (run) => run.status === 'completed');
  assertOneSuccessfulTerminal(workflowSlug, queued.id!);

  const after = readProviderState();
  assert.equal(after.counters.update - before.counters.update, 1);
  assert.equal(after.counters.append - before.counters.append, 0);
  assert.equal(Object.keys(after.destination).length, destinationCountBefore, 'an in-place update creates no row');
  assert.deepEqual(after.destination[FINAL_PAGE_ITEM_ID], {
    id: FINAL_PAGE_ITEM_ID,
    value: 'changed-at-record-499',
  });
  assert.deepEqual([...readSeenItemKeys(workflowSlug, 'checkpoint_updated_item')], [FINAL_PAGE_ITEM_ID]);
  assertCommittedMutationPhases(mutationInput(
    workflowSlug,
    queued.id!,
    'update_destination',
    'DESTPROOF_UPDATE_RECORD',
    { item_id: FINAL_PAGE_ITEM_ID, value: 'changed-at-record-499' },
  ));
});

test('unauthorized source dispatch stays zero while an authorized sibling commits once; same-run resume never repeats it', async () => {
  const workflowSlug = 'platform49-source-authority-runtime';
  const destinationId = '1785000000.000777';
  await revokeComposioCliDefaultAccountAuthority('sourceproof');
  writeWorkflow(workflowSlug, {
    name: workflowSlug,
    description: 'Prove destination authority is independent from prohibited source mutation authority.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      {
        id: 'write_destination',
        prompt: 'Write the authorized destination only.',
        sideEffect: 'write',
        call: {
          tool: 'DESTPROOF_APPEND_RECORD',
          args: { item_id: destinationId, value: 'authorized-destination-value' },
        },
      },
      {
        id: 'mutate_source',
        prompt: 'Attempt the separately-authorized source mutation.',
        sideEffect: 'write',
        call: {
          tool: 'SOURCEPROOF_UPDATE_RECORD',
          args: { item_id: FINAL_PAGE_ITEM_ID, value: 'authorized-after-resume' },
        },
      },
    ],
  });

  const before = readProviderState();
  const queued = queueWorkflowRun(workflowSlug, {}, {
    source: 'schedule',
    triggerReceiptId: 'workflow-schedule:v1:platform49-source-authority-runtime:1785000300000',
  });
  assert.equal(queued.status, 'queued', queued.message);
  const blocked = await drainUntil(queued.id!, (run) => run.status === 'blocked_capability');

  const afterBlock = readProviderState();
  assert.equal(afterBlock.counters.append - before.counters.append, 1, 'authorized destination committed once');
  assert.equal(afterBlock.counters.sourceMutation - before.counters.sourceMutation, 0, 'unauthorized source never dispatched');
  assert.equal(blocked.terminalOutcome, undefined, 'a recoverable authority interruption is not mislabeled as success');
  assert.equal(blocked.reportBack, undefined, 'the same resumable run has not fabricated terminal report truth');
  assert.equal(blocked.capabilityBlock?.stepId, 'mutate_source');
  assert.equal(blocked.capabilityBlock?.provenNoDispatch, true);
  assert.equal(blocked.capabilityBlock?.state, 'blocked');
  assert.equal(terminalJournalCount(workflowSlug, queued.id!), 0);
  assert.equal(
    workflowNotifications(queued.id!).filter((item) => item.id.includes('-capability-sourceproof')).length,
    1,
    'one user-visible capability intervention is durable',
  );
  assertCommittedMutationPhases(mutationInput(
    workflowSlug,
    queued.id!,
    'write_destination',
    'DESTPROOF_APPEND_RECORD',
    { item_id: destinationId, value: 'authorized-destination-value' },
  ));
  assert.equal(workflowCallMutationSlotHasLedger({
    workflowSlug,
    runId: queued.id!,
    stepId: 'mutate_source',
  }), false, 'a pre-dispatch gateway block creates no false started receipt');

  await grantComposioCliDefaultAccountAuthority({
    toolkit: 'sourceproof',
    label: 'sanitized Platform 49 source',
    grantedBy: 'test',
  });
  assert.equal(resumeCapabilityBlockedWorkflowRun(queued.id!), true);
  await drainUntil(queued.id!, (run) => run.status === 'completed');
  assertOneSuccessfulTerminal(workflowSlug, queued.id!);

  const afterResume = readProviderState();
  assert.equal(afterResume.counters.append - before.counters.append, 1, 'completed sibling is never replayed');
  assert.equal(afterResume.counters.sourceMutation - before.counters.sourceMutation, 1, 'the newly authorized source dispatches once');
  assert.deepEqual(afterResume.source[FINAL_PAGE_ITEM_ID], {
    id: FINAL_PAGE_ITEM_ID,
    value: 'authorized-after-resume',
  });
  assertCommittedMutationPhases(mutationInput(
    workflowSlug,
    queued.id!,
    'mutate_source',
    'SOURCEPROOF_UPDATE_RECORD',
    { item_id: FINAL_PAGE_ITEM_ID, value: 'authorized-after-resume' },
  ));
});

test('provider commit with a lost response becomes ambiguous and is never blindly re-dispatched', async () => {
  const workflowSlug = 'platform49-orphan-runtime';
  const orphanId = '1785000000.000888';
  await grantComposioCliDefaultAccountAuthority({
    toolkit: 'orphanproof',
    label: 'sanitized Platform 49 uncertain provider',
    grantedBy: 'test',
  });
  writeWorkflow(workflowSlug, {
    name: workflowSlug,
    description: 'Refuse a second mutation when the provider response is lost after commit.',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'append_uncertain',
      prompt: 'Append once through the uncertain provider.',
      sideEffect: 'write',
      call: {
        tool: 'ORPHANPROOF_APPEND_RECORD',
        args: { item_id: orphanId, value: 'may-have-landed' },
      },
    }],
  });

  const before = readProviderState();
  const queued = queueWorkflowRun(workflowSlug, {}, {
    source: 'schedule',
    triggerReceiptId: 'workflow-schedule:v1:platform49-orphan-runtime:1785000360000',
  });
  assert.equal(queued.status, 'queued', queued.message);
  const failed = await drainUntil(queued.id!, (run) => run.status === 'error');
  assert.equal(failed.terminalOutcome, 'failed');
  assert.equal(failed.reportBack?.version, 1);
  assert.equal(failed.reportBack?.outcome, 'failed');
  assert.equal(terminalJournalCount(workflowSlug, queued.id!), 1);

  const afterFailure = readProviderState();
  assert.equal(afterFailure.counters.orphan - before.counters.orphan, 1, 'provider boundary crossed once');
  assert.deepEqual(afterFailure.destination[orphanId], { id: orphanId, value: 'may-have-landed' });
  const input = mutationInput(
    workflowSlug,
    queued.id!,
    'append_uncertain',
    'ORPHANPROOF_APPEND_RECORD',
    { item_id: orphanId, value: 'may-have-landed' },
  );
  assert.equal(inspectWorkflowCallMutation(input).status, 'ambiguous');

  let blindRedispatches = 0;
  await assert.rejects(
    executeWorkflowCallMutation(input, async () => {
      blindRedispatches += 1;
      return { duplicate: true };
    }),
    (error: unknown) => error instanceof WorkflowCallMutationAmbiguousError,
  );
  assert.equal(blindRedispatches, 0, 'the ambiguous started boundary refuses before provider invocation');

  const runCountBeforeRequeue = runFiles().length;
  const requeue = requeueWorkflowFromRun(queued.id!);
  assert.equal(requeue.status, 'ambiguous');
  assert.match(requeue.message, /no rerun was queued/i);
  assert.equal(runFiles().length, runCountBeforeRequeue);

  await processWorkflowRuns({ respond: async () => ({ text: 'must not run' }) } as never);
  const afterReplayTick = readProviderState();
  assert.equal(afterReplayTick.counters.orphan, afterFailure.counters.orphan);
  assert.equal(terminalJournalCount(workflowSlug, queued.id!), 1);
  assert.equal(
    workflowNotifications(queued.id!).filter((item) => item.id === `workflow-${queued.id}-error`).length,
    1,
    'one terminal error notification',
  );
});
