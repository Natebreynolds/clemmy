/**
 * Run:
 *   npx tsx --test --test-concurrency=1 \
 *     src/execution/platform49-effect-runtime.integration.test.ts
 *
 * Durable Platform 49 effect/idempotency proof.
 *
 * Unlike platform49-effect-matrix.integration.test.ts (the pure ledger
 * characterization), this file drives the production run queue, workflow
 * runner, exact live catalog, immutable production capability ports, workflow-
 * v3 activation/dispatch/settlement store, cross-run watermark, report
 * envelope, notification, and terminal journal. The only fake is the provider
 * body behind an isolated fixture port. It never calls a live account.
 *
 * The provider identifiers are deliberately opaque strings. In particular,
 * `1785000000.000500` must never pass through a numeric type: doing so changes
 * the destination identity to `1785000000.0005`.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
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
    send: number;
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
      send: 0,
    },
    invocations: [],
  };
}

mkdirSync(TMP_HOME, { recursive: true });
writeFileSync(PROVIDER_STATE_FILE, JSON.stringify(initialProviderState(), null, 2), 'utf-8');

process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_WATCHER_JUDGE = 'off';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.CLEMMY_FAILURE_LEARNING = 'off';
process.env.WORKFLOW_SELF_HEAL = 'off';
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
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const {
  queueWorkflowRun,
  requeueWorkflowFromRun,
  readWorkflowTriggerReceiptAcceptance,
} = await import('../tools/workflow-run-queue.js');
const { processWorkflowSchedules } = await import('./workflow-scheduler.js');
const {
  processWorkflowRuns,
  reapCapabilityBlockedRuns,
  resumeCapabilityBlockedWorkflowRun,
  _setBeforeWorkflowCallGatewayForTests,
  _setBeforeWorkflowGraphFinalizationForTests,
} = await import('./workflow-runner.js');
const {
  appendWorkflowEventDurably,
  readWorkflowEvents,
} = await import('./workflow-events.js');
const {
  assessWorkflowV3RunMutationRequeue,
  inspectWorkflowV3Call,
} = await import('./workflow-v3-call-evidence.js');
const { readSeenItemKeys } = await import('./workflow-watermark-store.js');
const { loadNotifications } = await import('../runtime/notifications.js');
const { closeEventLog, openEventLog } = await import('../runtime/harness/eventlog.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const catalog = await import('../runtime/harness/host-capability-catalog-factory.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const kernel = await import('../runtime/harness/workflow-read-only-call-kernel.js');
const {
  _clearToolSchemaCacheForTest,
  _setToolSchemaLoaderForTests,
  rememberToolSchema,
  resetToolSchemaCache,
} = await import('../tools/composio-schema-cache.js');

type RunRecord = {
  id: string;
  workflow: string;
  workflowSlug?: string;
  status?: string;
  error?: string;
  terminalOutcome?: string;
  needsAttention?: boolean;
  stepOutputs?: Record<string, string>;
  blockedSteps?: Array<{ stepId?: string; reason?: string }>;
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
  mutationBlock?: {
    workflowSlug?: string;
    stepId?: string;
    itemKey?: string;
    tool?: string;
    fingerprint?: string;
    state?: string;
    providerRedispatched?: boolean;
  };
  heldExecution?: {
    stepId?: string;
    sourceStatus?: string;
    hold?: { owner?: string; wake?: string; reason?: string };
  };
};

function readProviderState(): ProviderState {
  return JSON.parse(readFileSync(PROVIDER_STATE_FILE, 'utf-8')) as ProviderState;
}

function persistProviderState(state: ProviderState): void {
  writeFileSync(PROVIDER_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

async function invokeFixtureProvider(
  slug: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const state = readProviderState();
  state.invocations.push({ slug, args: structuredClone(args) });
  const exactId = (): string => {
    const value = args.item_id ?? args.cursor;
    if (typeof value !== 'string' || !value) {
      throw new Error('provider requires an exact string identity');
    }
    return value;
  };
  if (slug === 'DESTPROOF_APPEND_RECORD') {
    const id = exactId();
    state.counters.append += 1;
    if (state.destination[id]) {
      persistProviderState(state);
      return { data: { successful: false, error: 'duplicate destination identity' } };
    }
    state.destination[id] = { id, value: String(args.value ?? '') };
    persistProviderState(state);
    return { data: structuredClone(state.destination[id]) };
  }
  if (slug === 'DESTPROOF_UPDATE_RECORD') {
    const id = exactId();
    state.counters.update += 1;
    if (!state.destination[id]) {
      persistProviderState(state);
      return { data: { successful: false, error: 'destination identity not found' } };
    }
    state.destination[id] = { id, value: String(args.value ?? '') };
    persistProviderState(state);
    return { data: structuredClone(state.destination[id]) };
  }
  if (slug === 'DESTPROOF_GET_RECORD') {
    const id = exactId();
    state.counters.readback += 1;
    const record = state.destination[id];
    persistProviderState(state);
    return { data: record ? [structuredClone(record)] : [] };
  }
  if (slug === 'DESTPROOF_GET_SCAN_CURSOR') {
    const cursor = exactId();
    state.counters.scan += 1;
    persistProviderState(state);
    return { data: [{ id: cursor, kind: 'scan_cursor' }] };
  }
  if (slug === 'SOURCEPROOF_UPDATE_RECORD') {
    const id = exactId();
    state.counters.sourceMutation += 1;
    state.source[id] = { id, value: String(args.value ?? '') };
    persistProviderState(state);
    return { data: structuredClone(state.source[id]) };
  }
  if (slug === 'ORPHANPROOF_APPEND_RECORD') {
    const id = exactId();
    state.counters.orphan += 1;
    state.destination[id] = { id, value: String(args.value ?? '') };
    persistProviderState(state);
    throw new Error('response channel closed after provider commit');
  }
  if (slug === 'EXACTPROOF_SEND_MESSAGE') {
    const channel = args.channel;
    const markdownText = args.markdown_text;
    if (typeof channel !== 'string' || !channel || typeof markdownText !== 'string' || !markdownText) {
      persistProviderState(state);
      return { data: { successful: false, error: 'exact channel and markdown_text are required' } };
    }
    state.counters.send += 1;
    persistProviderState(state);
    return {
      data: { receipt_id: `exact-provider-receipt-${state.counters.send}` },
    };
  }
  persistProviderState(state);
  throw new Error(`unknown fixture provider tool: ${slug}`);
}

const CAPABILITY_EFFECTS = {
  DESTPROOF_APPEND_RECORD: 'external_write',
  DESTPROOF_UPDATE_RECORD: 'external_write',
  DESTPROOF_GET_RECORD: 'read',
  DESTPROOF_GET_SCAN_CURSOR: 'read',
  SOURCEPROOF_UPDATE_RECORD: 'external_write',
  ORPHANPROOF_APPEND_RECORD: 'external_write',
  EXACTPROOF_SEND_MESSAGE: 'external_write',
} as const;

function capabilityDigest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex');
}

function installProviderCapabilities(
  operationIds: Array<keyof typeof CAPABILITY_EFFECTS>,
  revision = '1',
): void {
  catalog.installHostCapabilityCatalogFactory(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  const entries: Array<import('../runtime/harness/host-capability-catalog-factory.js').RegisteredHostCapability> = [];
  for (const operationId of operationIds) {
    const family = operationId.split('_')[0]!.toLowerCase();
    const definitionFingerprint = capabilityDigest(`platform49:${operationId}:schema:${revision}`);
    const manifest = manifests.attachSemanticContract({
      version: 1,
      manifestId: `manifest.platform49.${operationId}.${revision}`,
      providerKind: 'local_registry',
      operationId,
      providerIdentity: `platform49.${family}`,
      providerVersion: `fixture.${revision}`,
      operationVersion: revision,
      definitionFingerprint,
      effect: CAPABILITY_EFFECTS[operationId],
      accountId: `account.platform49.${family}`,
      idempotency: { required: false, policy: 'none' },
      reconciliation: { supported: false, policy: 'none' },
      outputContract: { kind: 'records' },
      purpose: CAPABILITY_EFFECTS[operationId] === 'read' ? 'bounded_read' : 'exact_mutation',
      acceptedInputKinds: ['scope'],
      producedOutputKinds: ['records'],
      applicableDeliverableKinds: ['records'],
      evidenceContract: { kinds: ['records'], readbackRequired: false },
      provenance: {
        issuer: 'platform49.effect.runtime.test',
        issuedAt: '2026-08-27T00:00:00.000Z',
        trusted: true,
      },
      lifecycle: { state: 'current' },
      advisoryRoles: CAPABILITY_EFFECTS[operationId] === 'read' ? ['read'] : ['write'],
    });
    assert.equal(ports.registerFixtureCapabilityPort(
      ports.productionPortIdentityFromManifest(manifest),
      {
        invoke: async (input) => invokeFixtureProvider(
          operationId,
          input.binding.args as Record<string, unknown>,
        ),
      },
    ).ok, true);
    const entry: import('../runtime/harness/host-capability-catalog-factory.js').RegisteredHostCapability = {
      capabilityId: `capability.platform49.${operationId}.${revision}`,
      toolName: operationId,
      schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint,
      effect: manifest.effect,
      account: manifest.accountId,
      advisoryRoles: manifest.advisoryRoles,
      manifestDigest: manifests.capabilityManifestDigest(manifest),
      providerKind: manifest.providerKind,
      liveFingerprint: manifest.definitionFingerprint,
      manifest,
      invoke: async () => { throw new Error('catalog callback cannot own Platform49 provider I/O'); },
    };
    entries.push(entry);
    assert.equal(observations.registerIndependentCapabilityObservation({
      operationId,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt: Date.now(),
      origin: 'independent',
      observe: () => ({
        operationId,
        accountId: manifest.accountId,
        definitionFingerprint: manifest.definitionFingerprint,
        providerVersion: manifest.providerVersion,
        operationVersion: manifest.operationVersion,
        observedAt: Date.now(),
      }),
    }).ok, true);
  }
  catalog.installHostCapabilityCatalogFactory(catalog.createHostCapabilityCatalogFactory(entries));
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

function assertCommittedV3Call(
  workflowSlug: string,
  runId: string,
  stepId: string,
  tool: string,
  args: Record<string, unknown>,
): void {
  const inspected = inspectWorkflowV3Call(
    { workflowSlug, runId, stepId },
    { tool, args },
  );
  assert.equal(inspected.status, 'committed', JSON.stringify(inspected));
  const db = openEventLog();
  const row = db.prepare(`
    SELECT activation.activation_id,
           activation.logical_call_id,
           binding.effect,
           authority.authority_kind,
           authority.state AS authority_state,
           logical.state AS logical_state,
           settlement.outcome_kind,
           settlement.requires_reconciliation,
           (SELECT COUNT(*)
              FROM physical_dispatches physical
             WHERE physical.session_id = activation.session_id
               AND physical.source_user_seq = activation.source_event_seq
               AND physical.logical_tool_call_id = activation.logical_call_id
               AND physical.relation != 'probe'
               AND physical.execution_site IS NULL) AS provider_crossings,
           (SELECT COUNT(*)
              FROM physical_dispatches physical
             WHERE physical.session_id = activation.session_id
               AND physical.source_user_seq = activation.source_event_seq
               AND physical.logical_tool_call_id = activation.logical_call_id
               AND physical.relation != 'probe'
               AND physical.execution_site IS NULL
               AND physical.state = 'returned') AS returned_crossings
      FROM workflow_node_invocation_activations activation
      JOIN workflow_v3_call_activation_bindings binding USING (activation_id)
      JOIN accepted_turn_call_authorities authority
        ON authority.workflow_activation_id = activation.activation_id
      JOIN logical_tool_calls logical
        ON logical.session_id = activation.session_id
       AND logical.source_user_seq = activation.source_event_seq
       AND logical.logical_tool_call_id = activation.logical_call_id
      JOIN logical_call_settlements settlement
        ON settlement.session_id = activation.session_id
       AND settlement.source_user_seq = activation.source_event_seq
       AND settlement.logical_tool_call_id = activation.logical_call_id
     WHERE activation.workflow_id = ? AND activation.run_id = ? AND activation.node_id = ?
  `).get(workflowSlug, runId, stepId) as Record<string, unknown> | undefined;
  assert.ok(row, 'one canonical workflow-v3 call row exists');
  assert.equal(row.authority_kind, 'workflow_v3_call');
  assert.equal(row.authority_state, 'closed');
  assert.equal(row.logical_state, 'settled');
  assert.ok(row.outcome_kind === 'succeeded' || row.outcome_kind === 'empty_result');
  assert.equal(row.requires_reconciliation, 0);
  assert.equal(row.provider_crossings, 1);
  assert.equal(row.returned_crossings, 1);
}

test.after(async () => {
  _setBeforeWorkflowCallGatewayForTests(null);
  _setBeforeWorkflowGraphFinalizationForTests(null);
  _setToolSchemaLoaderForTests(null);
  resetToolSchemaCache();
  catalog.installHostCapabilityCatalogFactory(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  kernel.setWorkflowCallKernelCrashPointForTests(null);
  try { closeEventLog(); } catch { /* best effort */ }
  try { if (!process.env.CLEM_TEST_KEEP_HOME) rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('racing schedule admission creates one run, one append, verified readback, checkpoint, report, and terminal', async () => {
  const workflowSlug = 'platform49-new-runtime';
  const receiptId = 'workflow-schedule:v1:platform49-new-runtime:1785000060000';
  installProviderCapabilities([
    'DESTPROOF_APPEND_RECORD',
    'DESTPROOF_GET_RECORD',
  ]);
  writeWorkflow(workflowSlug, {
    name: workflowSlug,
    description: 'Append one new opaque item, verify it, then checkpoint it.',
    enabled: true,
    trigger: { manual: true, schedule: '1 9 * * *', timezone: 'UTC' },
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
  // At least one INDEPENDENT provider readback verified the append. The
  // checkpoint's own verification may be served from the verify step's
  // durable result handle (same tool, same exact args, clean envelope) —
  // read-reuse is designed behavior, so the pin asserts verification
  // happened without freezing the provider call count.
  const readbacks = after.counters.readback - before.counters.readback;
  assert.ok(readbacks >= 1 && readbacks <= 2, `verification readback ran (${readbacks})`);
  assert.deepEqual(after.destination[NEW_ITEM_ID], { id: NEW_ITEM_ID, value: 'new-item-value' });
  assert.equal(Object.hasOwn(after.destination, String(Number(NEW_ITEM_ID))), false, 'numeric normalization never creates a second identity');
  assert.deepEqual([...readSeenItemKeys(workflowSlug, 'checkpoint_verified_item')], [NEW_ITEM_ID]);

  assertCommittedV3Call(
    workflowSlug,
    runId,
    'append_destination',
    'DESTPROOF_APPEND_RECORD',
    { item_id: NEW_ITEM_ID, value: 'new-item-value' },
  );

  await processWorkflowRuns({ respond: async () => ({ text: 'must not run' }) } as never);
  const afterReplayTick = readProviderState();
  assert.deepEqual(afterReplayTick.counters, after.counters, 'a later drain cannot repeat a terminal effect');
  assert.equal(terminalJournalCount(workflowSlug, runId), 1);
  assert.equal(workflowNotifications(runId).filter((item) => item.id === `workflow-${runId}-completed`).length, 1);
});

test('a no-op poll performs no mutation and checkpoints one exact scan cursor', async () => {
  const workflowSlug = 'platform49-noop-runtime';
  installProviderCapabilities(['DESTPROOF_GET_SCAN_CURSOR']);
  writeWorkflow(workflowSlug, {
    name: workflowSlug,
    description: 'Read a no-change scan cursor and checkpoint the verified cursor.',
    enabled: true,
    trigger: { manual: true, schedule: '1 9 * * *', timezone: 'UTC' },
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
  installProviderCapabilities([
    'DESTPROOF_UPDATE_RECORD',
    'DESTPROOF_GET_RECORD',
  ]);
  writeWorkflow(workflowSlug, {
    name: workflowSlug,
    description: 'Update the changed item on the final source page, verify, and checkpoint it.',
    enabled: true,
    trigger: { manual: true, schedule: '1 9 * * *', timezone: 'UTC' },
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
  assertCommittedV3Call(
    workflowSlug,
    queued.id!,
    'update_destination',
    'DESTPROOF_UPDATE_RECORD',
    { item_id: FINAL_PAGE_ITEM_ID, value: 'changed-at-record-499' },
  );
});

test('unauthorized source dispatch stays zero while an authorized sibling commits once; same-run resume never repeats it', async () => {
  const workflowSlug = 'platform49-source-authority-runtime';
  const destinationId = '1785000000.000777';
  installProviderCapabilities(['DESTPROOF_APPEND_RECORD']);
  writeWorkflow(workflowSlug, {
    name: workflowSlug,
    description: 'Prove destination authority is independent from prohibited source mutation authority.',
    enabled: true,
    trigger: { manual: true, schedule: '1 9 * * *', timezone: 'UTC' },
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
  assertCommittedV3Call(
    workflowSlug,
    queued.id!,
    'write_destination',
    'DESTPROOF_APPEND_RECORD',
    { item_id: destinationId, value: 'authorized-destination-value' },
  );
  assert.equal(inspectWorkflowV3Call({
    workflowSlug,
    runId: queued.id!,
    stepId: 'mutate_source',
  }).status, 'missing', 'a pre-dispatch capability block creates no false v3 activation');

  installProviderCapabilities([
    'DESTPROOF_APPEND_RECORD',
    'SOURCEPROOF_UPDATE_RECORD',
  ]);
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
  assertCommittedV3Call(
    workflowSlug,
    queued.id!,
    'mutate_source',
    'SOURCEPROOF_UPDATE_RECORD',
    { item_id: FINAL_PAGE_ITEM_ID, value: 'authorized-after-resume' },
  );
});

test('provider commit with a lost response becomes ambiguous and is never blindly re-dispatched', async () => {
  const workflowSlug = 'platform49-orphan-runtime';
  const orphanId = '1785000000.000888';
  installProviderCapabilities(['ORPHANPROOF_APPEND_RECORD']);
  writeWorkflow(workflowSlug, {
    name: workflowSlug,
    description: 'Refuse a second mutation when the provider response is lost after commit.',
    enabled: true,
    trigger: { manual: true, schedule: '1 9 * * *', timezone: 'UTC' },
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
  const held = await drainUntil(queued.id!, (run) => (
    run.status === 'running'
    && run.heldExecution?.stepId === 'append_uncertain'
    && run.heldExecution?.hold?.wake === 'recovery'
  ));
  assert.equal(held.terminalOutcome, undefined);
  assert.equal(held.reportBack, undefined);
  assert.equal(held.heldExecution?.sourceStatus, 'dispatched');
  assert.equal(held.heldExecution?.hold?.owner, 'host');
  assert.equal(held.heldExecution?.hold?.reason, 'recovery_pending');
  assert.equal(terminalJournalCount(workflowSlug, queued.id!), 0);

  const afterFailure = readProviderState();
  assert.equal(afterFailure.counters.orphan - before.counters.orphan, 1, 'provider boundary crossed once');
  assert.deepEqual(afterFailure.destination[orphanId], { id: orphanId, value: 'may-have-landed' });
  const uncertain = inspectWorkflowV3Call(
    { workflowSlug, runId: queued.id!, stepId: 'append_uncertain' },
    {
      tool: 'ORPHANPROOF_APPEND_RECORD',
      args: { item_id: orphanId, value: 'may-have-landed' },
    },
  );
  assert.equal(uncertain.status, 'uncertain', JSON.stringify(uncertain));
  const durable = openEventLog().prepare(`
    SELECT settlement.outcome_kind,
           settlement.requires_reconciliation,
           authority.state AS authority_state,
           physical.state AS physical_state
      FROM workflow_node_invocation_activations activation
      JOIN accepted_turn_call_authorities authority
        ON authority.workflow_activation_id = activation.activation_id
      JOIN logical_call_settlements settlement
        ON settlement.session_id = activation.session_id
       AND settlement.source_user_seq = activation.source_event_seq
       AND settlement.logical_tool_call_id = activation.logical_call_id
      JOIN physical_dispatches physical
        ON physical.session_id = activation.session_id
       AND physical.source_user_seq = activation.source_event_seq
       AND physical.logical_tool_call_id = activation.logical_call_id
       AND physical.relation != 'probe'
     WHERE activation.workflow_id = ? AND activation.run_id = ? AND activation.node_id = ?
  `).get(workflowSlug, queued.id!, 'append_uncertain') as Record<string, unknown>;
  assert.equal(durable.outcome_kind, 'uncertain_write');
  assert.equal(durable.requires_reconciliation, 1);
  assert.equal(durable.authority_state, 'open');
  assert.equal(durable.physical_state, 'threw');
  assert.deepEqual(assessWorkflowV3RunMutationRequeue({ workflowSlug, runId: queued.id! }).blocking.map(
    (item) => ({ stepId: item.stepId, status: item.status }),
  ), [{ stepId: 'append_uncertain', status: 'uncertain' }]);

  const runCountBeforeRequeue = runFiles().length;
  const requeue = requeueWorkflowFromRun(queued.id!);
  assert.equal(requeue.status, 'ambiguous');
  assert.match(requeue.message, /not terminal|no overlapping rerun was queued/i);
  assert.equal(runFiles().length, runCountBeforeRequeue);

  await processWorkflowRuns({ respond: async () => ({ text: 'must not run' }) } as never);
  const afterReplayTick = readProviderState();
  assert.equal(afterReplayTick.counters.orphan, afterFailure.counters.orphan);
  assert.equal(terminalJournalCount(workflowSlug, queued.id!), 0);
  assert.equal(workflowNotifications(queued.id!).filter((item) => item.id.includes('-completed')).length, 0);
});

test('an exact scheduled direct send crosses once and terminal truth redeems only host commit evidence', async () => {
  const workflowSlug = 'platform49-exact-scheduled-send-runtime';
  const displayName = 'Platform 49 Exact Scheduled Send Display Name';
  const destination = 'fixed-exact-channel';
  const exactBody = 'provider-neutral exact scheduled payload';
  const tool = 'EXACTPROOF_SEND_MESSAGE';
  rememberToolSchema(tool, {
    type: 'object',
    required: ['channel', 'markdown_text'],
    properties: {
      channel: { type: 'string' },
      markdown_text: { type: 'string' },
    },
  }, Date.now());
  installProviderCapabilities([
    'DESTPROOF_APPEND_RECORD',
    'DESTPROOF_UPDATE_RECORD',
    'DESTPROOF_GET_RECORD',
    'DESTPROOF_GET_SCAN_CURSOR',
    'SOURCEPROOF_UPDATE_RECORD',
    'ORPHANPROOF_APPEND_RECORD',
    'EXACTPROOF_SEND_MESSAGE',
  ]);
  writeWorkflow(workflowSlug, {
    // Deliberately differs from the catalog/directory slug. The mutation ledger
    // and terminal redemption must use workflowSlug, never this display text.
    name: displayName,
    description: 'Render one reviewed update and send it to one fixed destination.',
    enabled: true,
    allowSends: true,
    trigger: { manual: true, schedule: '0 9 * * 1-5', timezone: 'UTC' },
    steps: [
      {
        id: 'render_message',
        prompt: '',
        sideEffect: 'read',
        transform: {
          version: 1,
          expression: { op: 'literal', value: { summary: exactBody } },
        },
        output: {
          type: 'object',
          required_keys: ['summary'],
          non_empty: ['summary'],
        },
      },
      {
        id: 'deliver_message',
        prompt: '',
        dependsOn: ['render_message'],
        sideEffect: 'send',
        call: {
          tool,
          args: {
            channel: destination,
            markdown_text: '{{steps.render_message.output.summary}}',
          },
        },
        output: {
          type: 'object',
          required_keys: ['providerResult', 'callEvidence'],
          non_empty: [
            'providerResult.kind',
            'providerResult.resultId',
            'providerResult.digest',
            'callEvidence.evidenceId',
            'callEvidence.mutationReceiptId',
            'callEvidence.canonicalTool',
            'callEvidence.kind',
            'callEvidence.status',
            'callEvidence.dispatchSchemaFingerprint',
            'callEvidence.expectedArgsDigest',
            'callEvidence.providerReadyArgsDigest',
            'callEvidence.providerResultDigest',
            'callEvidence.payloadDigest',
            'callEvidence.target.digest',
          ],
        },
      },
    ],
  });

  const before = readProviderState();
  const runFilesBeforeSchedule = new Set(runFiles());
  const schedulerResult = await processWorkflowSchedules(new Date('2026-08-13T09:00:00.000Z'));
  assert.equal(
    schedulerResult.fired.includes(displayName),
    true,
    'the real scheduler admits the display-named definition through its catalog slug',
  );
  const scheduledFiles = runFiles().filter((file) => {
    if (runFilesBeforeSchedule.has(file)) return false;
    return readRun(file.replace(/\.json$/, '')).workflow === displayName;
  });
  assert.equal(scheduledFiles.length, 1, 'one admitted occurrence belongs to the exact display-named workflow');
  const queuedRunId = scheduledFiles[0]!.replace(/\.json$/, '');
  const queuedRecord = readRun(queuedRunId);
  assert.equal(queuedRecord.workflow, displayName);
  assert.equal(queuedRecord.workflowSlug, workflowSlug, 'scheduled admission persists immutable catalog identity');
  await drainUntil(queuedRunId, (run) => run.status === 'completed');
  const completed = assertOneSuccessfulTerminal(workflowSlug, queuedRunId);

  const after = readProviderState();
  assert.equal(after.counters.send - before.counters.send, 1, 'the production call-node crosses the fake provider once');
  const sendInvocation = after.invocations.filter((invocation) => invocation.slug === tool).at(-1);
  assert.deepEqual(sendInvocation?.args, { channel: destination, markdown_text: exactBody });

  const deliverOutput = JSON.parse(completed.stepOutputs?.deliver_message ?? 'null') as {
    providerResult?: unknown;
    callEvidence?: Record<string, unknown>;
  } | null;
  const providerProjection = deliverOutput?.providerResult as {
    protocolVersion?: number; kind?: string; resultId?: string; digest?: string;
  } | undefined;
  assert.equal(providerProjection?.protocolVersion, 1);
  assert.equal(providerProjection?.kind, 'workflow_call_provider_result');
  assert.equal(deliverOutput?.callEvidence?.kind, 'workflow_call_commit');
  assert.equal(deliverOutput?.callEvidence?.status, 'committed');
  assert.match(String(deliverOutput?.callEvidence?.evidenceId ?? ''), /^workflow-call-evidence:v1:[a-f0-9]{64}$/);
  assert.equal(providerProjection?.digest, deliverOutput?.callEvidence?.providerResultDigest);
  assert.equal(providerProjection?.resultId, `workflow-call-result:v1:${providerProjection?.digest}`);
  const publicEvidence = JSON.stringify(deliverOutput);
  assert.equal(publicEvidence.includes('exact-provider-receipt-'), false, 'raw provider receipt remains ledger-only');
  assert.equal(publicEvidence.includes(destination), false, 'public host evidence contains only the target digest');
  assert.equal(publicEvidence.includes(exactBody), false, 'public host evidence contains only the payload digest');
  assertCommittedV3Call(
    workflowSlug,
    queuedRunId,
    'deliver_message',
    tool,
    { channel: destination, markdown_text: exactBody },
  );

  closeEventLog();
  await processWorkflowRuns({ respond: async () => ({ text: 'must not run' }) } as never);
  assert.equal(
    readProviderState().counters.send,
    after.counters.send,
    'a closed/reopened durable store and later drain do not repeat the settled send',
  );

  // A second real run crosses once, then a deterministic pre-terminal race
  // replaces only the journal projection with forged evidence. Output-contract
  // verification already passed on the genuine envelope, so this can be caught
  // only by the production terminal redemption hook re-reading the ledger.
  const beforeTamper = readProviderState();
  const tampered = queueWorkflowRun(workflowSlug, {}, {
    source: 'schedule',
    workflowSlug,
    triggerReceiptId: 'workflow-schedule:v1:platform49-exact-scheduled-send-runtime:1785000480000',
  });
  assert.equal(tampered.status, 'queued', tampered.message);
  _setBeforeWorkflowGraphFinalizationForTests(({ workflowName, runId }) => {
    if (workflowName !== workflowSlug || runId !== tampered.id) return;
    const genuine = readWorkflowEvents(workflowName, runId)
      .filter((event) => event.kind === 'step_completed' && event.stepId === 'deliver_message')
      .at(-1)?.output as { providerResult?: unknown; callEvidence?: unknown } | undefined;
    assert.ok(genuine?.callEvidence, 'production call node emitted genuine host evidence before tamper');
    appendWorkflowEventDurably(workflowName, runId, {
      kind: 'step_completed',
      stepId: 'deliver_message',
      output: {
        providerResult: {
          protocolVersion: 1,
          kind: 'workflow_call_provider_result',
          resultId: `workflow-call-result:v1:${'0'.repeat(64)}`,
          digest: '0'.repeat(64),
        },
        callEvidence: genuine!.callEvidence,
      },
    });
  });
  try {
    await drainUntil(tampered.id!, (run) => run.status === 'completed');
  } finally {
    _setBeforeWorkflowGraphFinalizationForTests(null);
  }
  const repaired = readRun(tampered.id!);
  assert.equal(readProviderState().counters.send - beforeTamper.counters.send, 1, 'terminal tamper never causes a duplicate provider crossing');
  assert.notEqual(repaired.needsAttention, true, 'successful canonical repair must not require attention');
  assert.equal(repaired.reportBack?.outcome, 'done');
  const repairedOutput = JSON.parse(repaired.stepOutputs?.deliver_message ?? 'null') as {
    providerResult?: { digest?: string; resultId?: string };
    callEvidence?: { providerResultDigest?: string };
  };
  assert.notEqual(repairedOutput.providerResult?.digest, '0'.repeat(64));
  assert.equal(repairedOutput.providerResult?.digest, repairedOutput.callEvidence?.providerResultDigest);
  assert.equal(
    repairedOutput.providerResult?.resultId,
    `workflow-call-result:v1:${repairedOutput.providerResult?.digest}`,
  );
  assert.equal(JSON.stringify(repairedOutput).includes('exact-provider-receipt-'), false);
  assert.ok(repairedOutput.callEvidence, 'canonical committed envelope replaces forged journal bytes');
  assert.ok(readWorkflowEvents(workflowSlug, tampered.id!).some((event) => (
    event.kind === 'step_advisory'
    && event.stepId === 'deliver_message'
    && event.meta?.reason === 'exact_send_projection_repaired_from_committed_ledger'
    && event.meta?.providerRedispatched === false
  )), 'terminal repair is auditable and explicitly records zero redispatch');

  // An expired exact-schema lease plus a transient metadata outage is a
  // proven-pre-dispatch dependency pause, not a terminal failure. The same
  // accepted occurrence retries after one exact-slug refresh; its already
  // durable render is reused and the provider is crossed only after healing.
  const schemaOutage = queueWorkflowRun(workflowSlug, {}, {
    source: 'schedule',
    workflowSlug,
    triggerReceiptId: 'workflow-schedule:v1:platform49-exact-scheduled-send-runtime:1785000600000',
  });
  assert.equal(schemaOutage.status, 'queued', schemaOutage.message);
  appendWorkflowEventDurably(workflowSlug, schemaOutage.id!, {
    kind: 'step_completed',
    stepId: 'render_message',
    output: { summary: exactBody },
  });
  const beforeSchemaOutage = readProviderState();
  const realDateNowForSchemaOutage = Date.now;
  Date.now = () => realDateNowForSchemaOutage() + (31 * 60_000);
  _clearToolSchemaCacheForTest();
  _setToolSchemaLoaderForTests(async (requested) => {
    assert.equal(requested, tool, 'recovery probes only the pinned exact slug');
    return null;
  });
  try {
    const parked = await drainUntil(schemaOutage.id!, (run) => run.status === 'blocked_capability');
    assert.equal(parked.capabilityBlock?.reason, 'exact_schema_refresh_unavailable');
    assert.equal(parked.capabilityBlock?.provenNoDispatch, true);
    assert.equal(parked.terminalOutcome, undefined);
    assert.equal(parked.reportBack, undefined);
    assert.equal(terminalJournalCount(workflowSlug, schemaOutage.id!), 0);
    assert.equal(
      readWorkflowEvents(workflowSlug, schemaOutage.id!).some((event) => (
        event.kind === 'step_started' && event.stepId === 'deliver_message'
      )),
      false,
      'schema preflight parks before the exact send lifecycle begins',
    );
    assert.equal(inspectWorkflowV3Call({
      workflowSlug,
      runId: schemaOutage.id!,
      stepId: 'deliver_message',
    }).status, 'missing', 'proven-pre-dispatch schema park owns no v3 activation');
    assert.equal(
      readProviderState().counters.send - beforeSchemaOutage.counters.send,
      0,
      'metadata outage never crosses the provider',
    );
    assert.equal(
      readWorkflowEvents(workflowSlug, schemaOutage.id!).filter((event) => (
        event.kind === 'step_completed' && event.stepId === 'render_message'
      )).length,
      1,
      'prior transform completion is preserved while parked',
    );

    _setToolSchemaLoaderForTests(async (requested) => {
      assert.equal(requested, tool, 'self-heal remains one exact-slug metadata lookup');
      return {
        inputParameters: {
          type: 'object',
          required: ['channel', 'markdown_text'],
          properties: {
            channel: { type: 'string' },
            markdown_text: { type: 'string' },
          },
        },
        providerObservedAt: Date.now(),
      };
    });
    assert.equal(reapCapabilityBlockedRuns(Date.now() + 3_600_000), 1);
    assert.equal(readRun(schemaOutage.id!).status, 'running', 'the accepted occurrence keeps its run id');
    await drainUntil(schemaOutage.id!, (run) => run.status === 'completed');
    assertOneSuccessfulTerminal(workflowSlug, schemaOutage.id!);
    assert.equal(
      readProviderState().counters.send - beforeSchemaOutage.counters.send,
      1,
      'healed same-run retry crosses exactly once',
    );
    assert.equal(
      readWorkflowEvents(workflowSlug, schemaOutage.id!).filter((event) => (
        event.kind === 'step_completed' && event.stepId === 'render_message'
      )).length,
      1,
      'same-run recovery does not repeat completed upstream work',
    );
  } finally {
    Date.now = realDateNowForSchemaOutage;
    _setToolSchemaLoaderForTests(null);
    rememberToolSchema(tool, {
      type: 'object',
      required: ['channel', 'markdown_text'],
      properties: {
        channel: { type: 'string' },
        markdown_text: { type: 'string' },
      },
    }, Date.now());
  }

  // The same scheduled definition may be manually runnable for diagnostics,
  // but schedule consent never authorizes its SEND on a manual occurrence.
  const beforeManual = readProviderState();
  const manual = queueWorkflowRun(workflowSlug, {}, { source: 'manual' });
  assert.equal(manual.status, 'queued', manual.message);
  await drainUntil(manual.id!, (run) => run.status === 'error');
  const manualRun = readRun(manual.id!);
  assert.match(manualRun.error ?? '', /no accepted schedule occurrence|run_source_not_schedule/i);
  assert.equal(
    readProviderState().counters.send - beforeManual.counters.send,
    0,
    'manual occurrence is refused before provider I/O',
  );

});
