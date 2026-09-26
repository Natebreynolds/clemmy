/**
 * Run: npx tsx --test src/memory/workflow-step-fields.test.ts
 *
 * Every step field survives every path that saves a step. WORKFLOW_STEP_FIELDS
 * is keyed by the step type, so a new field does not compile until it is
 * listed; this suite then requires the fixture to carry it and every save
 * path to keep it. A field the writer drops on purpose says so in the list.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wf-step-fields-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const { WORKFLOW_STEP_FIELDS, writeWorkflow, readWorkflow } = await import('./workflow-store.js');
const { normalizeWorkflowSteps } = await import('../execution/workflow-authoring.js');
const { STEP_PATCH_FIELDS } = await import('../execution/workflow-step-edit.js');
import type { WorkflowStepInput } from './workflow-store.js';

/** One step carrying a non-default value for every field the type declares. */
function everyFieldStep(): WorkflowStepInput {
  return {
    id: 'every-field',
    prompt: 'Do the whole thing.',
    project: 'site-repo',
    dependsOn: ['upstream'],
    orderingOnlyDeps: ['upstream'],
    model: 'model-a',
    intent: 'design',
    tier: 2,
    maxTurns: 7,
    useHarness: false,
    forEach: 'upstream',
    forEachNewOnly: true,
    subgraph: {
      mode: 'read_parallel_v1',
      specialists: [{ id: 'spec-a', prompt: 'Look here.', label: 'Here', model: 'model-b', intent: 'research', maxTurns: 3 }],
    },
    transform: { version: 1, expression: { op: 'literal', value: { ok: true } } },
    deterministic: { runner: 'collect.mjs' },
    call: {
      tool: 'SHEETS_APPEND_ROW',
      args: { sheet: 'Pipeline', row: '{{item}}' },
      account: {
        capabilityId: 'sheets',
        accountId: 'acct-1',
        choiceSetDigest: 'a'.repeat(64),
        selectedAt: '2026-09-25T12:00:00.000Z',
        selectedBy: 'owner',
      },
    },
    invocationPlan: { operation: 'SHEETS_APPEND_ROW' } as unknown as WorkflowStepInput['invocationPlan'],
    codifiedFrom: { prompt: 'Append the row.', allowedTools: ['SHEETS_APPEND_ROW'] },
    allowedTools: ['SHEETS_APPEND_ROW'],
    sideEffect: 'write',
    executionRole: 'reducer',
    usesSkill: 'house-style',
    requiresApproval: true,
    approvalPreview: 'Append one row per lead',
    inputs: { sheet: { type: 'string', from: 'input.sheet', description: 'Target sheet' } },
    output: { type: 'array', min_items: 1 },
    retryBudget: 2,
    optional: true,
    loopUntil: { maxAttempts: 3, until: { type: 'array', min_items: 1 } },
    loopSafe: true,
  };
}

const fieldNames = Object.keys(WORKFLOW_STEP_FIELDS) as Array<keyof WorkflowStepInput>;
const keptFields = fieldNames.filter((field) => WORKFLOW_STEP_FIELDS[field].kept);
const droppedFields = fieldNames.filter((field) => !WORKFLOW_STEP_FIELDS[field].kept);

before(() => {
  writeWorkflow('step-fields', {
    name: 'Step fields',
    description: 'every step field',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'upstream', prompt: 'List things.', sideEffect: 'read' }, everyFieldStep()],
  });
});

test('the fixture covers every field in the list', () => {
  const step = everyFieldStep();
  const missing = fieldNames.filter((field) => step[field] === undefined);
  assert.deepEqual(missing, [], 'add a non-default value for each new field to everyFieldStep()');
});

test('writing and reading a workflow keeps every kept field exactly', () => {
  const stored = readWorkflow('step-fields')?.data.steps.find((step) => step.id === 'every-field');
  assert.ok(stored, 'the step was stored');
  const expected = everyFieldStep();
  for (const field of keptFields) {
    assert.deepEqual(stored[field], expected[field], `${String(field)} did not survive a write and read`);
  }
  for (const field of droppedFields) {
    assert.equal(stored[field], undefined, `${String(field)} is listed as dropped but was written`);
  }
});

test('the save normalizer keeps every field', () => {
  const [normalized] = normalizeWorkflowSteps([everyFieldStep()]);
  const expected = everyFieldStep();
  for (const field of fieldNames) {
    assert.deepEqual(normalized[field], expected[field], `${String(field)} was lost by normalizeWorkflowSteps`);
  }
});

test('the single-step patch fields are exactly the fields the list marks patchable', () => {
  const patchable = fieldNames.filter((field) => WORKFLOW_STEP_FIELDS[field].patch);
  assert.deepEqual([...STEP_PATCH_FIELDS].sort(), [...patchable].sort());
});
