/** Run: node scripts/run-tests-isolated.mjs src/execution/automation-pilot-production-convergence.test.ts */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MCPServer, Model, ModelRequest } from '@openai/agents';
import type { ManagedMcpServer } from '../types.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-pilot-production-convergence-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const convergence = await import('./automation-pilot-production-convergence.js');
const dispatcher = await import('./automation-pilot-authoring-dispatcher.js');
const chooser = await import('./automation-pilot-workspace-destination-authority.js');
const advancement = await import('./automation-pilot-advancement-control-plane.js');
const opportunities = await import('./automation-opportunity.js');
const opportunityStore = await import('./automation-opportunity-store.js');
const review = await import('./automation-opportunity-review-control-plane.js');
const pilot = await import('./automation-read-pilot-control-plane.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const productionPorts = await import('../runtime/harness/production-capability-ports.js');
const registry = await import('../runtime/harness/production-live-read-acquisition-registry.js');
const spaces = await import('../spaces/store.js');
const projections = await import('../memory/workflow-result-projection-contract.js');
const runner = await import('./workflow-runner.js');
const recurrenceRuntime = await import('./automation-recurrence-runtime.js');
const recurrenceControl = await import('./automation-recurrence-control-plane.js');
const scheduler = await import('./workflow-scheduler.js');
const intervalScheduler = await import('./workflow-interval-scheduler.js');
const workflowStore = await import('../memory/workflow-store.js');
const workflowQueue = await import('../tools/workflow-run-queue.js');
const shared = await import('../tools/shared.js');
import type { ClementineAssistant } from '../assistant/core.js';

function generated(label: string): string {
  return `${label}_${randomUUID().replaceAll('-', '').slice(0, 12)}`.toLowerCase();
}

function opportunity(label: string) {
  return opportunities.parseAutomationOpportunity({
    version: 1,
    title: `Bounded ${label} collection`,
    objective: `Collect one bounded ${label} result with exact evidence.`,
    rationale: 'A reviewed read pilot should prove the exact live contract.',
    lifetime: { kind: 'ongoing' },
    recurrence: {
      mode: 'proposed',
      cadence: { kind: 'interval', every: 2, unit: 'hour' },
      overlapPolicy: 'skip',
      catchUpPolicy: 'run_once',
      activation: 'requires_pilot_success_and_recurrence_consent',
    },
    trigger: { kind: 'recurrence' },
    partition: {
      mode: 'single',
      checkpointEvery: 1,
      completion: { kind: 'terminal_evidence', evidence: ['The records collection is present.'] },
    },
    capabilityRequirements: [{
      id: 'bounded-read',
      description: `retrieve exact ${label} records`,
      minimumEffect: 'read',
      constraints: ['Return a bounded records collection.'],
    }],
    phases: [{
      id: 'read-result',
      objective: 'Retrieve the exact bounded records.',
      dependsOn: [],
      capabilityRequirementIds: ['bounded-read'],
      effect: { class: 'read', approval: 'not_required', maxOperationsPerRun: 1 },
      partitioned: false,
      outputEvidence: ['The records collection is non-empty.'],
    }],
    effectCeiling: { class: 'read', maxOperationsPerRun: 1 },
    dataset: {
      schema: {
        fields: [
          { name: 'key', type: 'string', required: true, sensitivity: 'public' },
          { name: 'name', type: 'string', required: true, sensitivity: 'public' },
        ],
        additionalFields: 'reject',
      },
      identity: {
        rules: [{ id: 'by-key', fields: ['key'], match: 'exact', normalizers: ['trim'] }],
        ambiguousMatch: 'review_required',
      },
      merge: {
        mode: 'review_required',
        defaultConflict: 'review_required',
        fieldPolicies: [],
        preserveSourceRecords: true,
      },
      provenance: {
        required: true,
        retainSourceSnapshots: true,
        requiredReferences: ['source_ref', 'run_ref', 'observed_at'],
      },
    },
    deliverables: [{
      id: 'result',
      description: 'The bounded result.',
      kind: 'dataset_snapshot',
      required: true,
      successCriterionIds: ['complete'],
      evidence: ['The records collection is present.'],
    }],
    missingInputs: [],
    successCriteria: [{
      id: 'complete',
      description: 'Step "read-result" output includes required keys: version, kind, activationId, authorityRootId, logicalCallId',
      evidence: ['The records collection is non-empty.'],
    }],
    pilot: {
      required: true,
      maxPartitions: 1,
      maxRecords: 10,
      effectCeiling: { class: 'read', maxOperationsPerRun: 1 },
      successCriterionIds: ['complete'],
      haltOnFailure: true,
    },
    budgets: {
      maxWallClockMinutesPerRun: 5,
      maxConcurrentPartitions: 1,
      maxAttemptsPerPartition: 1,
      maxPartitionsPerRun: 1,
      maxRecordsPerRun: 10,
      maxOperationsPerRun: 1,
      reserveOperations: 0,
    },
  });
}

function exactCandidate(prompt: string) {
  const projected = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2)) as {
    request: {
      requestId: string;
      requirement: { phaseId: string; requirementId: string };
      workspaceSelection: Parameters<typeof projections.createWorkflowCanonicalEntityResultProjection>[0] extends never
        ? never
        : Record<string, unknown>;
    };
    requestDigest: string;
  };
  return {
    version: 1,
    requestId: projected.request.requestId,
    requestDigest: projected.requestDigest,
    contract: {
      phaseId: projected.request.requirement.phaseId,
      requirementId: projected.request.requirement.requirementId,
      workflowInputs: { scope: { type: 'string', required: true } },
      arguments: {
        scope: {
          source: { kind: 'workflow_input', key: 'scope' },
          required: true,
          type: 'string',
        },
      },
      evidence: {
        requiredPaths: ['records'],
        nonEmptyPaths: ['records'],
        minItems: { records: 1 },
      },
      completeness: { kind: 'terminal_result', evidencePaths: ['records'] },
      continuation: { kind: 'none' },
      resultProjection: projections.createWorkflowCanonicalEntityResultProjection({
        recordsPath: 'records',
        fields: [
          { field: 'key', recordPath: 'key', type: 'string', required: true, sensitivity: 'public', confidence: 1 },
          { field: 'name', recordPath: 'name', type: 'string', required: true, sensitivity: 'public', confidence: 1 },
        ],
        sourceRecord: { idPath: 'key', observedAt: { kind: 'page_settled_at' } },
        entityKind: 'generic-record',
        identityRules: [{
          ruleId: 'by-key',
          fields: ['key'],
          normalizers: ['trim'],
          exactIdentifierNamespace: 'generic-key',
        }],
        resolutionPolicy: {
          policyId: 'exact-key',
          mergeThreshold: 10,
          distinctThreshold: 2,
          ambiguityMargin: 1,
          weights: { defaultExactIdentifierMatch: 10, defaultCompoundSignalMatch: 0 },
        },
        fieldResolution: {
          kind: 'retain_all_evidence',
          selection: 'highest_confidence_then_newest',
          conflict: 'mark_conflicting_for_review',
        },
        provenance: { kind: 'workflow_page_record', retainSourceSnapshots: true },
        partition: {
          kind: 'workflow_run',
          coverageItems: 'source_record_occurrences',
          denominator: 'settled_record_count',
          completion: 'closed_authority_exhaustion',
        },
        bounds: {
          maxPages: 1,
          maxRecordsPerPage: 10,
          maxRecords: 10,
          maxPageBytes: 100_000,
          maxRecordBytes: 10_000,
          maxTotalBytes: 100_000,
        },
      }),
      workspaceBindingSelection: projected.request.workspaceSelection,
    },
    workflowInputs: { scope: 'bounded.scope' },
  };
}

function externalModelTransport(requests: ModelRequest[]): Model {
  return {
    async getResponse(): Promise<never> {
      throw new Error('the constrained authoring path must stream');
    },
    async *getStreamedResponse(request: ModelRequest) {
      requests.push(request);
      assert.deepEqual(request.tools, []);
      assert.equal(request.modelSettings.toolChoice, 'none');
      assert.equal(typeof request.outputType, 'object');
      const candidate = exactCandidate(String(request.input));
      yield { type: 'model', event: { finishReason: 'stop' } } as never;
      yield {
        type: 'response_done',
        response: {
          id: generated('model-response'),
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          output: [{
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: JSON.stringify(candidate) }],
          }],
        },
      } as never;
    },
  } as Model;
}

async function waitUntil(predicate: () => boolean, detail: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(detail);
}

test.after(() => {
  for (const workspace of spaces.spaceStore.list(true)) spaces.spaceStore.remove(workspace.id);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  productionPorts.clearProductionCapabilityPorts();
  opportunityStore.closeAutomationOpportunityStoreForTests();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('approved proposal advances without another chat turn through exact chooser, live metadata, constrained authoring, and full pilot card', async () => {
  const label = generated('nationwide');
  const serverName = generated('source');
  const toolName = `${serverName}__${generated('records')}`;
  const counts = { list: 0, call: 0, model: [] as ModelRequest[] };
  const tool = {
    name: toolName,
    description: `Return retrieve exact ${label} records from the connected source.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { scope: { type: 'string' } },
      required: ['scope'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        records: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { key: { type: 'string' }, name: { type: 'string' } },
            required: ['key', 'name'],
          },
        },
      },
      required: ['records'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  };
  const fakeServer: Pick<MCPServer, 'listTools' | 'callTool' | 'invalidateToolsCache'> = {
    async invalidateToolsCache() {},
    async listTools() {
      counts.list += 1;
      return [tool] as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool() {
      counts.call += 1;
      const payload = { records: [{ key: generated('record'), name: generated('value') }] };
      const result = [{
        type: 'text',
        text: JSON.stringify(payload),
      }] as unknown as Awaited<ReturnType<MCPServer['callTool']>> & Record<string, unknown>;
      Object.assign(result, { structuredContent: structuredClone(payload), isError: false });
      return result;
    },
  };
  const configuredServer: ManagedMcpServer = {
    name: serverName,
    type: 'stdio',
    command: '/isolated/external-mcp',
    args: ['--stdio'],
    env: { ISOLATED_CREDENTIAL: generated('secret') },
    description: 'Isolated external transport',
    enabled: true,
    source: 'user',
  };
  const runtime = {
    configuredServers: () => [configuredServer],
    serverForEnumeration: () => fakeServer,
    serverForOperation: () => fakeServer,
    portIdentity: () => ({
      portId: 'host:test-native-mcp-read:production-vertical',
      compiler: { id: 'host:mcp-json-arguments', version: '1' },
    }),
  };

  const factory = catalogs.createHostCapabilityCatalogFactory();
  const store = manifestStores.createCapabilityManifestStore();
  catalogs.installHostCapabilityCatalogFactory(factory);
  manifestStores.installCapabilityManifestStore(store);
  const acquisition = registry.configuredProductionLiveReadAcquisitionPort({
    configuredMcpServers: () => [configuredServer],
    mcpRuntimeForServer: () => runtime,
    factory,
    store,
  });
  const authoringPort = dispatcher.createProductionAutomationPilotAuthoringPort({
    resolveModel: () => externalModelTransport(counts.model),
  });
  const options = {
    advancementPorts: { acquisition },
    authoringPort,
  };

  const workspaceId = `workspace-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  spaces.spaceStore.save({ id: workspaceId, title: 'Nationwide records' });
  const sessionId = generated('chat');
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const created = opportunityStore.createAutomationOpportunityProposal({
    proposalId: generated('proposal').replaceAll('.', '_'),
    opportunity: opportunity(label),
    actorRef: `accepted-source:${sessionId}#1`,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) return;
  const requested = review.registerAutomationOpportunityReviewProjection({
    proposalId: created.record.proposalId,
    expectedProposalRevision: created.record.revision,
    expectedProposalDigest: created.record.digest,
    approvalSessionId: sessionId,
    requestSourceUserSeq: 1,
  });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  if (!requested.ok) return;

  convergence.installAutomationPilotProductionConvergenceListener(options);
  assert.equal(counts.list, 0);
  assert.equal(counts.call, 0);
  assert.equal(counts.model.length, 0);
  assert.equal(approvals.resolve(requested.approval.approvalId, 'approved', 'human.review').ok, true);
  await waitUntil(
    () => chooser.listAutomationPilotWorkspaceChoosers({ status: 'pending' }).length === 1,
    'review approval did not converge to the exact Workspace chooser',
  );

  const pendingChooser = chooser.listAutomationPilotWorkspaceChoosers({ status: 'pending' })[0]!;
  const selected = pendingChooser.choices.find((choice) => (
    choice.kind === 'existing' && choice.workspace.workspaceId === workspaceId
  ));
  assert.ok(selected);
  const resolved = chooser.resolveAutomationPilotWorkspaceChooser({
    chooserId: pendingChooser.chooserId,
    expectedChooserRevision: pendingChooser.chooserRevision,
    expectedChooserDigest: pendingChooser.chooserDigest,
    choiceId: selected!.choiceId,
    actorRef: 'human.console',
  });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));

  const advanced = await convergence.reconcileAutomationPilotProductionConvergence(options);
  assert.equal(advanced.failures, 0, JSON.stringify(advanced));
  const saga = advancement.listAutomationPilotAdvancements({ limit: 10 })[0]!;
  assert.equal(
    counts.model.length,
    1,
    `the configured model adapter receives one constrained authoring request: ${JSON.stringify(saga)}`,
  );
  assert.equal(counts.call, 0, 'metadata acquisition and authoring never sample the business operation');
  assert.equal(saga.stage, 'pilot_approval_pending');
  const pilotProjection = pilot.loadAutomationReadPilotProjection(saga.pilotProjectionId!);
  assert.ok(pilotProjection?.approvalId);
  assert.equal(pilotProjection?.status, 'approval_pending');

  assert.equal(approvals.resolve(pilotProjection!.approvalId!, 'approved', 'human.pilot').ok, true);
  await waitUntil(
    () => advancement.loadAutomationPilotAdvancement(saga.advancementId)?.stage === 'queued',
    'pilot approval did not converge to the durable queue without another chat turn',
  );
  assert.equal(counts.model.length, 1);
  assert.equal(counts.call, 0);
  assert.ok(counts.list > 0, 'the configured external carrier was observed live');

  const queuedPilot = pilot.loadAutomationReadPilotProjection(saga.pilotProjectionId!);
  assert.ok(queuedPilot?.runId);
  await runner.processWorkflowRuns({} as ClementineAssistant);
  assert.equal(counts.call, 1, 'the real pilot crosses the reviewed provider body exactly once');
  const runBytes = readFileSync(
    path.join(shared.WORKFLOW_RUNS_DIR, `${queuedPilot!.runId}.json`),
    'utf8',
  );
  const terminal = JSON.parse(runBytes) as {
    status?: string;
    terminalOutcome?: string;
    goalOutcome?: string;
    goalValidation?: {
      pass?: boolean;
      judgeFailedOpen?: boolean;
      perCriterion?: Array<{ pass?: boolean; method?: string; detail?: string }>;
    };
    stepOutputs?: Record<string, unknown>;
  };
  const retainedProviderResults = eventlog.openEventLog().prepare(`
    SELECT raw_payload_json FROM durable_result_handles ORDER BY created_at ASC
  `).all();
  assert.equal(
    terminal.status,
    'completed',
    `${runBytes}\n${JSON.stringify(retainedProviderResults, null, 2)}`,
  );
  assert.equal(
    terminal.goalOutcome,
    'satisfied',
    JSON.stringify({
      goalValidation: terminal.goalValidation,
      stepOutputs: terminal.stepOutputs,
    }, null, 2),
  );
  assert.equal(terminal.terminalOutcome, 'succeeded', runBytes);
  assert.equal(terminal.goalValidation?.pass, true);
  assert.equal(terminal.goalValidation?.judgeFailedOpen, false);
  assert.deepEqual(
    terminal.goalValidation?.perCriterion?.map((criterion) => ({
      pass: criterion.pass,
      method: criterion.method,
    })),
    [{ pass: true, method: 'deterministic' }],
    'the exact full targeted pilot persists the real criterion verdict',
  );
  const pilotSuccess = recurrenceRuntime.projectAutomationRecurrencePilotSuccess(queuedPilot!.runId!);
  assert.equal(pilotSuccess.ok, true, JSON.stringify(pilotSuccess));
  if (!pilotSuccess.ok) return;

  const recurrenceDurableState = () => {
    recurrenceControl.listAutomationRecurrenceActivationsForReconciliation();
    const db = eventlog.openEventLog();
    return {
      activations: (db.prepare(
        'SELECT COUNT(*) AS count FROM automation_recurrence_activations',
      ).get() as { count: number }).count,
      receipts: (db.prepare(
        'SELECT COUNT(*) AS count FROM automation_recurrence_activation_receipts',
      ).get() as { count: number }).count,
      approvals: approvals.listPending({ status: 'any' })
        .map((approval) => approval.approvalId)
        .sort(),
      definition: workflowStore.readWorkflow(pilotSuccess.evidence.workflowId)?.data,
    };
  };

  // A judge outage/advisory cannot be upgraded into recurrence authority. Use
  // the real admitted run and change only its persisted goal receipt, then put
  // the exact original bytes back before exercising the positive lane.
  const runPath = path.join(shared.WORKFLOW_RUNS_DIR, `${queuedPilot.runId}.json`);
  const unavailableTerminal = JSON.parse(runBytes) as {
    goalValidation?: Record<string, unknown>;
  };
  assert.ok(unavailableTerminal.goalValidation);
  unavailableTerminal.goalValidation = {
    ...unavailableTerminal.goalValidation,
    pass: false,
    judgeFailedOpen: true,
    perCriterion: [{
      criterion: opportunity(label).successCriteria[0]!.description,
      pass: false,
      method: 'skipped',
      detail: 'judge unavailable: isolated outage',
    }],
  };
  const beforeUnavailableRequest = recurrenceDurableState();
  try {
    writeFileSync(runPath, JSON.stringify(unavailableTerminal, null, 2), 'utf8');
    const unavailableRequest = recurrenceRuntime.requestAutomationRecurrenceActivation({
      pilotRunId: queuedPilot.runId,
      approvalSessionId: sessionId,
      cadence: {
        every: 2,
        unit: 'hour',
        overlapPolicy: 'skip',
        catchUpPolicy: 'run_once',
      },
      previewedAt: '2026-08-27T12:00:00.000Z',
    });
    assert.equal(unavailableRequest.ok, false, JSON.stringify(unavailableRequest));
    if (unavailableRequest.ok) assert.fail('judge-unavailable pilot created recurrence authority');
    assert.equal(unavailableRequest.code, 'pilot_goal_validation_invalid');
    assert.deepEqual(
      recurrenceDurableState(),
      beforeUnavailableRequest,
      'judge-unavailable validation changed activation/receipt/card/workflow state',
    );
  } finally {
    writeFileSync(runPath, runBytes, 'utf8');
  }

  const requestedRecurrence = recurrenceRuntime.requestAutomationRecurrenceActivation({
    pilotRunId: queuedPilot.runId,
    approvalSessionId: sessionId,
    cadence: {
      every: 2,
      unit: 'hour',
      overlapPolicy: 'skip',
      catchUpPolicy: 'run_once',
    },
    previewedAt: '2026-08-27T12:00:00.000Z',
  });
  assert.equal(requestedRecurrence.ok, true, JSON.stringify(requestedRecurrence));
  if (!requestedRecurrence.ok) return;
  assert.equal(requestedRecurrence.activation.status, 'approval_pending');
  assert.equal(requestedRecurrence.preview.interval.every, 2);
  assert.equal(requestedRecurrence.preview.interval.unit, 'hour');
  assert.equal(requestedRecurrence.preview.interval.overlapPolicy, 'skip');
  assert.equal(requestedRecurrence.preview.interval.catchUpPolicy, 'run_once');
  assert.equal(
    recurrenceControl.listAutomationRecurrenceActivationsForReconciliation()
      .filter((activation) => activation.activationId === requestedRecurrence.activation.activationId).length,
    1,
    'one durable activation row owns the consent request',
  );
  assert.equal(approvals.resolve(
    requestedRecurrence.approval.approvalId,
    'approved',
    'human.recurrence-owner',
  ).ok, true);
  const reconciled = recurrenceRuntime.reconcileAutomationRecurrences();
  assert.equal(reconciled.failed, 0, JSON.stringify(reconciled));
  assert.ok(reconciled.active >= 1, JSON.stringify(reconciled));
  const active = recurrenceControl.getAutomationRecurrenceActivation(
    requestedRecurrence.activation.activationId,
  );
  const activationReceipt = recurrenceControl.getAutomationRecurrenceActivationReceipt(
    requestedRecurrence.activation.activationId,
  );
  assert.equal(active?.status, 'active');
  assert.ok(activationReceipt);
  assert.equal(activationReceipt?.interval.every, 2);
  assert.equal(activationReceipt?.interval.unit, 'hour');
  assert.equal(workflowStore.readWorkflow(pilotSuccess.evidence.workflowId)?.data.enabled, true);
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS count
      FROM automation_recurrence_activation_receipts
     WHERE activation_id = ?
  `).get(requestedRecurrence.activation.activationId) as { count: number }).count, 1);

  const firstFire = await scheduler.processWorkflowSchedules(
    new Date(requestedRecurrence.preview.firstFireAt),
  );
  assert.equal(
    firstFire.fired.filter((workflowId) => workflowId === pilotSuccess.evidence.workflowId).length,
    1,
    JSON.stringify(firstFire),
  );
  const intervalRuns = () => readdirSync(shared.WORKFLOW_RUNS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(path.join(shared.WORKFLOW_RUNS_DIR, file), 'utf8')) as {
      id?: string;
      workflow?: string;
      source?: string;
      status?: string;
      triggerReceiptId?: string;
      workflowRecurringReadAdmission?: {
        activationAuthority?: { activationId?: string };
        occurrenceOrdinal?: number;
        runOccurrenceId?: string;
      };
    })
    .filter((run) => (
      run.source === 'schedule'
      && run.workflow === pilotSuccess.evidence.workflowId
      && run.workflowRecurringReadAdmission?.activationAuthority?.activationId
        === requestedRecurrence.activation.activationId
    ));
  const firstIntervalRuns = intervalRuns();
  assert.equal(firstIntervalRuns.length, 1, JSON.stringify(firstIntervalRuns));
  const firstIntervalRun = firstIntervalRuns[0]!;
  assert.equal(firstIntervalRun.status, 'queued');
  assert.equal(firstIntervalRun.workflowRecurringReadAdmission?.occurrenceOrdinal, 1);
  assert.equal(
    firstIntervalRun.workflowRecurringReadAdmission?.runOccurrenceId,
    firstIntervalRun.triggerReceiptId,
  );
  assert.equal(
    workflowQueue.readWorkflowTriggerReceiptAcceptance(firstIntervalRun.triggerReceiptId!),
    firstIntervalRun.id,
    'the first interval occurrence has one durable queue acceptance owner',
  );

  // Restart cut: forget only the scheduler cursor after the durable queue
  // acceptance exists. The trigger receipt must adopt the same run instead of
  // creating a second occurrence.
  rmSync(intervalScheduler.workflowIntervalSchedulerInternalsForTest.intervalStateFile, {
    force: true,
  });
  eventlog.closeEventLog();
  const replayedFirstFire = await scheduler.processWorkflowSchedules(
    new Date(requestedRecurrence.preview.firstFireAt),
  );
  assert.equal(
    replayedFirstFire.deduped.filter((workflowId) => workflowId === pilotSuccess.evidence.workflowId).length,
    1,
    JSON.stringify(replayedFirstFire),
  );
  assert.equal(intervalRuns().length, 1, 'restart replay did not mint a second interval run');
  assert.equal(
    workflowQueue.readWorkflowTriggerReceiptAcceptance(firstIntervalRun.triggerReceiptId!),
    firstIntervalRun.id,
  );
});
