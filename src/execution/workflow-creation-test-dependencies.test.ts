/** Public creation-test scheduling, using controlled executors only. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-creation-dependencies-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_BRAIN_FALLOVER = 'off';
process.env.CLEMENTINE_WORKFLOW_TRANSIENT_RETRY_FLOOR = '0';
const originalFetch = globalThis.fetch;
let providerCalls = 0;
globalThis.fetch = async () => { providerCalls++; throw new Error('Controlled creation test forbids provider requests.'); };

const runner = await import('./workflow-runner.js');
const { readWorkflowEvents } = await import('./workflow-events.js');
const { workflowCapabilityAccountChoiceSet } = await import('./workflow-live-call-compiler.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');

test.afterEach(() => {
  runner._setWorkflowCallNodeForTests();
  runner._setWorkflowHarnessLoopImplsForTests();
});
test.after(() => {
  assert.equal(providerCalls, 0, 'no model/provider requests were made');
  globalThis.fetch = originalFetch;
  closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function workflow(name: string, steps: WorkflowStepInput[]): WorkflowDefinition {
  return { name, description: 'Controlled creation-test dependency fixture.', enabled: false, trigger: { manual: true }, steps };
}
function readStep(id = 'read_packet', extra: Partial<WorkflowStepInput> = {}): WorkflowStepInput {
  return { id, prompt: '', sideEffect: 'read', call: { tool: 'SALESFORCE_GET_RECORDS', args: { scope: 'controlled-fixture' } }, ...extra };
}
function literalStep(id: string, value: unknown, dependsOn: string[] = []): WorkflowStepInput {
  return { id, prompt: '', sideEffect: 'read', dependsOn,
    transform: { version: 1, expression: { op: 'literal', value } } };
}
function forbiddenModels() {
  let calls = 0;
  const forbidden = async () => { calls++; throw new Error('A dependent model must not start.'); };
  runner._setWorkflowHarnessLoopImplsForTests({ configureRuntime: forbidden as never,
    buildAgent: forbidden as never, runConversation: forbidden as never, prepareExternalCatalog: forbidden as never });
  return { assistant: { respond: forbidden } as never, calls: () => calls };
}
function statuses(result: Awaited<ReturnType<typeof runner.runCreationTest>>) {
  return Object.fromEntries(result.steps.map(step => [step.stepId, step.status]));
}

test('creation rehearsal blocks transitive transform, prompt and write descendants after a required execution error; independent branches continue', async () => {
  const name = 'creation-required-error';
  const models = forbiddenModels();
  let reads = 0;
  runner._setWorkflowCallNodeForTests(async () => { reads++; throw new Error('Controlled required input file is absent.'); });
  const outputFile = path.join(TEST_HOME, 'must-not-be-written.txt');
  const definition = workflow(name, [
    readStep(),
    literalStep('shape_packet', { wouldInventData: true }, ['read_packet']),
    { id: 'compose_review', prompt: 'Summarize the actual packet.', sideEffect: 'read', dependsOn: ['shape_packet'] },
    { id: 'save_review', prompt: '', sideEffect: 'write', dependsOn: ['compose_review'],
      call: { tool: 'write_file', args: { path: outputFile, content: '{{steps.compose_review.output}}', mode: 'overwrite' } } },
    { id: 'direct_write', prompt: 'Create a controlled unsent draft.', sideEffect: 'write', dependsOn: ['read_packet'] },
    literalStep('independent_read', { available: true }),
    { id: 'independent_write', prompt: 'Create a controlled unsent draft.', sideEffect: 'write' },
    { id: 'verify_preview', prompt: 'Read the previewed draft.', sideEffect: 'read', dependsOn: ['independent_write'] },
  ]);
  const result = await runner.runCreationTest(definition, name, `${name}-run`, {}, models.assistant);
  assert.equal(result.pass, false);
  assert.deepEqual(statuses(result), { read_packet: 'error', independent_read: 'ok', independent_write: 'previewed',
    shape_packet: 'not_run', direct_write: 'not_run', verify_preview: 'unverifiable', compose_review: 'not_run', save_review: 'not_run' });
  assert.equal(reads, 1);
  assert.equal(models.calls(), 0, 'missing required data never starts a model or its preparation');
  assert.equal(existsSync(outputFile), false);
  const started = readWorkflowEvents(name, `${name}-run`).filter(event => event.kind === 'step_started').map(event => event.stepId);
  assert.deepEqual(started, ['read_packet', 'independent_read'], 'skipped transforms and descendants have no execution journal');
});

for (const [label, output, expected] of [
  ['typed block', { blocked: true, reason: 'Controlled packet unavailable.' }, 'failed'],
  ['error envelope', { status: 'error', error: 'Controlled source could not return its packet.' }, 'failed'],
  ['absent packet', undefined, 'empty'],
] as const) {
  test(`creation rehearsal propagates the actual ${label} verdict without treating it as normal upstream data`, async () => {
    const name = `creation-output-${expected}-${label.replaceAll(' ', '-')}`;
    const models = forbiddenModels();
    runner._setWorkflowCallNodeForTests(async () => output);
    const result = await runner.runCreationTest(workflow(name, [readStep(),
      literalStep('shape_packet', { wouldInventData: true }, ['read_packet']),
      { id: 'save_review', prompt: 'Create a controlled unsent draft.', sideEffect: 'write', dependsOn: ['shape_packet'] },
      literalStep('independent', { available: true }),
    ]), name, `${name}-run`, {}, models.assistant);
    assert.equal(result.pass, false);
    assert.equal(statuses(result).read_packet, expected);
    assert.equal(statuses(result).shape_packet, 'not_run');
    assert.equal(statuses(result).save_review, 'not_run');
    assert.equal(statuses(result).independent, 'ok');
    assert.equal(models.calls(), 0);
    assert.equal(readWorkflowEvents(name, `${name}-run`).some(event => event.kind === 'step_started' && event.stepId === 'shape_packet'), false);
  });
}

test('a source that answered with nothing right now passes the rehearsal; what depends on it waits for a run with data', async () => {
  const name = 'creation-output-empty-answer';
  const models = forbiddenModels();
  runner._setWorkflowCallNodeForTests(async () => ({ records: [] }));
  const result = await runner.runCreationTest(workflow(name, [readStep(),
    literalStep('shape_packet', { wouldInventData: true }, ['read_packet']),
    { id: 'save_review', prompt: 'Create a controlled unsent draft.', sideEffect: 'write', dependsOn: ['shape_packet'] },
    literalStep('independent', { available: true }),
  ]), name, `${name}-run`, {}, models.assistant);
  assert.equal(result.pass, true);
  assert.deepEqual(statuses(result), { read_packet: 'ok', shape_packet: 'unverifiable', save_review: 'unverifiable', independent: 'ok' });
  assert.equal(result.steps.find((step) => step.stepId === 'read_packet')?.emptyAnswer, true);
  assert.match(result.steps.find((step) => step.stepId === 'save_review')?.detail ?? '', /Shape packet had nothing in it/);
  assert.equal(models.calls(), 0, 'no model starts on an empty packet');
  assert.equal(readWorkflowEvents(name, `${name}-run`).some(event => event.kind === 'step_started' && event.stepId === 'shape_packet'), false);
});

test('creation rehearsal retains the host optional-read declared gap policy, while a returned blocked gap still blocks', async () => {
  const models = forbiddenModels();
  const name = 'creation-optional-gap';
  runner._setWorkflowCallNodeForTests(async () => { throw new Error('Controlled optional enrichment unavailable.'); });
  const definition = workflow(name, [readStep('enrichment', { optional: true }), {
    id: 'use_available_data', prompt: '', sideEffect: 'read', dependsOn: ['enrichment'],
    transform: { version: 1, expression: { op: 'object', fields: [
      { key: 'receivedGap', value: { op: 'get', from: 'steps.enrichment.output.gap' } },
      { key: 'explanation', value: { op: 'get', from: 'steps.enrichment.output.reason' } },
    ] } },
  }]);
  const result = await runner.runCreationTest(definition, name, `${name}-run`, {}, models.assistant);
  assert.deepEqual(statuses(result), { enrichment: 'failed', use_available_data: 'ok' });
  assert.equal(result.pass, false, 'continuation never turns an unavailable enrichment into a clean rehearsal');
  const events = readWorkflowEvents(name, `${name}-run`);
  assert.equal(events.find(event => event.kind === 'step_completed' && event.stepId === 'enrichment')?.meta?.softFailed, true);
  assert.equal((events.find(event => event.kind === 'step_completed' && event.stepId === 'use_available_data')?.output as { receivedGap?: unknown })?.receivedGap, true);

  runner._setWorkflowCallNodeForTests(async () => ({ gap: true, blocked: true, reason: 'A returned gap is not the host optional catch.' }));
  const blocked = await runner.runCreationTest(definition, `${name}-returned`, `${name}-returned-run`, {}, models.assistant);
  assert.deepEqual(statuses(blocked), { enrichment: 'failed', use_available_data: 'not_run' });
  assert.equal(models.calls(), 0);
});

test('creation rehearsal keeps normal records usable and preserves successful write preview readback semantics', async () => {
  const models = forbiddenModels();
  runner._setWorkflowCallNodeForTests(async () => ({ records: [{ id: 'fixture-1', status: 'blocked' }] }));
  const name = 'creation-normal-records';
  const result = await runner.runCreationTest(workflow(name, [readStep(), {
    id: 'retain_packet', prompt: '', sideEffect: 'read', dependsOn: ['read_packet'],
    transform: { version: 1, expression: { op: 'get', from: 'steps.read_packet.output' } },
  }, { id: 'save_review', prompt: 'Create a controlled unsent draft.', sideEffect: 'write', dependsOn: ['retain_packet'] },
  { id: 'verify_write', prompt: 'Read the saved draft.', sideEffect: 'read', dependsOn: ['save_review'] },
  ]), name, `${name}-run`, {}, models.assistant);
  assert.equal(result.pass, true);
  assert.deepEqual(statuses(result), { read_packet: 'ok', retain_packet: 'ok', save_review: 'previewed', verify_write: 'unverifiable' });
  assert.equal(models.calls(), 0);
});

test('creation rehearsal propagates a refused write-preparation verdict instead of calling its dependent read unverifiable', async () => {
  const models = forbiddenModels();
  const name = 'creation-write-preparation-failed';
  const result = await runner.runCreationTest(workflow(name, [
    { id: 'save_review', prompt: '', sideEffect: 'write', call: { tool: 'write_file', args: {
      path: { invalid: 'a path must be text' }, content: 'Controlled unsent content.', mode: 'overwrite',
    } } },
    { id: 'verify_write', prompt: 'Read the saved draft.', sideEffect: 'read', dependsOn: ['save_review'] },
    { id: 'followup_write', prompt: 'Create a controlled unsent draft.', sideEffect: 'write', dependsOn: ['verify_write'] },
    literalStep('independent', { available: true }),
  ]), name, `${name}-run`, {}, models.assistant);
  assert.equal(result.pass, false);
  assert.deepEqual(statuses(result), { save_review: 'error', independent: 'ok', verify_write: 'not_run', followup_write: 'not_run' });
  assert.equal(models.calls(), 0);
});

for (const [reason, expected] of [
  ['not-connected', 'needs_connection'],
  ['connection-check-unavailable', 'not_run'],
] as const) {
  test(`creation rehearsal retains ${expected} control flow and blocks dependent writes even when the read is optional`, async () => {
    const models = forbiddenModels();
    const name = `creation-capability-${reason}`;
    runner._setWorkflowCallNodeForTests(async step => { throw new runner.WorkflowCapabilityBlockedError({ stepId: step.id,
      tool: step.call!.tool, toolkit: 'fixture', reason, message: 'Controlled capability is unavailable; nothing dispatched.' }); });
    const result = await runner.runCreationTest(workflow(name, [readStep('read_packet', { optional: true }),
      { id: 'dependent_write', prompt: 'Create a controlled unsent draft.', sideEffect: 'write', dependsOn: ['read_packet'] },
      literalStep('independent', { available: true }),
    ]), name, `${name}-run`, {}, models.assistant);
    assert.equal(result.pass, false);
    assert.deepEqual(statuses(result), { read_packet: expected, independent: 'ok', dependent_write: 'not_run' });
    assert.equal(models.calls(), 0);
  });
}

test('creation rehearsal preserves an exact account-choice question and never previews its dependent write', async () => {
  const models = forbiddenModels();
  const name = 'creation-account-choice';
  const choiceSet = workflowCapabilityAccountChoiceSet([
    { capabilityId: 'cap:fixture:account-a', account: 'account-a' },
    { capabilityId: 'cap:fixture:account-b', account: 'account-b' },
  ]);
  runner._setWorkflowCallNodeForTests(async step => { throw new runner.WorkflowCapabilityBlockedError({ stepId: step.id,
    tool: step.call!.tool, toolkit: 'fixture', reason: 'ambiguous-account', accountChoiceSet: choiceSet,
    message: 'Choose the exact controlled account; nothing dispatched.' }); });
  const result = await runner.runCreationTest(workflow(name, [readStep(),
    { id: 'dependent_write', prompt: 'Create a controlled unsent draft.', sideEffect: 'write', dependsOn: ['read_packet'] },
    literalStep('independent', { available: true }),
  ]), name, `${name}-run`, {}, models.assistant);
  assert.equal(result.pass, false);
  assert.deepEqual(statuses(result), { read_packet: 'needs_choice', independent: 'ok', dependent_write: 'not_run' });
  assert.equal(result.steps.find(step => step.stepId === 'read_packet')?.block?.accountChoiceSet?.digest, choiceSet.digest);
  assert.match(result.steps.find(step => step.stepId === 'read_packet')?.detail ?? '', /account-a/);
  assert.match(result.steps.find(step => step.stepId === 'read_packet')?.detail ?? '', /account-b/);
  assert.equal(models.calls(), 0);
});
