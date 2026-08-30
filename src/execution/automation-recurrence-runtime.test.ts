/** Run: node scripts/run-tests-isolated.mjs src/execution/automation-recurrence-runtime.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { WorkflowDefinition } from '../memory/workflow-store.js';
import type { AutomationRecurrenceV1 } from './automation-opportunity.js';
import type {
  AutomationRecurrenceCadenceV1,
  AutomationRecurrencePilotSuccessEvidenceV1,
} from './automation-recurrence-control-plane.js';
import type { ProjectAutomationRecurrencePilotSuccessResultV1 } from './automation-recurrence-runtime.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-recurrence-runtime-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const runtime = await import('./automation-recurrence-runtime.js');
const control = await import('./automation-recurrence-control-plane.js');
const approvals = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const workflowStore = await import('../memory/workflow-store.js');

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const REQUESTED: AutomationRecurrenceCadenceV1 = {
  every: 2,
  unit: 'hour' as const,
  overlapPolicy: 'skip' as const,
  catchUpPolicy: 'run_once' as const,
};

function projectedSuccess(input: {
  recurrence: AutomationRecurrenceV1;
  evidenceRevision?: number;
  authorityRevision?: number;
}): Extract<ProjectAutomationRecurrencePilotSuccessResultV1, { ok: true }> {
  const proposalId = 'proposal.opaque.authority';
  const proposalDigest = digest('proposal.opaque.authority');
  const evidenceRevision = input.evidenceRevision ?? 7;
  const authorityRevision = input.authorityRevision ?? evidenceRevision;
  return {
    ok: true,
    evidence: {
      proposalId,
      proposalRevision: evidenceRevision,
      proposalDigest,
    } as AutomationRecurrencePilotSuccessEvidenceV1,
    sourceDefinition: {
      name: 'workflow.opaque.authority',
      description: 'inert test definition',
      enabled: false,
      trigger: { manual: true },
      steps: [],
    } as WorkflowDefinition,
    workflowInputs: {},
    approvedRecurrence: {
      version: 1,
      proposal: {
        proposalId,
        revision: authorityRevision,
        digest: proposalDigest,
      },
      recurrence: input.recurrence,
    },
  };
}

function durableSideEffects(): {
  activations: number;
  receipts: number;
  approvals: string[];
  workflows: string[];
} {
  // Initialize the recurrence schema before reading its exact row counts.
  control.listAutomationRecurrenceActivationsForReconciliation();
  const db = eventlog.openEventLog();
  return {
    activations: (db.prepare(
      'SELECT COUNT(*) AS count FROM automation_recurrence_activations',
    ).get() as { count: number }).count,
    receipts: (db.prepare(
      'SELECT COUNT(*) AS count FROM automation_recurrence_activation_receipts',
    ).get() as { count: number }).count,
    approvals: approvals.listPending({ status: 'any' }).map((row) => row.approvalId).sort(),
    workflows: workflowStore.listWorkflows().map((entry) => entry.name).sort(),
  };
}

test('none, calendar, proposal-lineage drift, and every interval field drift refuse before any durable side effect', () => {
  const proposed: AutomationRecurrenceV1 = {
    mode: 'proposed',
    cadence: { kind: 'interval', every: 2, unit: 'hour' },
    overlapPolicy: 'skip',
    catchUpPolicy: 'run_once',
    activation: 'requires_pilot_success_and_recurrence_consent',
  };
  const cases: Array<{
    name: string;
    success: Extract<ProjectAutomationRecurrencePilotSuccessResultV1, { ok: true }>;
    requested: AutomationRecurrenceCadenceV1;
    code: string;
  }> = [{
    name: 'proposal lineage',
    success: projectedSuccess({ recurrence: proposed, authorityRevision: 8 }),
    requested: REQUESTED,
    code: 'recurrence_proposal_lineage_mismatch',
  }, {
    name: 'recurrence none',
    success: projectedSuccess({ recurrence: { mode: 'none' } }),
    requested: REQUESTED,
    code: 'recurrence_not_proposed',
  }, {
    name: 'calendar conversion',
    success: projectedSuccess({
      recurrence: {
        mode: 'proposed',
        cadence: { kind: 'calendar', expression: '0 9 * * *', timezone: 'UTC' },
        overlapPolicy: 'skip',
        catchUpPolicy: 'run_once',
        activation: 'requires_pilot_success_and_recurrence_consent',
      },
    }),
    requested: REQUESTED,
    code: 'recurrence_cadence_unsupported',
  }, {
    name: 'every',
    success: projectedSuccess({ recurrence: proposed }),
    requested: { ...REQUESTED, every: 3 },
    code: 'recurrence_contract_mismatch',
  }, {
    name: 'unit',
    success: projectedSuccess({ recurrence: proposed }),
    requested: { ...REQUESTED, unit: 'day' },
    code: 'recurrence_contract_mismatch',
  }, {
    name: 'overlap',
    success: projectedSuccess({ recurrence: proposed }),
    requested: { ...REQUESTED, overlapPolicy: 'queue_one' },
    code: 'recurrence_contract_mismatch',
  }, {
    name: 'catch-up',
    success: projectedSuccess({ recurrence: proposed }),
    requested: { ...REQUESTED, catchUpPolicy: 'skip' },
    code: 'recurrence_contract_mismatch',
  }];

  for (const scenario of cases) {
    const before = durableSideEffects();
    const result = runtime.requestAutomationRecurrenceActivation({
      pilotRunId: 'run.opaque.pilot',
      approvalSessionId: 'chat.opaque.owner',
      cadence: scenario.requested,
      previewedAt: '2026-08-27T12:00:00.000Z',
    }, {
      projectPilotSuccess: () => scenario.success,
    });
    assert.equal(result.ok, false, scenario.name);
    if (result.ok) assert.fail(`${scenario.name} unexpectedly created recurrence authority`);
    assert.equal(result.code, scenario.code, scenario.name);
    assert.deepEqual(
      durableSideEffects(),
      before,
      `${scenario.name} changed preview/store/CAS/card durable state`,
    );
  }
});
