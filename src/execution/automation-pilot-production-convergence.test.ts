/** Run: node scripts/run-tests-isolated.mjs src/execution/automation-pilot-production-convergence.test.ts */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
      description: 'The bounded result is complete.',
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
      return [{ type: 'text', text: '{"records":[]}' }] as unknown as Awaited<ReturnType<MCPServer['callTool']>>;
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
});
