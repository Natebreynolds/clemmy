#!/usr/bin/env node

/**
 * Exercise a freshly npm-installed candidate against the already-migrated
 * v3.14 home. This driver deliberately contains no Clementine source imports:
 * every product module is loaded by absolute URL from the installed package.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'CLEMENTINE_V314_PACKAGED_EXERCISE=';
const CAPABILITY_ACQUISITION_MISSING_DETAILS = new Set([
  'no live-read carrier adapters are configured',
  'no current attested read capability matched the objective',
]);
const installedRoot = path.resolve(process.argv[2] ?? '');
const home = path.resolve(process.argv[3] ?? '');
if (!installedRoot || !home) throw new Error('usage: rehearse-v314-packaged-exercise.mjs <installed-root> <home>');
if (!existsSync(path.join(installedRoot, 'dist', 'index.js')) || existsSync(path.join(installedRoot, 'src'))) {
  throw new Error('exercise requires a real installed package with dist and without source');
}

const requests = [];
const reply = JSON.stringify({
  summary: 'The installed candidate completed the packaged upgrade exercise.',
  reply: 'The preserved workflow and the new cold turn both completed.',
  done: true,
  nextAction: 'completed',
  reason: null,
});
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  requests.push({
    model: typeof body.model === 'string' ? body.model : null,
    stream: body.stream === true,
    bodySha256: createHash('sha256').update(raw).digest('hex'),
  });
  const id = `upgrade-${requests.length}`;
  if (body.stream === true) {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'upgrade-fixture-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'upgrade-fixture-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    })}\n\n`);
    response.end('data: [DONE]\n\n');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    id,
    object: 'chat.completion',
    created: 1,
    model: 'upgrade-fixture-model',
    choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  }));
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture model did not bind a TCP port');
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    CLEMENTINE_HOME: home,
    CLEMMY_TEST_ISOLATED_HOME: '1',
    CLEMMY_TEST_DISABLE_LIVE_MODELS: '0',
    CLEMMY_AUTHORITY_SEAL_KEY: 'ab'.repeat(32),
    CLEMMY_LOCAL_EMBEDDINGS: 'off',
    CLEMMY_TURN_ENGINE: 'host_v1',
    CLEMMY_HARNESS_BACKGROUND: 'on',
    CLEMMY_HARNESS_CRON: 'off',
    CLEMMY_MCP_PREWARM: 'off',
    CLEMMY_BOOT_WARMUP: 'off',
    CLEMMY_CLI_DISCOVERY_WARMUP: 'off',
    MCP_AUTO_IMPORT_ENABLED: 'false',
    OPENAI_AGENTS_DISABLE_TRACING: '1',
    AUTH_MODE: 'api_key',
    MODEL_ROUTING_MODE: 'all_in',
    BYO_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    BYO_MODEL_API_KEY: 'packaged-upgrade-fixture-key',
    BYO_MODEL_ID: 'upgrade-fixture-model',
    BYO_MODEL_PROVIDER: 'packaged-upgrade-fixture',
    WEBHOOK_ENABLED: 'false',
    DISCORD_ENABLED: 'false',
    SLACK_ENABLED: 'false',
    CLEMENTINE_MOBILE_APP_LISTENER: 'off',
  });

  const load = async (relative) => {
    const file = path.resolve(installedRoot, 'dist', relative);
    const rel = path.relative(installedRoot, file);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !existsSync(file)) {
      throw new Error(`installed product module is absent or escaped: ${relative}`);
    }
    return import(pathToFileURL(file).href);
  };

  const eventlog = await load('runtime/harness/eventlog.js');
  const workflows = await load('memory/workflow-store.js');
  const spaces = await load('spaces/store.js');
  const cli = await load('cli/harness.js');
  const queue = await load('tools/workflow-run-queue.js');
  const shared = await load('tools/shared.js');
  const runner = await load('execution/workflow-runner.js');
  const daemonRunner = await load('daemon/runner.js');
  const assistantModule = await load('assistant/core.js');
  const runtimeFactory = await load('runtime/factory.js');
  const opportunityStore = await load('execution/automation-opportunity-store.js');
  const opportunityReview = await load('execution/automation-opportunity-review-control-plane.js');
  const pilotConvergence = await load('execution/automation-pilot-production-convergence.js');
  const pilotAdvancement = await load('execution/automation-pilot-advancement-control-plane.js');
  const approvals = await load('runtime/harness/approval-registry.js');
  const triggerEngine = await load('execution/workflow-trigger-engine.js');

  const oldSessionId = 'upgrade-rehearsal-chat-v314';
  const oldWorkflowName = 'upgrade-rehearsal-workflow';
  const oldSpaceId = 'upgrade-rehearsal-space';
  const oldSession = eventlog.getSession(oldSessionId);
  assert.equal(oldSession?.status, 'completed');
  assert.ok(eventlog.listEvents(oldSessionId).some((event) => event.type === 'conversation_step'));
  const oldSpace = spaces.spaceStore.get(oldSpaceId);
  assert.equal(oldSpace?.id, oldSpaceId);
  assert.equal(oldSpace?.contract?.objective, 'Keep this visual surface and its dataset intact.');
  const oldWorkflow = workflows.readWorkflow(oldWorkflowName);
  assert.ok(oldWorkflow, 'v3.14 workflow is readable through the installed candidate');
  assert.equal(oldWorkflow.data.enabled, false, 'crash fixture is intentionally disabled before boot');

  const sessionsBefore = new Set(eventlog.listSessions({ limit: 10_000 }).map((session) => session.id));
  const cliExit = await cli.runHarnessCli([
    'run',
    'Reply once to prove a new cold foreground turn works after the v3.14 upgrade.',
    '--max-turns',
    '2',
    '--max-steps',
    '4',
  ]);
  assert.equal(cliExit, 0, 'installed host_v1 CLI cold turn must complete');
  const coldSession = eventlog.listSessions({ limit: 10_000 })
    .find((session) => !sessionsBefore.has(session.id));
  assert.ok(coldSession, 'cold turn created one durable session');
  const coldEvents = eventlog.listEvents(coldSession.id);
  const coldSource = coldEvents.find((event) => event.type === 'user_input_received');
  const coldTerminal = coldEvents.find((event) => event.type === 'conversation_completed');
  assert.ok(coldSource && coldTerminal, 'cold turn persisted accepted input and terminal');

  workflows.writeWorkflow(oldWorkflowName, {
    ...oldWorkflow.data,
    enabled: true,
    trigger: { manual: true },
    description: 'The migrated v3.14 workflow, explicitly re-enabled by the packaged exercise.',
  });
  triggerEngine.syncWorkflowTriggerRegistry();
  const queued = queue.queueWorkflowRun(oldWorkflowName, { fixtureId: 'fixture-item-v314' }, {
    source: 'packaged_upgrade_rehearsal',
  });
  assert.ok(queued.id, JSON.stringify(queued));
  const assistant = new assistantModule.ClementineAssistant(runtimeFactory.createRuntimeFromConfig());
  await runner.processWorkflowRuns(assistant);
  const workflowRunPath = path.join(shared.WORKFLOW_RUNS_DIR, `${queued.id}.json`);
  const workflowRun = JSON.parse(readFileSync(workflowRunPath, 'utf8'));
  assert.equal(workflowRun.status, 'completed', JSON.stringify(workflowRun));

  const opportunity = {
    version: 1,
    title: 'Packaged upgrade durable project',
    objective: 'Retain one newly approved bounded read project after upgrading from v3.14.',
    rationale: 'The upgrade gate must prove new durable authority can be written after migration.',
    lifetime: { kind: 'single_run' },
    recurrence: { mode: 'none' },
    trigger: { kind: 'manual' },
    partition: {
      mode: 'single',
      checkpointEvery: 1,
      completion: { kind: 'terminal_evidence', evidence: ['One bounded result is present.'] },
    },
    capabilityRequirements: [{
      id: 'bounded-read',
      description: 'retrieve one bounded upgrade fixture value',
      minimumEffect: 'read',
      constraints: ['Return one bounded result.'],
    }],
    phases: [{
      id: 'read-result',
      objective: 'Retrieve one bounded upgrade fixture value.',
      dependsOn: [],
      capabilityRequirementIds: ['bounded-read'],
      effect: { class: 'read', approval: 'not_required', maxOperationsPerRun: 1 },
      partitioned: false,
      outputEvidence: ['The records collection is non-empty.'],
    }],
    effectCeiling: { class: 'read', maxOperationsPerRun: 1 },
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
  };
  const proposalId = 'packaged-upgrade-project-v1';
  const created = opportunityStore.createAutomationOpportunityProposal({
    proposalId,
    opportunity,
    actorRef: `accepted-source:${coldSession.id}#${coldSource.seq}`,
    note: 'Created by the installed packaged-upgrade exercise.',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const registered = opportunityReview.registerAutomationOpportunityReviewProjection({
    proposalId,
    expectedProposalRevision: created.record.revision,
    expectedProposalDigest: created.record.digest,
    approvalSessionId: coldSession.id,
    requestSourceUserSeq: coldSource.seq,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  approvals.resolve(registered.approval.approvalId, 'approved', 'human.packaged-upgrade');
  const reconciled = opportunityReview.reconcileAutomationOpportunityReviewProjection(
    registered.projection.projectionId,
  );
  assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
  assert.ok(reconciled.state === 'approved' || reconciled.state === 'already_approved', JSON.stringify(reconciled));
  const approved = opportunityStore.loadAutomationOpportunityProposal(proposalId);
  assert.equal(approved?.status, 'approved');
  assert.equal(approved?.revision, 3);
  const firstConvergence = await pilotConvergence.reconcileAutomationPilotProductionConvergence();
  assert.equal(firstConvergence.failures, 0, JSON.stringify(firstConvergence));
  const firstAdvancements = pilotAdvancement.listAutomationPilotAdvancements({ limit: 100 })
    .filter((row) => row.proposalId === proposalId);
  assert.equal(firstAdvancements.length, 1, JSON.stringify(firstAdvancements));
  const advancement = firstAdvancements[0];
  assert.equal(advancement.stage, 'blocked', JSON.stringify(advancement));
  assert.equal(advancement.blocked?.code, 'capability_acquisition_missing', JSON.stringify(advancement));
  assert.equal(
    CAPABILITY_ACQUISITION_MISSING_DETAILS.has(advancement.blocked?.detail ?? ''),
    true,
    JSON.stringify(advancement),
  );
  assert.equal(advancement.reviewProjectionId, registered.projection.projectionId);
  assert.equal(advancement.reviewApprovalId, registered.approval.approvalId);
  assert.equal(advancement.proposalRevision, approved.revision);
  assert.equal(advancement.proposalDigest, approved.digest);
  assert.equal(advancement.ownerSessionId, coldSession.id);
  assert.equal(advancement.sourceUserSeq, coldSource.seq);
  const secondConvergence = await pilotConvergence.reconcileAutomationPilotProductionConvergence();
  assert.equal(secondConvergence.failures, 0, JSON.stringify(secondConvergence));
  const stableAdvancement = pilotAdvancement.loadAutomationPilotAdvancement(advancement.advancementId);
  assert.deepEqual(stableAdvancement, advancement, 'a second production convergence pass must be an exact fixed point');
  const stableReview = opportunityReview.loadAutomationOpportunityReviewProjection(
    registered.projection.projectionId,
  );
  assert.equal(stableReview?.status, 'approved');
  assert.equal(stableReview?.proposalDigest, approved.digest);
  const stableProposal = opportunityStore.loadAutomationOpportunityProposal(proposalId);
  assert.equal(stableProposal?.status, 'approved');
  assert.equal(stableProposal?.revision, 3);
  assert.equal(stableProposal?.digest, approved.digest);

  // The packaged daemon owns notification delivery on an independent cadence.
  // Settle the exercise's new workflow-completion notification explicitly so
  // the post-exercise snapshot is already the same durable retry fixed point
  // that the second daemon boot must reopen. A second direct production pass
  // must be byte-idempotent; no delivery bytes are normalized away.
  const notificationFiles = [
    path.join(home, 'state', 'notifications.json'),
    path.join(home, 'state', 'notification-delivery-queue.json'),
  ];
  const notificationState = () => notificationFiles.map((file) =>
    existsSync(file) ? readFileSync(file) : Buffer.alloc(0));
  await daemonRunner.processNotificationDeliveries(assistant);
  const firstNotificationState = notificationState();
  await daemonRunner.processNotificationDeliveries(assistant);
  const secondNotificationState = notificationState();
  assert.equal(
    Buffer.compare(firstNotificationState[0], secondNotificationState[0]),
    0,
    'a second production notification pass must not rewrite settled notification bytes',
  );
  assert.equal(
    Buffer.compare(firstNotificationState[1], secondNotificationState[1]),
    0,
    'a second production notification pass must not rewrite settled queue bytes',
  );
  const notificationDeliveryDigest = createHash('sha256')
    .update(firstNotificationState[0])
    .update(firstNotificationState[1])
    .digest('hex');
  const notificationDeliveryQueueLength = (() => {
    const parsed = JSON.parse(firstNotificationState[1].toString('utf8') || '[]');
    return Array.isArray(parsed) ? parsed.length : -1;
  })();

  process.stdout.write(`${MARKER}${JSON.stringify({
    version: 1,
    installedRoot,
    oldSessionId,
    oldWorkflowName,
    oldSpaceId,
    coldSessionId: coldSession.id,
    coldSourceUserSeq: coldSource.seq,
    coldTerminalSeq: coldTerminal.seq,
    workflowRunId: queued.id,
    workflowRunStatus: workflowRun.status,
    proposalId,
    proposalRevision: approved.revision,
    proposalDigest: approved.digest,
    reviewProjectionId: registered.projection.projectionId,
    reviewApprovalId: registered.approval.approvalId,
    advancementId: advancement.advancementId,
    advancementStage: advancement.stage,
    advancementStateRevision: advancement.stateRevision,
    advancementStateDigest: advancement.stateDigest,
    advancementBlockedCode: advancement.blocked.code,
    advancementBlockedDetail: advancement.blocked.detail,
    firstConvergence,
    secondConvergence,
    notificationDeliveryDigest,
    notificationDeliveryQueueLength,
    modelRequests: requests,
  })}\n`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
