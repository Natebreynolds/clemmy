import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
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

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clementine-workflow-interval-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { processWorkflowSchedules } = await import('./workflow-scheduler.js');
const {
  workflowIntervalSchedulerInternalsForTest,
} = await import('./workflow-interval-scheduler.js');
const { readWorkflow, writeWorkflow } = await import('../memory/workflow-store.js');
const control = await import('./automation-recurrence-control-plane.js');
const plans = await import('../memory/workflow-node-invocation-plan.js');
const definitions = await import('./workflow-run-definition.js');
const intervalRunIdentity = await import('./workflow-interval-run-identity.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const {
  workflowIntervalDigest,
  workflowIntervalOccurrenceId,
} = await import('../shared/workflow-interval.js');
import type { WorkflowIntervalV1 } from '../shared/workflow-interval.js';
import type { WorkflowDefinition } from '../memory/workflow-store.js';

const HOUR = 3_600_000;
const ANCHOR = '2026-08-22T19:00:00.000Z';
const ANCHOR_MS = Date.parse(ANCHOR);
const INTERVAL_STATE_FILE = workflowIntervalSchedulerInternalsForTest.intervalStateFile;
const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

workflowIntervalSchedulerInternalsForTest.setCurrentRecurrenceAuthorityResolverForTests(
  (activationId) => {
    const contract = control.getAutomationRecurrenceActivationContract(activationId);
    return contract
      ? { ok: true, snapshot: structuredClone(contract.pilotSuccess.authoritySnapshot) }
      : { ok: false, reason: 'test recurrence contract is missing' };
  },
);

test.beforeEach(() => {
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  rmSync(INTERVAL_STATE_FILE, { force: true });
  mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
});

test.after(() => {
  workflowIntervalSchedulerInternalsForTest.setCurrentRecurrenceAuthorityResolverForTests(null);
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function interval(overrides: Partial<WorkflowIntervalV1> = {}): WorkflowIntervalV1 {
  return {
    version: 1,
    every: 2,
    unit: 'hour',
    anchorAt: ANCHOR,
    overlapPolicy: 'queue_one',
    catchUpPolicy: 'run_once',
    ...overrides,
  };
}

let seedSequence = 0;

function seed(name: string, recurrence = interval()): void {
  seedSequence += 1;
  const label = `${name}.${seedSequence}`;
  const plan = plans.createWorkflowNodeInvocationPlan({
    requirementId: `requirement.${label}`,
    logicalCapabilityId: `logical.${label}`,
    binding: {
      capabilityId: `capability.${label}`,
      manifestId: `manifest.${label}`,
      manifestDigest: digest(`manifest.${label}`),
      operationId: `operation.${label}`,
      operationVersion: '1',
      schemaDigest: digest(`schema.${label}`),
      providerVersion: '1',
      liveFingerprint: digest(`live.${label}`),
      accountId: `account.${label}`,
      effect: 'read',
      invokePortId: `port.${label}`,
      argumentCompiler: { id: 'compiler.exact', version: '1' },
    },
    arguments: {
      scope: {
        source: { kind: 'workflow_input', key: 'scope' },
        required: true,
        type: 'string',
      },
    },
    evidence: { requiredPaths: ['records'], nonEmptyPaths: ['records'], minItems: { records: 1 } },
    completeness: { kind: 'terminal_result', evidencePaths: ['records'] },
    continuation: { kind: 'none' },
  });
  const sourceDefinition: WorkflowDefinition = {
    name,
    description: `Generated interval workflow ${name}`,
    description_body: `Generated interval workflow ${name}`,
    enabled: false,
    trigger: { manual: true },
    allowedTools: [],
    inputs: { scope: { type: 'string', required: true } },
    steps: [{
      id: 'read',
      prompt: '',
      sideEffect: 'read',
      allowedTools: [],
      invocationPlan: plan,
    }],
  };
  const oldActive = control.getActiveAutomationRecurrenceForWorkflow(name);
  if (oldActive) {
    control.reconcileAutomationRecurrenceActivation({
      activationId: oldActive.activation.activationId,
      currentDefinition: sourceDefinition,
      at: '2026-08-22T18:58:00.000Z',
    });
  }
  const workflowInputs = { scope: `scope.${label}` };
  const authoritySnapshot = {
    version: 1 as const,
    capabilitySnapshotDigest: digest(`capability-snapshot.${label}`),
    accountSnapshotDigest: digest(`account-snapshot.${label}`),
    schemaSnapshotDigest: digest(`schema-snapshot.${label}`),
    bindingSnapshotDigest: digest(`binding-snapshot.${label}`),
    controlContractDigest: digest(`control.${label}`),
  };
  const evidence = control.createAutomationRecurrencePilotSuccessEvidence({
    version: 1,
    proposalId: `proposal.${label}`,
    proposalRevision: 1,
    proposalDigest: digest(`proposal.${label}`),
    workflowId: name,
    workflowRevision: 1,
    workflowDigest: definitions.workflowDefinitionHash(sourceDefinition),
    nodeId: 'read',
    invocationPlanDigest: plan.bindingDigest,
    workflowInputs,
    workflowInputsDigest: digest(JSON.stringify(workflowInputs)),
    pilotCompilationDigest: digest(`compilation.${label}`),
    pilotAuthorizationRef: `approval.pilot.${label}`,
    pilotAuthorizationDigest: digest(`approval-pilot.${label}`),
    runId: `run.pilot.${label}`,
    runOccurrenceId: `occurrence.pilot.${label}`,
    triggerReceiptId: `trigger.pilot.${label}`,
    triggerReceiptDigest: digest(`trigger.${label}`),
    terminalReceiptId: `terminal.pilot.${label}`,
    terminalReceiptDigest: digest(`terminal.${label}`),
    status: 'completed',
    terminalOutcome: 'succeeded',
    needsAttention: false,
    finishedAt: '2026-08-22T18:59:00.000Z',
    resultAuthority: {
      version: 1,
      kind: 'closed_read',
      receiptId: `closed-read.${label}`,
      receiptDigest: digest(`closed-read.${label}`),
      acceptedSourceCount: 1,
    },
    settlement: {
      version: 1,
      clean: true,
      receiptId: `settlement.${label}`,
      receiptDigest: digest(`settlement.${label}`),
      reasons: [],
    },
    selectedSuccessCriterionIds: ['criterion.complete'],
    criterionEvidence: [{
      criterionId: 'criterion.complete',
      outcome: 'met',
      evidenceRef: `evidence.${label}`,
      evidenceDigest: digest(`evidence.${label}`),
    }],
    authoritySnapshot,
  });
  const preview = control.createAutomationRecurrencePreview({
    pilotSuccess: evidence,
    workflowSlug: name,
    sourceDefinition,
    cadence: {
      every: recurrence.every,
      unit: recurrence.unit,
      overlapPolicy: recurrence.overlapPolicy,
      catchUpPolicy: recurrence.catchUpPolicy,
    },
    previewedAt: '2026-08-22T18:59:30.000Z',
  });
  assert.deepEqual(preview.interval, recurrence);
  const request = control.createAutomationRecurrenceConsentRequest({
    preview,
    approvalSessionId: `chat.${label}`,
  });
  const registered = control.registerAutomationRecurrenceActivation({
    pilotSuccess: evidence,
    preview,
    consentRequest: request,
    at: '2026-08-22T18:59:35.000Z',
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) throw new Error(registered.reason);
  const approval = {
    approvalId: `approval.recurrence.${label}`,
    sessionId: request.approvalSessionId,
    channel: 'desktop',
    channelId: null,
    requestedAt: '2026-08-22T18:59:36.000Z',
    expiresAt: '2026-08-23T18:59:36.000Z',
    subject: request.subject,
    tool: request.tool,
    args: request.args,
    status: 'resolved' as const,
    resolution: 'approved' as const,
    resolver: 'human.owner',
    resolvedAt: '2026-08-22T18:59:40.000Z',
    resumeKey: request.resumeKey,
    consumedAt: null,
    presentation: null,
  };
  const bound = control.bindAutomationRecurrenceConsentApproval({
    activationId: registered.state.activationId,
    approval,
    at: '2026-08-22T18:59:40.000Z',
  });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  const ready = control.reconcileAutomationRecurrenceActivation({
    activationId: registered.state.activationId,
    currentDefinition: sourceDefinition,
    approval,
    at: '2026-08-22T18:59:45.000Z',
  });
  assert.equal(ready.ok && ready.state, 'ready_to_install');
  if (!ready.ok || ready.state !== 'ready_to_install') throw new Error('recurrence fixture was not installable');
  writeWorkflow(name, ready.installation.authorizedDefinition);
  const retained = readWorkflow(name);
  assert.ok(retained);
  assert.equal(
    retained ? definitions.workflowDefinitionHash(retained.data) : '',
    preview.authorizedEnabledDefinitionHash,
  );
  const active = control.reconcileAutomationRecurrenceActivation({
    activationId: registered.state.activationId,
    currentDefinition: retained?.data,
    at: '2026-08-22T18:59:50.000Z',
  });
  assert.equal(active.ok && active.state, 'active', JSON.stringify(active));
}

function runRecords(workflow?: string): Array<Record<string, unknown>> {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return [];
  return readdirSync(WORKFLOW_RUNS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(
      readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf8'),
    ) as Record<string, unknown>)
    .filter((record) => workflow === undefined || record.workflow === workflow);
}

function updateRunStatus(id: string, status: string): void {
  const file = path.join(WORKFLOW_RUNS_DIR, `${id}.json`);
  const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...record, status }, null, 2), 'utf8');
}

test('an enabled interval definition without a standing activation receipt stays configuration-only', async () => {
  const name = 'configured-without-consent';
  writeWorkflow(name, {
    name,
    description: 'Configuration alone is not recurrence authority.',
    enabled: true,
    trigger: { interval: interval() },
    steps: [{ id: 'read', prompt: 'Read a source.', sideEffect: 'read' }],
  });
  const result = await processWorkflowSchedules(new Date(ANCHOR_MS + 2 * HOUR));
  assert.deepEqual(result.fired, []);
  assert.equal(result.held.includes(name), true);
  assert.deepEqual(runRecords(name), []);
});

test('an unreadable run record makes overlap pressure fail closed', () => {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, 'corrupt.json'), '{not-json', 'utf8');
  const pressure = workflowIntervalSchedulerInternalsForTest.intervalRunPressure(
    digest('arbitrary-revision'),
  );
  assert.equal(pressure.uncertain, true);
  assert.equal(pressure.activeRuns >= 1, true);
  assert.equal(pressure.pendingRuns >= 1, true);
});

test('every awaiting, approval, held, and future non-terminal run state is overlap pressure', async () => {
  const name = 'generated-nonterminal-pressure';
  seed(name);
  await processWorkflowSchedules(new Date(ANCHOR_MS + 2 * HOUR));
  const run = runRecords(name)[0];
  const revisionIdentity = intervalRunIdentity.workflowIntervalRevisionIdentityFromRun(run);
  assert.equal(typeof revisionIdentity, 'string');

  for (const status of [
    'running',
    'finalizing',
    'parked',
    'held',
    'awaiting_input',
    'awaiting_user_input',
    'awaiting_approval',
    'blocked_capability',
    'blocked_mutation',
    'future_nonterminal_state',
  ]) {
    updateRunStatus(String(run.id), status);
    const pressure = workflowIntervalSchedulerInternalsForTest.intervalRunPressure(revisionIdentity!);
    assert.equal(pressure.uncertain, false, status);
    assert.equal(pressure.activeRuns, 1, status);
    assert.equal(pressure.pendingRuns, 0, status);
  }
});

test('every-two-hours uses the exact activation anchor and one deterministic occurrence receipt', async () => {
  const name = 'generated-anchor';
  const recurrence = interval();
  seed(name, recurrence);

  assert.deepEqual((await processWorkflowSchedules(new Date(ANCHOR))).fired, []);
  assert.deepEqual(
    (await processWorkflowSchedules(new Date(ANCHOR_MS + 2 * HOUR - 1))).fired,
    [],
  );
  const due = await processWorkflowSchedules(new Date(ANCHOR_MS + 2 * HOUR + 15_000));
  assert.deepEqual(due.fired, [name], JSON.stringify(due));

  const records = runRecords(name);
  assert.equal(records.length, 1);
  assert.equal(
    records[0].triggerReceiptId,
    workflowIntervalOccurrenceId({ workflowKey: name, interval: recurrence, ordinal: 1 }),
  );
  await processWorkflowSchedules(new Date(ANCHOR_MS + 2 * HOUR + 30_000));
  assert.equal(runRecords(name).length, 1, 'repeated ticks in the due minute cannot duplicate the run');
});

test('restart after queue acceptance converges on the accepted occurrence instead of duplicating it', async () => {
  const name = 'generated-restart';
  const recurrence = interval();
  seed(name, recurrence);
  await processWorkflowSchedules(new Date(ANCHOR_MS + 2 * HOUR));
  assert.equal(runRecords(name).length, 1);

  // Recreate the exact durable pre-commit cursor: the run/receipt exists, while
  // the scheduler cursor still says ordinal 1 is unhandled.
  writeFileSync(INTERVAL_STATE_FILE, JSON.stringify({
    version: 1,
    byWorkflow: {
      [`wf:${name}`]: {
        contractDigest: workflowIntervalDigest(recurrence),
        lastHandledOrdinal: 0,
      },
    },
  }, null, 2));

  const replay = await processWorkflowSchedules(new Date(ANCHOR_MS + 2 * HOUR));
  assert.equal(replay.deduped.includes(name), true);
  assert.equal(runRecords(name).length, 1);
  const state = workflowIntervalSchedulerInternalsForTest.loadIntervalState();
  assert.equal(state.byWorkflow[`wf:${name}`]?.lastHandledOrdinal, 1);
  assert.equal(state.byWorkflow[`wf:${name}`]?.pending, undefined);
});

test('missed occurrences obey run_once and skip without enumerating backlog', async () => {
  const runOnce = 'generated-run-once';
  const skip = 'generated-skip-catchup';
  const runOnceInterval = interval({ catchUpPolicy: 'run_once' });
  seed(runOnce, runOnceInterval);
  seed(skip, interval({ catchUpPolicy: 'skip' }));

  const result = await processWorkflowSchedules(new Date(ANCHOR_MS + 10 * HOUR + 5 * 60_000));
  assert.equal(result.fired.includes(runOnce), true);
  assert.equal(result.deduped.includes(skip), true);
  assert.equal(runRecords(runOnce).length, 1, 'run_once collapses five due ordinals to one run');
  assert.equal(runRecords(skip).length, 0, 'skip manufactures no recovery work');
  assert.equal(
    runRecords(runOnce)[0].triggerReceiptId,
    workflowIntervalOccurrenceId({ workflowKey: runOnce, interval: runOnceInterval, ordinal: 5 }),
  );
  const state = workflowIntervalSchedulerInternalsForTest.loadIntervalState();
  assert.equal(state.byWorkflow[`wf:${runOnce}`]?.lastHandledOrdinal, 5);
  assert.equal(state.byWorkflow[`wf:${skip}`]?.lastHandledOrdinal, 5);
});

test('overlap skip drops one occurrence while queue_one preserves exactly one restart-safe pending unit', async () => {
  const queueOne = 'generated-overlap-queue-one';
  const skip = 'generated-overlap-skip';
  seed(queueOne, interval({ overlapPolicy: 'queue_one' }));
  seed(skip, interval({ overlapPolicy: 'skip' }));
  const first = await processWorkflowSchedules(new Date(ANCHOR_MS + 2 * HOUR));
  assert.equal(first.fired.includes(queueOne), true);
  assert.equal(first.fired.includes(skip), true);
  const queueOneRunId = String(runRecords(queueOne)[0].id);
  const skipRunId = String(runRecords(skip)[0].id);
  updateRunStatus(queueOneRunId, 'running');
  updateRunStatus(skipRunId, 'running');

  const overlapped = await processWorkflowSchedules(new Date(ANCHOR_MS + 4 * HOUR));
  assert.equal(overlapped.deferred.includes(queueOne), true);
  assert.equal(overlapped.deduped.includes(skip), true);
  assert.equal(runRecords(queueOne).length, 1, 'queue_one does not create an executable overlap');
  assert.equal(runRecords(skip).length, 1, 'skip does not create an executable overlap');
  let state = workflowIntervalSchedulerInternalsForTest.loadIntervalState();
  assert.ok(state.byWorkflow[`wf:${queueOne}`]?.pending, 'queue_one keeps one fsynced scheduler slot');
  assert.equal(state.byWorkflow[`wf:${skip}`]?.pending, undefined);
  assert.equal(state.byWorkflow[`wf:${skip}`]?.lastHandledOrdinal, 2);

  updateRunStatus(queueOneRunId, 'completed');
  updateRunStatus(skipRunId, 'completed');
  const released = await processWorkflowSchedules(new Date(ANCHOR_MS + 4 * HOUR + 30_000));
  assert.equal(released.fired.includes(queueOne), true);
  assert.equal(released.fired.includes(skip), false);
  assert.equal(runRecords(queueOne).length, 2);
  assert.equal(runRecords(skip).length, 1);

  await processWorkflowSchedules(new Date(ANCHOR_MS + 4 * HOUR + 45_000));
  assert.equal(runRecords(queueOne).length, 2, 'the released pending occurrence is accepted once');
  state = workflowIntervalSchedulerInternalsForTest.loadIntervalState();
  assert.equal(state.byWorkflow[`wf:${queueOne}`]?.pending, undefined);
  assert.equal(state.byWorkflow[`wf:${queueOne}`]?.lastHandledOrdinal, 2);
});

test('changing any interval contract bytes invalidates the old cursor and occurrence identity', async () => {
  const name = 'generated-contract-change';
  const first = interval({ every: 2 });
  seed(name, first);
  await processWorkflowSchedules(new Date(ANCHOR_MS + 2 * HOUR));
  const firstRun = runRecords(name)[0];
  updateRunStatus(String(firstRun.id), 'running');

  const changed = interval({ every: 4 });
  seed(name, changed);
  const result = await processWorkflowSchedules(new Date(ANCHOR_MS + 4 * HOUR));
  assert.equal(result.fired.includes(name), true, 'the revised contract inherits no old overlap authority');
  const records = runRecords(name);
  assert.equal(records.length, 2);
  const oldReceipt = workflowIntervalOccurrenceId({ workflowKey: name, interval: first, ordinal: 1 });
  const changedReceipt = workflowIntervalOccurrenceId({ workflowKey: name, interval: changed, ordinal: 1 });
  assert.notEqual(oldReceipt, changedReceipt);
  assert.deepEqual(
    new Set(records.map((record) => record.triggerReceiptId)),
    new Set([oldReceipt, changedReceipt]),
  );
});

test('restart recovery is bounded and leaves exact pending work for later ticks', async () => {
  const limit = workflowIntervalSchedulerInternalsForTest.maxRecoveryEnqueuesPerTick;
  const names = Array.from({ length: limit + 3 }, (_, index) => `generated-recovery-${String(index).padStart(2, '0')}`);
  for (const name of names) seed(name, interval({ catchUpPolicy: 'run_once' }));

  const first = await processWorkflowSchedules(new Date(ANCHOR_MS + 10 * HOUR + 5 * 60_000));
  assert.equal(first.fired.length, limit);
  assert.equal(first.deferred.length, 3);
  assert.equal(runRecords().length, limit);

  const second = await processWorkflowSchedules(new Date(ANCHOR_MS + 10 * HOUR + 5 * 60_000 + 15_000));
  assert.equal(second.fired.length, 3);
  assert.equal(second.deferred.length, 0);
  assert.equal(runRecords().length, limit + 3);
});
