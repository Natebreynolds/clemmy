import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

/**
 * Tests for usesSkill injection on workflow steps.
 *
 * Why this matters: usesSkill is the composable-expertise primitive —
 * a step says "use the seo-audit skill", the runner pulls the skill's
 * SKILL.md body and prepends it to the step prompt at execution time.
 * The injection has to (a) preserve the rendered prompt downstream,
 * (b) fail gracefully when a skill is missing rather than silently
 * dropping context.
 *
 * Skills live under BASE_DIR (from config). We can't easily redirect
 * the skill-store at runtime, so the test creates a real skill in the
 * runtime BASE_DIR and cleans up after — keeps the assertion honest
 * against the same skill-loader the runner uses in production.
 */

// Set BASE_DIR to a temp dir BEFORE importing modules that resolve it.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'clementine-runner-test-'));
process.env.CLEMENTINE_HOME = tmp;
process.env.CLEMENTINE_WORKFLOW_CONCURRENCY = '5';
process.env.CLEMENTINE_WORKFLOW_HARNESS_POLL_MS = '20';

const skillsDir = path.join(tmp, 'skills');
mkdirSync(path.join(skillsDir, 'test-skill'), { recursive: true });
writeFileSync(
  path.join(skillsDir, 'test-skill', 'SKILL.md'),
  '---\nname: test-skill\ndescription: Sample skill for runner tests\n---\n\n# Test Skill Instructions\n\nDo the thing carefully.',
  'utf-8',
);

// Imports MUST come after the env var + file setup, since skill-store
// resolves BASE_DIR at module load.
const {
  applySkillToPrompt,
  planWorkflowExecutionBatches,
  planBlockedDependencySkips,
  callToolSideEffectClass,
  runDeterministicWorkflowStepForTest,
  DeterministicWorkflowStepError,
  workflowRunnerInternalsForTest,
  explainDeterministicSpawnError,
  reapResolvedParkedRuns,
  executeStep,
  findContractViolationStep,
  tightenWorkflowContractsFromCleanRun,
  describeStepNonCompletion,
  processWorkflowRuns,
  workflowAdvisoryRequiresAttention,
  workflowReportLaneForOutcome,
  enqueueWorkflowOutcomeTurn,
  shouldNotifyCancelledRun,
  coerceOutputForContract,
  applyContractToPrompt,
  describeOutputShape,
  isTransientStepError,
  runWithStepRetry,
  creationTestVerdict,
  shouldHaltResumeForSideEffect,
  hostStepMutationProof,
  stepSideEffectClass,
  isPhantomStepCompletion,
  phantomBlockedOutput,
  settlementGuardedStepOutput,
  decideBatchSettlement,
  ParkRunSignal,
  finalizeStepOutput,
  forEachItemOutputContract,
  forEachAggregateOutputContract,
  verifyForEachItemOutput,
  inferredOutputContractAdvisory,
  sendAlreadyClaimed,
  stepExternalWriteAlreadyClaimed,
  stepSendAlreadyFired,
  omitBlocksForAlreadyFiredSends,
  seedFailedItemRetryRun,
  detectEmptyDeliverableReads,
  stepConsumesOutput,
  summarizeRunArtifacts,
  looksLikeWorkflowStepStructuralResultMiss,
  WorkflowStepStructuralResultError,
  isWorkflowStepStructuralResultError,
  isWorkflowStepBrainFalloverEligible,
  _setWorkflowHarnessLoopImplsForTests,
  _setWorkflowVoiceRewriteForTests,
  _setWorkflowCallNodeForTests,
  _setBeforeWorkflowCallGatewayForTests,
  publishWorkflowRunTerminalForTest,
  emitParkedApprovalCardToOriginChat,
  resolveWorkflowDefinitionForRun,
  WorkflowWatcherMailbox,
  WorkflowCapabilityBlockedError,
  WorkflowContractViolationError,
  WorkflowHarnessBlockedSignal,
  workflowCapabilityBlockIsRecoverable,
  workflowCapabilityRetryDelayMs,
  reapCapabilityBlockedRuns,
  resumeCapabilityBlockedWorkflowRun,
  resolveWorkflowCapabilityAccountChoice,
  latestWorkflowNotifyUserPresentation,
  mergeWorkflowPresentationContribution,
  scrubWorkflowTerminalPresentation,
} = await import('./workflow-runner.js');
// The workflow watcher would otherwise place a REAL judge call from any
// multi-step test run (live OAuth tokens make the judge reachable on dev
// machines). Silent-on-track stub = the byte-identical no-steer path.
const { _setWorkflowWatcherForTests } = await import('./workflow-runner.js');
_setWorkflowWatcherForTests(async () => ({ onTrack: true, miss: '', steer: '' }));
const { validateWorkflowDefinition } = await import('./workflow-validator.js');

// ─── Re-hunt Lane 4 regression (2026-07-09) ───────────────────────
// The RUNTIME call-node classifier must agree with the validator (both route
// through isIrreversibleSendSlug). The old regex called VAPI_CREATE_CALL /
// TWILIO_MAKE_OUTBOUND_CALL / RESPOND_TO_EVENT 'write'/'read', so the
// unattended-scheduled auto-approve carve-out fired them with no consent.
test('callToolSideEffectClass: telephony + comm-object dispatches are SEND (validator/runtime agree)', () => {
  for (const t of ['VAPI_CREATE_CALL', 'TWILIO_MAKE_OUTBOUND_CALL', 'ELEVENLABS_MAKE_OUTBOUND_CALL', 'make_outbound_call', 'GOOGLECALENDAR_RESPOND_TO_EVENT', 'GMAIL_SEND_EMAIL', 'DISCORD_CREATE_MESSAGE', 'outlook_send_draft', 'outlook_forward_mail']) {
    assert.equal(callToolSideEffectClass(t), 'send', `${t} must classify as send at runtime`);
  }
  // Reversible writes stay 'write'; call-reads stay 'read'; no over-gating.
  assert.equal(callToolSideEffectClass('GOOGLESHEETS_CREATE_SPREADSHEET'), 'write');
  assert.equal(callToolSideEffectClass('OUTLOOK_CREATE_DRAFT'), 'write');
  assert.equal(callToolSideEffectClass('VAPI_GET_CALL'), 'read');
  assert.equal(callToolSideEffectClass('TWILIO_LIST_CALLS'), 'read');
});

test('exact notify_user presentation is deterministic, bounded, redacted, and drops a receipt-only wrapper', () => {
  const body = `Authored result is ready. api_key=do-not-publish-this-value ${'x'.repeat(2_000)}`;
  const publicBody = latestWorkflowNotifyUserPresentation({
    runId: 'run-notify-public-projection',
    notifications: [{
      id: 'notify-public-projection',
      kind: 'workflow',
      title: 'Result',
      body,
      createdAt: '2026-08-03T12:00:00.000Z',
      read: false,
      silent: true,
      metadata: {
        source: 'notify_user_tool',
        workflowRunId: 'run-notify-public-projection',
        exactOriginTerminalAuthority: true,
      },
    }],
  });
  assert.ok(publicBody);
  assert.match(publicBody, /Authored result is ready/);
  assert.match(publicBody, /api_key=\[REDACTED\]/);
  assert.doesNotMatch(publicBody, /do-not-publish-this-value/);
  assert.ok(publicBody.length <= 1_800);
  assert.equal(
    mergeWorkflowPresentationContribution(
      publicBody,
      'Notification queued: 1800000000000-tool-notify',
      ['1800000000000-tool-notify'],
    ),
    publicBody,
    'the local queue receipt is execution evidence, not user-facing result prose',
  );
});

test('derived workflow terminal presentation scrubs credential assignments before publication', () => {
  const bearer = 'Bearer eyJhbGciOiJIUzI1NiJ9.private-terminal-secret';
  const derived = [
    'Provider readback succeeded.',
    `Authorization: ${bearer}`,
    'refresh_token=terminal-refresh-secret',
  ].join('\n');
  const publicBody = scrubWorkflowTerminalPresentation(derived);
  assert.match(publicBody, /Provider readback succeeded/);
  assert.match(publicBody, /Authorization: \[REDACTED\]/);
  assert.match(publicBody, /refresh_token=\[REDACTED\]/);
  assert.doesNotMatch(publicBody, /private-terminal-secret|terminal-refresh-secret/);
  assert.equal(
    mergeWorkflowPresentationContribution(null, derived),
    publicBody,
    'the derived-only exact terminal uses the same scrubbed public projection',
  );
});

test('blocked workflow nodes propagate through dependents without cancelling independent branches', () => {
  const steps = [
    { id: 'fetch', prompt: 'fetch' },
    { id: 'tracker', prompt: 'tracker', dependsOn: ['fetch'] },
    { id: 'contact', prompt: 'contact', dependsOn: ['fetch', 'tracker'] },
    { id: 'write', prompt: 'write', dependsOn: ['contact'] },
    { id: 'independent', prompt: 'independent' },
  ];
  const skips = planBlockedDependencySkips(steps, {
    fetch: { accounts: [{ id: 'a' }] },
    tracker: { blocked: true, reason: 'Google Sheets auth expired' },
  });

  assert.deepEqual(skips.map((skip) => skip.stepId), ['contact', 'write']);
  assert.deepEqual(skips[0].blockedBy, ['tracker']);
  assert.deepEqual(skips[1].blockedBy, ['contact']);
  assert.match(skips[0].output.reason, /Google Sheets auth expired/);
  assert.equal(skips.some((skip) => skip.stepId === 'independent'), false);
});
const { SessionStore: RunnerSessionStore } = await import('../memory/session-store.js');
const {
  readWorkflowEvents,
  appendWorkflowEvent,
  appendWorkflowEventDurably,
  computeResumeState,
} = await import('./workflow-events.js');
const {
  readStepOutputArtifact,
  recordItemOutput,
  recordStepOutput,
  runWorkspaceDir,
} = await import('./workflow-run-workspace.js');
const { clearStepWatermark, readSeenItemKeys } = await import('./workflow-watermark-store.js');
const { HarnessSession } = await import('../runtime/harness/session.js');
const {
  resetEventLog,
  listEvents,
  appendEvent,
  appendAsyncWorkDispatchBatchClosedOnce,
  getLatestRunAttempt,
  isKillRequested,
} = await import('../runtime/harness/eventlog.js');
const workflowSettlementIdentities = await import('../runtime/harness/attempt-identity.js');
const workflowSettlementDispatch = await import('../runtime/harness/dispatch-ledger.js');
const workflowSettlementOutcomes = await import('../runtime/harness/attempt-outcome.js');
const workflowSettlements = await import('../runtime/harness/logical-call-settlement-store.js');
const workflowSettlementShadow = await import('../runtime/graph/turn-graph-shadow.js');
const workflowSemanticDisposition = await import('../runtime/semantic-boundary/semantic-disposition.js');
const { resetHarnessRuntimeConfig } = await import('../runtime/harness/codex-client.js');
const { setClaudeAgentSdkWorkflowStepRunForTest } = await import('../runtime/harness/claude-agent-workflow-step.js');
const { ClaudeAgentSdkApprovalBoundaryError } = await import('../runtime/harness/claude-agent-sdk.js');
const { AgentRuntimeCancelledError } = await import('../runtime/provider.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const workflowNotifications = await import('../runtime/notifications.js');
const runEvents = await import('../runtime/run-events.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { readWorkflowRunRecord } = await import('./workflow-run-record.js');
const {
  createWorkflowRunDefinitionSnapshot,
  workflowDefinitionHash,
} = await import('./workflow-run-definition.js');
const { workflowCapabilityAccountChoiceSet } = await import('./workflow-live-call-compiler.js');
const {
  queueCompiledWorkflowRun,
  queueWorkflowRun,
  createWorkflowChatDispatchPreparedReceipt,
  createWorkflowOriginGroupCloseAuthority,
  createWorkflowOriginGroupClosedBatchReceipt,
  finalizeWorkflowOriginGroupClosedBatch,
  recordWorkflowChatDispatchPreparation,
  recordWorkflowOriginGroupClosedBatch,
} = await import('../tools/workflow-run-queue.js');
const {
  compileWorkflowStepsToGraph,
  WORKFLOW_GRAPH_ALLOWED_TOOLS,
} = await import('./workflow-graph.js');
const { persistWorkflowGraphSnapshot } = await import('./workflow-graph-store.js');
const { ExecutionStore } = await import('./store.js');
const { compileProjectPlan } = await import('./project-compiler.js');
const { PROJECT_STRUCTURAL_TOOLS } = await import('./project-plan-ir.js');

test('run definition resolution pins admitted steps across later workflow edits and fails closed on corruption', () => {
  const admitted = {
    name: 'Pinned workflow',
    description: 'Pinned definition test.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'work', prompt: 'Original admitted instruction.', sideEffect: 'read' as const }],
  };
  const snapshot = createWorkflowRunDefinitionSnapshot(
    'pinned-workflow',
    admitted,
    '2026-07-26T12:00:00.000Z',
  );
  const current = {
    name: 'pinned-workflow',
    data: {
      ...admitted,
      steps: [{ id: 'work', prompt: 'Edited after queueing.', sideEffect: 'read' as const }],
    },
  };

  const pinned = resolveWorkflowDefinitionForRun(
    { workflow: admitted.name, workflowDefinitionSnapshot: snapshot },
    [current] as never,
  );
  assert.equal(pinned.ok, true);
  assert.equal(pinned.definitionSource, 'snapshot');
  assert.equal(pinned.workflow?.data.steps[0].prompt, 'Original admitted instruction.');
  assert.equal(pinned.currentWorkflow?.data.steps[0].prompt, 'Edited after queueing.');

  const legacy = resolveWorkflowDefinitionForRun(
    { workflow: admitted.name },
    [current] as never,
  );
  assert.equal(legacy.ok, true);
  assert.equal(legacy.definitionSource, 'legacy_current');
  assert.equal(legacy.workflow?.data.steps[0].prompt, 'Edited after queueing.');

  const corrupt = structuredClone(snapshot);
  corrupt.definition.steps[0].prompt = 'Tampered.';
  const rejected = resolveWorkflowDefinitionForRun(
    { workflow: admitted.name, workflowDefinitionSnapshot: corrupt },
    [current] as never,
  );
  assert.equal(rejected.ok, false);
  assert.match(rejected.error ?? '', /snapshot is invalid|content does not match/i);
});

test('reserved project lineage never falls through a missing snapshot into a catalog collision', () => {
  const catalog = [{
    name: 'platform-49',
    data: {
      name: 'platform-49',
      enabled: true,
      trigger: { manual: true },
      steps: [{ id: 'must_not_run', prompt: 'This catalog step must never run for project lineage.' }],
    },
  }] as never;
  const base = { workflow: 'platform-49', inputs: {} };

  for (const workflowDefinitionSnapshot of [undefined, null, 'wrong-type', 42]) {
    const rejected = resolveWorkflowDefinitionForRun({
      ...base,
      source: 'project_graph',
      workflowDefinitionSnapshot,
    } as never, catalog);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.definitionSource, 'compiled_snapshot');
    assert.equal(rejected.workflow, undefined);
    assert.match(rejected.error ?? '', /No workflow step was executed/i);
  }

  for (const marker of [
    { source: 'project_graph' },
    { sourceExecutionId: 'exec-project-pre-cut' },
    { compiledContractHash: 'a'.repeat(64) },
    { triggerReceiptId: `project-turn:v1:${'b'.repeat(64)}` },
    { workflowSlug: `compiled-${'c'.repeat(32)}` },
  ]) {
    const rejected = resolveWorkflowDefinitionForRun({ ...base, ...marker } as never, catalog);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.definitionSource, 'compiled_snapshot');
    assert.equal(rejected.workflow, undefined);
  }

  let poisonedCatalogLookups = 0;
  const poisonedCatalog = [] as unknown as typeof catalog;
  Object.defineProperty(poisonedCatalog, 'find', {
    value: () => {
      poisonedCatalogLookups += 1;
      throw new Error('reserved lineage reached catalog lookup');
    },
  });
  for (const marker of [
    { sourceExecutionId: null },
    { sourceExecutionId: '' },
    { compiledContractHash: null },
    { compiledContractHash: '' },
    { projectBoundAt: null },
    { projectExecutionSettlement: null },
  ]) {
    const rejected = resolveWorkflowDefinitionForRun({ ...base, ...marker } as never, poisonedCatalog);
    assert.equal(rejected.ok, false, JSON.stringify(marker));
    assert.equal(rejected.definitionSource, 'compiled_snapshot', JSON.stringify(marker));
    assert.equal(rejected.workflow, undefined, JSON.stringify(marker));
  }
  assert.equal(poisonedCatalogLookups, 0, 'presence-only reserved lineage fails before catalog lookup');

  const invalidReservedSnapshot = resolveWorkflowDefinitionForRun({
    ...base,
    projectBoundAt: '',
    workflowDefinitionSnapshot: { version: 1, definitionHash: 'malformed' },
  } as never, poisonedCatalog);
  assert.equal(invalidReservedSnapshot.ok, false);
  assert.equal(invalidReservedSnapshot.definitionSource, 'compiled_snapshot');
  assert.match(invalidReservedSnapshot.error ?? '', /snapshot is invalid.*No workflow step was executed/is);
  assert.equal(poisonedCatalogLookups, 0, 'invalid reserved snapshots retain compiled classification before lookup');

  const genuineLegacy = resolveWorkflowDefinitionForRun(base, catalog);
  assert.equal(genuineLegacy.ok, true);
  assert.equal(genuineLegacy.definitionSource, 'legacy_current');
  assert.equal(genuineLegacy.workflow?.data.steps[0]?.id, 'must_not_run');

  const ordinaryCompiledPrefix = {
    name: 'compiled-existing',
    data: {
      name: 'Compiled Existing',
      enabled: true,
      trigger: { manual: true },
      steps: [{ id: 'ordinary_step', prompt: 'Run this ordinary catalog workflow.' }],
    },
  };
  const ordinarySnapshot = createWorkflowRunDefinitionSnapshot(
    ordinaryCompiledPrefix.name,
    ordinaryCompiledPrefix.data,
    '2026-08-02T12:30:00.000Z',
  );
  const ordinaryResolved = resolveWorkflowDefinitionForRun({
    workflow: ordinaryCompiledPrefix.data.name,
    workflowSlug: ordinaryCompiledPrefix.name,
    workflowDefinitionSnapshot: ordinarySnapshot,
  } as never, [ordinaryCompiledPrefix] as never);
  assert.equal(ordinaryResolved.ok, true);
  assert.equal(ordinaryResolved.definitionSource, 'snapshot');
  assert.equal(ordinaryResolved.workflow?.data.steps[0]?.id, 'ordinary_step');
});

test('run definition resolution fails closed when authored code changes after admission', () => {
  const slug = `pinned-code-${Date.now()}`;
  const scriptsDir = path.join(tmp, 'vault', '00-System', 'workflows', slug, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  const runner = path.join(scriptsDir, 'transform.mjs');
  writeFileSync(runner, 'process.stdout.write(JSON.stringify({ revision: 1 }));\n', 'utf-8');
  const admitted = {
    name: 'Pinned code workflow',
    description: 'Pin exact authored code.',
    enabled: true,
    trigger: { manual: true },
    steps: [{
      id: 'transform',
      prompt: 'Transform deterministically.',
      sideEffect: 'read' as const,
      deterministic: { runner: 'transform.mjs' },
    }],
  };
  const snapshot = createWorkflowRunDefinitionSnapshot(slug, admitted, '2026-07-26T12:00:00.000Z');
  writeFileSync(runner, 'process.stdout.write(JSON.stringify({ revision: 2 }));\n', 'utf-8');

  const rejected = resolveWorkflowDefinitionForRun(
    { workflow: admitted.name, workflowDefinitionSnapshot: snapshot },
    [{ name: slug, data: admitted }] as never,
  );
  assert.equal(rejected.ok, false);
  assert.match(rejected.error ?? '', /code changed after this run was admitted/i);
});

test('run definition resolution admits only a catalogless compiled project root', () => {
  const plan = {
    planId: 'one-off-compiled-project',
    objective: 'Execute the immutable project graph.',
    nodes: [{
      id: 'work',
      executor: {
        kind: 'model' as const,
        instruction: 'Perform bounded read-only work.',
        allowedTools: ['workspace_artifact_query'],
      },
      effect: 'read' as const,
      maxTurns: 8,
    }],
  };
  const compiled = compileProjectPlan(plan);
  const definition = compiled.definition;
  const sessionId = `sess-compiled-project-${Date.now()}`;
  HarnessSession.create({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'Compiled project source' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Build the durable project.', source: 'desktop' },
  });
  new ExecutionStore().createOrGetForSource({
    sessionId,
    sourceUserSeq: source.seq,
    title: 'Compiled project',
    objective: 'Execute a durable project graph.',
    reason: 'Long-horizon accepted source.',
    startedFromMessage: 'Build the durable project.',
    confidence: 0.95,
    reasons: ['durable project'],
    admission: {
      compiledPlan: {
        version: 2,
        compilerId: 'project_graph_v2',
        planHash: compiled.planHash,
        definitionHash: workflowDefinitionHash(definition),
        plan,
        definition,
        inputs: {},
      },
    },
  });
  const queued = queueCompiledWorkflowRun({ sessionId, sourceUserSeq: source.seq });
  assert.equal(queued.status, 'queued');
  const rootRun = JSON.parse(
    readFileSync(path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`), 'utf-8'),
  );
  const workflowSlug = rootRun.workflowSlug as string;

  const resolved = resolveWorkflowDefinitionForRun(rootRun, []);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.definitionSource, 'compiled_snapshot');
  assert.equal(resolved.currentWorkflow, undefined);
  assert.equal(resolved.workflow?.name, workflowSlug);
  assert.equal(resolved.workflow?.data.steps[0].prompt, 'Perform bounded read-only work.');
  const runtimeStep = resolved.workflow!.data.steps[0];
  assert.equal((runtimeStep as { __compiledProjectRuntime?: boolean }).__compiledProjectRuntime, true);
  assert.equal(workflowRunnerInternalsForTest.workflowStepRunMaxTurns(runtimeStep), 8);
  assert.deepEqual(
    workflowRunnerInternalsForTest.workflowAutoApprovalTools(resolved.workflow!.data, runtimeStep),
    [...PROJECT_STRUCTURAL_TOOLS],
  );
  assert.equal(
    workflowRunnerInternalsForTest.workflowStepRunMaxTurns({ ...runtimeStep, __compiledProjectRuntime: undefined } as never),
    undefined,
    'ordinary catalog steps keep their legacy run budget behavior',
  );

  for (const status of ['running', 'finalizing'] as const) {
    assert.equal(resolveWorkflowDefinitionForRun({ ...rootRun, status }, []).ok, true);
  }

  const collision = resolveWorkflowDefinitionForRun(rootRun, [{
    name: workflowSlug,
    data: { ...definition, name: 'Catalog collision' },
  }] as never);
  assert.equal(collision.ok, false);
  assert.match(collision.error ?? '', /catalogless root-run contract/i);

  for (const invalid of [
    { ...rootRun, source: 'workflow_run' },
    { ...rootRun, status: 'dry_run' },
    { ...rootRun, id: 'forged-run' },
    { ...rootRun, triggerReceiptId: 'project-turn:v2:wrong' },
    { ...rootRun, compiledContractHash: '0'.repeat(64) },
    { ...rootRun, sourceUserSeq: source.seq + 1 },
    { ...rootRun, targetStepId: 'work' },
    { ...rootRun, requeuedFromRunId: 'older-run' },
    { ...rootRun, originSessionId: '' },
  ]) {
    const rejected = resolveWorkflowDefinitionForRun(invalid, []);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? '', /catalogless root-run contract/i);
  }

  const stableTopLevelJson = (value: Record<string, unknown>) => JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ));
  const oldInputsHash = createHash('sha256')
    .update(stableTopLevelJson(rootRun.inputs as Record<string, unknown>))
    .digest('hex');
  const oldDomainContractHash = createHash('sha256').update(stableTopLevelJson({
    version: 'compiled-project-run:v1',
    sourceExecutionId: rootRun.sourceExecutionId,
    sourceUserSeq: rootRun.sourceUserSeq,
    sourceTurnKeyHash: rootRun.workflowDefinitionSnapshot.sourceTurnKeyHash,
    originSessionId: rootRun.originSessionId,
    workflowSlug: rootRun.workflowSlug,
    definitionHash: rootRun.workflowDefinitionSnapshot.definitionHash,
    admissionHash: rootRun.workflowDefinitionSnapshot.admissionHash,
    normalizedInputsHash: oldInputsHash,
  })).digest('hex');
  const oldContractRejected = resolveWorkflowDefinitionForRun({
    ...rootRun,
    compiledContractHash: oldDomainContractHash,
  }, []);
  assert.equal(oldContractRejected.ok, false);
  assert.match(oldContractRejected.error ?? '', /catalogless root-run contract/i);

  rmSync(path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`), { force: true });
});

test('persisted executionRole is inert until compiled admission authenticates the step', () => {
  const resolve = workflowRunnerInternalsForTest.resolveWorkflowStepModel;
  const roleOf = workflowRunnerInternalsForTest.authenticatedWorkflowExecutionRole;
  const models = { models: { worker: 'worker-pin-model', brain: 'brain-pin-model' } } as never;
  const legacy = {
    id: 'legacy',
    prompt: 'ordinary catalog work',
    intent: 'design',
    executionRole: 'specialist' as const,
  };
  const withoutPersistedHint = { ...legacy, executionRole: undefined };

  assert.equal(roleOf(legacy as never), undefined);
  assert.deepEqual(
    resolve(legacy as never, models),
    resolve(withoutPersistedHint as never, models),
    'an ordinary catalog field cannot silently change its legacy model route',
  );

  const specialist = { ...legacy, __compiledProjectRuntime: true };
  assert.equal(roleOf(specialist as never), 'specialist');
  assert.equal(resolve(specialist as never, models).model, 'worker-pin-model');

  for (const executionRole of ['reducer', 'brain'] as const) {
    const converger = { ...legacy, executionRole, __compiledProjectRuntime: true };
    assert.equal(roleOf(converger as never), executionRole);
    assert.equal(resolve(converger as never, models).model, 'brain-pin-model');
  }

  assert.equal(
    roleOf({ ...legacy, executionRole: undefined, __graphRuntimeRole: 'specialist' } as never),
    'specialist',
    'the existing read_parallel runtime marker retains its authority',
  );
});

test('compiled public sink is selected structurally even without a role and fails closed on ambiguity', () => {
  const sink = workflowRunnerInternalsForTest.uniqueCompiledProjectTerminalSink([
    { id: 'left', prompt: 'left' },
    { id: 'right', prompt: 'right' },
    { id: 'join', prompt: 'join', dependsOn: ['left', 'right'] },
  ] as never);
  assert.equal(sink.id, 'join');
  assert.throws(
    () => workflowRunnerInternalsForTest.uniqueCompiledProjectTerminalSink([
      { id: 'left', prompt: 'left' },
      { id: 'right', prompt: 'right' },
    ] as never),
    /exactly one terminal sink; found 2.*No project output was published/i,
  );
});

test('compiled V3 execution rejects a preexisting additive graph overlay before any unadmitted node can run', async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `sess-compiled-overlay-reject-${stamp}`;
  const plan = {
    planId: `overlay-reject-${createHash('sha256').update(stamp).digest('hex').slice(0, 16)}`,
    objective: 'Execute the immutable project graph.',
    nodes: [{
      id: 'admitted_sink',
      executor: {
        kind: 'model' as const,
        instruction: 'Perform bounded read-only work.',
        allowedTools: ['workspace_artifact_query'],
      },
      effect: 'read' as const,
    }],
  };
  const compiled = compileProjectPlan(plan);
  HarnessSession.create({
    id: sessionId,
    kind: 'chat',
    channel: 'desktop',
    title: 'Compiled overlay rejection source',
  });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Run the exact admitted project.', source: 'desktop' },
  });
  new ExecutionStore().createOrGetForSource({
    sessionId,
    sourceUserSeq: source.seq,
    title: 'Compiled overlay rejection',
    objective: plan.objective,
    reason: 'Exercise immutable compiled graph authority.',
    startedFromMessage: 'Run the exact admitted project.',
    confidence: 0.99,
    reasons: ['compiled overlay rejection'],
    admission: {
      compiledPlan: {
        version: 2,
        compilerId: 'project_graph_v2',
        planHash: compiled.planHash,
        definitionHash: workflowDefinitionHash(compiled.definition),
        plan,
        definition: compiled.definition,
        inputs: {},
      },
    },
  });
  const queued = queueCompiledWorkflowRun({ sessionId, sourceUserSeq: source.seq });
  if (queued.status !== 'queued' || !queued.id) {
    assert.fail(`expected compiled overlay run to queue, got ${queued.status}: ${queued.message}`);
  }
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${queued.id}.json`);
  const admitted = JSON.parse(readFileSync(runFile, 'utf-8')) as Record<string, any>;
  const graph = compileWorkflowStepsToGraph(admitted.workflowDefinitionSnapshot.definition.steps, {
    id: `${admitted.workflowSlug}:${queued.id}`,
    name: admitted.workflow,
  });
  graph.nodes.push({
    id: 'unadmitted_probe',
    type: 'step',
    stepId: 'unadmitted_probe',
    label: 'unadmitted_probe',
    prompt: 'Return UNADMITTED-NODE-RAN.',
    sideEffect: 'read',
    allowedTools: [...WORKFLOW_GRAPH_ALLOWED_TOOLS],
    requiresApproval: false,
    config: {
      runtimeMode: 'additive_read_only_v3',
      toolAuthority: 'result_only',
    },
  });
  graph.edges.push({
    id: 'dependency:admitted_sink->unadmitted_probe',
    source: 'admitted_sink',
    target: 'unadmitted_probe',
    type: 'dependency',
  });
  // The malicious overlay has one structural sink, so a sink-count-only guard
  // would accept it and publish the injected node. Immutable byte authority is
  // what must reject it.
  graph.entryNodeIds = ['admitted_sink'];
  persistWorkflowGraphSnapshot({
    workflowName: admitted.workflowSlug,
    runId: queued.id,
    graph,
  });

  let modelCalls = 0;
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async () => {
      modelCalls += 1;
      throw new Error('UNADMITTED-NODE-RAN');
    }) as never,
  });
  try {
    await processWorkflowRuns({
      respond: async () => {
        modelCalls += 1;
        throw new Error('UNADMITTED-LEGACY-NODE-RAN');
      },
    } as never);
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as Record<string, any>;
  const events = readWorkflowEvents(admitted.workflowSlug, queued.id);
  assert.equal(modelCalls, 0, 'neither admitted nor injected model work starts after authority conflict');
  assert.equal(terminal.status, 'error');
  assert.equal(terminal.output, undefined, 'no public project output is published');
  assert.equal(Object.keys(terminal.stepOutputs ?? {}).length, 0);
  assert.match(terminal.error ?? '', /does not exactly match its admitted V3 definition/i);
  assert.match(terminal.reportBack?.detail ?? '', /no project node was executed and no output was published/i);
  assert.equal(events.some((event) => event.kind === 'step_started'), false);
  assert.equal(events.some((event) => event.kind === 'run_completed'), false);
  assert.equal(
    events.some((event) => event.kind === 'workflow_graph_patch_applied'),
    false,
    'a rejected compiled overlay emits no patch-derived telemetry',
  );
});

test('compiled project winner drains its catalogless V3 model node once and reports back across a restart-style rescan', async () => {
  const { recordStepResult } = await import('../tools/step-result-tool.js');
  const { getPlanScope } = await import('../agents/plan-scope.js');

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `sess-compiled-runner-e2e-${stamp}`;
  const plan = {
    planId: `runner-e2e-${createHash('sha256').update(stamp).digest('hex').slice(0, 16)}`,
    objective: 'Verify and summarize an already-sent message receipt.',
    nodes: [{
      id: 'verify_receipt',
      executor: {
        kind: 'model' as const,
        instruction: 'Verify the supplied receipt and return the durable result.',
        allowedTools: ['workspace_artifact_query'],
      },
      effect: 'read' as const,
      maxTurns: 13,
      evidence: {
        type: 'object' as const,
        requiredKeys: ['sent', 'messageId', 'summary'],
        nonEmpty: ['messageId', 'summary'],
      },
    }],
  };
  const compiled = compileProjectPlan(plan);

  HarnessSession.create({
    id: sessionId,
    kind: 'chat',
    channel: 'desktop',
    title: 'Compiled project runner acceptance',
  });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Verify the sent-message receipt as a durable project.',
      displayText: 'Verify the sent-message receipt as a durable project.',
      source: 'desktop',
    },
  });
  const winner = new ExecutionStore().createOrGetForSource({
    sessionId,
    sourceUserSeq: source.seq,
    title: 'Compiled project runner acceptance',
    objective: plan.objective,
    reason: 'Accepted as bounded durable project work.',
    startedFromMessage: 'Verify the sent-message receipt as a durable project.',
    confidence: 0.98,
    reasons: ['durable execution acceptance'],
    admission: {
      compiledPlan: {
        version: 2,
        compilerId: 'project_graph_v2',
        planHash: compiled.planHash,
        definitionHash: workflowDefinitionHash(compiled.definition),
        plan,
        definition: compiled.definition,
        inputs: {},
      },
    },
  });
  assert.equal(winner.created, true);
  assert.equal(winner.plannerConflict, false);

  const queued = queueCompiledWorkflowRun({ sessionId, sourceUserSeq: source.seq });
  if (queued.status !== 'queued' || !queued.id) {
    assert.fail(`expected compiled run to queue, got ${queued.status}: ${queued.message}`);
  }
  const runId = queued.id;
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const admitted = JSON.parse(readFileSync(runFile, 'utf-8')) as Record<string, any>;
  assert.equal(admitted.workflowDefinitionSnapshot?.version, 3);
  assert.equal(admitted.workflowDefinitionSnapshot?.scope, 'compiled');
  assert.equal(admitted.workflowDefinitionSnapshot?.compilerId, 'project_graph_v2');
  assert.equal(admitted.workflowDefinitionSnapshot?.definition?.steps?.[0]?.maxTurns, 13);
  assert.deepEqual(
    admitted.workflowDefinitionSnapshot?.definition?.steps?.[0]?.allowedTools,
    [...PROJECT_STRUCTURAL_TOOLS],
  );
  assert.equal(
    existsSync(path.join(WORKFLOWS_DIR, admitted.workflowSlug, 'SKILL.md')),
    false,
    'the catalogless run must not author a workflow skill',
  );
  assert.equal(
    existsSync(path.join(WORKFLOWS_DIR, compiled.workflowName, 'SKILL.md')),
    false,
    'the compiler display identity must not be persisted as a catalog skill either',
  );

  let modelLoopCalls = 0;
  let observedMaxTurns: number | undefined;
  let observedPlanScopeTools: string[] | undefined;
  let observedMcpScope: unknown = 'not-observed';
  let observedAgentTools: string[] = [];
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (options: {
      agent: { tools?: Array<{ name?: string }> };
      sessionId: string;
      maxTurns?: number;
      mcpToolScope?: unknown;
    }) => {
      modelLoopCalls += 1;
      observedMaxTurns = options.maxTurns;
      observedPlanScopeTools = getPlanScope(options.sessionId)?.allowedTools;
      observedMcpScope = options.mcpToolScope;
      observedAgentTools = (options.agent.tools ?? [])
        .map((tool) => tool.name ?? '')
        .filter(Boolean)
        .sort();
      const receiptUrls = Array.from(
        { length: 6 },
        (_, index) => `https://example.test/receipt-${index}-${'a'.repeat(80)}`,
      );
      recordStepResult(options.sessionId, {
        sent: true,
        messageId: `receipt-${stamp}`,
        // Keep this structured value below the workspace-offload threshold so
        // the deterministic receipt proof remains visible to terminal checks,
        // while its de-duplicated artifact line puts the human report above
        // the optional voice-rewrite threshold. This acceptance stubs only the
        // execution model loop and must not call an unrelated judge/tone model.
        summary: `Receipt verified. ${receiptUrls.join(' ')} ${'x'.repeat(7_100)}`,
      });
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: {
          summary: 'Receipt verified.',
          reply: 'Receipt verified.',
          done: true,
          nextAction: 'completed',
        },
      };
    }) as never,
  });

  try {
    await processWorkflowRuns({
      respond: async () => { throw new Error('compiled model nodes must use the workflow harness'); },
    } as never);

    const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as Record<string, any>;
    assert.equal(modelLoopCalls, 1);
    assert.equal(observedMaxTurns, 13, 'the compiled node budget reaches the real model loop');
    assert.deepEqual(
      observedPlanScopeTools,
      [...PROJECT_STRUCTURAL_TOOLS],
      'the compiler capability list becomes the exact runtime plan scope',
    );
    assert.equal(observedMcpScope, null, 'a local-only explicit lock attaches no external MCP surface');
    assert.ok(observedAgentTools.includes('workflow_step_result'));
    for (const forbidden of ['notify_user', 'read_file', 'composio_execute_tool', 'run_shell_command', 'write_file', 'workflow_run']) {
      assert.equal(observedAgentTools.includes(forbidden), false, `${forbidden} must be absent from the locked step agent`);
    }
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.terminalOutcome, 'succeeded');
    assert.equal(typeof terminal.finishedAt, 'string');
    assert.equal(terminal.projectExecutionSettlement?.version, 1);
    assert.equal(terminal.projectExecutionSettlement?.executionId, winner.execution.id);
    assert.match(terminal.projectExecutionSettlement?.terminalDigest ?? '', /^[a-f0-9]{64}$/);
    const settledProject = new ExecutionStore().getForSource(sessionId, source.seq);
    assert.equal(settledProject?.status, 'completed');
    assert.equal(settledProject?.graphAdmission?.rootWorkflowTerminal?.runId, runId);
    assert.equal(settledProject?.graphAdmission?.rootWorkflowTerminal?.outcome, 'succeeded');
    assert.equal(settledProject?.workflowBindings?.[0]?.status, 'completed');
    assert.equal(terminal.reportBack?.outcome, 'done');
    assert.deepEqual(terminal.reportBack?.acknowledgedOriginSessionIds, [sessionId]);
    assert.deepEqual(terminal.reportBack?.acknowledgedOriginObserverIds, []);
    assert.deepEqual(terminal.reportBack?.acknowledgedOriginObserverSettlements, {});
    assert.equal(typeof terminal.reportBackAcknowledgedAt, 'string');
    assert.equal(
      readWorkflowEvents(admitted.workflowSlug, runId)
        .filter((event) => event.kind === 'step_completed' && event.stepId === 'verify_receipt').length,
      1,
    );
    assert.equal(
      listEvents(sessionId, { types: ['user_input_received'] })
        .filter((event) => typeof event.data?.text === 'string'
          && event.data.text.startsWith(`[workflow run ${runId} `)).length,
      1,
      'the terminal result reports back to the exact source session once',
    );

    // Crash-injection at the two-ledger boundary: preserve the terminal root
    // but remove both its settlement marker and the ExecutionStore projection.
    // The next ordinary drain must heal from run truth without executing work
    // or asking the user to repeat the project.
    const executionsFile = path.join(tmp, 'state', 'executions.json');
    const executions = JSON.parse(readFileSync(executionsFile, 'utf-8')) as Array<Record<string, any>>;
    const execution = executions.find((entry) => entry.id === winner.execution.id)!;
    execution.status = 'active';
    delete execution.completedAt;
    delete execution.graphAdmission.rootWorkflowTerminal;
    execution.workflowBindings[0].status = 'queued';
    delete execution.workflowBindings[0].terminalOutcome;
    delete execution.workflowBindings[0].finishedAt;
    writeFileSync(executionsFile, JSON.stringify(executions, null, 2), 'utf-8');
    const unmarkedTerminal = JSON.parse(readFileSync(runFile, 'utf-8')) as Record<string, any>;
    delete unmarkedTerminal.projectExecutionSettlement;
    writeFileSync(runFile, JSON.stringify(unmarkedTerminal, null, 2), 'utf-8');

    // Restart-style durable rescan: heal settlement, but neither execute the
    // node nor emit another report.
    await processWorkflowRuns({
      respond: async () => { throw new Error('terminal compiled run must not re-enter execution'); },
    } as never);
    assert.equal(modelLoopCalls, 1, 'a second durable drain does not repeat the model node');
    assert.equal(
      new ExecutionStore().getForSource(sessionId, source.seq)?.graphAdmission?.rootWorkflowTerminal?.outcome,
      'succeeded',
    );
    assert.equal(
      (JSON.parse(readFileSync(runFile, 'utf-8')) as Record<string, any>).projectExecutionSettlement?.executionId,
      winner.execution.id,
    );
    assert.equal(
      readWorkflowEvents(admitted.workflowSlug, runId)
        .filter((event) => event.kind === 'step_completed' && event.stepId === 'verify_receipt').length,
      1,
    );
    assert.equal(
      listEvents(sessionId, { types: ['user_input_received'] })
        .filter((event) => typeof event.data?.text === 'string'
          && event.data.text.startsWith(`[workflow run ${runId} `)).length,
      1,
      'restart-style report-back remains idempotent',
    );
    assert.equal(existsSync(path.join(WORKFLOWS_DIR, admitted.workflowSlug, 'SKILL.md')), false);
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }
});

test('compiled specialists fan out as workers while only the exact brain sink is published', async () => {
  const { recordStepResult } = await import('../tools/step-result-tool.js');
  const { loadNotifications } = await import('../runtime/notifications.js');
  const { writeWorkflow } = await import('../memory/workflow-store.js');
  const { registerAutonomyActionTools } = await import('../tools/autonomy-action-tools.js');
  const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
  type NotifyResult = { content?: Array<{ text?: string }> };
  type NotifyHandler = (input: Record<string, unknown>) => Promise<NotifyResult>;
  const autonomyHandlers = new Map<string, NotifyHandler>();
  registerAutonomyActionTools({
    tool(name: string, _description: string, _schema: unknown, handler: NotifyHandler) {
      autonomyHandlers.set(name, handler);
    },
  } as never);
  const notifyUser = autonomyHandlers.get('notify_user');
  assert.ok(notifyUser);
  const prepareExactDispatch = (source: {
    sessionId: string;
    seq: number;
    turn: number;
    id: string;
  }) => (authority: Parameters<typeof createWorkflowChatDispatchPreparedReceipt>[0]) => {
    const prepared = appendEvent({
      sessionId: source.sessionId,
      turn: source.turn,
      role: 'system',
      type: 'async_work_dispatch_prepared',
      parentEventId: source.id,
      data: { ...authority },
    });
    return recordWorkflowChatDispatchPreparation(
      createWorkflowChatDispatchPreparedReceipt(authority, {
        eventId: prepared.id,
        eventSeq: prepared.seq,
        preparedAt: prepared.createdAt,
      }),
    );
  };
  const closeAndActivatePreparedRun = (
    queued: ReturnType<typeof queueWorkflowRun>,
    source: { sessionId: string; seq: number; turn: number },
  ): void => {
    assert.ok(queued.chatDispatchPreparation, 'exact fixture must return durable preparation evidence');
    const closeAuthority = createWorkflowOriginGroupCloseAuthority([queued.chatDispatchPreparation]);
    const closeEvent = appendAsyncWorkDispatchBatchClosedOnce({
      sessionId: source.sessionId,
      turn: source.turn,
      sourceUserSeq: source.seq,
      data: { ...closeAuthority },
    }).event;
    const closeReceipt = createWorkflowOriginGroupClosedBatchReceipt(closeAuthority, {
      eventId: closeEvent.id,
      eventSeq: closeEvent.seq,
      closedAt: closeEvent.createdAt,
    });
    recordWorkflowOriginGroupClosedBatch({
      receipt: closeReceipt,
      preparedReceipts: [queued.chatDispatchPreparation],
    });
    finalizeWorkflowOriginGroupClosedBatch(closeAuthority.sourceGroupId, {
      beforeMemberRelease: () => {},
    });
  };
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `sess-compiled-role-boundary-${stamp}`;
  const specialistIds = ['probe_north', 'probe_east', 'probe_west'];
  const exactTerminalValue = { count: 37, url: 'https://sales.example.test/eom' };
  const exactTerminal = JSON.stringify(exactTerminalValue);
  const plan = {
    planId: `role-boundary-${createHash('sha256').update(stamp).digest('hex').slice(0, 16)}`,
    objective: 'Catalogue thrumcap density across the northern glarnix beds.',
    nodes: [
      ...specialistIds.map((id) => ({
        id,
        executor: {
          kind: 'model' as const,
          instruction: `Collect the private ${id} evidence.`,
          allowedTools: ['workspace_artifact_query'],
        },
        effect: 'read' as const,
        executionRole: 'specialist' as const,
      })),
      {
        id: 'reduce_sales',
        dependsOn: specialistIds,
        executor: {
          kind: 'model' as const,
          instruction: 'Join all three private probes into one exact sales total.',
          allowedTools: ['workspace_artifact_query'],
        },
        effect: 'read' as const,
        executionRole: 'reducer' as const,
      },
      {
        id: 'brain',
        dependsOn: ['reduce_sales'],
        executor: {
          kind: 'model' as const,
          instruction: 'Confirm the joined density model against the observations.',
          allowedTools: ['workspace_artifact_query'],
        },
        effect: 'read' as const,
        executionRole: 'brain' as const,
        evidence: {
          type: 'object' as const,
          requiredKeys: ['count', 'url'],
          nonEmpty: ['url'],
        },
      },
    ],
  };
  const compiled = compileProjectPlan(plan);

  HarnessSession.create({
    id: sessionId,
    kind: 'chat',
    channel: 'desktop',
    title: 'Compiled role boundary source',
  });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Build the sales result.', source: 'desktop' },
  });
  new ExecutionStore().createOrGetForSource({
    sessionId,
    sourceUserSeq: source.seq,
    title: 'Compiled role boundary',
    objective: plan.objective,
    reason: 'Exercise authenticated compiled role topology.',
    startedFromMessage: 'Build the sales result.',
    confidence: 0.99,
    reasons: ['compiled role acceptance'],
    admission: {
      compiledPlan: {
        version: 2,
        compilerId: 'project_graph_v2',
        planHash: compiled.planHash,
        definitionHash: workflowDefinitionHash(compiled.definition),
        plan,
        definition: compiled.definition,
        inputs: {},
      },
    },
  });
  const queued = queueCompiledWorkflowRun({ sessionId, sourceUserSeq: source.seq });
  if (queued.status !== 'queued' || !queued.id) {
    assert.fail(`expected compiled run to queue, got ${queued.status}: ${queued.message}`);
  }
  const runId = queued.id;
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const admitted = JSON.parse(readFileSync(runFile, 'utf-8')) as Record<string, any>;

  let activeSpecialists = 0;
  let maxActiveSpecialists = 0;
  let releaseSpecialists!: () => void;
  const allSpecialistsEntered = new Promise<void>((resolve) => { releaseSpecialists = resolve; });
  const reducerContexts: string[] = [];
  let voiceRewriteCalls = 0;
  const poisonedRewrite = 'Quarter total: 999\nDashboard: https://wrong.example.test\nPRIVATE-probe_north';
  const authoredNotifyBody = 'Platform 49 is current: no new qualified accounts appeared, and the tracker refresh completed.';

  _setWorkflowVoiceRewriteForTests((async () => {
    voiceRewriteCalls += 1;
    return { message: poisonedRewrite, nothingHappened: false };
  }) as never);
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (options: { sessionId: string; input?: string }) => {
      const stepId = options.sessionId.split(':').at(-1) ?? '';
      if (specialistIds.includes(stepId)) {
        activeSpecialists += 1;
        maxActiveSpecialists = Math.max(maxActiveSpecialists, activeSpecialists);
        if (activeSpecialists === specialistIds.length) releaseSpecialists();
        await allSpecialistsEntered;
        recordStepResult(options.sessionId, {
          branch: stepId,
          value: stepId === 'probe_north' ? 12 : stepId === 'probe_east' ? 10 : 15,
          secret: `PRIVATE-${stepId}`,
        });
        activeSpecialists -= 1;
      } else if (stepId === 'reduce_sales') {
        reducerContexts.push(options.input ?? '');
        recordStepResult(options.sessionId, {
          total: 37,
          reducerSecret: 'PRIVATE-reducer-only',
        });
      } else if (stepId === 'brain') {
        recordStepResult(options.sessionId, exactTerminalValue);
      } else if (stepId === 'ordinary_step') {
        recordStepResult(options.sessionId, 'ordinary catalog result');
      } else if (stepId === 'notify_step') {
        const workflowRunId = options.sessionId.split(':')[1];
        if (!workflowRunId) throw new Error('notify acceptance fixture could not resolve its workflow run id');
        const result = await withToolOutputContext({
          workflowRunId,
          sessionId: options.sessionId,
          stepId,
        }, () => notifyUser!({
          title: 'Platform 49 review complete',
          body: authoredNotifyBody,
          kind: 'workflow',
        }));
        const receipt = result.content?.find((item) => typeof item.text === 'string')?.text;
        if (!receipt) throw new Error('notify_user acceptance fixture returned no receipt');
        // Deliberately persist only the local queue receipt as the step result.
        // The authored body exists solely in notify_user's durable record.
        recordStepResult(options.sessionId, receipt);
      } else if (stepId === 'fail_node') {
        throw new Error('EXACT-COMPILED-FAILURE-73');
      } else {
        throw new Error(`unexpected workflow step in acceptance stub: ${stepId}`);
      }
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 'done', reply: 'done', done: true, nextAction: 'completed' },
      };
    }) as never,
  });

  const ordinarySlug = `ordinary-role-control-${stamp}`;
  const ordinaryName = `Ordinary Role Control ${stamp}`;
  const ordinaryRunId = `ordinary-role-control-run-${stamp}`;
  const notifySlug = `exact-notify-presentation-${stamp}`;
  const notifyName = `Exact Notify Presentation ${stamp}`;
  try {
    await processWorkflowRuns({
      respond: async () => { throw new Error('compiled nodes must use the workflow harness'); },
    } as never);

    assert.equal(maxActiveSpecialists, 3, 'all three specialist workers overlap before the reducer starts');
    assert.equal(reducerContexts.length, 1);
    for (const id of specialistIds) {
      assert.match(reducerContexts[0], new RegExp(`PRIVATE-${id}`), `reducer receives ${id} through DAG context`);
    }

    const started = specialistIds.flatMap((id) =>
      listEvents(`workflow:${runId}:${id}`, { types: ['worker_started'] }));
    const results = specialistIds.flatMap((id) =>
      listEvents(`workflow:${runId}:${id}`, { types: ['worker_result'] }));
    assert.equal(started.length, 3);
    assert.equal(results.length, 3);
    assert.equal(started.every((event) => event.data?.lane === 'compiled_project'), true);
    assert.equal(results.every((event) => event.data?.lane === 'compiled_project' && event.data?.ok === true), true);
    for (const id of ['reduce_sales', 'brain']) {
      assert.equal(listEvents(`workflow:${runId}:${id}`, { types: ['worker_started'] }).length, 0);
      assert.equal(listEvents(`workflow:${runId}:${id}`, { types: ['worker_result'] }).length, 0);
    }

    const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as Record<string, any>;
    assert.equal(voiceRewriteCalls, 0, 'compiled success places no post-graph voice-model call');
    assert.equal(terminal.output, exactTerminal);
    assert.deepEqual(Object.keys(terminal.stepOutputs ?? {}), ['brain']);
    assert.equal(terminal.stepOutputs.brain, exactTerminal);
    assert.equal(terminal.reportBack?.detail, exactTerminal);
    for (const privateText of [...specialistIds.map((id) => `PRIVATE-${id}`), 'PRIVATE-reducer-only']) {
      assert.doesNotMatch(JSON.stringify({
        output: terminal.output,
        stepOutputs: terminal.stepOutputs,
        reportBack: terminal.reportBack,
      }), new RegExp(privateText));
    }

    const completionNotice = loadNotifications().find((row) => row.id === `workflow-${runId}-completed`);
    assert.equal(completionNotice?.body, exactTerminal);
    assert.doesNotMatch(completionNotice?.body ?? '', /PRIVATE-/);
    const originReports = listEvents(sessionId, { types: ['user_input_received'] })
      .filter((event) => typeof event.data?.text === 'string'
        && event.data.text.startsWith(`[workflow run ${runId} `));
    assert.equal(originReports.length, 1);
    assert.match(String(originReports[0].data?.text), /"count":37/);
    assert.match(String(originReports[0].data?.text), /https:\/\/sales\.example\.test\/eom/);
    assert.doesNotMatch(String(originReports[0].data?.text), /PRIVATE-/);
    const runSummary = readWorkflowEvents(admitted.workflowSlug, runId)
      .find((event) => event.kind === 'run_summary');
    assert.ok(runSummary);
    assert.doesNotMatch(JSON.stringify(runSummary?.meta?.artifacts ?? {}), /PRIVATE-/);
    assert.deepEqual((runSummary?.meta?.artifacts as { urls?: string[] })?.urls, ['https://sales.example.test/eom']);

    // The failure terminal is just as model-free: no tone pass gets a chance
    // to turn the exact runtime error into the poisoned rewrite.
    const failureSessionId = `sess-compiled-role-failure-${stamp}`;
    const failurePlan = {
      planId: `role-failure-${createHash('sha256').update(stamp).digest('hex').slice(0, 16)}`,
      objective: 'Inspect one thrumcap observation.',
      nodes: [{
        id: 'fail_node',
        executor: {
          kind: 'model' as const,
          instruction: 'Inspect the thrumcap observation.',
          allowedTools: ['workspace_artifact_query'],
        },
        effect: 'read' as const,
      }],
    };
    const compiledFailure = compileProjectPlan(failurePlan);
    HarnessSession.create({
      id: failureSessionId,
      kind: 'chat',
      channel: 'desktop',
      title: 'Compiled failure boundary source',
    });
    const failureSource = appendEvent({
      sessionId: failureSessionId,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Inspect the thrumcap.', source: 'desktop' },
    });
    new ExecutionStore().createOrGetForSource({
      sessionId: failureSessionId,
      sourceUserSeq: failureSource.seq,
      title: 'Compiled failure boundary',
      objective: failurePlan.objective,
      reason: 'Exercise the compiled failure terminal.',
      startedFromMessage: 'Inspect the thrumcap.',
      confidence: 0.99,
      reasons: ['compiled failure acceptance'],
      admission: {
        compiledPlan: {
          version: 2,
          compilerId: 'project_graph_v2',
          planHash: compiledFailure.planHash,
          definitionHash: workflowDefinitionHash(compiledFailure.definition),
          plan: failurePlan,
          definition: compiledFailure.definition,
          inputs: {},
        },
      },
    });
    const queuedFailure = queueCompiledWorkflowRun({
      sessionId: failureSessionId,
      sourceUserSeq: failureSource.seq,
    });
    if (queuedFailure.status !== 'queued' || !queuedFailure.id) {
      assert.fail(`expected compiled failure run to queue, got ${queuedFailure.status}: ${queuedFailure.message}`);
    }
    await processWorkflowRuns({} as never);
    const failureTerminal = JSON.parse(
      readFileSync(path.join(WORKFLOW_RUNS_DIR, `${queuedFailure.id}.json`), 'utf-8'),
    ) as Record<string, any>;
    assert.equal(failureTerminal.status, 'error');
    assert.equal(failureTerminal.reportBack?.detail, 'EXACT-COMPILED-FAILURE-73');
    assert.equal(voiceRewriteCalls, 0, 'compiled failure places no post-graph voice-model call');
    assert.doesNotMatch(failureTerminal.reportBack?.detail ?? '', /999|wrong\.example|PRIVATE-/);

    // Ordinary catalog control: the same persisted role field is untrusted and
    // the existing report voice pass still runs. A partial TRY avoids unrelated
    // target/goal judges while exercising the real terminal publication path.
    writeWorkflow(ordinarySlug, {
      name: ordinaryName,
      description: 'Ordinary catalog role compatibility control.',
      enabled: true,
      trigger: { manual: true },
      steps: [{
        id: 'ordinary_step',
        prompt: 'Return the ordinary catalog result.',
        sideEffect: 'read',
        executionRole: 'specialist',
      }],
    });
    mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
    writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${ordinaryRunId}.json`), JSON.stringify({
      id: ordinaryRunId,
      workflow: ordinaryName,
      status: 'queued',
      targetStepId: 'ordinary_step',
      inputs: {},
      createdAt: new Date().toISOString(),
    }), 'utf-8');
    await processWorkflowRuns({} as never);
    const ordinaryTerminal = JSON.parse(
      readFileSync(path.join(WORKFLOW_RUNS_DIR, `${ordinaryRunId}.json`), 'utf-8'),
    ) as Record<string, any>;
    assert.equal(voiceRewriteCalls, 1, 'ordinary catalog completion retains the voice rewrite');
    assert.equal(ordinaryTerminal.reportBack?.detail, poisonedRewrite);
    assert.equal(listEvents(`workflow:${ordinaryRunId}:ordinary_step`, { types: ['worker_started'] }).length, 0);
    const ordinaryNotice = loadNotifications().find((row) => row.id === `workflow-${ordinaryRunId}-completed`);
    assert.notEqual(ordinaryNotice?.silent, true, 'scheduled/no-origin completion retains external notification delivery');

    // An ordinary catalog workflow becomes single-reply/model-free only when
    // it has a real exact v2 source observer. This is deliberately NOT keyed
    // from originSessionId, so the scheduled control above and legacy v1
    // origins retain their existing path.
    const exactOrdinarySessionId = `sess-ordinary-exact-${stamp}`;
    HarnessSession.create({
      id: exactOrdinarySessionId,
      kind: 'chat',
      channel: 'desktop',
      title: 'Ordinary exact observer control',
    });
    const exactOrdinarySource = appendEvent({
      sessionId: exactOrdinarySessionId,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Run the ordinary exact-observer control.', source: 'desktop' },
    });
    const exactOrdinary = queueWorkflowRun(ordinaryName, {}, {
      targetStepId: 'ordinary_step',
      originSessionId: exactOrdinarySessionId,
      originObserver: {
        sessionId: exactOrdinarySessionId,
        sourceUserSeq: exactOrdinarySource.seq,
        replyTarget: { type: 'origin_chat' },
      },
      prepareChatDispatch: prepareExactDispatch(exactOrdinarySource),
    });
    assert.equal(exactOrdinary.status, 'held');
    assert.ok(exactOrdinary.id);
    closeAndActivatePreparedRun(exactOrdinary, exactOrdinarySource);
    await processWorkflowRuns({} as never);
    const exactOrdinaryTerminal = JSON.parse(
      readFileSync(path.join(WORKFLOW_RUNS_DIR, `${exactOrdinary.id}.json`), 'utf-8'),
    ) as Record<string, any>;
    assert.equal(voiceRewriteCalls, 1, 'exact-observer completion makes no second voice-model call');
    assert.match(exactOrdinaryTerminal.reportBack?.detail ?? '', /ordinary catalog result/i);
    assert.doesNotMatch(exactOrdinaryTerminal.reportBack?.detail ?? '', /999|wrong\.example|PRIVATE-/);
    const exactOrdinaryNotice = loadNotifications()
      .find((row) => row.id === `workflow-${exactOrdinary.id}-completed`);
    assert.equal(
      exactOrdinaryNotice,
      undefined,
      'exact-origin terminal carrier replaces the duplicate global Activity row',
    );
    assert.equal(
      loadNotifications().filter((row) =>
        row.metadata?.runId === exactOrdinary.id
        && row.metadata?.source === 'workflow_origin_terminal').length,
      1,
      'exact ordinary run retains one terminal notification carrier',
    );

    // Biting end-to-end contribution check: the step result contains no
    // meaningful business answer at all, only notify_user's local queue id.
    // The exact-origin terminal must recover the authored body from the
    // correlated durable notification without a second voice-model pass.
    writeWorkflow(notifySlug, {
      name: notifyName,
      description: 'Exact notify_user presentation contribution acceptance.',
      enabled: true,
      trigger: { manual: true },
      steps: [{
        id: 'notify_step',
        prompt: 'Send the completed Platform 49 review to the user through notify_user.',
        sideEffect: 'read',
      }],
    });
    const notifySessionId = `sess-exact-notify-${stamp}`;
    HarnessSession.create({
      id: notifySessionId,
      kind: 'chat',
      channel: 'desktop',
      title: 'Exact notify presentation source',
    });
    const notifySource = appendEvent({
      sessionId: notifySessionId,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'What changed in Platform 49?', source: 'desktop' },
    });
    const notifyRun = queueWorkflowRun(notifyName, {}, {
      targetStepId: 'notify_step',
      originSessionId: notifySessionId,
      originObserver: {
        sessionId: notifySessionId,
        sourceUserSeq: notifySource.seq,
        replyTarget: { type: 'origin_chat' },
      },
      prepareChatDispatch: prepareExactDispatch(notifySource),
    });
    assert.equal(notifyRun.status, 'held');
    assert.ok(notifyRun.id);
    closeAndActivatePreparedRun(notifyRun, notifySource);
    await processWorkflowRuns({} as never);

    const notifyTerminalRecord = JSON.parse(
      readFileSync(path.join(WORKFLOW_RUNS_DIR, `${notifyRun.id}.json`), 'utf-8'),
    ) as Record<string, any>;
    assert.equal(voiceRewriteCalls, 1, 'notify contribution reaches the terminal without a voice-model call');
    assert.equal(notifyTerminalRecord.reportBack?.detail, authoredNotifyBody);
    assert.doesNotMatch(
      notifyTerminalRecord.reportBack?.detail ?? '',
      /Notification queued:|notify_step|tool-notify/i,
      'the execution receipt cannot replace or narrate beside the authored result',
    );
    const notifyRows = loadNotifications();
    const authoredIntermediate = notifyRows.find((row) =>
      row.metadata?.source === 'notify_user_tool'
      && row.metadata?.workflowRunId === notifyRun.id);
    assert.equal(authoredIntermediate?.body, authoredNotifyBody);
    assert.equal(
      authoredIntermediate?.silent,
      true,
      'the intermediate notify_user record is dashboard-only under exact terminal authority',
    );
    const notifyCompletion = notifyRows.find((row) => row.id === `workflow-${notifyRun.id}-completed`);
    assert.equal(notifyCompletion, undefined, 'the duplicate global completion row is omitted');
    const notifyTerminalCarriers = notifyRows.filter((row) =>
      row.metadata?.runId === notifyRun.id
      && row.metadata?.source === 'workflow_origin_terminal');
    assert.equal(notifyTerminalCarriers.length, 1);
    assert.equal(notifyTerminalCarriers[0]?.body, authoredNotifyBody);

    const sourceTerminals = listEvents(notifySessionId, { types: ['conversation_completed'] })
      .filter((event) => event.data.sourceUserSeq === notifySource.seq);
    assert.equal(sourceTerminals.length, 1, 'the original source receives exactly one terminal');
    assert.equal(sourceTerminals[0].data.reply, authoredNotifyBody);
    assert.equal(
      listEvents(notifySessionId, { types: ['user_input_received'] })
        .filter((event) => event.data.synthetic === true).length,
      0,
      'exact workflow delivery uses no synthetic outcome turn',
    );
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
    _setWorkflowVoiceRewriteForTests(null);
    rmSync(path.join(WORKFLOWS_DIR, ordinarySlug), { recursive: true, force: true });
    rmSync(path.join(WORKFLOWS_DIR, notifySlug), { recursive: true, force: true });
  }
});

test('SIGKILL after terminal publication cannot leave status without its exact report envelope', async () => {
  const runId = `terminal-envelope-crash-${Date.now()}`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(file, JSON.stringify({
    id: runId,
    workflow: 'Crash Envelope Workflow',
    status: 'running',
  }), 'utf-8');
  const ready = path.join(tmp, `${runId}.ready`);
  const release = path.join(tmp, `${runId}.release`);
  const moduleUrl = new URL('./workflow-runner.ts', import.meta.url).href;
  const childCode = String.raw`
    const mod = await import(process.env.CLEM_RUNNER_MODULE_URL);
    mod.publishWorkflowRunTerminalForTest(
      process.env.CLEM_RUNNER_FILE,
      JSON.parse(process.env.CLEM_RUNNER_RECORD),
      JSON.parse(process.env.CLEM_RUNNER_REPORT),
    );
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childCode], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLEM_RUNNER_MODULE_URL: moduleUrl,
      CLEM_RUNNER_FILE: file,
      CLEM_RUNNER_RECORD: JSON.stringify({
        id: runId,
        workflow: 'Crash Envelope Workflow',
        status: 'completed',
        finishedAt: new Date().toISOString(),
        output: 'exact durable result',
      }),
      CLEM_RUNNER_REPORT: JSON.stringify({
        workflowName: 'Crash Envelope Workflow',
        outcome: 'done',
        detail: 'exact durable result',
      }),
      CLEMENTINE_TEST_TERMINAL_PUBLISH_READY: ready,
      CLEMENTINE_TEST_TERMINAL_PUBLISH_RELEASE: release,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const deadline = Date.now() + 60_000;
    while (!existsSync(ready)) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for terminal publication crash barrier.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.kill('SIGKILL');
    const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, any>;
    assert.equal(raw.status, 'completed');
    assert.equal(raw.terminalOutcome, 'succeeded');
    assert.equal(raw.output, 'exact durable result');
    assert.deepEqual(raw.reportBack, {
      version: 1,
      workflowName: 'Crash Envelope Workflow',
      outcome: 'done',
      detail: 'exact durable result',
      acknowledgedOriginSessionIds: [],
    });
    assert.equal(
      readWorkflowRunRecord<Record<string, unknown>>(file)?.status,
      'completed',
      'the next reader safely reclaims the dead lock owner without changing the atomic record',
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(ready, { force: true });
    rmSync(release, { force: true });
  }
});

test('terminal publication persists user-objective truth separately from lifecycle completion', () => {
  const blockedId = `terminal-outcome-blocked-${Date.now()}`;
  const blockedFile = path.join(WORKFLOW_RUNS_DIR, `${blockedId}.json`);
  writeFileSync(blockedFile, JSON.stringify({
    id: blockedId,
    workflow: 'Truthful Outcome Workflow',
    status: 'running',
  }), 'utf-8');
  const blocked = publishWorkflowRunTerminalForTest(
    blockedFile,
    {
      id: blockedId,
      workflow: 'Truthful Outcome Workflow',
      status: 'completed',
      finishedAt: new Date().toISOString(),
      needsAttention: true,
      blockedSteps: [{ stepId: 'publish', reason: 'authentication required' }],
    },
    {
      workflowName: 'Truthful Outcome Workflow',
      outcome: 'blocked',
      detail: 'Publishing is blocked until authentication is restored.',
    },
  );
  assert.equal(blocked.status, 'completed', 'lifecycle compatibility remains intact');
  assert.equal(blocked.terminalOutcome, 'blocked', 'user-objective truth cannot read as success');

  const partialId = `terminal-outcome-partial-${Date.now()}`;
  const partialFile = path.join(WORKFLOW_RUNS_DIR, `${partialId}.json`);
  writeFileSync(partialFile, JSON.stringify({
    id: partialId,
    workflow: 'Truthful Fanout Workflow',
    status: 'running',
  }), 'utf-8');
  const partial = publishWorkflowRunTerminalForTest(
    partialFile,
    {
      id: partialId,
      workflow: 'Truthful Fanout Workflow',
      status: 'completed_with_errors',
      finishedAt: new Date().toISOString(),
      needsAttention: true,
    },
    {
      workflowName: 'Truthful Fanout Workflow',
      outcome: 'blocked',
      detail: 'Two fan-out items failed; verified items were preserved.',
    },
  );
  assert.equal(partial.terminalOutcome, 'partial');
});

test('terminal publication cannot regress consumed capability resume authority', () => {
  const runId = `capability-consumed-terminal-${Date.now()}`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const block = {
    stepId: 'publish',
    tool: 'GOOGLESHEETS_BATCH_UPDATE',
    toolkit: 'googlesheets',
    reason: 'not-connected' as const,
    message: 'Reconnect Google Sheets.',
    blockedAt: '2026-07-26T12:00:00.000Z',
    retryAt: '2026-07-26T12:01:00.000Z',
    retryCount: 1,
    provenNoDispatch: true as const,
    state: 'consumed' as const,
    resumedAt: '2026-07-26T12:00:10.000Z',
    resumeAuthorityConsumedAt: '2026-07-26T12:00:11.000Z',
  };
  writeFileSync(file, JSON.stringify({
    id: runId,
    workflow: 'Capability Terminal Workflow',
    status: 'running',
    capabilityBlock: block,
  }), 'utf-8');

  const terminal = publishWorkflowRunTerminalForTest(
    file,
    {
      id: runId,
      workflow: 'Capability Terminal Workflow',
      status: 'completed',
      finishedAt: '2026-07-26T12:00:20.000Z',
      capabilityBlock: {
        ...block,
        state: 'retrying',
        resumeAuthorityConsumedAt: undefined,
      },
    },
    {
      workflowName: 'Capability Terminal Workflow',
      outcome: 'done',
      detail: 'The resumed write completed exactly once.',
    },
  );

  assert.equal(terminal.capabilityBlock?.state, 'consumed');
  assert.equal(terminal.capabilityBlock?.resumeAuthorityConsumedAt, block.resumeAuthorityConsumedAt);
  rmSync(file, { force: true });
});

test('workflow attempt metrics count one native MCP action, not its transport mirror', () => {
  resetEventLog();
  const runId = `metric-accounting-${Date.now()}`;
  const step = { id: 'create-doc', prompt: 'Create the document.' };
  const workflow = { name: 'Metric Accounting Workflow' };
  const session = workflowRunnerInternalsForTest.getWorkflowHarnessSession(
    workflow.name,
    step.id,
    runId,
    `${runId}:${step.id}`,
  );
  appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'toolu-doc', accounting: 'top_level', arguments: '{}' } });
  appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'mcp-doc', accounting: 'transport_mirror', args: {} } });

  const sample = workflowRunnerInternalsForTest.sampleStepAttemptMetrics(
    step as never,
    { workflow, runId } as never,
  );
  assert.equal(sample.toolCalls, 1);
});

// ---------------------------------------------------------------------------
// P0 — event-driven approval parking (WORKFLOW_APPROVAL_PARKING)
// ---------------------------------------------------------------------------

function writeParkedRun(runId: string, approvalIds: string[]): string {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(
    filePath,
    JSON.stringify({
      id: runId,
      workflow: 'Test Parking WF',
      status: 'parked',
      parked: {
        parkedSteps: [{ stepId: 'send_step', kind: 'gate', approvalIds }],
        parkedAt: new Date().toISOString(),
      },
    }, null, 2),
    'utf-8',
  );
  return filePath;
}

const statusOf = (filePath: string): string | undefined =>
  JSON.parse(readFileSync(filePath, 'utf-8')).status;

function writeCapabilityBlockedRun(runId: string, retryAt: string): string {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const definition = {
    name: 'Capability Resume WF',
    description: 'Resume one admitted capability-blocked workflow.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'publish', prompt: 'Publish after the dependency recovers.', sideEffect: 'write' as const }],
  };
  writeFileSync(filePath, JSON.stringify({
    id: runId,
    workflow: 'Capability Resume WF',
    // Manual/chat admissions do not require the top-level slug projection;
    // resume authority comes from this authenticated immutable snapshot.
    workflowDefinitionSnapshot: createWorkflowRunDefinitionSnapshot(
      'capability-resume-wf',
      definition,
      '2026-07-26T12:00:00.000Z',
    ),
    status: 'blocked_capability',
    capabilityBlock: {
      stepId: 'publish',
      tool: 'GOOGLESHEETS_BATCH_UPDATE',
      toolkit: 'googlesheets',
      reason: 'not-connected',
      message: 'Reconnect Google Sheets.',
      blockedAt: new Date(Date.parse(retryAt) - 60_000).toISOString(),
      retryAt,
      retryCount: 1,
      provenNoDispatch: true,
      state: 'blocked',
    },
  }, null, 2), 'utf-8');
  return filePath;
}

function withEnv(over: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(over)) {
    prev[key] = process.env[key];
    if (over[key] === undefined) delete process.env[key];
    else process.env[key] = over[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(over)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

type CanonicalWorkflowHarnessRequest = {
  sessionId: string;
  input?: string;
};

/** Exercise the production workflow-owned host loop without a live provider.
 * The responder stands in for the final model only; accepted-source creation,
 * run-attempt identity, fan-out scheduling, retry, evidence, and settlement
 * remain owned by `runStepViaHarness`. */
function installCanonicalWorkflowTextHarness(
  responder: (request: CanonicalWorkflowHarnessRequest) => string | Promise<string>,
): void {
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (request: CanonicalWorkflowHarnessRequest) => {
      const text = await responder(request);
      return {
        sessionId: request.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: {
          summary: text,
          reply: text,
          done: true,
          nextAction: 'completed',
        },
      };
    }) as never,
  });
}

test('capability blocks are typed control flow only for externally recoverable gateway reasons', () => {
  assert.equal(workflowCapabilityBlockIsRecoverable('not-connected'), true);
  assert.equal(workflowCapabilityBlockIsRecoverable('identity-absent'), true);
  assert.equal(workflowCapabilityBlockIsRecoverable('ambiguous-account'), true);
  assert.equal(workflowCapabilityBlockIsRecoverable('suppressed'), true);
  assert.equal(workflowCapabilityBlockIsRecoverable('constraint'), false);
  assert.equal(workflowCapabilityBlockIsRecoverable('invalid-args'), false);

  const block = new WorkflowCapabilityBlockedError({
    stepId: 'publish',
    tool: 'GOOGLESHEETS_BATCH_UPDATE',
    toolkit: 'googlesheets',
    reason: 'not-connected',
    message: 'Reconnect Google Sheets.',
  });
  assert.equal(block.provenNoDispatch, true);
  assert.equal(block.stepId, 'publish');
  assert.match(block.message, /Reconnect Google Sheets/);
});

test('capability retry re-admits the same run only when due, and manual resume bypasses the timer', () => {
  const now = Date.now();
  const automatic = writeCapabilityBlockedRun('capability-auto-resume', new Date(now + 30_000).toISOString());
  assert.equal(reapCapabilityBlockedRuns(now), 0);
  assert.equal(statusOf(automatic), 'blocked_capability');

  assert.equal(reapCapabilityBlockedRuns(now + 30_000), 1);
  const resumed = JSON.parse(readFileSync(automatic, 'utf-8')) as {
    status: string;
    capabilityBlock: { state: string; resumedAt?: string; provenNoDispatch: boolean };
  };
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.capabilityBlock.state, 'retrying');
  assert.equal(resumed.capabilityBlock.provenNoDispatch, true);
  assert.ok(resumed.capabilityBlock.resumedAt);

  const manual = writeCapabilityBlockedRun('capability-manual-resume', new Date(now + 60 * 60_000).toISOString());
  assert.equal(resumeCapabilityBlockedWorkflowRun('capability-manual-resume'), true);
  assert.equal(statusOf(manual), 'running');
  assert.equal(resumeCapabilityBlockedWorkflowRun('../unsafe'), false);

  for (const [runId, capabilityBlockPatch] of [
    ['capability-manual-not-proven', { provenNoDispatch: false }],
    ['capability-manual-already-retrying', { state: 'retrying' }],
  ] as const) {
    const malformed = writeCapabilityBlockedRun(runId, new Date(now + 60 * 60_000).toISOString());
    const record = JSON.parse(readFileSync(malformed, 'utf-8')) as Record<string, unknown>;
    writeFileSync(malformed, JSON.stringify({
      ...record,
      capabilityBlock: {
        ...(record.capabilityBlock as Record<string, unknown>),
        ...capabilityBlockPatch,
      },
    }, null, 2), 'utf-8');
    assert.equal(resumeCapabilityBlockedWorkflowRun(runId), false);
    assert.equal(statusOf(malformed), 'blocked_capability');
    rmSync(malformed, { force: true });
  }
  const conflictingSlug = writeCapabilityBlockedRun('capability-manual-conflicting-slug', new Date(now + 60 * 60_000).toISOString());
  const conflictingSlugRecord = JSON.parse(readFileSync(conflictingSlug, 'utf-8')) as Record<string, unknown>;
  conflictingSlugRecord.workflowSlug = 'forged-conflicting-slug';
  writeFileSync(conflictingSlug, JSON.stringify(conflictingSlugRecord, null, 2), 'utf-8');
  assert.equal(resumeCapabilityBlockedWorkflowRun('capability-manual-conflicting-slug'), false);
  assert.equal(statusOf(conflictingSlug), 'blocked_capability');
  rmSync(conflictingSlug, { force: true });
  const corruptSlug = writeCapabilityBlockedRun('capability-manual-corrupt-slug', new Date(now + 60 * 60_000).toISOString());
  const corruptSlugRecord = JSON.parse(readFileSync(corruptSlug, 'utf-8')) as Record<string, unknown>;
  corruptSlugRecord.workflowSlug = 42;
  writeFileSync(corruptSlug, JSON.stringify(corruptSlugRecord, null, 2), 'utf-8');
  assert.equal(resumeCapabilityBlockedWorkflowRun('capability-manual-corrupt-slug'), false);
  assert.equal(statusOf(corruptSlug), 'blocked_capability');
  rmSync(corruptSlug, { force: true });

  withEnv({
    CLEMENTINE_WORKFLOW_CAPABILITY_RETRY_BASE_MS: '1000',
    CLEMENTINE_WORKFLOW_CAPABILITY_RETRY_MAX_MS: '4000',
  }, () => {
    assert.equal(workflowCapabilityRetryDelayMs(1), 1000);
    assert.equal(workflowCapabilityRetryDelayMs(2), 2000);
    assert.equal(workflowCapabilityRetryDelayMs(99), 4000);
  });

  rmSync(automatic, { force: true });
  rmSync(manual, { force: true });
});

test('ambiguous capability gate requires exact account CAS, selects B, and dedupes a restart replay', () => {
  const runId = 'capability-account-choice-cas';
  const filePath = writeCapabilityBlockedRun(runId, new Date(Date.now() - 1_000).toISOString());
  const record = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  const choices = workflowCapabilityAccountChoiceSet([
    { capabilityId: 'cap:sheet:account-a', account: 'account-a' },
    { capabilityId: 'cap:sheet:account-b', account: 'account-b' },
  ]);
  writeFileSync(filePath, JSON.stringify({
    ...record,
    capabilityBlock: {
      ...(record.capabilityBlock as Record<string, unknown>),
      reason: 'ambiguous-account',
      message: 'Choose an exact Sheets account.',
      accountChoiceSet: choices,
    },
  }, null, 2), 'utf-8');

  assert.equal(reapCapabilityBlockedRuns(Date.now()), 0, 'timer must not choose by catalog order');
  assert.equal(resumeCapabilityBlockedWorkflowRun(runId), false, 'generic retry must not bypass the account question');

  const selected = resolveWorkflowCapabilityAccountChoice({
    runId,
    stepId: 'publish',
    tool: 'GOOGLESHEETS_BATCH_UPDATE',
    retryCount: 1,
    choiceSetDigest: choices.digest,
    capabilityId: 'cap:sheet:account-b',
    accountId: 'account-b',
    selectedBy: 'chat:account-answer',
  });
  assert.deepEqual(selected, {
    ok: true,
    status: 'selected',
    runId,
    stepId: 'publish',
    capabilityId: 'cap:sheet:account-b',
    accountId: 'account-b',
  });
  const persisted = JSON.parse(readFileSync(filePath, 'utf-8')) as {
    status: string;
    capabilityBlock: {
      state: string;
      accountSelection?: Record<string, unknown>;
    };
  };
  assert.equal(persisted.status, 'running');
  assert.equal(persisted.capabilityBlock.state, 'retrying');
  assert.deepEqual(persisted.capabilityBlock.accountSelection, {
    capabilityId: 'cap:sheet:account-b',
    accountId: 'account-b',
    choiceSetDigest: choices.digest,
    selectedAt: persisted.capabilityBlock.accountSelection?.selectedAt,
    selectedBy: 'chat:account-answer',
  });
  assert.match(String(persisted.capabilityBlock.accountSelection?.selectedAt ?? ''), /^\d{4}-\d{2}-\d{2}T/);

  // The resolver owns no process-local lease. Replaying the same exact answer
  // from a restarted UI/daemon reads the durable retrying checkpoint and is a
  // no-op; a different answer cannot retarget it.
  const replay = resolveWorkflowCapabilityAccountChoice({
    runId,
    stepId: 'publish',
    tool: 'GOOGLESHEETS_BATCH_UPDATE',
    retryCount: 1,
    choiceSetDigest: choices.digest,
    capabilityId: 'cap:sheet:account-b',
    accountId: 'account-b',
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.status, 'already_selected');
  const conflict = resolveWorkflowCapabilityAccountChoice({
    runId,
    stepId: 'publish',
    tool: 'GOOGLESHEETS_BATCH_UPDATE',
    retryCount: 1,
    choiceSetDigest: choices.digest,
    capabilityId: 'cap:sheet:account-a',
    accountId: 'account-a',
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 'conflict');
  const afterReplay = JSON.parse(readFileSync(filePath, 'utf-8')) as typeof persisted;
  assert.equal(afterReplay.capabilityBlock.accountSelection?.accountId, 'account-b');

  rmSync(filePath, { force: true });
});

test('reapResolvedParkedRuns keeps a run parked while its approval is pending, re-admits once resolved', () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  const sid1 = 'workflow-gate:park-test-1:send_step';
  HarnessSession.create({ id: sid1, kind: 'workflow', channel: 'workflow', title: 'park-test-1', metadata: { source: 'workflow' } });
  const row = approvalRegistry.register({
    sessionId: sid1,
    subject: 'Approve the send',
    tool: 'workflow_approval_gate',
    ttlMs: 60_000,
  });
  const filePath = writeParkedRun('park-test-1', [row.approvalId]);

  // Approval still pending → the run stays parked (slot stays free; it is
  // NOT re-admitted to the drain).
  reapResolvedParkedRuns();
  assert.equal(statusOf(filePath), 'parked');

  // Approval resolved → the two-phase flip re-admits it as 'running' so the
  // next drain pass resumes from the parked step.
  approvalRegistry.resolve(row.approvalId, 'approved', 'parking-test');
  reapResolvedParkedRuns();
  assert.equal(statusOf(filePath), 'running');

  rmSync(filePath, { force: true });
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

test('reapResolvedParkedRuns terminates a rejected occurrence instead of minting another approval', () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  const runId = 'park-test-rejected-terminal';
  const sessionId = `workflow:${runId}:send_step`;
  HarnessSession.create({
    id: sessionId,
    kind: 'workflow',
    channel: 'workflow',
    title: runId,
    metadata: { source: 'workflow', workflowName: 'daily-standup-email', workflowRunId: runId, stepId: 'send_step' },
  });
  const session = HarnessSession.load(sessionId)!;
  session.saveInterruptState('{"parked":true}');
  const row = approvalRegistry.register({
    sessionId,
    subject: 'Send the daily standup email?',
    tool: 'composio_execute_tool',
    args: { tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL', arguments: '{"to_email":"alex@corp.example"}' },
    ttlMs: 60_000,
  });
  const filePath = writeParkedRun(runId, [row.approvalId]);

  approvalRegistry.resolve(row.approvalId, 'rejected', 'unit-test-human');
  reapResolvedParkedRuns();

  const stopped = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.parked, undefined);
  assert.match(String(stopped.error), /declined by the user/i);
  assert.equal(HarnessSession.load(sessionId)?.sessionRow.status, 'cancelled');
  assert.equal(HarnessSession.load(sessionId)?.loadInterruptState(), null);

  // A later scan is idempotent: the occurrence remains terminal and cannot
  // re-enter the step to generate a slightly different approval payload.
  reapResolvedParkedRuns();
  assert.equal(statusOf(filePath), 'cancelled');

  rmSync(filePath, { force: true });
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

test('reapResolvedParkedRuns terminates an expired occurrence instead of retrying the send', () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  const runId = 'park-test-expired-terminal';
  const sessionId = `workflow:${runId}:send_step`;
  HarnessSession.create({ id: sessionId, kind: 'workflow', channel: 'workflow', title: runId, metadata: { source: 'workflow' } });
  const row = approvalRegistry.register({
    sessionId,
    subject: 'Send the daily standup email?',
    tool: 'composio_execute_tool',
    ttlMs: 60_000,
  });
  const filePath = writeParkedRun(runId, [row.approvalId]);

  approvalRegistry.resolve(row.approvalId, 'expired', 'unit-test-reaper');
  reapResolvedParkedRuns();

  const stopped = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.parked, undefined);
  assert.match(String(stopped.error), /not approved before it expired/i);

  rmSync(filePath, { force: true });
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

// Break-scenario C / audit A4 hole 2: orphaned parked runs must terminalize,
// not sit "parked" forever.
function writeBackdatedParkedRun(runId: string, approvalIds: string[], parkedAgoMs: number): string {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(filePath, JSON.stringify({
    id: runId,
    workflow: 'Orphan WF',
    status: 'parked',
    parked: {
      parkedSteps: [{ stepId: 'send_step', kind: 'gate', approvalIds }],
      parkedAt: new Date(Date.now() - parkedAgoMs).toISOString(),
    },
  }, null, 2), 'utf-8');
  return filePath;
}

test('reapResolvedParkedRuns terminalizes a MALFORMED parked checkpoint after the grace (was skipped forever)', () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  // No watched approval ids at all — the malformed-checkpoint class.
  const fresh = writeBackdatedParkedRun('orphan-malformed-fresh', [], 60_000);
  reapResolvedParkedRuns();
  assert.equal(statusOf(fresh), 'parked', 'a FRESH malformed park is left alone (transient); only aged ones die');

  const aged = writeBackdatedParkedRun('orphan-malformed-aged', [], 27 * 60 * 60_000);
  reapResolvedParkedRuns();
  const rec = JSON.parse(readFileSync(aged, 'utf-8')) as Record<string, unknown>;
  assert.equal(rec.status, 'cancelled', 'an aged malformed park is terminalized, not orphaned forever');
  assert.equal(rec.parked, undefined);
  assert.match(String(rec.error), /malformed approval checkpoint/i);

  rmSync(fresh, { force: true });
  rmSync(aged, { force: true });
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

test('reapResolvedParkedRuns terminalizes a LOST registry row after the grace — but NEVER auto-approves', () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  // A watched approval id that does not exist in the registry (reaped/lost).
  const aged = writeBackdatedParkedRun('orphan-lostrow-aged', ['approval-that-was-reaped'], 27 * 60 * 60_000);
  reapResolvedParkedRuns();
  const rec = JSON.parse(readFileSync(aged, 'utf-8')) as Record<string, unknown>;
  assert.equal(rec.status, 'cancelled', 'a lost-row park past grace is closed as failed');
  assert.match(String(rec.error), /no longer exists|not performed/i, 'closed as failed — the protected action was NOT performed');
  assert.equal(/\b(approved|sent)\b/i.test(String(rec.error ?? '')), false, 'absence must NEVER read as approval');

  const fresh = writeBackdatedParkedRun('orphan-lostrow-fresh', ['approval-reaped-2'], 60_000);
  reapResolvedParkedRuns();
  assert.equal(statusOf(fresh), 'parked', 'a fresh lost-row park stays parked (a transient registry miss must not kill a live park)');

  rmSync(aged, { force: true });
  rmSync(fresh, { force: true });
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

test('reapResolvedParkedRuns marks the Activity run as resumed when approval clears', () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  const runId = 'park-test-activity';
  const sid = `workflow-gate:${runId}:send_step`;
  HarnessSession.create({ id: sid, kind: 'workflow', channel: 'workflow', title: runId, metadata: { source: 'workflow' } });
  const row = approvalRegistry.register({
    sessionId: sid,
    subject: 'Approve the send',
    tool: 'workflow_approval_gate',
    ttlMs: 60_000,
  });
  const filePath = writeParkedRun(runId, [row.approvalId]);
  runEvents.startRun({
    id: runId,
    sessionId: `workflow:${runId}`,
    channel: 'workflow',
    source: 'workflow',
    title: 'Workflow: Test Parking WF',
    message: 'Running workflow "Test Parking WF"',
  });

  approvalRegistry.resolve(row.approvalId, 'approved', 'parking-test');
  reapResolvedParkedRuns();

  const activityRun = runEvents.getRun(runId);
  assert.equal(activityRun?.status, 'running');
  assert.equal(activityRun?.events.at(-1)?.type, 'run_resumed');

  rmSync(filePath, { force: true });
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

test('pre-start missing-input workflow failure is recorded in Activity runs', async () => {
  const { writeWorkflow } = await import('../memory/workflow-store.js');
  const slug = 'prestart-missing-activity';
  const workflowName = 'Prestart Missing Activity';
  const runId = `prestart-missing-${Date.now()}`;
  writeWorkflow(slug, {
    name: workflowName,
    description: 'Requires a URL before it can run.',
    enabled: true,
    trigger: { manual: true },
    inputs: { url: { description: 'Target URL' } },
    steps: [{ id: 'fetch', prompt: 'Fetch {{input.url}}' }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(filePath, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'queued',
    inputs: {},
    createdAt: new Date().toISOString(),
  }), 'utf-8');

  await processWorkflowRuns({} as never);

  const runFile = JSON.parse(readFileSync(filePath, 'utf-8')) as { status?: string; error?: string };
  assert.equal(runFile.status, 'error');
  assert.match(runFile.error ?? '', /Missing required workflow input: url/);
  const activityRun = runEvents.getRun(runId);
  assert.equal(activityRun?.status, 'failed');
  assert.match(activityRun?.error ?? '', /Missing required workflow input: url/);
  assert.equal(activityRun?.events.at(-1)?.type, 'failed');
});

test('a corrupt project execution ledger cannot starve an independently admitted catalog run', async () => {
  const { writeWorkflow } = await import('../memory/workflow-store.js');
  const slug = 'catalog-drains-with-corrupt-project-ledger';
  const workflowName = 'Catalog Drain Isolation';
  const runId = `catalog-isolation-${Date.now()}`;
  writeWorkflow(slug, {
    name: workflowName,
    description: 'Prove the workflow lane is independent from project admission state.',
    enabled: true,
    trigger: { manual: true },
    inputs: { required: { description: 'Required input' } },
    steps: [{ id: 'work', prompt: 'Use {{input.required}}.', sideEffect: 'read' }],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'queued',
    inputs: {},
    createdAt: new Date().toISOString(),
  }), 'utf-8');
  const executionsFile = path.join(tmp, 'state', 'executions.json');
  mkdirSync(path.dirname(executionsFile), { recursive: true });
  writeFileSync(executionsFile, '{ "graphAdmission": [', 'utf-8');

  try {
    await processWorkflowRuns({} as never);
    const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as { status?: string; error?: string };
    assert.equal(terminal.status, 'error');
    assert.match(terminal.error ?? '', /Missing required workflow input: required/);
  } finally {
    rmSync(executionsFile, { force: true });
  }
});

test('fresh workflow run records a sanitized graph snapshot event', async () => {
  const { writeWorkflow } = await import('../memory/workflow-store.js');
  const { recordStepResult } = await import('../tools/step-result-tool.js');
  const slug = 'graph-snapshot-runner';
  const workflowName = 'Graph Snapshot Runner';
  const runId = `graph-snapshot-${Date.now()}`;
  writeWorkflow(slug, {
    name: workflowName,
    description: 'Records the workflow graph shape when a run starts.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      {
        id: 'pull',
        prompt: 'Return the first fixture value.',
      },
      {
        id: 'summarize',
        prompt: 'Return the dependent fixture value.',
        dependsOn: ['pull'],
      },
    ],
  });

  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const filePath = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(filePath, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'queued',
    inputs: {},
    createdAt: new Date().toISOString(),
  }), 'utf-8');

  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (options: { sessionId: string }) => {
      recordStepResult(options.sessionId, { ok: true });
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 'done', reply: 'done', done: true, nextAction: 'completed' },
      };
    }) as never,
  });
  try {
    await processWorkflowRuns({} as never);
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  const events = readWorkflowEvents(slug, runId);
  const graphEvent = events.find((event) => event.kind === 'workflow_graph_created');
  assert.ok(graphEvent, `expected workflow_graph_created, got ${events.map((event) => event.kind).join(', ')}`);
  const graph = graphEvent.meta?.graph as {
    nodes?: Array<Record<string, unknown>>;
    edges?: Array<{ source: string; target: string; type: string }>;
    entryNodeIds?: string[];
  } | undefined;
  assert.deepEqual(graph?.entryNodeIds, ['pull']);
  assert.deepEqual(graph?.nodes?.map((node) => node.id), ['pull', 'summarize']);
  assert.equal(graph?.nodes?.some((node) => Object.hasOwn(node, 'prompt')), false);
  assert.ok(graph?.edges?.some((edge) => edge.source === 'pull' && edge.target === 'summarize' && edge.type === 'dependency'));
});

test('fresh workflow run records ready batch metadata for parallel scheduler lanes', async () => {
  const { writeWorkflow } = await import('../memory/workflow-store.js');
  const { recordStepResult } = await import('../tools/step-result-tool.js');
  const slug = 'parallel-ready-runner';
  const workflowName = 'Parallel Ready Runner';
  const runId = `parallel-ready-${Date.now()}`;
  writeWorkflow(slug, {
    name: workflowName,
    description: 'Records node readiness for parallel scheduler lanes.',
    enabled: true,
    trigger: { manual: true },
    steps: Array.from({ length: 6 }, (_, index) => ({
      id: `root_${index + 1}`,
      prompt: `Return fixture value ${index + 1}.`,
    })),
  });

  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'queued',
    inputs: {},
    createdAt: new Date().toISOString(),
  }), 'utf-8');

  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (options: { sessionId: string }) => {
      recordStepResult(options.sessionId, { ok: true });
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 'done', reply: 'done', done: true, nextAction: 'completed' },
      };
    }) as never,
  });
  try {
    await processWorkflowRuns({} as never);
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }

  const ready = readWorkflowEvents(slug, runId).filter((event) => event.kind === 'workflow_node_ready');
  // Under the shared graph executor (Clem 4 Stage 3) a ready wave is PACED
  // within the wave rather than deferred to a second scheduler round: all six
  // roots belong to one wave, dispatched at most five at a time as slots free.
  // The old pin asserted 5 scheduled + 1 deferredByConcurrency across two
  // rounds; that deferral round no longer exists — the sixth root starts as
  // soon as a slot opens instead of waiting for a full batch barrier. Same
  // cap, strictly less waiting. (Deliberate re-pin, not a weakening: every
  // assertion below is still an exact equality on the new shape. Specialist
  // overlap ceilings are pinned by the graph-runtime integration suite.)
  const roundOne = ready.filter((event) => event.meta?.round === 1);
  assert.equal(roundOne.length, 6);
  assert.equal(roundOne.filter((event) => event.meta?.scheduled === true).length, 6);
  assert.equal(roundOne.filter((event) => event.meta?.deferredByConcurrency === true).length, 0);
  assert.equal(roundOne.every((event) => event.meta?.readyWidth === 6), true);
  assert.equal(roundOne.every((event) => event.meta?.concurrencyCap === 5), true);
  assert.equal(ready.filter((event) => event.meta?.round === 2).length, 0,
    'a second scheduler round appeared — the wave barrier is back');
});

test('reapResolvedParkedRuns makes a rejected approval terminal (never stuck or re-admitted)', () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  const sid2 = 'workflow-gate:park-test-2:send_step';
  HarnessSession.create({ id: sid2, kind: 'workflow', channel: 'workflow', title: 'park-test-2', metadata: { source: 'workflow' } });
  const row = approvalRegistry.register({
    sessionId: sid2,
    subject: 'Approve the send',
    tool: 'workflow_approval_gate',
    ttlMs: 60_000,
  });
  const filePath = writeParkedRun('park-test-2', [row.approvalId]);
  approvalRegistry.resolve(row.approvalId, 'rejected', 'parking-test');
  reapResolvedParkedRuns();
  assert.equal(statusOf(filePath), 'cancelled');
  rmSync(filePath, { force: true });
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

test('reapResolvedParkedRuns records system cleanup truthfully without attributing it to the user', () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  const runId = 'park-test-system-cancel';
  const sessionId = `workflow-gate:${runId}:send_step`;
  HarnessSession.create({
    id: sessionId,
    kind: 'workflow',
    channel: 'workflow',
    title: runId,
    metadata: { source: 'workflow' },
  });
  const row = approvalRegistry.register({
    sessionId,
    subject: 'Approve the send',
    tool: 'workflow_approval_gate',
    ttlMs: 60_000,
  });
  const filePath = writeParkedRun(runId, [row.approvalId]);
  approvalRegistry.resolve(row.approvalId, 'cancelled_by_system', 'reaper-dead-session');

  reapResolvedParkedRuns();

  const record = JSON.parse(readFileSync(filePath, 'utf-8')) as { status?: string; error?: string };
  assert.equal(record.status, 'cancelled');
  assert.match(record.error ?? '', /owning session ended/);
  assert.doesNotMatch(record.error ?? '', /cancelled by the user/);
  rmSync(filePath, { force: true });
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

test('reapResolvedParkedRuns is a no-op when WORKFLOW_APPROVAL_PARKING is off (kill-switch)', () => {
  // Parking now defaults ON (P1-7), so the kill-switch must be set EXPLICITLY to
  // get the legacy no-scan behavior (was: rely on the default).
  process.env.WORKFLOW_APPROVAL_PARKING = 'off';
  const filePath = writeParkedRun('park-test-off', ['apr-irrelevant']);
  reapResolvedParkedRuns();
  assert.equal(statusOf(filePath), 'parked'); // scan disabled → untouched
  rmSync(filePath, { force: true });
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

// ── D: contract binding (parse JSON-text output + inject the shape) ──────────

const objContract = { type: 'object', required_keys: ['proposed_prospects', 'existing_airtable_count', 'dedupe_summary'] } as never;

test('coerceOutputForContract: no contract → output unchanged', () => {
  assert.equal(coerceOutputForContract('just text', undefined), 'just text');
});

test('coerceOutputForContract: an already-structured object is returned as-is', () => {
  const o = { proposed_prospects: [], existing_airtable_count: 0, dedupe_summary: 'x' };
  assert.equal(coerceOutputForContract(o, objContract), o);
});

test('coerceOutputForContract: a JSON-TEXT output is parsed into the object (the live failure)', () => {
  const text = '{"proposed_prospects":[{"account_name":"Acme"}],"existing_airtable_count":3,"dedupe_summary":"ok"}';
  const out = coerceOutputForContract(text, objContract);
  assert.equal(typeof out, 'object');
  assert.equal((out as { existing_airtable_count: number }).existing_airtable_count, 3);
  assert.equal(((out as { proposed_prospects: unknown[] }).proposed_prospects).length, 1);
});

test('coerceOutputForContract: a fenced ```json block is parsed', () => {
  const text = 'Here you go:\n```json\n{"proposed_prospects":[],"existing_airtable_count":0,"dedupe_summary":"none"}\n```';
  const out = coerceOutputForContract(text, objContract);
  assert.equal((out as { dedupe_summary: string }).dedupe_summary, 'none');
});

test('coerceOutputForContract: JSON embedded in surrounding prose is extracted', () => {
  const text = 'Done. {"proposed_prospects":[],"existing_airtable_count":1,"dedupe_summary":"d"} — that is the batch.';
  const out = coerceOutputForContract(text, objContract);
  assert.equal((out as { existing_airtable_count: number }).existing_airtable_count, 1);
});

test('coerceOutputForContract: non-JSON text is returned unchanged (verifier then fails loudly, as before)', () => {
  assert.equal(coerceOutputForContract('I could not find any prospects.', objContract), 'I could not find any prospects.');
});

test('coerceOutputForContract: a type:"string" contract is NEVER coerced — a JSON-looking string stays a string (regression #1)', () => {
  const strContract = { type: 'string' } as never;
  assert.equal(coerceOutputForContract('{"a":1}', strContract), '{"a":1}');
  assert.equal(coerceOutputForContract('[1,2,3]', strContract), '[1,2,3]');
});

test('coerceOutputForContract: a parse that does NOT satisfy the contract is rejected (no wrong-pass, regression #2)', () => {
  // objContract requires proposed_prospects/existing_airtable_count/dedupe_summary.
  // A JSON object WITHOUT those keys must NOT be accepted — return the original
  // so the verifier fails loudly instead of binding a wrong-shaped object.
  const wrong = '{"reply":"found some","summary":"3 prospects"}';
  assert.equal(coerceOutputForContract(wrong, objContract), wrong);
});

test('describeOutputShape: names the actual produced shape (so a contract failure is diagnosable)', () => {
  assert.match(describeOutputShape({ reply: 'x', summary: 'y' }), /object with keys: reply, summary/);
  assert.match(describeOutputShape([1, 2, 3]), /array \(3 items\)/);
  assert.match(describeOutputShape('hello world'), /string \(11 chars\)/);
  assert.equal(describeOutputShape(null), 'null');
});

test('inferredOutputContractAdvisory: accepts legacy prose with concrete URL evidence', () => {
  const note = inferredOutputContractAdvisory(
    { id: 'publish', prompt: 'Build and publish the website page URL.' } as never,
    'Published at https://example.com/landing',
  );
  assert.equal(note, null);
});

test('inferredOutputContractAdvisory: accepts legacy prose with an existing file path', () => {
  const filePath = path.join(tmp, 'legacy-report.md');
  writeFileSync(filePath, '# Report\n', 'utf-8');
  const note = inferredOutputContractAdvisory(
    { id: 'report', prompt: 'Create an HTML file and output the file path.' } as never,
    `Saved to ${filePath}.`,
  );
  assert.equal(note, null);
});

test('inferredOutputContractAdvisory: flags a legacy deliverable step with no list evidence', () => {
  const note = inferredOutputContractAdvisory(
    { id: 'leads', prompt: 'Generate a list of weekly leads.' } as never,
    'No leads found.',
  );
  assert.match(note ?? '', /non-empty list/);
  assert.match(note ?? '', /produced string/);
});

test('inferredOutputContractAdvisory: explicit output contracts own their own enforcement path', () => {
  const note = inferredOutputContractAdvisory(
    {
      id: 'leads',
      prompt: 'Generate a list of weekly leads.',
      output: { type: 'object', required_keys: ['items'], non_empty: ['items'] },
    } as never,
    { items: [] },
  );
  assert.equal(note, null);
});

test('workflowAdvisoryRequiresAttention: confident quality misses are not clean success', () => {
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'target_missed' }), true);
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'foreach_overflow' }), true);
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'skill_not_executed' }), true);
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'idempotent_skip' }), true);
  // Move 3: a Claude-lane figure that contradicts the run's own tool results is
  // the trust-killer — it must surface for review, never pass as clean success.
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'ungrounded_output' }), true);
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'inferred_output_contract' }), true);
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'goal_validation_unavailable' }), false);
  // Tier-1 item 3: a judge OUTAGE on a legacy run is reported honestly as
  // "completed unverified" — but an infra blip must NEVER flip a good run to
  // blocked, so the advisory is informational by construction.
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'target_unverified' }), false);
  // T1.2: a degraded synthesis rollup is a presentation loss, not a failed run —
  // every step already completed and verified.
  assert.equal(workflowAdvisoryRequiresAttention({ kind: 'synthesis_degraded' }), false);
});

test('workflowReportLaneForOutcome: non-review advisories stay on done lane', () => {
  assert.equal(workflowReportLaneForOutcome({
    needsAttention: false,
    advisories: [{ kind: 'goal_validation_unavailable' }],
  }), 'done');
  assert.equal(workflowReportLaneForOutcome({
    needsAttention: false,
    advisories: [{ kind: 'skill_not_executed' }],
  }), 'blocked');
  assert.equal(workflowReportLaneForOutcome({
    needsAttention: true,
    advisories: [{ kind: 'goal_validation_unavailable' }],
  }), 'blocked');
});

test('applyContractToPrompt: no contract → prompt unchanged', () => {
  assert.equal(applyContractToPrompt({ id: 'a', prompt: 'do' }, 'do'), 'do');
});

test('applyContractToPrompt: injects the EXACT required keys so the agent knows the shape', () => {
  const out = applyContractToPrompt({ id: 'a', prompt: 'do', output: objContract } as never, 'find prospects');
  assert.match(out, /REQUIRED OUTPUT/);
  assert.match(out, /"proposed_prospects"/);
  assert.match(out, /"existing_airtable_count"/);
  assert.match(out, /"dedupe_summary"/);
  assert.ok(out.startsWith('find prospects'), 'the task text is preserved first');
});

test('applyContractToPrompt: surfaces url_present as a hard requirement', () => {
  const c = { type: 'object', required_keys: ['airtable_table_url'], verify: { url_present: ['airtable_table_url'] } } as never;
  const out = applyContractToPrompt({ id: 'w', prompt: 'write', output: c } as never, 'write records');
  assert.match(out, /https:\/\/ URL/i);
  assert.match(out, /airtable_table_url/);
});

test('applySkillToPrompt: no usesSkill returns prompt unchanged', () => {
  const out = applySkillToPrompt(
    { id: 'a', prompt: 'do thing' },
    'do thing',
  );
  assert.equal(out, 'do thing');
});

test('applySkillToPrompt: injects skill body when usesSkill resolves', () => {
  const out = applySkillToPrompt(
    { id: 'a', prompt: 'do thing', usesSkill: 'test-skill' },
    'do thing carefully',
  );
  assert.ok(out.includes('=== SKILL: test-skill ==='), 'skill header present');
  assert.ok(out.includes('Do the thing carefully.'), 'skill body present');
  assert.ok(out.includes('=== STEP TASK ==='), 'task delimiter present');
  assert.ok(out.includes('do thing carefully'), 'rendered prompt preserved');
  // Skill must come BEFORE task so the model reads the instructions first.
  assert.ok(out.indexOf('=== SKILL') < out.indexOf('=== STEP TASK'), 'skill precedes task');
});

test('applySkillToPrompt: missing skill fails loud (no silent downgrade)', () => {
  assert.throws(
    () => applySkillToPrompt(
      { id: 'a', prompt: 'do thing', usesSkill: 'does-not-exist' },
      'do thing carefully',
    ),
    /does-not-exist/,
    'a missing declared skill must throw so the step fails and reports back, not run the raw prompt',
  );
});

test('applySkillToPrompt: empty usesSkill string is treated as unset', () => {
  const out = applySkillToPrompt(
    { id: 'a', prompt: 'do thing', usesSkill: '   ' },
    'do thing carefully',
  );
  assert.equal(out, 'do thing carefully');
});

test('renderWorkflowOriginLineageBlock includes harness transcript/action ledger and ignores legacy ghosts', () => {
  resetEventLog();
  const sid = 'workflow-origin-lineage';
  HarnessSession.create({ id: sid, kind: 'chat', channel: 'desktop', title: 'Origin chat' });
  appendEvent({ sessionId: sid, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Use the approved Denver list only.' } });
  appendEvent({ sessionId: sid, turn: 1, role: 'system', type: 'external_write', data: { shapeKey: 'OUTLOOK_SEND_EMAIL', targets: ['casey@example.com'] } });
  appendEvent({ sessionId: sid, turn: 1, role: 'system', type: 'conversation_completed', data: { reply: 'Sent Casey once and saved the follow-up brief.' } });
  new RunnerSessionStore().appendTurn(sid, {
    role: 'user',
    text: '[workflow run wf-ghost completed] synthetic ghost only',
    createdAt: new Date().toISOString(),
  });

  const out = workflowRunnerInternalsForTest.renderWorkflowOriginLineageBlock(sid);

  assert.match(out, /ORIGIN SESSION LINEAGE/);
  assert.match(out, /USER: Use the approved Denver list only/);
  assert.match(out, /YOU: Sent Casey once/);
  assert.match(out, /ALREADY DONE/);
  assert.match(out, /OUTLOOK_SEND_EMAIL/);
  assert.match(out, /casey@example\.com/);
  assert.doesNotMatch(out, /wf-ghost/);
});

// ---------------------------------------------------------------------------
// Gap A — a step that ends in any non-`completed` harness status must report
// back honestly, never be captured as prose-success. The throw in
// runStepViaHarness uses describeStepNonCompletion for a legible message; the
// outer processOneRunFile catch then classifies cancel-vs-error. (The
// behavioral throw is verified live; here we lock the message contract that
// drives the report-back.)
// ---------------------------------------------------------------------------

test('describeStepNonCompletion: limit_exceeded explains the guardrail/budget stop', () => {
  const msg = describeStepNonCompletion('limit_exceeded');
  assert.match(msg, /guardrail|loop|budget|limit/i);
  assert.ok(!/unknown/i.test(msg), 'must be specific, not a generic placeholder');
});

test('describeStepNonCompletion: killed explains the abort', () => {
  assert.match(describeStepNonCompletion('killed'), /abort/i);
});

test('describeStepNonCompletion: awaiting_user_input names the background-workflow limitation + the fix', () => {
  const msg = describeStepNonCompletion('awaiting_user_input');
  assert.match(msg, /user input/i);
  assert.match(msg, /requiresApproval|input/i, 'should point at the actionable remedy');
});

test('describeStepNonCompletion: failed describes an unhandled error', () => {
  assert.match(describeStepNonCompletion('failed'), /error/i);
});

test('describeStepNonCompletion: an explicit harness error takes precedence over the canned reason', () => {
  const msg = describeStepNonCompletion('limit_exceeded', 'tool AIRTABLE_LIST repeated 7x');
  assert.equal(msg, 'tool AIRTABLE_LIST repeated 7x');
});

test('describeStepNonCompletion: a blank error falls back to the status reason (no empty report)', () => {
  const msg = describeStepNonCompletion('killed', '   ');
  assert.match(msg, /abort/i, 'whitespace-only error must not produce an empty report-back');
});

test('describeStepNonCompletion: an unknown future status still yields a non-empty reason', () => {
  const msg = describeStepNonCompletion('some_new_status');
  assert.ok(msg.length > 0);
  assert.match(msg, /some_new_status/);
});

test('looksLikeWorkflowStepStructuralResultMiss: catches no-live-tool and result-channel prose', () => {
  assert.equal(
    looksLikeWorkflowStepStructuralResultMiss(
      'This execution context has no live tool access, so I cannot call workflow_step_result for this step.',
    ),
    true,
  );
  assert.equal(
    looksLikeWorkflowStepStructuralResultMiss(
      "I can't continue the workflow step from that interrupted tool state here. Please rerun the step so I can call workflow_step_result.",
    ),
    true,
  );
  assert.equal(
    looksLikeWorkflowStepStructuralResultMiss(
      "I can't complete this step because workflow_step_result is not exposed in this text-only subprocess.",
    ),
    true,
  );
  assert.equal(
    looksLikeWorkflowStepStructuralResultMiss({ blocked: true, reason: 'source returned no rows' }),
    false,
    'honest structured blockers must flow through as step data, not a harness structural miss',
  );
  assert.equal(looksLikeWorkflowStepStructuralResultMiss('{"accounts":[]}'), false);
});

test('runWithStepRetry: workflow structural result miss is retryable when opted in', async () => {
  let attempts = 0;
  const retryReasons: string[] = [];
  const out = await runWithStepRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new WorkflowStepStructuralResultError(
          'find_or_create_tracker',
          'This execution context has no live tool access, so I cannot call workflow_step_result.',
        );
      }
      return { ok: true };
    },
    {
      budget: 1,
      backoffBaseMs: 1,
      isRetryable: isWorkflowStepStructuralResultError,
      onRetry: ({ err }) => retryReasons.push(isWorkflowStepStructuralResultError(err) ? 'structural_result' : 'other'),
      sleep: async () => undefined,
    },
  );

  assert.deepEqual(out, { ok: true });
  assert.equal(attempts, 2);
  assert.deepEqual(retryReasons, ['structural_result']);
});

// ---------------------------------------------------------------------------
// Gap E — enqueueWorkflowOutcomeTurn: re-enter the origin chat in-context.
// ---------------------------------------------------------------------------

test('enqueueWorkflowOutcomeTurn: appends ONE role:user outcome turn to the origin session', () => {
  assert.equal(
    enqueueWorkflowOutcomeTurn({ id: 'gapE-1', workflow: 'wf' as never, originSessionId: 'sessE1' }, 'My WF', 'done', 'the deliverable'),
    true,
  );
  const turns = new RunnerSessionStore().get('sessE1').turns;
  const mine = turns.filter((t: { text?: string }) => typeof t.text === 'string' && t.text.startsWith('[workflow run gapE-1 '));
  assert.equal(mine.length, 1, 'exactly one outcome turn');
  assert.equal(mine[0].role, 'user');
  assert.match(mine[0].text, /completed]/);
  assert.match(mine[0].text, /the deliverable/);
});

test('enqueueWorkflowOutcomeTurn: idempotent — a second call (drain retry / restart) does not double-post', () => {
  assert.equal(enqueueWorkflowOutcomeTurn({ id: 'gapE-2', workflow: 'wf' as never, originSessionId: 'sessE2' }, 'My WF', 'done', 'r'), true);
  assert.equal(
    enqueueWorkflowOutcomeTurn({ id: 'gapE-2', workflow: 'wf' as never, originSessionId: 'sessE2' }, 'My WF', 'done', 'r'),
    true,
    'an idempotent duplicate still acknowledges durable delivery',
  );
  const turns = new RunnerSessionStore().get('sessE2').turns;
  assert.equal(turns.filter((t: { text?: string }) => typeof t.text === 'string' && t.text.startsWith('[workflow run gapE-2 ')).length, 1);
});

test('enqueueWorkflowOutcomeTurn: duplicate observer origins each receive one report-back', () => {
  const run = {
    id: 'gapE-multi',
    workflow: 'wf' as never,
    originSessionId: 'sessE-multi-a',
    originSessionIds: ['sessE-multi-a', 'sessE-multi-b', 'sessE-multi-b'],
  };

  enqueueWorkflowOutcomeTurn(run, 'My WF', 'done', 'the deliverable');
  enqueueWorkflowOutcomeTurn(run, 'My WF', 'done', 'the deliverable');

  for (const sessionId of ['sessE-multi-a', 'sessE-multi-b']) {
    const turns = new RunnerSessionStore().get(sessionId).turns;
    const mine = turns.filter((t: { text?: string }) => typeof t.text === 'string' && t.text.startsWith('[workflow run gapE-multi '));
    assert.equal(mine.length, 1, `${sessionId} gets exactly one report-back`);
    assert.match(mine[0].text, /the deliverable/);
  }
});

// shouldNotifyCancelledRun — backlog-spam guard (review must-fix #1)
const NOW = 1_780_000_000_000;
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

test('shouldNotifyCancelledRun: a RECENT, un-reported cancel → notify', () => {
  assert.equal(shouldNotifyCancelledRun({ id: 'c1', finishedAt: isoAgo(60_000) }, NOW, new Set()), true);
});

test('shouldNotifyCancelledRun: a STALE cancel (older than 12h) → do NOT re-notify (the backlog-sweep bug)', () => {
  assert.equal(shouldNotifyCancelledRun({ id: 'c2', finishedAt: isoAgo(6 * 24 * 60 * 60_000) }, NOW, new Set()), false);
  // falls back to createdAt when finishedAt is absent
  assert.equal(shouldNotifyCancelledRun({ id: 'c3', createdAt: isoAgo(13 * 60 * 60_000) }, NOW, new Set()), false);
});

test('shouldNotifyCancelledRun: an already-reported cancel → do NOT double-notify', () => {
  assert.equal(shouldNotifyCancelledRun({ id: 'c4', finishedAt: isoAgo(60_000) }, NOW, new Set(['c4'])), false);
});

test('shouldNotifyCancelledRun: a recent cancel with an unparseable timestamp still notifies (fresh, not stale)', () => {
  assert.equal(shouldNotifyCancelledRun({ id: 'c5' }, NOW, new Set()), true);
});

test('enqueueWorkflowOutcomeTurn: NO originSessionId → no-op (scheduled/cron stay notification-only)', () => {
  // Must not throw and must not create a turn anywhere addressable.
  assert.doesNotThrow(() => enqueueWorkflowOutcomeTurn({ id: 'gapE-3', workflow: 'wf' as never }, 'My WF', 'done', 'r'));
});

test('enqueueWorkflowOutcomeTurn: failed/blocked outcomes carry the right in-context guidance', () => {
  enqueueWorkflowOutcomeTurn({ id: 'gapE-4', workflow: 'wf' as never, originSessionId: 'sessE4' }, 'My WF', 'failed', 'boom');
  enqueueWorkflowOutcomeTurn({ id: 'gapE-5', workflow: 'wf' as never, originSessionId: 'sessE5' }, 'My WF', 'blocked', 'gap');
  const f = new RunnerSessionStore().get('sessE4').turns.find((t: { text?: string }) => t.text?.startsWith('[workflow run gapE-4 '));
  const b = new RunnerSessionStore().get('sessE5').turns.find((t: { text?: string }) => t.text?.startsWith('[workflow run gapE-5 '));
  assert.match(f!.text, /FAILED]/);
  assert.match(f!.text, /did NOT complete/i);
  assert.match(b!.text, /needs attention]/);
  assert.match(b!.text, /NEEDS ATTENTION/i);
});

test('planWorkflowExecutionBatches: fans out independent dependsOn branches', () => {
  const batches = planWorkflowExecutionBatches([
    { id: 'normalize', prompt: 'normalize' },
    { id: 'site', prompt: 'site', dependsOn: ['normalize'] },
    { id: 'seo', prompt: 'seo', dependsOn: ['normalize'] },
    { id: 'reviews', prompt: 'reviews', dependsOn: ['normalize'] },
    { id: 'aggregate', prompt: 'aggregate', dependsOn: ['site', 'seo', 'reviews'] },
    { id: 'render', prompt: 'render', dependsOn: ['aggregate'] },
  ]);

  assert.deepEqual(
    batches.map((batch) => batch.map((step) => step.id)),
    [
      ['normalize'],
      ['site', 'seo', 'reviews'],
      ['aggregate'],
      ['render'],
    ],
  );
});

test('planWorkflowExecutionBatches: resumes after completed steps', () => {
  const batches = planWorkflowExecutionBatches([
    { id: 'normalize', prompt: 'normalize' },
    { id: 'site', prompt: 'site', dependsOn: ['normalize'] },
    { id: 'seo', prompt: 'seo', dependsOn: ['normalize'] },
    { id: 'aggregate', prompt: 'aggregate', dependsOn: ['site', 'seo'] },
  ], new Set(['normalize', 'site']));

  assert.deepEqual(
    batches.map((batch) => batch.map((step) => step.id)),
    [
      ['seo'],
      ['aggregate'],
    ],
  );
});

test('planWorkflowExecutionBatches: rejects cyclic graphs', () => {
  assert.throws(
    () => planWorkflowExecutionBatches([
      { id: 'a', prompt: 'a', dependsOn: ['b'] },
      { id: 'b', prompt: 'b', dependsOn: ['a'] },
    ]),
    /blocked or cyclic/,
  );
});

test('bindStepContext carries dependsOn outputs even without explicit step inputs', () => {
  const ctx = {
    inputs: {},
    stepOutputs: {
      fetch_accounts: { rows: [{ id: 'A1', domain: 'example.com' }], count: 1 },
      unrelated: { ignored: true },
    },
    workflowSlug: 'test-workflow',
    runId: 'run-context-test',
  };

  const bound = workflowRunnerInternalsForTest.bindStepContext(
    { id: 'summarize', prompt: 'Summarize the fetched accounts.', dependsOn: ['fetch_accounts'] },
    ctx as never,
  );

  assert.ok(bound);
  assert.deepEqual(bound, {
    values: {},
    upstream: {
      fetch_accounts: { rows: [{ id: 'A1', domain: 'example.com' }], count: 1 },
    },
    item: undefined,
  });
  const rendered = workflowRunnerInternalsForTest.renderStepContextBlock(bound);
  assert.match(rendered, /STEP CONTEXT/);
  assert.match(rendered, /fetch_accounts/);
  assert.match(rendered, /example\.com/);
  assert.doesNotMatch(rendered, /unrelated/);
});

test('renderStepContextBlock offloads large upstream values to the run workspace with a read_file path', () => {
  const rows = Array.from({ length: 260 }, (_, i) => ({
    id: `A${i}`,
    domain: `domain-${i}.example.com`,
    notes: `context payload ${i} ${'x'.repeat(70)}`,
  }));
  const lastNeedle = 'domain-259.example.com';
  const largeOutput = { rows, count: rows.length };
  assert.ok(JSON.stringify(largeOutput).length > 8000, 'fixture must exceed inline context clip threshold');

  const bound = workflowRunnerInternalsForTest.bindStepContext(
    { id: 'select', prompt: 'Select the best accounts.', dependsOn: ['fetch_accounts'] },
    {
      inputs: {},
      stepOutputs: { fetch_accounts: largeOutput },
      workflowSlug: 'context-offload-workflow',
      runId: 'run-context-offload',
    } as never,
  );

  assert.ok(bound);
  const rendered = workflowRunnerInternalsForTest.renderStepContextBlock(bound, {
    workflowName: 'context-offload-workflow',
    runId: 'run-context-offload',
    nowIso: '2026-07-09T00:00:00.000Z',
  });

  assert.match(rendered, /__clementine_context_ref/);
  assert.match(rendered, /workspace_artifact_query/);
  assert.match(rendered, /read_file/);
  assert.doesNotMatch(rendered, new RegExp(lastNeedle), 'large tail data should live in the artifact, not the prompt');

  const pathMatch = rendered.match(/"path": "([^"]+)"/);
  assert.ok(pathMatch?.[1], 'offloaded context must include an absolute artifact path');
  const artifact = readFileSync(pathMatch[1], 'utf-8');
  assert.match(artifact, new RegExp(lastNeedle), 'artifact carries the exact full upstream payload');
});

test('compiled invocation binds artifact authority to rendered DAG dependencies only', () => {
  const workflowName = 'dag-bound-artifact-workflow';
  const runId = 'dag-bound-artifact-run';
  const large = (label: string) => ({
    rows: Array.from({ length: 260 }, (_, index) => ({
      index,
      value: `${label}-${index}-${'x'.repeat(80)}`,
    })),
  });
  const declared = large('DECLARED');
  const completedSibling = large('PRIVATE-SIBLING');
  const declaredArtifact = finalizeStepOutput(
    workflowName,
    runId,
    { id: 'declared_source', prompt: 'Source.' } as never,
    declared,
  );
  finalizeStepOutput(
    workflowName,
    runId,
    { id: 'completed_sibling', prompt: 'Sibling.' } as never,
    completedSibling,
  );

  const invocation = workflowRunnerInternalsForTest.renderStepContextForInvocation(
    { values: {}, upstream: { declared_source: declared } },
    { workflowName, runId, nowIso: '2026-08-02T00:00:00.000Z' },
  );
  const refs = invocation.graphContext.allowedArtifacts;
  assert.equal(refs.length, 1, 'only the dependency rendered for this invocation grants a read');
  assert.match(refs[0].path, /step-declared_source-[a-f0-9]{64}\.json$/);
  assert.equal(refs[0].sha256.length, 64);
  assert.ok(refs[0].bytes > 8_000);
  assert.doesNotMatch(JSON.stringify(refs), /completed_sibling|PRIVATE-SIBLING/);
  assert.match(invocation.block, /"sha256": "[a-f0-9]{64}"/);
  assert.doesNotMatch(invocation.block, /read_file/, 'compiled context advertises only its bound query helper');
  assert.deepEqual(declaredArtifact, declared, 'context rendering never changes the completed output');
});

test('large fan-out values with the same logical key receive distinct immutable refs', () => {
  const workflowName = 'fanout-context-addressing';
  const runId = 'fanout-context-addressing-run';
  const makeItem = (label: string) => ({
    id: label,
    body: `${label}:${'z'.repeat(9_000)}`,
  });
  const first = workflowRunnerInternalsForTest.renderStepContextForInvocation(
    { values: {}, upstream: {}, item: makeItem('FIRST') },
    { workflowName, runId, nowIso: '2026-08-02T00:00:00.000Z' },
  );
  const second = workflowRunnerInternalsForTest.renderStepContextForInvocation(
    { values: {}, upstream: {}, item: makeItem('SECOND') },
    { workflowName, runId, nowIso: '2026-08-02T00:00:01.000Z' },
  );
  const firstRef = first.graphContext.allowedArtifacts[0];
  const secondRef = second.graphContext.allowedArtifacts[0];
  assert.ok(firstRef && secondRef);
  assert.notEqual(firstRef.path, secondRef.path);
  assert.notEqual(firstRef.sha256, secondRef.sha256);
  assert.match(readFileSync(path.join(runWorkspaceDir(workflowName, runId), firstRef.path), 'utf8'), /FIRST/);
  assert.match(readFileSync(path.join(runWorkspaceDir(workflowName, runId), secondRef.path), 'utf8'), /SECOND/);
});

test('final synthesis and goal evidence render large completed outputs as queryable step artifacts', () => {
  const rows = Array.from({ length: 260 }, (_, i) => ({
    id: `A${i}`,
    domain: `domain-${i}.example.com`,
    notes: `synthesis payload ${i} ${'x'.repeat(70)}`,
  }));
  const lastNeedle = 'domain-259.example.com';
  const largeOutput = { rows, count: rows.length };
  const workflowName = 'synthesis-artifact-workflow';
  const runId = 'run-synthesis-artifact';
  finalizeStepOutput(
    workflowName,
    runId,
    { id: 'fetch_accounts', prompt: 'Fetch accounts.' } as never,
    largeOutput,
  );

  const opts = { workflowName, runId, nowIso: '2026-07-09T00:00:00.000Z' };
  const rendered = workflowRunnerInternalsForTest.formatStepOutputs(
    [{ id: 'fetch_accounts', prompt: 'Fetch accounts.' }] as never,
    { fetch_accounts: largeOutput },
    opts,
  );

  assert.match(rendered, /__clementine_context_ref/);
  assert.match(rendered, /workspace_artifact_query/);
  assert.match(
    rendered,
    /artifacts\/step-fetch_accounts-[a-f0-9]{64}\.json/,
    'completion context points at the immutable content-addressed artifact',
  );
  assert.doesNotMatch(rendered, new RegExp(lastNeedle), 'large tail data should stay in the artifact during synthesis');

  const pathMatch = rendered.match(/"path": "([^"]+)"/);
  assert.ok(pathMatch?.[1], 'synthesis handoff must include an absolute artifact path');
  const artifact = readFileSync(pathMatch[1], 'utf-8');
  assert.match(artifact, new RegExp(lastNeedle), 'artifact carries the exact full completed step output');

  const evidence = workflowRunnerInternalsForTest.buildGoalEvidenceText('Final summary.', { fetch_accounts: largeOutput }, opts);
  assert.match(evidence, /workspace_artifact_query/);
  assert.match(evidence, /Artifact:/);
  assert.match(evidence, /Preview:/);
  assert.doesNotMatch(evidence, new RegExp(lastNeedle), 'goal evidence stays bounded and points to the artifact');
});

test('downstream context selects the event-authorized artifact, never a later orphan', () => {
  const workflowName = 'authorized-artifact-workflow';
  const runId = 'authorized-artifact-run';
  const step = { id: 'source', prompt: 'Produce source rows.' } as never;
  const authorized = {
    rows: Array.from({ length: 380 }, (_, index) => ({
      index,
      value: `${'a'.repeat(90)}${index === 379 ? 'AUTHORIZED-TAIL' : index}`,
    })),
  };
  const orphan = {
    rows: Array.from({ length: 380 }, (_, index) => ({
      index,
      value: `${'b'.repeat(90)}${index === 379 ? 'ORPHAN-TAIL' : index}`,
    })),
  };
  finalizeStepOutput(workflowName, runId, step, authorized);
  recordStepOutput({
    workflowName,
    runId,
    stepId: 'source',
    output: orphan,
    nowIso: new Date().toISOString(),
  });

  const rendered = workflowRunnerInternalsForTest.formatStepOutputs(
    [step],
    { source: authorized },
    { workflowName, runId },
  );
  const pathMatch = rendered.match(/"path": "([^"]+)"/);
  assert.ok(pathMatch?.[1]);
  const selected = readFileSync(pathMatch[1], 'utf-8');
  assert.match(selected, /AUTHORIZED-TAIL/);
  assert.doesNotMatch(selected, /ORPHAN-TAIL/);
});

test('terminal run projection stays bounded while exact large outputs remain artifact-backed', () => {
  const workflowName = 'bounded-terminal-workflow';
  const runId = 'bounded-terminal-run';
  const output = {
    rows: Array.from({ length: 1_200 }, (_, index) => ({
      index,
      value: `${'z'.repeat(120)}${index === 1_199 ? 'TERMINAL-EXACT-TAIL' : index}`,
    })),
  };
  finalizeStepOutput(
    workflowName,
    runId,
    { id: 'large', prompt: 'Produce a large exact result.' } as never,
    output,
  );
  const projection = workflowRunnerInternalsForTest.boundedStepOutputsForRunRecord(
    { large: output },
    { workflowName, runId },
  );
  assert.ok(Buffer.byteLength(JSON.stringify(projection), 'utf-8') < 20_000);
  assert.match(projection.large, /__clementine_context_ref/);
  assert.doesNotMatch(projection.large, /TERMINAL-EXACT-TAIL/);
});

test('goal evidence preserves line count and scalar metadata after wide arrays', () => {
  const evidence = workflowRunnerInternalsForTest.buildGoalEvidenceText(
    'Pulled 5 candidates.\nPrepared 1 account.\nVerified row 29.\nTracker: https://example.test/sheet',
    {
      tracker: {
        spreadsheetId: 'sheet-1',
        columns: Array.from({ length: 70 }, (_, index) => `Column ${index + 1}`),
        gridRowCount: 1009,
        nextAppendRow: 98,
        existingRows: [{ rowNumber: 29, accountId: 'acct-1', domain: 'example.test' }],
        duplicateMatches: [{ stableKey: 'acct-1', canonicalRowNumber: 29, ignoredRowNumbers: [13, 28] }],
      },
    },
  );

  assert.match(evidence, /FINAL OUTPUT \(4 non-empty lines\)/);
  assert.match(evidence, /"columns": \{ "count": 70/);
  assert.match(evidence, /"gridRowCount": 1009/);
  assert.match(evidence, /"nextAppendRow": 98/);
  assert.match(evidence, /"existingRows": \{ "count": 1/);
  assert.match(evidence, /"duplicateMatches": \{ "count": 1/);
  assert.match(evidence, /reached step_completed after blocked\/error detection/);
});

test('goal evidence keeps trailing proof fields when a nested provider string is long', () => {
  const evidence = workflowRunnerInternalsForTest.buildGoalEvidenceText('Done.', {
    tracker: {
      spreadsheetId: 'sheet-1',
      existingRows: [{
        rowNumber: 29,
        accountId: 'acct-1',
        seoSource: `provider detail ${'x'.repeat(2_000)}`,
      }],
      duplicateMatches: [{ stableKey: 'acct-1', canonicalRowNumber: 29, ignoredRowNumbers: [13, 28] }],
    },
  });

  assert.match(evidence, /"spreadsheetId": "sheet-1"/);
  assert.match(evidence, /"duplicateMatches": \{ "count": 1/);
});

test('goal evidence prioritizes proof fields after more than thirty top-level fields', () => {
  const output = Object.fromEntries([
    ...Array.from({ length: 35 }, (_, index) => [`providerField${index + 1}`, `value-${index + 1}`]),
    ['verifiedCount', 1],
    ['protectedFieldsUnchanged', true],
  ]);
  const evidence = workflowRunnerInternalsForTest.buildGoalEvidenceText('Done.', { upsert: output });

  assert.match(evidence, /"verifiedCount": 1/);
  assert.match(evidence, /"protectedFieldsUnchanged": true/);
});

test('goal evidence derives its blocked/error claim from the step outputs it lists', () => {
  const blockedEvidence = workflowRunnerInternalsForTest.buildGoalEvidenceText('Partial.', {
    pull: { rows: [{ id: 1 }] },
    upsert: { blocked: true, reason: 'tracker has zero data rows' },
  });
  assert.doesNotMatch(blockedEvidence, /No listed step (returned|result carries) blocked:true/);
  assert.match(blockedEvidence, /upsert/);
  assert.match(blockedEvidence, /NOT verified successes/i);

  const cleanEvidence = workflowRunnerInternalsForTest.buildGoalEvidenceText('Done.', {
    pull: { rows: [{ id: 1 }] },
    upsert: { verifiedCount: 1 },
  });
  assert.match(cleanEvidence, /No listed step result carries blocked:true/);
});

test('workflow step model route uses the intent-bound worker model and trace metadata', () => {
  withEnv({
    AUTH_MODE: 'codex_oauth',
    MODEL_ROUTING_MODE: undefined,
    BYO_MODEL_BASE_URL: 'https://api.example.test',
    BYO_MODEL_API_KEY: 'k',
    BYO_MODEL_ID: 'minimax-01',
    CLEMMY_MODEL_ROLES_REGISTRY: 'on',
    CLEMMY_WORKER_INTENT_ROUTING: 'on',
    CLEMMY_MODEL_ROLES: JSON.stringify([
      { role: 'worker', modelId: 'minimax-01', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
    ]),
  }, () => {
    const route = workflowRunnerInternalsForTest.resolveWorkflowStepModel({
      id: 'design',
      prompt: 'Design the hero.',
      intent: 'design',
    });
    assert.equal(route.model, 'minimax-01');
    assert.deepEqual(route.trace, {
      seam: 'workflow',
      stepId: 'design',
      attemptedIntent: 'design',
      matchedIntent: 'design',
      modelId: 'minimax-01',
      provider: 'byo',
      source: 'chat-rule',
    });
  });
});

test('workflow step explicit model wins over intent routing', () => {
  withEnv({
    BYO_MODEL_BASE_URL: 'https://api.example.test',
    BYO_MODEL_API_KEY: 'k',
    BYO_MODEL_ID: 'minimax-01',
    CLEMMY_MODEL_ROLES: JSON.stringify([
      { role: 'worker', modelId: 'minimax-01', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
    ]),
  }, () => {
    const route = workflowRunnerInternalsForTest.resolveWorkflowStepModel({
      id: 'design',
      prompt: 'Design the hero.',
      intent: 'design',
      model: 'gpt-5.5',
    });
    assert.equal(route.model, 'gpt-5.5');
    assert.equal(route.trace, undefined);
  });
});

test('normal harness route marker always names provider + transport for untagged Codex and BYO steps', () => {
  const codex = workflowRunnerInternalsForTest.workflowHarnessRouteMarker(
    { id: 'untagged_codex', prompt: 'Do the step.' },
    'gpt-5.4',
  );
  assert.equal(codex.provider, 'codex');
  assert.equal(codex.transport, 'host_harness');
  assert.equal((codex.modelRoute as { routeKind?: string }).routeKind, 'harness');
  assert.equal((codex.modelRoute as { requestedModel?: string }).requestedModel, 'gpt-5.4');
  assert.equal((codex.modelRoute as { effectiveModel?: string }).effectiveModel, 'gpt-5.4');
  assert.equal((codex.modelRoute as { provider?: string }).provider, 'codex');
  assert.equal((codex.modelRoute as { transport?: string }).transport, 'host_harness');

  withEnv({
    MODEL_ROUTING_MODE: 'all_in',
    BYO_MODEL_BASE_URL: 'https://byo.example.test/v1',
    BYO_MODEL_API_KEY: 'key',
    BYO_MODEL_ID: 'minimax-01',
  }, () => {
    const byo = workflowRunnerInternalsForTest.workflowHarnessRouteMarker(
      { id: 'untagged_byo', prompt: 'Do the step.' },
      'minimax-01',
    );
    assert.equal(byo.provider, 'byo');
    assert.equal(byo.transport, 'host_harness');
    assert.equal((byo.modelRoute as { provider?: string }).provider, 'byo');
  });
});




test('Tasks-board stop releases a standard workflow step waiting in-place on approval', async () => {
  resetEventLog();
  resetHarnessRuntimeConfig();
  const prev = {
    AUTH_MODE: process.env.AUTH_MODE,
    WORKFLOW_USE_HARNESS: process.env.WORKFLOW_USE_HARNESS,
    WORKFLOW_APPROVAL_PARKING: process.env.WORKFLOW_APPROVAL_PARKING,
    WORKFLOW_STEP_AGENT: process.env.WORKFLOW_STEP_AGENT,
    CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP: process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP,
  };
  const runId = `wf-standard-approval-cancel-${Date.now()}`;
  const sessionId = `workflow:${runId}:needs_approval`;
  let approvalId = '';
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  let resumeCalls = 0;
  let standardRunOptions: { sourceUserSeq?: number; reuseRecordedUserInput?: boolean } | undefined;
  try {
    const stateDir = path.join(tmp, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, 'auth.json'),
      JSON.stringify({ codexOauth: { accessToken: 'codex-standard-cancel-test-token', refreshToken: 'refresh' } }),
      'utf-8',
    );
    process.env.AUTH_MODE = 'codex_oauth';
    process.env.WORKFLOW_USE_HARNESS = 'on';
    process.env.WORKFLOW_APPROVAL_PARKING = 'off';
    process.env.WORKFLOW_STEP_AGENT = 'off';
    process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP = 'off';
    runEvents.startRun({
      id: runId,
      sessionId: `workflow:${runId}`,
      source: 'workflow',
      title: 'Cancelable approval wait',
      message: 'Wait for a protected action.',
    });
    _setWorkflowHarnessLoopImplsForTests({
      buildAgent: (async () => ({})) as never,
      runConversation: (async (options: { sessionId: string; sourceUserSeq?: number; reuseRecordedUserInput?: boolean }) => {
        standardRunOptions = options;
        const row = approvalRegistry.register({
          sessionId: options.sessionId,
          subject: 'Approve the protected action?',
          tool: 'composio_execute_tool',
          ttlMs: 60_000,
        });
        approvalId = row.approvalId;
        entered();
        return {
          sessionId: options.sessionId,
          status: 'awaiting_approval',
          steps: 1,
          lastTurn: 1,
        };
      }) as never,
      runConversationFromResume: (async () => {
        resumeCalls += 1;
        throw new Error('cancelled approval wait must not resume');
      }) as never,
    });
    const step = {
      id: 'needs_approval',
      prompt: 'Perform the protected action.',
      model: 'gpt-5.4',
      sideEffect: 'write' as const,
    };
    const ctx = {
      workflow: { name: 'Standard Approval Cancel', description: 'test', enabled: true, steps: [step], trigger: { manual: true } },
      workflowSlug: 'standard-approval-cancel',
      runId,
      inputs: {},
      stepOutputs: {},
      assistant: { respond: async () => { throw new Error('legacy assistant should not run'); } },
      completedItems: new Map(),
      forEachFailures: [],
      qualityAdvisories: [],
    } as unknown as Parameters<typeof executeStep>[1];

    const running = executeStep(step, ctx);
    await enteredPromise;
    const activeAttempt = getLatestRunAttempt(sessionId);
    assert.equal(activeAttempt?.status, 'active');
    assert.equal(standardRunOptions?.sourceUserSeq, activeAttempt?.sourceUserSeq);
    assert.equal(standardRunOptions?.reuseRecordedUserInput, true, 'the standard lane reuses the one attempt-bound input row');
    runEvents.finishRun(runId, { status: 'cancelled', message: 'Cancelled from the Tasks board.' });
    await assert.rejects(running, /Workflow run cancelled by user/);
    assert.equal(resumeCalls, 0, 'approval continuation never starts after Stop');
    assert.equal(getLatestRunAttempt(sessionId)?.status, 'cancelled');
  } finally {
    if (approvalId) approvalRegistry.resolve(approvalId, 'cancelled_by_user', 'test-cleanup');
    _setWorkflowHarnessLoopImplsForTests();
    resetHarnessRuntimeConfig();
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('standard workflow approval resume retains the exact step attempt identity', async () => {
  const { _acceptResumeConversationInputForTest } = await import('../runtime/harness/loop.js');
  resetEventLog();
  resetHarnessRuntimeConfig();
  const prev = {
    AUTH_MODE: process.env.AUTH_MODE,
    WORKFLOW_USE_HARNESS: process.env.WORKFLOW_USE_HARNESS,
    WORKFLOW_APPROVAL_PARKING: process.env.WORKFLOW_APPROVAL_PARKING,
    WORKFLOW_STEP_AGENT: process.env.WORKFLOW_STEP_AGENT,
    CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP: process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP,
  };
  const runId = `wf-standard-attempt-resume-${Date.now()}`;
  const sessionId = `workflow:${runId}:approval_identity`;
  let approvalId = '';
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  let initialOptions: {
    sessionId: string;
    sourceUserSeq?: number;
    runAttemptId?: string;
  } | undefined;
  let resumeOptions: {
    sessionId: string;
    runAttemptId?: string;
    approvalId?: string;
    decision?: 'approve' | 'reject';
  } | undefined;
  try {
    const stateDir = path.join(tmp, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, 'auth.json'),
      JSON.stringify({ codexOauth: { accessToken: 'codex-standard-attempt-test-token', refreshToken: 'refresh' } }),
      'utf-8',
    );
    process.env.AUTH_MODE = 'codex_oauth';
    process.env.WORKFLOW_USE_HARNESS = 'on';
    process.env.WORKFLOW_APPROVAL_PARKING = 'off';
    process.env.WORKFLOW_STEP_AGENT = 'off';
    process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP = 'off';
    _setWorkflowHarnessLoopImplsForTests({
      buildAgent: (async () => ({})) as never,
      runConversation: (async (options: {
        sessionId: string;
        sourceUserSeq?: number;
        runAttemptId?: string;
      }) => {
        initialOptions = options;
        const row = approvalRegistry.register({
          sessionId: options.sessionId,
          subject: 'Approve the exact workflow action?',
          tool: 'composio_execute_tool',
          ttlMs: 60_000,
        });
        approvalId = row.approvalId;
        entered();
        return {
          sessionId: options.sessionId,
          status: 'awaiting_approval',
          steps: 1,
          lastTurn: 1,
        };
      }) as never,
      runConversationFromResume: (async (options: {
        sessionId: string;
        runAttemptId?: string;
        approvalId?: string;
        decision?: 'approve' | 'reject';
      }) => {
        resumeOptions = options;
        _acceptResumeConversationInputForTest({
          sessionId: options.sessionId,
          approvalId: options.approvalId,
          decision: options.decision,
        });
        return {
          sessionId: options.sessionId,
          status: 'completed',
          steps: 1,
          lastTurn: 2,
          lastDecision: {
            summary: 'Approved workflow action completed.',
            reply: 'The approved workflow action is complete.',
            done: true,
            nextAction: 'completed',
          },
        };
      }) as never,
    });
    const step = {
      id: 'approval_identity',
      prompt: 'Complete the exact approved workflow action.',
      model: 'gpt-5.4',
      sideEffect: 'read' as const,
    };
    const ctx = {
      workflow: {
        name: 'Standard Attempt Identity',
        description: 'test',
        enabled: true,
        steps: [step],
        trigger: { manual: true },
      },
      workflowSlug: 'standard-attempt-identity',
      runId,
      inputs: {},
      stepOutputs: {},
      assistant: { respond: async () => { throw new Error('legacy assistant should not run'); } },
      completedItems: new Map(),
      forEachFailures: [],
      qualityAdvisories: [],
    } as unknown as Parameters<typeof executeStep>[1];

    const running = executeStep(step, ctx);
    await enteredPromise;
    const activeAttempt = getLatestRunAttempt(sessionId);
    assert.ok(activeAttempt?.attemptId);
    assert.equal(initialOptions?.sourceUserSeq, activeAttempt?.sourceUserSeq);
    assert.equal(initialOptions?.runAttemptId, activeAttempt?.attemptId);

    // `enteredPromise` fires inside the model stub, before its
    // `awaiting_approval` result has returned to the workflow owner. Wait on
    // that owner's exact card projection so it can enumerate and bind the
    // pending card before the fixture resolves it. Resolving in the same
    // microtask incorrectly simulates a decision that predates this
    // activation's observation authority.
    let activationObservedCard = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      activationObservedCard = workflowNotifications.loadNotifications().some((row) =>
        row.id === `approval-${approvalId}`
        && row.metadata?.workflowName === 'Standard Attempt Identity'
        && row.metadata?.stepId === step.id,
      );
      if (activationObservedCard) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(activationObservedCard, true, 'the workflow owner observed and surfaced the exact card');
    assert.equal(
      approvalRegistry.listPending({ sessionId, status: 'pending' })
        .some((row) => row.approvalId === approvalId),
      true,
    );
    approvalRegistry.resolve(approvalId, 'approved', 'unit-test-human');
    await running;

    assert.equal(
      resumeOptions?.runAttemptId,
      activeAttempt?.attemptId,
      'approval resume remains owned by the same durable workflow step attempt',
    );
    assert.equal(getLatestRunAttempt(sessionId)?.status, 'completed');
  } finally {
    if (approvalId) approvalRegistry.resolve(approvalId, 'cancelled_by_user', 'test-cleanup');
    _setWorkflowHarnessLoopImplsForTests();
    resetHarnessRuntimeConfig();
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test('workflow harness sessions are deterministic per run step', () => {
  resetEventLog();
  const first = workflowRunnerInternalsForTest.getWorkflowHarnessSession(
    'Daily Outreach',
    'surface_for_approval',
    'run-123',
    'run-123:surface_for_approval',
  );
  const second = workflowRunnerInternalsForTest.getWorkflowHarnessSession(
    'Daily Outreach',
    'surface_for_approval',
    'run-123',
    'run-123:surface_for_approval',
  );

  assert.equal(first.id, 'workflow:run-123:surface_for_approval');
  assert.equal(second.id, first.id);
  assert.equal(second.sessionRow.metadata.workflowRunId, 'run-123');
});

test('generic Tasks-board cancellation is stop authority for workflow child steps', () => {
  const runId = `wf-board-stop-${Date.now()}`;
  rmSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), { force: true });
  runEvents.startRun({
    id: runId,
    sessionId: `workflow:${runId}`,
    source: 'workflow',
    title: 'Board stop bridge',
    message: 'Run a long workflow step.',
  });
  assert.equal(workflowRunnerInternalsForTest.isWorkflowRunCancelled(runId), false);
  runEvents.finishRun(runId, {
    status: 'cancelled',
    message: 'Cancelled from the Tasks board.',
  });
  assert.equal(
    workflowRunnerInternalsForTest.isWorkflowRunCancelled(runId),
    true,
    'the base workflow:<runId> card stops child workflow:<runId>:<stepId> work',
  );
});

test('workflow harness resume reuses already parked legacy approval session', () => {
  resetEventLog();
  const legacy = HarnessSession.create({
    kind: 'workflow',
    channel: 'workflow',
    title: 'Daily Outreach::surface_for_approval',
    metadata: {
      source: 'workflow',
      workflowName: 'Daily Outreach',
      stepId: 'surface_for_approval',
    },
  });
  approvalRegistry.register({
    sessionId: legacy.id,
    subject: 'Send the pending cold-prospect emails',
    tool: 'request_approval',
  });

  const resumed = workflowRunnerInternalsForTest.getWorkflowHarnessSession(
    'Daily Outreach',
    'surface_for_approval',
    'run-123',
    'run-123:surface_for_approval',
  );

  assert.equal(resumed.id, legacy.id);
  assert.equal(HarnessSession.load('workflow:run-123:surface_for_approval'), null);
  assert.deepEqual(
    {
      source: resumed.sessionRow.metadata.source,
      workflowName: resumed.sessionRow.metadata.workflowName,
      workflowRunId: resumed.sessionRow.metadata.workflowRunId,
      stepId: resumed.sessionRow.metadata.stepId,
      sessionIdSuffix: resumed.sessionRow.metadata.sessionIdSuffix,
    },
    {
      source: 'workflow',
      workflowName: 'Daily Outreach',
      workflowRunId: 'run-123',
      stepId: 'surface_for_approval',
      sessionIdSuffix: 'run-123:surface_for_approval',
    },
    'the current workflow owner upgrades the reused legacy session before resuming it',
  );
});

test('deterministic workflow step runs a bundled scripts/ helper with JSON stdin', async () => {
  const workflowDir = path.join(tmp, 'vault', '00-System', 'workflows', 'deterministic-test');
  const scriptsDir = path.join(workflowDir, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'echo.mjs'),
    [
      'let input = "";',
      'process.stdin.setEncoding("utf-8");',
      'process.stdin.on("data", (chunk) => input += chunk);',
      'process.stdin.on("end", () => {',
      '  const payload = JSON.parse(input);',
      '  process.stdout.write(JSON.stringify({ stepId: payload.stepId, account: payload.inputs.account, prior: payload.stepOutputs.prior }));',
      '});',
    ].join('\n'),
    'utf-8',
  );

  const output = await runDeterministicWorkflowStepForTest('echo.mjs', {
    workflow: 'Deterministic Test',
    workflowSlug: 'deterministic-test',
    runId: 'run-1',
    stepId: 'script',
    inputs: { account: 'Acme' },
    stepOutputs: { prior: ['one'] },
  });

  assert.deepEqual(output, { stepId: 'script', account: 'Acme', prior: ['one'] });
});

test('deterministic workflow payload preserves a host-owned occurrenceAt and never synthesizes one', async () => {
  const scriptsDir = path.join(tmp, 'vault', '00-System', 'workflows', 'det-occurrence-at', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'echo.mjs'),
    [
      'let input = "";',
      'for await (const chunk of process.stdin) input += chunk;',
      'const payload = JSON.parse(input);',
      'process.stdout.write(JSON.stringify({ occurrenceAt: payload.occurrenceAt }));',
    ].join('\n'),
    'utf-8',
  );
  const occurrenceAt = '2026-08-13T16:00:00.000Z';
  const output = await runDeterministicWorkflowStepForTest('echo.mjs', {
    workflow: 'Det occurrence at',
    workflowSlug: 'det-occurrence-at',
    runId: 'det-occurrence-at-run',
    stepId: 'pull',
    inputs: {},
    stepOutputs: {},
    occurrenceAt,
  });
  assert.deepEqual(output, { occurrenceAt });

  const missing = await runDeterministicWorkflowStepForTest('echo.mjs', {
    workflow: 'Det occurrence at',
    workflowSlug: 'det-occurrence-at',
    runId: 'det-occurrence-at-missing-run',
    stepId: 'pull',
    inputs: {},
    stepOutputs: {},
  });
  assert.deepEqual(missing, {});
});

test('deterministic occurrenceAt binds catch-up and schedule receipts to the exact workflow slug', () => {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const scheduledId = 'det-scheduled-occurrence-run';
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${scheduledId}.json`), JSON.stringify({
    id: scheduledId,
    workflow: 'wf',
    createdAt: '2026-08-13T16:05:00.000Z',
    source: 'schedule',
    triggerReceiptId: `workflow-schedule:v1:wf:${Date.parse('2026-08-13T16:00:00.000Z')}`,
  }), 'utf8');
  assert.equal(
    workflowRunnerInternalsForTest.deterministicOccurrenceAt(scheduledId, 'wf'),
    '2026-08-13T16:00:00.000Z',
  );
  assert.equal(
    workflowRunnerInternalsForTest.deterministicOccurrenceAt(scheduledId, 'other-wf'),
    '2026-08-13T16:05:00.000Z',
  );

  const catchupId = 'det-catchup-occurrence-run';
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${catchupId}.json`), JSON.stringify({
    id: catchupId,
    workflow: 'wf',
    createdAt: '2026-08-13T18:00:00.000Z',
    source: 'schedule',
    triggerReceiptId: `workflow-schedule:v1:wf:${Date.parse('2026-08-13T17:00:00.000Z')}`,
    catchupOccurrenceAtMs: Date.parse('2026-08-13T16:00:00.000Z'),
  }), 'utf8');
  assert.equal(
    workflowRunnerInternalsForTest.deterministicOccurrenceAt(catchupId, 'wf'),
    '2026-08-13T16:00:00.000Z',
  );
});

test('deterministic runner preserves structured stdout failure instead of blaming a stderr warning', async () => {
  const scriptsDir = path.join(tmp, 'vault', '00-System', 'workflows', 'det-failure-evidence', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'fail.mjs'),
    [
      'process.stderr.write("Warning: sf CLI update available.\\n");',
      'process.stdout.write(JSON.stringify({ found: false, kind: "deterministic_source_failure", code: "salesforce_provider_error", failedRead: "salesforce-org-readiness", providerErrorId: "INVALID_SESSION_ID", error: "Salesforce target org is not authenticated." }));',
      'process.exit(1);',
    ].join('\n'),
    'utf-8',
  );

  const failure = await runDeterministicWorkflowStepForTest('fail.mjs', {
    workflow: 'Det failure evidence',
    workflowSlug: 'det-failure-evidence',
    runId: 'det-failure-evidence-run',
    stepId: 'pull',
    inputs: {},
    stepOutputs: {},
  }).then(
    () => null,
    (error: unknown) => error,
  );

  assert.ok(failure instanceof DeterministicWorkflowStepError);
  assert.equal(failure.failure.structuredFailureSource, 'stdout');
  assert.equal(failure.failure.summary, 'Salesforce target org is not authenticated.');
  assert.deepEqual(failure.failure.sourceFailure, {
    kind: 'deterministic_source_failure',
    code: 'salesforce_provider_error',
    failedRead: 'salesforce-org-readiness',
    providerErrorId: 'INVALID_SESSION_ID',
  });
  assert.equal(failure.failure.stdout, undefined, 'raw structured stdout is not persisted');
  assert.equal(failure.failure.stderr, 'Warning: sf CLI update available.');
  assert.match(failure.message, /Reported reason: Salesforce target org is not authenticated\./);
  assert.match(failure.message, /stderr diagnostic: Warning: sf CLI update available\./);
  assert.doesNotMatch(failure.message, /reason: Warning: sf CLI update/i);
});

test('deterministic source failure projection rejects unsafe or overlong metadata without retaining packet fields', async () => {
  const scriptsDir = path.join(tmp, 'vault', '00-System', 'workflows', 'det-failure-projection-rejects', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'fail.mjs'),
    [
      'let input = "";',
      'for await (const chunk of process.stdin) input += chunk;',
      'const payload = JSON.parse(input);',
      'process.stdout.write(payload.inputs.packet);',
      'process.exit(1);',
    ].join('\n'),
    'utf-8',
  );
  const base = Object.freeze({
    found: false,
    kind: 'deterministic_source_failure',
    code: 'salesforce_provider_error',
    failedRead: 'salesforce-org-readiness',
    error: 'Safe adapter failure.',
  });
  const cases: Array<[string, Record<string, unknown>]> = [
    ['kind', { ...base, kind: 'provider_failure' }],
    ['code characters', { ...base, code: 'unsafe-retry-code' }],
    ['code bound', { ...base, code: `x${'a'.repeat(64)}` }],
    ['read characters', { ...base, failedRead: 'unsafe read' }],
    ['read bound', { ...base, failedRead: `read:${'a'.repeat(156)}` }],
    ['provider id', { ...base, providerErrorId: 'Bearer super-secret-token' }],
    ['extra key', { ...base, arbitrarySecret: 'unredacted-secret-material' }],
  ];
  for (const [label, packet] of cases) {
    const failure = await runDeterministicWorkflowStepForTest('fail.mjs', {
      workflow: 'Det failure projection rejects',
      workflowSlug: 'det-failure-projection-rejects',
      runId: `det-failure-projection-rejects-${label}`,
      stepId: 'pull',
      inputs: { packet: JSON.stringify(packet) },
      stepOutputs: {},
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof DeterministicWorkflowStepError, label);
    assert.equal(failure.failure.summary, 'Safe adapter failure.', label);
    assert.equal(failure.failure.sourceFailure, undefined, label);
    assert.equal(failure.failure.stdout, undefined, label);
    assert.doesNotMatch(JSON.stringify(failure.failure), /super-secret|unredacted-secret/i, label);
  }
});

test('an embedded JSON line cannot mint deterministic source failure metadata', async () => {
  const scriptsDir = path.join(tmp, 'vault', '00-System', 'workflows', 'det-embedded-failure-projection', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'fail.mjs'),
    [
      'process.stdout.write("adapter prelude\\n");',
      'process.stdout.write(JSON.stringify({ found: false, kind: "deterministic_source_failure", code: "provider_error", failedRead: "crm-read:Account_01", error: "Embedded adapter failure." }));',
      'process.exit(1);',
    ].join('\n'),
    'utf-8',
  );
  const failure = await runDeterministicWorkflowStepForTest('fail.mjs', {
    workflow: 'Det embedded failure projection',
    workflowSlug: 'det-embedded-failure-projection',
    runId: 'det-embedded-failure-projection-run',
    stepId: 'pull',
    inputs: {},
    stepOutputs: {},
  }).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof DeterministicWorkflowStepError);
  assert.equal(failure.failure.summary, 'Embedded adapter failure.');
  assert.equal(failure.failure.structuredFailureSource, 'stdout');
  assert.equal(failure.failure.sourceFailure, undefined);
  assert.equal(failure.failure.stdout, undefined, 'selected multiline stdout is not persisted');
});

test('an over-4k structured failure is recognized before diagnostic bounding', async () => {
  const scriptsDir = path.join(tmp, 'vault', '00-System', 'workflows', 'det-large-failure-envelope', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'fail.mjs'),
    [
      'process.stdout.write(JSON.stringify({',
      '  found: false,',
      '  kind: "deterministic_source_failure",',
      '  code: "provider_error",',
      '  failedRead: "crm-read",',
      '  arbitrarySecret: "unredacted-secret-material-" + "x".repeat(5_000),',
      '  error: "Oversized adapter failure.",',
      '}));',
      'process.exit(1);',
    ].join('\n'),
    'utf-8',
  );
  const failure = await runDeterministicWorkflowStepForTest('fail.mjs', {
    workflow: 'Det large failure envelope',
    workflowSlug: 'det-large-failure-envelope',
    runId: 'det-large-failure-envelope-run',
    stepId: 'pull',
    inputs: {},
    stepOutputs: {},
  }).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof DeterministicWorkflowStepError);
  assert.equal(failure.failure.summary, 'Oversized adapter failure.');
  assert.equal(failure.failure.sourceFailure, undefined, 'extra packet fields reject typed projection');
  assert.equal(failure.failure.stdout, undefined, 'complete structured envelope is not retained');
  assert.doesNotMatch(JSON.stringify(failure.failure), /unredacted-secret/i);
});

test('a reasonless failure envelope cannot leak arbitrary fields through raw stdout', async () => {
  const scriptsDir = path.join(tmp, 'vault', '00-System', 'workflows', 'det-reasonless-failure-envelope', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'fail.mjs'),
    'process.stdout.write(JSON.stringify({ found: false, kind: "deterministic_source_failure", code: "provider_error", failedRead: "crm-read", arbitrarySecret: "unredacted-secret-material" })); process.exit(1);',
    'utf-8',
  );
  const failure = await runDeterministicWorkflowStepForTest('fail.mjs', {
    workflow: 'Det reasonless failure envelope',
    workflowSlug: 'det-reasonless-failure-envelope',
    runId: 'det-reasonless-failure-envelope-run',
    stepId: 'pull',
    inputs: {},
    stepOutputs: {},
  }).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof DeterministicWorkflowStepError);
  assert.equal(failure.failure.summary, 'The runner exited without emitting a structured failure reason.');
  assert.equal(failure.failure.sourceFailure, undefined);
  assert.equal(failure.failure.stdout, undefined);
  assert.doesNotMatch(JSON.stringify(failure.failure), /unredacted-secret/i);
});

test('provider-controlled stderr cannot mint deterministic source failure metadata', async () => {
  const scriptsDir = path.join(tmp, 'vault', '00-System', 'workflows', 'det-stderr-failure-projection', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'fail.mjs'),
    [
      'process.stderr.write(JSON.stringify({ found: false, kind: "deterministic_source_failure", code: "salesforce_provider_error", failedRead: "salesforce-org-readiness", error: "Provider stderr failure." }));',
      'process.exit(1);',
    ].join('\n'),
    'utf-8',
  );
  const failure = await runDeterministicWorkflowStepForTest('fail.mjs', {
    workflow: 'Det stderr failure projection',
    workflowSlug: 'det-stderr-failure-projection',
    runId: 'det-stderr-failure-projection-run',
    stepId: 'pull',
    inputs: {},
    stepOutputs: {},
  }).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof DeterministicWorkflowStepError);
  assert.equal(failure.failure.summary, 'Provider stderr failure.');
  assert.equal(failure.failure.structuredFailureSource, 'stderr');
  assert.equal(failure.failure.sourceFailure, undefined);
  assert.equal(failure.failure.stderr, undefined, 'raw structured stderr is not persisted');
});

test('warning-only stderr is retained as a diagnostic but never promoted to root cause', async () => {
  const scriptsDir = path.join(tmp, 'vault', '00-System', 'workflows', 'det-warning-only', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'fail.mjs'),
    'process.stderr.write("›   Warning: dependency CLI update available.\\n"); process.exit(1);',
    'utf-8',
  );

  const failure = await runDeterministicWorkflowStepForTest('fail.mjs', {
    workflow: 'Det warning only',
    workflowSlug: 'det-warning-only',
    runId: 'det-warning-only-run',
    stepId: 'pull',
    inputs: {},
    stepOutputs: {},
  }).then(
    () => null,
    (error: unknown) => error,
  );

  assert.ok(failure instanceof DeterministicWorkflowStepError);
  assert.equal(failure.failure.summary, 'The runner exited without emitting a structured failure reason.');
  assert.match(failure.failure.stderr ?? '', /Warning: dependency CLI update available/);
  assert.match(failure.message, /without emitting a structured failure reason/);
  assert.doesNotMatch(failure.message, /Reported reason: .*Warning/i);
});

test('a persisted raw runner is a typed zero-process refusal', async () => {
  const slug = 'raw-runner-zero-process-refusal';
  const runId = 'raw-runner-zero-process-refusal-run';
  const marker = path.join(tmp, 'raw-runner-zero-process-spawned');
  const scriptsDir = path.join(WORKFLOWS_DIR, slug, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'fail.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'spawned');\n`,
    'utf-8',
  );
  const step = {
    id: 'pull',
    prompt: '',
    sideEffect: 'read',
    deterministic: { runner: 'fail.mjs' },
  };
  const ctx = {
    workflow: { name: slug, description: '', enabled: true, trigger: { manual: true }, steps: [step] },
    workflowSlug: slug,
    runId,
    inputs: {},
    stepOutputs: {},
    assistant: { respond: async () => { throw new Error('the model must not run'); } },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];

  await assert.rejects(
    () => executeStep(step as never, ctx),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowHarnessBlockedSignal);
      assert.match(
        error.reason,
        /workflow_raw_subprocess_authority_unrepresented.*deterministic\.runner/i,
      );
      return true;
    },
  );
  assert.equal(existsSync(marker), false, 'the legacy subprocess body never starts');
  assert.equal(readWorkflowEvents(slug, runId).some((event) => event.kind === 'step_started'), false);
});

test('deterministic workflow step now runs a .ts runner via the shared tsx interpreter', async () => {
  const scriptsDir = path.join(tmp, 'vault', '00-System', 'workflows', 'det-ts-test', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'echo.ts'),
    [
      'let input = "";',
      'process.stdin.setEncoding("utf-8");',
      'process.stdin.on("data", (chunk: string) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      '  const payload = JSON.parse(input) as { stepId: string; inputs: { account: string } };',
      '  process.stdout.write(JSON.stringify({ stepId: payload.stepId, account: payload.inputs.account }));',
      '});',
    ].join('\n'),
    'utf-8',
  );

  const output = await runDeterministicWorkflowStepForTest('echo.ts', {
    workflow: 'Det TS Test',
    workflowSlug: 'det-ts-test',
    runId: 'run-ts',
    stepId: 'script',
    inputs: { account: 'Acme' },
    stepOutputs: {},
  });

  assert.deepEqual(output, { stepId: 'script', account: 'Acme' });
});

test('deterministic workflow step rejects runners outside scripts/', async () => {
  await assert.rejects(
    () => runDeterministicWorkflowStepForTest('../bad.sh', {
      workflow: 'Deterministic Test',
      workflowSlug: 'deterministic-test',
      runId: 'run-1',
      stepId: 'script',
      inputs: {},
      stepOutputs: {},
    }),
    /inside the workflow scripts|outside scripts|must stay inside/,
  );
});

test('an exact call result reaches the shared output-contract chokepoint', async () => {
  const mkCtx = (runId: string) => ({
    workflow: { name: 'Exact Call Contract Test', steps: [] },
    workflowSlug: 'exact-call-contract-test',
    runId,
    inputs: {},
    stepOutputs: {},
    assistant: {},
    completedItems: new Map(),
    forEachFailures: [],
  } as unknown as Parameters<typeof executeStep>[1]);

  let calls = 0;
  _setWorkflowCallNodeForTests(async (step) => {
    calls += 1;
    assert.equal(step.call?.tool, 'SALESFORCE_GET_RECORDS');
    return { ok: true };
  });
  try {
    const failStep = {
      id: 'read_fail',
      prompt: '',
      sideEffect: 'read',
      call: { tool: 'SALESFORCE_GET_RECORDS', args: { objectName: 'Account' } },
      output: { type: 'object', required_keys: ['url'] },
    } as unknown as Parameters<typeof executeStep>[0];
    await assert.rejects(
      () => executeStep(failStep, mkCtx('call-fail')),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowContractViolationError);
        assert.match(error.message, /output failed its contract/);
        return true;
      },
    );
    const failKinds = readWorkflowEvents('exact-call-contract-test', 'call-fail').map((e) => e.kind);
    assert.ok(failKinds.includes('step_started'));
    assert.ok(failKinds.includes('step_failed'));
    assert.ok(!failKinds.includes('step_completed'));

    const okStep = {
      id: 'read_ok',
      prompt: '',
      sideEffect: 'read',
      call: { tool: 'SALESFORCE_GET_RECORDS', args: { objectName: 'Account' } },
    } as unknown as Parameters<typeof executeStep>[0];
    const okResult = await executeStep(okStep, mkCtx('call-ok'));
    assert.deepEqual(okResult, { ok: true });
    assert.ok(readWorkflowEvents('exact-call-contract-test', 'call-ok').map((e) => e.kind).includes('step_completed'));
    assert.equal(calls, 2);
  } finally {
    _setWorkflowCallNodeForTests();
  }
});

// ─── Owner-workflow shapes (2026-08-26) ────────────────────────────────────
// These mirrored shapes pin the migration rule: external work stays on an
// exact call; pure data shaping uses the closed in-process transform; literal
// fan-out data is a declared workflow input. No fixture restores subprocess
// authority merely because an old workflow happened to use a script.
function ownerShapeCtx(slug: string, runId: string, step: Record<string, unknown>, stepOutputs: Record<string, unknown> = {}) {
  return {
    workflow: {
      name: slug,
      description: '',
      enabled: true,
      trigger: { manual: true },
      steps: [step],
    },
    workflowSlug: slug,
    runId,
    inputs: {},
    stepOutputs,
    assistant: { respond: async () => { throw new Error('owner shape unexpectedly dispatched through the model'); } },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];
}

test('migrated owner shape — friday-dashboard-daily-refresh uses a reviewed literal transform', async () => {
  const slug = 'friday-dashboard-daily-refresh-shape';
  const step = {
    id: 'pull',
    prompt: '',
    sideEffect: 'read',
    transform: {
      version: 1,
      expression: { op: 'literal', value: { ok: true } },
    },
    output: { type: 'object', required_keys: ['ok'] },
  };
  const validation = validateWorkflowDefinition({
    name: slug,
    description: 'Refresh the dashboard.',
    enabled: true,
    trigger: { manual: true, schedule: '0 7 * * *' },
    steps: [step],
  } as never);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  const result = await executeStep(step as never, ownerShapeCtx(slug, 'run-1', step));
  assert.deepEqual(result, { ok: true });
  assert.ok(readWorkflowEvents(slug, 'run-1').map((e) => e.kind).includes('step_completed'));
});

test('migrated owner shape — monday Salesforce report uses one exact read call', async () => {
  const slug = 'monday-salesforce-opportunity-report-shape';
  const step = {
    id: 'pull_open_opportunities',
    prompt: '',
    sideEffect: 'read',
    call: {
      tool: 'SALESFORCE_RUN_SOQL_QUERY',
      args: {
        query: 'SELECT Id FROM Opportunity WHERE IsClosed = false',
      },
    },
    output: { type: 'object', required_keys: ['records'], non_empty: ['records'] },
  };
  const validation = validateWorkflowDefinition({
    name: slug,
    description: 'Read open Salesforce opportunities.',
    enabled: true,
    trigger: { manual: true, schedule: '0 7 * * 1' },
    steps: [step],
  } as never);
  assert.equal(validation.ok, true, validation.errors.join('\n'));

  let crossings = 0;
  _setWorkflowCallNodeForTests(async (actual) => {
    crossings += 1;
    assert.equal(actual.call?.tool, 'SALESFORCE_RUN_SOQL_QUERY');
    assert.deepEqual(actual.call?.args, {
      query: 'SELECT Id FROM Opportunity WHERE IsClosed = false',
    });
    return { records: [{ Id: '006-1' }] };
  });
  try {
    const result = await executeStep(step as never, ownerShapeCtx(slug, 'run-1', step));
    assert.deepEqual(result, { records: [{ Id: '006-1' }] });
    assert.equal(crossings, 1);
    assert.ok(readWorkflowEvents(slug, 'run-1').map((e) => e.kind).includes('step_completed'));
  } finally {
    _setWorkflowCallNodeForTests();
  }
});

test('migrated owner shape — salesforce-quarterly-to-sheets keeps the provider read exact and reshapes in-process', async () => {
  const slug = 'salesforce-quarterly-to-sheets-shape';
  const oppsStep = {
    id: 'opportunities',
    prompt: '',
    sideEffect: 'read',
    call: {
      tool: 'SALESFORCE_RUN_SOQL_QUERY',
      args: { query: 'SELECT Id, Name, Amount FROM Opportunity WHERE IsClosed = false' },
    },
  };

  const gridStep = {
    id: 'grid',
    prompt: '',
    dependsOn: ['opportunities'],
    sideEffect: 'read',
    transform: {
      version: 1,
      expression: {
        op: 'object',
        fields: [
          { key: 'data', value: { op: 'get', from: 'steps.opportunities.output.data.records' } },
          {
            key: 'grid',
            value: {
              op: 'map',
              value: { op: 'get', from: 'steps.opportunities.output.data.records' },
              each: {
                op: 'array',
                items: [
                  { op: 'get', from: 'item.Id' },
                  { op: 'get', from: 'item.Name' },
                  { op: 'get', from: 'item.Amount' },
                ],
              },
            },
          },
          {
            key: 'counts',
            value: {
              op: 'object',
              fields: [{
                key: 'opportunities',
                value: { op: 'count', value: { op: 'get', from: 'steps.opportunities.output.data.records' } },
              }],
            },
          },
          { key: 'tabsWritten', value: { op: 'literal', value: ['Opportunities'] } },
        ],
      },
    },
    output: { type: 'object', required_keys: ['data', 'counts', 'tabsWritten'] },
  };
  const workflow = {
    name: slug,
    description: 'Read opportunities and shape the Sheets payload.',
    enabled: true,
    trigger: { manual: true, schedule: '0 7 1 */3 *' },
    steps: [oppsStep, gridStep],
  };
  const validation = validateWorkflowDefinition(workflow as never);
  assert.equal(validation.ok, true, validation.errors.join('\n'));

  let crossings = 0;
  _setWorkflowCallNodeForTests(async (actual) => {
    crossings += 1;
    assert.equal(actual.call?.tool, 'SALESFORCE_RUN_SOQL_QUERY');
    return {
      successful: true,
      data: { records: [{ Id: 'opp-1', Name: 'Alpha', Amount: 12 }] },
    };
  });
  try {
    const oppsOutput = await executeStep(oppsStep as never, ownerShapeCtx(slug, 'run-1', oppsStep));
    const gridOutput = await executeStep(
      gridStep as never,
      ownerShapeCtx(slug, 'run-1', gridStep, { opportunities: oppsOutput }),
    ) as {
      data: unknown;
      grid: unknown[][];
      counts: { opportunities: number };
      tabsWritten: string[];
    };
    assert.deepEqual(gridOutput.data, [{ Id: 'opp-1', Name: 'Alpha', Amount: 12 }]);
    assert.deepEqual(gridOutput.grid, [['opp-1', 'Alpha', 12]]);
    assert.equal(gridOutput.counts.opportunities, 1);
    assert.deepEqual(gridOutput.tabsWritten, ['Opportunities']);
    assert.equal(crossings, 1, 'only the exact Salesforce read crosses a provider boundary');
  } finally {
    _setWorkflowCallNodeForTests();
  }
});

test('migrated owner shape — team activity keeps the Salesforce read exact and groups rows in-process', async () => {
  const slug = 'team-activity-slack-updates-shape';
  const pullStep = {
    id: 'pull_activity',
    prompt: '',
    sideEffect: 'read',
    call: {
      tool: 'SALESFORCE_RUN_SOQL_QUERY',
      args: { query: 'SELECT Owner.Name, Type, ActivityDate FROM Task WHERE ActivityDate = TODAY' },
    },
  };
  const groupStep = {
    id: 'group_activity',
    prompt: '',
    dependsOn: ['pull_activity'],
    sideEffect: 'read',
    transform: {
      version: 1,
      expression: {
        op: 'object',
        fields: [
          {
            key: 'byRep',
            value: {
              op: 'aggregate',
              value: { op: 'get', from: 'steps.pull_activity.output.data.records' },
              groupBy: ['owner'],
              metrics: [{ fn: 'count' }],
            },
          },
          {
            key: 'totals',
            value: {
              op: 'object',
              fields: [{
                key: 'activities',
                value: { op: 'count', value: { op: 'get', from: 'steps.pull_activity.output.data.records' } },
              }],
            },
          },
        ],
      },
    },
    output: { type: 'object', required_keys: ['byRep', 'totals'] },
  };
  const validation = validateWorkflowDefinition({
    name: slug,
    description: 'Read and summarize team activity.',
    enabled: true,
    trigger: { manual: true, schedule: '0 9,16 * * 1-5' },
    steps: [pullStep, groupStep],
  } as never);
  assert.equal(validation.ok, true, validation.errors.join('\n'));

  let crossings = 0;
  _setWorkflowCallNodeForTests(async () => {
    crossings += 1;
    return {
      successful: true,
      data: {
        records: [
          { owner: 'Ada', type: 'Call' },
          { owner: 'Ada', type: 'Email' },
          { owner: 'Grace', type: 'Call' },
        ],
      },
    };
  });
  try {
    const pullOutput = await executeStep(pullStep as never, ownerShapeCtx(slug, 'run-1', pullStep));
    const result = await executeStep(
      groupStep as never,
      ownerShapeCtx(slug, 'run-1', groupStep, { pull_activity: pullOutput }),
    ) as { byRep: Array<{ owner: string; count: number }>; totals: { activities: number } };
    assert.deepEqual(result.byRep, [{ owner: 'Ada', count: 2 }, { owner: 'Grace', count: 1 }]);
    assert.equal(result.totals.activities, 3);
    assert.equal(crossings, 1, 'the local aggregate performs no additional provider I/O');
  } finally {
    _setWorkflowCallNodeForTests();
  }
});

test('reviewed transforms execute end-to-end through the durable workflow graph and output journal', async () => {
  const { writeWorkflow } = await import('../memory/workflow-store.js');
  const slug = `reviewed-transform-e2e-${Date.now()}`;
  const workflowName = `Reviewed Transform E2E ${Date.now()}`;
  const runId = `reviewed-transform-e2e-run-${Date.now()}`;
  writeWorkflow(slug, {
    name: workflowName,
    description: 'Prove pure transforms survive compilation and durable execution.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      {
        id: 'seed',
        prompt: '',
        sideEffect: 'read',
        transform: {
          version: 1,
          expression: {
            op: 'literal',
            value: [{ id: 'A', amount: 4 }, { id: 'B', amount: 7 }],
          },
        },
        output: { type: 'array', min_items: { '': 2 } },
      },
      {
        id: 'shape',
        prompt: '',
        dependsOn: ['seed'],
        sideEffect: 'read',
        transform: {
          version: 1,
          expression: {
            op: 'object',
            fields: [
              {
                key: 'count',
                value: { op: 'count', value: { op: 'get', from: 'steps.seed.output' } },
              },
              {
                key: 'grid',
                value: {
                  op: 'map',
                  value: { op: 'get', from: 'steps.seed.output' },
                  each: {
                    op: 'array',
                    items: [
                      { op: 'get', from: 'item.id' },
                      { op: 'get', from: 'item.amount' },
                    ],
                  },
                },
              },
            ],
          },
        },
        output: { type: 'object', required_keys: ['count', 'grid'] },
      },
    ],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'queued',
    inputs: {},
    createdAt: new Date().toISOString(),
  }), 'utf-8');

  let modelCalls = 0;
  await processWorkflowRuns({
    respond: async () => {
      modelCalls += 1;
      throw new Error('a reviewed transform must not dispatch a model');
    },
  } as never);

  const terminal = JSON.parse(readFileSync(runFile, 'utf-8')) as {
    status?: string;
    stepOutputs?: Record<string, unknown>;
  };
  assert.equal(terminal.status, 'completed');
  assert.deepEqual(
    JSON.parse(String(terminal.stepOutputs?.seed)),
    [{ id: 'A', amount: 4 }, { id: 'B', amount: 7 }],
  );
  assert.deepEqual(
    JSON.parse(String(terminal.stepOutputs?.shape)),
    { count: 2, grid: [['A', 4], ['B', 7]] },
  );
  assert.equal(modelCalls, 0);
  const transformCompletions = readWorkflowEvents(slug, runId)
    .filter((event) => event.kind === 'step_completed' && event.meta?.mode === 'transform');
  assert.deepEqual(transformCompletions.map((event) => event.stepId), ['seed', 'shape']);
});

test('migrated owner shape — social manager fans out from a declared JSON-list input with no synthetic producer', async () => {
  const prevWorkflowHarness = process.env.WORKFLOW_USE_HARNESS;
  process.env.WORKFLOW_USE_HARNESS = 'on';
  const seen: string[] = [];
  installCanonicalWorkflowTextHarness(async (request) => {
    const name = /Research ([ABC])\./.exec(String(request.input ?? ''))?.[1] ?? '?';
    seen.push(name);
    return `done-${name}`;
  });
  const step = {
    id: 'research',
    prompt: 'Research {{item.name}}.',
    forEach: 'input.competitors',
    sideEffect: 'read',
  };
  const workflow = {
    name: 'Social Manager Input Fanout',
    description: 'Research each explicitly configured competitor.',
    enabled: true,
    trigger: { manual: true },
    inputs: {
      competitors: {
        type: 'string',
        default: '[{"name":"A"},{"name":"B"},{"name":"C"}]',
      },
    },
    steps: [step],
  };
  const validation = validateWorkflowDefinition(workflow as never);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  const ctx = {
    workflow,
    workflowSlug: 'input-fanout',
    runId: 'input-fanout-run',
    inputs: { competitors: '[{"name":"A"},{"name":"B"},{"name":"C"}]' },
    stepOutputs: {},
    assistant: {
      respond: async () => { throw new Error('retired assistant.respond lane ran'); },
    },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];
  try {
    const output = await executeStep(step as never, ctx) as Array<{ itemKey: string }>;
    assert.deepEqual(seen.sort(), ['A', 'B', 'C']);
    assert.equal(output.length, 3);
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
    restoreEnv('WORKFLOW_USE_HARNESS', prevWorkflowHarness);
  }
});

test('forEach batches an oversized fan-out and still attempts every item', async () => {
  const prev = process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS;
  const prevWorkflowHarness = process.env.WORKFLOW_USE_HARNESS;
  const prevBridgeHarness = process.env.CLEMMY_HARNESS_WORKFLOW;
  const prevLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS = '2';
  process.env.WORKFLOW_USE_HARNESS = 'off';
  process.env.CLEMMY_HARNESS_WORKFLOW = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  try {
    const qualityAdvisories: Array<{ kind: string; note: string }> = [];
    const ctx = {
      workflow: { name: 'Choke Test', steps: [] },
      workflowSlug: 'foreach-cap-test',
      runId: 'fc-1',
      inputs: {},
      stepOutputs: { pull: ['a', 'b', 'c', 'd', 'e'] },
      assistant: { respond: async () => ({ text: 'done' }) },
      completedItems: new Map(),
      forEachFailures: [],
      qualityAdvisories,
    } as unknown as Parameters<typeof executeStep>[1];
    const step = { id: 'blast', prompt: 'Process the item.', forEach: 'pull' } as unknown as Parameters<typeof executeStep>[0];

    const output = await executeStep(step, ctx) as Array<{ itemKey: string; output: unknown }>;

    const overflow = qualityAdvisories.find((a) => a.kind === 'foreach_overflow');
    assert.equal(overflow, undefined, 'batching is not a terminal overflow advisory when every item is attempted');
    assert.deepEqual(output.map((item) => item.itemKey), ['a', 'b', 'c', 'd', 'e']);
    const started = readWorkflowEvents('foreach-cap-test', 'fc-1').filter((e) => e.kind === 'item_started');
    assert.equal(started.length, 5, 'all pending items are attempted in bounded windows');
    const batched = readWorkflowEvents('foreach-cap-test', 'fc-1')
      .find((e) => e.kind === 'step_advisory' && e.meta?.reason === 'foreach_batched');
    assert.equal(batched?.meta?.batchSize, 2);
    assert.equal(batched?.meta?.batches, 3);
  } finally {
    if (prev === undefined) delete process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS;
    else process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS = prev;
    restoreEnv('WORKFLOW_USE_HARNESS', prevWorkflowHarness);
    restoreEnv('CLEMMY_HARNESS_WORKFLOW', prevBridgeHarness);
    restoreEnv('CLEMMY_LEGACY_RESPOND_FALLBACK', prevLegacyFallback);
  }
});

test('forEach resolves {{steps.x.output.path}} sources at runtime', async () => {
  const prevWorkflowHarness = process.env.WORKFLOW_USE_HARNESS;
  const prevBridgeHarness = process.env.CLEMMY_HARNESS_WORKFLOW;
  const prevLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.WORKFLOW_USE_HARNESS = 'off';
  process.env.CLEMMY_HARNESS_WORKFLOW = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  try {
    const ctx = {
      workflow: { name: 'Path ForEach Test', steps: [] },
      workflowSlug: 'foreach-path-test',
      runId: 'fp-1',
      inputs: {},
      stepOutputs: { pull: { created_records: [{ id: 'r1' }, { id: 'r2' }] } },
      assistant: { respond: async () => ({ text: 'done' }) },
      completedItems: new Map(),
      forEachFailures: [],
      qualityAdvisories: [],
    } as unknown as Parameters<typeof executeStep>[1];
    const step = {
      id: 'enrich',
      prompt: 'Process {{item.id}}.',
      forEach: '{{steps.pull.output.created_records}}',
    } as unknown as Parameters<typeof executeStep>[0];

    const output = await executeStep(step, ctx) as Array<{ itemKey: string; output: unknown }>;

    assert.deepEqual(output.map((item) => item.itemKey), ['r1', 'r2']);
    const started = readWorkflowEvents('foreach-path-test', 'fp-1').filter((e) => e.kind === 'item_started');
    assert.deepEqual(started.map((e) => e.itemKey), ['r1', 'r2']);
  } finally {
    restoreEnv('WORKFLOW_USE_HARNESS', prevWorkflowHarness);
    restoreEnv('CLEMMY_HARNESS_WORKFLOW', prevBridgeHarness);
    restoreEnv('CLEMMY_LEGACY_RESPOND_FALLBACK', prevLegacyFallback);
  }
});

test('forEachNewOnly watermarks completed items and retries failed items on the next run', async () => {
  const prevWorkflowHarness = process.env.WORKFLOW_USE_HARNESS;
  process.env.WORKFLOW_USE_HARNESS = 'on';
  const workflowSlug = 'foreach-watermark-test';
  const stepId = 'blast';
  clearStepWatermark(workflowSlug, stepId);
  try {
    let failB = true;
    installCanonicalWorkflowTextHarness(async (request) => {
      const message = String(request.input ?? '');
      if (failB && message.includes('Item: b')) throw new Error('temporary b failure');
      const item = message.match(/Item: ([^\n]+)/)?.[1] ?? 'unknown';
      return `done-${item}`;
    });
    const mkCtx = (runId: string) => ({
      workflow: { name: 'New Only Fanout Test', steps: [] },
      workflowSlug,
      runId,
      inputs: {},
      stepOutputs: { pull: ['a', 'b', 'c'] },
      assistant: { respond: async () => { throw new Error('retired assistant.respond lane ran'); } },
      completedItems: new Map(),
      forEachFailures: [],
      qualityAdvisories: [],
    } as unknown as Parameters<typeof executeStep>[1]);
    const step = {
      id: stepId,
      prompt: 'Process the item.',
      forEach: 'pull',
      forEachNewOnly: true,
    } as unknown as Parameters<typeof executeStep>[0];

    const first = await executeStep(step, mkCtx('fw-1')) as {
      blocked: true;
      completed_items: number;
      failed_items: Array<{ itemKey: string; error: string }>;
    };
    assert.equal(first.blocked, true, 'an incomplete fan-out blocks its downstream graph');
    assert.equal(first.completed_items, 2, 'successful work is preserved even though the node is blocked');
    assert.deepEqual(first.failed_items.map((item) => item.itemKey), ['b']);
    assert.deepEqual([...readSeenItemKeys(workflowSlug, stepId)].sort(), ['a', 'c'], 'only completed items advance the watermark');

    failB = false;
    const second = await executeStep(step, mkCtx('fw-2')) as Array<{ itemKey: string; output: unknown }>;
    assert.deepEqual(second.map((item) => item.itemKey), ['b'], 'next run processes only the previously failed item');
    assert.deepEqual(
      readWorkflowEvents(workflowSlug, 'fw-2').filter((e) => e.kind === 'item_started').map((e) => e.itemKey),
      ['b'],
      'watermarked items are not started again',
    );
    assert.deepEqual([...readSeenItemKeys(workflowSlug, stepId)].sort(), ['a', 'b', 'c']);
  } finally {
    clearStepWatermark(workflowSlug, stepId);
    _setWorkflowHarnessLoopImplsForTests();
    restoreEnv('WORKFLOW_USE_HARNESS', prevWorkflowHarness);
  }
});

test('forEach batching resumes after already-completed items and drains remaining pending items', async () => {
  const prev = process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS;
  const prevWorkflowHarness = process.env.WORKFLOW_USE_HARNESS;
  const prevBridgeHarness = process.env.CLEMMY_HARNESS_WORKFLOW;
  const prevLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS = '2';
  process.env.WORKFLOW_USE_HARNESS = 'off';
  process.env.CLEMMY_HARNESS_WORKFLOW = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  try {
    const qualityAdvisories: Array<{ kind: string; note: string }> = [];
    const completedItems = new Map<string, unknown>([
      ['a', 'done-a'],
      ['b', 'done-b'],
    ]);
    const ctx = {
      workflow: { name: 'Choke Resume Test', steps: [] },
      workflowSlug: 'foreach-cap-resume-test',
      runId: 'fc-resume-1',
      inputs: {},
      stepOutputs: { pull: ['a', 'b', 'c', 'd', 'e'] },
      assistant: { respond: async () => ({ text: 'done' }) },
      completedItems,
      forEachFailures: [],
      qualityAdvisories,
    } as unknown as Parameters<typeof executeStep>[1];
    const step = { id: 'blast', prompt: 'Process the item.', forEach: 'pull', useHarness: false } as unknown as Parameters<typeof executeStep>[0];

    const output = await executeStep(step, ctx) as Array<{ itemKey: string; output: unknown }>;

    const overflow = qualityAdvisories.find((a) => a.kind === 'foreach_overflow');
    assert.equal(overflow, undefined, 'resume batching does not turn fully attempted work into an overflow');
    assert.deepEqual(output.map((item) => item.itemKey), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(output.slice(0, 2).map((item) => item.output), ['done-a', 'done-b']);
    const started = readWorkflowEvents('foreach-cap-resume-test', 'fc-resume-1')
      .filter((e) => e.kind === 'item_started')
      .map((e) => e.itemKey);
    assert.deepEqual(started, ['c', 'd', 'e'], 'resume processes only pending items, across all windows');
    const batched = readWorkflowEvents('foreach-cap-resume-test', 'fc-resume-1')
      .find((e) => e.kind === 'step_advisory' && e.meta?.reason === 'foreach_batched');
    assert.equal(batched?.meta?.batchSize, 2);
    assert.equal(batched?.meta?.batches, 2);
    const completed = readWorkflowEvents('foreach-cap-resume-test', 'fc-resume-1')
      .findLast((e) => e.kind === 'step_completed');
    assert.equal((completed as { meta?: Record<string, unknown> } | undefined)?.meta?.completed, 5, 'step metadata counts resumed + newly processed items');
    assert.equal((completed as { meta?: Record<string, unknown> } | undefined)?.meta?.resumed, 2);
    assert.equal((completed as { meta?: Record<string, unknown> } | undefined)?.meta?.processed, 3);
  } finally {
    if (prev === undefined) delete process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS;
    else process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS = prev;
    restoreEnv('WORKFLOW_USE_HARNESS', prevWorkflowHarness);
    restoreEnv('CLEMMY_HARNESS_WORKFLOW', prevBridgeHarness);
    restoreEnv('CLEMMY_LEGACY_RESPOND_FALLBACK', prevLegacyFallback);
  }
});

test('forEach restart hydrates an exact >32KB completed item before draining its pending sibling', async () => {
  const prevWorkflowHarness = process.env.WORKFLOW_USE_HARNESS;
  process.env.WORKFLOW_USE_HARNESS = 'on';
  const workflowSlug = 'foreach-exact-item-resume';
  const runId = 'foreach-exact-item-run';
  const exactItem = {
    body: `${'x'.repeat(40_000)}EXACT-ITEM-TAIL-AFTER-RESTART`,
  };
  try {
    const persisted = recordItemOutput({
      workflowName: workflowSlug,
      runId,
      stepId: 'fanout',
      itemKey: 'a',
      output: exactItem,
      nowIso: new Date().toISOString(),
    });
    assert.ok(persisted.sha256);
    appendWorkflowEventDurably(workflowSlug, runId, {
      kind: 'item_completed',
      stepId: 'fanout',
      itemKey: 'a',
      output: exactItem,
      meta: {
        itemOutputArtifact: {
          path: persisted.path,
          sha256: persisted.sha256,
          bytes: persisted.bytes,
          producedAt: persisted.producedAt,
        },
      },
    });

    const compact = computeResumeState(workflowSlug, runId);
    assert.equal(
      (compact.completedItems.get('fanout')?.get('a') as { truncated?: boolean }).truncated,
      true,
      'the item journal remains compact',
    );
    const resumed = workflowRunnerInternalsForTest.hydrateCompletedOutputArtifacts(
      compact,
      workflowSlug,
      runId,
    );
    assert.match(
      JSON.stringify(resumed.completedItems.get('fanout')?.get('a')),
      /EXACT-ITEM-TAIL-AFTER-RESTART/,
    );
    let modelCalls = 0;
    installCanonicalWorkflowTextHarness(async (request) => {
      modelCalls += 1;
      assert.match(String(request.input ?? ''), /Item: b/);
      return 'done-b';
    });
    const ctx = {
      workflow: { name: 'Exact Item Resume', steps: [] },
      workflowSlug,
      runId,
      inputs: {},
      stepOutputs: { pull: ['a', 'b'] },
      assistant: { respond: async () => { throw new Error('retired assistant.respond lane ran'); } },
      completedItems: resumed.completedItems.get('fanout') ?? new Map(),
      forEachFailures: [],
      qualityAdvisories: [],
    } as unknown as Parameters<typeof executeStep>[1];
    const output = await executeStep(
      { id: 'fanout', prompt: 'Process item.', forEach: 'pull' } as never,
      ctx,
    ) as Array<{ itemKey: string; output: unknown }>;

    assert.equal(modelCalls, 1, 'only the pending sibling executes after restart');
    assert.match(JSON.stringify(output.find((item) => item.itemKey === 'a')?.output), /EXACT-ITEM-TAIL-AFTER-RESTART/);
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
    restoreEnv('WORKFLOW_USE_HARNESS', prevWorkflowHarness);
  }
});

test('missing or malformed item artifact authority fails closed instead of replaying partial work', () => {
  const workflowSlug = 'foreach-corrupt-item-ref';
  appendWorkflowEventDurably(workflowSlug, 'missing-ref', {
    kind: 'item_completed',
    stepId: 'fanout',
    itemKey: 'a',
    output: { truncated: true, preview: 'partial' },
    meta: {
      itemOutputArtifact: {
        path: 'artifacts/does-not-exist.json',
        sha256: 'a'.repeat(64),
        bytes: 7,
        producedAt: new Date().toISOString(),
      },
    },
  });
  assert.throws(
    () => workflowRunnerInternalsForTest.hydrateCompletedOutputArtifacts(
      computeResumeState(workflowSlug, 'missing-ref'),
      workflowSlug,
      'missing-ref',
    ),
    /unreadable exact output artifact/,
  );

  appendWorkflowEvent(workflowSlug, 'malformed-ref', {
    kind: 'item_completed',
    stepId: 'fanout',
    itemKey: 'a',
    output: 'partial',
    meta: { itemOutputArtifact: { path: '../escape.json' } },
  });
  assert.throws(
    () => computeResumeState(workflowSlug, 'malformed-ref'),
    /malformed itemOutputArtifact reference/,
  );
});

test('forEach batching attributes item failures to their original keys across windows', async () => {
  const prev = process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS;
  const prevWorkflowHarness = process.env.WORKFLOW_USE_HARNESS;
  process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS = '2';
  process.env.WORKFLOW_USE_HARNESS = 'on';
  try {
    const forEachFailures: Array<{ stepId: string; itemKey: string; error: string }> = [];
    installCanonicalWorkflowTextHarness(async (request) => {
      if (/\bItem:\s*d\b/.test(request.input ?? '')) throw new Error('downstream d failed');
      return 'done';
    });
    const ctx = {
      workflow: { name: 'Choke Failure Attribution Test', steps: [] },
      workflowSlug: 'foreach-batch-failure-test',
      runId: 'fc-fail-1',
      inputs: {},
      stepOutputs: { pull: ['a', 'b', 'c', 'd', 'e'] },
      assistant: { respond: async () => { throw new Error('retired assistant.respond lane ran'); } },
      completedItems: new Map(),
      forEachFailures,
      qualityAdvisories: [],
    } as unknown as Parameters<typeof executeStep>[1];
    const step = { id: 'blast', prompt: 'Process the item.', forEach: 'pull' } as unknown as Parameters<typeof executeStep>[0];

    const output = await executeStep(step, ctx) as {
      blocked: true;
      completed_items: number;
      failed_items: Array<{ itemKey: string; error: string }>;
    };

    assert.equal(output.blocked, true, 'partial fan-out cannot masquerade as a completed aggregate');
    assert.equal(output.completed_items, 4);
    assert.deepEqual(output.failed_items.map((item) => item.itemKey), ['d']);
    assert.deepEqual(forEachFailures.map((f) => f.itemKey), ['d'], 'run-level failure summary names the failed item');
    assert.match(forEachFailures[0]?.error ?? '', /downstream d failed/);
    const itemFailed = readWorkflowEvents('foreach-batch-failure-test', 'fc-fail-1')
      .find((e) => e.kind === 'item_failed');
    assert.equal(itemFailed?.itemKey, 'd');
    const completed = readWorkflowEvents('foreach-batch-failure-test', 'fc-fail-1')
      .findLast((e) => e.kind === 'step_completed');
    assert.equal((completed as { meta?: Record<string, unknown> } | undefined)?.meta?.failed, 1);
    assert.equal((completed as { meta?: Record<string, unknown> } | undefined)?.meta?.blocked, true);
    const skips = planBlockedDependencySkips(
      [
        step,
        { id: 'write_rows', prompt: 'Write the rows.', dependsOn: ['blast'], sideEffect: 'write' },
      ] as never,
      { blast: output },
    );
    assert.deepEqual(
      skips.map((skip) => skip.stepId),
      ['write_rows'],
      'a dependent write is deterministically skipped after any fan-out item failure',
    );
  } finally {
    if (prev === undefined) delete process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS;
    else process.env.CLEMENTINE_WORKFLOW_FOREACH_MAX_ITEMS = prev;
    _setWorkflowHarnessLoopImplsForTests();
    restoreEnv('WORKFLOW_USE_HARNESS', prevWorkflowHarness);
  }
});

test('W1b: a forEach item that fails TRANSIENTLY retries and succeeds', async () => {
  const prevH = process.env.WORKFLOW_USE_HARNESS;
  process.env.WORKFLOW_USE_HARNESS = 'on';
  try {
    const attempts: Record<string, number> = {};
    const forEachFailures: Array<{ stepId: string; itemKey: string; error: string }> = [];
    installCanonicalWorkflowTextHarness(async (request) => {
      const k = (request.input ?? '').match(/\bItem:\s*(\w+)\b/)?.[1] ?? '?';
      attempts[k] = (attempts[k] ?? 0) + 1;
      // item 'd' hits a transient 503 on its FIRST attempt, recovers on retry.
      if (k === 'd' && attempts[k] === 1) throw new Error('upstream 503 service unavailable');
      return 'done';
    });
    const ctx = {
      workflow: { name: 'W1b Item Retry Test', steps: [] },
      workflowSlug: 'w1b-item-retry',
      runId: 'w1b-1',
      inputs: {},
      stepOutputs: { pull: ['a', 'd'] },
      assistant: { respond: async () => { throw new Error('retired assistant.respond lane ran'); } },
      completedItems: new Map(),
      forEachFailures,
      qualityAdvisories: [],
    } as unknown as Parameters<typeof executeStep>[1];
    const step = { id: 'blast', prompt: 'Process the item.', forEach: 'pull' } as unknown as Parameters<typeof executeStep>[0];

    const output = await executeStep(step, ctx) as Array<{ itemKey: string }>;

    assert.deepEqual(output.map((i) => i.itemKey).sort(), ['a', 'd'], 'the transient item recovered on retry');
    assert.equal(forEachFailures.length, 0, 'no item failure after a successful retry');
    assert.equal(attempts.d, 2, 'item d ran twice — fail then retry-success');
    const retried = readWorkflowEvents('w1b-item-retry', 'w1b-1').find((e) => e.kind === 'item_retry');
    assert.equal(retried?.itemKey, 'd', 'an item_retry advisory was recorded');
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
    restoreEnv('WORKFLOW_USE_HARNESS', prevH);
  }
});

test('failed-item retry seeding inherits upstream + completed items but not stale downstream outputs', () => {
  const workflow = {
    name: 'Retry Seed Test',
    steps: [
      { id: 'pull', prompt: 'Pull records.' },
      { id: 'blast', prompt: 'Process one record.', forEach: 'pull', dependsOn: ['pull'] },
      { id: 'summarize', prompt: 'Summarize all processed records.', dependsOn: ['blast'] },
    ],
  } as never;
  const exactPull = [
    'a',
    'b',
    'c',
    ...Array.from({ length: 400 }, (_, index) =>
      `${'x'.repeat(90)}${index === 399 ? 'EXACT-RETRY-SEED-TAIL' : index}`),
  ];
  finalizeStepOutput(
    'retry-seed-test',
    'source-run',
    { id: 'pull', prompt: 'Pull records.' },
    exactPull,
  );
  appendWorkflowEvent('retry-seed-test', 'source-run', { kind: 'item_completed', stepId: 'blast', itemKey: 'a', output: 'done-a' });
  appendWorkflowEvent('retry-seed-test', 'source-run', { kind: 'item_failed', stepId: 'blast', itemKey: 'b', error: 'temporary b failure' });
  appendWorkflowEvent('retry-seed-test', 'source-run', { kind: 'item_completed', stepId: 'blast', itemKey: 'c', output: 'done-c' });
  appendWorkflowEvent('retry-seed-test', 'source-run', {
    kind: 'step_completed',
    stepId: 'blast',
    output: [
      { itemKey: 'a', output: 'done-a' },
      { itemKey: 'c', output: 'done-c' },
    ],
  });
  appendWorkflowEvent('retry-seed-test', 'source-run', { kind: 'step_completed', stepId: 'summarize', output: 'old summary missing b' });

  const seeded = seedFailedItemRetryRun(workflow, 'retry-seed-test', 'retry-run', {
    fromRunId: 'source-run',
    stepId: 'blast',
    itemKeys: ['b'],
  });

  assert.deepEqual(seeded, { inheritedSteps: 1, inheritedItems: 2, sentSkips: 0 });
  const state = computeResumeState('retry-seed-test', 'retry-run');
  assert.equal(
    (state.completedSteps.get('pull') as { truncated?: boolean }).truncated,
    true,
    'the retry journal remains compact',
  );
  const inheritedReference = state.completedStepArtifacts.get('pull');
  assert.ok(inheritedReference, 'the inherited completion owns a new exact artifact');
  const inheritedExact = readStepOutputArtifact({
    workflowName: 'retry-seed-test',
    runId: 'retry-run',
    stepId: 'pull',
    reference: inheritedReference,
  });
  assert.equal(inheritedExact.verified, true);
  assert.match(
    JSON.stringify(inheritedExact.value),
    /EXACT-RETRY-SEED-TAIL/,
    'failed-item retry seeding never inherits the truncated journal preview',
  );
  assert.equal(state.completedSteps.has('blast'), false, 'retry step reruns with failed item pending');
  assert.equal(state.completedSteps.has('summarize'), false, 'downstream summary must recompute after retry');
  assert.deepEqual(Array.from(state.completedItems.get('blast')?.keys() ?? []), ['a', 'c']);
  const seededEvent = readWorkflowEvents('retry-seed-test', 'retry-run')
    .find((ev) => ev.kind === 'step_advisory' && ev.meta?.reason === 'failed_item_retry_seeded');
  assert.equal(seededEvent?.meta?.inheritedSteps, 1);
  assert.equal(seededEvent?.meta?.inheritedItems, 2);
});

test('a raw external loop probe refuses before the primary model or provisional completion', async () => {
  const prevWorkflowHarness = process.env.WORKFLOW_USE_HARNESS;
  const prevBridgeHarness = process.env.CLEMMY_HARNESS_WORKFLOW;
  const prevLegacyFallback = process.env.CLEMMY_LEGACY_RESPOND_FALLBACK;
  process.env.WORKFLOW_USE_HARNESS = 'off';
  process.env.CLEMMY_HARNESS_WORKFLOW = 'off';
  process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
  const workflowSlug = 'deferred-probe-completion';
  const runId = 'probe-failed-before-commit';
  const marker = path.join(tmp, 'deferred-probe-process-started');
  const scriptsDir = path.join(WORKFLOWS_DIR, workflowSlug, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'probe.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'spawned'); console.log(JSON.stringify({ pending: true }));\n`,
    'utf-8',
  );
  const step = {
    id: 'poll_export',
    prompt: 'Start or inspect the export.',
    sideEffect: 'read',
    useHarness: false,
    loopUntil: {
      maxAttempts: 1,
      probe: { runner: 'probe.mjs' },
      until: { type: 'object', required_keys: ['done'] },
    },
  };
  let primaryCalls = 0;
  const ctx = {
    workflow: {
      name: 'Deferred Probe Completion',
      description: '',
      enabled: true,
      trigger: { manual: true },
      steps: [step],
    },
    workflowSlug,
    runId,
    inputs: {},
    stepOutputs: {},
    assistant: { respond: async () => { primaryCalls += 1; return { text: 'candidate output before probe' }; } },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];
  try {
    await assert.rejects(
      () => workflowRunnerInternalsForTest.runStepVerifiedAttempt(step as never, ctx),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowHarnessBlockedSignal);
        assert.match(
          error.reason,
          /workflow_raw_subprocess_authority_unrepresented.*loopUntil\.probe\.runner/i,
        );
        return true;
      },
    );
    const events = readWorkflowEvents(workflowSlug, runId);
    assert.equal(primaryCalls, 0, 'the primary model does not run before an unrepresentable exit gate');
    assert.equal(existsSync(marker), false, 'the probe process never starts');
    assert.equal(
      events.some((event) => event.kind === 'step_completed' && event.stepId === step.id),
      false,
      'an unrepresentable external exit condition owns no completion authority',
    );
    assert.equal(computeResumeState(workflowSlug, runId).completedSteps.has(step.id), false);
  } finally {
    restoreEnv('WORKFLOW_USE_HARNESS', prevWorkflowHarness);
    restoreEnv('CLEMMY_HARNESS_WORKFLOW', prevBridgeHarness);
    restoreEnv('CLEMMY_LEGACY_RESPOND_FALLBACK', prevLegacyFallback);
  }
});

test('a raw loop probe refuses before its primary exact call', async () => {
  const workflowSlug = 'deferred-call-probe-completion';
  const runId = 'call-probe-failed-before-commit';
  const marker = path.join(tmp, 'deferred-call-probe-process-started');
  const scriptsDir = path.join(WORKFLOWS_DIR, workflowSlug, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    path.join(scriptsDir, 'probe.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'spawned'); console.log(JSON.stringify({ pending: true }));\n`,
    'utf-8',
  );
  const step = {
    id: 'poll_sheet_export',
    prompt: 'Read the export state.',
    sideEffect: 'read',
    call: { tool: 'GOOGLESHEETS_GET_VALUES', args: { spreadsheet_id: 'sheet-test' } },
    loopUntil: {
      maxAttempts: 1,
      probe: { runner: 'probe.mjs' },
      until: { type: 'object', required_keys: ['done'] },
    },
  };
  const ctx = {
    workflow: {
      name: 'Deferred Call Probe Completion',
      description: '',
      enabled: true,
      trigger: { manual: true },
      steps: [step],
    },
    workflowSlug,
    runId,
    inputs: {},
    stepOutputs: {},
    assistant: { respond: async () => ({ text: 'unused' }) },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];
  let primaryCalls = 0;
  _setWorkflowCallNodeForTests(async () => {
    primaryCalls += 1;
    return { exportId: 'exp-1', status: 'pending' };
  });
  try {
    await assert.rejects(
      () => workflowRunnerInternalsForTest.runStepVerifiedAttempt(step as never, ctx),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowHarnessBlockedSignal);
        assert.match(
          error.reason,
          /workflow_raw_subprocess_authority_unrepresented.*loopUntil\.probe\.runner/i,
        );
        return true;
      },
    );
    assert.equal(primaryCalls, 0, 'the exact provider call does not cross before its exit gate is representable');
    assert.equal(existsSync(marker), false, 'the probe process never starts');
    assert.equal(
      readWorkflowEvents(workflowSlug, runId)
        .some((event) => event.kind === 'step_completed' && event.stepId === step.id),
      false,
    );
  } finally {
    _setWorkflowCallNodeForTests();
  }
});

test('a structured Composio call preserves its legacy envelope while validating nested provider data', async () => {
  const workflowSlug = 'call-output-envelope';
  const runId = 'call-output-envelope-run';
  const rows = [['fingerprint'], ['receipt-1']];
  const providerResult = {
    successful: true,
    data: { rows },
    logId: 'log-proof-readback-1',
  };
  const step = {
    id: 'readback',
    prompt: 'Read the rows back.',
    sideEffect: 'read',
    call: { tool: 'GOOGLESHEETS_VALUES_GET', args: { spreadsheet_id: 'sheet-test' } },
    output: {
      type: 'object',
      required_keys: ['successful', 'data', 'logId'],
      non_empty: ['data.rows'],
      min_items: { 'data.rows': 1 },
    },
  };
  const ctx = {
    workflow: {
      name: 'Call Output Envelope',
      description: '',
      enabled: true,
      trigger: { manual: true },
      steps: [step],
    },
    workflowSlug,
    runId,
    inputs: {},
    stepOutputs: {},
    assistant: { respond: async () => ({ text: 'unused' }) },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];

  _setWorkflowCallNodeForTests(async () => providerResult);
  try {
    const result = await executeStep(step as never, ctx);
    assert.deepEqual(result, providerResult);
    assert.deepEqual(
      (result as typeof providerResult).data.rows,
      rows,
      'existing {{steps.readback.output.data.rows}} bindings remain valid',
    );
    const completion = readWorkflowEvents(workflowSlug, runId)
      .find((event) => event.kind === 'step_completed' && event.stepId === step.id);
    assert.deepEqual(completion?.output, providerResult);
  } finally {
    _setWorkflowCallNodeForTests();
  }
});

// Regression pin (2026-08-26): 60db67d8 made an exact invocationPlan
// mandatory for any step carrying a structured `call`, deleting the
// dispatchable bare name/args lane that had worked for months — including
// the owner's own salesforce-quarterly-to-sheets, which has a bare
// GOOGLESHEETS_BATCH_UPDATE call step with no invocationPlan. ff05c19a
// restored dispatch through the gated composio gateway — but that gateway
// lane minted its own identity by appending a FABRICATED user_input_received
// event purely to satisfy the settlement spine: two execution kernels for
// one concept, one of them authenticating itself with a fake user.
//
// Converged (2026-08-26): a bare call now compiles its own invocation plan
// from the live host-capability catalog at execution time — the same
// precedent space-read-authority.ts already uses for workspace reads — and
// dispatches through the ONE v3 call kernel a plan-carrying step has always
// used (see compileWorkflowBareCallInvocationPlan / executeWorkflowCallNode
// / executeExactWorkflowV3CallNode in workflow-runner.ts). No chat turn is
// minted for this lane at all: the kernel's own real
// workflow_node_invocation_activated activation event is its lineage. Full
// end-to-end success — a live catalog entry present, reaching the provider
// body with zero synthetic turn — is pinned in
// workflow-runner-v3-call.integration.red.test.ts, which already carries the
// catalog/observation fixture machinery that needs. This lightweight test
// proves the other required half: with NO catalog entry for the operation
// (this sandboxed test home has none), the step refuses by naming exactly
// what is missing (not-connected) — never a silent second dispatch lane,
// never a fabricated identity — and mints no session/turn for the refusal.
test('THE OWNER\'S SHAPE: a bare call step (no invocationPlan) compiles at execution and refuses by name when unregistered', async () => {
  const workflow = {
    name: 'salesforce-quarterly-to-sheets-shape',
    description: 'Write the transformed grid to the target sheet.',
    enabled: true,
    trigger: { manual: true },
    inputs: { spreadsheet_id: { type: 'string' } },
    steps: [
      {
        id: 'grid',
        prompt: '',
        sideEffect: 'read',
        transform: {
          version: 1,
          expression: { op: 'literal', value: { data: [['a', 'b']] } },
        },
      },
      {
        id: 'write',
        prompt: '',
        dependsOn: ['grid'],
        sideEffect: 'write',
        call: {
          tool: 'GOOGLESHEETS_BATCH_UPDATE',
          args: {
            spreadsheet_id: '{{input.spreadsheet_id}}',
            data: '{{steps.grid.output.data}}',
            value_input_option: 'RAW',
          },
        },
      },
    ],
  };
  const validation = validateWorkflowDefinition(workflow as never);
  assert.equal(validation.ok, true, validation.errors.join('\n'));

  const step = workflow.steps[1];
  const workflowSlug = 'salesforce-quarterly-to-sheets-shape';
  const runId = 'bare-call-owner-shape-run';
  const ctx = {
    workflow,
    workflowSlug,
    runId,
    inputs: { spreadsheet_id: 'sheet-xyz' },
    stepOutputs: { grid: { data: [['a', 'b']] } },
    assistant: { respond: async () => ({ text: 'unused' }) },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];

  const { installHostCapabilityCatalogFactory, createHostCapabilityCatalogFactory } =
    await import('../runtime/harness/host-capability-catalog-factory.js');
  installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory([]));
  try {
    await assert.rejects(
      () => executeStep(step as never, ctx),
      (error: unknown) => error instanceof WorkflowCapabilityBlockedError
        && error.reason === 'not-connected'
        && error.tool === 'GOOGLESHEETS_BATCH_UPDATE'
        && /GOOGLESHEETS_BATCH_UPDATE/.test(error.message),
    );
  } finally {
    installHostCapabilityCatalogFactory(null);
  }
  // The refusal happened before any identity was ever needed — no session
  // exists for it, fabricated or otherwise.
  const { getSession } = await import('../runtime/harness/eventlog.js');
  assert.equal(getSession(`workflow:${runId}:${step.id}`), null);
});

// Direction pin: the restored bare-call lane must stay GATED — an autonomous
// SEND-class bare call still hits the SEND-CALL GATE (no approval, no exact
// scheduled-send authority) and refuses BEFORE the composio gateway, not a
// raw pass-through. Proves the restored lane isn't a safety regression.
test('a bare SEND-class call without approval or exact schedule authority refuses before the gateway (gated, not raw)', async () => {
  const step = {
    id: 'notify',
    prompt: '',
    sideEffect: 'send',
    call: { tool: 'GMAIL_SEND_EMAIL', args: { to: 'someone@example.com', subject: 'hi', body: 'hi' } },
  };
  const ctx = {
    workflow: {
      name: 'Bare Send Refused',
      description: '',
      enabled: true,
      trigger: { manual: true },
      steps: [step],
    },
    workflowSlug: 'bare-send-refused',
    runId: 'bare-send-refused-run',
    inputs: {},
    stepOutputs: {},
    assistant: { respond: async () => ({ text: 'unused' }) },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];

  let gatewayReached = false;
  _setBeforeWorkflowCallGatewayForTests(() => {
    gatewayReached = true;
  });
  try {
    await assert.rejects(
      () => executeStep(step as never, ctx),
      /lost exact scheduled-send authority/,
    );
  } finally {
    _setBeforeWorkflowCallGatewayForTests(null);
  }
  assert.equal(gatewayReached, false, 'an ungated autonomous SEND must refuse before it ever reaches the dispatch gateway');
});

test('workflow conversion: a plain step routes through the GATED harness loop when CLEMMY_HARNESS_WORKFLOW=on (not the legacy core)', async () => {
  // Proves the staged workflow-step conversion (respondPreferHarness on the
  // default-off `workflow` surface) actually rides the harness when flipped on,
  // and the legacy core is NOT used. Combined with the architect/home behavioral
  // smoke (respondPreferHarness returns valid step text) + the unchanged chaining
  // (renderTemplate/stepOutputs), this closes the workflow-conversion validation.
  const prev = process.env.CLEMMY_HARNESS_WORKFLOW;
  const prevWUH = process.env.WORKFLOW_USE_HARNESS;
  process.env.CLEMMY_HARNESS_WORKFLOW = 'on';
  // Force the legacy/fallback branch (where this conversion lives): the PRIMARY
  // path already rides the harness via runStepViaHarness when WORKFLOW_USE_HARNESS
  // is on. This conversion gates the fallback through the bridge instead.
  process.env.WORKFLOW_USE_HARNESS = 'off';
  const { _setBridgeImplsForTests } = await import('../runtime/harness/respond-bridge.js');
  _setBridgeImplsForTests({
    configure: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (opts: { sessionId: string }) => ({
      sessionId: opts.sessionId, steps: 1, lastTurn: 1, status: 'completed',
      lastDecision: { reply: 'HARNESS-STEP-OUTPUT', nextAction: 'completed' },
    })) as never,
  });
  try {
    let legacyCalled = false;
    const ctx = {
      workflow: { name: 'WF Harness Route', steps: [] },
      workflowSlug: 'wf-harness-route', runId: 'wf-hr-1', inputs: {}, stepOutputs: {},
      assistant: { respond: async () => { legacyCalled = true; return { text: 'LEGACY-OUTPUT', sessionId: 'x' }; } },
      completedItems: new Map(), forEachFailures: [],
    } as unknown as Parameters<typeof executeStep>[1];
    const step = { id: 'route', prompt: 'produce output' } as unknown as Parameters<typeof executeStep>[0];
    const out = await executeStep(step, ctx);
    assert.equal(out, 'HARNESS-STEP-OUTPUT', 'step output came from the gated harness loop');
    assert.equal(legacyCalled, false, 'legacy ungated core NOT used when the flag is on');
  } finally {
    _setBridgeImplsForTests({});
    if (prev === undefined) delete process.env.CLEMMY_HARNESS_WORKFLOW; else process.env.CLEMMY_HARNESS_WORKFLOW = prev;
    if (prevWUH === undefined) delete process.env.WORKFLOW_USE_HARNESS; else process.env.WORKFLOW_USE_HARNESS = prevWUH;
  }
});

test('executeStep: legacy plain deliverable step records inferred output-contract advisory', async () => {
  const prevWorkflowHarness = process.env.WORKFLOW_USE_HARNESS;
  process.env.WORKFLOW_USE_HARNESS = 'on';
  try {
    installCanonicalWorkflowTextHarness(async () => 'No leads found.');
    const qualityAdvisories: Array<{ kind: string; note: string }> = [];
    const ctx = {
      workflow: { name: 'Legacy Deliverable Advisory', steps: [] },
      workflowSlug: 'legacy-deliverable-advisory',
      runId: 'legacy-deliverable-1',
      inputs: {},
      stepOutputs: {},
      assistant: { respond: async () => { throw new Error('retired assistant.respond lane ran'); } },
      completedItems: new Map(),
      forEachFailures: [],
      qualityAdvisories,
    } as unknown as Parameters<typeof executeStep>[1];
    const step = {
      id: 'lead_list',
      prompt: 'Generate a list of weekly leads.',
    } as unknown as Parameters<typeof executeStep>[0];

    const out = await executeStep(step, ctx);
    assert.equal(out, 'No leads found.');
    const advisory = qualityAdvisories.find((a) => a.kind === 'inferred_output_contract');
    assert.match(advisory?.note ?? '', /non-empty list/);
    const event = readWorkflowEvents('legacy-deliverable-advisory', 'legacy-deliverable-1')
      .find((ev) => ev.kind === 'step_advisory' && ev.meta?.reason === 'inferred_output_contract');
    assert.equal(event?.stepId, 'lead_list');
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
    restoreEnv('WORKFLOW_USE_HARNESS', prevWorkflowHarness);
  }
});

test('findContractViolationStep: finds the most-recent output_contract failure with its problems', () => {
  const events = [
    { t: '1', kind: 'step_started', stepId: 'a' },
    { t: '2', kind: 'step_failed', stepId: 'a', meta: { reason: 'output_contract', problems: ['missing required output key "url"'] } },
  ] as never;
  const cv = findContractViolationStep(events);
  assert.equal(cv?.stepId, 'a');
  assert.deepEqual(cv?.problems, ['missing required output key "url"']);
});

test('findContractViolationStep: null when the failure is not a contract violation', () => {
  assert.equal(findContractViolationStep([{ t: '1', kind: 'step_failed', stepId: 'a', meta: { reason: 'transient' } }] as never), null);
  assert.equal(findContractViolationStep([{ t: '1', kind: 'step_completed', stepId: 'a' }] as never), null);
  assert.equal(findContractViolationStep([] as never), null);
});

test('P1-9 finalizeStepOutput: empty-only violation → "produced no usable data" + empty_output reason (skips the Doctor)', () => {
  // The SF→Airtable shape: required_keys are present, but the list is empty.
  const step = {
    id: 'pull',
    prompt: 'x',
    output: { required_keys: ['prospects'], non_empty: ['prospects'] },
  } as never;
  assert.throws(
    () => finalizeStepOutput('empty-route-test', 'er-1', step, { prospects: [], note: 'Blocked: SF expired' }),
    /produced no usable data/,
  );
  const failed = readWorkflowEvents('empty-route-test', 'er-1').find((e) => e.kind === 'step_failed');
  assert.equal((failed as { meta?: { reason?: string } })?.meta?.reason, 'empty_output');
  // empty_output is a DATA problem → NOT routed to the Doctor.
  assert.equal(findContractViolationStep(readWorkflowEvents('empty-route-test', 'er-1')), null);
});

test('P1-9 finalizeStepOutput: a shape violation alongside an empty one stays output_contract (routes to Doctor)', () => {
  const step = {
    id: 'pull',
    prompt: 'x',
    output: { required_keys: ['prospects', 'summary'], non_empty: ['prospects'] },
  } as never;
  // Missing `summary` (shape) + empty `prospects` (emptiness) → mixed → contract.
  assert.throws(
    () => finalizeStepOutput('empty-route-test', 'er-2', step, { prospects: [] }),
    /failed its contract/,
  );
  const failed = readWorkflowEvents('empty-route-test', 'er-2').find((e) => e.kind === 'step_failed');
  assert.equal((failed as { meta?: { reason?: string } })?.meta?.reason, 'output_contract');
  assert.equal(findContractViolationStep(readWorkflowEvents('empty-route-test', 'er-2'))?.stepId, 'pull');
});

test('forEach object contracts validate each item while the aggregate gets an array contract', () => {
  const itemContract = {
    type: 'object' as const,
    required_keys: ['competitor', 'url', 'evidence'],
    non_empty: ['competitor', 'url', 'evidence'],
    verify: { url_present: ['url'] },
  };
  const step = {
    id: 'research_competitors',
    prompt: 'Research one competitor.',
    forEach: 'competitors',
    output: itemContract,
  };

  assert.equal(forEachItemOutputContract(step), itemContract);
  assert.deepEqual(forEachAggregateOutputContract(step), {
    type: 'array',
    non_empty: [''],
    min_items: { '': 1 },
    description: 'Fan-out aggregate for step "research_competitors" ({itemKey, output} per completed item).',
  });
  assert.deepEqual(
    verifyForEachItemOutput(
      step,
      '```json\n{"competitor":"Hermes","url":"https://github.com/NousResearch/hermes-agent","evidence":"official repository"}\n```',
    ),
    {
      competitor: 'Hermes',
      url: 'https://github.com/NousResearch/hermes-agent',
      evidence: 'official repository',
    },
  );
  assert.throws(
    () => verifyForEachItemOutput(step, { competitor: 'Hermes', url: 'not-a-url', evidence: '' }),
    /item output failed its contract/,
  );
});

test('forEach array contracts retain legacy aggregate validation semantics', () => {
  const aggregateContract = {
    type: 'array' as const,
    non_empty: [''],
    min_items: { '': 3 },
  };
  const step = {
    id: 'fanout',
    prompt: 'Process each item.',
    forEach: 'items',
    output: aggregateContract,
  };
  assert.equal(forEachItemOutputContract(step), undefined);
  assert.equal(forEachAggregateOutputContract(step), aggregateContract);
});

// Cleanup the temp BASE_DIR.
test.after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---- #4: deterministic-step spawn error is made legible ----

test('explainDeterministicSpawnError: EPERM names the packaged-app TCC sandbox cause', () => {
  const err = Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
  const out = explainDeterministicSpawnError(err, 'scripts/fetch.py');
  assert.match(out.message, /sandbox|TCC|entitlement/i);
  assert.match(out.message, /scripts\/fetch\.py/);
});

test('explainDeterministicSpawnError: ENOENT points at a missing interpreter/script', () => {
  const err = Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' });
  const out = explainDeterministicSpawnError(err, 'scripts/fetch.py');
  assert.match(out.message, /missing/i);
});

test('explainDeterministicSpawnError: an unrelated error passes through unchanged', () => {
  const err = new Error('some other failure');
  const out = explainDeterministicSpawnError(err, 'scripts/x.sh');
  assert.equal(out.message, 'some other failure');
});

// ---- Wave 2.1: substance gap — empty read feeding downstream is a MISS ----

test('stepConsumesOutput: dependsOn, forEach, and {{steps.x.output}} all count as consuming', () => {
  assert.equal(stepConsumesOutput({ id: 'b', prompt: 'x', dependsOn: ['a'] } as any, 'a'), true);
  assert.equal(stepConsumesOutput({ id: 'b', prompt: 'x', forEach: 'a' } as any, 'a'), true);
  assert.equal(stepConsumesOutput({ id: 'b', prompt: 'x', forEach: '{{steps.a.output.items}}' } as any, 'a'), true);
  assert.equal(stepConsumesOutput({ id: 'b', prompt: 'use {{steps.a.output}} now' } as any, 'a'), true);
  assert.equal(stepConsumesOutput({ id: 'b', prompt: 'unrelated' } as any, 'a'), false);
  // a different step id that is a prefix must NOT match (steps.a vs steps.account)
  assert.equal(stepConsumesOutput({ id: 'b', prompt: 'use {{steps.account.output}}' } as any, 'a'), false);
});

test('detectEmptyDeliverableReads: an empty read feeding a forEach is flagged', () => {
  const steps = [
    { id: 'find_prospects', prompt: 'query CRM for prospects' },
    { id: 'email_each', prompt: 'email them', forEach: 'find_prospects' },
  ] as any;
  const hits = detectEmptyDeliverableReads(steps, { find_prospects: [], email_each: [] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].stepId, 'find_prospects');
  assert.equal(hits[0].consumerId, 'email_each');
});

test('detectEmptyDeliverableReads: a NON-empty read is not flagged', () => {
  const steps = [
    { id: 'find', prompt: 'query' },
    { id: 'use', prompt: 'use {{steps.find.output}}' },
  ] as any;
  assert.equal(detectEmptyDeliverableReads(steps, { find: [{ id: 1 }], use: 'ok' }).length, 0);
});

test('detectEmptyDeliverableReads: a TERMINAL empty read (no consumer) is not flagged (legit "nothing found")', () => {
  const steps = [{ id: 'find_overdue', prompt: 'find overdue invoices' }] as any;
  assert.equal(detectEmptyDeliverableReads(steps, { find_overdue: [] }).length, 0);
});

test('detectEmptyDeliverableReads: an empty WRITE/SEND step is not flagged (only reads)', () => {
  const steps = [
    { id: 'send_blast', prompt: 'send the email blast to the list', sideEffect: 'send' },
    { id: 'log_it', prompt: 'record {{steps.send_blast.output}}' },
  ] as any;
  assert.equal(detectEmptyDeliverableReads(steps, { send_blast: {}, log_it: 'x' }).length, 0);
});

test('detectEmptyDeliverableReads: a declared non_empty contract is NOT double-flagged (contract enforces it)', () => {
  const steps = [
    { id: 'pull', prompt: 'pull rows', output: { non_empty: [''] } },
    { id: 'next', prompt: 'use {{steps.pull.output}}' },
  ] as any;
  assert.equal(detectEmptyDeliverableReads(steps, { pull: [], next: 'x' }).length, 0);
});

test("detectEmptyDeliverableReads: a step that didn't run is skipped (partial resume)", () => {
  const steps = [
    { id: 'a', prompt: 'read' },
    { id: 'b', prompt: 'use {{steps.a.output}}' },
  ] as any;
  // 'a' not in outputs (never ran) → nothing to flag
  assert.equal(detectEmptyDeliverableReads(steps, { b: 'x' }).length, 0);
});

// ---- Wave 2.2: structured run summary — artifacts (files/URLs/counts) ----

test('summarizeRunArtifacts: collects URLs, declared files, and row counts', () => {
  const steps = [
    { id: 'pull', prompt: 'query', output: {} },
    { id: 'render', prompt: 'render', output: { verify: { path_exists: ['path'] } } },
    { id: 'publish', prompt: 'deploy' },
  ] as any;
  const art = summarizeRunArtifacts(steps, {
    pull: { contacts: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    render: { path: '/Users/x/report.html' },
    publish: { url: 'https://demo.netlify.app' },
  });
  assert.deepEqual(art.counts, ['contacts: 3']);
  assert.deepEqual(art.files, ['/Users/x/report.html']);
  assert.deepEqual(art.urls, ['https://demo.netlify.app']);
});

test('summarizeRunArtifacts: a top-level array output is counted by step id', () => {
  const steps = [{ id: 'rows', prompt: 'pull' }] as any;
  const art = summarizeRunArtifacts(steps, { rows: [1, 2, 3, 4] });
  assert.deepEqual(art.counts, ['rows: 4']);
});

test('summarizeRunArtifacts: an empty run produces NO artifacts (so the no-op stays silent)', () => {
  const steps = [
    { id: 'find', prompt: 'find new' },
    { id: 'act', prompt: 'use {{steps.find.output}}' },
  ] as any;
  const art = summarizeRunArtifacts(steps, { find: [], act: {} });
  assert.equal(art.counts.length, 0);
  assert.equal(art.files.length, 0);
  assert.equal(art.urls.length, 0);
});

test('summarizeRunArtifacts: dedupes URLs and ignores _meta when counting', () => {
  const steps = [{ id: 's', prompt: 'x' }] as any;
  const art = summarizeRunArtifacts(steps, {
    s: { _meta: { ok: true }, rows: ['a', 'b'], link: 'see https://site.example and https://site.example again' },
  });
  assert.deepEqual(art.counts, ['rows: 2']);
  assert.deepEqual(art.urls, ['https://site.example']);
});

test('reapResolvedParkedRuns does NOT re-admit when a watched approval row is missing (no auto-approve on a lost row)', () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  // 'apr-ghost' was never registered → get() returns undefined → cannot
  // confirm resolution → the run must stay parked (the watchdog surfaces it).
  const filePath = writeParkedRun('park-ghost', ['apr-ghost-never-registered']);
  reapResolvedParkedRuns();
  assert.equal(statusOf(filePath), 'parked');
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

test('reapResolvedParkedRuns does NOT re-admit a parked run with empty watched approvalIds (thrash guard)', () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  const filePath = writeParkedRun('park-empty', []);
  reapResolvedParkedRuns();
  assert.equal(statusOf(filePath), 'parked');
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

test('awaitDeclarativeStepApproval creates the gate session so register() does not FK (live regression)', async () => {
  // Repro of the live e2e bug: a requires_approval gate registered an approval
  // under workflow-gate:<runId>:<stepId> with NO sessions row → pending_approvals
  // FK violation → run_failed before it could park. The fix creates the gate
  // session first. With parking on, the gate registers then throws to release
  // the slot — assert it throws but NOT a FK error, and the row was created.
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  const runId = 'gate-fk-regression';
  const gateSessionId = `workflow-gate:${runId}:send`;
  assert.equal(HarnessSession.load(gateSessionId), null, 'no pre-existing gate session (the bug condition)');

  const ctx = {
    workflow: { name: 'Gate FK WF', steps: [] },
    workflowSlug: 'gate-fk-wf',
    runId,
    inputs: {},
    stepOutputs: {},
    assistant: {} as never,
    completedItems: new Map(),
    forEachFailures: [],
  } as never;
  const step = { id: 'send', prompt: 'send it', requiresApproval: true, approvalPreview: 'Send the thing' } as never;

  let threw: Error | null = null;
  try {
    await workflowRunnerInternalsForTest.awaitDeclarativeStepApproval(ctx, step);
  } catch (e) {
    threw = e as Error;
  }
  assert.ok(threw, 'parking path throws (ParkRunSignal) to release the slot');
  assert.ok(!/FOREIGN KEY/i.test(threw!.message), `must not FK: ${threw!.message}`);
  assert.ok(HarnessSession.load(gateSessionId), 'gate session row was created');
  const pending = approvalRegistry.listPending({ sessionId: gateSessionId, status: 'pending' });
  assert.equal(pending.length, 1, 'exactly one pending gate approval registered');

  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

// ---------------------------------------------------------------------------
// Feature B — bounded autonomous self-heal + re-run
// ---------------------------------------------------------------------------

const { writeWorkflow: writeWorkflowForHeal } = await import('../memory/workflow-store.js');
const { recordProposedFix } = await import('./workflow-diagnosis.js');

function editStepDiagnosis(stepId: string, autoApplicable = true, kind: 'edit_step' | 'reconnect_service' = 'edit_step') {
  return {
    summary: 'A step blocked.',
    rootCause: 'The step was too vague about how to reach Salesforce.',
    fix: {
      kind,
      stepId,
      description: 'Bind the step to the proven sf CLI.',
      newStepPrompt: kind === 'edit_step' ? `Query Salesforce. Use this exact, proven command: \`sf data query --json --query "SELECT Id FROM Account"\` via run_shell_command.` : null,
      newOutputContractJson: null,
      service: kind === 'reconnect_service' ? 'Salesforce' : null,
      autoApplicable,
    },
    confidence: 'high' as const,
  };
}

/** RSH-1: an edit_contract fix — corrects a too-strict output contract. */
function editContractDiagnosis(stepId: string, contractJson: string, autoApplicable = true) {
  return {
    summary: 'The step produced valid data but its contract was too strict.',
    rootCause: 'The declared output contract required a key the real data legitimately omits.',
    fix: {
      kind: 'edit_contract' as const,
      stepId,
      description: 'Loosen the output contract to match the real data shape.',
      newStepPrompt: null,
      newOutputContractJson: contractJson,
      newInputsJson: null,
      newAllowedToolsJson: null,
      service: null,
      autoApplicable,
    },
    confidence: 'high' as const,
  };
}

/** RSH-3: an edit_input fix — corrects a step's typed input binding. */
function editInputDiagnosis(stepId: string, inputsJson: string, autoApplicable = true) {
  return {
    summary: 'The step could not resolve a required input.',
    rootCause: 'The input binding pointed at a source that does not exist.',
    fix: {
      kind: 'edit_input' as const,
      stepId,
      description: 'Rebind the input to the correct source.',
      newStepPrompt: null,
      newOutputContractJson: null,
      newInputsJson: inputsJson,
      newAllowedToolsJson: null,
      service: null,
      autoApplicable,
    },
    confidence: 'high' as const,
  };
}

function writeHealWorkflow(name: string, steps: Array<{ id: string; prompt: string; requiresApproval?: boolean }>): void {
  writeWorkflowForHeal(name, {
    name,
    description: 'Self-heal test workflow.',
    enabled: true,
    trigger: { manual: true },
    steps: steps.map((s) => ({ id: s.id, prompt: s.prompt, requiresApproval: s.requiresApproval })),
  });
}

function freshRunsFor(wf: string, origId: string): Array<Record<string, unknown>> {
  return readdirSync(WORKFLOW_RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== `${origId}.json`)
    .map((f) => JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')) as Record<string, unknown>)
    .filter((r) => r.workflow === wf);
}

function removeFreshRunsFor(wf: string, origId: string): void {
  for (const file of readdirSync(WORKFLOW_RUNS_DIR)) {
    if (!file.endsWith('.json') || file === `${origId}.json`) continue;
    const fullPath = path.join(WORKFLOW_RUNS_DIR, file);
    try {
      const run = JSON.parse(readFileSync(fullPath, 'utf-8')) as { workflow?: unknown };
      if (run.workflow === wf) rmSync(fullPath, { force: true });
    } catch {
      // A malformed fixture is not ours to remove.
    }
  }
}

test('self-heal: below cap → applies the edit_step fix + re-queues a fresh run carrying attempt+1', async (t) => {
  // T3.2: the cross-family veto judge would attempt a live model call here —
  // disable it (kill-switch) so the heal proceeds on the fail-open path.
  process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
  const wf = 'heal-below-cap';
  t.after(() => removeFreshRunsFor(wf, `${wf}-run`));
  writeHealWorkflow(wf, [{ id: 'find', prompt: 'Query Salesforce for prospects somehow.' }]);
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: {}, status: 'completed', originSessionId: 'sess-h' }), 'utf-8');
  const fix = recordProposedFix(wf, origId, editStepDiagnosis('find'));

  const out = await workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
    run: { id: origId, workflow: wf, originSessionId: 'sess-h', selfHealAttempt: 0 },
    workflowSlug: wf,
    steps: [{ id: 'find', prompt: 'Query Salesforce for prospects somehow.' }] as never,
    diagnosis: editStepDiagnosis('find') as never,
    proposedFix: fix,
    completedStepIds: new Set(['find']),
  });
  assert.ok(out, 'heal fired');
  assert.equal(out!.attempt, 1);
  const fresh = freshRunsFor(wf, origId) as Array<{ workflow: string; selfHealAttempt?: number; originSessionId?: string }>;
  assert.equal(fresh.length, 1, 'one fresh re-run queued');
  assert.equal(fresh[0].selfHealAttempt, 1, 'carries the bumped attempt counter');
  assert.equal(fresh[0].originSessionId, 'sess-h', 'carries origin so the re-run re-enters chat');
  // T3.2: the healed re-run carries the reversible backup id so a non-stick
  // heal auto-reverts.
  assert.equal(typeof (fresh[0] as { selfHealBackupId?: string }).selfHealBackupId, 'string', 'carries the heal backup id');
  delete process.env.CLEMMY_JUDGE_CROSS_FAMILY;
});

test('self-heal RSH-1: an edit_contract fix auto-applies (loosens the contract) + re-queues', async (t) => {
  process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
  const wf = 'heal-contract';
  t.after(() => removeFreshRunsFor(wf, `${wf}-run`));
  writeHealWorkflow(wf, [{ id: 'gather', prompt: 'Gather leads and return them.' }]);
  // give the step a too-strict contract, then heal it
  const entry = (await import('../memory/workflow-store.js'));
  const cur = entry.readWorkflow(wf)!.data;
  entry.writeWorkflow(wf, { ...cur, steps: [{ ...cur.steps[0], output: { type: 'object', required_keys: ['name', 'email', 'phone'] } }] });
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: {}, status: 'completed', originSessionId: 'sess-c' }), 'utf-8');
  const diag = editContractDiagnosis('gather', '{"type":"object","required_keys":["name","email"]}');
  const fix = recordProposedFix(wf, origId, diag as never);

  const out = await workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
    run: { id: origId, workflow: wf, originSessionId: 'sess-c', selfHealAttempt: 0 },
    workflowSlug: wf,
    steps: [{ id: 'gather', prompt: 'Gather leads and return them.' }] as never,
    diagnosis: diag as never,
    proposedFix: fix,
    completedStepIds: new Set(['gather']),
    // RSH-2: the real output satisfies the loosened contract → probe passes.
    rawStepOutputs: { gather: { name: 'Ada', email: 'ada@site-alt.example' } },
  });
  assert.ok(out, 'contract heal fired');
  // the workflow's contract was loosened on disk
  assert.deepEqual(entry.readWorkflow(wf)!.data.steps[0].output, { type: 'object', required_keys: ['name', 'email'] });
  // and a fresh re-run was queued carrying the backup id for auto-revert
  const fresh = freshRunsFor(wf, origId) as Array<{ selfHealBackupId?: string }>;
  assert.equal(fresh.length, 1);
  assert.equal(typeof fresh[0].selfHealBackupId, 'string');
  delete process.env.CLEMMY_JUDGE_CROSS_FAMILY;
});

test('self-heal RSH-3: an edit_input fix auto-applies (rebinds the input) + re-queues', async (t) => {
  process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
  const wf = 'heal-input';
  t.after(() => removeFreshRunsFor(wf, `${wf}-run`));
  writeHealWorkflow(wf, [{ id: 'fetch', prompt: 'Fetch {{input.url}} and return it.' }]);
  const entry = (await import('../memory/workflow-store.js'));
  const cur = entry.readWorkflow(wf)!.data;
  entry.writeWorkflow(wf, {
    ...cur, inputs: { url: { type: 'string' } },
    steps: [{ ...cur.steps[0], inputs: { url: { from: 'input.wrongname' } } }],
  });
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: { url: 'https://site-alt.example' }, status: 'completed', originSessionId: 'sess-i' }), 'utf-8');
  const diag = editInputDiagnosis('fetch', '{"url":{"from":"input.url"}}');
  const fix = recordProposedFix(wf, origId, diag as never);

  const out = await workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
    run: { id: origId, workflow: wf, originSessionId: 'sess-i', selfHealAttempt: 0 },
    workflowSlug: wf,
    steps: [{ id: 'fetch', prompt: 'Fetch {{input.url}} and return it.' }] as never,
    diagnosis: diag as never,
    proposedFix: fix,
    completedStepIds: new Set(['fetch']),
  });
  assert.ok(out, 'input heal fired');
  assert.deepEqual(entry.readWorkflow(wf)!.data.steps[0].inputs, { url: { from: 'input.url' } });
  const fresh = freshRunsFor(wf, origId) as Array<{ selfHealBackupId?: string }>;
  assert.equal(fresh.length, 1);
  assert.equal(typeof fresh[0].selfHealBackupId, 'string');
  delete process.env.CLEMMY_JUDGE_CROSS_FAMILY;
});

test('self-heal RSH-2: probe blocks a doomed contract fix (real output still fails it) — no apply, no re-run', async () => {
  process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
  const wf = 'heal-probe-block';
  writeHealWorkflow(wf, [{ id: 'gather', prompt: 'Gather leads.' }]);
  const entry = (await import('../memory/workflow-store.js'));
  const cur = entry.readWorkflow(wf)!.data;
  const strict = { type: 'object' as const, required_keys: ['name', 'email', 'phone'] };
  entry.writeWorkflow(wf, { ...cur, steps: [{ ...cur.steps[0], output: strict }] });
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: {}, status: 'completed' }), 'utf-8');
  // the Doctor proposes requiring [name,email] — but the REAL output only has name,
  // so even the data we have would fail the "fixed" contract → probe must reject.
  const diag = editContractDiagnosis('gather', '{"type":"object","required_keys":["name","email"]}');
  const fix = recordProposedFix(wf, origId, diag as never);

  const out = await workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
    run: { id: origId, workflow: wf, selfHealAttempt: 0 },
    workflowSlug: wf,
    steps: [{ id: 'gather', prompt: 'Gather leads.' }] as never,
    diagnosis: diag as never,
    proposedFix: fix,
    completedStepIds: new Set(['gather']),
    rawStepOutputs: { gather: { name: 'Ada' } }, // missing email → fails the proposed contract
  });
  assert.equal(out, null, 'doomed contract fix → escalate, do not auto-heal');
  // the workflow contract is UNTOUCHED (fix never applied) and no re-run queued
  assert.deepEqual(entry.readWorkflow(wf)!.data.steps[0].output, strict);
  assert.equal(freshRunsFor(wf, origId).length, 0, 'no wasted re-run');
  delete process.env.CLEMMY_JUDGE_CROSS_FAMILY;
});

test('self-heal: at the attempt cap → escalates (no auto re-run)', async () => {
  const wf = 'heal-at-cap';
  writeHealWorkflow(wf, [{ id: 'find', prompt: 'Query Salesforce for prospects somehow.' }]);
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: {}, status: 'completed' }), 'utf-8');
  const fix = recordProposedFix(wf, origId, editStepDiagnosis('find'));
  const max = workflowRunnerInternalsForTest.selfHealAutoMaxAttempts();

  const out = await workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
    run: { id: origId, workflow: wf, selfHealAttempt: max },
    workflowSlug: wf,
    steps: [{ id: 'find', prompt: 'x' }] as never,
    diagnosis: editStepDiagnosis('find') as never,
    proposedFix: fix,
    completedStepIds: new Set(['find']),
  });
  assert.equal(out, null, 'at cap → does not auto-heal');
  assert.equal(freshRunsFor(wf, origId).length, 0, 'no fresh run queued at cap');
});

test('self-heal: a completed UPSTREAM mutating step blocks auto re-run (no double side-effects)', () => {
  const steps = [{ id: 'send', prompt: 'Send the emails.', requiresApproval: true }, { id: 'find', prompt: 'x' }];
  // send (mutating) already completed → guard trips.
  assert.equal(
    workflowRunnerInternalsForTest.hasCompletedUpstreamMutation(steps as never, 'find', new Set(['send', 'find'])),
    true,
  );
  // the blocked step itself being requiresApproval does NOT trip the guard.
  assert.equal(
    workflowRunnerInternalsForTest.hasCompletedUpstreamMutation(
      [{ id: 'find', prompt: 'x', requiresApproval: true }] as never, 'find', new Set(['find'])),
    false,
  );
});

test('self-heal: a non-edit_step (reconnect) fix is never auto-applied', async () => {
  const wf = 'heal-reconnect';
  writeHealWorkflow(wf, [{ id: 'find', prompt: 'x' }]);
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: {}, status: 'completed' }), 'utf-8');
  const fix = recordProposedFix(wf, origId, editStepDiagnosis('find', false, 'reconnect_service'));
  const out = await workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
    run: { id: origId, workflow: wf, selfHealAttempt: 0 },
    workflowSlug: wf,
    steps: [{ id: 'find', prompt: 'x' }] as never,
    diagnosis: editStepDiagnosis('find', false, 'reconnect_service') as never,
    proposedFix: fix,
    completedStepIds: new Set(['find']),
  });
  assert.equal(out, null, 'reconnect_service escalates, never auto-applies');
});

test('self-heal: a completed upstream IRREVERSIBLE-SEND step (unmarked) blocks auto re-run', () => {
  // Adversarial review B-1: requiresApproval alone is insufficient — an unmarked
  // "send the emails" step that completed must still block a fresh re-run.
  const steps = [{ id: 'send', prompt: 'Send the prospect emails to each contact.' }, { id: 'find', prompt: 'x' }];
  assert.equal(
    workflowRunnerInternalsForTest.hasCompletedUpstreamMutation(steps as never, 'find', new Set(['send', 'find'])),
    true,
  );
  // A benign read upstream does NOT block.
  const reads = [{ id: 'read', prompt: 'Read the prospect list from the sheet.' }, { id: 'find', prompt: 'x' }];
  assert.equal(
    workflowRunnerInternalsForTest.hasCompletedUpstreamMutation(reads as never, 'find', new Set(['read', 'find'])),
    false,
  );
});

test('self-heal: a completed structured write blocks a fresh-run duplicate even with a stale read label', () => {
  const steps = [
    {
      id: 'create',
      prompt: 'Store the approved record.',
      sideEffect: 'read',
      call: { tool: 'AIRTABLE_CREATE_RECORD', args: { table: 'Prospects' } },
    },
    { id: 'find', prompt: 'x' },
  ];
  assert.equal(
    workflowRunnerInternalsForTest.hasCompletedUpstreamMutation(steps as never, 'find', new Set(['create', 'find'])),
    true,
  );
});

test('self-heal: an ungated future post/send step blocks auto re-run after a prompt edit', async () => {
  const wf = 'heal-ungated-post';
  writeHealWorkflow(wf, [
    { id: 'research', prompt: 'Research the topic.' },
    { id: 'post', prompt: 'Post the approved Instagram caption to Instagram.' },
  ]);
  const origId = `${wf}-run`;
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${origId}.json`),
    JSON.stringify({ id: origId, workflow: wf, inputs: {}, status: 'completed', originSessionId: 'sess-post' }), 'utf-8');
  const fix = recordProposedFix(wf, origId, editStepDiagnosis('research'));

  const steps = [
    { id: 'research', prompt: 'Research the topic.' },
    { id: 'post', prompt: 'Post the approved Instagram caption to Instagram.' },
  ] as never;
  assert.equal(workflowRunnerInternalsForTest.hasUngatedIrreversibleAction(steps), true);

  const out = await workflowRunnerInternalsForTest.tryAutoHealAndRequeue({
    run: { id: origId, workflow: wf, originSessionId: 'sess-post', selfHealAttempt: 0 },
    workflowSlug: wf,
    steps,
    diagnosis: editStepDiagnosis('research') as never,
    proposedFix: fix,
    completedStepIds: new Set(['research']),
  });

  assert.equal(out, null, 'ungated future post escalates instead of auto-requeueing');
  assert.equal(freshRunsFor(wf, origId).length, 0, 'no fresh run queued');
});

test('self-heal: an approval-gated future post/send step may auto-heal because execution will park', () => {
  assert.equal(
    workflowRunnerInternalsForTest.hasUngatedIrreversibleAction([
      { id: 'research', prompt: 'Research the topic.' },
      { id: 'post', prompt: 'Post the approved Instagram caption to Instagram.', requiresApproval: true },
    ] as never),
    false,
  );
  assert.equal(
    workflowRunnerInternalsForTest.hasUngatedIrreversibleAction([
      { id: 'post', prompt: 'Prepare a caption for review.', sideEffect: 'send', requiresApproval: true },
    ] as never),
    false,
  );
});

// ── G8: transient classifier covers "fetch failed" + err.cause (no-fail retry) ──

test('G8: a bare "fetch failed" (undici) is now classified transient → retryable', () => {
  assert.equal(isTransientStepError(new Error('fetch failed')), true);
  assert.equal(isTransientStepError(new Error('workflow step "x" failed via harness: fetch failed')), true);
});

test('G8: a transient cause one level down is detected even when the top message is generic', () => {
  const e = new Error('request to https://api.example.com failed');
  (e as { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  assert.equal(isTransientStepError(e), true);
});

test('G8: deterministic failures are NOT retried (real bugs fail fast, no loop)', () => {
  assert.equal(isTransientStepError(new Error('missing required input "url"')), false);
  assert.equal(isTransientStepError(new Error('TypeError: x is not a function')), false);
  assert.equal(isTransientStepError(new Error('failed its contract')), false);
  // a self-referential cause must not loop forever (bounded recursion)
  const loop = new Error('weird');
  (loop as { cause?: unknown }).cause = loop;
  assert.equal(isTransientStepError(loop), false);
});

test('step-boundary brain fallover is eligible for an EXPIRED brain, not just transient/parse (2026-07-20)', () => {
  // The reported bug: a workflow failed because Claude auth expired and did NOT
  // fall over to a connected brain. An expired token is a 401 → not transient →
  // the gate rejected it → the step hard-failed. Auth-expiry must now be eligible.
  assert.equal(isWorkflowStepBrainFalloverEligible(new Error('Claude Code returned an error result: API Error: 401 Unauthorized — OAuth token has expired')), true);
  assert.equal(isWorkflowStepBrainFalloverEligible(Object.assign(new Error('x'), { name: 'ClaudeSdkAuthExpiredError' })), true);
  // Still eligible for the pre-existing classes.
  assert.equal(isWorkflowStepBrainFalloverEligible(new Error('API Error: 529 Overloaded')), true);
  assert.equal(
    isWorkflowStepBrainFalloverEligible(new Error("You're out of extra usage. Add more at claude.ai/settings/usage and keep going.")),
    true,
    'model-scoped capacity switches brains without retrying the exhausted model',
  );
  assert.equal(isWorkflowStepBrainFalloverEligible(new Error("tool call could not be parsed (retry also failed)")), true);
  // A real deterministic error still fails fast (no brain-chain burn).
  assert.equal(isWorkflowStepBrainFalloverEligible(new Error('missing required input "url"')), false);
  assert.equal(isWorkflowStepBrainFalloverEligible(new Error('API Error: 400 Bad Request: invalid schema')), false);
});

// ── G5: scheduled enabled workflow auto-approves its declarative gate ──────────

test('G5: an unattended SCHEDULED run auto-approves the gate (no human at 8am → no deadlock)', async () => {
  const runId = 'g5-scheduled-gate';
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`),
    JSON.stringify({ id: runId, workflow: 'Daily Dash', status: 'running', source: 'schedule' }), 'utf-8');
  const ctx = {
    workflow: { name: 'Daily Dash', enabled: true, steps: [] }, workflowSlug: 'daily-dash',
    runId, inputs: {}, stepOutputs: {}, assistant: {} as never, completedItems: new Map(),
    forEachFailures: [], qualityAdvisories: [],
  } as never;
  const step = { id: 'deploy', prompt: 'deploy', requiresApproval: true, approvalPreview: 'Deploy' } as never;
  // Must NOT throw (no park) and must NOT register a pending human approval.
  await workflowRunnerInternalsForTest.awaitDeclarativeStepApproval(ctx, step);
  const pending = approvalRegistry.listPending({ sessionId: `workflow-gate:${runId}:deploy`, status: 'pending' });
  assert.equal(pending.length, 0, 'auto-approved — no human approval registered for the unattended run');
  rmSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), { force: true });
});

test('G5: a MANUAL run still registers the gate (a person is present to approve)', async () => {
  process.env.WORKFLOW_APPROVAL_PARKING = 'on';
  const runId = 'g5-manual-gate';
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`),
    JSON.stringify({ id: runId, workflow: 'Daily Dash', status: 'running', source: 'manual', originSessionId: 'sess-x' }), 'utf-8');
  const ctx = {
    workflow: { name: 'Daily Dash', enabled: true, steps: [] }, workflowSlug: 'daily-dash2',
    runId, inputs: {}, stepOutputs: {}, assistant: {} as never, completedItems: new Map(),
    forEachFailures: [], qualityAdvisories: [],
  } as never;
  const step = { id: 'deploy', prompt: 'deploy', requiresApproval: true, approvalPreview: 'Deploy' } as never;
  let threw: Error | null = null;
  try { await workflowRunnerInternalsForTest.awaitDeclarativeStepApproval(ctx, step); } catch (e) { threw = e as Error; }
  assert.ok(threw, 'manual run parks — registers the gate + throws to release the slot');
  const pending = approvalRegistry.listPending({ sessionId: `workflow-gate:${runId}:deploy`, status: 'pending' });
  assert.equal(pending.length, 1, 'manual run registers a human approval (unchanged)');
  rmSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), { force: true });
  delete process.env.WORKFLOW_APPROVAL_PARKING;
});

// ---------------------------------------------------------------------------
// Part B — creation-test verdict (did a read-only step actually return data?)
// ---------------------------------------------------------------------------

test('creationTestVerdict: real data → ok', () => {
  assert.equal(creationTestVerdict('scrape', { records: [{ id: 1 }] }).status, 'ok');
  assert.equal(creationTestVerdict('scrape', 'some real scraped text').status, 'ok');
  assert.equal(creationTestVerdict('scrape', [{ a: 1 }]).status, 'ok');
});

test('creationTestVerdict: empty results → empty (the acme failure — caught at creation)', () => {
  assert.equal(creationTestVerdict('scrape', null).status, 'empty');
  assert.equal(creationTestVerdict('scrape', '').status, 'empty');
  assert.equal(creationTestVerdict('scrape', '   ').status, 'empty');
  assert.equal(creationTestVerdict('scrape', []).status, 'empty');
  assert.equal(creationTestVerdict('scrape', {}).status, 'empty');
});

test('creationTestVerdict: a blocked/self-reported failure → failed (with reason)', () => {
  const blocked = creationTestVerdict('scrape', { blocked: true, reason: 'Apify actor not bound' });
  assert.equal(blocked.status, 'failed');
  assert.match(blocked.detail ?? '', /Apify/);
});

test('creationTestVerdict: reuses the canonical detector — prose "blocked …" string + ok:false → failed', () => {
  // The Part A directive ("block with a reason if it can't return data") may
  // surface as a string OR an object; both must be caught, same as a real run.
  assert.equal(creationTestVerdict('scrape', 'blocked: the Apify actor returned no posts').status, 'failed');
  assert.equal(creationTestVerdict('scrape', { ok: false, note: 'no data' }).status, 'failed');
  // An empty object is "no data", not a healthy result.
  assert.equal(creationTestVerdict('scrape', {}).status, 'empty');
});

test('creationTestVerdict: NESTED failure envelope → failed (the live-smoke false-pass)', () => {
  // Exact shape the smoke caught: the step wrapped an error one level deep to
  // satisfy a contract key. Top-level looks fine; the failure is buried.
  const out = { records: { ok: false, error: 'Unable to retrieve tool with slug NONEXISTENT_SMOKE_TOOLKIT_XYZ' } };
  const v = creationTestVerdict('scrape', out);
  assert.equal(v.status, 'failed');
  assert.match(v.detail ?? '', /ok=false|Unable to retrieve/);
});

test('creationTestVerdict: empty dominant list (wrapped) → empty', () => {
  assert.equal(creationTestVerdict('scrape', { records: [] }).status, 'empty');
  assert.equal(creationTestVerdict('scrape', { data: { records: [] } }).status, 'empty');
  // A NON-empty wrapped list is real data → ok.
  assert.equal(creationTestVerdict('scrape', { data: { records: [{ id: 1 }] } }).status, 'ok');
});

// ---------------------------------------------------------------------------
// Wave 3 P0-3 — crash-resume side-effect guard
// ---------------------------------------------------------------------------

function resumeState(inFlightStepId: string | undefined, completed: string[] = [], failed: string[] = []) {
  return {
    inFlightStepId,
    completedSteps: new Map<string, unknown>(completed.map((id) => [id, 'out'] as [string, unknown])),
    failedSteps: new Set<string>(failed),
  };
}
function wfWith(steps: unknown[]): Parameters<typeof shouldHaltResumeForSideEffect>[0] {
  return { name: 'rt', description: '', enabled: true, trigger: { manual: true }, steps } as never;
}

test('stepSideEffectClass: declared field wins, else heuristic', () => {
  assert.equal(stepSideEffectClass({ id: 'a', prompt: 'anything', sideEffect: 'send' }), 'send');
  assert.equal(stepSideEffectClass({ id: 'a', prompt: 'Send the outreach emails to the list.' }), 'send');
  assert.equal(stepSideEffectClass({ id: 'a', prompt: 'Read the leads from the sheet.' }), 'read');
});

test('host-lane resume proof: a prose step whose ledger shows no mutation re-runs; mutating, uncertain or open ledgers keep the halt; exact steps are not the ledger\'s business', () => {
  const evidence = (over: Record<string, number>) => ({
    sessions: 1, openLogicalCalls: 0, settledCalls: 3, mutatingSettlements: 0, uncertainSettlements: 0, physicalCrossings: 3, unsettledDispatches: 0, ...over,
  });
  const asked: string[] = [];
  const reader = (sessionId: string) => {
    asked.push(sessionId);
    if (sessionId.endsWith(':reads')) return evidence({});
    if (sessionId.endsWith(':save')) return evidence({ mutatingSettlements: 1 });
    if (sessionId.endsWith(':send')) return evidence({ uncertainSettlements: 1 });
    if (sessionId.endsWith(':open')) return evidence({ openLogicalCalls: 1 });
    throw new Error('ledger unavailable');
  };
  const proof = hostStepMutationProof({
    runId: 'r1',
    steps: [
      { id: 'reads', prompt: 'Read the sheet and post a digest.', sideEffect: 'write' },
      { id: 'save', prompt: 'Write rows.', sideEffect: 'write' },
      { id: 'send', prompt: 'Send.', sideEffect: 'send' },
      { id: 'open', prompt: 'Write.', sideEffect: 'write' },
      { id: 'exact', prompt: '', call: { tool: 'X', args: {} }, sideEffect: 'write' },
      { id: 'broken', prompt: 'Write.', sideEffect: 'write' },
    ] as never,
    inFlightStepIds: new Set(['reads', 'save', 'send', 'open', 'exact', 'broken']),
    alreadyProven: new Set(),
  }, reader as never);
  assert.deepEqual([...proof.proven], ['reads'], 'two settled reads and nothing else: safe to re-run');
  assert.deepEqual([...proof.uncertain.keys()].sort(), ['open', 'save', 'send']);
  assert.ok(!asked.some((id) => id.endsWith(':exact')), 'an exact call step keeps its own receipt ledger');
  assert.ok(asked.every((id) => id.startsWith('workflow:r1:')), 'the ledger is asked under the step\'s host session id');
});

test('P0-3 halts crash-resume of an autonomous write/send step', () => {
  const wf = wfWith([
    { id: 'pull', prompt: 'Read leads.', sideEffect: 'read' },
    { id: 'save', prompt: 'Write to the sheet.', sideEffect: 'write', dependsOn: ['pull'] },
    { id: 'send', prompt: 'Email the batch.', sideEffect: 'send', dependsOn: ['save'] },
  ]);
  assert.deepEqual(shouldHaltResumeForSideEffect(wf, resumeState('save', ['pull'])), { stepId: 'save', cls: 'write', declared: true });
  assert.deepEqual(shouldHaltResumeForSideEffect(wf, resumeState('send', ['pull', 'save'])), { stepId: 'send', cls: 'send', declared: true });
});

test('P0-3 harness telemetry absence cannot authorize replay of an interrupted write', () => {
  const wf = wfWith([
    { id: 'pull', prompt: 'Read leads.', sideEffect: 'read' },
    { id: 'save', prompt: 'Write to the sheet.', sideEffect: 'write', dependsOn: ['pull'] },
  ]);
  assert.deepEqual(
    shouldHaltResumeForSideEffect(
      wf,
      resumeState('save', ['pull']),
      undefined,
      { harnessEnabled: true, claimedExternalWrite: false },
    ),
    { stepId: 'save', cls: 'write', declared: true },
  );
});

test('P0-3 ledger-aware resume: claimed external_write still halts', () => {
  const wf = wfWith([
    { id: 'save', prompt: 'Write to the sheet.', sideEffect: 'write' },
  ]);
  assert.deepEqual(
    shouldHaltResumeForSideEffect(
      wf,
      resumeState('save'),
      undefined,
      { harnessEnabled: true, claimedExternalWrite: true },
    ),
    { stepId: 'save', cls: 'write', declared: true },
  );
});

test('P0-3 structured mutation resume defers to the exact-call receipt ledger', () => {
  const wf = wfWith([
    { id: 'send', prompt: '', call: { tool: 'GMAIL_SEND_EMAIL', args: { to: 'a@beta-co.example' } }, sideEffect: 'send' },
  ]);
  assert.equal(
    shouldHaltResumeForSideEffect(
      wf,
      resumeState('send'),
      undefined,
      { mutationReceiptProtected: true },
    ),
    null,
    'the exact-call ledger replays committed results and refuses ambiguous starts itself',
  );
});

test('P0-3 ledger-aware resume stays conservative for legacy/non-harness steps', () => {
  const wf = wfWith([
    { id: 'save', prompt: 'Write to the sheet.', sideEffect: 'write' },
  ]);
  assert.deepEqual(
    shouldHaltResumeForSideEffect(
      wf,
      resumeState('save'),
      undefined,
      { harnessEnabled: false, claimedExternalWrite: false },
    ),
    { stepId: 'save', cls: 'write', declared: true },
  );
});

test('P0-3 halt reports declared=false when the class was only inferred from prose', () => {
  // The acme-facebook-trends failure mode: no declared sideEffect, prose
  // heuristic guesses write → halt. The message uses declared=false to teach
  // the one-line `sideEffect: read` fix.
  const wf = wfWith([
    { id: 'scrape', prompt: 'Normalize the scraped page data and write rows into the result.' },
  ]);
  const halt = shouldHaltResumeForSideEffect(wf, resumeState('scrape'));
  assert.ok(halt, 'inferred write step should halt');
  assert.equal(halt?.declared, false);
});

test('P0-3 does not halt a read/completed step, but a crashed targeted run still parks', () => {
  const wf = wfWith([
    { id: 'pull', prompt: 'Read leads.', sideEffect: 'read' },
    { id: 'send', prompt: 'Email the batch.', sideEffect: 'send', dependsOn: ['pull'] },
  ]);
  // read step in flight → no halt
  assert.equal(shouldHaltResumeForSideEffect(wf, resumeState('pull')), null);
  // in-flight step already completed → no halt
  assert.equal(shouldHaltResumeForSideEffect(wf, resumeState('send', ['pull', 'send'])), null);
  // A newly requested single-step run has no in-flight event, but a restart of
  // that same targeted run does. It must park rather than dispatch twice.
  assert.deepEqual(
    shouldHaltResumeForSideEffect(wf, resumeState('send', ['pull']), 'send'),
    { stepId: 'send', cls: 'send', declared: true },
  );
  // nothing in flight → no halt
  assert.equal(shouldHaltResumeForSideEffect(wf, resumeState(undefined)), null);
});

test('P0-3 a crash-resumed run with a lost lifecycle event parks before an uncompleted plain mutation', () => {
  const wf = wfWith([
    { id: 'pull', prompt: 'Read leads.', sideEffect: 'read' },
    { id: 'send', prompt: 'Email the batch.', sideEffect: 'send', dependsOn: ['pull'] },
  ]);
  assert.deepEqual(
    shouldHaltResumeForSideEffect(
      wf,
      resumeState(undefined, ['pull']),
      undefined,
      { resumedRun: true, durableMutationProtocolStepIds: new Set() },
    ),
    { stepId: 'send', cls: 'send', declared: true },
  );
});

test('P0-3 a lost-event exact pre-dispatch proof exempts only its one ready-frontier step', () => {
  const sendOnly = wfWith([
    { id: 'send', prompt: '', sideEffect: 'send', call: { tool: 'SLACK_SEND_MESSAGE', args: { channel: 'fixed', markdown_text: 'fixed' } } },
  ]);
  const resumed = resumeState(undefined);
  assert.equal(
    shouldHaltResumeForSideEffect(sendOnly, resumed, undefined, {
      resumedRun: true,
      durableMutationProtocolStepIds: new Set(),
      provenNoDispatchStepIds: new Set(['send']),
    }),
    null,
    'the authenticated same-run pre-dispatch proof survives a missing step_started event',
  );
  for (const provenNoDispatchStepIds of [new Set<string>(), new Set(['different-step'])]) {
    assert.deepEqual(
      shouldHaltResumeForSideEffect(sendOnly, resumed, undefined, {
        resumedRun: true,
        durableMutationProtocolStepIds: new Set(),
        provenNoDispatchStepIds,
      }),
      { stepId: 'send', cls: 'send', declared: true },
      'absent or wrong-step proof remains fail-closed',
    );
  }

  const siblingMutation = wfWith([
    ...sendOnly.steps,
    { id: 'write', prompt: 'Update the CRM.', sideEffect: 'write' },
  ]);
  assert.deepEqual(
    shouldHaltResumeForSideEffect(siblingMutation, resumed, undefined, {
      resumedRun: true,
      durableMutationProtocolStepIds: new Set(),
      provenNoDispatchStepIds: new Set(['send']),
    }),
    { stepId: 'write', cls: 'write', declared: true },
    'one step proof cannot hide a concurrent unproven mutation',
  );
});

test('P0-3 a lost-event crash resume does NOT park a downstream mutation execution never reached', () => {
  // Crash during the FIRST read step: the send step deep in the chain provably
  // never started (its dependency never completed), so a lost step_started must
  // not park it (2026-07-17 final-wave review #3 — the over-halt regression).
  const wf = wfWith([
    { id: 'scrape', prompt: 'Scrape the listing.', sideEffect: 'read' },
    { id: 'summarize', prompt: 'Summarize the rows.', sideEffect: 'read', dependsOn: ['scrape'] },
    { id: 'send', prompt: 'Email the summary.', sideEffect: 'send', dependsOn: ['summarize'] },
  ]);
  assert.equal(
    shouldHaltResumeForSideEffect(
      wf,
      resumeState(undefined, []),
      undefined,
      { resumedRun: true, durableMutationProtocolStepIds: new Set() },
    ),
    null,
    'send is not in the ready frontier while scrape is still the running step',
  );
  // Once its prerequisites completed, the same send IS in the frontier and a
  // lost lifecycle event must park it conservatively.
  assert.deepEqual(
    shouldHaltResumeForSideEffect(
      wf,
      resumeState(undefined, ['scrape', 'summarize']),
      undefined,
      { resumedRun: true, durableMutationProtocolStepIds: new Set() },
    ),
    { stepId: 'send', cls: 'send', declared: true },
  );
});

test('P0-3 a dependsOn-less concurrent workflow still halts on any incomplete mutation after a lost event', () => {
  // With no declared dependencies every step runs in one batch, so all are in
  // the frontier — the guard must stay conservative and park the mutation.
  const wf = wfWith([
    { id: 'read1', prompt: 'Read A.', sideEffect: 'read' },
    { id: 'write1', prompt: 'Write B.', sideEffect: 'write' },
  ]);
  assert.deepEqual(
    shouldHaltResumeForSideEffect(
      wf,
      resumeState(undefined, []),
      undefined,
      { resumedRun: true, durableMutationProtocolStepIds: new Set() },
    ),
    { stepId: 'write1', cls: 'write', declared: true },
  );
});

test('P0-3 mixed parallel read+send daemon-kill resume halts the send even when the read started last', () => {
  resetEventLog();
  const slug = 'p03-parallel-kill';
  const runId = 'parallel-r1';
  const wf = wfWith([
    { id: 'send', prompt: 'Email the approved update.', sideEffect: 'send' },
    { id: 'lookup', prompt: 'Read the account status.', sideEffect: 'read' },
  ]);

  // Both branches were launched by the same graph batch. The provider accepted
  // the send, the read emitted the last lifecycle event, then the daemon died
  // before either completion event could land.
  appendWorkflowEvent(slug, runId, { kind: 'run_started' });
  appendWorkflowEvent(slug, runId, { kind: 'step_started', stepId: 'send' });
  appendWorkflowEvent(slug, runId, { kind: 'step_started', stepId: 'lookup' });

  const resumed = computeResumeState(slug, runId);
  assert.equal(resumed.inFlightStepId, 'lookup', 'legacy singular cursor reproduces the unsafe last-started read');
  assert.deepEqual(
    shouldHaltResumeForSideEffect(wf, resumed),
    { stepId: 'send', cls: 'send', declared: true },
    'restart must park the incomplete send rather than dispatching it twice',
  );
});

test('P0-3 one step-scoped recovery proof cannot hide a concurrent unreceipted mutation', () => {
  const wf = wfWith([
    { id: 'receipted_send', prompt: '', sideEffect: 'send', call: { tool: 'GMAIL_SEND_EMAIL', args: { to: 'a@beta-co.example' } } },
    { id: 'plain_write', prompt: 'Write the status to the CRM.', sideEffect: 'write' },
  ]);
  const resumed = {
    ...resumeState('receipted_send'),
    inFlightStepIds: new Set(['receipted_send', 'plain_write']),
  };

  assert.deepEqual(
    shouldHaltResumeForSideEffect(
      wf,
      resumed,
      undefined,
      {
        durableMutationProtocolStepIds: new Set(['receipted_send']),
        provenNoDispatchStepIds: new Set(['receipted_send']),
      },
    ),
    { stepId: 'plain_write', cls: 'write', declared: true },
    'only the exact proven/receipted step is exempt; its unsafe sibling still parks',
  );
});

test('P0-3 a structured direct mutation may start after restart only under the durable receipt protocol', () => {
  const wf = wfWith([
    { id: 'send', prompt: '', sideEffect: 'send', call: { tool: 'GMAIL_SEND_EMAIL', args: { to: 'a@beta-co.example' } } },
  ]);
  assert.equal(
    shouldHaltResumeForSideEffect(
      wf,
      resumeState(undefined),
      undefined,
      { resumedRun: true, durableMutationProtocolStepIds: new Set(['send']) },
    ),
    null,
  );
});

test('Lane B: a legacy crashed forEach SEND parks when the interrupted item has no exact receipt proof', () => {
  const wf = wfWith([
    { id: 'pull', prompt: 'Read leads.', sideEffect: 'read' },
    { id: 'blast', prompt: 'Email each lead.', sideEffect: 'send', forEach: 'pull', dependsOn: ['pull'] },
  ]);
  assert.deepEqual(
    shouldHaltResumeForSideEffect(wf, resumeState('blast', ['pull'])),
    { stepId: 'blast', cls: 'send', declared: true },
  );
});

test('Lane B (bug #8 / audit #2.2): stepSendAlreadyFired — a PLAIN step whose send fired is detected, so a transient error does NOT re-run it (no double-send)', () => {
  resetEventLog();
  const runId = 'r-step-dup';
  const stepId = 'notify_owner';
  const sid = `workflow:${runId}:${stepId}`;
  // Nothing fired yet → a transient error IS retryable.
  assert.equal(stepSendAlreadyFired(runId, stepId), false, 'no send yet → not claimed');
  // The send fires: an external_write is recorded under the step's deterministic
  // session id. A later transient model error (e.g. 529 before step_completed)
  // must NOT re-run the step — the guard catches the prior send.
  HarnessSession.create({ id: sid, kind: 'workflow', channel: 'workflow', title: runId, metadata: { source: 'workflow' } });
  appendEvent({ sessionId: sid, turn: 0, role: 'tool', type: 'external_write', data: { shapeKey: 'GMAIL_SEND', targets: ['x@personal.example'] } });
  assert.equal(stepSendAlreadyFired(runId, stepId), true, 'a fired send suppresses the transient retry (no double-send)');
  assert.equal(stepExternalWriteAlreadyClaimed(runId, stepId), true, 'generic write ledger helper sees the same claim');
  // A failure compensation nets it back out → the send did NOT claim → retry ok.
  appendEvent({ sessionId: sid, turn: 0, role: 'tool', type: 'external_write_failed', data: { shapeKey: 'GMAIL_SEND', targets: ['x@personal.example'] } });
  assert.equal(stepSendAlreadyFired(runId, stepId), false, 'a netted failure means the send did not claim → retry allowed');
});

test('Lane B (bug #8): sendAlreadyClaimed — more external_writes than failures ⇒ a send fired', () => {
  assert.equal(sendAlreadyClaimed(1, 0), true, 'one send, no failure → claimed');
  assert.equal(sendAlreadyClaimed(1, 1), false, 'one send fully netted by a failure → not claimed');
  assert.equal(sendAlreadyClaimed(0, 0), false, 'nothing fired → not claimed');
  assert.equal(sendAlreadyClaimed(2, 1), true, '2 writes, 1 failed → 1 net send claimed');
});

test('plain-step write recovery nets failures by exact call, never by aggregate count', () => {
  resetEventLog();
  const runId = 'r-step-exact-settlement';
  const stepId = 'notify_two';
  const sid = `workflow:${runId}:${stepId}`;
  HarnessSession.create({ id: sid, kind: 'workflow', channel: 'workflow', title: runId, metadata: { source: 'workflow' } });
  appendEvent({
    sessionId: sid,
    turn: 0,
    role: 'tool',
    type: 'external_write',
    data: { callId: 'call-a', shapeKey: 'GMAIL_SEND', targets: ['a@example.com'], preDispatch: true },
  });
  appendEvent({
    sessionId: sid,
    turn: 0,
    role: 'tool',
    type: 'external_write',
    data: { callId: 'call-b', shapeKey: 'GMAIL_SEND', targets: ['b@example.com'], preDispatch: true },
  });
  appendEvent({
    sessionId: sid,
    turn: 0,
    role: 'tool',
    type: 'external_write_failed',
    data: { callId: 'call-a', shapeKey: 'GMAIL_SEND', targets: ['a@example.com'] },
  });
  assert.equal(
    stepExternalWriteAlreadyClaimed(runId, stepId),
    true,
    'failure for call-a cannot release call-b',
  );
  appendEvent({
    sessionId: sid,
    turn: 0,
    role: 'tool',
    type: 'external_write_failed',
    data: { callId: 'call-b', shapeKey: 'GMAIL_SEND', targets: ['b@example.com'] },
  });
  assert.equal(stepExternalWriteAlreadyClaimed(runId, stepId), false);
});

test('P0-3 approval-gated step is exempt (parking emits step_started before the gate)', () => {
  const wf = wfWith([
    { id: 'send', prompt: 'Email the batch.', sideEffect: 'send', requiresApproval: true },
  ]);
  assert.equal(shouldHaltResumeForSideEffect(wf, resumeState('send')), null);
});

test('P0-3 runtime-request_approval park is exempt (in-flight step has a step_failed event)', () => {
  // The regression case: a PLAIN send step (requiresApproval=false) that called
  // request_approval mid-run parks via ParkRunSignal → caught + logged as
  // step_failed → reaper re-admits. On resume it must RESUME (not halt), or the
  // now-default-ON parking flow would break for every send step.
  const wf = wfWith([
    { id: 'send', prompt: 'Email the batch.', sideEffect: 'send' },
  ]);
  // Without the park marker it WOULD halt (plain crashed send) …
  assert.deepEqual(shouldHaltResumeForSideEffect(wf, resumeState('send')), { stepId: 'send', cls: 'send', declared: true });
  // … with a logged step_failed (the park signature) it is exempt.
  assert.equal(shouldHaltResumeForSideEffect(wf, resumeState('send', [], ['send'])), null);
});

test('P0-3 mutating forEach parks; completed-item tracking alone cannot prove the interrupted item did not commit', () => {
  const wf = wfWith([
    { id: 'blast', prompt: 'Email each prospect.', sideEffect: 'send', forEach: 'pull' },
  ]);
  assert.deepEqual(
    shouldHaltResumeForSideEffect(wf, resumeState('blast')),
    { stepId: 'blast', cls: 'send', declared: true },
  );
});

test('P0-3 read-only forEach remains restart-safe', () => {
  const wf = wfWith([
    { id: 'lookup', prompt: 'Fetch each prospect profile.', sideEffect: 'read', forEach: 'pull' },
  ]);
  assert.equal(shouldHaltResumeForSideEffect(wf, resumeState('lookup')), null);
});

test('P0-3 end-to-end: park → approve → crash mid-send HALTS (closes the double-send hole)', () => {
  // Build the real event sequence through the durability layer and feed the
  // resulting ResumeState to the guard — the post-approval re-start must clear
  // the park marker so a mid-send crash is caught, not blind-re-run.
  const slug = 'p03-e2e';
  const wf = wfWith([{ id: 'send', prompt: 'Email the batch.', sideEffect: 'send' }]);

  // 1. parked on a runtime approval → exempt (resumes from the gate).
  appendWorkflowEvent(slug, 'r1', { kind: 'step_started', stepId: 'send' });
  appendWorkflowEvent(slug, 'r1', { kind: 'step_failed', stepId: 'send', error: 'Workflow run parked on approval.' });
  assert.equal(shouldHaltResumeForSideEffect(wf, computeResumeState(slug, 'r1')), null, 'still-parked send resumes');

  // 2. approved → re-started → crashed mid-send → HALT (no double send).
  appendWorkflowEvent(slug, 'r1', { kind: 'step_started', stepId: 'send' });
  assert.deepEqual(
    shouldHaltResumeForSideEffect(wf, computeResumeState(slug, 'r1')),
    { stepId: 'send', cls: 'send', declared: true },
    'post-approval mid-send crash halts',
  );
});

test('isPhantomStepCompletion: a send/write step that called no real tool is flagged (phantom completion #2)', () => {
  // phantom: send step, zero tools → it never sent
  assert.equal(isPhantomStepCompletion({ id: 'notify', sideEffect: 'send', prompt: 'call notify_user' }, [], {}), true);
  // phantom: only StructuredOutput (schema emission, not an action)
  assert.equal(isPhantomStepCompletion({ id: 'notify', sideEffect: 'send' }, ['StructuredOutput'], {}), true);
  // phantom: write step, zero tools
  assert.equal(isPhantomStepCompletion({ id: 'w', sideEffect: 'write' }, [], 'done'), true);

  // NOT phantom: it actually called the send tool
  assert.equal(isPhantomStepCompletion({ id: 'notify', sideEffect: 'send' }, ['mcp__clementine-local__notify_user'], {}), false);
  // NOT phantom: read step (no action expected)
  assert.equal(isPhantomStepCompletion({ id: 'r', sideEffect: 'read' }, [], {}), false);
  // NOT phantom: deterministic runner doesn't call brain tools
  assert.equal(isPhantomStepCompletion({ id: 'd', sideEffect: 'send', deterministic: { runner: 'x.mjs' } }, [], {}), false);
  // NOT phantom: already-blocked output is honest, leave it
  assert.equal(isPhantomStepCompletion({ id: 'b', sideEffect: 'send' }, [], { blocked: true, reason: 'no data' }), false);
});

test('isPhantomStepCompletion: kill-switch off → never flags', () => {
  process.env.CLEMMY_WORKFLOW_PHANTOM_GUARD = 'off';
  assert.equal(isPhantomStepCompletion({ id: 'notify', sideEffect: 'send' }, [], {}), false);
  delete process.env.CLEMMY_WORKFLOW_PHANTOM_GUARD;
});

test('isPhantomStepCompletion: workflow_step_result is result emission, not action (orchestrator-lane parity)', () => {
  // phantom: the step emitted its structured result but never called an acting tool
  assert.equal(isPhantomStepCompletion({ id: 'notify', sideEffect: 'send' }, ['workflow_step_result'], { ok: true }), true);
  assert.equal(isPhantomStepCompletion({ id: 'notify', sideEffect: 'send' }, ['StructuredOutput', 'workflow_step_result'], {}), true);
  // NOT phantom: emitted the result AND actually acted
  assert.equal(isPhantomStepCompletion({ id: 'notify', sideEffect: 'send' }, ['workflow_step_result', 'mcp__clementine-local__notify_user'], {}), false);
});

test('required read failures cannot be laundered into a downstream-ready dashboard', () => {
  resetEventLog();
  const sessionId = 'workflow:source-failed-dashboard:pull';
  HarnessSession.create({
    id: sessionId,
    kind: 'workflow',
    channel: 'workflow',
    title: 'Required source failure',
    metadata: { source: 'workflow' },
  });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Read the source and produce the dashboard.' },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: source.seq,
      tool: 'run_shell_command',
      callId: 'call-source-failed',
      arguments: JSON.stringify({ command: 'provider-cli query --json' }),
      accounting: 'top_level',
    },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: {
      sourceUserSeq: source.seq,
      tool: 'run_shell_command',
      callId: 'call-source-failed',
      ok: false,
      error: 'exit_code: 1 — required provider account is signed out',
    },
  });

  const guarded = settlementGuardedStepOutput({
    step: { id: 'pull', prompt: 'Read the required provider source.', sideEffect: 'read' },
    sessionId,
    sourceUserSeq: source.seq,
    toolUses: ['run_shell_command', 'workflow_step_result'],
    output: {
      summary: 'Every metric is unavailable.',
      totals: { calls: 0, emails: 0, total: 0 },
    },
  });

  assert.equal((guarded as { blocked?: unknown }).blocked, true);
  assert.match(
    String((guarded as { reason?: unknown }).reason),
    /no completed business settlement|not complete yet/i,
  );
});

test('a recovered scrape whose output satisfies the declared contract is complete', () => {
  resetEventLog();
  const sessionId = 'workflow:facebook-trends:scrape_and_analyze';
  HarnessSession.create({
    id: sessionId,
    kind: 'workflow',
    channel: 'workflow',
    title: 'Recovered scrape',
    metadata: { source: 'workflow' },
  });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Scrape the official page and analyze recent posts.' },
  });
  workflowSemanticDisposition.recordSemanticParticipation(sessionId, source.seq, 'participated');
  assert.ok(workflowSettlementShadow.recordTurnGraphShadow({
    identity: { sessionId, turn: source.turn, sourceUserSeq: source.seq },
    surface: 'workflow',
  }));
  const acceptedTaskId = workflowSettlementIdentities.acceptedTaskIdFor(sessionId, source.seq);

  const settleRead = (callId: string, tool: string, ok: boolean): void => {
    const args = { actor: callId };
    const logicalToolCallId = `logical:${callId}`;
    const begun = workflowSettlementDispatch.beginPhysicalDispatch({
      identity: {
        sessionId,
        sourceUserSeq: source.seq,
        turn: source.turn,
        acceptedTaskId,
        logicalToolCallId,
        physicalDispatchId: `dispatch:${callId}`,
        ordinal: 0,
      },
      tool,
      args,
    });
    assert.equal(begun.status, 'inserted', JSON.stringify(begun));
    if (begun.status !== 'inserted') throw new Error('fixture dispatch was not admitted');
    assert.equal(workflowSettlementDispatch.settlePhysicalDispatch({
      identity: begun.identity,
      tool,
      outcome: 'returned',
    }).status, 'inserted');
    const settled = workflowSettlements.commitLogicalCallSettlement({
      identity: {
        sessionId,
        sourceUserSeq: source.seq,
        turn: source.turn,
        acceptedTaskId,
        logicalToolCallId,
      },
      contract: { toolName: tool, args },
      execution: { kind: 'provider_execution' },
      ...(ok ? { result: { payload: { successful: true, data: { items: [{ id: 'p1' }] } } } } : {}),
      outcome: ok
        ? workflowSettlementOutcomes.classifyAttemptOutcome({ envelopeSuccessful: true })
        : workflowSettlementOutcomes.classifyAttemptOutcome({ executionFailed: true }),
      recovery: { businessCall: true, mutating: false },
      observer: { lane: 'agents_runner', turn: source.turn },
    });
    assert.equal(settled.status, 'committed');
  };
  settleRead('sync-timeout', 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', false);
  settleRead('dataset-recovery', 'APIFY_GET_RUN_DATASET_ITEMS', true);

  const scrapeContract = {
    required_keys: [
      'scraper_used',
      'actor_id',
      'source_page_url',
      'posts_reviewed_count',
      'key_trends',
      'limitations',
      'sources',
      'key_findings',
      'source_errors',
    ],
  };
  const output = {
    scraper_used: 'apify',
    actor_id: 'zhOq6vlY7WaeCwX88',
    source_page_url: 'https://www.facebook.com/scorpion.co',
    posts_reviewed_count: 25,
    key_trends: ['AI-search partner'],
    limitations: ['sync actor timed out; recovered via dataset items'],
    sources: ['https://www.facebook.com/scorpion.co'],
    key_findings: ['AI-search partner announced 2026-07-23'],
    source_errors: ['APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS timed out'],
  };
  const guarded = settlementGuardedStepOutput({
    step: {
      id: 'scrape_and_analyze',
      prompt: 'Scrape recent posts and return the analysis contract.',
      sideEffect: 'read',
      output: scrapeContract,
    },
    sessionId,
    sourceUserSeq: source.seq,
    toolUses: [
      'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
      'APIFY_GET_RUN_DATASET_ITEMS',
      'StructuredOutput',
    ],
    output,
  });

  assert.equal((guarded as { blocked?: unknown }).blocked, undefined);
  assert.deepEqual(guarded, output);
});

test('one successful workflow read cannot launder a failed sibling required read', () => {
  resetEventLog();
  const sessionId = 'workflow:mixed-source-dashboard:pull';
  HarnessSession.create({
    id: sessionId,
    kind: 'workflow',
    channel: 'workflow',
    title: 'Mixed required sources',
    metadata: { source: 'workflow' },
  });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Run every required source query and produce the dashboard.' },
  });

  const recordRead = (callId: string, ok: boolean, output: string): void => {
    appendEvent({
      sessionId,
      turn: 1,
      role: 'Clem',
      type: 'tool_called',
      data: {
        sourceUserSeq: source.seq,
        tool: 'run_shell_command',
        callId,
        arguments: JSON.stringify({ command: `provider-cli query ${callId} --json` }),
        accounting: 'top_level',
      },
    });
    appendEvent({
      sessionId,
      turn: 1,
      role: 'tool',
      type: 'tool_returned',
      data: {
        sourceUserSeq: source.seq,
        tool: 'run_shell_command',
        callId,
        ok,
        ...(ok ? { output } : { error: output }),
      },
    });
  };
  recordRead('call-required-success', true, '{"records":[{"id":"001"}]}');
  recordRead('call-required-failure', false, 'exit_code: 1 — one required query failed');

  const guarded = settlementGuardedStepOutput({
    step: { id: 'pull', prompt: 'Run both required provider reads.', sideEffect: 'read' },
    sessionId,
    sourceUserSeq: source.seq,
    toolUses: ['run_shell_command', 'run_shell_command', 'workflow_step_result'],
    output: {
      summary: 'The available metric looks healthy; the missing metric is unavailable.',
      sourceEvidence: { queriesSucceeded: ['required-success', 'required-failure'] },
    },
  });

  assert.equal((guarded as { blocked?: unknown }).blocked, true);
  assert.match(
    String((guarded as { reason?: unknown }).reason),
    /unrecovered|not complete yet|failed/i,
  );
});

test('a local-write source step cannot fabricate complete evidence over a failed read or dispatch its dependent send', () => {
  resetEventLog();
  const sessionId = 'workflow:mixed-source-local-baseline:pull';
  HarnessSession.create({
    id: sessionId,
    kind: 'workflow',
    channel: 'workflow',
    title: 'Required source reads plus local baseline',
    metadata: { source: 'workflow' },
  });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Run every required query, save the local baseline, then post the summary.' },
  });
  workflowSemanticDisposition.recordSemanticParticipation(sessionId, source.seq, 'participated');
  assert.ok(workflowSettlementShadow.recordTurnGraphShadow({
    identity: { sessionId, turn: source.turn, sourceUserSeq: source.seq },
    surface: 'workflow',
  }));
  const acceptedTaskId = workflowSettlementIdentities.acceptedTaskIdFor(sessionId, source.seq);

  const settleRead = (callId: string, ok: boolean): void => {
    const args = { query: callId };
    const logicalToolCallId = `logical:${callId}`;
    const begun = workflowSettlementDispatch.beginPhysicalDispatch({
      identity: {
        sessionId,
        sourceUserSeq: source.seq,
        turn: source.turn,
        acceptedTaskId,
        logicalToolCallId,
        physicalDispatchId: `dispatch:${callId}`,
        ordinal: 0,
      },
      tool: 'alpha_records_read',
      args,
    });
    assert.equal(begun.status, 'inserted', JSON.stringify(begun));
    if (begun.status !== 'inserted') throw new Error('fixture dispatch was not admitted');
    assert.equal(workflowSettlementDispatch.settlePhysicalDispatch({
      identity: begun.identity,
      tool: 'alpha_records_read',
      outcome: 'returned',
    }).status, 'inserted');
    const settled = workflowSettlements.commitLogicalCallSettlement({
      identity: {
        sessionId,
        sourceUserSeq: source.seq,
        turn: source.turn,
        acceptedTaskId,
        logicalToolCallId,
      },
      contract: { toolName: 'alpha_records_read', args },
      execution: { kind: 'provider_execution' },
      ...(ok ? { result: { payload: { successful: true, data: { records: [] } } } } : {}),
      outcome: ok
        ? workflowSettlementOutcomes.classifyAttemptOutcome({ envelopeSuccessful: true })
        : workflowSettlementOutcomes.classifyAttemptOutcome({ executionFailed: true }),
      recovery: { businessCall: true, mutating: false },
      observer: { lane: 'agents_runner', turn: source.turn },
    });
    assert.equal(settled.status, 'committed');
  };
  settleRead('required-read-success', true);
  settleRead('required-read-failure', false);

  const sourceStep = {
    id: 'pull_activity',
    prompt: 'Read every required source query and persist the local morning baseline.',
    sideEffect: 'write' as const,
  };
  const guarded = settlementGuardedStepOutput({
    step: sourceStep,
    sessionId,
    sourceUserSeq: source.seq,
    toolUses: ['alpha_records_read', 'alpha_records_read', 'workflow_step_result'],
    output: {
      summary: 'All metrics are ready.',
      sourceEvidence: {
        queriesSucceeded: ['calls', 'pace', 'meetings-set', 'meetings-held', 'closed-won', 'stale-opportunities'],
      },
    },
  });

  assert.equal((guarded as { blocked?: unknown }).blocked, true);
  const skips = planBlockedDependencySkips(
    [
      sourceStep,
      {
        id: 'post_summary',
        prompt: 'Post the summary to the declared destination.',
        dependsOn: ['pull_activity'],
        sideEffect: 'send' as const,
      },
    ],
    { pull_activity: guarded },
  );
  assert.deepEqual(skips.map((skip) => skip.stepId), ['post_summary']);
  assert.match(skips[0]?.output.reason ?? '', /required source query failed|not complete yet|unrecovered/i);
});

test('omitBlocksForAlreadyFiredSends: a successful send is not a failed run', () => {
  resetEventLog();
  const runId = 'run-slack-echo';
  const stepId = 'post_slack';
  const sessionId = `workflow:${runId}:${stepId}`;
  HarnessSession.create({
    id: sessionId,
    kind: 'workflow',
    channel: 'workflow',
    title: 'Posted slack send',
    metadata: { source: 'workflow' },
  });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Post the summary.' },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: {
      sourceUserSeq: source.seq,
      shapeKey: 'SLACK_SEND_MESSAGE',
      action: 'send',
    },
  });
  const blocked = omitBlocksForAlreadyFiredSends(
    [{
      stepId,
      kind: 'blocked',
      reason: 'provider echo was not byte-equal after Slack normalized markdown',
    }],
    [{ id: stepId, prompt: 'Send the summary.', sideEffect: 'send' }],
    runId,
  );
  assert.deepEqual(blocked, []);
});

test('decideBatchSettlement: park OUTRANKS a sibling failure (T1.3 — the approval survives)', () => {
  const stepA = { id: 'a', prompt: 'read stuff' };
  const stepB = { id: 'b', prompt: 'send stuff', sideEffect: 'send' as const };
  const stepC = { id: 'c', prompt: 'also read' };
  const park = new ParkRunSignal([{ stepId: 'b', kind: 'gate' as const, approvalIds: ['apr-1'] }]);
  const decision = decideBatchSettlement(
    [stepA, stepB, stepC],
    [
      { status: 'fulfilled', value: { step: stepA, output: { ok: true } } },
      { status: 'rejected', reason: park },
      { status: 'rejected', reason: new Error('provider blew up') },
    ],
  );
  // park wins over the sibling failure — the run parks instead of dying
  assert.equal(decision.action, 'park');
  assert.deepEqual(decision.parkedSteps, [{ stepId: 'b', kind: 'gate', approvalIds: ['apr-1'] }]);
  // the failure is preserved for the advisory (not swallowed)
  assert.deepEqual(decision.failures, [{ stepId: 'c', message: 'provider blew up' }]);
  // the completed sibling is kept
  assert.deepEqual(decision.completions, [{ stepId: 'a', output: { ok: true } }]);
});

test('decideBatchSettlement: failures with no park → fail; all fulfilled → continue', () => {
  const stepA = { id: 'a', prompt: 'x' };
  const stepB = { id: 'b', prompt: 'y' };
  const failed = decideBatchSettlement(
    [stepA, stepB],
    [
      { status: 'fulfilled', value: { step: stepA, output: 'done' } },
      { status: 'rejected', reason: new Error('boom') },
    ],
  );
  assert.equal(failed.action, 'fail');
  assert.deepEqual(failed.failures, [{ stepId: 'b', message: 'boom' }]);
  assert.deepEqual(failed.completions, [{ stepId: 'a', output: 'done' }]);

  const clean = decideBatchSettlement(
    [stepA],
    [{ status: 'fulfilled', value: { step: stepA, output: 1 } }],
  );
  assert.equal(clean.action, 'continue');
  assert.equal(clean.failures.length, 0);
  assert.equal(clean.parkedSteps.length, 0);
});

test('decideBatchSettlement: a proven capability block preserves completed siblings and outranks failure', () => {
  const stepA = { id: 'a', prompt: 'read stuff' };
  const stepB = { id: 'b', prompt: 'write sheet', sideEffect: 'write' as const };
  const stepC = { id: 'c', prompt: 'also read' };
  const capability = new WorkflowCapabilityBlockedError({
    stepId: 'b',
    tool: 'GOOGLESHEETS_BATCH_UPDATE',
    toolkit: 'googlesheets',
    reason: 'not-connected',
    message: 'Reconnect Google Sheets.',
  });
  const decision = decideBatchSettlement(
    [stepA, stepB, stepC],
    [
      { status: 'fulfilled', value: { step: stepA, output: { rows: 4 } } },
      { status: 'rejected', reason: capability },
      { status: 'rejected', reason: new Error('unrelated read failure') },
    ],
  );

  assert.equal(decision.action, 'capability');
  assert.equal(decision.capabilityBlocks[0], capability);
  assert.deepEqual(decision.completions, [{ stepId: 'a', output: { rows: 4 } }]);
  assert.deepEqual(decision.failures, [{ stepId: 'c', message: 'unrelated read failure' }]);
});

test('tightenWorkflowContractsFromCleanRun applies to current workflow without clobbering newer edits', async () => {
  const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');
  const slug = 'clean-tighten-current';
  const runStartDef = {
    name: 'Clean Tighten Current',
    description: 'Original run-start definition',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'same', prompt: 'Gather current data.' },
      { id: 'changed', prompt: 'Gather old data.' },
    ],
  };
  writeWorkflow(slug, {
    ...runStartDef,
    description: 'User-edited definition while the run was active',
    steps: [
      { id: 'same', prompt: 'Gather current data.' },
      { id: 'changed', prompt: 'User changed this step while run was active.' },
    ],
  });

  // T3.1 conservative: tightening requires ≥3 invariant clean runs. Prime two,
  // which must NOT tighten yet, then the third applies.
  const outputs = { same: [{ id: 'A' }], changed: [{ id: 'B' }] };
  assert.deepEqual(tightenWorkflowContractsFromCleanRun(slug, runStartDef, outputs, 'run-1'), []);
  assert.deepEqual(tightenWorkflowContractsFromCleanRun(slug, runStartDef, outputs, 'run-2'), []);
  const applied = tightenWorkflowContractsFromCleanRun(slug, runStartDef, outputs, 'run-3');

  assert.deepEqual(applied, ['same']);
  const saved = readWorkflow(slug)!.data;
  // the user's concurrent edit to `changed` is preserved, and only `same` (whose
  // prompt was unchanged) is tightened — the anti-clobber guard still holds.
  assert.equal(saved.description, 'User-edited definition while the run was active');
  assert.equal(saved.steps.find((s) => s.id === 'same')?.output?.type, 'array');
  assert.equal(saved.steps.find((s) => s.id === 'changed')?.output, undefined);
  assert.equal(saved.steps.find((s) => s.id === 'changed')?.prompt, 'User changed this step while run was active.');
});

test('phantomBlockedOutput: blocked shape names the step and its side-effect class', () => {
  const send = phantomBlockedOutput({ id: 'notify', sideEffect: 'send', prompt: '' });
  assert.equal(send.blocked, true);
  assert.match(send.reason, /"notify".*send step.*without calling any tool/s);
  const write = phantomBlockedOutput({ id: 'save', sideEffect: 'write', prompt: '' });
  assert.match(write.reason, /write step/);
  assert.match(write.reason, /write was not actually performed/);
});

// ─── WATCHER (workflow mount): trajectory steer at step boundaries ───────────

test('applyWatcherSteerToPrompt: appends the trajectory block only when a steer is pending', async () => {
  const { applyWatcherSteerToPrompt } = await import('./workflow-runner.js');
  assert.equal(applyWatcherSteerToPrompt({}, 'do the step'), 'do the step', 'no steer → byte-identical');
  const steered = applyWatcherSteerToPrompt({ watcherSteer: 'criterion 2 untouched. Address it before drafting.' }, 'do the step');
  assert.match(steered, /TRAJECTORY CHECK/);
  assert.match(steered, /criterion 2 untouched/);
  assert.match(steered, /remain authoritative/);
});

test('renderWatcherWorkflowDigest: completed outputs clipped, remaining steps named as NOT drift', async () => {
  const { renderWatcherWorkflowDigest } = await import('./workflow-runner.js');
  const digest = renderWatcherWorkflowDigest(
    [{ id: 'pull' }, { id: 'enrich' }, { id: 'send' }],
    { pull: { rows: 12, note: 'x'.repeat(500) }, enrich: 'twelve rows enriched' },
  );
  assert.match(digest.summary, /2 of 3 steps completed/);
  assert.match(digest.summary, /step "pull"/);
  assert.match(digest.summary, /Steps still to run \(NOT drift[^)]*\): send/);
  assert.ok(digest.summary.length < 1200, 'outputs are clipped');
  assert.match(digest.latest, /completed step "enrich"/);
});

test('WorkflowWatcherMailbox never waits for the judge and exposes a late verdict at a later boundary', async () => {
  let resolveJudge!: (verdict: { onTrack: boolean; miss: string; steer: string }) => void;
  const deferred = new Promise<{ onTrack: boolean; miss: string; steer: string }>((resolve) => {
    resolveJudge = resolve;
  });
  const mailbox = new WorkflowWatcherMailbox();

  assert.equal(mailbox.start(2, () => deferred), true);
  assert.equal(mailbox.inFlight, true);
  assert.equal(mailbox.take(), undefined, 'execution can continue immediately while the judge is unresolved');
  assert.equal(mailbox.start(3, () => deferred), false, 'never stacks verifier calls');

  resolveJudge({ onTrack: false, miss: 'criterion missing', steer: 'Address it before finishing.' });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(mailbox.take(), {
    afterSteps: 2,
    verdict: { onTrack: false, miss: 'criterion missing', steer: 'Address it before finishing.' },
  });
  mailbox.close();
});

test('workflow watcher: drift at a step boundary records a steer advisory with the right cadence and digest', async () => {
  const { writeWorkflow } = await import('../memory/workflow-store.js');
  const { recordStepResult } = await import('../tools/step-result-tool.js');
  const { _setWorkflowWatcherForTests: setWatcher } = await import('./workflow-runner.js');
  const slug = 'watcher-steer-runner';
  const workflowName = 'Watcher Steer Runner';
  const runId = `watcher-steer-${Date.now()}`;
  writeWorkflow(slug, {
    name: workflowName,
    description: 'Three-step chain to exercise the step-boundary watcher.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'a', prompt: 'Return fixture A.' },
      { id: 'b', prompt: 'Return fixture B.', dependsOn: ['a'] },
      { id: 'c', prompt: 'Return fixture C.', dependsOn: ['b'] },
    ],
  });
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId, workflow: workflowName, status: 'queued', inputs: {}, createdAt: new Date().toISOString(),
  }), 'utf-8');

  const digestsSeen: Array<{ summary: string; count: number }> = [];
  const previousWorkflowWatcher = process.env.CLEMMY_WORKFLOW_WATCHER_JUDGE;
  process.env.CLEMMY_WORKFLOW_WATCHER_JUDGE = 'on';
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (options: { sessionId: string }) => {
      recordStepResult(options.sessionId, { ok: true });
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: 'done', reply: 'done', done: true, nextAction: 'completed' },
      };
    }) as never,
  });
  setWatcher(async (input) => {
    digestsSeen.push({ summary: input.toolCallSummary, count: input.toolCallCount });
    return { onTrack: false, miss: 'the enrichment ignored the stated goal', steer: 'Re-anchor on the goal before the final step.' };
  });
  try {
    await processWorkflowRuns({} as never);
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
    setWatcher(async () => ({ onTrack: true, miss: '', steer: '' }));
    if (previousWorkflowWatcher === undefined) delete process.env.CLEMMY_WORKFLOW_WATCHER_JUDGE;
    else process.env.CLEMMY_WORKFLOW_WATCHER_JUDGE = previousWorkflowWatcher;
  }

  // Cadence: default interval 2 over 3 sequential steps → exactly ONE check
  // (after step 2; never after the final step — end-of-run judges own that).
  assert.equal(digestsSeen.length, 1, `expected one watcher check, saw ${digestsSeen.length}`);
  assert.equal(digestsSeen[0].count, 2, 'checked at the 2-completed-steps boundary');
  assert.match(digestsSeen[0].summary, /Steps still to run[^:]*: c/, 'digest names the remaining step');
  const events = readWorkflowEvents(slug, runId);
  const steer = events.find((e) => e.kind === 'step_advisory' && (e.meta as { reason?: string } | undefined)?.reason === 'watcher_steer');
  assert.ok(steer, `expected a watcher_steer advisory, got kinds: ${events.map((e) => e.kind).join(', ')}`);
  assert.match(String((steer!.meta as { steer?: string }).steer ?? ''), /Re-anchor on the goal/);
});

// A2 (v2.3.0): a workflow park must land the ACTIONABLE approval card in the
// origin chat — the same `approval_requested` event shape the chat folds into
// the approve/execute card — not just a prose "reply approve apr-x" turn
// (live 2026-07-23: user sat in the origin conversation with no card).
test('A2: parking emits the actionable approval card into the origin chat', () => {
  const origin = 'desktop-origin-a2';
  HarnessSession.create({ id: origin, kind: 'chat', channel: 'desktop', title: 'a2 origin', metadata: { source: 'desktop' } });
  const gateSid = 'workflow-gate:a2-run:post_slack';
  HarnessSession.create({ id: gateSid, kind: 'workflow', channel: 'workflow', title: 'a2 gate', metadata: { source: 'workflow' } });
  const row = approvalRegistry.register({
    sessionId: gateSid,
    subject: 'Post the update to #clawde-and-order',
    tool: 'composio_execute_tool',
    args: { tool_slug: 'SLACK_SEND_MESSAGE', channel: '#clawde-and-order' },
    ttlMs: 60_000,
  });
  const emitted = emitParkedApprovalCardToOriginChat({
    originSessionId: origin,
    approvalId: row.approvalId,
    workflowName: 'slack-eod',
    runId: 'run-a2',
  });
  assert.equal(emitted, true);
  const cards = listEvents(origin, { types: ['approval_requested'] });
  assert.equal(cards.length, 1, 'exactly one card event in the origin chat');
  const d = cards[0].data as Record<string, unknown>;
  assert.equal(d.approvalId, row.approvalId);
  assert.equal(d.subject, 'Post the update to #clawde-and-order');
  assert.equal(d.tool, 'composio_execute_tool');
  assert.equal(d.workflowName, 'slack-eod');
  assert.equal(d.runId, 'run-a2');

  // No registry row (or no approvalId at all) → no card, no throw; the prose
  // needs_input turn stays the guaranteed baseline.
  assert.equal(emitParkedApprovalCardToOriginChat({
    originSessionId: origin, approvalId: 'apr-does-not-exist', workflowName: 'w', runId: 'r',
  }), false);
  assert.equal(emitParkedApprovalCardToOriginChat({
    originSessionId: origin, approvalId: undefined, workflowName: 'w', runId: 'r',
  }), false);
  assert.equal(listEvents(origin, { types: ['approval_requested'] }).length, 1, 'failed emits add nothing');
});

// Discord double-card (live 2026-07-23): a workflow fired FROM Discord that
// parked on approval produced TWO approval messages in the channel — the
// notification card (fan-out) + the proactive "reply approve apr-x" prose
// relay. Channel origins with their own approval cards suppress the prose
// (passive staging remains); desktop keeps the relay (its card folds inline).
// Pinned at the channel-classification level the park block consults.
test('park relay: discord/slack origins suppress the proactive prose, desktop keeps it', async () => {
  const { originChannelRendersOwnApprovalCard } = await import('./workflow-runner.js');
  for (const [channel, suppressed] of [['desktop', false], ['discord', true], ['slack', true]] as const) {
    const s = HarnessSession.create({ id: `park-relay-${channel}`, kind: 'chat', channel, title: 'relay test', metadata: {} });
    assert.equal(originChannelRendersOwnApprovalCard(s.id), suppressed, `${channel} origin`);
  }
  // Unknown session → default to relaying (never silence the prose blindly).
  assert.equal(originChannelRendersOwnApprovalCard('sess-does-not-exist'), false);
});


// Workflow-level model pins (owner ask, 2026-07-24): pin brain + worker at
// authoring to cut tokens on every scheduled run. Precedence: step.model >
// models.brain > intent routing > role defaults.
test('resolveWorkflowStepModel honors the workflow-level brain pin under step.model', () => {
  const resolve = workflowRunnerInternalsForTest.resolveWorkflowStepModel;
  const wf = { models: { brain: 'kimi-k3' } } as never;
  assert.equal(resolve({ id: 's1', mode: 'llm' } as never, wf).model, 'kimi-k3', 'workflow brain pin is the step default');
  assert.equal(resolve({ id: 's1', mode: 'llm', model: 'glm-5.2' } as never, wf).model, 'glm-5.2', 'an explicit step.model still wins');
});

test('workflow worker pin: session override registers, wins at dispatch, and clears', async () => {
  const { setSessionWorkerModelOverride, getSessionWorkerModelOverride, clearSessionWorkerModelOverride, _resetSessionRoleOverridesForTests } =
    await import('../runtime/harness/session-role-overrides.js');
  _resetSessionRoleOverridesForTests();
  setSessionWorkerModelOverride('workflow:run-1:step-a', 'zai-org/GLM-5.2');
  assert.equal(getSessionWorkerModelOverride('workflow:run-1:step-a'), 'zai-org/GLM-5.2');
  assert.equal(getSessionWorkerModelOverride('some-other-session'), undefined, 'override is session-scoped');
  clearSessionWorkerModelOverride('workflow:run-1:step-a');
  assert.equal(getSessionWorkerModelOverride('workflow:run-1:step-a'), undefined, 'cleared at step end');
});

test('learned workflow read pins are advisory only before the ordinary harness invocation', async () => {
  resetEventLog();
  resetHarnessRuntimeConfig();
  const previous = {
    AUTH_MODE: process.env.AUTH_MODE,
    WORKFLOW_USE_HARNESS: process.env.WORKFLOW_USE_HARNESS,
    WORKFLOW_STEP_AGENT: process.env.WORKFLOW_STEP_AGENT,
    CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP: process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP,
    COMPOSIO_BACKEND: process.env.COMPOSIO_BACKEND,
  };
  process.env.AUTH_MODE = 'codex_oauth';
  process.env.WORKFLOW_USE_HARNESS = 'on';
  process.env.WORKFLOW_STEP_AGENT = 'off';
  process.env.CLEMMY_CLAUDE_AGENT_SDK_WORKFLOW_STEP = 'off';
  process.env.COMPOSIO_BACKEND = 'sdk';

  const workflowName = `Pin Advisory ${Date.now()}`;
  const workflowSlug = `pin-advisory-${Date.now()}`;
  const runId = `pin-advisory-run-${Date.now()}`;
  const stepId = 'read_records';
  const sessionId = `workflow:${runId}:${stepId}`;
  const slug = 'PROOF_LIST_RECORDS';
  const staleSlug = 'PROOF_STALE_LIST_RECORDS';
  const args = { scope: 'current' };
  const toolChoices = await import('../memory/tool-choice-store.js');
  const certifiedBindings = await import('../memory/workflow-certified-binding.js');
  const composioClient = await import('../integrations/composio/client.js');
  const schemaCache = await import('../tools/composio-schema-cache.js');
  const db = (await import('../runtime/harness/eventlog.js')).openEventLog();
  const authorityCounts = () => db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM logical_tool_calls WHERE session_id = ?) AS logical_calls,
      (SELECT COUNT(*) FROM run_dispatch_leases WHERE session_id = ?) AS call_leases,
      (SELECT COUNT(*) FROM physical_dispatches WHERE session_id = ?) AS physical_dispatches,
      (SELECT COUNT(*) FROM logical_call_settlements WHERE session_id = ?) AS settlements,
      (SELECT COUNT(*) FROM logical_call_settlements
        WHERE session_id = ? AND result_handle_id IS NOT NULL) AS result_handles
  `).get(sessionId, sessionId, sessionId, sessionId, sessionId) as {
    logical_calls: number;
    call_leases: number;
    physical_dispatches: number;
    settlements: number;
    result_handles: number;
  };
  const zeroAuthority = {
    logical_calls: 0,
    call_leases: 0,
    physical_dispatches: 0,
    settlements: 0,
    result_handles: 0,
  };

  toolChoices.rememberToolChoice({
    intent: certifiedBindings.workflowStepPinIntent(workflowName, stepId),
    description: 'Previously successful read route.',
    choice: {
      kind: 'composio',
      identifier: slug,
      invocationTemplate: JSON.stringify(args),
      testedAt: new Date().toISOString(),
      testEvidence: 'prior read completed successfully',
    },
  });
  const staleWorkflow = `${workflowName} Stale`;
  const staleIntent = certifiedBindings.workflowStepPinIntent(staleWorkflow, stepId);
  toolChoices.rememberToolChoice({
    intent: staleIntent,
    description: 'A route whose later execution failed.',
    choice: {
      kind: 'composio',
      identifier: staleSlug,
      invocationTemplate: JSON.stringify(args),
      testedAt: new Date().toISOString(),
      testEvidence: 'initial read completed successfully',
    },
  });
  toolChoices.updateToolChoiceOutcome(staleIntent, 'failure');

  const renderPin = workflowRunnerInternalsForTest.renderWorkflowToolPin;
  const exactHint = renderPin(workflowName, stepId);
  assert.match(exactHint, /LEARNED TOOL PIN/);
  assert.match(exactHint, new RegExp(slug));
  assert.equal(renderPin(`${workflowName} Mismatch`, stepId), '', 'lookup is exact, so another workflow cannot borrow this pin');
  assert.equal(renderPin(staleWorkflow, stepId), '', 'a net-failing pin is withheld rather than elevated to authority');
  assert.deepEqual(authorityCounts(), zeroAuthority, 'pin lookup/render mints no execution authority');

  let providerBodies = 0;
  composioClient.__test__.setComposioApiKeyOverride('cmp_test_pin_advisory');
  composioClient.__test__.setComposioClient({
    tools: {
      execute: async () => {
        providerBodies += 1;
        return { successful: true, data: { records: [{ id: 'provider-record' }] } };
      },
    },
  });
  composioClient.__test__.setConnectedAccountsLoader(async () => [{
    id: 'ca_pin_advisory',
    toolkit: { slug: 'proof' },
    status: 'ACTIVE',
    data: { user_info: { email: 'pin@example.test' } },
  }]);
  schemaCache.rememberToolSchema(slug, {
    type: 'object',
    required: ['scope'],
    properties: { scope: { type: 'string' } },
    additionalProperties: false,
  }, Date.now());

  let observedPrompt = '';
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (options: { sessionId: string; input?: string }) => {
      observedPrompt = options.input ?? '';
      assert.equal(providerBodies, 0, 'the learned pin cannot cross the provider before the model chooses a tool');
      assert.deepEqual(authorityCounts(), zeroAuthority, 'pre-model pin retrieval owns no logical/physical/lease/settlement rows');
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: {
          summary: 'No ordinary tool call was needed in this fixture.',
          reply: 'No ordinary tool call was needed in this fixture.',
          done: true,
          nextAction: 'completed',
        },
      };
    }) as never,
  });

  try {
    const step = {
      id: stepId,
      prompt: 'Read the current proof records.',
      model: 'gpt-5.4',
      sideEffect: 'read' as const,
      allowedTools: ['composio_execute_tool'],
    };
    const ctx = {
      workflow: {
        name: workflowName,
        description: 'Learned-pin authority regression.',
        enabled: true,
        trigger: { manual: true },
        allowedTools: ['composio_execute_tool'],
        steps: [step],
      },
      workflowSlug,
      runId,
      inputs: {},
      stepOutputs: {},
      assistant: { respond: async () => { throw new Error('legacy assistant should not run'); } },
      completedItems: new Map(),
      forEachFailures: [],
      qualityAdvisories: [],
    } as unknown as Parameters<typeof executeStep>[1];

    await executeStep(step, ctx);
    assert.match(observedPrompt, /LEARNED TOOL PIN/);
    assert.match(observedPrompt, new RegExp(slug));
    assert.doesNotMatch(observedPrompt, /HOST SETTLED READ|runtime already executed/i);
    assert.equal(providerBodies, 0);
    assert.deepEqual(authorityCounts(), zeroAuthority);
    assert.equal(
      readWorkflowEvents(workflowSlug, runId)
        .some((event) => event.kind === 'step_advisory' && event.meta?.reason === 'host_dispatched_step_pin'),
      false,
      'pin memory cannot publish a host-dispatch claim',
    );
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
    composioClient.__test__.setConnectedAccountsLoader(null);
    composioClient.__test__.setComposioApiKeyOverride(null);
    composioClient.resetComposioClient();
    resetHarnessRuntimeConfig();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ─── Claude-SDK lane arms turn-graph authority before its model runs ─────────
//
// Live (2026-08-25, platform-49 run 1787649022538-3634b5): deleting the
// pre-model graph persist to fix the typed-lane collision ALSO disarmed the
// Claude-SDK workflow lane — which never enters admit-and-compile, so no
// admitted graph ever exists for its source. callAdmissionAuthorityFor fell
// through to expectedTaskFor and every MCP-carried composio call was refused
// pre-execution ("no persisted turn graph for accepted task") while
// host-local tools sailed past the wall: four refusals, zero external reads,
// an honest but empty blocked report. The lane-scoped persist restores the
// authority; the collision cannot recur here because this lane never admits.
// ─── The Claude Agent SDK workflow-step lane is REMOVED (owner goal, 2026-08-25) ─
//
// "Keep Claude coach but remove Clem from running Claude workflow steps via
// the Claude agent SDK." The five pins that stood here exercised the removed
// carrier (SDK parking, SDK structured output, SDK stop targeting, SDK throw
// handling, and the lane-scoped graph persist). A Claude-model step now takes
// the SAME harness path as every other model — parking, stop, failure
// marking, and authority arming are the shared harness-lane machinery already
// pinned by the standard-step tests in this file. The one contract unique to
// the removal is pinned below: the SDK executor is never consulted.
test('a Claude-model step routes through the harness lane and never enters the SDK executor', async () => {
  resetEventLog();
  resetHarnessRuntimeConfig();
  const prev = {
    AUTH_MODE: process.env.AUTH_MODE,
    WORKFLOW_USE_HARNESS: process.env.WORKFLOW_USE_HARNESS,
  };
  let sdkInvocations = 0;
  const step = {
    id: 'claude_step',
    prompt: 'Summarize the workspace state.',
    model: 'claude-sonnet-4-6',
  };
  const ctx = {
    workflow: {
      name: 'Fork Kill Probe', description: 'test', enabled: true,
      trigger: { manual: true }, steps: [step],
    },
    workflowSlug: 'fork-kill-probe',
    runId: 'wf-fork-kill-1',
    inputs: {},
    stepOutputs: {},
    assistant: { respond: async () => 'harness-lane-answer' },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];
  try {
    process.env.AUTH_MODE = 'codex_oauth';
    // WORKFLOW_USE_HARNESS off keeps this probe on the legacy assistant seam —
    // the routing DECISION under test is identical: the SDK stub must not fire.
    process.env.WORKFLOW_USE_HARNESS = 'off';
    setClaudeAgentSdkWorkflowStepRunForTest(async () => {
      sdkInvocations += 1;
      throw new Error('the removed SDK workflow-step lane must never be consulted');
    });
    await executeStep(step, ctx);
    assert.equal(sdkInvocations, 0, 'a Claude-model step never enters the Claude Agent SDK executor');
    // Lane-absence is a SOURCE property: the runner module must not reference
    // the SDK step executor or its transport at all — a re-added import or
    // branch fails here even before any routing scenario exercises it.
    const runnerSource = readFileSync(path.join(process.cwd(), 'src/execution/workflow-runner.ts'), 'utf-8');
    assert.ok(!runnerSource.includes('runClaudeAgentSdkWorkflowStep'), 'the SDK step executor is not referenced by the runner');
    assert.ok(!runnerSource.includes("routeKind: 'claude_agent_sdk_workflow_step'"), 'the SDK step transport is not minted by the runner');
  } finally {
    setClaudeAgentSdkWorkflowStepRunForTest(null);
    resetHarnessRuntimeConfig();
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ─── Gate 12: ordinary-step output-contract repair beat ─────────────────────
// A contract violation on an ordinary contract-bearing step used to fail the
// run outright; loopUntil steps already got evidence-fed retries. The ordinary
// step now gets ONE evidence-fed re-run on the same durable step session; the
// second failure still raises WorkflowContractViolationError('output_contract').
// A step whose session already crossed irreversibly is never re-run.
const contractRepair = await import('./workflow-runner.js');
const harnessEventlog = await import('../runtime/harness/eventlog.js');

test('stepContractRepairEnabled: contract-bearing plain steps only', () => {
  const base = { id: 's', prompt: 'p', sideEffect: 'read' as const, output: { type: 'object', required_keys: ['summary'] } };
  assert.equal(contractRepair.stepContractRepairEnabled(base as never), true);
  assert.equal(contractRepair.stepContractRepairEnabled({ ...base, sideEffect: 'send' } as never), true,
    'eligibility is shape-based; the side-effect law is enforced at retry time');
  assert.equal(contractRepair.stepContractRepairEnabled({ id: 's', prompt: 'p', sideEffect: 'read' } as never), false, 'no contract, nothing to repair');
  assert.equal(contractRepair.stepContractRepairEnabled({ ...base, loopUntil: { maxAttempts: 3 } } as never), false, 'loopUntil owns its own loop');
  assert.equal(contractRepair.stepContractRepairEnabled({ ...base, forEach: 'items' } as never), false);
  assert.equal(contractRepair.stepContractRepairEnabled({ ...base, deterministic: { runner: 'x.mjs' } } as never), false);
  assert.equal(contractRepair.stepContractRepairEnabled({ ...base, call: { tool: 'FIXTURE_READ', args: {} } } as never), false,
    'an exact call node re-executes the provider, it does not re-shape output');
  assert.equal(contractRepair.CONTRACT_REPAIR_MAX_ATTEMPTS, 2);
});

function contractRepairCtx(
  workflowSlug: string,
  runId: string,
  step: Record<string, unknown>,
  respond: (request: unknown) => Promise<{ text: string }>,
) {
  return {
    workflow: { name: `Contract Repair ${runId}`, description: '', enabled: true, trigger: { manual: true }, steps: [step] },
    workflowSlug,
    runId,
    inputs: {},
    stepOutputs: {},
    assistant: { respond },
    completedItems: new Map(),
    forEachFailures: [],
    qualityAdvisories: [],
  } as unknown as Parameters<typeof executeStep>[1];
}

/** Drive the real harness step lane with a stubbed conversation: each call
 *  answers with the next reply and records the exact prompt it was given. */
async function withStubbedHarnessLane<T>(
  replies: (input: string, call: number) => string,
  work: (inputs: string[]) => Promise<T>,
): Promise<T> {
  const inputs: string[] = [];
  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    runConversation: (async (options: { sessionId: string; input?: string }) => {
      const input = options.input ?? '';
      inputs.push(input);
      const text = replies(input, inputs.length);
      return {
        sessionId: options.sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: text, reply: text, done: true, nextAction: 'completed' },
      };
    }) as never,
  });
  try {
    return await work(inputs);
  } finally {
    _setWorkflowHarnessLoopImplsForTests();
  }
}

test('an ordinary contract-bearing step gets one evidence-fed re-run and passes', async () => {
  const workflowSlug = 'contract-repair-pass';
  const runId = 'cr-pass-1';
  const step = {
    id: 'wrap_up',
    prompt: 'Summarize the day.',
    sideEffect: 'read',
    output: { type: 'object', required_keys: ['summary'] },
  };
  await withStubbedHarnessLane(
    (_input, call) => (call === 1
      ? 'Here is a prose summary with none of the contracted keys.'
      : JSON.stringify({ summary: 'corrected on the repair beat' })),
    async (inputs) => {
    const ctx = contractRepairCtx(workflowSlug, runId, step, async () => { throw new Error('legacy assistant must not run'); });
    const output = await workflowRunnerInternalsForTest.runStepVerifiedAttempt(step as never, ctx);
    assert.deepEqual(output, { summary: 'corrected on the repair beat' });
    assert.equal(inputs.length, 2, 'exactly one repair re-run');
    assert.match(inputs[1]!, /CONTRACT RETRY \(attempt 2\)/, 'the second attempt carries the exact contract evidence');
    assert.match(inputs[1]!, /summary/, 'the evidence names the missing key');
    assert.doesNotMatch(inputs[0]!, /CONTRACT RETRY/, 'the first attempt is the plain authored step');
    const events = readWorkflowEvents(workflowSlug, runId);
    const retry = events.find((event) => event.kind === 'step_loop_retry' && event.stepId === step.id);
    assert.ok(retry, 'the repair beat is journaled as a contract retry');
    assert.equal(retry?.meta?.attempt, 1);
    assert.equal(retry?.meta?.maxAttempts, 2);
    assert.ok(events.some((event) => event.kind === 'step_completed' && event.stepId === step.id));
  });
});

test('two contract failures still fail the step with output_contract', async () => {
  const workflowSlug = 'contract-repair-fail';
  const runId = 'cr-fail-1';
  const step = {
    id: 'wrap_up',
    prompt: 'Summarize the day.',
    sideEffect: 'read',
    output: { type: 'object', required_keys: ['summary'] },
  };
  await withStubbedHarnessLane(() => 'Still prose, still no contracted keys.', async (inputs) => {
    const calls = () => inputs.length;
    const ctx = contractRepairCtx(workflowSlug, runId, step, async () => { throw new Error('legacy assistant must not run'); });
    await assert.rejects(
      () => workflowRunnerInternalsForTest.runStepVerifiedAttempt(step as never, ctx),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowContractViolationError);
        assert.equal(error.reason, 'output_contract');
        assert.match(error.message, /output failed its contract/);
        return true;
      },
    );
    assert.equal(calls(), 2, 'bounded: one repair beat, then the violation propagates');
    const events = readWorkflowEvents(workflowSlug, runId);
    assert.equal(events.filter((event) => event.kind === 'step_loop_retry').length, 1);
    assert.equal(events.filter((event) => event.kind === 'step_failed' && event.meta?.reason === 'output_contract').length, 2);
    assert.ok(!events.some((event) => event.kind === 'step_completed'));
  });
});

test('a step whose session already crossed irreversibly is never re-run for a contract repair', async () => {
  const workflowSlug = 'contract-repair-crossed';
  const runId = 'cr-crossed-1';
  // The crossing truth is the SESSION's, not the declaration's: the guard reads
  // the durable ledger of this step's own harness session.
  const step = {
    id: 'post_update',
    prompt: 'Report the update and return the structured receipt.',
    sideEffect: 'read',
    output: { type: 'object', required_keys: ['posted'] },
  };
  const sessionId = `workflow:${runId}:${step.id}`;
  harnessEventlog.createSession({ id: sessionId, kind: 'workflow', channel: 'workflow' });
  harnessEventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: { toolName: 'fixture_send', callId: 'sent-1', irreversible: true },
  });
  assert.equal(contractRepair.stepIrreversibleCrossingRecorded(runId, step.id), true);
  assert.equal(contractRepair.stepIrreversibleCrossingRecorded(runId, 'never_ran'), false);
  await withStubbedHarnessLane(() => 'Posted, but as prose.', async (inputs) => {
    const ctx = contractRepairCtx(workflowSlug, runId, step, async () => { throw new Error('legacy assistant must not run'); });
    await assert.rejects(
      () => workflowRunnerInternalsForTest.runStepVerifiedAttempt(step as never, ctx),
      (error: unknown) => error instanceof WorkflowContractViolationError && error.reason === 'output_contract',
    );
    assert.equal(inputs.length, 1, 'a second crossing is never risked for a shape fix');
    assert.equal(readWorkflowEvents(workflowSlug, runId).some((event) => event.kind === 'step_loop_retry'), false);
  });
});

// ─── Ever-learning: the learned pin is the CORRECTED call, never the refused one
const learnedPinToolChoices = await import('../memory/tool-choice-store.js');
const learnedPinBindings = await import('../memory/workflow-certified-binding.js');

test('rememberProvenWorkflowStepTool records the corrected invocation template, never a refused attempt', () => {
  const toolChoices = learnedPinToolChoices;
  const { workflowStepPinIntent } = learnedPinBindings;
  const refusedMarker = JSON.stringify({
    protocol: 'host_tool_disposition_v1',
    disposition: 'refused_pre_dispatch',
    frameDigest: 'f'.repeat(64),
    frameIndex: 0,
    frameSize: 1,
    effect: 'none',
    retry: 'replan',
    requiresReconciliation: false,
    message: 'Retry this same operation exactly once with one corrected JSON object.',
  });
  const refusedArgs = JSON.stringify({ tool_slug: 'FIXTURE_SHEETS_UPDATE', arguments: JSON.stringify({ range: 'A1', values: [[1]] }) });
  const correctedArgs = JSON.stringify({ tool_slug: 'FIXTURE_SHEETS_UPDATE', arguments: JSON.stringify({ range: { sheetId: 0, startIndex: 1 }, values: [[1]] }) });
  const seed = (sessionId: string, order: 'refused_then_corrected' | 'corrected_then_refused') => {
    harnessEventlog.createSession({ id: sessionId, kind: 'workflow', channel: 'workflow' });
    const pairs = order === 'refused_then_corrected'
      ? [['refused-1', refusedArgs, refusedMarker], ['corrected-1', correctedArgs, '{"successful":true,"data":{"updatedRows":1}}']]
      : [['corrected-1', correctedArgs, '{"successful":true,"data":{"updatedRows":1}}'], ['refused-2', refusedArgs, refusedMarker]];
    for (const [callId, args, result] of pairs) {
      harnessEventlog.appendEvent({
        sessionId, turn: 1, role: 'agent', type: 'tool_called',
        data: { tool: 'composio_execute_tool', callId, arguments: args },
      });
      harnessEventlog.appendEvent({
        sessionId, turn: 1, role: 'agent', type: 'tool_returned',
        data: { tool: 'composio_execute_tool', callId, result },
      });
    }
  };
  for (const [index, order] of (['refused_then_corrected', 'corrected_then_refused'] as const).entries()) {
    const workflowName = `Learned Pin ${order}`;
    const stepId = 'update_sheet';
    const sessionId = `workflow:learned-pin-${index}:${stepId}`;
    seed(sessionId, order);
    workflowRunnerInternalsForTest.rememberProvenWorkflowStepTool({ sessionId, workflowName, stepId });
    const record = toolChoices.peekToolChoice(workflowStepPinIntent(workflowName, stepId));
    assert.ok(record, `${order}: a proven call is pinned`);
    assert.equal(record?.choice.identifier, 'FIXTURE_SHEETS_UPDATE');
    assert.match(record?.choice.invocationTemplate ?? '', /startIndex/, `${order}: the CORRECTED shape is the template`);
    assert.doesNotMatch(record?.choice.invocationTemplate ?? '', /"A1"/, `${order}: the refused shape never becomes a pin`);
  }
  const emptySession = 'workflow:learned-pin-refused-only:update_sheet';
  harnessEventlog.createSession({ id: emptySession, kind: 'workflow', channel: 'workflow' });
  harnessEventlog.appendEvent({
    sessionId: emptySession, turn: 1, role: 'agent', type: 'tool_called',
    data: { tool: 'composio_execute_tool', callId: 'refused-only', arguments: refusedArgs },
  });
  harnessEventlog.appendEvent({
    sessionId: emptySession, turn: 1, role: 'agent', type: 'tool_returned',
    data: { tool: 'composio_execute_tool', callId: 'refused-only', result: refusedMarker },
  });
  workflowRunnerInternalsForTest.rememberProvenWorkflowStepTool({ sessionId: emptySession, workflowName: 'Learned Pin refused only', stepId: 'update_sheet' });
  assert.ok(!toolChoices.peekToolChoice(workflowStepPinIntent('Learned Pin refused only', 'update_sheet')),
    'a step whose only provider call was refused learns nothing');
});
