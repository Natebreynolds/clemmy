/** Run: node scripts/run-tests-isolated.mjs src/execution/automation-read-pilot-run.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-automation-read-pilot-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const runBridge = await import('./automation-read-pilot-run.js');
const bridge = await import('./automation-workflow-bridge.js');
const opportunities = await import('./automation-opportunity.js');
const executor = await import('./workflow-node-invocation-executor.js');
const runner = await import('./workflow-runner.js');
const workflowEvents = await import('./workflow-events.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const materializer = await import('../runtime/harness/live-capability-materializer.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const shipped = await import('../runtime/harness/shipped-implementation-identity.js');
const workflows = await import('../memory/workflow-store.js');
const shared = await import('../tools/shared.js');
import type { ClementineAssistant } from '../assistant/core.js';
import type { AutomationOpportunityProposalRecordV1 } from './automation-opportunity-store.js';
import type { AutomationReadPilotCompilationInputV1 } from './automation-read-pilot-run.js';
import type { WorkflowReadPilotAdmissionV1 } from './workflow-read-pilot-admission.js';
import type { WorkflowRunDefinitionSnapshot } from './workflow-run-definition.js';

test.after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  eventlog.closeEventLog();
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

async function coldCompilationFixture(
  label = 'alpha',
  pagination?: { responses: unknown[]; maxPages: number },
) {
  const objective = `retrieve bounded ${label} values`;
  const operationId = `operation.${label}`;
  const accountId = `account.${label}`;
  let bodies = 0;
  const seenArgs: Array<Record<string, unknown>> = [];
  const carrier: materializer.LiveCapabilityCarrier = {
    identity: { kind: 'host', name: `carrier.${label}` },
    async enumerate() {
      return [{
        identifier: operationId,
        carrierKind: 'host' as const,
        carrier: `carrier.${label}`,
        displayName: `Bounded ${label} values`,
        description: objective,
        effectClass: 'read' as const,
        effectProvenance: 'inferred' as const,
        accountIdentity: accountId,
      }];
    },
    async refresh() {},
    observe(reference) {
      if (reference.identifier !== operationId || reference.accountId !== accountId) return 'missing';
      return {
        operationId,
        providerKind: 'local_registry',
        providerIdentity: `runtime.${label}`,
        providerVersion: '1',
        operationVersion: '1',
        accountId,
        effect: 'read',
        effectAttestation: 'carrier_declared',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scope: { type: 'string' },
            cursor: { type: 'string' },
          },
          required: ['scope'],
        },
        observedAt: Date.now(),
        invoke: {
          portId: `port.${label}`,
          argumentCompiler: { id: `compiler.${label}`, version: '1' },
        },
      };
    },
  };
  const store = manifestStores.createCapabilityManifestStore();
  const factory = catalogs.createHostCapabilityCatalogFactory();
  manifestStores.installCapabilityManifestStore(store);
  catalogs.installHostCapabilityCatalogFactory(factory);
  const installed = await materializer.materializeLiveReadCapability({
    objective,
    carrier,
    store,
    factory,
    registerPort: ({ manifest, attestation }) => {
      shipped.loadShippedImplementations().registerIsolatedObservation({
        operationId: attestation.reference.identifier,
        accountId: attestation.accountId,
        definitionFingerprint: attestation.definitionFingerprint,
        providerVersion: attestation.providerVersion,
        operationVersion: attestation.operationVersion,
        observedAt: Date.now(),
      });
      return ports.registerFixtureCapabilityPort(
        ports.productionPortIdentityFromManifest(manifest),
        {
          invoke: async ({ payload }) => {
            const args = structuredClone(payload as Record<string, unknown>);
            seenArgs.push(args);
            const ordinal = bodies;
            bodies += 1;
            if (pagination) {
              if (ordinal >= pagination.responses.length) {
                throw new Error(`unexpected page body ${ordinal}`);
              }
              return structuredClone(pagination.responses[ordinal]);
            }
            return { records: [{ id: `record.${label}`, scope: args.scope }] };
          },
        },
      );
    },
  });
  assert.equal(installed.status, 'installed', JSON.stringify(installed));
  const entry = factory.snapshot()[0];
  assert.ok(entry);
  const identity = catalogs.canonicalCatalogIdentityOf(entry);
  assert.ok(identity);

  const maxOperations = pagination?.maxPages ?? 1;
  const opportunity = opportunities.parseAutomationOpportunity({
    version: 1,
    title: `Bounded ${label} read pilot`,
    objective: `Retrieve one bounded ${label} result with exact evidence.`,
    rationale: 'A disabled pilot verifies the exact capability binding.',
    lifetime: { kind: 'single_run' },
    recurrence: { mode: 'none' },
    trigger: { kind: 'manual' },
    partition: {
      mode: 'single',
      checkpointEvery: 1,
      completion: { kind: 'terminal_evidence', evidence: ['A non-empty result is present.'] },
    },
    capabilityRequirements: [{
      id: 'bounded-read',
      description: 'Read the exact bounded result.',
      minimumEffect: 'read',
      constraints: ['Return a non-empty result.'],
    }],
    phases: [{
      id: 'read-result',
      objective: `Read the exact bounded ${label} result.`,
      dependsOn: [],
      capabilityRequirementIds: ['bounded-read'],
      effect: { class: 'read', approval: 'not_required', maxOperationsPerRun: maxOperations },
      partitioned: false,
      outputEvidence: ['The records collection is non-empty.'],
    }],
    effectCeiling: { class: 'read', maxOperationsPerRun: maxOperations },
    deliverables: [{
      id: 'result',
      description: 'The bounded result.',
      kind: 'artifact',
      required: true,
      successCriterionIds: ['complete'],
      evidence: ['The records collection is present.'],
    }],
    missingInputs: [],
    successCriteria: [{
      id: 'complete',
      description: 'The bounded result is complete.',
      evidence: ['The records collection is non-empty.'],
    }],
    pilot: {
      required: true,
      maxPartitions: 1,
      maxRecords: 10,
      effectCeiling: { class: 'read', maxOperationsPerRun: maxOperations },
      successCriterionIds: ['complete'],
      haltOnFailure: true,
    },
    budgets: {
      maxWallClockMinutesPerRun: 5,
      maxConcurrentPartitions: 1,
      maxAttemptsPerPartition: 1,
      maxPartitionsPerRun: 1,
      maxRecordsPerRun: 10,
      maxOperationsPerRun: maxOperations,
      reserveOperations: 0,
    },
  });
  const proposal: AutomationOpportunityProposalRecordV1 = {
    version: 1,
    proposalId: `proposal.${label}`,
    status: 'approved',
    revision: 1,
    digest: opportunities.automationOpportunityDigest(opportunity),
    opportunity,
    createdAt: '2026-08-22T12:00:00.000Z',
    updatedAt: '2026-08-22T12:01:00.000Z',
    reviewedAt: '2026-08-22T12:00:30.000Z',
    decidedAt: '2026-08-22T12:01:00.000Z',
  };
  const capability = {
    lifecycle: 'current' as const,
    logicalToolName: `display.${label}`,
    identity,
    matches: [{
      requirementId: 'bounded-read',
      requirementDigest: bridge.automationCapabilityRequirementDigest(
        opportunity.capabilityRequirements[0],
      ),
    }],
  };
  const compilation: AutomationReadPilotCompilationInputV1 = {
    proposal,
    expectedProposalRevision: proposal.revision,
    expectedProposalDigest: proposal.digest,
    liveSnapshot: {
      capabilities: [capability],
      digest: bridge.automationLiveCapabilitySnapshotDigest([capability]),
    },
    readPilotContract: {
      phaseId: 'read-result',
      requirementId: 'bounded-read',
      workflowInputs: { scope: { type: 'string', required: true } },
      arguments: {
        scope: {
          source: { kind: 'workflow_input', key: 'scope' },
          required: true,
          type: 'string',
        },
        ...(pagination ? {
          cursor: {
            source: { kind: 'continuation_cursor' as const },
            required: false,
            type: 'string' as const,
          },
        } : {}),
      },
      evidence: {
        requiredPaths: ['records'],
        nonEmptyPaths: ['records'],
        minItems: { records: 1 },
      },
      completeness: pagination
        ? {
            kind: 'finite_exhaustive' as const,
            exhaustedPath: 'page.exhausted',
            evidencePaths: ['records'],
          }
        : { kind: 'terminal_result' as const, evidencePaths: ['records'] },
      ...(pagination ? {
        continuation: {
          kind: 'cursor' as const,
          cursorArgument: 'cursor',
          nextCursorPath: 'page.next',
          exhaustedPath: 'page.exhausted',
          maxPages: pagination.maxPages,
        },
      } : {}),
    },
  };
  return {
    compilation,
    bodies: () => bodies,
    seenArgs: () => structuredClone(seenArgs),
    workflowInput: `scope.${label}`,
  };
}

function kernelCounts(): {
  activations: number;
  logical_calls: number;
  physical_calls: number;
  settlements: number;
} {
  return eventlog.openEventLog().prepare(`
    SELECT
      (SELECT COUNT(*) FROM workflow_node_invocation_activations) AS activations,
      (SELECT COUNT(*) FROM logical_tool_calls) AS logical_calls,
      (SELECT COUNT(*) FROM physical_dispatches WHERE io_claimed_at IS NOT NULL) AS physical_calls,
      (SELECT COUNT(*) FROM logical_call_settlements) AS settlements
  `).get() as {
    activations: number;
    logical_calls: number;
    physical_calls: number;
    settlements: number;
  };
}

function queueApprovedFixture(
  fixture: Awaited<ReturnType<typeof coldCompilationFixture>>,
  label: string,
) {
  const chat = eventlog.createSession({ id: `chat.pilot.${label}`, kind: 'chat' });
  const requested = runBridge.requestAutomationReadPilotApproval({
    compilation: fixture.compilation,
    approvalSessionId: chat.id,
  });
  if (!requested.ok) throw new Error(requested.reason);
  const decision = approvals.resolve(
    requested.approval.row.approvalId,
    'approved',
    `user.${label}`,
  );
  if (!decision.ok) throw new Error(decision.reason);
  const queued = runBridge.queueApprovedAutomationReadPilot({
    compilation: fixture.compilation,
    approvalId: requested.approval.row.approvalId,
    workflowInputs: { scope: fixture.workflowInput },
    originSessionId: chat.id,
  });
  if (!queued.ok || !queued.queue.id || !queued.bridge.pilotAdmission) {
    throw new Error(queued.ok ? 'pilot queue omitted its exact identity' : queued.reason);
  }
  return {
    chat,
    requested,
    queued,
    admission: queued.bridge.pilotAdmission,
    runFile: path.join(shared.WORKFLOW_RUNS_DIR, `${queued.queue.id}.json`),
  };
}

test('cold materialized read pilot survives settled-call restart and completes through the durable runner once', async () => {
  const fixture = await coldCompilationFixture();
  const chat = eventlog.createSession({ id: 'chat.pilot.alpha', kind: 'chat' });
  const requested = runBridge.requestAutomationReadPilotApproval({
    compilation: fixture.compilation,
    approvalSessionId: chat.id,
  });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  if (!requested.ok) return;
  assert.equal(requested.approval.approvalCreated, true);
  assert.equal(requested.approval.eventCreated, true);
  assert.equal(eventlog.listEvents(chat.id, { types: ['approval_requested'] }).length, 1);

  const beforeDecision = runBridge.queueApprovedAutomationReadPilot({
    compilation: fixture.compilation,
    approvalId: requested.approval.row.approvalId,
    workflowInputs: { scope: fixture.workflowInput },
    originSessionId: chat.id,
  });
  assert.equal(beforeDecision.ok, false);
  assert.equal(fixture.bodies(), 0);
  assert.equal(eventlog.openEventLog().prepare(
    'SELECT COUNT(*) AS n FROM workflow_node_invocation_activations',
  ).get().n, 0);

  const decision = approvals.resolve(
    requested.approval.row.approvalId,
    'approved',
    'user.alpha',
  );
  assert.equal(decision.ok, true);
  const queued = runBridge.queueApprovedAutomationReadPilot({
    compilation: fixture.compilation,
    approvalId: requested.approval.row.approvalId,
    workflowInputs: { scope: fixture.workflowInput },
    originSessionId: chat.id,
  });
  assert.equal(queued.ok, true, JSON.stringify(queued));
  if (!queued.ok || !queued.queue.id || !queued.bridge.pilotAdmission) return;
  assert.equal(queued.queue.status, 'queued');
  const workflow = workflows.readWorkflow(queued.bridge.pilotAdmission.workflowId);
  assert.equal(workflow?.data.enabled, false);
  assert.deepEqual(workflow?.data.trigger, { manual: true });

  const runFile = path.join(shared.WORKFLOW_RUNS_DIR, `${queued.queue.id}.json`);
  const runRecord = JSON.parse(readFileSync(runFile, 'utf8')) as {
    workflowDefinitionSnapshot: WorkflowRunDefinitionSnapshot;
    workflowReadPilotAdmission: WorkflowReadPilotAdmissionV1;
  };
  const admission = runRecord.workflowReadPilotAdmission;
  const step = runRecord.workflowDefinitionSnapshot.definition.steps[0];
  const settledBeforeRunner = await executor.executeWorkflowNodeRead({
    plan: step.invocationPlan,
    identity: {
      workflowId: admission.workflowId,
      workflowRevision: admission.workflowRevision,
      workflowDigest: admission.workflowDigest,
      runId: admission.runId,
      runOccurrenceId: admission.runOccurrenceId,
      nodeId: admission.nodeId,
      nodeAttempt: admission.nodeAttempt,
      invocationPlanDigest: admission.invocationPlanDigest,
      bindingSnapshotDigest: admission.bindingSnapshotDigest,
      controlDigest: admission.controlDigest,
    },
    arguments: { workflowInputs: { scope: fixture.workflowInput }, stepOutputs: {} },
    sessionId: admission.workflowSessionId,
    oneShotActivationAuthorization: admission.oneShotActivationAuthorization,
  });
  assert.equal(settledBeforeRunner.ok, true, JSON.stringify(settledBeforeRunner));
  assert.equal(fixture.bodies(), 1);

  // Simulate a process death after the shared call settled but before the
  // workflow step wrote its artifact/completion journal. The durable runner
  // must redeem the same activation/result and never invoke again.
  eventlog.closeEventLog();
  await runner.processWorkflowRuns({} as ClementineAssistant);
  const completed = JSON.parse(readFileSync(runFile, 'utf8')) as {
    status: string;
    stepOutputs?: Record<string, string>;
  };
  assert.equal(completed.status, 'completed');
  assert.equal(fixture.bodies(), 1);
  assert.equal(approvals.get(requested.approval.row.approvalId)?.consumedAt !== null, true);

  const counts = kernelCounts();
  assert.deepEqual(counts, {
    activations: 1,
    logical_calls: 1,
    physical_calls: 1,
    settlements: 1,
  });
  await runner.processWorkflowRuns({} as ClementineAssistant);
  assert.equal(fixture.bodies(), 1, 'terminal drain replay must not cross a second time');
});

test('durable runner itself performs the first and only exact read crossing from a queued pilot', async () => {
  const fixture = await coldCompilationFixture('beta');
  const chat = eventlog.createSession({ id: 'chat.pilot.beta', kind: 'chat' });
  const requested = runBridge.requestAutomationReadPilotApproval({
    compilation: fixture.compilation,
    approvalSessionId: chat.id,
  });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  if (!requested.ok) return;
  const decision = approvals.resolve(
    requested.approval.row.approvalId,
    'approved',
    'user.beta',
  );
  assert.equal(decision.ok, true);

  const before = kernelCounts();
  const queued = runBridge.queueApprovedAutomationReadPilot({
    compilation: fixture.compilation,
    approvalId: requested.approval.row.approvalId,
    workflowInputs: { scope: fixture.workflowInput },
    originSessionId: chat.id,
  });
  assert.equal(queued.ok, true, JSON.stringify(queued));
  if (!queued.ok || !queued.queue.id || !queued.bridge.pilotAdmission) return;
  assert.equal(fixture.bodies(), 0);

  // An empty assistant object is intentional: touching the model/legacy path
  // would fail this run. The plan-only node must go straight to ToolKernel.
  await runner.processWorkflowRuns({} as ClementineAssistant);
  const runFile = path.join(shared.WORKFLOW_RUNS_DIR, `${queued.queue.id}.json`);
  const completed = JSON.parse(readFileSync(runFile, 'utf8')) as { status: string };
  assert.equal(completed.status, 'completed');
  assert.equal(fixture.bodies(), 1);
  assert.equal(approvals.get(requested.approval.row.approvalId)?.consumedAt !== null, true);

  const after = kernelCounts();
  assert.deepEqual({
    activations: after.activations - before.activations,
    logical_calls: after.logical_calls - before.logical_calls,
    physical_calls: after.physical_calls - before.physical_calls,
    settlements: after.settlements - before.settlements,
  }, {
    activations: 1,
    logical_calls: 1,
    physical_calls: 1,
    settlements: 1,
  });

  const events = workflowEvents.readWorkflowEvents(
    queued.bridge.pilotAdmission.workflowId,
    queued.queue.id,
  );
  assert.equal(events.filter((event) => (
    event.kind === 'step_started'
      && event.stepId === queued.bridge.pilotAdmission!.nodeId
      && event.meta?.mode === 'manifest_bound_read'
  )).length, 1);
  assert.equal(events.filter((event) => event.kind === 'step_completed').length, 1);
  assert.equal(events.filter((event) => event.kind === 'run_completed').length, 1);

  await runner.processWorkflowRuns({} as ClementineAssistant);
  assert.equal(fixture.bodies(), 1, 'terminal replay must not redispatch');
  assert.deepEqual(kernelCounts(), after, 'terminal replay must create no new kernel rows');
});

test('real approval queue and runner execute a sealed three-page plan in deterministic aggregate order', async () => {
  const fixture = await coldCompilationFixture('pages-three', {
    maxPages: 3,
    responses: [
      { records: [{ id: 'page.0' }], page: { exhausted: false, next: 'cursor.1' } },
      { records: [{ id: 'page.1' }], page: { exhausted: false, next: 'cursor.2' } },
      { records: [{ id: 'page.2' }], page: { exhausted: true, next: null } },
    ],
  });
  const queued = queueApprovedFixture(fixture, 'pages-three');
  assert.equal(fixture.bodies(), 0);

  await runner.processWorkflowRuns({} as ClementineAssistant);

  const run = JSON.parse(readFileSync(queued.runFile, 'utf8')) as { status: string };
  assert.equal(run.status, 'completed');
  assert.equal(fixture.bodies(), 3);
  assert.deepEqual(fixture.seenArgs(), [
    { scope: fixture.workflowInput },
    { cursor: 'cursor.1', scope: fixture.workflowInput },
    { cursor: 'cursor.2', scope: fixture.workflowInput },
  ]);

  const db = eventlog.openEventLog();
  const aggregate = db.prepare(`
    SELECT a.aggregate_receipt_digest, a.page_receipt_digests_json,
           a.page_result_handles_json, a.page_count, a.coverage_state,
           a.outcome, a.final_exhausted_truth
      FROM workflow_paginated_aggregate_receipts a
      JOIN workflow_paginated_read_activations p USING (activation_id)
     WHERE p.session_id = ?
  `).get(queued.admission.workflowSessionId) as {
    aggregate_receipt_digest: string;
    page_receipt_digests_json: string;
    page_result_handles_json: string;
    page_count: number;
    coverage_state: string;
    outcome: string;
    final_exhausted_truth: string;
  };
  const pages = db.prepare(`
    SELECT p.page_ordinal, p.page_receipt_digest, p.result_handle_id
      FROM workflow_paginated_read_pages p
      JOIN workflow_paginated_read_activations a USING (activation_id)
     WHERE a.session_id = ? ORDER BY p.page_ordinal
  `).all(queued.admission.workflowSessionId) as Array<{
    page_ordinal: number;
    page_receipt_digest: string;
    result_handle_id: string;
  }>;
  assert.deepEqual(pages.map((page) => page.page_ordinal), [0, 1, 2]);
  assert.deepEqual(JSON.parse(aggregate.page_receipt_digests_json), pages.map((page) => page.page_receipt_digest));
  assert.deepEqual(JSON.parse(aggregate.page_result_handles_json), pages.map((page) => page.result_handle_id));
  assert.deepEqual({
    pageCount: aggregate.page_count,
    coverage: aggregate.coverage_state,
    outcome: aggregate.outcome,
    exhausted: aggregate.final_exhausted_truth,
  }, { pageCount: 3, coverage: 'complete', outcome: 'complete', exhausted: 'true' });
  assert.match(aggregate.aggregate_receipt_digest, /^[a-f0-9]{64}$/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM workflow_node_invocation_activations
    WHERE session_id = ?`).get(queued.admission.workflowSessionId).n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM workflow_paginated_read_activations
    WHERE session_id = ?`).get(queued.admission.workflowSessionId).n, 1);

  const events = workflowEvents.readWorkflowEvents(
    queued.admission.workflowId,
    queued.queued.queue.id!,
  );
  assert.equal(events.find((event) => event.kind === 'step_started')?.meta?.mode,
    'manifest_bound_paginated_read');
  const completed = events.find((event) => event.kind === 'step_completed');
  assert.equal(completed?.meta?.mode, 'manifest_bound_paginated_read');
  assert.equal(completed?.meta?.aggregateReceiptDigest, aggregate.aggregate_receipt_digest);
  assert.equal(events.filter((event) => event.kind === 'run_completed').length, 1);
});

test('runner restart after a settled middle page redeems pages zero and one without redispatch', async () => {
  const fixture = await coldCompilationFixture('pages-restart', {
    maxPages: 3,
    responses: [
      { records: [{ id: 'page.0' }], page: { exhausted: false, next: 'cursor.1' } },
      { records: [{ id: 'page.1' }], page: { exhausted: false, next: 'cursor.2' } },
      { records: [{ id: 'page.2' }], page: { exhausted: true, next: null } },
    ],
  });
  const queued = queueApprovedFixture(fixture, 'pages-restart');
  const record = JSON.parse(readFileSync(queued.runFile, 'utf8')) as {
    workflowDefinitionSnapshot: WorkflowRunDefinitionSnapshot;
    workflowReadPilotAdmission: WorkflowReadPilotAdmissionV1;
  };
  const step = record.workflowDefinitionSnapshot.definition.steps[0];
  const admission = record.workflowReadPilotAdmission;
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER abort_runner_third_page_reservation
    BEFORE INSERT ON workflow_paginated_read_pages
    WHEN NEW.page_ordinal = 2
    BEGIN SELECT RAISE(ABORT, 'fixture crash after middle page'); END;
  `);
  const cut = await executor.executeWorkflowNodeRead({
    plan: step.invocationPlan,
    identity: {
      workflowId: admission.workflowId,
      workflowRevision: admission.workflowRevision,
      workflowDigest: admission.workflowDigest,
      runId: admission.runId,
      runOccurrenceId: admission.runOccurrenceId,
      nodeId: admission.nodeId,
      nodeAttempt: admission.nodeAttempt,
      invocationPlanDigest: admission.invocationPlanDigest,
      bindingSnapshotDigest: admission.bindingSnapshotDigest,
      controlDigest: admission.controlDigest,
    },
    arguments: { workflowInputs: { scope: fixture.workflowInput }, stepOutputs: {} },
    sessionId: admission.workflowSessionId,
    oneShotActivationAuthorization: admission.oneShotActivationAuthorization,
  });
  assert.equal(cut.ok, false);
  assert.equal(fixture.bodies(), 2);
  assert.deepEqual(db.prepare(`
    SELECT page_ordinal, state FROM workflow_paginated_read_pages p
      JOIN workflow_paginated_read_activations a USING (activation_id)
     WHERE a.session_id = ? ORDER BY page_ordinal
  `).all(admission.workflowSessionId), [
    { page_ordinal: 0, state: 'settled' },
    { page_ordinal: 1, state: 'settled' },
  ]);
  db.exec('DROP TRIGGER abort_runner_third_page_reservation');
  eventlog.closeEventLog();

  await runner.processWorkflowRuns({} as ClementineAssistant);

  assert.equal((JSON.parse(readFileSync(queued.runFile, 'utf8')) as { status: string }).status, 'completed');
  assert.equal(fixture.bodies(), 3, 'restart must redeem the two settled pages and cross only page two');
  const reopened = eventlog.openEventLog();
  assert.deepEqual(reopened.prepare(`
    SELECT page_ordinal FROM workflow_paginated_read_pages p
      JOIN workflow_paginated_read_activations a USING (activation_id)
     WHERE a.session_id = ? ORDER BY page_ordinal
  `).all(admission.workflowSessionId), [
    { page_ordinal: 0 },
    { page_ordinal: 1 },
    { page_ordinal: 2 },
  ]);
  assert.equal(reopened.prepare(`SELECT COUNT(*) AS n FROM physical_dispatches
    WHERE session_id = ? AND io_claimed_at IS NOT NULL`).get(admission.workflowSessionId).n, 3);
  assert.equal(reopened.prepare(`SELECT COUNT(*) AS n FROM workflow_paginated_aggregate_receipts a
    JOIN workflow_paginated_read_activations p USING (activation_id)
    WHERE p.session_id = ?`).get(admission.workflowSessionId).n, 1);
});

test('repeated cursor and page-budget stop remain typed partial blocked runs with no universal completion', async () => {
  const repeatedFixture = await coldCompilationFixture('pages-cycle', {
    maxPages: 4,
    responses: [
      { records: [{ id: 'page.0' }], page: { exhausted: false, next: 'same' } },
      { records: [{ id: 'page.1' }], page: { exhausted: false, next: 'same' } },
    ],
  });
  const repeated = queueApprovedFixture(repeatedFixture, 'pages-cycle');
  await runner.processWorkflowRuns({} as ClementineAssistant);
  assert.equal((JSON.parse(readFileSync(repeated.runFile, 'utf8')) as { status: string }).status, 'blocked');
  assert.equal(repeatedFixture.bodies(), 2);

  const budgetFixture = await coldCompilationFixture('pages-budget', {
    maxPages: 2,
    responses: [
      { records: [{ id: 'page.0' }], page: { exhausted: false, next: 'cursor.1' } },
      { records: [{ id: 'page.1' }], page: { exhausted: false, next: 'cursor.2' } },
    ],
  });
  const budget = queueApprovedFixture(budgetFixture, 'pages-budget');
  await runner.processWorkflowRuns({} as ClementineAssistant);
  assert.equal((JSON.parse(readFileSync(budget.runFile, 'utf8')) as { status: string }).status, 'blocked');
  assert.equal(budgetFixture.bodies(), 2);

  const db = eventlog.openEventLog();
  const receipts = db.prepare(`
    SELECT p.session_id, a.outcome, a.coverage_state,
           a.final_exhausted_truth, a.reason, a.page_count
      FROM workflow_paginated_aggregate_receipts a
      JOIN workflow_paginated_read_activations p USING (activation_id)
     WHERE p.session_id IN (?, ?) ORDER BY p.session_id
  `).all(
    repeated.admission.workflowSessionId,
    budget.admission.workflowSessionId,
  ) as Array<{
    session_id: string;
    outcome: string;
    coverage_state: string;
    final_exhausted_truth: string;
    reason: string;
    page_count: number;
  }>;
  assert.equal(receipts.length, 2);
  const cycle = receipts.find((receipt) => receipt.session_id === repeated.admission.workflowSessionId);
  const capped = receipts.find((receipt) => receipt.session_id === budget.admission.workflowSessionId);
  assert.deepEqual(cycle && {
    outcome: cycle.outcome,
    coverage: cycle.coverage_state,
    exhausted: cycle.final_exhausted_truth,
    reason: cycle.reason,
    pages: cycle.page_count,
  }, { outcome: 'partial', coverage: 'partial', exhausted: 'false', reason: 'repeated_cursor', pages: 2 });
  assert.deepEqual(capped && {
    outcome: capped.outcome,
    coverage: capped.coverage_state,
    exhausted: capped.final_exhausted_truth,
    reason: capped.reason,
    pages: capped.page_count,
  }, { outcome: 'partial', coverage: 'partial', exhausted: 'false', reason: 'maximum_page_budget_reached', pages: 2 });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM workflow_paginated_aggregate_receipts a
    JOIN workflow_paginated_read_activations p USING (activation_id)
    WHERE p.session_id IN (?, ?) AND a.coverage_state = 'complete'`).get(
    repeated.admission.workflowSessionId,
    budget.admission.workflowSessionId,
  ).n, 0);
});

test('a persisted invocation plan without exact pilot lineage never falls through to a model or legacy call path', async () => {
  const fixture = await coldCompilationFixture('gamma');
  const preview = bridge.designApprovedAutomationWorkflowBridge({
    ...fixture.compilation,
    activation: { kind: 'preview', target: 'pilot' },
  });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.ok(preview.preview?.workflow.steps[0]?.invocationPlan);
  if (!preview.preview?.workflow.steps[0]) return;

  let assistantReads = 0;
  const assistant = new Proxy({} as ClementineAssistant, {
    get() {
      assistantReads += 1;
      throw new Error('legacy/model fallback was consulted');
    },
  });
  const before = kernelCounts();
  await assert.rejects(
    runner.executeStep(preview.preview.workflow.steps[0], {
      workflow: preview.preview.workflow,
      workflowSlug: preview.preview.workflow.name,
      runId: 'run.gamma',
      inputs: { scope: fixture.workflowInput },
      stepOutputs: {},
      assistant,
      completedItems: new Map(),
      forEachFailures: [],
      qualityAdvisories: [],
      recoveredContract: false,
    } as never),
    (error: unknown) => error instanceof runner.WorkflowHarnessBlockedSignal
      && error.reason.startsWith('workflow_activation_lineage_unrepresented:'),
  );
  assert.equal(assistantReads, 0);
  assert.equal(fixture.bodies(), 0);
  assert.deepEqual(kernelCounts(), before, 'lineage refusal must create no authority or crossing rows');
});
