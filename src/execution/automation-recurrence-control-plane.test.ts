/** Run: node scripts/run-tests-isolated.mjs src/execution/automation-recurrence-control-plane.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-recurrence-control-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const control = await import('./automation-recurrence-control-plane.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const plans = await import('../memory/workflow-node-invocation-plan.js');
const projections = await import('../memory/workflow-result-projection-contract.js');
const workspaceBindings = await import('../spaces/canonical-entity-workspace-binding-contract.js');
const definitions = await import('./workflow-run-definition.js');
const runtime = await import('./automation-recurrence-runtime.js');
const scheduler = await import('./workflow-scheduler.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const workflowStore = await import('../memory/workflow-store.js');
import type { WorkflowDefinition } from '../memory/workflow-store.js';
import type { PendingApprovalRow } from '../runtime/harness/approval-registry.js';

const digest = (label: string): string => createHash('sha256').update(label, 'utf8').digest('hex');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

let fixtureSequence = 0;

function recurrenceFixture(options: {
  dataset?: boolean;
  label?: string;
  previewedAt?: string;
  workflowId?: string;
} = {}) {
  fixtureSequence += 1;
  const label = options.label ?? `alpha-${fixtureSequence}`;
  const workflowId = options.workflowId ?? `workflow.${label}`;
  const resultProjection = options.dataset
    ? projections.createWorkflowCanonicalEntityResultProjection({
        recordsPath: 'records',
        fields: [{
          field: 'key',
          recordPath: 'key',
          type: 'string',
          required: true,
          sensitivity: 'public',
          confidence: 1,
        }],
        sourceRecord: { idPath: 'key', observedAt: { kind: 'page_settled_at' } },
        entityKind: 'record',
        identityRules: [{
          ruleId: 'by-key',
          fields: ['key'],
          normalizers: ['trim'],
          exactIdentifierNamespace: 'record-key',
        }],
        resolutionPolicy: {
          policyId: 'exact-record-key',
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
          maxRecordsPerPage: 20,
          maxRecords: 20,
          maxPageBytes: 100_000,
          maxRecordBytes: 10_000,
          maxTotalBytes: 100_000,
        },
      })
    : undefined;
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
    ...(resultProjection ? { resultProjection } : {}),
  });
  const sourceDefinition: WorkflowDefinition = {
    name: workflowId,
    description: 'Provider-neutral exact read recurrence.',
    description_body: 'Provider-neutral exact read recurrence.',
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
  const workspaceBinding = resultProjection
    ? workspaceBindings.createCanonicalEntityWorkspaceBindingApproval({
        selection: {
          version: 1,
          workspaceId: `workspace.${label}`,
          expectedWorkspaceRevision: 1,
          expectedWorkspaceDigest: digest(`workspace-${label}`),
          bindingId: `binding.${label}`,
          role: 'primary',
        },
        workflowId,
        at: '2026-08-22T12:00:00.000Z',
      })
    : undefined;
  const authoritySnapshot = {
    version: 1 as const,
    capabilitySnapshotDigest: digest(`capability-snapshot-${label}`),
    accountSnapshotDigest: digest(`account-snapshot-${label}`),
    schemaSnapshotDigest: digest(`schema-snapshot-${label}`),
    bindingSnapshotDigest: digest(`binding-snapshot-${label}`),
    controlContractDigest: digest(`control-${label}`),
    ...(workspaceBinding ? { workspaceBindingDigest: workspaceBinding.bindingDigest } : {}),
  };
  const workflowInputs = { scope: `scope.${label}` };
  const pilotSuccess = control.createAutomationRecurrencePilotSuccessEvidence({
    version: 1,
    proposalId: `proposal.${label}`,
    proposalRevision: 2,
    proposalDigest: digest(`proposal-${label}`),
    workflowId,
    workflowRevision: 2,
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
    finishedAt: '2026-08-22T12:00:00.000Z',
    resultAuthority: {
      version: 1,
      kind: 'closed_read',
      receiptId: `closed-read.${label}`,
      receiptDigest: digest(`closed-read-${label}`),
      acceptedSourceCount: 3,
    },
    ...(resultProjection ? {
      projectionAuthority: {
        version: 1 as const,
        receiptId: `projection.${label}`,
        receiptDigest: digest(`projection-${label}`),
        coverage: 'closed' as const,
      },
    } : {}),
    settlement: {
      version: 1,
      clean: true,
      receiptId: `settlement.${label}`,
      receiptDigest: digest(`settlement-${label}`),
      reasons: [],
    },
    selectedSuccessCriterionIds: ['criterion.complete', 'criterion.provenance'],
    criterionEvidence: [{
      criterionId: 'criterion.complete',
      outcome: 'met',
      evidenceRef: `evidence.complete.${label}`,
      evidenceDigest: digest(`criterion-complete-${label}`),
    }, {
      criterionId: 'criterion.provenance',
      outcome: 'met',
      evidenceRef: `evidence.provenance.${label}`,
      evidenceDigest: digest(`criterion-provenance-${label}`),
    }],
    authoritySnapshot,
    ...(workspaceBinding ? { workspaceBinding } : {}),
  });
  const preview = control.createAutomationRecurrencePreview({
    pilotSuccess,
    workflowSlug: workflowId,
    sourceDefinition,
    cadence: { every: 2, unit: 'hour', overlapPolicy: 'skip', catchUpPolicy: 'run_once' },
    previewedAt: options.previewedAt ?? '2026-08-22T12:00:30.000Z',
  });
  const request = control.createAutomationRecurrenceConsentRequest({
    preview,
    approvalSessionId: `chat.${label}`,
  });
  return { label, workflowId, plan, sourceDefinition, workspaceBinding, authoritySnapshot, pilotSuccess, preview, request };
}

function approvalFor(
  fixture: ReturnType<typeof recurrenceFixture>,
  status: 'pending' | 'approved' | 'rejected' = 'pending',
): PendingApprovalRow {
  const resolved = status !== 'pending';
  return {
    approvalId: `approval.recurrence.${fixture.label}`,
    sessionId: fixture.request.approvalSessionId,
    channel: 'desktop',
    channelId: null,
    requestedAt: '2026-08-22T12:02:00.000Z',
    expiresAt: '2026-08-23T12:02:00.000Z',
    subject: fixture.request.subject,
    tool: fixture.request.tool,
    args: fixture.request.args,
    status: resolved ? 'resolved' : 'pending',
    resolution: status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : null,
    resolver: resolved ? 'human.owner' : null,
    resolvedAt: resolved ? '2026-08-22T12:03:00.000Z' : null,
    resumeKey: fixture.request.resumeKey,
    consumedAt: null,
    presentation: null,
  };
}

function registerAndBind(fixture: ReturnType<typeof recurrenceFixture>, approval: PendingApprovalRow) {
  const registered = control.registerAutomationRecurrenceActivation({
    pilotSuccess: fixture.pilotSuccess,
    preview: fixture.preview,
    consentRequest: fixture.request,
    at: '2026-08-22T12:01:00.000Z',
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) throw new Error(registered.reason);
  const bound = control.bindAutomationRecurrenceConsentApproval({
    activationId: registered.state.activationId,
    approval,
    at: '2026-08-22T12:02:00.000Z',
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) throw new Error(bound.reason);
  return { registered, bound };
}

test('pilot success is non-vacuous, exact-criteria evidence and projects to the existing bridge shape', () => {
  const fixture = recurrenceFixture({ dataset: true });
  const parsed = control.parseAutomationRecurrencePilotSuccessEvidence(fixture.pilotSuccess);
  assert.equal(parsed.ok, true);
  const projected = control.automationPilotSuccessEvidenceForBridge(fixture.pilotSuccess);
  assert.equal(projected.evidenceRef, fixture.pilotSuccess.evidenceId);
  assert.equal(projected.pilotBindingSnapshotDigest, fixture.authoritySnapshot.bindingSnapshotDigest);
  assert.equal(projected.terminalReceiptDigest, fixture.pilotSuccess.terminalReceiptDigest);

  assert.throws(() => control.createAutomationRecurrencePilotSuccessEvidence({
    ...fixture.pilotSuccess,
    resultAuthority: { ...fixture.pilotSuccess.resultAuthority, acceptedSourceCount: 0 },
  }), /non-vacuous/);
  assert.throws(() => control.createAutomationRecurrencePilotSuccessEvidence({
    ...fixture.pilotSuccess,
    selectedSuccessCriterionIds: ['criterion.complete'],
  }), /cover every selected criterion exactly once/);
  assert.throws(() => control.createAutomationRecurrencePilotSuccessEvidence({
    ...fixture.pilotSuccess,
    settlement: { ...fixture.pilotSuccess.settlement, clean: true, reasons: ['contradiction'] } as never,
  }), /exactly clean/);
});

test('disabled preview deterministically fixes anchor, first fire, effects, Workspace, and no active claim', () => {
  const fixture = recurrenceFixture({ dataset: true });
  assert.equal(fixture.preview.interval.anchorAt, '2026-08-22T12:01:00.000Z');
  assert.equal(fixture.preview.firstFireAt, '2026-08-22T14:01:00.000Z');
  assert.equal(fixture.preview.reviewedDisabledDefinition.enabled, false);
  assert.equal(fixture.preview.authorizedEnabledDefinition.enabled, true);
  assert.equal(control.parseAutomationRecurrencePreview(fixture.preview).ok, true);
  assert.equal(fixture.request.args.effect, 'read');
  assert.equal(fixture.request.args.externalWrites, false);
  assert.equal(fixture.request.args.sends, false);
  assert.deepEqual(fixture.request.args.workspaceBinding, fixture.workspaceBinding);
  assert.match(fixture.request.subject, /read-only/);
  assert.doesNotMatch(fixture.request.subject, /currently running|already active/i);
  assert.equal(
    control.createAutomationRecurrenceConsentRequest({
      preview: fixture.preview,
      approvalSessionId: fixture.request.approvalSessionId,
    }).requestDigest,
    fixture.request.requestDigest,
  );
});

test('register -> separate card -> approval -> receipt -> install is replay and crash convergent', () => {
  const fixture = recurrenceFixture({ dataset: true });
  const pendingApproval = approvalFor(fixture);
  const { registered, bound } = registerAndBind(fixture, pendingApproval);
  assert.equal(registered.inserted, true);
  assert.equal(registered.state.status, 'registering');
  assert.equal(bound.state.status, 'approval_pending');

  const replayRegistration = control.registerAutomationRecurrenceActivation({
    pilotSuccess: fixture.pilotSuccess,
    preview: fixture.preview,
    consentRequest: fixture.request,
    at: '2026-08-22T12:01:00.000Z',
  });
  assert.equal(replayRegistration.ok && replayRegistration.inserted, false);
  const replayBinding = control.bindAutomationRecurrenceConsentApproval({
    activationId: registered.state.activationId,
    approval: pendingApproval,
    at: '2026-08-22T12:02:00.000Z',
  });
  assert.equal(replayBinding.ok && replayBinding.replayed, true);

  const pending = control.reconcileAutomationRecurrenceActivation({
    activationId: registered.state.activationId,
    approval: pendingApproval,
    currentDefinition: fixture.sourceDefinition,
    at: '2026-08-22T12:02:30.000Z',
  });
  assert.equal(pending.ok && pending.state, 'pending');

  const approved = approvalFor(fixture, 'approved');
  const ready = control.reconcileAutomationRecurrenceActivation({
    activationId: registered.state.activationId,
    approval: approved,
    currentDefinition: fixture.sourceDefinition,
    at: '2026-08-22T12:03:30.000Z',
  });
  assert.equal(ready.ok && ready.state, 'ready_to_install');
  if (!ready.ok || ready.state !== 'ready_to_install') throw new Error('activation not ready');
  assert.equal(ready.activation.status, 'activating');
  assert.equal(ready.receipt.consent.approvalId, approved.approvalId);
  assert.deepEqual(ready.receipt.workspaceBinding, fixture.workspaceBinding);
  assert.equal(
    control.getAutomationRecurrenceActivationReceipt(registered.state.activationId)?.receiptId,
    ready.receipt.receiptId,
  );

  // Crash after receipt commit but before definition CAS: exact reconciliation
  // returns the same install unit and cannot mint another receipt.
  const receiptReplay = control.reconcileAutomationRecurrenceActivation({
    activationId: registered.state.activationId,
    currentDefinition: fixture.sourceDefinition,
    at: '2026-08-22T12:04:00.000Z',
  });
  assert.equal(receiptReplay.ok && receiptReplay.state, 'ready_to_install');
  if (!receiptReplay.ok || receiptReplay.state !== 'ready_to_install') throw new Error('receipt replay failed');
  assert.equal(receiptReplay.receipt.receiptId, ready.receipt.receiptId);

  // Crash after the exact CAS but before the active marker: boot observes the
  // authorized hash and converges the state without rewriting the workflow.
  const active = control.reconcileAutomationRecurrenceActivation({
    activationId: registered.state.activationId,
    currentDefinition: ready.installation.authorizedDefinition,
    at: '2026-08-22T12:05:00.000Z',
  });
  assert.equal(active.ok && active.state, 'active');
  if (!active.ok || active.state !== 'active') throw new Error('activation did not converge');
  assert.equal(active.activation.installedDefinitionHash, fixture.preview.authorizedEnabledDefinitionHash);
  assert.equal(active.authority.activationReceiptDigest, ready.receipt.receiptDigest);
  assert.deepEqual(
    control.getActiveAutomationRecurrenceForWorkflow(fixture.workflowId)?.authority,
    active.authority,
  );

  const replayActive = control.reconcileAutomationRecurrenceActivation({
    activationId: registered.state.activationId,
    currentDefinition: ready.installation.authorizedDefinition,
    at: '2026-08-22T12:06:00.000Z',
  });
  assert.equal(replayActive.ok && replayActive.state, 'active');
  assert.equal(control.listAutomationRecurrenceActivationsForReconciliation().filter(
    (state) => state.activationId === registered.state.activationId,
  ).length, 1);
});

test('boot/tick reconciliation repairs the formal card, listener installs once after approval, and replay is idempotent', () => {
  const fixture = recurrenceFixture();
  workflowStore.writeWorkflow(fixture.workflowId, fixture.sourceDefinition);
  eventlog.createSession({
    id: fixture.request.approvalSessionId,
    kind: 'chat',
    channel: 'desktop',
    title: 'Recurrence consent test',
  });
  const registered = control.registerAutomationRecurrenceActivation({
    pilotSuccess: fixture.pilotSuccess,
    preview: fixture.preview,
    consentRequest: fixture.request,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) return;

  const repaired = runtime.reconcileAutomationRecurrences();
  assert.equal(repaired.repairedCards, 1);
  assert.equal(repaired.pending, 1);
  const pending = control.getAutomationRecurrenceActivation(registered.state.activationId);
  assert.equal(pending?.status, 'approval_pending');
  const approval = pending?.approvalId ? approvalRegistry.get(pending.approvalId) : undefined;
  assert.ok(approval);
  assert.equal(approval?.tool, control.AUTOMATION_RECURRENCE_CONSENT_TOOL);
  assert.equal(approval?.resumeKey, fixture.request.resumeKey);
  assert.equal(
    eventlog.listEvents(fixture.request.approvalSessionId)
      .filter((event) => event.type === 'approval_requested').length,
    1,
  );

  runtime.installAutomationRecurrenceReconciler();
  const resolved = approvalRegistry.resolve(approval!.approvalId, 'approved', 'human.owner');
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(
    workflowStore.readWorkflow(fixture.workflowId)?.data.enabled,
    true,
    'the approval listener reconciles the exact receipt and installs before returning',
  );
  assert.ok(control.getAutomationRecurrenceActivationReceipt(registered.state.activationId));

  // A later boot/tick observes the listener-completed state and performs no
  // second definition write, card registration, or authority mint.
  const installed = runtime.reconcileAutomationRecurrences();
  assert.equal(installed.installed, 0);
  assert.equal(installed.active, 1);

  const replay = runtime.reconcileAutomationRecurrences();
  assert.equal(replay.installed, 0);
  assert.equal(replay.active, 1);
  assert.equal(
    eventlog.listEvents(fixture.request.approvalSessionId)
      .filter((event) => event.type === 'approval_requested').length,
    1,
  );
});

test('foreign formal consent never binds and a rejection is terminally inert', () => {
  const fixture = recurrenceFixture();
  const pending = approvalFor(fixture);
  const registered = control.registerAutomationRecurrenceActivation({
    pilotSuccess: fixture.pilotSuccess,
    preview: fixture.preview,
    consentRequest: fixture.request,
    at: '2026-08-22T13:00:00.000Z',
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) return;
  const foreign = control.bindAutomationRecurrenceConsentApproval({
    activationId: registered.state.activationId,
    approval: { ...pending, args: { ...pending.args, workflowId: 'workflow.foreign' } },
    at: '2026-08-22T13:01:00.000Z',
  });
  assert.equal(foreign.ok, false);
  assert.equal(control.getAutomationRecurrenceActivation(registered.state.activationId)?.status, 'registering');

  const bound = control.bindAutomationRecurrenceConsentApproval({
    activationId: registered.state.activationId,
    approval: pending,
    at: '2026-08-22T13:01:00.000Z',
  });
  assert.equal(bound.ok, true);
  const rejected = control.reconcileAutomationRecurrenceActivation({
    activationId: registered.state.activationId,
    approval: approvalFor(fixture, 'rejected'),
    currentDefinition: fixture.sourceDefinition,
    at: '2026-08-22T13:02:00.000Z',
  });
  assert.equal(rejected.ok && rejected.state, 'refused');
  if (rejected.ok) assert.equal(rejected.activation.refusalCode, 'consent_not_approved');
  assert.equal(control.getAutomationRecurrenceActivationReceipt(registered.state.activationId), null);
});

test('a historically persisted approval resolved after expiry cannot mint or install recurrence authority', () => {
  const fixture = recurrenceFixture();
  const lateApproval: PendingApprovalRow = {
    ...approvalFor(fixture, 'approved'),
    resolvedAt: '2026-08-23T12:02:00.001Z',
  };
  const { registered } = registerAndBind(fixture, lateApproval);
  assert.equal(
    control.automationRecurrenceConsentDecisionDigest({
      approval: lateApproval,
      request: fixture.request,
    }),
    null,
  );
  const reconciled = control.reconcileAutomationRecurrenceActivation({
    activationId: registered.state.activationId,
    approval: lateApproval,
    currentDefinition: fixture.sourceDefinition,
    at: '2026-08-23T12:03:00.000Z',
  });
  assert.equal(reconciled.ok && reconciled.state, 'refused');
  if (reconciled.ok) assert.equal(reconciled.activation.refusalCode, 'consent_outside_lifetime');
  assert.equal(control.getAutomationRecurrenceActivationReceipt(registered.state.activationId), null);
  assert.equal(control.getAutomationRecurrenceActiveAuthority(registered.state.activationId), null);
});

test('definition drift before or after consent never inherits standing authority', () => {
  const before = recurrenceFixture();
  const beforeApproval = approvalFor(before, 'approved');
  const beforeState = registerAndBind(before, beforeApproval).registered.state;
  const driftedBefore = { ...before.sourceDefinition, description: 'Changed after review.' };
  const refusedBefore = control.reconcileAutomationRecurrenceActivation({
    activationId: beforeState.activationId,
    approval: beforeApproval,
    currentDefinition: driftedBefore,
    at: '2026-08-22T14:00:00.000Z',
  });
  assert.equal(refusedBefore.ok && refusedBefore.state, 'refused');
  if (refusedBefore.ok) assert.equal(refusedBefore.activation.refusalCode, 'definition_drifted_before_activation');

  const after = recurrenceFixture();
  const afterApproval = approvalFor(after, 'approved');
  const afterState = registerAndBind(after, afterApproval).registered.state;
  const ready = control.reconcileAutomationRecurrenceActivation({
    activationId: afterState.activationId,
    approval: afterApproval,
    currentDefinition: after.sourceDefinition,
    at: '2026-08-22T14:01:00.000Z',
  });
  assert.equal(ready.ok && ready.state, 'ready_to_install');
  if (!ready.ok || ready.state !== 'ready_to_install') return;
  const active = control.reconcileAutomationRecurrenceActivation({
    activationId: afterState.activationId,
    currentDefinition: ready.installation.authorizedDefinition,
    at: '2026-08-22T14:02:00.000Z',
  });
  assert.equal(active.ok && active.state, 'active');
  const driftedAfter = { ...ready.installation.authorizedDefinition, description: 'Changed after consent.' };
  const refusedAfter = control.reconcileAutomationRecurrenceActivation({
    activationId: afterState.activationId,
    currentDefinition: driftedAfter,
    at: '2026-08-22T14:03:00.000Z',
  });
  assert.equal(refusedAfter.ok && refusedAfter.state, 'refused');
  if (refusedAfter.ok) assert.equal(refusedAfter.activation.refusalCode, 'definition_revision_drifted');
  assert.equal(control.getAutomationRecurrenceActiveAuthority(afterState.activationId), null);
});

test('registering plus a missing workflow refuses before creating a ghost approval and releases uniqueness', () => {
  const fixture = recurrenceFixture({ label: 'registering-workflow-missing' });
  workflowStore.writeWorkflow(fixture.workflowId, fixture.sourceDefinition);
  assert.equal(workflowStore.deleteWorkflow(fixture.workflowId), true);
  eventlog.createSession({
    id: fixture.request.approvalSessionId,
    kind: 'chat',
    channel: 'desktop',
    title: 'Missing recurrence registration',
  });
  const registered = control.registerAutomationRecurrenceActivation({
    pilotSuccess: fixture.pilotSuccess,
    preview: fixture.preview,
    consentRequest: fixture.request,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) return;

  const converged = runtime.reconcileAutomationRecurrences();
  const refused = control.getAutomationRecurrenceActivation(registered.state.activationId);
  assert.ok(converged.refused >= 1);
  assert.equal(refused?.status, 'refused');
  assert.equal(refused?.refusalCode, 'workflow_missing_or_invalid');
  assert.equal(approvalRegistry.listPending({ sessionId: fixture.request.approvalSessionId }).length, 0);
  assert.equal(
    eventlog.listEvents(fixture.request.approvalSessionId)
      .filter((event) => event.type === 'approval_requested').length,
    0,
  );

  const replacement = recurrenceFixture({
    label: 'registering-workflow-missing-replacement',
    workflowId: fixture.workflowId,
  });
  const replaced = control.registerAutomationRecurrenceActivation({
    pilotSuccess: replacement.pilotSuccess,
    preview: replacement.preview,
    consentRequest: replacement.request,
  });
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  if (replaced.ok) assert.equal(replaced.inserted, true);
});

test('a linked missing-workflow approval stays actionable only until its real expiry, then refuses', () => {
  const fixture = recurrenceFixture({ label: 'pending-workflow-missing' });
  workflowStore.writeWorkflow(fixture.workflowId, fixture.sourceDefinition);
  eventlog.createSession({
    id: fixture.request.approvalSessionId,
    kind: 'chat',
    channel: 'desktop',
    title: 'Pending recurrence expiry',
  });
  const registered = control.registerAutomationRecurrenceActivation({
    pilotSuccess: fixture.pilotSuccess,
    preview: fixture.preview,
    consentRequest: fixture.request,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) return;
  runtime.reconcileAutomationRecurrences();
  const pendingState = control.getAutomationRecurrenceActivation(registered.state.activationId);
  assert.equal(pendingState?.status, 'approval_pending');
  const approvalId = pendingState?.approvalId;
  assert.ok(approvalId);
  assert.equal(workflowStore.deleteWorkflow(fixture.workflowId), true);

  const linked = runtime.reconcileAutomationRecurrences();
  assert.ok(linked.pending >= 1);
  assert.equal(control.getAutomationRecurrenceActivation(registered.state.activationId)?.status, 'approval_pending');
  assert.equal(approvalRegistry.get(approvalId!)?.status, 'pending');

  eventlog.openEventLog().prepare(`
    UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?
  `).run(new Date(Date.now() - 1_000).toISOString(), approvalId);
  const expired = runtime.reconcileAutomationRecurrences();
  const refused = control.getAutomationRecurrenceActivation(registered.state.activationId);
  assert.ok(expired.refused >= 1);
  assert.equal(refused?.status, 'refused');
  assert.equal(refused?.refusalCode, 'workflow_missing_or_invalid');
  assert.equal(approvalRegistry.get(approvalId!)?.status, 'expired');
  assert.equal(approvalRegistry.get(approvalId!)?.resolution, 'expired');
  assert.equal(approvalRegistry.listPending({ sessionId: fixture.request.approvalSessionId }).length, 0);
});

test('an active recurrence whose workflow disappears refuses and remains scheduler-inert', async () => {
  const fixture = recurrenceFixture({ label: 'active-workflow-missing' });
  workflowStore.writeWorkflow(fixture.workflowId, fixture.sourceDefinition);
  eventlog.createSession({
    id: fixture.request.approvalSessionId,
    kind: 'chat',
    channel: 'desktop',
    title: 'Active recurrence deletion',
  });
  const registered = control.registerAutomationRecurrenceActivation({
    pilotSuccess: fixture.pilotSuccess,
    preview: fixture.preview,
    consentRequest: fixture.request,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) return;
  runtime.reconcileAutomationRecurrences();
  const pending = control.getAutomationRecurrenceActivation(registered.state.activationId);
  const approvalId = pending?.approvalId;
  assert.ok(approvalId);
  const approved = approvalRegistry.resolve(approvalId!, 'approved', 'human.owner');
  assert.equal(approved.ok, true, JSON.stringify(approved));
  runtime.reconcileAutomationRecurrences();
  assert.equal(control.getAutomationRecurrenceActivation(registered.state.activationId)?.status, 'active');
  assert.equal(workflowStore.readWorkflow(fixture.workflowId)?.data.enabled, true);

  assert.equal(workflowStore.deleteWorkflow(fixture.workflowId), true);
  const converged = runtime.reconcileAutomationRecurrences();
  const refused = control.getAutomationRecurrenceActivation(registered.state.activationId);
  assert.ok(converged.refused >= 1);
  assert.equal(refused?.status, 'refused');
  assert.equal(refused?.refusalCode, 'workflow_missing_or_invalid');
  assert.equal(control.getActiveAutomationRecurrenceForWorkflow(fixture.workflowId), null);

  const scheduled = await scheduler.processWorkflowSchedules(new Date(fixture.preview.firstFireAt));
  for (const names of [scheduled.fired, scheduled.held, scheduled.deferred, scheduled.deduped]) {
    assert.equal(names.includes(fixture.workflowId), false);
  }
});

test('a missing exact approval row durably refuses without replacement, receipt, write, or schedule', async () => {
  const fixture = recurrenceFixture({ label: 'approval-row-missing' });
  workflowStore.writeWorkflow(fixture.workflowId, fixture.sourceDefinition);
  eventlog.createSession({
    id: fixture.request.approvalSessionId,
    kind: 'chat',
    channel: 'desktop',
    title: 'Missing recurrence approval row',
  });
  const registered = control.registerAutomationRecurrenceActivation({
    pilotSuccess: fixture.pilotSuccess,
    preview: fixture.preview,
    consentRequest: fixture.request,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) return;
  runtime.reconcileAutomationRecurrences();
  const pending = control.getAutomationRecurrenceActivation(registered.state.activationId);
  assert.equal(pending?.status, 'approval_pending');
  assert.ok(pending?.approvalId);
  assert.equal(
    eventlog.listEvents(fixture.request.approvalSessionId)
      .filter((event) => event.type === 'approval_requested').length,
    1,
  );

  eventlog.openEventLog().prepare('DELETE FROM pending_approvals WHERE approval_id = ?')
    .run(pending!.approvalId);
  const beforeDefinition = workflowStore.readWorkflow(fixture.workflowId)?.data;
  const converged = runtime.reconcileAutomationRecurrences();
  const refused = control.getAutomationRecurrenceActivation(registered.state.activationId);
  assert.ok(converged.refused >= 1);
  assert.equal(refused?.status, 'refused');
  assert.equal(refused?.refusalCode, 'consent_missing_or_invalid');
  assert.equal(control.getAutomationRecurrenceActivationReceipt(registered.state.activationId), null);
  assert.deepEqual(workflowStore.readWorkflow(fixture.workflowId)?.data, beforeDefinition);
  assert.equal(approvalRegistry.listPending({ sessionId: fixture.request.approvalSessionId }).length, 0);
  assert.equal(
    eventlog.listEvents(fixture.request.approvalSessionId)
      .filter((event) => event.type === 'approval_requested').length,
    1,
    'reconciliation must not manufacture a replacement card',
  );

  const frozen = structuredClone(refused);
  eventlog.closeEventLog();
  runtime.reconcileAutomationRecurrences();
  assert.deepEqual(control.getAutomationRecurrenceActivation(registered.state.activationId), frozen);
  const scheduled = await scheduler.processWorkflowSchedules(new Date(fixture.preview.firstFireAt));
  for (const names of [scheduled.fired, scheduled.held, scheduled.deferred, scheduled.deduped]) {
    assert.equal(names.includes(fixture.workflowId), false);
  }
});

test('contradictory approval bytes durably refuse without receipt, definition write, or duplicate card', async () => {
  const fixture = recurrenceFixture({ label: 'approval-row-contradictory' });
  workflowStore.writeWorkflow(fixture.workflowId, fixture.sourceDefinition);
  eventlog.createSession({
    id: fixture.request.approvalSessionId,
    kind: 'chat',
    channel: 'desktop',
    title: 'Contradictory recurrence approval row',
  });
  const registered = control.registerAutomationRecurrenceActivation({
    pilotSuccess: fixture.pilotSuccess,
    preview: fixture.preview,
    consentRequest: fixture.request,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) return;
  runtime.reconcileAutomationRecurrences();
  const pending = control.getAutomationRecurrenceActivation(registered.state.activationId);
  assert.equal(pending?.status, 'approval_pending');
  assert.ok(pending?.approvalId);

  eventlog.openEventLog().prepare('UPDATE pending_approvals SET tool = ? WHERE approval_id = ?')
    .run('automation_recurrence_consent.contradictory', pending!.approvalId);
  const beforeDefinition = workflowStore.readWorkflow(fixture.workflowId)?.data;
  const converged = runtime.reconcileAutomationRecurrences();
  const refused = control.getAutomationRecurrenceActivation(registered.state.activationId);
  assert.ok(converged.refused >= 1);
  assert.equal(refused?.status, 'refused');
  assert.equal(refused?.refusalCode, 'consent_missing_or_invalid');
  assert.equal(control.getAutomationRecurrenceActivationReceipt(registered.state.activationId), null);
  assert.deepEqual(workflowStore.readWorkflow(fixture.workflowId)?.data, beforeDefinition);
  assert.equal(
    eventlog.listEvents(fixture.request.approvalSessionId)
      .filter((event) => event.type === 'approval_requested').length,
    1,
  );

  const frozen = structuredClone(refused);
  eventlog.closeEventLog();
  runtime.reconcileAutomationRecurrences();
  assert.deepEqual(control.getAutomationRecurrenceActivation(registered.state.activationId), frozen);
  const scheduled = await scheduler.processWorkflowSchedules(new Date(fixture.preview.firstFireAt));
  for (const names of [scheduled.fired, scheduled.held, scheduled.deferred, scheduled.deduped]) {
    assert.equal(names.includes(fixture.workflowId), false);
  }
});
