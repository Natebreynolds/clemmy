/**
 * Run: npx tsx --test src/execution/workflow-authoring.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-workflow-authoring-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const {
  applyWorkflowTriggerPatch,
  buildWorkflowTrigger,
  deleteWorkflowAndSyncTriggers,
  normalizeWorkflowModelPortability,
  normalizeWorkflowSteps,
  prepareWorkflowCreateForWrite,
  prepareWorkflowEnableForWrite,
  prepareWorkflowUpdateForWrite,
  validateWorkflowStepGraph,
  workflowModelPortabilityFromUnknown,
  workflowTriggerCreateInputFromUnknown,
  writeWorkflowAndSyncTriggers,
} = await import('./workflow-authoring.js');
const { fireWorkflowSystemEvent, closeWorkflowTriggerDbForTest } = await import('./workflow-trigger-engine.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');

beforeEach(() => {
  closeWorkflowTriggerDbForTest();
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  rmSync(WORKFLOW_RUNS_DIR, { recursive: true, force: true });
  rmSync(path.join(TMP_HOME, 'state'), { recursive: true, force: true });
});

test.after(() => {
  closeWorkflowTriggerDbForTest();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('workflowTriggerCreateInputFromUnknown accepts dashboard nested webhook and event triggers', () => {
  const input = workflowTriggerCreateInputFromUnknown({
    trigger: {
      schedule: '0 9 * * 1-5',
      timezone: 'America/Los_Angeles',
      webhookPath: 'lead-created',
      events: [{ type: 'crm.lead.created', dedupeKey: 'lead-{{payload.id}}' }],
    },
  });
  assert.equal(input.ok, true);
  if (!input.ok) return;

  const built = buildWorkflowTrigger(input.input);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.trigger, {
    manual: true,
    schedule: '0 9 * * 1-5',
    timezone: 'America/Los_Angeles',
    webhookPath: 'lead-created',
    events: [{ type: 'crm.lead.created', dedupeKey: 'lead-{{payload.id}}' }],
  });
});

test('applyWorkflowTriggerPatch clears and replaces trigger fields in one shared path', () => {
  const patched = applyWorkflowTriggerPatch(
    {
      manual: true,
      schedule: '0 9 * * *',
      timezone: 'America/Los_Angeles',
      webhookPath: 'old-hook',
      events: [{ type: 'old.event' }],
    },
    {
      triggerSchedule: '',
      triggerWebhookPath: 'new-hook',
      triggerEvents: [],
    },
  );
  assert.equal(patched.ok, true);
  if (!patched.ok) return;
  assert.deepEqual(patched.trigger, {
    manual: true,
    timezone: 'America/Los_Angeles',
    webhookPath: 'new-hook',
  });
  assert.equal(patched.changed, true);
});

test('shared step normalization and graph validation preserve execution fields', () => {
  const steps = normalizeWorkflowSteps([{
    id: 'send',
    prompt: undefined,
    project: 'clementine-next',
    dependsOn: ['pull'],
    forEach: 'pull',
    forEachNewOnly: true,
    call: { tool: 'GMAIL_SEND_EMAIL', args: { to: '{{item.email}}' } },
    loopUntil: { maxAttempts: 2, probe: { runner: 'check-send.mjs' }, until: { type: 'object', required_keys: ['done'] } },
    loopSafe: true,
  }]);
  assert.equal(steps[0].prompt, '');
  assert.equal(steps[0].project, 'clementine-next');
  assert.deepEqual(steps[0].call, { tool: 'GMAIL_SEND_EMAIL', args: { to: '{{item.email}}' } });
  assert.equal(steps[0].forEachNewOnly, true);
  assert.match(validateWorkflowStepGraph(steps) ?? '', /depends on unknown step "pull"/);
});

test('portable model normalization strips exact pins but preserves intent/default routing', () => {
  const normalized = normalizeWorkflowModelPortability({
    name: 'portable-model-wf',
    description: 'Portable model test.',
    enabled: false,
    trigger: { manual: true },
    steps: [
      { id: 'draft', prompt: 'Draft.', model: 'gpt-5-codex' },
      { id: 'design', prompt: 'Design.', model: 'claude-opus-4-8', intent: 'design' },
      { id: 'lookup', prompt: 'Lookup.', model: 'gpt-5.5', call: { tool: 'SALESFORCE_GET_RECORDS', args: {} } },
      { id: 'render', prompt: 'Render.', model: 'claude-sonnet-4-6', deterministic: { runner: 'render.py' } },
    ],
  }, 'portable');

  assert.deepEqual(normalized.def.steps.map((step) => ({ id: step.id, model: step.model, intent: step.intent })), [
    { id: 'draft', model: undefined, intent: undefined },
    { id: 'design', model: undefined, intent: 'design' },
    { id: 'lookup', model: undefined, intent: undefined },
    { id: 'render', model: undefined, intent: undefined },
  ]);
  assert.equal(normalized.repairs.length, 4);
  assert.ok(normalized.repairs.some((repair) => repair.includes('portable intent routing "design"')));
  assert.ok(normalized.repairs.some((repair) => repair.includes('runs without a model')));
});

test('prepareWorkflowCreateForWrite preserves model pins unless portable mode is requested', () => {
  const def = {
    name: 'pin-preserve-wf',
    description: 'Pin preserve test.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'draft', prompt: 'Draft.', model: 'claude-opus-4-8' }],
  };

  const preserved = prepareWorkflowCreateForWrite(def);
  assert.equal(preserved.def.steps[0].model, 'claude-opus-4-8');
  assert.deepEqual(preserved.repairs.filter((repair) => repair.includes('pinned model')), []);

  const portable = prepareWorkflowCreateForWrite(def, { modelPortability: 'portable' });
  assert.equal(portable.def.steps[0].model, undefined);
  assert.ok(portable.repairs.some((repair) => repair.includes('portable default model routing')));
});

test('workflowModelPortabilityFromUnknown accepts dashboard and tool aliases', () => {
  assert.equal(workflowModelPortabilityFromUnknown({ portable_models: true }), 'portable');
  assert.equal(workflowModelPortabilityFromUnknown({ portableModels: true }), 'portable');
  assert.equal(workflowModelPortabilityFromUnknown({ modelPortability: 'portable' }), 'portable');
  assert.equal(workflowModelPortabilityFromUnknown({ model_portability: 'preserve' }), 'preserve');
  assert.equal(workflowModelPortabilityFromUnknown({}), 'preserve');
});

test('prepareWorkflowEnableForWrite keeps readiness-gap workflows disabled', () => {
  const prepared = prepareWorkflowEnableForWrite({
    name: 'gapful-send-wf',
    description: 'Send outreach.',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'send', prompt: 'Send the emails to the outside prospect list.' }],
  });
  assert.equal(prepared.status, 'readiness_gaps');
  assert.equal(prepared.def.enabled, false);
  assert.ok(prepared.gaps.some((gap) => gap.stepId === 'send'));
});

test('prepareWorkflowUpdateForWrite disables enabled updates with unresolved readiness gaps', () => {
  const before = {
    name: 'update-gap-wf',
    description: 'Draft a summary.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'draft', prompt: 'Draft a short internal note.' }],
  };
  const next = {
    ...before,
    steps: [{ id: 'send', prompt: 'Send the emails to the outside prospect list.' }],
  };
  const prepared = prepareWorkflowUpdateForWrite(before, next);
  assert.equal(prepared.status, 'readiness_gaps');
  assert.equal(prepared.def.enabled, false);
});

test('writeWorkflowAndSyncTriggers updates the event trigger registry immediately', () => {
  writeWorkflowAndSyncTriggers('event-authoring-wf', {
    name: 'event-authoring-wf',
    description: 'Handle lead events.',
    enabled: true,
    trigger: { manual: true, events: [{ type: 'authoring.lead.created', dedupeKey: 'lead-{{payload.id}}' }] },
    steps: [{ id: 'handle', prompt: 'Handle the lead.' }],
  });

  const fired = fireWorkflowSystemEvent('authoring.lead.created', { id: 'L-1' })
    .filter((result) => result.workflowName === 'event-authoring-wf');
  assert.equal(fired.length, 1);
  assert.equal(fired[0].status, 'queued');

  assert.equal(deleteWorkflowAndSyncTriggers('event-authoring-wf'), true);
  const afterDelete = fireWorkflowSystemEvent('authoring.lead.created', { id: 'L-2' })
    .filter((result) => result.workflowName === 'event-authoring-wf');
  assert.equal(afterDelete.length, 0);
});
