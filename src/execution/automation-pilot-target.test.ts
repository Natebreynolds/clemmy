import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAutomationOpportunity, type AutomationOpportunityV1 } from './automation-opportunity.js';
import { selectAutomaticReadPilotTarget } from './automation-pilot-target.js';

function finiteOpportunity(): AutomationOpportunityV1 {
  return parseAutomationOpportunity({
    version: 1,
    title: 'Closed partition source',
    objective: 'Enumerate a closed source and process each normalized item.',
    rationale: 'The source ledger is larger than the inline topology seal.',
    lifetime: { kind: 'ongoing' },
    recurrence: {
      mode: 'proposed',
      cadence: { kind: 'interval', every: 1, unit: 'day' },
      overlapPolicy: 'skip',
      catchUpPolicy: 'run_once',
      activation: 'requires_pilot_success_and_recurrence_consent',
    },
    trigger: { kind: 'recurrence' },
    partition: {
      mode: 'finite',
      keyFields: ['item_key'],
      dimensions: ['item'],
      checkpointEvery: 2,
      completion: { kind: 'exact_count', expected: 4 },
    },
    capabilityRequirements: [{
      id: 'enumeration-read',
      description: 'Enumerate the exact closed item scope.',
      minimumEffect: 'read',
      constraints: [],
    }, {
      id: 'partition-read',
      description: 'Read one exact normalized item.',
      minimumEffect: 'read',
      constraints: [],
    }],
    phases: [{
      id: 'enumerate',
      objective: 'Enumerate the exact closed item scope.',
      dependsOn: [],
      capabilityRequirementIds: ['enumeration-read'],
      effect: { class: 'read', approval: 'not_required', maxOperationsPerRun: 1 },
      partitioned: false,
      outputEvidence: ['The source result is exhausted.'],
    }, {
      id: 'process-item',
      objective: 'Process one exact normalized item.',
      dependsOn: ['enumerate'],
      capabilityRequirementIds: ['partition-read'],
      effect: { class: 'read', approval: 'not_required', maxOperationsPerRun: 4 },
      partitioned: true,
      outputEvidence: ['The item has a durable settlement.'],
    }],
    effectCeiling: { class: 'read', maxOperationsPerRun: 5 },
    deliverables: [{
      id: 'result',
      description: 'One settled partition result.',
      kind: 'artifact',
      required: true,
      successCriterionIds: ['source-closed'],
      evidence: ['The source has closed authority.'],
    }],
    missingInputs: [],
    successCriteria: [{
      id: 'source-closed',
      description: 'The exact enumeration is closed.',
      evidence: ['The final source page is exhausted.'],
    }],
    pilot: {
      required: true,
      maxPartitions: 1,
      maxRecords: 4,
      effectCeiling: { class: 'read', maxOperationsPerRun: 1 },
      successCriterionIds: ['source-closed'],
      haltOnFailure: true,
    },
    budgets: {
      maxWallClockMinutesPerRun: 5,
      maxConcurrentPartitions: 2,
      maxAttemptsPerPartition: 2,
      maxPartitionsPerRun: 4,
      maxRecordsPerRun: 4,
      maxOperationsPerRun: 5,
      reserveOperations: 1,
    },
  });
}

test('the closed finite selector admits only the sole unpartitioned enumeration target', () => {
  const selected = selectAutomaticReadPilotTarget(finiteOpportunity());
  assert.equal(selected.ok, true, JSON.stringify(selected));
  if (!selected.ok) return;
  assert.equal(selected.phase.id, 'enumerate');
  assert.equal(selected.requirement.id, 'enumeration-read');
});

test('the closed finite selector rejects arbitrary, ambiguous, and partitioned source shapes', async (t) => {
  const variants: Array<{ name: string; mutate(value: AutomationOpportunityV1): void }> = [{
    name: 'arbitrary finite plan with no source dependency',
    mutate(value) { value.phases[1]!.dependsOn = []; },
  }, {
    name: 'multiple unpartitioned enumerators',
    mutate(value) { value.phases[1]!.partitioned = false; },
  }, {
    name: 'source binds multiple capabilities',
    mutate(value) { value.phases[0]!.capabilityRequirementIds.push('partition-read'); },
  }, {
    name: 'enumerator itself is partitioned',
    mutate(value) { value.phases[0]!.partitioned = true; },
  }];
  for (const variant of variants) {
    await t.test(variant.name, () => {
      const candidate = structuredClone(finiteOpportunity());
      variant.mutate(candidate);
      const selected = selectAutomaticReadPilotTarget(candidate);
      assert.equal(selected.ok, false, JSON.stringify(selected));
    });
  }
});
