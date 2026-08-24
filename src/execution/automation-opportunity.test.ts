import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  automationOpportunityDigest,
  automationOpportunityToDispositionDraft,
  canonicalAutomationOpportunityJson,
  parseAutomationOpportunity,
  validateAutomationOpportunity,
  type AutomationOpportunityV1,
} from './automation-opportunity.js';
import {
  AutomationOpportunityStoreIntegrityError,
  createAutomationOpportunityProposal,
  listAutomationOpportunityProposalRevisions,
  listAutomationOpportunityProposals,
  loadAutomationOpportunityProposal,
  reviseAutomationOpportunityProposal,
  transitionAutomationOpportunityProposal,
} from './automation-opportunity-store.js';

function opportunity(overrides: Partial<AutomationOpportunityV1> = {}): AutomationOpportunityV1 {
  return {
    version: 1,
    title: 'Periodic structured collection',
    objective: 'Collect, normalize, and retain bounded structured observations.',
    rationale: 'The work spans stable partitions and benefits from checkpoints and review.',
    lifetime: { kind: 'ongoing' },
    recurrence: {
      mode: 'proposed',
      cadence: { kind: 'interval', every: 6, unit: 'hour' },
      overlapPolicy: 'queue_one',
      catchUpPolicy: 'run_once',
      activation: 'requires_pilot_success_and_recurrence_consent',
    },
    trigger: { kind: 'recurrence' },
    partition: {
      mode: 'finite',
      keyFields: ['stable_key'],
      dimensions: ['axis_b', 'axis_a'],
      checkpointEvery: 25,
      completion: {
        kind: 'enumeration_exhausted',
        evidence: ['The enumerator reports exhaustion.', 'Every declared partition has a terminal state.'],
      },
    },
    capabilityRequirements: [
      {
        id: 'artifact-commit',
        description: 'Commit bounded result batches.',
        minimumEffect: 'local_write',
        constraints: ['Returns a durable receipt.', 'Supports replay-safe identity.'],
      },
      {
        id: 'source-observe',
        description: 'Observe partition and item data.',
        minimumEffect: 'read',
        constraints: ['Reports terminal enumeration.', 'Returns stable item keys.'],
      },
    ],
    phases: [
      {
        id: 'consolidate',
        objective: 'Commit canonical batches with provenance.',
        dependsOn: ['observe'],
        capabilityRequirementIds: ['artifact-commit'],
        effect: { class: 'local_write', approval: 'not_required', maxOperationsPerRun: 500 },
        partitioned: true,
        outputEvidence: ['A durable batch receipt exists.', 'Committed counts reconcile.'],
      },
      {
        id: 'enumerate',
        objective: 'Declare stable partitions and completion evidence.',
        dependsOn: [],
        capabilityRequirementIds: ['source-observe'],
        effect: { class: 'read', approval: 'not_required', maxOperationsPerRun: 100 },
        partitioned: false,
        outputEvidence: ['Each partition has a stable key.', 'Enumeration evidence is retained.'],
      },
      {
        id: 'observe',
        objective: 'Collect and normalize observations per partition.',
        dependsOn: ['enumerate'],
        capabilityRequirementIds: ['source-observe'],
        effect: { class: 'read', approval: 'not_required', maxOperationsPerRun: 900 },
        partitioned: true,
        outputEvidence: ['Each observation has a stable key.', 'Each source result has provenance.'],
      },
    ],
    effectCeiling: { class: 'local_write', maxOperationsPerRun: 1_000 },
    dataset: {
      schema: {
        fields: [
          { name: 'metric', type: 'number', required: false, sensitivity: 'internal' },
          { name: 'stable_key', type: 'string', required: true, sensitivity: 'internal' },
          { name: 'label', type: 'string', required: false, sensitivity: 'internal' },
        ],
        additionalFields: 'reject',
      },
      identity: {
        rules: [
          {
            id: 'stable-exact',
            fields: ['stable_key'],
            match: 'exact',
            normalizers: ['unicode_nfkc', 'case_fold', 'trim'],
          },
        ],
        ambiguousMatch: 'review_required',
      },
      merge: {
        mode: 'field_policy_after_exact_identity',
        defaultConflict: 'review_required',
        fieldPolicies: [
          { field: 'metric', onConflict: 'prefer_newer' },
          { field: 'label', onConflict: 'prefer_newer' },
        ],
        preserveSourceRecords: true,
      },
      provenance: {
        required: true,
        retainSourceSnapshots: true,
        requiredReferences: ['observed_at', 'source_ref', 'run_ref'],
      },
    },
    deliverables: [
      {
        id: 'run-summary',
        description: 'A bounded progress and exception summary.',
        kind: 'artifact',
        required: true,
        successCriterionIds: ['coverage'],
        evidence: ['Counts reconcile with terminal partition states.'],
      },
      {
        id: 'structured-snapshot',
        description: 'A canonical structured snapshot with source history.',
        kind: 'dataset_snapshot',
        required: true,
        successCriterionIds: ['provenance', 'identity'],
        evidence: ['The snapshot has a durable content digest.'],
      },
    ],
    missingInputs: [],
    successCriteria: [
      {
        id: 'provenance',
        description: 'Every committed observation retains required provenance.',
        evidence: ['Source, run, and observation-time references are present.'],
      },
      {
        id: 'coverage',
        description: 'Declared partitions reach explicit terminal states.',
        evidence: ['Partition counts reconcile.', 'No declared partition disappears.'],
      },
      {
        id: 'identity',
        description: 'Identity conflicts are preserved for review.',
        evidence: ['Ambiguous matches remain separate or enter review.'],
      },
    ],
    pilot: {
      required: true,
      maxPartitions: 5,
      maxRecords: 100,
      effectCeiling: { class: 'read', maxOperationsPerRun: 100 },
      successCriterionIds: ['coverage', 'provenance'],
      haltOnFailure: true,
    },
    budgets: {
      maxWallClockMinutesPerRun: 120,
      maxConcurrentPartitions: 8,
      maxAttemptsPerPartition: 3,
      maxPartitionsPerRun: 1_000,
      maxRecordsPerRun: 100_000,
      maxOperationsPerRun: 1_000,
      reserveOperations: 10,
    },
    ...overrides,
  };
}

function assertInvalid(candidate: unknown, pattern: RegExp): void {
  const validation = validateAutomationOpportunity(candidate);
  assert.equal(validation.ok, false);
  if (validation.ok) return;
  assert.match(validation.errors.join('\n'), pattern);
}

test('metamorphic set ordering and insignificant whitespace produce identical canonical bytes', () => {
  const first = opportunity();
  const second = structuredClone(first);
  second.title = '  Periodic   structured collection  ';
  second.objective = 'Collect, normalize, and retain   bounded structured observations.';
  second.capabilityRequirements.reverse();
  second.capabilityRequirements[0].constraints.reverse();
  second.phases.reverse();
  second.phases.find((phase) => phase.id === 'observe')!.outputEvidence.reverse();
  second.partition = {
    ...second.partition,
    dimensions: ['axis_a', 'axis_b'],
    keyFields: ['stable_key'],
  } as AutomationOpportunityV1['partition'];
  second.dataset!.schema.fields.reverse();
  second.dataset!.merge.fieldPolicies.reverse();
  second.dataset!.provenance.requiredReferences.reverse();
  second.deliverables.reverse();
  second.successCriteria.reverse();
  second.pilot.successCriterionIds.reverse();

  assert.equal(canonicalAutomationOpportunityJson(first), canonicalAutomationOpportunityJson(second));
  assert.equal(automationOpportunityDigest(first), automationOpportunityDigest(second));
  assert.deepEqual(parseAutomationOpportunity(first), parseAutomationOpportunity(second));
});

test('semantic changes alter the digest and the narrow disposition draft grants no topology', () => {
  const first = opportunity();
  const changed = structuredClone(first);
  changed.budgets.maxRecordsPerRun += 1;
  assert.notEqual(automationOpportunityDigest(first), automationOpportunityDigest(changed));

  const draft = automationOpportunityToDispositionDraft(first);
  assert.deepEqual(Object.keys(draft).sort(), [
    'effectCeiling',
    'missingRequiredInputs',
    'objective',
    'successCriteria',
  ]);
  assert.equal(draft.effectCeiling, 'write');
  assert.equal(Object.hasOwn(draft, 'manifest'), false);
  assert.equal(Object.hasOwn(draft, 'kind'), false);
});

test('invalid references, dependency cycles, and unsafe effects fail closed', () => {
  const cyclic = opportunity();
  cyclic.phases.find((phase) => phase.id === 'enumerate')!.dependsOn = ['consolidate'];
  assertInvalid(cyclic, /dependency cycle/);

  const overCeiling = opportunity({ effectCeiling: { class: 'read', maxOperationsPerRun: 1_000 } });
  assertInvalid(overCeiling, /exceeds the opportunity effect ceiling/);

  const unapproved = opportunity();
  unapproved.effectCeiling = { class: 'external_write', maxOperationsPerRun: 1_000 };
  unapproved.phases.find((phase) => phase.id === 'consolidate')!.effect = {
    class: 'external_write',
    approval: 'not_required',
    maxOperationsPerRun: 10,
  };
  assertInvalid(unapproved, /without required approval/);

  const unknownCapability = opportunity();
  unknownCapability.phases[0].capabilityRequirementIds = ['absent'];
  assertInvalid(unknownCapability, /unknown capability requirement/);

  const unboundWrite = opportunity();
  unboundWrite.phases.find((phase) => phase.id === 'consolidate')!.capabilityRequirementIds = [
    'source-observe',
  ];
  assertInvalid(unboundWrite, /no capability requirement for its local_write effect/);

  const unknownIdentityField = opportunity();
  unknownIdentityField.dataset!.identity.rules[0].fields = ['absent'];
  assertInvalid(unknownIdentityField, /identity rule .* unknown field/);
});

test('reserved object keys cannot enter ids, dataset fields, or event paths', () => {
  const reservedField = structuredClone(opportunity()) as unknown as Record<string, unknown>;
  const dataset = reservedField.dataset as Record<string, unknown>;
  const schema = dataset.schema as Record<string, unknown>;
  const fields = schema.fields as Array<Record<string, unknown>>;
  fields[0]!.name = '__proto__';
  assertInvalid(reservedField, /reserved object key/i);

  const reservedId = structuredClone(opportunity()) as unknown as Record<string, unknown>;
  (reservedId.phases as Array<Record<string, unknown>>)[0]!.id = 'constructor';
  assertInvalid(reservedId, /reserved object key/i);

  const reservedPath = structuredClone(opportunity()) as unknown as Record<string, unknown>;
  reservedPath.trigger = {
    kind: 'event',
    eventContract: 'A current event definition.',
    dedupeKey: 'payload.__proto__.id',
    capabilityRequirementId: 'source-observe',
  };
  assertInvalid(reservedPath, /reserved object path segment/i);
});

test('recurrence is explicit proposal data and never accepts an active flag', () => {
  const hiddenActivation = structuredClone(opportunity()) as unknown as Record<string, unknown>;
  hiddenActivation.recurrence = {
    ...(hiddenActivation.recurrence as Record<string, unknown>),
    enabled: true,
  };
  assertInvalid(hiddenActivation, /recurrence.*Unrecognized key|recurrence.*unrecognized key/i);

  const contradictory = opportunity({ lifetime: { kind: 'single_run' } });
  assertInvalid(contradictory, /single_run lifetime cannot propose recurrence/);

  const absentProposal = opportunity({
    recurrence: { mode: 'none' },
    trigger: { kind: 'recurrence' },
  });
  assertInvalid(absentProposal, /requires an explicit recurrence proposal/);

  const invalidCalendar = opportunity({
    recurrence: {
      mode: 'proposed',
      cadence: { kind: 'calendar', expression: 'invalid', timezone: 'Nowhere/Undefined' },
      overlapPolicy: 'skip',
      catchUpPolicy: 'skip',
      activation: 'requires_pilot_success_and_recurrence_consent',
    },
  });
  assertInvalid(invalidCalendar, /calendar expression is invalid|timezone is invalid/);
});

test('dataset provenance and merge preservation are mandatory and bounded', () => {
  const missingProvenance = opportunity();
  missingProvenance.dataset!.provenance.requiredReferences = [
    'source_ref',
    'run_ref',
    'run_ref',
  ];
  assertInvalid(missingProvenance, /must require "observed_at"/);

  const nonPreserving = structuredClone(opportunity()) as unknown as Record<string, unknown>;
  const dataset = nonPreserving.dataset as Record<string, unknown>;
  dataset.merge = { ...(dataset.merge as Record<string, unknown>), preserveSourceRecords: false };
  assertInvalid(nonPreserving, /preserveSourceRecords/);

  const excessivePilot = opportunity();
  excessivePilot.pilot.maxRecords = excessivePilot.budgets.maxRecordsPerRun + 1;
  assertInvalid(excessivePilot, /pilot record bound exceeds/);
});

test('proposal review and approval use exact revision plus digest CAS and retain history', () => {
  const database = new Database(':memory:');
  try {
    const created = createAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-a',
      opportunity: opportunity(),
      actorRef: 'author-a',
      now: new Date('2026-08-22T10:00:00.000Z'),
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.record.status, 'proposed');
    assert.equal(created.record.revision, 1);

    const premature = transitionAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-a',
      to: 'approved',
      expectedRevision: 1,
      expectedDigest: created.record.digest,
      actorRef: 'reviewer-a',
    });
    assert.equal(premature.ok, false);
    if (!premature.ok) assert.equal(premature.code, 'invalid_transition');

    const reviewed = transitionAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-a',
      to: 'reviewed',
      expectedRevision: 1,
      expectedDigest: created.record.digest,
      actorRef: 'reviewer-a',
      note: 'The boundaries are explicit.',
      now: new Date('2026-08-22T10:05:00.000Z'),
    });
    assert.equal(reviewed.ok, true);
    if (!reviewed.ok) return;
    assert.equal(reviewed.record.revision, 2);

    const stale = transitionAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-a',
      to: 'approved',
      expectedRevision: 1,
      expectedDigest: reviewed.record.digest,
      actorRef: 'reviewer-b',
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, 'cas_mismatch');

    const wrongDigest = transitionAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-a',
      to: 'approved',
      expectedRevision: 2,
      expectedDigest: '0'.repeat(64),
      actorRef: 'reviewer-b',
    });
    assert.equal(wrongDigest.ok, false);
    if (!wrongDigest.ok) assert.equal(wrongDigest.code, 'cas_mismatch');

    const approved = transitionAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-a',
      to: 'approved',
      expectedRevision: 2,
      expectedDigest: reviewed.record.digest,
      actorRef: 'reviewer-b',
      now: new Date('2026-08-22T10:10:00.000Z'),
    });
    assert.equal(approved.ok, true);
    if (!approved.ok) return;
    assert.equal(approved.record.status, 'approved');
    assert.equal(approved.record.revision, 3);
    assert.equal(approved.record.opportunity.recurrence.mode, 'proposed');
    assert.equal(Object.hasOwn(approved.record.opportunity.recurrence, 'enabled'), false);

    const history = listAutomationOpportunityProposalRevisions('proposal-a', database);
    assert.deepEqual(history.map((revision) => revision.status), ['proposed', 'reviewed', 'approved']);
    assert.deepEqual(history.map((revision) => revision.revision), [1, 2, 3]);
    assert.equal(new Set(history.map((revision) => revision.digest)).size, 1);
    assert.equal(listAutomationOpportunityProposals({ status: 'approved', database }).length, 1);
  } finally {
    database.close();
  }
});

test('a semantic revision changes the digest, resets review, and spends the old CAS pair', () => {
  const database = new Database(':memory:');
  try {
    const created = createAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-b',
      opportunity: opportunity(),
      actorRef: 'author-a',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const reviewed = transitionAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-b',
      to: 'reviewed',
      expectedRevision: created.record.revision,
      expectedDigest: created.record.digest,
      actorRef: 'reviewer-a',
    });
    assert.equal(reviewed.ok, true);
    if (!reviewed.ok) return;

    const revisedOpportunity = structuredClone(reviewed.record.opportunity);
    revisedOpportunity.budgets.maxRecordsPerRun += 1;
    const revised = reviseAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-b',
      opportunity: revisedOpportunity,
      expectedRevision: reviewed.record.revision,
      expectedDigest: reviewed.record.digest,
      actorRef: 'author-b',
      note: 'Adjusted one explicit bound.',
    });
    assert.equal(revised.ok, true);
    if (!revised.ok) return;
    assert.equal(revised.record.status, 'proposed');
    assert.equal(revised.record.revision, 3);
    assert.notEqual(revised.record.digest, reviewed.record.digest);
    assert.equal(revised.record.reviewedAt, undefined);

    const stale = transitionAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-b',
      to: 'reviewed',
      expectedRevision: reviewed.record.revision,
      expectedDigest: reviewed.record.digest,
      actorRef: 'reviewer-b',
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, 'cas_mismatch');

    const sameMeaning = structuredClone(revised.record.opportunity);
    sameMeaning.phases.reverse();
    const unchanged = reviseAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-b',
      opportunity: sameMeaning,
      expectedRevision: revised.record.revision,
      expectedDigest: revised.record.digest,
      actorRef: 'author-b',
    });
    assert.equal(unchanged.ok, false);
    if (!unchanged.ok) assert.equal(unchanged.code, 'unchanged');
  } finally {
    database.close();
  }
});

test('required missing inputs prevent approval until a reviewed revision removes them', () => {
  const database = new Database(':memory:');
  try {
    const withGap = opportunity({
      missingInputs: [
        {
          id: 'scope-boundary',
          description: 'Choose the bounded observation scope.',
          required: true,
          blockingPhaseIds: ['enumerate'],
        },
      ],
    });
    const created = createAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-c',
      opportunity: withGap,
      actorRef: 'author-a',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const reviewed = transitionAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-c',
      to: 'reviewed',
      expectedRevision: created.record.revision,
      expectedDigest: created.record.digest,
      actorRef: 'reviewer-a',
    });
    assert.equal(reviewed.ok, true);
    if (!reviewed.ok) return;
    const blocked = transitionAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-c',
      to: 'approved',
      expectedRevision: reviewed.record.revision,
      expectedDigest: reviewed.record.digest,
      actorRef: 'reviewer-a',
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.code, 'invalid_transition');
      assert.match(blocked.message, /scope-boundary/);
    }
  } finally {
    database.close();
  }
});

test('rejection is durable and terminal', () => {
  const database = new Database(':memory:');
  try {
    const created = createAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-rejected',
      opportunity: opportunity(),
      actorRef: 'author-a',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const rejected = transitionAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-rejected',
      to: 'rejected',
      expectedRevision: created.record.revision,
      expectedDigest: created.record.digest,
      actorRef: 'reviewer-a',
      note: 'The proposal should not proceed.',
    });
    assert.equal(rejected.ok, true);
    if (!rejected.ok) return;
    assert.equal(rejected.record.status, 'rejected');
    assert.equal(rejected.record.revision, 2);

    const terminal = reviseAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-rejected',
      opportunity: opportunity({ title: 'Replacement proposal' }),
      expectedRevision: rejected.record.revision,
      expectedDigest: rejected.record.digest,
      actorRef: 'author-a',
    });
    assert.equal(terminal.ok, false);
    if (!terminal.ok) assert.equal(terminal.code, 'invalid_transition');
  } finally {
    database.close();
  }
});

test('corrupted persisted proposal bytes fail closed on read', () => {
  const database = new Database(':memory:');
  try {
    const created = createAutomationOpportunityProposal({
      database,
      proposalId: 'proposal-d',
      opportunity: opportunity(),
      actorRef: 'author-a',
    });
    assert.equal(created.ok, true);
    database.prepare(
      `UPDATE automation_opportunity_proposals
       SET opportunity_json = ? WHERE proposal_id = ?`,
    ).run(JSON.stringify({ version: 1 }), 'proposal-d');
    assert.throws(
      () => loadAutomationOpportunityProposal('proposal-d', database),
      AutomationOpportunityStoreIntegrityError,
    );
  } finally {
    database.close();
  }
});
