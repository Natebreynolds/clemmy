/** Run: node scripts/run-tests-isolated.mjs src/execution/automation-pilot-workspace-destination-authority.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workspace-chooser-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const chooser = await import('./automation-pilot-workspace-destination-authority.js');
const advancement = await import('./automation-pilot-advancement-control-plane.js');
const opportunities = await import('./automation-opportunity.js');
const opportunityStore = await import('./automation-opportunity-store.js');
const review = await import('./automation-opportunity-review-control-plane.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const spaces = await import('../spaces/store.js');
import type { AutomationOpportunityV1 } from './automation-opportunity.js';

let sequence = 0;
function unique(label: string): string {
  sequence += 1;
  return `${label}.${sequence}`;
}

function datasetOpportunity(label: string): AutomationOpportunityV1 {
  return opportunities.parseAutomationOpportunity({
    version: 1,
    title: `Bounded ${label} collection`,
    objective: `Collect one bounded ${label} result with exact evidence.`,
    rationale: 'A one-shot read pilot should prove the reviewed contract.',
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
        fields: [{ name: 'key', type: 'string', required: true, sensitivity: 'public' }],
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

function approvedAdvancement(label: string): advancement.AutomationPilotAdvancementProjectionV1 {
  const sessionId = unique('chat');
  eventlog.createSession({ id: sessionId, kind: 'chat' });
  const created = opportunityStore.createAutomationOpportunityProposal({
    proposalId: unique('proposal').replaceAll('.', '_'),
    opportunity: datasetOpportunity(label),
    actorRef: `accepted-source:${sessionId}#1`,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) throw new Error(created.message);
  const requested = review.registerAutomationOpportunityReviewProjection({
    proposalId: created.record.proposalId,
    expectedProposalRevision: created.record.revision,
    expectedProposalDigest: created.record.digest,
    approvalSessionId: sessionId,
    requestSourceUserSeq: 1,
  });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  if (!requested.ok) throw new Error(requested.reason);
  assert.equal(approvals.resolve(requested.approval.approvalId, 'approved', `human.${label}`).ok, true);
  const reviewed = review.reconcileAutomationOpportunityReviewProjection(requested.projection.projectionId);
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  if (!reviewed.ok) throw new Error(reviewed.reason);
  const registered = advancement.registerAutomationPilotAdvancement({
    reviewProjectionId: reviewed.projection.projectionId,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) throw new Error(registered.reason);
  assert.equal(registered.projection.stage, 'workspace_destination_required');
  return registered.projection;
}

test.afterEach(() => {
  chooser.automationPilotWorkspaceChooserInternalsForTest.setAfterAdvancementDecisionHook();
  for (const workspace of spaces.spaceStore.list(true)) spaces.spaceStore.remove(workspace.id);
});

test.after(() => {
  opportunityStore.closeAutomationOpportunityStoreForTests();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('desktop/mobile host choice resolves one exact offered Workspace without title or order inference', () => {
  spaces.spaceStore.save({ id: 'zeta-workspace', title: 'Same title' });
  spaces.spaceStore.save({ id: 'alpha-workspace', title: 'Same title' });
  const staged = approvedAdvancement('exact-choice');
  const ensured = chooser.ensureAutomationPilotWorkspaceChooser({
    advancementId: staged.advancementId,
  });
  assert.equal(ensured.ok, true, JSON.stringify(ensured));
  if (!ensured.ok) return;
  assert.equal(ensured.created, true);
  assert.equal(ensured.projection.status, 'pending');
  const existing = ensured.projection.choices.filter((choice) => choice.kind === 'existing');
  assert.equal(existing.length, 2);
  assert.equal(existing[0]?.label, existing[1]?.label, 'duplicate titles remain separate opaque choices');
  const zeta = existing.find((choice) => choice.kind === 'existing'
    && choice.workspace.workspaceId === 'zeta-workspace')!;

  const resolved = chooser.resolveAutomationPilotWorkspaceChooser({
    chooserId: ensured.projection.chooserId,
    expectedChooserRevision: ensured.projection.chooserRevision,
    expectedChooserDigest: ensured.projection.chooserDigest,
    choiceId: zeta.choiceId,
    actorRef: 'human.desktop',
  });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  if (!resolved.ok) return;
  assert.equal(resolved.projection.status, 'resolved');
  assert.equal(resolved.projection.receipt?.actorRef, 'human.desktop');
  const advanced = advancement.loadAutomationPilotAdvancement(staged.advancementId)!;
  assert.equal(advanced.stage, 'acquisition_pending');
  assert.equal(advanced.workspaceSelection?.workspaceId, 'zeta-workspace');

  const replay = chooser.resolveAutomationPilotWorkspaceChooser({
    chooserId: ensured.projection.chooserId,
    expectedChooserRevision: ensured.projection.chooserRevision,
    expectedChooserDigest: ensured.projection.chooserDigest,
    choiceId: zeta.choiceId,
    actorRef: 'human.mobile',
  });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  if (replay.ok) assert.equal(replay.alreadyResolved, true);
  assert.deepEqual(
    advancement.loadAutomationPilotAdvancement(staged.advancementId)?.workspaceDecision,
    advanced.workspaceDecision,
  );
});

test('create-new is a destination choice only and stages the separate Workspace creation card boundary', () => {
  spaces.spaceStore.save({ id: 'existing-workspace', title: 'Existing' });
  const staged = approvedAdvancement('create-choice');
  const ensured = chooser.ensureAutomationPilotWorkspaceChooser({ advancementId: staged.advancementId });
  assert.equal(ensured.ok, true, JSON.stringify(ensured));
  if (!ensured.ok) return;
  const createNew = ensured.projection.choices.find((choice) => choice.kind === 'create_new')!;
  const resolved = chooser.resolveAutomationPilotWorkspaceChooser({
    chooserId: ensured.projection.chooserId,
    expectedChooserRevision: ensured.projection.chooserRevision,
    expectedChooserDigest: ensured.projection.chooserDigest,
    choiceId: createNew.choiceId,
    actorRef: 'human.mobile',
  });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  const advanced = advancement.loadAutomationPilotAdvancement(staged.advancementId)!;
  assert.equal(advanced.stage, 'workspace_creation_pending');
  assert.equal(advanced.workspaceCreationProjectionId, undefined, 'the separate approval card is not bypassed');
  assert.equal(spaces.spaceStore.get(createNew.workspaceId), undefined, 'the choice does not create a Workspace');
});

test('unoffered, stale, and drifted chooser decisions fail closed', async (t) => {
  await t.test('unoffered opaque choice', () => {
    spaces.spaceStore.save({ id: 'offered-workspace', title: 'Offered' });
    const staged = approvedAdvancement('unoffered-choice');
    const ensured = chooser.ensureAutomationPilotWorkspaceChooser({ advancementId: staged.advancementId });
    assert.equal(ensured.ok, true, JSON.stringify(ensured));
    if (!ensured.ok) return;
    const refused = chooser.resolveAutomationPilotWorkspaceChooser({
      chooserId: ensured.projection.chooserId,
      expectedChooserRevision: ensured.projection.chooserRevision,
      expectedChooserDigest: ensured.projection.chooserDigest,
      choiceId: 'workspace-choice:not-offered',
      actorRef: 'human.desktop',
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, 'workspace_choice_not_offered');
    assert.equal(advancement.loadAutomationPilotAdvancement(staged.advancementId)?.stage, 'workspace_destination_required');
  });

  await t.test('stale chooser CAS', () => {
    spaces.spaceStore.save({ id: 'stale-workspace', title: 'Stale' });
    const staged = approvedAdvancement('stale-choice');
    const ensured = chooser.ensureAutomationPilotWorkspaceChooser({ advancementId: staged.advancementId });
    assert.equal(ensured.ok, true, JSON.stringify(ensured));
    if (!ensured.ok) return;
    const choice = ensured.projection.choices.find((candidate) => candidate.kind === 'existing')!;
    const refused = chooser.resolveAutomationPilotWorkspaceChooser({
      chooserId: ensured.projection.chooserId,
      expectedChooserRevision: ensured.projection.chooserRevision + 1,
      expectedChooserDigest: ensured.projection.chooserDigest,
      choiceId: choice.choiceId,
      actorRef: 'human.desktop',
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, 'workspace_chooser_stale');
  });

  await t.test('Workspace bytes drift after rendering', () => {
    spaces.spaceStore.save({ id: 'drift-workspace', title: 'Before' });
    const staged = approvedAdvancement('drift-choice');
    const ensured = chooser.ensureAutomationPilotWorkspaceChooser({ advancementId: staged.advancementId });
    assert.equal(ensured.ok, true, JSON.stringify(ensured));
    if (!ensured.ok) return;
    const choice = ensured.projection.choices.find((candidate) => candidate.kind === 'existing')!;
    spaces.spaceStore.save({ id: 'drift-workspace', title: 'After' });
    const refused = chooser.resolveAutomationPilotWorkspaceChooser({
      chooserId: ensured.projection.chooserId,
      expectedChooserRevision: ensured.projection.chooserRevision,
      expectedChooserDigest: ensured.projection.chooserDigest,
      choiceId: choice.choiceId,
      actorRef: 'human.desktop',
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.code, 'workspace_selection_drift');
      assert.equal(refused.projection?.status, 'blocked');
    }
    assert.equal(advancement.loadAutomationPilotAdvancement(staged.advancementId)?.stage, 'workspace_destination_required');
  });
});

test('crash after advancement consumption converges from the durable resolving receipt', () => {
  spaces.spaceStore.save({ id: 'crash-workspace', title: 'Crash target' });
  const staged = approvedAdvancement('crash-choice');
  const ensured = chooser.ensureAutomationPilotWorkspaceChooser({ advancementId: staged.advancementId });
  assert.equal(ensured.ok, true, JSON.stringify(ensured));
  if (!ensured.ok) return;
  const choice = ensured.projection.choices.find((candidate) => candidate.kind === 'existing')!;
  chooser.automationPilotWorkspaceChooserInternalsForTest.setAfterAdvancementDecisionHook(() => {
    throw new Error('simulated crash after advancement decision');
  });
  assert.throws(() => chooser.resolveAutomationPilotWorkspaceChooser({
    chooserId: ensured.projection.chooserId,
    expectedChooserRevision: ensured.projection.chooserRevision,
    expectedChooserDigest: ensured.projection.chooserDigest,
    choiceId: choice.choiceId,
    actorRef: 'human.desktop',
  }), /simulated crash/);
  const afterCrash = chooser.loadAutomationPilotWorkspaceChooser(ensured.projection.chooserId)!;
  assert.equal(afterCrash.status, 'resolving');
  const retainedReceipt = structuredClone(afterCrash.receipt);
  assert.equal(advancement.loadAutomationPilotAdvancement(staged.advancementId)?.stage, 'acquisition_pending');

  chooser.automationPilotWorkspaceChooserInternalsForTest.setAfterAdvancementDecisionHook();
  eventlog.closeEventLog();
  const recovered = chooser.reconcileAutomationPilotWorkspaceChoosers();
  assert.deepEqual(recovered, { scanned: 1, resolved: 1, blocked: 0, failed: 0 });
  const resolved = chooser.loadAutomationPilotWorkspaceChooser(ensured.projection.chooserId)!;
  assert.equal(resolved.status, 'resolved');
  assert.deepEqual(resolved.receipt, retainedReceipt);
  assert.deepEqual(
    advancement.loadAutomationPilotAdvancement(staged.advancementId)?.workspaceDecision,
    retainedReceipt,
  );
});
