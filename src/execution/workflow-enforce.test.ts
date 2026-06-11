/**
 * Run: npx tsx --test src/execution/workflow-enforce.test.ts
 *
 * Author/enable-time enforcement of the typed workflow contract.
 * Validation is UNCONDITIONAL (the WORKFLOW_TYPED_CONTRACT rollout flag was
 * removed 2026-05-31 — feedback_no_rollout_flags). Every error describes a
 * workflow that would already fail at run time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkWorkflowForWrite,
  checkRunnabilityConstraints,
  autoRepairWorkflowDefinition,
  prepareWorkflowForWrite,
  stepLooksMutating,
  stepIsTestableRead,
  workflowNeedsCreationTest,
} from './workflow-enforce.js';
import type { WorkflowDefinition } from '../memory/workflow-store.js';

function wf(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'demo',
    description: 'demo workflow',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'a', prompt: 'do a thing' }],
    ...overrides,
  } as WorkflowDefinition;
}

test('checkWorkflowForWrite: a clean manual workflow validates ok', () => {
  const result = checkWorkflowForWrite(wf());
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('checkWorkflowForWrite: enabled send workflow is allowed (default allowSends=true)', () => {
  // Approval gates are now opt-in. Ungated sends are allowed by default unless
  // the user explicitly sets allowSends: false (strict mode).
  const offending = wf({
    steps: [{ id: 'send', prompt: 'send the emails to the leads' }],
  });
  const result = checkWorkflowForWrite(offending);
  assert.equal(result.ok, true, 'ungated send is allowed with default allowSends=true');
  assert.equal(result.errors.length, 0, 'no errors for autonomous sends');
});

test('checkWorkflowForWrite: enabled send workflow with allowSends=false is rejected', () => {
  // Strict mode: require approval gates for any send when allowSends: false
  const offending = wf({
    enabled: true,
    allowSends: false,
    steps: [{ id: 'send', prompt: 'send the emails to the leads' }],
  });
  const result = checkWorkflowForWrite(offending);
  assert.equal(result.ok, false, 'ungated send is rejected with allowSends=false');
  assert.match(result.errors.join(' '), /requiresApproval|approval/i);
});

test('checkWorkflowForWrite: user-only notification workflow is allowed without approval gate', () => {
  const notification = wf({
    steps: [{ id: 'notify', prompt: 'notify the user with a structured summary of the outlook triage' }],
  });
  const result = checkWorkflowForWrite(notification);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

// ─── runnability (the "can't author an unrunnable workflow" guarantee) ───

test('checkRunnabilityConstraints: schedule-only + required non-common input with no default → error', () => {
  // 'segment' is NOT in COMMON_WORKFLOW_INPUT_KEYS, so it has no auto-supply
  // path on a scheduled run — must be flagged.
  const def = wf({
    trigger: { schedule: '0 9 * * *' }, // schedule, no manual
    inputs: { segment: { type: 'string' } } as WorkflowDefinition['inputs'],
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
  });
  const errors = checkRunnabilityConstraints(def);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no default and no way to be supplied/i);
  assert.match(errors[0], /segment/);
});

test('checkRunnabilityConstraints: schedule-only + required COMMON input (url) is allowed (injectable)', () => {
  const def = wf({
    trigger: { schedule: '0 9 * * *' },
    steps: [{ id: 'a', prompt: 'audit {{input.url}}' }],
  });
  assert.deepEqual(checkRunnabilityConstraints(def), []);
});

test('checkRunnabilityConstraints: manual trigger never blocks a required input (caller supplies it)', () => {
  const def = wf({
    trigger: { manual: true },
    inputs: { segment: { type: 'string' } } as WorkflowDefinition['inputs'],
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
  });
  assert.deepEqual(checkRunnabilityConstraints(def), []);
});

test('checkRunnabilityConstraints: schedule-only + required input WITH a default is allowed', () => {
  const def = wf({
    trigger: { schedule: '0 9 * * *' },
    inputs: { segment: { type: 'string', default: 'enterprise' } } as WorkflowDefinition['inputs'],
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
  });
  assert.deepEqual(checkRunnabilityConstraints(def), []);
});

test('checkRunnabilityConstraints: schedule + manual together never blocks (a caller can pass inputs)', () => {
  const def = wf({
    trigger: { schedule: '0 9 * * *', manual: true },
    inputs: { segment: { type: 'string' } } as WorkflowDefinition['inputs'],
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
  });
  assert.deepEqual(checkRunnabilityConstraints(def), []);
});

// ─── auto-repair (creation reliability: save runnable, don't bounce) ──────

test('autoRepair: {{steps.X.output}} on a non-dependency wires the dependsOn', () => {
  // 'analyze' references fetch's output but doesn't depend on it → would
  // render empty at run time and the validator would refuse the save.
  const def = wf({
    steps: [
      { id: 'fetch', prompt: 'fetch the data' },
      { id: 'analyze', prompt: 'analyze {{steps.fetch.output}}' },
    ],
  });
  // Pre-repair: the raw definition is refused.
  assert.equal(checkWorkflowForWrite(def).ok, false);
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  assert.deepEqual(repaired.steps[1].dependsOn, ['fetch']);
  assert.equal(repairs.length, 1);
  assert.match(repairs[0], /analyze.*fetch/);
  // Post-repair: it now validates.
  assert.equal(checkWorkflowForWrite(repaired).ok, true);
});

test('autoRepair: {{steps.X.output}} with a subpath still wires the dependsOn', () => {
  const def = wf({
    steps: [
      { id: 'fetch', prompt: 'fetch' },
      { id: 'use', prompt: 'use {{steps.fetch.output.items}}' },
    ],
  });
  const { def: repaired } = autoRepairWorkflowDefinition(def);
  assert.deepEqual(repaired.steps[1].dependsOn, ['fetch']);
});

test('autoRepair: forEach over a non-dependency wires the dependsOn', () => {
  const def = wf({
    steps: [
      { id: 'list', prompt: 'produce a list of leads' },
      { id: 'each', prompt: 'process {{item}}', forEach: 'list' },
    ],
  });
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  assert.deepEqual(repaired.steps[1].dependsOn, ['list']);
  assert.match(repairs.join(' '), /forEach/);
  assert.equal(checkWorkflowForWrite(repaired).ok, true);
});

test('autoRepair: undeclared {{input.X}} gets declared so the engine binds it', () => {
  const def = wf({
    steps: [{ id: 'a', prompt: 'audit {{input.segment}}' }],
  });
  // segment is non-common + undeclared → validator error pre-repair.
  assert.equal(checkWorkflowForWrite(def).ok, false);
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  assert.ok(repaired.inputs?.segment);
  assert.match(repairs.join(' '), /segment/);
  assert.equal(checkWorkflowForWrite(repaired).ok, true);
});

test('autoRepair P0-3: derives sideEffect from the prompt when the author omitted it', () => {
  const def = wf({
    steps: [
      { id: 'pull', prompt: 'Read the leads from the CRM.' },
      { id: 'save', prompt: 'Update the Airtable records with the enriched data.', dependsOn: ['pull'] },
      { id: 'send', prompt: 'Send the outreach emails to the list.', dependsOn: ['save'], requiresApproval: true },
    ],
  });
  const { def: repaired } = autoRepairWorkflowDefinition(def);
  assert.equal(repaired.steps[0].sideEffect, 'read');
  assert.equal(repaired.steps[1].sideEffect, 'write');
  assert.equal(repaired.steps[2].sideEffect, 'send');
});

test('autoRepair P0-3: never overrides an author-declared sideEffect', () => {
  const def = wf({
    steps: [{ id: 'a', prompt: 'Send the emails.', sideEffect: 'read', requiresApproval: true } as never],
  });
  const { def: repaired } = autoRepairWorkflowDefinition(def);
  assert.equal(repaired.steps[0].sideEffect, 'read'); // declared value preserved
});

test('autoRepair: never declares a COMMON input key (url is injectable)', () => {
  const def = wf({ steps: [{ id: 'a', prompt: 'audit {{input.url}}' }] });
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  assert.equal(repairs.length, 0);
  assert.equal(repaired.inputs?.url, undefined);
});

test('autoRepair: refuses to introduce a cycle (leaves the error for the validator)', () => {
  // a already depends on b; b references a's output. Wiring b→a would cycle.
  const def = wf({
    steps: [
      { id: 'a', prompt: 'start {{steps.b.output}}', dependsOn: ['b'] },
      { id: 'b', prompt: 'work' },
    ],
  });
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  // b is NOT given a dependsOn on a (would cycle); no repair claimed.
  assert.equal(repaired.steps[0].dependsOn?.includes('b'), true);
  assert.equal(repairs.length, 0);
});

test('autoRepair: a clean workflow is returned unchanged (same object, no repairs)', () => {
  const def = wf({
    steps: [
      { id: 'fetch', prompt: 'fetch' },
      { id: 'analyze', prompt: 'analyze {{steps.fetch.output}}', dependsOn: ['fetch'] },
    ],
  });
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  assert.equal(repairs.length, 0);
  assert.equal(repaired, def); // no clone when nothing changed
});

test('autoRepair: an already-transitive dependency is not re-added', () => {
  // c depends on b, b depends on a; c references a's output → a is already
  // transitively reachable, so no new direct dep is added.
  const def = wf({
    steps: [
      { id: 'a', prompt: 'a' },
      { id: 'b', prompt: 'b', dependsOn: ['a'] },
      { id: 'c', prompt: 'use {{steps.a.output}}', dependsOn: ['b'] },
    ],
  });
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  assert.deepEqual(repaired.steps[2].dependsOn, ['b']);
  assert.equal(repairs.length, 0);
});

test('prepareWorkflowForWrite: repairs then validates, surfacing repairs', () => {
  const def = wf({
    steps: [
      { id: 'fetch', prompt: 'fetch' },
      { id: 'analyze', prompt: 'analyze {{steps.fetch.output}}' },
    ],
  });
  const prep = prepareWorkflowForWrite(def);
  assert.equal(prep.ok, true);
  assert.deepEqual(prep.def.steps[1].dependsOn, ['fetch']);
  assert.ok(prep.repairs.length >= 1);
});

test('prepareWorkflowForWrite: a genuinely broken workflow still fails after repair', () => {
  // Hand-off language is not auto-fixable → still refused.
  const def = wf({
    steps: [{ id: 'a', prompt: 'do the work; a future turn will handle the rest' }],
  });
  const prep = prepareWorkflowForWrite(def);
  assert.equal(prep.ok, false);
  assert.ok(prep.errors.length >= 1);
});

// ── Part B: creation-test eligibility (which steps run for real / get previewed) ──

test('stepLooksMutating: a send/write step is mutating; a pure read step is not', () => {
  assert.equal(stepLooksMutating({ prompt: 'send the report email to the owner' }), true);
  assert.equal(stepLooksMutating({ prompt: 'create a new record in the Airtable table' }), true);
  assert.equal(stepLooksMutating({ prompt: 'do anything', requiresApproval: true }), true);
  assert.equal(stepLooksMutating({ prompt: 'scrape the Facebook page posts with Apify' }), false);
  assert.equal(stepLooksMutating({ prompt: 'fetch the latest SERP rankings' }), false);
});

test('stepIsTestableRead: read step with an external tool surface is testable', () => {
  // The scorpion scrape step: read intent + a composio/shell surface → test it for real.
  assert.equal(
    stepIsTestableRead({ prompt: 'scrape the Facebook page with Apify', allowedTools: ['composio_*', 'run_shell_command'] }),
    true,
  );
  // forEach over upstream data counts as reaching external data.
  assert.equal(stepIsTestableRead({ prompt: 'process each item', forEach: '{{steps.a.output}}', allowedTools: ['*'] }), true);
});

test('stepIsTestableRead: a mutating step is NOT testable (it gets previewed, not run)', () => {
  assert.equal(
    stepIsTestableRead({ prompt: 'create records in Airtable for each prospect', allowedTools: ['composio_*'] }),
    false,
  );
});

test('stepIsTestableRead: a pure-LLM read step (no external tools) is NOT worth a creation test', () => {
  assert.equal(stepIsTestableRead({ prompt: 'summarize the findings into three bullets' }), false);
  assert.equal(stepIsTestableRead({ prompt: 'read the upstream data and rank it', allowedTools: [] }), false);
});

test('workflowNeedsCreationTest: true when any step is a testable read, false otherwise', () => {
  // Scrape-then-email: the scrape step is testable → the workflow gets the gate.
  assert.equal(
    workflowNeedsCreationTest(wf({
      steps: [
        { id: 'scrape', prompt: 'scrape the page with Apify', allowedTools: ['composio_*'] },
        { id: 'send', prompt: 'send the summary email', dependsOn: ['scrape'] },
      ],
    })),
    true,
  );
  // All-mutating workflow → nothing read-only to validate → no gate.
  assert.equal(
    workflowNeedsCreationTest(wf({
      steps: [{ id: 'a', prompt: 'send the daily reminder email', requiresApproval: true }],
    })),
    false,
  );
  // Pure-LLM workflow → no external data to validate → no gate.
  assert.equal(
    workflowNeedsCreationTest(wf({ steps: [{ id: 'a', prompt: 'draft a motivational quote of the day' }] })),
    false,
  );
});
