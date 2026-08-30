/**
 * Governing NEXT-TAG row 10 journey.
 *
 * A natural structural request enters the exported ordinary channel and may
 * create only an inert reviewed proposal. Human review then crosses the real
 * production convergence path: live carrier discovery, constrained typed
 * authoring, full pilot approval, paginated provider execution, canonical
 * projection, projected pilot success, separate recurrence consent, interval
 * scheduling, and a fresh-process scheduled-run recovery. The child process
 * redeems the exact settled page handles into 10,001 normalized partition
 * rows, admits bounded durable fan-out, retries one failed window, and proves
 * occurrence and authority replay cannot duplicate work.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Model, ModelRequest } from '@openai/agents';
import type { ClementineAssistant } from '../assistant/core.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-automation-partitions-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.AUTH_MODE = 'codex_oauth';
process.env.MODEL_ROUTING_MODE = 'off';
process.env.OPENAI_MODEL_PRIMARY = 'gpt-5.5';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_TOOL_JIT = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_SEMANTIC_RECALL = 'off';
process.env.CLEMMY_DEBATE_MODE = 'off';
process.env.CLEMMY_BRAIN_FALLOVER = 'off';
process.env.CLEMMY_AUTH_FALLOVER = 'off';
process.env.CLEMMY_PLAN_FIRST = 'off';
process.env.CLEMMY_DYNAMIC_REASONING = 'off';
process.env.CLEMMY_EVAL_AUTO_PROMOTE = 'off';

mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), 'machine-automation-partition-ledger\n');
writeFileSync(path.join(TEST_HOME, 'state', 'auth.json'), JSON.stringify({
  source: 'native',
  codexOauth: {
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
    lastRefresh: new Date().toISOString(),
  },
}));

const support = await import('./automation-partition-ledger.fixture-support.js');
const discord = await import('../channels/discord-harness.js');
const bridge = await import('../runtime/harness/respond-bridge.js');
const runtimeConfig = await import('../runtime/harness/codex-client.js');
const { buildOrchestratorAgent } = await import('../agents/orchestrator.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const opportunities = await import('../execution/automation-opportunity.js');
const opportunityStore = await import('../execution/automation-opportunity-store.js');
const opportunityReview = await import('../execution/automation-opportunity-review-control-plane.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const convergence = await import('../execution/automation-pilot-production-convergence.js');
const dispatcher = await import('../execution/automation-pilot-authoring-dispatcher.js');
const chooser = await import('../execution/automation-pilot-workspace-destination-authority.js');
const advancement = await import('../execution/automation-pilot-advancement-control-plane.js');
const pilot = await import('../execution/automation-read-pilot-control-plane.js');
const recurrenceRuntime = await import('../execution/automation-recurrence-runtime.js');
const recurrenceControl = await import('../execution/automation-recurrence-control-plane.js');
const scheduler = await import('../execution/workflow-scheduler.js');
const intervalScheduler = await import('../execution/workflow-interval-scheduler.js');
const runner = await import('../execution/workflow-runner.js');
const workflowQueue = await import('../tools/workflow-run-queue.js');
const projections = await import('../memory/workflow-result-projection-contract.js');
const workflowStore = await import('../memory/workflow-store.js');
const spaces = await import('../spaces/store.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const partitions = await import('../execution/automation-partition-authority.js');
const fanout = await import('../execution/durable-fanout.js');
const memoryDb = await import('../memory/db.js');
const shared = await import('../tools/shared.js');
const topology = await import('../runtime/graph/work-topology.js');

const SOURCE_PHASE = 'enumerate';
const PARTITION_PHASE = 'process_partition';
const PROPOSAL_KEY = 'generated_partition_ledger';
const OWNER_SESSION_ID = 'chat.partition.owner';
const ORDINARY_PROMPT = [
  'Every two hours, enumerate the exact closed generated shard scope and process all 10,001 shard identities.',
  'The provider is cursor-paginated. Keep exact settled source handles, bound concurrent partition windows to two, retry each failed window at most once, resume after process restart, and deduplicate each scheduled occurrence.',
  'Create only a reviewable automation opportunity for me now; do not invoke the provider, create a workflow, create a Space, or schedule anything.',
].join(' ');

const OPPORTUNITY = opportunities.parseAutomationOpportunity({
  version: 1,
  title: 'Generated partition ledger',
  objective: 'Enumerate one exact closed generated scope and process every normalized shard partition.',
  rationale: 'A closed paginated source larger than the inline WorkTopology seal needs durable normalized partition authority, bounded backpressure, retry, restart, and occurrence deduplication.',
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
    mode: 'finite',
    keyFields: ['shard_code'],
    dimensions: ['shard'],
    checkpointEvery: 256,
    completion: { kind: 'exact_count', expected: support.PARTITION_RECORD_COUNT },
  },
  capabilityRequirements: [{
    id: 'enumeration_read',
    description: 'Enumerate the exact closed generated partition scope as bounded cursor pages.',
    minimumEffect: 'read',
    constraints: ['Return shard_code records and explicit exhausted/next cursor authority.'],
  }, {
    id: 'partition_read',
    description: 'Read one exact normalized shard partition.',
    minimumEffect: 'read',
    constraints: ['Use only the durable normalized partition identity.'],
  }],
  phases: [{
    id: SOURCE_PHASE,
    objective: 'Enumerate the exact closed generated partition scope.',
    dependsOn: [],
    capabilityRequirementIds: ['enumeration_read'],
    effect: { class: 'read', approval: 'not_required', maxOperationsPerRun: support.PARTITION_PAGE_COUNT },
    partitioned: false,
    outputEvidence: ['The final provider page is explicitly exhausted and every page has a settled result handle.'],
  }, {
    id: PARTITION_PHASE,
    objective: 'Process one exact normalized shard partition.',
    dependsOn: [SOURCE_PHASE],
    capabilityRequirementIds: ['partition_read'],
    effect: { class: 'read', approval: 'not_required', maxOperationsPerRun: support.PARTITION_RECORD_COUNT },
    partitioned: true,
    outputEvidence: ['The exact partition has one durable terminal settlement.'],
  }],
  effectCeiling: { class: 'read', maxOperationsPerRun: support.PARTITION_RECORD_COUNT + support.PARTITION_PAGE_COUNT },
  dataset: {
    schema: {
      fields: [{ name: 'shard_code', type: 'string', required: true, sensitivity: 'public' }],
      additionalFields: 'reject',
    },
    identity: {
      rules: [{ id: 'by_shard_code', fields: ['shard_code'], match: 'exact', normalizers: ['trim'] }],
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
    id: 'partition_result',
    description: 'A durable normalized result authority for the complete reviewed partition scope.',
    kind: 'dataset_snapshot',
    required: true,
    successCriterionIds: ['enumeration_closed', 'all_partitions'],
    evidence: ['The source is closed and every exact normalized partition has one activation.'],
  }],
  missingInputs: [],
  successCriteria: [{
    id: 'enumeration_closed',
    description: `Step "${SOURCE_PHASE}" output includes required keys: aggregateReceiptId, aggregateReceiptDigest, activationId, authorityRootId, pageResultHandleIds, pageCount, totalItemCount, finalExhaustedTruth, coverageState, outcome`,
    evidence: ['The pilot retains one exact exhausted paginated result authority.'],
  }, {
    id: 'all_partitions',
    description: `All ${support.PARTITION_RECORD_COUNT.toLocaleString('en-US')} normalized shard partitions have durable fan-out activations.`,
    evidence: ['The normalized ledger and activation journal contain the exact reviewed count.'],
  }],
  pilot: {
    required: true,
    maxPartitions: 1,
    maxRecords: support.PARTITION_RECORD_COUNT,
    effectCeiling: { class: 'read', maxOperationsPerRun: support.PARTITION_PAGE_COUNT },
    successCriterionIds: ['enumeration_closed'],
    haltOnFailure: true,
  },
  budgets: {
    maxWallClockMinutesPerRun: 60,
    maxConcurrentPartitions: 2,
    maxAttemptsPerPartition: 2,
    maxPartitionsPerRun: support.PARTITION_RECORD_COUNT,
    maxRecordsPerRun: support.PARTITION_RECORD_COUNT,
    maxOperationsPerRun: support.PARTITION_RECORD_COUNT + support.PARTITION_PAGE_COUNT,
    reserveOperations: support.PARTITION_PAGE_COUNT,
  },
});

function functionCall(callId: string, name: string, args: Record<string, unknown>) {
  return { type: 'function_call', callId, name, arguments: JSON.stringify(args) };
}

function finalMessage(text: string) {
  return {
    type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: JSON.stringify({
      summary: text, reply: text, done: true, nextAction: 'completed', reason: null,
    }) }],
  };
}

async function* streamResponse(
  this: { getResponse: (request: unknown) => Promise<Record<string, unknown>> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = Array.isArray(response.output) ? response.output : [];
  yield { type: 'response_started' } as never;
  yield { type: 'model', event: {
    type: 'finish',
    finishReason: output.some((item) => (item as { type?: string }).type === 'function_call') ? 'tool_calls' : 'stop',
  } } as never;
  yield { type: 'response_done', response: {
    id: typeof response.responseId === 'string' ? response.responseId : 'partition-opportunity-response',
    usage: response.usage ?? { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output,
  } } as never;
}

function delivery() {
  const edits: string[] = [];
  const errors: string[] = [];
  return { edits, errors, transport: {
    async sendInitial(content: string) {
      edits.push(content);
      return { async edit(next: string) { edits.push(next); } };
    },
    async sendError(content: string) { errors.push(content); },
    async sendFollowup(content: string) { edits.push(content); },
  } };
}

function authoringCandidate(prompt: string) {
  const projected = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2)) as {
    request: {
      requestId: string;
      requirement: { phaseId: string; requirementId: string };
      workspaceSelection: Record<string, unknown>;
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
        scope: { source: { kind: 'workflow_input', key: 'scope' }, required: true, type: 'string' },
        cursor: { source: { kind: 'continuation_cursor' }, required: false, type: 'string' },
      },
      evidence: { requiredPaths: ['records'], nonEmptyPaths: ['records'], minItems: { records: 1 } },
      completeness: { kind: 'finite_exhaustive', exhaustedPath: 'page.exhausted', evidencePaths: ['records'] },
      continuation: {
        kind: 'cursor', cursorArgument: 'cursor', nextCursorPath: 'page.next',
        exhaustedPath: 'page.exhausted', maxPages: support.PARTITION_PAGE_COUNT,
      },
      resultProjection: projections.createWorkflowCanonicalEntityResultProjection({
        recordsPath: 'records',
        fields: [{
          field: 'shard_code', recordPath: 'shard_code', type: 'string', required: true,
          sensitivity: 'public', confidence: 1,
        }],
        sourceRecord: { idPath: 'shard_code', observedAt: { kind: 'page_settled_at' } },
        entityKind: 'partition_scope',
        identityRules: [{
          ruleId: 'by_shard_code', fields: ['shard_code'], normalizers: ['trim'],
          exactIdentifierNamespace: 'partition_scope',
        }],
        resolutionPolicy: {
          policyId: 'exact_partition_scope', mergeThreshold: 10, distinctThreshold: 2,
          ambiguityMargin: 1,
          weights: { defaultExactIdentifierMatch: 10, defaultCompoundSignalMatch: 0 },
        },
        fieldResolution: {
          kind: 'retain_all_evidence', selection: 'highest_confidence_then_newest',
          conflict: 'mark_conflicting_for_review',
        },
        provenance: { kind: 'workflow_page_record', retainSourceSnapshots: true },
        partition: {
          kind: 'workflow_run', coverageItems: 'source_record_occurrences',
          denominator: 'settled_record_count', completion: 'closed_authority_exhaustion',
        },
        bounds: {
          maxPages: support.PARTITION_PAGE_COUNT,
          maxRecordsPerPage: support.PARTITION_PAGE_SIZE,
          maxRecords: support.PARTITION_RECORD_COUNT,
          maxPageBytes: 1_000_000,
          maxRecordBytes: 1_000,
          maxTotalBytes: 3_000_000,
        },
      }),
      workspaceBindingSelection: projected.request.workspaceSelection,
    },
    workflowInputs: { scope: 'generated-large' },
  };
}

function authoringModel(requests: ModelRequest[]): Model {
  return {
    async getResponse(): Promise<never> { throw new Error('the constrained authoring path must stream'); },
    async *getStreamedResponse(request: ModelRequest) {
      requests.push(request);
      assert.deepEqual(request.tools, []);
      assert.equal(request.modelSettings.toolChoice, 'none');
      assert.equal(typeof request.outputType, 'object');
      yield { type: 'model', event: { finishReason: 'stop' } } as never;
      yield { type: 'response_done', response: {
        id: 'partition-authoring-response',
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{
          type: 'output_text', text: JSON.stringify(authoringCandidate(String(request.input))),
        }] }],
      } } as never;
    },
  } as Model;
}

function scheduledRuns(workflowId: string, activationId: string) {
  return readdirSync(shared.WORKFLOW_RUNS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(path.join(shared.WORKFLOW_RUNS_DIR, file), 'utf8')) as {
      id?: string; workflow?: string; source?: string; status?: string; triggerReceiptId?: string;
      workflowRecurringReadAdmission?: {
        activationAuthority?: { activationId?: string };
        occurrenceOrdinal?: number;
        runOccurrenceId?: string;
      };
    })
    .filter((run) => run.source === 'schedule' && run.workflow === workflowId
      && run.workflowRecurringReadAdmission?.activationAuthority?.activationId === activationId);
}

test.after(() => {
  bridge._setBridgeImplsForTests({});
  runtimeConfig.resetHarnessRuntimeConfig();
  convergence.automationPilotProductionConvergenceInternalsForTest.reset();
  for (const workspace of spaces.spaceStore.list(true)) spaces.spaceStore.remove(workspace.id);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  partitions.closeAutomationPartitionAuthorityForTests();
  fanout.closeDurableFanoutForTests();
  opportunityStore.closeAutomationOpportunityStoreForTests();
  eventlog.closeEventLog();
  memoryDb.closeMemoryDb();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('10,001 naturally reviewed partitions survive fresh-process restart, backpressure, retry, and occurrence dedupe', {
  timeout: 900_000,
}, async () => {
  assert.ok(support.PARTITION_RECORD_COUNT > topology.WORK_TOPOLOGY_MAX_UNIVERSE_MEMBERS);
  assert.equal(topology.WORK_TOPOLOGY_MAX_UNIVERSE_MEMBERS, 10_000);
  assert.equal(topology.WORK_TOPOLOGY_MAX_INLINE_MODEL_MEMBERS, 256);

  eventlog.resetEventLog();
  runtimeConfig.resetHarnessRuntimeConfig();
  const configured = await runtimeConfig.configureHarnessRuntime();
  assert.equal(configured.ok, true, configured.ok ? '' : configured.reason);

  let ordinaryStep = 0;
  const ordinaryModel = {
    async getResponse(rawRequest: unknown) {
      const serialized = JSON.stringify(rawRequest ?? {});
      const tools = (((rawRequest ?? {}) as { tools?: Array<{ name?: string }> }).tools ?? [])
        .map((entry) => entry.name ?? '').filter(Boolean);
      ordinaryStep += 1;
      if (ordinaryStep === 1) {
        assert.match(serialized, /10,001 shard identities/);
        assert.ok(tools.includes('tool_search'));
        return {
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
          output: [functionCall('find-partition-opportunity', 'tool_search', {
            query: 'persist reviewable recurring paginated partition automation with restart retry and dedupe',
            role_key: 'clause-0:write', limit: 8, cursor: null,
          })], responseId: 'partition-opportunity-1',
        };
      }
      if (ordinaryStep === 2) {
        assert.match(serialized, /automation_opportunity_propose/);
        assert.ok(tools.includes('call_tool'));
        return {
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
          output: [functionCall('persist-partition-opportunity', 'call_tool', {
            name: 'automation_opportunity_propose',
            args_json: JSON.stringify({
              proposal_key: PROPOSAL_KEY, opportunity: OPPORTUNITY,
              note: 'Ordinary-channel structural evidence for the large partition lane.',
            }),
          })], responseId: 'partition-opportunity-2',
        };
      }
      assert.match(serialized, /executionAuthority/);
      assert.match(serialized, /user_review/);
      return {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 },
        output: [finalMessage('I saved one inert large-partition automation opportunity for review; nothing was run or scheduled.')],
        responseId: 'partition-opportunity-3',
      };
    },
    getStreamedResponse: streamResponse,
  };
  bridge._setBridgeImplsForTests({
    buildAgent: async (options) => buildOrchestratorAgent({ ...options, model: ordinaryModel as never }),
  });
  eventlog.createSession({ id: OWNER_SESSION_ID, kind: 'chat', userId: 'partition-owner' });
  let acceptedSource: { seq: number; turn: number } | null = null;
  const chatDelivery = delivery();
  await discord.runDiscordHarnessConversation({
    prompt: ORDINARY_PROMPT, rawPrompt: ORDINARY_PROMPT,
    channelId: 'partition-owner-channel', userId: 'partition-owner', guildId: 'partition-owner-guild',
    transport: chatDelivery.transport,
    durableRequest: {
      sessionId: OWNER_SESSION_ID, runId: 'partition-opportunity-chat-run',
      onSourceAccepted(source: { seq: number; turn: number }) {
        acceptedSource = { seq: source.seq, turn: source.turn };
      },
    },
  });
  assert.ok(acceptedSource);
  assert.equal(ordinaryStep, 3);
  assert.deepEqual(chatDelivery.errors, []);
  assert.match(chatDelivery.edits.at(-1) ?? '', /saved one inert/i);
  const proposals = opportunityStore.listAutomationOpportunityProposals({ limit: 10 });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]?.status, 'proposed');
  assert.deepEqual(proposals[0]?.opportunity, OPPORTUNITY);
  assert.equal(
    opportunityStore.listAutomationOpportunityProposalRevisions(proposals[0]!.proposalId)[0]?.actorRef,
    `accepted-source:${OWNER_SESSION_ID}#${acceptedSource!.seq}`,
  );
  assert.equal((eventlog.openEventLog().prepare(
    'SELECT COUNT(*) AS count FROM pending_approvals',
  ).get() as { count: number }).count, 0);

  spaces.spaceStore.save({ id: 'workspace-partition-ledger', title: 'Generated partition ledger' });
  const review = opportunityReview.registerAutomationOpportunityReviewProjection({
    proposalId: proposals[0]!.proposalId,
    expectedProposalRevision: proposals[0]!.revision,
    expectedProposalDigest: proposals[0]!.digest,
    approvalSessionId: OWNER_SESSION_ID,
    requestSourceUserSeq: acceptedSource!.seq,
  });
  assert.equal(review.ok, true, JSON.stringify(review));
  if (!review.ok) return;

  const carrier = support.installGeneratedPartitionCarrier();
  const authoringRequests: ModelRequest[] = [];
  const options = {
    advancementPorts: { acquisition: carrier.acquisition },
    authoringPort: dispatcher.createProductionAutomationPilotAuthoringPort({
      resolveModel: () => authoringModel(authoringRequests),
    }),
  };
  assert.equal(carrier.counts.call, 0);
  assert.equal(approvals.resolve(review.approval.approvalId, 'approved', 'human.partition.review').ok, true);
  const firstConvergence = await convergence.reconcileAutomationPilotProductionConvergence(options);
  assert.equal(firstConvergence.failures, 0, JSON.stringify(firstConvergence));
  const pendingChooser = chooser.listAutomationPilotWorkspaceChoosers({ status: 'pending' })[0];
  assert.ok(pendingChooser);
  const selectedWorkspace = pendingChooser!.choices.find((choice) =>
    choice.kind === 'existing' && choice.workspace.workspaceId === 'workspace-partition-ledger');
  assert.ok(selectedWorkspace);
  const chosen = chooser.resolveAutomationPilotWorkspaceChooser({
    chooserId: pendingChooser!.chooserId,
    expectedChooserRevision: pendingChooser!.chooserRevision,
    expectedChooserDigest: pendingChooser!.chooserDigest,
    choiceId: selectedWorkspace!.choiceId,
    actorRef: 'human.partition.workspace',
  });
  assert.equal(chosen.ok, true, JSON.stringify(chosen));

  const authored = await convergence.reconcileAutomationPilotProductionConvergence(options);
  assert.equal(authored.failures, 0, JSON.stringify(authored));
  assert.equal(authoringRequests.length, 1);
  assert.equal(carrier.counts.call, 0, 'metadata acquisition and constrained authoring never sample business data');
  const saga = advancement.listAutomationPilotAdvancements({ limit: 10 })[0];
  assert.ok(saga);
  assert.equal(saga!.stage, 'pilot_approval_pending', JSON.stringify(saga));
  const pilotProjection = pilot.loadAutomationReadPilotProjection(saga!.pilotProjectionId!);
  assert.ok(pilotProjection?.approvalId);
  assert.equal(pilotProjection?.status, 'approval_pending');
  assert.equal(approvals.resolve(pilotProjection!.approvalId!, 'approved', 'human.partition.pilot').ok, true);
  const queuedConvergence = await convergence.reconcileAutomationPilotProductionConvergence(options);
  assert.equal(queuedConvergence.failures, 0, JSON.stringify(queuedConvergence));
  const queuedPilot = pilot.loadAutomationReadPilotProjection(saga!.pilotProjectionId!);
  assert.ok(queuedPilot?.runId);
  assert.equal(queuedPilot?.status, 'queued');

  await runner.processWorkflowRuns({} as ClementineAssistant);
  assert.equal(carrier.counts.call, support.PARTITION_PAGE_COUNT);
  assert.deepEqual(carrier.counts.cursors, [null, 'partition-page-1', 'partition-page-2']);
  const pilotRunBytes = readFileSync(path.join(shared.WORKFLOW_RUNS_DIR, `${queuedPilot!.runId}.json`), 'utf8');
  const pilotRun = JSON.parse(pilotRunBytes) as {
    status?: string; terminalOutcome?: string; goalOutcome?: string;
    goalValidation?: {
      pass?: boolean;
      judgeFailedOpen?: boolean;
      perCriterion?: Array<{ pass?: boolean; method?: string }>;
    };
  };
  assert.equal(pilotRun.status, 'completed', pilotRunBytes);
  assert.equal(pilotRun.terminalOutcome, 'succeeded', pilotRunBytes);
  assert.equal(pilotRun.goalOutcome, 'satisfied', pilotRunBytes);
  assert.equal(pilotRun.goalValidation?.pass, true);
  assert.equal(pilotRun.goalValidation?.judgeFailedOpen, false);
  assert.deepEqual(pilotRun.goalValidation?.perCriterion?.map((criterion) => ({
    pass: criterion.pass,
    method: criterion.method,
  })), [{ pass: true, method: 'deterministic' }]);
  const pilotAggregate = eventlog.openEventLog().prepare(`
    SELECT receipt.page_result_handles_json, receipt.page_count, receipt.total_item_count,
           receipt.final_exhausted_truth, receipt.coverage_state, receipt.outcome
      FROM workflow_paginated_aggregate_receipts receipt
      JOIN workflow_paginated_read_activations activation
        ON activation.activation_id = receipt.activation_id
     WHERE activation.run_id = ?
  `).get(queuedPilot!.runId!) as {
    page_result_handles_json: string;
    page_count: number;
    total_item_count: number;
    final_exhausted_truth: string;
    coverage_state: string;
    outcome: string;
  } | undefined;
  assert.ok(pilotAggregate);
  assert.equal(JSON.parse(pilotAggregate!.page_result_handles_json).length, support.PARTITION_PAGE_COUNT);
  assert.equal(pilotAggregate!.page_count, support.PARTITION_PAGE_COUNT);
  assert.equal(pilotAggregate!.total_item_count, support.PARTITION_RECORD_COUNT);
  assert.equal(pilotAggregate!.final_exhausted_truth, 'true');
  assert.equal(pilotAggregate!.coverage_state, 'complete');
  assert.equal(pilotAggregate!.outcome, 'complete');
  const pilotSuccess = recurrenceRuntime.projectAutomationRecurrencePilotSuccess(queuedPilot!.runId!);
  assert.equal(pilotSuccess.ok, true, JSON.stringify(pilotSuccess));
  if (!pilotSuccess.ok) return;
  assert.equal(pilotSuccess.evidence.resultAuthority.acceptedSourceCount, support.PARTITION_RECORD_COUNT);
  assert.equal(pilotSuccess.sourceDefinition.steps.length, 1);
  assert.equal(pilotSuccess.sourceDefinition.steps[0]?.id, SOURCE_PHASE);
  assert.equal(pilotSuccess.sourceDefinition.steps[0]?.invocationPlan?.continuation.kind, 'cursor');

  const recurrence = recurrenceRuntime.requestAutomationRecurrenceActivation({
    pilotRunId: queuedPilot!.runId!, approvalSessionId: OWNER_SESSION_ID,
    cadence: { every: 2, unit: 'hour', overlapPolicy: 'skip', catchUpPolicy: 'run_once' },
    previewedAt: '2026-08-27T12:00:00.000Z',
  });
  assert.equal(recurrence.ok, true, JSON.stringify(recurrence));
  if (!recurrence.ok) return;
  assert.equal(recurrence.activation.status, 'approval_pending');
  assert.equal(approvals.resolve(
    recurrence.approval.approvalId, 'approved', 'human.partition.recurrence',
  ).ok, true);
  const recurrenceReconciled = recurrenceRuntime.reconcileAutomationRecurrences();
  assert.equal(recurrenceReconciled.failed, 0, JSON.stringify(recurrenceReconciled));
  assert.ok(recurrenceReconciled.active >= 1);
  const active = recurrenceControl.getAutomationRecurrenceActiveAuthority(recurrence.activation.activationId);
  assert.ok(active);
  assert.equal(workflowStore.readWorkflow(pilotSuccess.evidence.workflowId)?.data.enabled, true);

  const firstFire = await scheduler.processWorkflowSchedules(new Date(recurrence.preview.firstFireAt));
  assert.equal(firstFire.fired.filter((candidate) => candidate === pilotSuccess.evidence.workflowId).length, 1, JSON.stringify(firstFire));
  const firstRuns = scheduledRuns(pilotSuccess.evidence.workflowId, recurrence.activation.activationId);
  assert.equal(firstRuns.length, 1, JSON.stringify(firstRuns));
  const scheduledRun = firstRuns[0]!;
  assert.equal(scheduledRun.status, 'queued');
  assert.equal(scheduledRun.workflowRecurringReadAdmission?.occurrenceOrdinal, 1);
  assert.equal(scheduledRun.workflowRecurringReadAdmission?.runOccurrenceId, scheduledRun.triggerReceiptId);
  assert.equal(workflowQueue.readWorkflowTriggerReceiptAcceptance(scheduledRun.triggerReceiptId!), scheduledRun.id);

  rmSync(intervalScheduler.workflowIntervalSchedulerInternalsForTest.intervalStateFile, { force: true });
  partitions.closeAutomationPartitionAuthorityForTests();
  fanout.closeDurableFanoutForTests();
  opportunityStore.closeAutomationOpportunityStoreForTests();
  eventlog.closeEventLog();
  memoryDb.closeMemoryDb();
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();

  const fixture = path.join(import.meta.dirname, 'automation-partition-ledger.fixture.ts');
  const child = spawnSync(process.execPath, ['--import', 'tsx', fixture], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEMENTINE_HOME: TEST_HOME,
      CLEMMY_TEST_ISOLATED_HOME: '1',
      ROW10_RUN_ID: scheduledRun.id!,
      ROW10_ACTIVATION_ID: recurrence.activation.activationId,
      ROW10_WORKFLOW_ID: pilotSuccess.evidence.workflowId,
      ROW10_FIRST_FIRE_AT: recurrence.preview.firstFireAt,
      ROW10_PROPOSAL_ID: pilotSuccess.evidence.proposalId,
    },
    encoding: 'utf8', timeout: 600_000, maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(child.signal, null, `${child.stdout}\n${child.stderr}`);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  const summaryLine = child.stdout.split('\n').find((line) => line.startsWith('ROW10_RESULT '));
  assert.ok(summaryLine, `${child.stdout}\n${child.stderr}`);
  const summary = JSON.parse(summaryLine!.slice('ROW10_RESULT '.length)) as {
    occurrenceDeduped: boolean; scheduledRunCount: number; providerCalls: number;
    authorityId: string; ledgerDigest: string; partitionCount: number; pageCount: number;
    fanoutPlanId: string; activationCount: number; windowCount: number;
    initialWorkerTasks: number; claimedAfterRetry: number; retriedWindowAttempts: number;
    replayState: string;
  };
  assert.deepEqual(summary, {
    occurrenceDeduped: true,
    scheduledRunCount: 1,
    providerCalls: support.PARTITION_PAGE_COUNT,
    authorityId: summary.authorityId,
    ledgerDigest: summary.ledgerDigest,
    partitionCount: support.PARTITION_RECORD_COUNT,
    pageCount: support.PARTITION_PAGE_COUNT,
    fanoutPlanId: summary.fanoutPlanId,
    activationCount: support.PARTITION_RECORD_COUNT,
    windowCount: Math.ceil(support.PARTITION_RECORD_COUNT / 256),
    initialWorkerTasks: 2,
    claimedAfterRetry: 2,
    retriedWindowAttempts: 2,
    replayState: 'replayed',
  });

  const durableAuthority = partitions.loadAutomationPartitionAuthority(summary.authorityId);
  assert.ok(durableAuthority);
  assert.equal(durableAuthority?.ledgerDigest, summary.ledgerDigest);
  assert.equal(durableAuthority?.partitionCount, support.PARTITION_RECORD_COUNT);
  assert.equal(durableAuthority?.source.pageCount, support.PARTITION_PAGE_COUNT);
  const sourcePages = partitions.automationPartitionAuthorityInternalsForTest.database().prepare(`
    SELECT COUNT(*) AS count,
           COUNT(DISTINCT result_handle_id) AS distinct_handles,
           SUM(exhausted) AS exhausted_pages
      FROM automation_partition_source_pages
     WHERE authority_id = ?
  `).get(summary.authorityId) as { count: number; distinct_handles: number; exhausted_pages: number };
  assert.deepEqual(sourcePages, {
    count: support.PARTITION_PAGE_COUNT,
    distinct_handles: support.PARTITION_PAGE_COUNT,
    exhausted_pages: 1,
  });
  let retainedPartitions = 0;
  let firstPartition: ReturnType<typeof partitions.listAutomationPartitions>[number] | undefined;
  let lastPartition: ReturnType<typeof partitions.listAutomationPartitions>[number] | undefined;
  for (let offset = 0; offset < support.PARTITION_RECORD_COUNT; offset += 1_000) {
    const page = partitions.listAutomationPartitions(summary.authorityId, { offset, limit: 1_000 });
    retainedPartitions += page.length;
    firstPartition ??= page[0];
    lastPartition = page.at(-1) ?? lastPartition;
  }
  assert.equal(retainedPartitions, support.PARTITION_RECORD_COUNT, 'the normalized ledger evicted no partition');
  assert.deepEqual(firstPartition?.key, { shard_code: 'scope_00000' });
  assert.deepEqual(lastPartition?.key, { shard_code: 'scope_10000' });
  const activations = fanout.listFanoutActivations(summary.fanoutPlanId);
  assert.equal(activations.length, support.PARTITION_RECORD_COUNT);
  assert.equal(new Set(activations.map((row) => `${row.itemId}:${row.phaseId}`)).size, support.PARTITION_RECORD_COUNT);
  assert.equal(scheduledRuns(pilotSuccess.evidence.workflowId, recurrence.activation.activationId).length, 1);
});
