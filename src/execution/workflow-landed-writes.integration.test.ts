/**
 * Landed writes stay landed — pinned through the real workflow runner.
 *
 * Each fixture drives `processWorkflowRuns` over a queued run whose write
 * crosses the real shared call kernel and settles in the real ledger. Only the
 * goal reviewer (a model) is stubbed, to report a gap after the write landed.
 *
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-landed-writes.integration.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-landed-writes-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const runner = await import('./workflow-runner.js');
const workflowStore = await import('../memory/workflow-store.js');
const workflowQueue = await import('../tools/workflow-run-queue.js');
const failureLedger = await import('./workflow-failure-ledger.js');
const carrier = await import('../runtime/harness/reviewed-local-tool-carrier.js');
const adapters = await import('../runtime/harness/production-capability-adapters.js');
const manifests = await import('../runtime/harness/capability-manifest-store.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const spaces = await import('../spaces/store.js');
const workspaceDb = await import('../spaces/workspace-db.js');
const shared = await import('../tools/shared.js');
const notifications = await import('../runtime/notifications.js');

import type { WorkflowDefinition } from '../memory/workflow-store.js';

test.after(() => {
  runner._setWorkflowRunGoalJudgeForTests(null);
  runner._setWorkflowVoiceRewriteForTests(null);
  runner._setWorkflowWatcherForTests(null);
  workspaceDb.closeWorkspaceDb();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function readRun(runId: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(shared.WORKFLOW_RUNS_DIR, `${runId}.json`), 'utf8')) as Record<string, any>;
}

function queuedRunsFor(workflowName: string): Array<Record<string, any>> {
  const dir = shared.WORKFLOW_RUNS_DIR;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Record<string, any>)
    .filter((record) => record.workflow === workflowName);
}

/** The goal reviewer reports the same gap on every attempt. */
function stubGapReviewer(note: string): { calls: () => number } {
  let calls = 0;
  runner._setWorkflowRunGoalJudgeForTests({
    judge: async () => {
      calls += 1;
      return { done: false, reason: note };
    },
    judgeCriteria: async (_objective: string, criteria: string[]) => {
      calls += 1;
      return criteria.map((criterion) => ({ criterion, pass: false, note }));
    },
  } as never);
  return { calls: () => calls };
}

function installQuietReportSeams(): void {
  runner._setWorkflowVoiceRewriteForTests((async (message: string) => ({ message, nothingHappened: false })) as never);
  runner._setWorkflowWatcherForTests((async () => ({ onTrack: true })) as never);
}

function installSpaceSetDataPort(): void {
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  const observed = carrier.observeReviewedLocalTool('space_set_data');
  assert.ok(observed);
  const manifest = carrier.reviewedLocalCapabilityManifest(observed);
  assert.ok(manifest);
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(manifest),
    {
      invoke: adapters.invokeForSealedManifest(manifest),
      reconcile: adapters.reconcileForSealedManifest(manifest),
    },
  ).ok, true);
}

test('FRAMEWORK-TEST-landed-dataset: a gap after a landed, repeat-safe write re-runs it, never blocks, and the replay adds no write', async () => {
  installSpaceSetDataPort();
  installQuietReportSeams();
  const slug = 'framework-test-landed-dataset';
  spaces.spaceStore.save({
    id: slug,
    title: 'FRAMEWORK-TEST landed dataset',
    status: 'active',
    viewEntry: 'view/index.html',
    viewContent: '<!doctype html><title>FRAMEWORK-TEST landed dataset</title>',
    dataSources: [],
    actions: [],
  });
  const workflow: WorkflowDefinition = {
    name: 'FRAMEWORK-TEST-landed-dataset',
    description: 'Commit one fictional dataset into a test Space.',
    enabled: true,
    trigger: { schedule: '0 7 * * *', timezone: 'UTC' },
    inputs: {},
    steps: [{
      id: 'update_dataset',
      prompt: '',
      sideEffect: 'write',
      call: {
        tool: 'space_set_data',
        args: {
          slug,
          source_id: 'dashboard',
          data_json: JSON.stringify({ summary: { pipeline: '$1,000' }, rows: [{ id: 'fixture-row-1' }] }),
        },
      },
    }],
    goal: {
      objective: 'Keep the fictional test dataset current through one idempotent commit.',
      successCriteria: ['A replay of the commit adds no second write'],
      maxAttempts: 2,
    },
  };
  const persisted = workflowStore.writeWorkflow(workflow.name, workflow);
  // Two earlier genuine failures: under the old rule this run's goal miss
  // would have been the third and paused self-healing.
  failureLedger.recordWorkflowOutcome(persisted.name, false, 'earlier failure one');
  failureLedger.recordWorkflowOutcome(persisted.name, false, 'earlier failure two');
  const reviewer = stubGapReviewer('No replay was recorded, so a second write cannot be ruled out.');

  const queued = workflowQueue.queueWorkflowRun(persisted.data.name, {}, {
    source: 'schedule',
    workflowSlug: persisted.name,
    triggerReceiptId: `workflow-schedule:v1:${persisted.name}:1790000000000`,
    dedupe: false,
  });
  assert.equal(queued.status, 'queued', queued.message);
  const firstRunId = queued.id!;

  await runner.processWorkflowRuns({} as never);

  const first = readRun(firstRunId);
  assert.equal(first.status, 'completed', JSON.stringify({
    parked: first.parked, error: first.error, blockedSteps: first.blockedSteps, capabilityBlock: first.capabilityBlock,
    mutationBlock: first.mutationBlock, heldExecution: first.heldExecution, awaitingInput: first.awaitingInput,
  }).slice(0, 3000));
  assert.equal(first.terminalOutcome, 'succeeded', 'a run whose write landed never ends blocked on the goal review');
  assert.notEqual(first.needsAttention, true);
  assert.equal(first.goalOutcome, 'repursue', first.goalReason);
  assert.equal(first.goalValidation?.pass, false, 'the review verdict stays on the record');
  assert.equal(first.reportBack?.outcome, 'done');
  assert.doesNotMatch(String(first.reportBack?.detail), /auto-heal is PAUSED|reconcile any completed writes|re-running could double/);
  assert.match(String(first.reportBack?.detail), /landed and stays as it is/);
  assert.equal(failureLedger.getConsecutiveFailures(persisted.name), 0, 'a landed-write run is not a failure');
  const observationsAfterFirst = workspaceDb.listWorkspaceDatasetObservations(slug, { limit: 20 }).length;
  assert.equal(observationsAfterFirst, 1, 'the first run committed the dataset once');

  const followUps = queuedRunsFor(persisted.data.name).filter((record) => record.id !== firstRunId);
  assert.equal(followUps.length, 1, 'one follow-up attempt was queued');
  const followUp = followUps[0]!;
  assert.equal(followUp.goalAttempt, 1);
  assert.equal(followUp.goalFollowUp?.fromRunId, firstRunId);
  assert.deepEqual(followUp.goalFollowUp?.carriedSteps, [], 'a repeat-safe write is not carried; it simply runs again');
  assert.match(String(followUp.goalFeedback), /Already done by earlier attempts of this goal/);
  assert.match(String(followUp.goalFeedback), /space_set_data/);

  await runner.processWorkflowRuns({} as never);

  const second = readRun(followUp.id);
  assert.equal(second.status, 'completed', JSON.stringify(second).slice(0, 800));
  assert.equal(second.terminalOutcome, 'succeeded');
  assert.notEqual(second.needsAttention, true);
  assert.equal(second.goalOutcome, 'gap', 'attempts used up: done, with the gap named');
  assert.match(String(second.reportBack?.detail), /Done, with a gap/);
  assert.equal(
    workspaceDb.listWorkspaceDatasetObservations(slug, { limit: 20 }).length,
    observationsAfterFirst,
    'the content-addressed replay added no second write',
  );
  assert.equal(failureLedger.getConsecutiveFailures(persisted.name), 0);
  assert.equal(reviewer.calls(), 2, 'the goal reviewer judged both attempts');
  const pausedNotices = notifications.loadNotifications()
    .filter((row) => String(row.body ?? '').includes('auto-heal is PAUSED'));
  assert.equal(pausedNotices.length, 0, 'self-healing never paused for landed work');
});

const capabilityManifests = await import('../runtime/harness/capability-manifest.js');
const { createHash } = await import('node:crypto');

/** A fictional provider write the tool registry declares nothing about: its
 *  landed write cannot be assumed safe to repeat. */
function installFictionalProviderWrite(label: string, opts: { providerResult?: unknown; providerErrorAfterBody?: string } = {}) {
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  ports.clearProductionCapabilityPorts();
  observations.clearIndependentCapabilityObservations();
  const operationId = `FRAMEWORK_TEST_${label.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_APPEND`;
  const manifest = capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest.${label}`,
    providerKind: 'local_registry',
    operationId,
    providerIdentity: `framework-test.${label}`,
    providerVersion: 'fixture.1',
    operationVersion: '1',
    definitionFingerprint: createHash('sha256').update(`schema.${label}`).digest('hex'),
    effect: 'external_write',
    accountId: `account.${label}`,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'bounded_read',
    acceptedInputKinds: ['scope'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['records'], readbackRequired: false },
    provenance: { issuer: 'framework-test', issuedAt: '2026-09-26T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['write'],
  });
  let bodies = 0;
  assert.equal(ports.registerFixtureCapabilityPort(
    ports.productionPortIdentityFromManifest(manifest),
    {
      invoke: async () => {
        bodies += 1;
        if (opts.providerErrorAfterBody) throw new Error(opts.providerErrorAfterBody);
        return structuredClone(opts.providerResult ?? { data: { id: `row-${bodies}`, permalink: `https://tracker.example.test/rows/${bodies}` } });
      },
    },
  ).ok, true);
  const entry = {
    capabilityId: `capability.${label}`,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => { throw new Error('catalog callback cannot own runner v3 I/O'); },
  } as catalogs.RegisteredHostCapability;
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory([entry]));
  assert.equal(observations.registerIndependentCapabilityObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt: Date.now(),
    origin: 'independent',
    observe: () => ({
      operationId: manifest.operationId,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt: Date.now(),
    }),
  }).ok, true);
  return { operationId, bodies: () => bodies };
}

function scheduledCallWorkflow(name: string, operationId: string, stepId: string): WorkflowDefinition {
  return {
    name,
    description: 'Append one fictional row to a test tracker.',
    enabled: true,
    trigger: { schedule: '0 12 * * *', timezone: 'UTC' },
    inputs: {},
    steps: [{
      id: stepId,
      prompt: '',
      sideEffect: 'write',
      call: { tool: operationId, args: { scope: 'fixture-tracker' } },
    }],
    goal: {
      objective: 'Record today\'s fictional tracker row and re-check the last seven days of rows.',
      successCriteria: ['Rows from the last seven days were re-checked'],
      maxAttempts: 2,
    },
  };
}

test('FRAMEWORK-TEST-landed-tracker: a gap after a landed write that cannot repeat is done-with-a-gap, never blocked, never re-run', async () => {
  installQuietReportSeams();
  const provider = installFictionalProviderWrite('landed-tracker');
  const persisted = workflowStore.writeWorkflow(
    'FRAMEWORK-TEST-landed-tracker',
    scheduledCallWorkflow('FRAMEWORK-TEST-landed-tracker', provider.operationId, 'append_row'),
  );
  failureLedger.recordWorkflowOutcome(persisted.name, false, 'earlier failure one');
  failureLedger.recordWorkflowOutcome(persisted.name, false, 'earlier failure two');
  stubGapReviewer('The seven-day re-check was skipped.');
  const queued = workflowQueue.queueWorkflowRun(persisted.data.name, {}, {
    source: 'schedule',
    workflowSlug: persisted.name,
    triggerReceiptId: `workflow-schedule:v1:${persisted.name}:1790010000000`,
    dedupe: false,
  });
  assert.equal(queued.status, 'queued', queued.message);

  await runner.processWorkflowRuns({} as never);

  const run = readRun(queued.id!);
  assert.equal(provider.bodies(), 1, 'the provider write crossed exactly once');
  assert.equal(run.status, 'completed', JSON.stringify({ blockedSteps: run.blockedSteps, error: run.error, status: run.status }));
  assert.equal(run.terminalOutcome, 'succeeded', 'the write landed: the run is not blocked on the review');
  assert.notEqual(run.needsAttention, true);
  assert.equal(run.goalOutcome, 'gap', run.goalReason);
  assert.match(String(run.goalReason), /cannot run again automatically/);
  assert.match(String(run.reportBack?.detail), /Done, with a gap/);
  assert.match(String(run.reportBack?.detail), /seven-day re-check was skipped/);
  assert.doesNotMatch(String(run.reportBack?.detail), /auto-heal is PAUSED|reconcile any completed writes|re-running could double/);
  assert.equal(
    queuedRunsFor(persisted.data.name).filter((record) => record.id !== queued.id).length,
    0,
    'a write that cannot repeat is never re-run automatically',
  );
  assert.equal(failureLedger.getConsecutiveFailures(persisted.name), 0);
});

test('FRAMEWORK-TEST-unconfirmed-tracker: a write whose provider reply never came back does not read as landed or done', async () => {
  installQuietReportSeams();
  const provider = installFictionalProviderWrite('unconfirmed-tracker', { providerErrorAfterBody: 'connection reset after the request was sent' });
  const persisted = workflowStore.writeWorkflow(
    'FRAMEWORK-TEST-unconfirmed-tracker',
    scheduledCallWorkflow('FRAMEWORK-TEST-unconfirmed-tracker', provider.operationId, 'append_row'),
  );
  stubGapReviewer('unused: the run never reaches goal review');
  const queued = workflowQueue.queueWorkflowRun(persisted.data.name, {}, {
    source: 'schedule',
    workflowSlug: persisted.name,
    triggerReceiptId: `workflow-schedule:v1:${persisted.name}:1790020000000`,
    dedupe: false,
  });
  assert.equal(queued.status, 'queued', queued.message);

  await runner.processWorkflowRuns({} as never);

  const run = readRun(queued.id!);
  assert.equal(provider.bodies(), 1);
  assert.notEqual(run.terminalOutcome, 'succeeded', JSON.stringify({ status: run.status, terminalOutcome: run.terminalOutcome }));
  assert.notEqual(run.goalOutcome, 'gap');
  assert.notEqual(run.goalOutcome, 'follow_up');
  const facts = (await import('./workflow-run-write-facts.js')).readWorkflowRunWriteFacts({
    runId: queued.id!,
    steps: persisted.data.steps,
    completedStepIds: new Set(['append_row']),
    sideEffectOf: () => 'write',
  });
  assert.equal(facts.steps[0]?.disposition, 'uncertain', 'an unanswered write is never a landed fact');
  assert.equal(
    queuedRunsFor(persisted.data.name).filter((record) => record.id !== queued.id).length,
    0,
    'nothing re-runs an unresolved write',
  );
});

const shadow = await import('../runtime/graph/turn-graph-shadow.js');
const identities = await import('../runtime/harness/attempt-identity.js');
const dispatchLedger = await import('../runtime/harness/dispatch-ledger.js');
const attemptSettlement = await import('../runtime/harness/attempt-settlement.js');
const stepResults = await import('../tools/step-result-tool.js');

/** What the stubbed model does in one step attempt. Every tool call it makes
 *  is admitted and settled through the same ledger path the host uses. */
type ModelAction = { tool: string; mutating: boolean; result: unknown };

function stubModelStep(plan: (attempt: number, input: string) => { calls: ModelAction[]; output: unknown }) {
  const prompts: string[] = [];
  runner._setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (options: { sessionId: string; sourceUserSeq: number; input: string }) => {
      prompts.push(String(options.input));
      const { calls, output } = plan(prompts.length, String(options.input));
      if (calls.length > 0) {
        const identity = { sessionId: options.sessionId, sourceUserSeq: options.sourceUserSeq, turn: 1 };
        shadow.recordTurnGraphShadow({ identity });
        const acceptedTaskId = identities.acceptedTaskIdFor(options.sessionId, options.sourceUserSeq);
        calls.forEach((call, index) => {
          const logicalToolCallId = `framework-test-call-${prompts.length}-${index}`;
          const args = { scope: 'fixture-tracker', attempt: prompts.length };
          const opened = dispatchLedger.admitLogicalCall({
            identity: { ...identity, acceptedTaskId, logicalToolCallId },
            tool: call.tool,
            args,
          });
          assert.equal(opened.status, 'inserted', JSON.stringify(opened));
          eventlog.appendEvent({
            sessionId: options.sessionId,
            turn: 1,
            role: 'assistant',
            type: 'tool_called',
            data: { tool: call.tool, callId: logicalToolCallId, sourceUserSeq: options.sourceUserSeq, accounting: 'top_level' },
          });
          attemptSettlement.settleToolAttempt({
            sessionId: options.sessionId,
            sourceUserSeq: options.sourceUserSeq,
            turn: 1,
            lane: 'agents_runner',
            toolName: call.tool,
            callId: logicalToolCallId,
            args,
            mutating: call.mutating,
            businessCall: true,
            result: call.result,
          });
        });
      }
      stepResults.recordStepResult(options.sessionId, output);
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 'done', reply: 'done', done: true, nextAction: 'completed' },
      };
    }) as never,
  });
  return { prompts };
}

/** First review finds a gap; the second finds the goal met. */
function stubReviewerGapThenMet(note: string): void {
  let reviews = 0;
  runner._setWorkflowRunGoalJudgeForTests({
    judge: async () => ({ done: reviews++ > 0, reason: note }),
    judgeCriteria: async (_objective: string, criteria: string[]) => {
      const met = reviews++ > 0;
      return criteria.map((criterion) => ({ criterion, pass: met, note: met ? 'met under test' : note }));
    },
  } as never);
}

function modelWriteWorkflow(name: string): WorkflowDefinition {
  return {
    name,
    description: 'Review a fictional test channel and keep a fictional tracker current.',
    enabled: true,
    trigger: { schedule: '0 16 * * *', timezone: 'UTC' },
    inputs: {},
    steps: [{
      id: 'review',
      prompt: 'Read the fictional FRAMEWORK-TEST channel, log new requests in the fictional tracker, and re-check rows from the last seven days.',
      sideEffect: 'write',
    }],
    goal: {
      objective: 'Keep the fictional tracker current, including the seven-day re-check.',
      successCriteria: ['Rows from the last seven days were re-checked'],
      maxAttempts: 2,
    },
  };
}

function mutatingSettlementsFor(runId: string, stepId: string): number {
  const row = eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM logical_call_settlements
     WHERE (session_id = ? OR substr(session_id, 1, ?) = ?) AND mutating = 1
  `).get(`workflow:${runId}:${stepId}`, `workflow:${runId}:${stepId}:`.length, `workflow:${runId}:${stepId}:`) as { n: number };
  return row.n;
}

test('FRAMEWORK-TEST-landed-review: a model step whose write landed re-checks only the gap in a follow-up that lists the landed write as done', async () => {
  installQuietReportSeams();
  const model = stubModelStep((attempt) => attempt === 1
    ? {
        calls: [{ tool: 'framework_test_tracker_update', mutating: true, result: { ok: true, data: { id: 'row-7', updated_range: 'Tracker!A7:F7' } } }],
        output: { url: 'https://tracker.example.test/sheet', leads: 1 },
      }
    : {
        calls: [{ tool: 'framework_test_tracker_read', mutating: false, result: { ok: true, data: { rows: [{ id: 'row-7' }] } } }],
        output: { url: 'https://tracker.example.test/sheet', leads: 0, rechecked: 7 },
      });
  stubReviewerGapThenMet('The seven-day re-check was skipped.');
  const persisted = workflowStore.writeWorkflow('FRAMEWORK-TEST-landed-review', modelWriteWorkflow('FRAMEWORK-TEST-landed-review'));
  const queued = workflowQueue.queueWorkflowRun(persisted.data.name, {}, {
    source: 'schedule',
    workflowSlug: persisted.name,
    triggerReceiptId: `workflow-schedule:v1:${persisted.name}:1790030000000`,
    dedupe: false,
  });
  assert.equal(queued.status, 'queued', queued.message);
  try {
    await runner.processWorkflowRuns({} as never);
    const first = readRun(queued.id!);
    assert.equal(first.status, 'completed', JSON.stringify({ blockedSteps: first.blockedSteps, error: first.error }));
    assert.equal(first.terminalOutcome, 'succeeded');
    assert.notEqual(first.needsAttention, true);
    assert.equal(first.goalOutcome, 'follow_up', first.goalReason);
    assert.equal(first.reportBack?.outcome, 'done');
    assert.match(String(first.reportBack?.detail), /Re-checking only what is missing/);
    assert.equal(mutatingSettlementsFor(queued.id!, 'review'), 1, 'the first attempt landed one write');

    const followUps = queuedRunsFor(persisted.data.name).filter((record) => record.id !== queued.id);
    assert.equal(followUps.length, 1);
    const followUp = followUps[0]!;
    assert.deepEqual(followUp.goalFollowUp?.continuedStepIds, ['review']);
    assert.deepEqual(followUp.goalFollowUp?.carriedSteps, []);

    await runner.processWorkflowRuns({} as never);

    assert.equal(model.prompts.length, 2);
    const secondPrompt = model.prompts[1]!;
    assert.match(secondPrompt, /seven-day re-check was skipped/, 'the follow-up is told what is missing');
    assert.match(secondPrompt, /Already done by earlier attempts of this goal/, 'and what already landed');
    assert.match(secondPrompt, /framework_test_tracker_update/);
    assert.match(secondPrompt, /do not repeat them/);
    const second = readRun(followUp.id);
    assert.equal(second.status, 'completed', JSON.stringify({ blockedSteps: second.blockedSteps, error: second.error }));
    assert.equal(second.terminalOutcome, 'succeeded');
    assert.equal(second.goalOutcome, 'satisfied');
    assert.equal(mutatingSettlementsFor(followUp.id, 'review'), 0, 'the landed write was not repeated');
  } finally {
    runner._setWorkflowHarnessLoopImplsForTests();
  }
});

test('FRAMEWORK-TEST-landed-review-idle: a continued step that finds nothing more to change completes instead of blocking', async () => {
  installQuietReportSeams();
  stubModelStep((attempt) => attempt === 1
    ? {
        calls: [{ tool: 'framework_test_tracker_update', mutating: true, result: { ok: true, data: { id: 'row-9' } } }],
        output: { url: 'https://tracker.example.test/sheet', leads: 1 },
      }
    : { calls: [], output: { url: 'https://tracker.example.test/sheet', leads: 0, note: 'nothing more to change' } });
  stubReviewerGapThenMet('The seven-day re-check was not evidenced.');
  const persisted = workflowStore.writeWorkflow('FRAMEWORK-TEST-landed-review-idle', modelWriteWorkflow('FRAMEWORK-TEST-landed-review-idle'));
  const queued = workflowQueue.queueWorkflowRun(persisted.data.name, {}, {
    source: 'schedule',
    workflowSlug: persisted.name,
    triggerReceiptId: `workflow-schedule:v1:${persisted.name}:1790040000000`,
    dedupe: false,
  });
  assert.equal(queued.status, 'queued', queued.message);
  try {
    await runner.processWorkflowRuns({} as never);
    const followUp = queuedRunsFor(persisted.data.name).find((record) => record.id !== queued.id);
    assert.ok(followUp, 'a follow-up was queued');
    await runner.processWorkflowRuns({} as never);
    const second = readRun(followUp!.id);
    assert.equal(second.status, 'completed', JSON.stringify({ blockedSteps: second.blockedSteps, error: second.error }));
    assert.notEqual(second.needsAttention, true);
    assert.equal(second.terminalOutcome, 'succeeded');
  } finally {
    runner._setWorkflowHarnessLoopImplsForTests();
  }
});
