/** Run: npx tsx --test src/runtime/harness/workflow-paginated-read-kernel.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-paginated-read-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const eventlog = await import('./eventlog.js');
const pagination = await import('./workflow-paginated-read-authority.js');
const kernel = await import('./workflow-paginated-read-kernel.js');
const dispatch = await import('./dispatch-ledger.js');
const manifests = await import('./capability-manifest.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const observations = await import('./independent-capability-observation.js');
const ports = await import('./production-capability-ports.js');
const plans = await import('../../memory/workflow-node-invocation-plan.js');

test.after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
let serial = 0;

function installPagedRead(
  responses: unknown[] | ((args: Record<string, unknown>, body: number) => Promise<unknown>),
  maxPages = 8,
) {
  const suffix = String(++serial);
  const exactManifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.page.${suffix}`,
    providerKind: 'local_registry',
    operationId: `enumerate_scope_${suffix}`,
    providerIdentity: 'runtime.test',
    providerVersion: 'runtime.1',
    operationVersion: '1',
    definitionFingerprint: digest(`schema:${suffix}`),
    effect: 'read',
    accountId: `account.${suffix}`,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'read_bounded_records',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'host.test', issuedAt: '2026-08-22T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
  });
  let bodies = 0;
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(exactManifest),
    {
      invoke: async (input) => {
        const index = bodies++;
        const args = input.payload as Record<string, unknown>;
        return typeof responses === 'function' ? responses(args, index) : responses[index];
      },
    },
  ).ok, true);
  const entry: catalogs.RegisteredHostCapability = {
    capabilityId: exactManifest.manifestId,
    toolName: exactManifest.operationId,
    schemaVersion: exactManifest.operationVersion,
    schemaDigest: exactManifest.definitionFingerprint,
    effect: exactManifest.effect,
    account: exactManifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(exactManifest),
    providerKind: exactManifest.providerKind,
    liveFingerprint: exactManifest.definitionFingerprint,
    manifest: exactManifest,
    invoke: async () => { throw new Error('catalog callback is not the immutable port'); },
  };
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory([entry]));
  assert.equal(observations.registerIndependentCapabilityObservation({
    operationId: exactManifest.operationId,
    accountId: exactManifest.accountId,
    definitionFingerprint: exactManifest.definitionFingerprint,
    providerVersion: exactManifest.providerVersion,
    operationVersion: exactManifest.operationVersion,
    observedAt: Date.now(),
    origin: 'independent',
    observe: () => ({
      operationId: exactManifest.operationId,
      accountId: exactManifest.accountId,
      definitionFingerprint: exactManifest.definitionFingerprint,
      providerVersion: exactManifest.providerVersion,
      operationVersion: exactManifest.operationVersion,
      observedAt: Date.now(),
    }),
  }).ok, true);
  const identity = catalogs.canonicalCatalogIdentityOf(entry);
  assert.ok(identity);
  const plan = plans.createWorkflowNodeInvocationPlan({
    requirementId: `requirement.page.${suffix}`,
    logicalCapabilityId: `capability.page.${suffix}`,
    binding: {
      capabilityId: identity.capabilityId,
      manifestId: identity.manifestId,
      manifestDigest: identity.manifestDigest,
      operationId: identity.operationId,
      operationVersion: identity.schemaVersion,
      schemaDigest: identity.schemaDigest,
      providerVersion: identity.providerVersion,
      liveFingerprint: identity.liveFingerprint,
      accountId: identity.account,
      effect: 'read',
      invokePortId: identity.invokePortId,
      argumentCompiler: { ...identity.argumentCompiler },
    },
    arguments: {
      scope: { source: { kind: 'workflow_input', key: 'scope' }, required: true, type: 'string' },
      cursor: { source: { kind: 'continuation_cursor' }, required: false, type: 'string' },
    },
    evidence: { requiredPaths: ['records'], nonEmptyPaths: ['records'], minItems: { records: 1 } },
    completeness: { kind: 'finite_exhaustive', exhaustedPath: 'page.exhausted', evidencePaths: ['records'] },
    continuation: {
      kind: 'cursor',
      cursorArgument: 'cursor',
      nextCursorPath: 'page.next',
      exhaustedPath: 'page.exhausted',
      maxPages,
    },
  });
  return { plan, bodies: () => bodies, exactManifest };
}

function arm(plan: plans.WorkflowNodeInvocationPlanV1, label: string) {
  const session = eventlog.createSession({ id: `pagination-session-${label}`, kind: 'workflow' });
  return pagination.armWorkflowPaginatedReadAuthority({
    sessionId: session.id,
    workflowId: `workflow.${label}`,
    workflowRevision: 1,
    workflowDigest: digest(`workflow:${label}`),
    runId: `run.${label}`,
    runOccurrenceId: `occurrence.${label}`,
    nodeId: `node.${label}`,
    nodeAttempt: 1,
    invocationPlan: plan,
    bindingSnapshotDigest: digest(`binding:${label}`),
    controlDigest: digest(`control:${label}`),
  });
}

test('two pages exhaust under one activation and closed replay has zero new bodies', async () => {
  const installed = installPagedRead([
    { records: [{ id: 'a' }], page: { exhausted: false, next: 'cursor-2' } },
    { records: [{ id: 'b' }], page: { exhausted: true, next: null } },
  ]);
  const armed = arm(installed.plan, 'two-pages');
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  if (armed.status !== 'armed') return;
  assert.equal(armed.authority.authorityKind, 'workflow_v2_paginated_read');
  assert.equal(armed.ref.nodeAttempt, 1);

  const completed = await kernel.executeWorkflowPaginatedRead({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    baseArgs: { scope: 'current' },
  });
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  if (completed.status !== 'completed') return;
  assert.equal(completed.aggregate.coverageState, 'complete');
  assert.equal(completed.aggregate.finalExhaustedTruth, 'true');
  assert.equal(completed.aggregate.pageCount, 2);
  assert.equal(completed.aggregate.totalItemCount, 2);
  assert.equal(installed.bodies(), 2);

  const db = eventlog.openEventLog();
  assert.deepEqual(db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM workflow_paginated_read_activations WHERE activation_id = ?) AS activations,
      (SELECT COUNT(*) FROM workflow_node_invocation_activations WHERE session_id = ?) AS v51_activations,
      (SELECT COUNT(*) FROM workflow_paginated_read_pages WHERE activation_id = ?) AS pages,
      (SELECT COUNT(*) FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ?) AS logical_calls,
      (SELECT COUNT(*) FROM physical_dispatches WHERE session_id = ? AND source_user_seq = ?
        AND io_claimed_at IS NOT NULL AND state = 'returned') AS crossings,
      (SELECT COUNT(*) FROM workflow_paginated_aggregate_receipts WHERE activation_id = ?) AS terminals,
      (SELECT COUNT(*) FROM accepted_task_resolutions WHERE session_id = ?) AS graph_rows
  `).get(
    armed.ref.activationId, armed.ref.sessionId, armed.ref.activationId,
    armed.ref.sessionId, armed.ref.sourceEventSeq,
    armed.ref.sessionId, armed.ref.sourceEventSeq,
    armed.ref.activationId, armed.ref.sessionId,
  ), {
    activations: 1,
    v51_activations: 0,
    pages: 2,
    logical_calls: 2,
    crossings: 2,
    terminals: 1,
    graph_rows: 0,
  });
  const logicalIds = db.prepare(`
    SELECT logical_call_id FROM workflow_paginated_read_pages
     WHERE activation_id = ? ORDER BY page_ordinal
  `).all(armed.ref.activationId) as Array<{ logical_call_id: string }>;
  assert.equal(new Set(logicalIds.map((row) => row.logical_call_id)).size, 2);

  const replay = await kernel.executeWorkflowPaginatedRead({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    baseArgs: { scope: 'current' },
  });
  assert.equal(replay.status, 'replayed');
  if (replay.status === 'replayed') {
    assert.equal(replay.aggregate.aggregateReceiptDigest, completed.aggregate.aggregateReceiptDigest);
  }
  assert.equal(installed.bodies(), 2);
  assert.equal(db.pragma('foreign_key_check').length, 0);
});

test('a repeated cursor stops before a third body and closes partial once', async () => {
  const installed = installPagedRead([
    { records: [{ id: 'a' }], page: { exhausted: false, next: 'same' } },
    { records: [{ id: 'b' }], page: { exhausted: false, next: 'same' } },
  ]);
  const armed = arm(installed.plan, 'cycle');
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;
  const result = await kernel.executeWorkflowPaginatedRead({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    baseArgs: { scope: 'cycle' },
  });
  assert.equal(result.status, 'partial', JSON.stringify(result));
  if (result.status === 'partial') assert.equal(result.reason, 'repeated_cursor');
  assert.equal(installed.bodies(), 2);
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM workflow_paginated_read_pages
    WHERE activation_id = ?`).get(armed.ref.activationId) as { n: number }).n, 2);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM workflow_paginated_aggregate_receipts
    WHERE activation_id = ?`).get(armed.ref.activationId) as { n: number }).n, 1);
  const replay = await kernel.executeWorkflowPaginatedRead({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    baseArgs: { scope: 'cycle' },
  });
  assert.equal(replay.status, 'partial');
  if (replay.status === 'partial') {
    assert.equal(replay.reason, 'repeated_cursor');
    assert.equal(replay.aggregate.aggregateReceiptDigest, result.status === 'partial'
      ? result.aggregate.aggregateReceiptDigest : 'unreachable');
  }
  assert.equal(installed.bodies(), 2, 'closed partial replay must never redispatch');
});

test('page budget and ambiguous exhaustion are durable partial outcomes, never complete', async () => {
  const budgeted = installPagedRead([
    { records: [{ id: 'a' }], page: { exhausted: false, next: 'b' } },
  ], 1);
  const budgetRoot = arm(budgeted.plan, 'budget');
  assert.equal(budgetRoot.status, 'armed');
  if (budgetRoot.status !== 'armed') return;
  const budget = await kernel.executeWorkflowPaginatedRead({
    activationId: budgetRoot.ref.activationId,
    invocationPlan: budgeted.plan,
    baseArgs: { scope: 'budget' },
  });
  assert.equal(budget.status, 'partial');
  if (budget.status === 'partial') {
    assert.equal(budget.reason, 'maximum_page_budget_reached');
    assert.notEqual(budget.aggregate.coverageState, 'complete');
  }
  assert.equal(budgeted.bodies(), 1);

  const unknown = installPagedRead([
    { records: [{ id: 'u' }], page: { next: null } },
  ]);
  const unknownRoot = arm(unknown.plan, 'unknown');
  assert.equal(unknownRoot.status, 'armed');
  if (unknownRoot.status !== 'armed') return;
  const ambiguous = await kernel.executeWorkflowPaginatedRead({
    activationId: unknownRoot.ref.activationId,
    invocationPlan: unknown.plan,
    baseArgs: { scope: 'unknown' },
  });
  assert.equal(ambiguous.status, 'partial');
  if (ambiguous.status === 'partial') {
    assert.equal(ambiguous.reason, 'unknown_exhaustion');
    assert.equal(ambiguous.aggregate.finalExhaustedTruth, 'unknown');
    assert.notEqual(ambiguous.aggregate.coverageState, 'complete');
  }
});

test('concurrent/restart reentry after physical claim never redispatches or closes the winning root', async () => {
  let entered!: () => void;
  let release!: () => void;
  const bodyEntered = new Promise<void>((resolve) => { entered = resolve; });
  const bodyRelease = new Promise<void>((resolve) => { release = resolve; });
  const installed = installPagedRead(async () => {
    entered();
    await bodyRelease;
    return { records: [{ id: 'one' }], page: { exhausted: true, next: null } };
  });
  const armed = arm(installed.plan, 'crash-after-claim');
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;
  const winner = kernel.executeWorkflowPaginatedRead({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    baseArgs: { scope: 'same' },
  });
  await bodyEntered;
  const reentry = await kernel.executeWorkflowPaginatedRead({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    baseArgs: { scope: 'same' },
  });
  assert.equal(reentry.status, 'blocked');
  if (reentry.status === 'blocked') {
    assert.equal(reentry.reason, 'prior_crossing_unknown_no_redispatch');
    assert.equal(reentry.zeroBody, false);
  }
  assert.equal(installed.bodies(), 1);
  const stillOpen = pagination.readWorkflowPaginatedReadAuthority(armed.ref.activationId);
  assert.equal(stillOpen.status, 'ok');
  if (stillOpen.status === 'ok') assert.equal(stillOpen.ref.aggregateState, 'open');
  release();
  const completed = await winner;
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
});

test('restart after page settlement and after final settlement replays exact receipts without duplicate bodies', async () => {
  const installed = installPagedRead([
    { records: [{ id: 'a' }], page: { exhausted: false, next: 'next' } },
    { records: [{ id: 'b' }], page: { exhausted: true, next: null } },
  ]);
  const armed = arm(installed.plan, 'settlement-restart');
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER abort_second_page_reservation
    BEFORE INSERT ON workflow_paginated_read_pages
    WHEN NEW.activation_id = '${armed.ref.activationId}' AND NEW.page_ordinal = 1
    BEGIN SELECT RAISE(ABORT, 'fixture crash before second reservation'); END;
  `);
  const first = await kernel.executeWorkflowPaginatedRead({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    baseArgs: { scope: 'resume' },
  });
  assert.equal(first.status, 'blocked');
  assert.equal(installed.bodies(), 1);
  assert.deepEqual(db.prepare(`SELECT state, page_receipt_digest IS NOT NULL AS receipt
    FROM workflow_paginated_read_pages WHERE activation_id = ? AND page_ordinal = 0`)
    .get(armed.ref.activationId), { state: 'settled', receipt: 1 });
  db.exec('DROP TRIGGER abort_second_page_reservation');
  const resumed = await kernel.executeWorkflowPaginatedRead({
    activationId: armed.ref.activationId,
    invocationPlan: installed.plan,
    baseArgs: { scope: 'resume' },
  });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.equal(installed.bodies(), 2, 'settled page zero was redeemed, not dispatched again');

  const finalInstalled = installPagedRead([
    { records: [{ id: 'only' }], page: { exhausted: true, next: null } },
  ]);
  const finalRoot = arm(finalInstalled.plan, 'final-close-restart');
  assert.equal(finalRoot.status, 'armed');
  if (finalRoot.status !== 'armed') return;
  db.exec(`
    CREATE TRIGGER abort_paginated_aggregate_close
    BEFORE INSERT ON workflow_paginated_aggregate_receipts
    WHEN NEW.activation_id = '${finalRoot.ref.activationId}'
    BEGIN SELECT RAISE(ABORT, 'fixture crash before aggregate close'); END;
  `);
  const cut = await kernel.executeWorkflowPaginatedRead({
    activationId: finalRoot.ref.activationId,
    invocationPlan: finalInstalled.plan,
    baseArgs: { scope: 'final' },
  });
  assert.equal(cut.status, 'failed');
  assert.equal(finalInstalled.bodies(), 1);
  const open = pagination.readWorkflowPaginatedReadAuthority(finalRoot.ref.activationId);
  assert.equal(open.status, 'ok');
  if (open.status === 'ok') assert.equal(open.ref.aggregateState, 'open');
  db.exec('DROP TRIGGER abort_paginated_aggregate_close');
  const finalReplay = await kernel.executeWorkflowPaginatedRead({
    activationId: finalRoot.ref.activationId,
    invocationPlan: finalInstalled.plan,
    baseArgs: { scope: 'final' },
  });
  assert.equal(finalReplay.status, 'completed', JSON.stringify(finalReplay));
  assert.equal(finalInstalled.bodies(), 1, 'final page receipt rebuilt the aggregate without another crossing');
});

test('live binding drift and pre-claim cancellation close partial with zero next bodies', async () => {
  const drifting = installPagedRead(async (_args, body) => {
    if (body === 0) {
      observations.clearIndependentCapabilityObservations();
      return { records: [{ id: 'first' }], page: { exhausted: false, next: 'next' } };
    }
    return { records: [{ id: 'forbidden' }], page: { exhausted: true, next: null } };
  });
  const driftRoot = arm(drifting.plan, 'binding-drift');
  assert.equal(driftRoot.status, 'armed');
  if (driftRoot.status !== 'armed') return;
  const drifted = await kernel.executeWorkflowPaginatedRead({
    activationId: driftRoot.ref.activationId,
    invocationPlan: drifting.plan,
    baseArgs: { scope: 'drift' },
  });
  assert.equal(drifted.status, 'partial', JSON.stringify(drifted));
  if (drifted.status === 'partial') assert.equal(drifted.reason, 'live_binding_drift');
  assert.equal(drifting.bodies(), 1);

  const cancellable = installPagedRead([
    { records: [{ id: 'forbidden' }], page: { exhausted: true, next: null } },
  ]);
  const cancelledRoot = arm(cancellable.plan, 'cancelled');
  assert.equal(cancelledRoot.status, 'armed');
  if (cancelledRoot.status !== 'armed') return;
  const controller = new AbortController();
  controller.abort();
  const cancelled = await kernel.executeWorkflowPaginatedRead({
    activationId: cancelledRoot.ref.activationId,
    invocationPlan: cancellable.plan,
    baseArgs: { scope: 'cancelled' },
    signal: controller.signal,
  });
  assert.equal(cancelled.status, 'partial', JSON.stringify(cancelled));
  assert.equal(cancellable.bodies(), 0);
  const replay = await kernel.executeWorkflowPaginatedRead({
    activationId: cancelledRoot.ref.activationId,
    invocationPlan: cancellable.plan,
    baseArgs: { scope: 'cancelled' },
  });
  assert.equal(replay.status, 'partial');
  if (replay.status === 'partial') assert.equal(replay.reason, 'cancelled_before_page_crossing');
  assert.equal(cancellable.bodies(), 0);
});

test('direct ledger bypass refuses before any body', async () => {
  const installed = installPagedRead([
    { records: [{ id: 'a' }], page: { exhausted: false, next: 'two' } },
    { records: [{ id: 'b' }], page: { exhausted: true, next: null } },
  ]);
  const armed = arm(installed.plan, 'bypass');
  assert.equal(armed.status, 'armed');
  if (armed.status !== 'armed') return;
  const reserved = pagination.reserveWorkflowReadPage({
    activationId: armed.ref.activationId,
    pageOrdinal: 0,
    priorPageReceiptDigest: null,
    invocationPlan: installed.plan,
    args: { scope: 'bypass' },
  });
  assert.equal(reserved.status, 'reserved');
  if (reserved.status !== 'reserved') return;
  const bypass = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId: armed.ref.sessionId,
      sourceUserSeq: armed.ref.sourceEventSeq,
      acceptedTaskId: armed.ref.authorityRootId,
      logicalToolCallId: reserved.ref.logicalCallId,
      physicalDispatchId: reserved.ref.physicalDispatchId,
      ordinal: 0,
    },
    tool: installed.exactManifest.operationId,
    args: { scope: 'bypass' },
  });
  assert.equal(bypass.status, 'conflict');
  assert.equal(installed.bodies(), 0);
});
