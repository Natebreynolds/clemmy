import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';

import {
  parseAutomationOpportunity,
  type AutomationOpportunityV1,
} from '../execution/automation-opportunity.js';
import {
  listAutomationOpportunityProposalRevisions,
  listAutomationOpportunityProposals,
} from '../execution/automation-opportunity-store.js';
import {
  automationOpportunityProposalId,
  registerAutomationOpportunityTools,
} from './automation-opportunity-tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

function opportunity(title = 'Periodic bounded observations'): AutomationOpportunityV1 {
  return {
    version: 1,
    title,
    objective: 'Observe every declared partition and retain an evidence-backed result.',
    rationale: 'The work is recurring, partitioned, and benefits from durable checkpoints.',
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
      keyFields: ['partition_key'],
      dimensions: ['partition_axis'],
      checkpointEvery: 10,
      completion: { kind: 'exact_count', expected: 20 },
    },
    capabilityRequirements: [{
      id: 'observe_source',
      description: 'Read the current observations for one bounded partition.',
      minimumEffect: 'read',
      constraints: ['Return stable item identities.', 'Expose continuation evidence.'],
    }],
    phases: [{
      id: 'observe',
      objective: 'Read and retain evidence for each declared partition.',
      dependsOn: [],
      capabilityRequirementIds: ['observe_source'],
      effect: { class: 'read', approval: 'not_required', maxOperationsPerRun: 50 },
      partitioned: true,
      outputEvidence: ['Every observation carries source and run references.'],
    }],
    effectCeiling: { class: 'read', maxOperationsPerRun: 50 },
    deliverables: [{
      id: 'coverage_report',
      description: 'A report of completed, partial, and failed partitions.',
      kind: 'artifact',
      required: true,
      successCriterionIds: ['bounded_coverage'],
      evidence: ['Counts reconcile with the declared denominator.'],
    }],
    missingInputs: [],
    successCriteria: [{
      id: 'bounded_coverage',
      description: 'Coverage is complete only when the declared denominator is exhausted.',
      evidence: ['Every partition has a terminal receipt.'],
    }],
    pilot: {
      required: true,
      maxPartitions: 2,
      maxRecords: 25,
      effectCeiling: { class: 'read', maxOperationsPerRun: 5 },
      successCriterionIds: ['bounded_coverage'],
      haltOnFailure: true,
    },
    budgets: {
      maxWallClockMinutesPerRun: 30,
      maxConcurrentPartitions: 4,
      maxAttemptsPerPartition: 2,
      maxPartitionsPerRun: 20,
      maxRecordsPerRun: 1_000,
      maxOperationsPerRun: 50,
      reserveOperations: 2,
    },
  };
}

function handlers(input: {
  database: Database.Database;
  source?: { sessionId: string; sourceUserSeq: number };
}): Map<string, Handler> {
  const captured = new Map<string, Handler>();
  registerAutomationOpportunityTools({
    tool(name: string, ...args: unknown[]) {
      const handler = args.at(-1);
      assert.equal(typeof handler, 'function');
      captured.set(name, handler as Handler);
    },
  } as never, {
    database: input.database,
    acceptedSource: () => input.source,
  });
  return captured;
}

function body(result: Awaited<ReturnType<Handler>>): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

test('proposal identity is bound to the accepted source and explicit opportunity key', () => {
  assert.equal(
    automationOpportunityProposalId({ sessionId: 'session_a', sourceUserSeq: 7, proposalKey: 'primary' }),
    automationOpportunityProposalId({ sessionId: 'session_a', sourceUserSeq: 7, proposalKey: 'primary' }),
  );
  assert.notEqual(
    automationOpportunityProposalId({ sessionId: 'session_a', sourceUserSeq: 7, proposalKey: 'primary' }),
    automationOpportunityProposalId({ sessionId: 'session_a', sourceUserSeq: 8, proposalKey: 'primary' }),
  );
});

test('proposal creation requires an exact accepted source and grants no execution authority', async () => {
  const database = new Database(':memory:');
  try {
    const tools = handlers({ database });
    assert.deepEqual([...tools.keys()].sort(), [
      'automation_opportunity_get',
      'automation_opportunity_list',
      'automation_opportunity_propose',
      'automation_opportunity_revise',
    ]);
    assert.equal(tools.has('automation_opportunity_approve'), false);
    const result = await tools.get('automation_opportunity_propose')!({
      proposal_key: 'primary',
      opportunity: opportunity(),
    });
    assert.equal(result.isError, true);
    assert.equal(body(result).code, 'accepted_source_required');
    assert.equal(listAutomationOpportunityProposals({ database }).length, 0);
  } finally {
    database.close();
  }
});

test('an exact proposal retry is idempotent while changed bytes cannot fork the same source key', async () => {
  const database = new Database(':memory:');
  try {
    const source = { sessionId: 'session_review', sourceUserSeq: 11 };
    const tools = handlers({ database, source });
    const propose = tools.get('automation_opportunity_propose')!;
    const args = {
      proposal_key: 'primary',
      opportunity: opportunity(),
      note: 'Drafted from structural long-work evidence.',
    };
    const first = body(await propose(args));
    const replay = body(await propose(args));
    assert.equal(first.ok, true);
    assert.equal(replay.ok, true);
    assert.equal(first.executionAuthority, 'none');
    assert.equal(first.nextBoundary, 'user_review');
    const proposal = first.proposal as Record<string, unknown>;
    assert.equal(proposal.status, 'proposed');
    assert.equal(proposal.revision, 1);
    assert.deepEqual(
      proposal.opportunity,
      parseAutomationOpportunity(opportunity()),
      'the review surface returns the exact canonical inert plan, not only counts',
    );

    const changed = await propose({
      ...args,
      opportunity: opportunity('Changed semantic proposal'),
    });
    assert.equal(changed.isError, true);
    assert.equal(body(changed).code, 'already_exists');

    const rows = listAutomationOpportunityProposals({ database });
    assert.equal(rows.length, 1);
    const history = listAutomationOpportunityProposalRevisions(rows[0]!.proposalId, database);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.actorRef, 'accepted-source:session_review#11');
  } finally {
    database.close();
  }
});

test('revision is exact-CAS and remains inert for user review', async () => {
  const database = new Database(':memory:');
  try {
    const source = { sessionId: 'session_revision', sourceUserSeq: 19 };
    const tools = handlers({ database, source });
    const first = body(await tools.get('automation_opportunity_propose')!({
      proposal_key: 'primary',
      opportunity: opportunity(),
    }));
    const initial = first.proposal as Record<string, unknown>;
    const revised = body(await tools.get('automation_opportunity_revise')!({
      proposal_id: initial.proposalId,
      expected_revision: initial.revision,
      expected_digest: initial.digest,
      opportunity: opportunity('Reviewed draft title'),
      note: 'Material answers incorporated.',
    }));
    assert.equal(revised.ok, true);
    assert.equal(revised.executionAuthority, 'none');
    const current = revised.proposal as Record<string, unknown>;
    assert.equal(current.status, 'proposed');
    assert.equal(current.revision, 2);

    const stale = await tools.get('automation_opportunity_revise')!({
      proposal_id: initial.proposalId,
      expected_revision: initial.revision,
      expected_digest: initial.digest,
      opportunity: opportunity('Stale overwrite'),
    });
    assert.equal(stale.isError, true);
    assert.equal(body(stale).code, 'cas_mismatch');

    const loaded = body(await tools.get('automation_opportunity_get')!({ proposal_id: initial.proposalId }));
    assert.equal((loaded.proposal as Record<string, unknown>).revision, 2);
    const listed = body(await tools.get('automation_opportunity_list')!({ status: 'proposed', limit: 10 }));
    assert.equal((listed.proposals as unknown[]).length, 1);
  } finally {
    database.close();
  }
});

test('invalid structured proposal produces no durable row', async () => {
  const database = new Database(':memory:');
  try {
    const tools = handlers({
      database,
      source: { sessionId: 'session_invalid', sourceUserSeq: 23 },
    });
    const invalid = await tools.get('automation_opportunity_propose')!({
      proposal_key: 'primary',
      opportunity: { version: 1, title: 'Incomplete' },
    });
    assert.equal(invalid.isError, true);
    assert.equal(body(invalid).code, 'invalid_opportunity');
    assert.equal(listAutomationOpportunityProposals({ database }).length, 0);
  } finally {
    database.close();
  }
});
