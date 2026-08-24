/** Run: node scripts/run-tests-isolated.mjs src/execution/workflow-recurring-read-admission.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-recurring-read-admission-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const control = await import('./automation-recurrence-control-plane.js');
const admissions = await import('./workflow-recurring-read-admission.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const plans = await import('../memory/workflow-node-invocation-plan.js');
const intervals = await import('../shared/workflow-interval.js');
const definitions = await import('./workflow-run-definition.js');
const runner = await import('./workflow-runner.js');
import type { WorkflowDefinition } from '../memory/workflow-store.js';
import type { PendingApprovalRow } from '../runtime/harness/approval-registry.js';
import type { WorkflowRunDefinitionSnapshot } from './workflow-run-definition.js';

const digest = (label: string): string => createHash('sha256').update(label, 'utf8').digest('hex');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

let sequence = 0;

function activeFixture() {
  sequence += 1;
  const label = `record-${sequence}`;
  const workflowId = `workflow.${label}`;
  const plan = plans.createWorkflowNodeInvocationPlan({
    requirementId: `requirement.${label}`,
    logicalCapabilityId: `logical.${label}`,
    binding: {
      capabilityId: `capability.${label}`,
      manifestId: `manifest.${label}`,
      manifestDigest: digest(`manifest-${label}`),
      operationId: `operation.${label}`,
      operationVersion: '1',
      schemaDigest: digest(`schema-${label}`),
      providerVersion: '1',
      liveFingerprint: digest(`live-${label}`),
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
    name: workflowId,
    description: 'Exact provider-neutral recurring read.',
    description_body: 'Exact provider-neutral recurring read.',
    enabled: false,
    trigger: { manual: true },
    allowedTools: [],
    inputs: { scope: { type: 'string', required: true } },
    steps: [{
      id: 'read-records',
      prompt: '',
      sideEffect: 'read',
      allowedTools: [],
      invocationPlan: plan,
    }],
  };
  const authoritySnapshot = {
    version: 1 as const,
    capabilitySnapshotDigest: digest(`capability-snapshot-${label}`),
    accountSnapshotDigest: digest(`account-snapshot-${label}`),
    schemaSnapshotDigest: digest(`schema-snapshot-${label}`),
    bindingSnapshotDigest: digest(`binding-snapshot-${label}`),
    controlContractDigest: digest(`control-${label}`),
  };
  const workflowInputs = { scope: `scope.${label}` };
  const pilotSuccess = control.createAutomationRecurrencePilotSuccessEvidence({
    version: 1,
    proposalId: `proposal.${label}`,
    proposalRevision: 1,
    proposalDigest: digest(`proposal-${label}`),
    workflowId,
    workflowRevision: 1,
    workflowDigest: definitions.workflowDefinitionHash(sourceDefinition),
    nodeId: 'read-records',
    invocationPlanDigest: plan.bindingDigest,
    workflowInputs,
    workflowInputsDigest: digest(JSON.stringify(workflowInputs)),
    pilotCompilationDigest: digest(`compilation-${label}`),
    pilotAuthorizationRef: `approval.pilot.${label}`,
    pilotAuthorizationDigest: digest(`pilot-approval-${label}`),
    runId: `run.pilot.${label}`,
    runOccurrenceId: `occurrence.pilot.${label}`,
    triggerReceiptId: `trigger.pilot.${label}`,
    triggerReceiptDigest: digest(`trigger-${label}`),
    terminalReceiptId: `terminal.pilot.${label}`,
    terminalReceiptDigest: digest(`terminal-${label}`),
    status: 'completed',
    terminalOutcome: 'succeeded',
    needsAttention: false,
    finishedAt: '2026-08-22T10:00:00.000Z',
    resultAuthority: {
      version: 1,
      kind: 'closed_read',
      receiptId: `closed-read.${label}`,
      receiptDigest: digest(`closed-read-${label}`),
      acceptedSourceCount: 2,
    },
    settlement: {
      version: 1,
      clean: true,
      receiptId: `settlement.${label}`,
      receiptDigest: digest(`settlement-${label}`),
      reasons: [],
    },
    selectedSuccessCriterionIds: ['criterion.complete'],
    criterionEvidence: [{
      criterionId: 'criterion.complete',
      outcome: 'met',
      evidenceRef: `evidence.complete.${label}`,
      evidenceDigest: digest(`criterion-${label}`),
    }],
    authoritySnapshot,
  });
  const preview = control.createAutomationRecurrencePreview({
    pilotSuccess,
    workflowSlug: workflowId,
    sourceDefinition,
    cadence: { every: 3, unit: 'hour', overlapPolicy: 'queue_one', catchUpPolicy: 'skip' },
    previewedAt: '2026-08-22T10:00:20.000Z',
  });
  const request = control.createAutomationRecurrenceConsentRequest({
    preview,
    approvalSessionId: `chat.${label}`,
  });
  const registered = control.registerAutomationRecurrenceActivation({
    pilotSuccess,
    preview,
    consentRequest: request,
    at: '2026-08-22T10:01:00.000Z',
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) throw new Error(registered.reason);
  const approval: PendingApprovalRow = {
    approvalId: `approval.recurrence.${label}`,
    sessionId: request.approvalSessionId,
    channel: 'desktop',
    channelId: null,
    requestedAt: '2026-08-22T10:02:00.000Z',
    expiresAt: '2026-08-23T10:02:00.000Z',
    subject: request.subject,
    tool: request.tool,
    args: request.args,
    status: 'resolved',
    resolution: 'approved',
    resolver: 'human.owner',
    resolvedAt: '2026-08-22T10:03:00.000Z',
    resumeKey: request.resumeKey,
    consumedAt: null,
    presentation: null,
  };
  const bound = control.bindAutomationRecurrenceConsentApproval({
    activationId: registered.state.activationId,
    approval,
    at: '2026-08-22T10:03:00.000Z',
  });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  const ready = control.reconcileAutomationRecurrenceActivation({
    activationId: registered.state.activationId,
    approval,
    currentDefinition: sourceDefinition,
    at: '2026-08-22T10:04:00.000Z',
  });
  assert.equal(ready.ok && ready.state, 'ready_to_install');
  if (!ready.ok || ready.state !== 'ready_to_install') throw new Error('recurrence not ready');
  const active = control.reconcileAutomationRecurrenceActivation({
    activationId: registered.state.activationId,
    currentDefinition: ready.installation.authorizedDefinition,
    at: '2026-08-22T10:05:00.000Z',
  });
  assert.equal(active.ok && active.state, 'active');
  if (!active.ok || active.state !== 'active') throw new Error('recurrence not active');
  const snapshot: WorkflowRunDefinitionSnapshot = {
    version: 1,
    workflowSlug: workflowId,
    definitionHash: definitions.workflowDefinitionHash(ready.installation.authorizedDefinition),
    admittedAt: '2026-08-22T13:01:00.000Z',
    definition: ready.installation.authorizedDefinition,
  };
  return {
    label,
    workflowId,
    activationId: registered.state.activationId,
    authoritySnapshot,
    preview,
    active,
    snapshot,
    workflowInputs,
  };
}

test('one exact interval occurrence receives standing activation lineage and resolves byte-for-byte', () => {
  const fixture = activeFixture();
  const created = admissions.createWorkflowRecurringReadAdmission({
    activationId: fixture.activationId,
    runId: `run.interval.${fixture.label}`,
    occurrenceOrdinal: 1,
    nodeAttempt: 1,
    snapshot: fixture.snapshot,
    currentAuthoritySnapshot: fixture.authoritySnapshot,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const admission = created.admission;
  assert.equal(admission.activationAuthority.activationId, fixture.activationId);
  assert.equal(admission.runOccurrenceId, intervals.workflowIntervalOccurrenceId({
    workflowKey: fixture.workflowId,
    interval: fixture.preview.interval,
    ordinal: 1,
  }));
  assert.equal(admission.occurrenceAt, fixture.preview.firstFireAt);
  assert.equal(admission.workflowDigest, fixture.preview.authorizedEnabledDefinitionHash);
  assert.equal(admission.workflowInputsDigest, fixture.preview.workflowInputsDigest);
  assert.equal(admission.bindingSnapshotDigest, fixture.authoritySnapshot.bindingSnapshotDigest);
  assert.equal(admission.controlDigest, fixture.authoritySnapshot.controlContractDigest);

  const resolved = admissions.resolveWorkflowRecurringReadAdmission({
    value: admission,
    runId: admission.runId,
    snapshot: fixture.snapshot,
    currentAuthoritySnapshot: fixture.authoritySnapshot,
  });
  assert.deepEqual(resolved, created);

  const secondAttempt = admissions.createWorkflowRecurringReadAdmission({
    activationId: fixture.activationId,
    runId: admission.runId,
    occurrenceOrdinal: 1,
    nodeAttempt: 2,
    snapshot: fixture.snapshot,
    currentAuthoritySnapshot: fixture.authoritySnapshot,
  });
  assert.equal(secondAttempt.ok, true);
  if (secondAttempt.ok) assert.notEqual(secondAttempt.admission.workflowSessionId, admission.workflowSessionId);
});

test('capability, account, schema, binding, and control drift all fail closed before queue authority', () => {
  const fixture = activeFixture();
  for (const key of [
    'capabilitySnapshotDigest',
    'accountSnapshotDigest',
    'schemaSnapshotDigest',
    'bindingSnapshotDigest',
    'controlContractDigest',
  ] as const) {
    const created = admissions.createWorkflowRecurringReadAdmission({
      activationId: fixture.activationId,
      runId: `run.drift.${fixture.label}.${key}`,
      occurrenceOrdinal: 1,
      nodeAttempt: 1,
      snapshot: fixture.snapshot,
      currentAuthoritySnapshot: { ...fixture.authoritySnapshot, [key]: digest(`drift-${key}`) },
    });
    assert.equal(created.ok, false, `${key} drift was admitted`);
    if (!created.ok) assert.match(created.reason, /authority drifted/);
  }
});

test('definition and interval revision drift cannot reuse prior consent', () => {
  const fixture = activeFixture();
  const driftedDefinition: WorkflowDefinition = {
    ...fixture.snapshot.definition,
    description: 'Changed after recurrence consent.',
  };
  const driftedSnapshot: WorkflowRunDefinitionSnapshot = {
    ...fixture.snapshot,
    definition: driftedDefinition,
    definitionHash: definitions.workflowDefinitionHash(driftedDefinition),
  };
  const changed = admissions.createWorkflowRecurringReadAdmission({
    activationId: fixture.activationId,
    runId: `run.definition-drift.${fixture.label}`,
    occurrenceOrdinal: 1,
    nodeAttempt: 1,
    snapshot: driftedSnapshot,
    currentAuthoritySnapshot: fixture.authoritySnapshot,
  });
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.match(changed.reason, /does not match/);

  const intervalDrift: WorkflowDefinition = {
    ...fixture.snapshot.definition,
    trigger: {
      interval: { ...fixture.preview.interval, every: fixture.preview.interval.every + 1 },
    },
  };
  const intervalSnapshot: WorkflowRunDefinitionSnapshot = {
    ...fixture.snapshot,
    definition: intervalDrift,
    definitionHash: definitions.workflowDefinitionHash(intervalDrift),
  };
  const intervalChanged = admissions.createWorkflowRecurringReadAdmission({
    activationId: fixture.activationId,
    runId: `run.interval-drift.${fixture.label}`,
    occurrenceOrdinal: 1,
    nodeAttempt: 1,
    snapshot: intervalSnapshot,
    currentAuthoritySnapshot: fixture.authoritySnapshot,
  });
  assert.equal(intervalChanged.ok, false);
});

test('serialized occurrence, run, digest, and active-state tampering never resolve', () => {
  const fixture = activeFixture();
  const created = admissions.createWorkflowRecurringReadAdmission({
    activationId: fixture.activationId,
    runId: `run.tamper.${fixture.label}`,
    occurrenceOrdinal: 2,
    nodeAttempt: 1,
    snapshot: fixture.snapshot,
    currentAuthoritySnapshot: fixture.authoritySnapshot,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  for (const candidate of [
    { ...created.admission, occurrenceOrdinal: 1 },
    { ...created.admission, runId: `run.foreign.${fixture.label}` },
    { ...created.admission, workflowInputsDigest: digest('forged-inputs') },
    { ...created.admission, admissionDigest: digest('forged-admission') },
    {
      ...created.admission,
      activationAuthority: {
        ...created.admission.activationAuthority,
        activationStateDigest: digest('forged-state'),
      },
    },
  ]) {
    const resolved = admissions.resolveWorkflowRecurringReadAdmission({
      value: candidate,
      runId: created.admission.runId,
      snapshot: fixture.snapshot,
      currentAuthoritySnapshot: fixture.authoritySnapshot,
    });
    assert.equal(resolved.ok, false);
  }
});

test('an active receipt becomes immediately inert when definition reconciliation records drift', () => {
  const fixture = activeFixture();
  const refused = control.reconcileAutomationRecurrenceActivation({
    activationId: fixture.activationId,
    currentDefinition: { ...fixture.snapshot.definition, description: 'Drifted live bytes.' },
    at: '2026-08-22T10:06:00.000Z',
  });
  assert.equal(refused.ok && refused.state, 'refused');
  const created = admissions.createWorkflowRecurringReadAdmission({
    activationId: fixture.activationId,
    runId: `run.after-refusal.${fixture.label}`,
    occurrenceOrdinal: 1,
    nodeAttempt: 1,
    snapshot: fixture.snapshot,
    currentAuthoritySnapshot: fixture.authoritySnapshot,
  });
  assert.equal(created.ok, false);
  if (!created.ok) assert.match(created.reason, /not exactly active/);
});

test('runner re-resolves standing authority and exact inputs before any recurring step can execute', () => {
  const fixture = activeFixture();
  const runId = `run.runner.${fixture.label}`;
  const created = admissions.createWorkflowRecurringReadAdmission({
    activationId: fixture.activationId,
    runId,
    occurrenceOrdinal: 1,
    nodeAttempt: 1,
    snapshot: fixture.snapshot,
    currentAuthoritySnapshot: fixture.authoritySnapshot,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const workflowEntry = {
    name: fixture.workflowId,
    dir: '/test/workflow',
    filePath: '/test/workflow/SKILL.md',
    layout: 'directory' as const,
    data: fixture.snapshot.definition,
  };
  const baseRun = {
    id: runId,
    workflow: fixture.workflowId,
    workflowSlug: fixture.workflowId,
    inputs: fixture.workflowInputs,
    workflowDefinitionSnapshot: fixture.snapshot,
    source: 'schedule',
    triggerReceiptId: created.admission.runOccurrenceId,
    workflowRecurringReadAdmission: created.admission,
  };
  const authorityResolver = () => ({ ok: true as const, snapshot: fixture.authoritySnapshot });
  const admitted = runner.resolveWorkflowDefinitionForRun(
    baseRun,
    [workflowEntry],
    authorityResolver,
  );
  assert.equal(admitted.ok, true, admitted.error);
  assert.deepEqual(admitted.workflowRecurringReadAdmission, created.admission);

  const inputDrift = runner.resolveWorkflowDefinitionForRun(
    { ...baseRun, inputs: { scope: 'foreign-scope' } },
    [workflowEntry],
    authorityResolver,
  );
  assert.equal(inputDrift.ok, false);
  assert.match(inputDrift.error ?? '', /inputs/);

  const replayLineage = runner.resolveWorkflowDefinitionForRun(
    { ...baseRun, selfHealAttempt: 1 },
    [workflowEntry],
    authorityResolver,
  );
  assert.equal(replayLineage.ok, false);
  assert.match(replayLineage.error ?? '', /recovery controls/);
});
