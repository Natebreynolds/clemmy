/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-step-effect-reading.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-step-effect-reading-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMENTINE_WORKFLOW_CANCEL_POLL_MS = '100';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const reading = await import('./workflow-step-effect-reading.js');
const enforce = await import('./workflow-enforce.js');
const { BASE_DIR } = await import('../config.js');

test.after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

const draftStep = (prompt = 'Create one unsent email draft to me with the note below as its body.') => ({
  id: 'stage_draft', prompt, usesSkill: 'house-style', allowedTools: ['task_list'],
});

test('an unmarked prompt step is read once per exact version and an unchanged rerun reads nothing', async () => {
  reading._resetWorkflowStepEffectReadingsForTests();
  const asked: string[] = [];
  reading._setWorkflowStepEffectReaderForTests(async (user) => { asked.push(user); return { effect: 'write' }; });
  mkdirSync(path.join(BASE_DIR, 'skills', 'house-style'), { recursive: true });
  writeFileSync(path.join(BASE_DIR, 'skills', 'house-style', 'SKILL.md'), '---\nname: house-style\n---\nBe brief.');
  try {
    const step = draftStep();
    assert.equal(enforce.classifyStepSideEffect(step), 'read', 'before any reading, the wording guess misses this write');
    assert.equal(await reading.ensureWorkflowStepEffectsRead({ steps: [step] }), 1);
    assert.equal(reading.savedStepEffect(step), 'write');
    assert.equal(enforce.classifyStepSideEffect(step), 'write');
    assert.equal(enforce.stepLooksMutating(step), true, 'the rehearsal previews it');

    assert.equal(await reading.ensureWorkflowStepEffectsRead({ steps: [step] }), 0, 'an unchanged rerun makes no reading');

    const edited = draftStep('Create one unsent email draft to me, signed "Clem".');
    assert.equal(reading.savedStepEffect(edited), undefined, 'an edited prompt is a new version');
    assert.equal(await reading.ensureWorkflowStepEffectsRead({ steps: [edited] }), 1);

    writeFileSync(path.join(BASE_DIR, 'skills', 'house-style', 'SKILL.md'), '---\nname: house-style\n---\nBe brief and warm.');
    assert.equal(reading.savedStepEffect(step), undefined, 'a changed skill invalidates the reading');
    assert.equal(await reading.ensureWorkflowStepEffectsRead({ steps: [step] }), 1);

    const marked = { ...step, sideEffect: 'read' as const };
    const call = { id: 'c', call: { tool: 'write_file' }, prompt: '' };
    assert.equal(await reading.ensureWorkflowStepEffectsRead({ steps: [marked, call] }), 0, 'declared and structured steps are never read');
    assert.equal(asked.length, 3);
    assert.match(asked[0]!, /Be brief/, 'the exact effective skill body is read, not only its name');
    assert.equal(JSON.parse(asked[0]!).tools[0].definition.name, 'task_list');
  } finally {
    reading._setWorkflowStepEffectReaderForTests(null);
  }
});

test('an unavailable reading has no guessed read pass and is attempted once per activation', async () => {
  reading._resetWorkflowStepEffectReadingsForTests();
  reading._setWorkflowStepEffectReaderForTests(async () => { throw new Error('model unavailable'); });
  try {
    const step = draftStep('Summarize the attached notes.');
    const state = reading.createWorkflowStepEffectPreparation();
    for (let i = 0; i < 2; i++) await assert.rejects(reading.ensureWorkflowStepEffectsRead({ steps: [step] }, state),
      error => error instanceof reading.WorkflowStepEffectUnavailableError);
    assert.equal(reading.workflowStepEffectReadsMade(), 1, 'an outer/inner caller cannot spend another failed reading');
    assert.equal(reading.savedStepEffect(step), undefined);
    reading._setWorkflowStepEffectReaderForTests(async () => ({ effect: 'read' }));
    assert.equal(await reading.ensureWorkflowStepEffectsRead({ steps: [step] }), 1, 'a new explicit activation can retry the unchanged saved version');
  } finally {
    reading._setWorkflowStepEffectReaderForTests(null);
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('one consumer can Stop a shared exact reading without cancelling another run', async () => {
  const entered = deferred<void>(); const answer = deferred<unknown>();
  let producerSignal!: AbortSignal; let calls = 0;
  reading._setWorkflowStepEffectReaderForTests(async (_user, controls) => {
    calls++; producerSignal = controls.signal; entered.resolve(); return answer.promise;
  });
  const a = new AbortController(); const b = new AbortController();
  const step = draftStep('A shared consumer fixture creates an unsent draft.');
  const first = reading.ensureWorkflowStepEffectsRead({ steps: [step] }, reading.createWorkflowStepEffectPreparation({ signal: a.signal }));
  void first.catch(() => {});
  await entered.promise;
  const second = reading.ensureWorkflowStepEffectsRead({ steps: [step] }, reading.createWorkflowStepEffectPreparation({ signal: b.signal }));
  await tick();
  const stopped = new Error('controlled first owner Stop'); a.abort(stopped);
  await assert.rejects(first, error => error === stopped);
  assert.equal(producerSignal.aborted, false);
  answer.resolve({ effect: 'write' });
  assert.equal(await second, 0, 'the second owner shares the existing physical reading');
  assert.equal(calls, 1);
  assert.equal(reading.savedStepEffect(step), 'write');
  reading._setWorkflowStepEffectReaderForTests(null);
});

test('Stop releases the last consumer, aborts its producer and cannot cache a late reply or start another step', async () => {
  const entered = deferred<void>(); const answer = deferred<unknown>();
  const controller = new AbortController(); let signal!: AbortSignal; let calls = 0;
  reading._setWorkflowStepEffectReaderForTests(async (_user, controls) => {
    calls++; signal = controls.signal; entered.resolve(); return answer.promise;
  });
  const first = draftStep('A last-consumer fixture creates an unsent draft.');
  const second = draftStep('This later fixture must never be read after Stop.');
  const running = reading.ensureWorkflowStepEffectsRead({ steps: [first, second] },
    reading.createWorkflowStepEffectPreparation({ signal: controller.signal }));
  void running.catch(() => {});
  await entered.promise;
  controller.abort(new Error('controlled last owner Stop'));
  await assert.rejects(running, /controlled last owner Stop/);
  assert.equal(signal.aborted, true);
  answer.resolve({ effect: 'read' });
  await tick(); await tick();
  assert.equal(reading.savedStepEffect(first), undefined);
  assert.equal(reading.savedStepEffect(second), undefined);
  assert.equal(calls, 1);
  reading._setWorkflowStepEffectReaderForTests(null);
});

test('one preparation deadline bounds the whole step sequence even when the reader ignores abort', async () => {
  let calls = 0; let signal!: AbortSignal;
  reading._setWorkflowStepEffectReaderForTests(async (_user, controls) => {
    calls++; signal = controls.signal; return new Promise(() => {});
  });
  const first = draftStep('A bounded preparation fixture creates an unsent draft.');
  const started = Date.now();
  await assert.rejects(reading.ensureWorkflowStepEffectsRead({ steps: [first, draftStep('Unreached after deadline.')] },
    reading.createWorkflowStepEffectPreparation({ deadlineAt: Date.now() + 40 })),
  error => error instanceof reading.WorkflowStepEffectUnavailableError && error.reason === 'deadline');
  assert.ok(Date.now() - started < 2_000);
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
  assert.equal(reading.savedStepEffect(first), undefined);
  reading._setWorkflowStepEffectReaderForTests(null);
});

test('the effective packet includes hidden skill and tool effects and the complete prompt suffix', async () => {
  mkdirSync(path.join(BASE_DIR, 'skills', 'effect-alias'), { recursive: true });
  mkdirSync(path.join(BASE_DIR, 'skills', 'effect-canonical'), { recursive: true });
  writeFileSync(path.join(BASE_DIR, 'skills', 'effect-alias', 'SKILL.md'), '---\nname: effect-alias\nsupersededBy: effect-canonical\n---\nRetired instructions must not execute.');
  writeFileSync(path.join(BASE_DIR, 'skills', 'effect-canonical', 'SKILL.md'), '---\nname: effect-canonical\ndescription: hidden mutation fixture\n---\nCreate an unsent email draft.');
  let packet: Record<string, any> | undefined;
  reading._setWorkflowStepEffectReaderForTests(async user => {
    packet = JSON.parse(user);
    assert.match(packet!.skill.body, /Create an unsent email draft/);
    assert.equal(packet!.skill.name, 'effect-canonical');
    assert.equal(packet!.tools[0].definition.sideEffect, 'write');
    assert.match(packet!.prompt, /decisive suffix: create a local file/);
    return { effect: 'write' };
  });
  const step = { id: 'hidden-effects', prompt: `${'context '.repeat(1_000)}decisive suffix: create a local file.`,
    usesSkill: 'effect-alias', allowedTools: ['write_file'] };
  assert.equal(await reading.ensureWorkflowStepEffectsRead({ steps: [step] }), 1);
  assert.equal(reading.savedStepEffect(step), 'write');
  writeFileSync(path.join(BASE_DIR, 'skills', 'effect-canonical', 'SKILL.md'), '---\nname: effect-canonical\n---\nRead the existing draft only.');
  assert.equal(reading.savedStepEffect(step), undefined, 'a changed canonical replacement invalidates an alias-bound reading');
  reading._setWorkflowStepEffectReaderForTests(null);
});

test('missing definitions, oversized instructions and malformed answers do not become cached read results', async () => {
  let calls = 0;
  reading._setWorkflowStepEffectReaderForTests(async () => { calls++; return { effect: 'not-an-effect' }; });
  for (const step of [
    { id: 'missing-definition', prompt: 'Use the missing tool.', allowedTools: ['fixture_tool_not_installed_here'] },
    { id: 'oversized', prompt: 'x'.repeat(140_000) },
    { id: 'malformed-answer', prompt: 'An independent malformed answer fixture.' },
  ]) {
    await assert.rejects(reading.ensureWorkflowStepEffectsRead({ steps: [step] }), error => error instanceof reading.WorkflowStepEffectUnavailableError);
    assert.equal(reading.savedStepEffect(step), undefined);
  }
  assert.equal(calls, 1, 'missing or truncated semantics never reach the classifier');
  reading._setWorkflowStepEffectReaderForTests(null);
});

test('an unavailable unmarked draft rehearsal runs no step and preserves its saved definition', async () => {
  const runner = await import('./workflow-runner.js');
  const workflows = await import('../memory/workflow-store.js');
  let executions = 0;
  const saved = workflows.writeWorkflow('unavailable-effect-draft', { name: 'Unavailable effect draft', description: 'Controlled unavailable classification fixture.', enabled: false,
    trigger: { manual: true }, steps: [{ id: 'draft', prompt: 'Create one unsent draft from this controlled fixture.' }] });
  const before = workflows.readWorkflow(saved.name)!.data;
  reading._setWorkflowStepEffectReaderForTests(async () => { throw new Error('controlled unavailable reader'); });
  const result = await runner.runCreationTest(saved.data, saved.name, 'unavailable-effect-draft-run', {},
    { respond: async () => { executions++; throw new Error('execution forbidden'); } } as never);
  assert.equal(result.pass, false);
  assert.equal(result.steps[0]!.status, 'not_run');
  assert.match(result.steps[0]!.detail!, /Test this saved version again/);
  assert.equal(executions, 0);
  assert.deepEqual(workflows.readWorkflow(saved.name)!.data, before);
  reading._setWorkflowStepEffectReaderForTests(null);
});

test('the exact run Stop watcher cancels preparation and leaves a concurrent run sharing its read alive', async () => {
  const runner = await import('./workflow-runner.js');
  const { requestWorkflowRunCancellation } = await import('./workflow-run-cancellation.js');
  const entered = deferred<void>(); const answer = deferred<unknown>();
  let producerSignal!: AbortSignal; let calls = 0;
  reading._setWorkflowStepEffectReaderForTests(async (_user, controls) => {
    calls++; producerSignal = controls.signal; entered.resolve(); return answer.promise;
  });
  const workflow = { name: 'Concurrent preparation Stop fixture', enabled: false, trigger: { manual: true },
    steps: [{ id: 'draft', prompt: 'Create a controlled draft for the exact Stop watcher fixture.' }] };
  const assistant = { respond: async () => { throw new Error('a preview must never execute'); } } as never;
  const first = runner.runCreationTest(workflow, 'concurrent-preparation-stop', 'preparation-stop-owner', {}, assistant);
  void first.catch(() => {});
  await entered.promise;
  const second = runner.runCreationTest(workflow, 'concurrent-preparation-stop', 'preparation-remaining-owner', {}, assistant);
  await tick();
  requestWorkflowRunCancellation('preparation-stop-owner', 'Controlled Stop during preparation.', 'fixture');
  await assert.rejects(first, error => error instanceof Error && error.name === 'WorkflowRunCancelledError');
  assert.equal(producerSignal.aborted, false);
  answer.resolve({ effect: 'write' });
  const result = await second;
  assert.equal(result.pass, true, JSON.stringify(result));
  assert.equal(result.steps[0]!.status, 'previewed');
  assert.equal(calls, 1);
  reading._setWorkflowStepEffectReaderForTests(null);
});

test('a durable Stop arriving with a model reply wins before the watcher poll and cannot cache that reply', async () => {
  const runner = await import('./workflow-runner.js');
  const { requestWorkflowRunCancellation } = await import('./workflow-run-cancellation.js');
  const runId = 'preparation-stop-before-poll';
  const step = { id: 'late-draft', prompt: 'Create the controlled draft whose Stop arrives with its classification reply.' };
  reading._setWorkflowStepEffectReaderForTests(async () => {
    requestWorkflowRunCancellation(runId, 'Controlled Stop before the next cancellation poll.', 'fixture');
    return { effect: 'read' };
  });
  await assert.rejects(runner.runCreationTest({ name: 'Stop before poll', description: 'Controlled Stop fixture.', enabled: false,
    trigger: { manual: true }, steps: [step] }, 'stop-before-poll', runId, {},
  { respond: async () => { throw new Error('no step may execute'); } } as never),
  error => error instanceof Error && error.name === 'WorkflowRunCancelledError');
  assert.equal(reading.savedStepEffect(step), undefined);
  reading._setWorkflowStepEffectReaderForTests(null);
});


test('inherited workflow tools bind the reading and explicit step tools retain their own exact scope', async () => {
  let packet: Record<string, any> | undefined;
  reading._setWorkflowStepEffectReaderForTests(async user => { packet = JSON.parse(user); return { effect: 'write' }; });
  try {
    for (const allowedTools of [undefined, []]) {
      const step = { id: 'inherited', prompt: `Use the inherited fixture tool ${allowedTools ? 'empty' : 'absent'}.`, allowedTools };
      const workflow = { steps: [step], allowedTools: ['write_file'] };
      await reading.ensureWorkflowStepEffectsRead(workflow);
      assert.equal(packet!.tools[0].definition.sideEffect, 'write', 'hidden inherited write metadata is read');
      reading.withWorkflowStepEffectExecutionContext(() => workflow, () => {
        assert.equal(enforce.classifyStepSideEffect(step), 'write');
        workflow.allowedTools = ['task_list'];
        assert.equal(reading.savedStepEffect(step), undefined);
        assert.throws(() => enforce.classifyStepSideEffect(step), reading.WorkflowStepEffectUnavailableError,
          'execution cannot restore a prose/read guess after inherited tools change');
      });
    }
    const step = { id: 'override', prompt: 'Use the exact explicit fixture tools.', allowedTools: ['task_list'] };
    const workflow = { steps: [step], allowedTools: ['write_file'] };
    await reading.ensureWorkflowStepEffectsRead(workflow);
    assert.equal(packet!.tools[0].name, 'task_list');
    workflow.allowedTools = ['fixture_unused_tool'];
    assert.equal(reading.savedStepEffect(step, workflow), 'write', 'unused parent tools do not invalidate an explicit step override');
  } finally { reading._setWorkflowStepEffectReaderForTests(null); }
});

test('current external description, effect and schema invalidate readings without exposing account identity', async () => {
  const { recordCapabilityOperations } = await import('../memory/capability-index.js');
  const { rememberToolSchema } = await import('../tools/composio-schema-cache.js');
  const name = 'FIXTURE_EFFECT_OPERATION';
  const base = { identifier: name, carrierKind: 'composio' as const, carrier: 'fixture', displayName: 'Controlled operation',
    description: 'Return the current controlled record.', effectClass: 'read' as const, effectProvenance: 'declared' as const,
    accountIdentity: 'private-account-not-for-classification' };
  recordCapabilityOperations([base]);
  rememberToolSchema(name, { type: 'object', properties: { record: { type: 'string' } } });
  const step = { id: 'external-semantic-drift', prompt: 'Use the controlled operation.', allowedTools: [name] };
  const workflow = { steps: [step] };
  const packets: string[] = [];
  reading._setWorkflowStepEffectReaderForTests(async user => { packets.push(user); return { effect: 'read' }; });
  try {
    await reading.ensureWorkflowStepEffectsRead(workflow);
    assert.doesNotMatch(packets[0]!, /private-account-not-for-classification|accountIdentity|account_identity/);
    recordCapabilityOperations([{ ...base, description: 'Update the controlled record, then return it.' }]);
    assert.equal(reading.savedStepEffect(step), undefined, 'same-schema behavior description changes are new semantics');
    reading.withWorkflowStepEffectExecutionContext(() => workflow, () => {
      assert.throws(() => enforce.stepLooksMutating(step), reading.WorkflowStepEffectUnavailableError);
    });
    await reading.ensureWorkflowStepEffectsRead(workflow);
    assert.match(packets[1]!, /Update the controlled record/);
    recordCapabilityOperations([{ ...base, description: 'Update the controlled record, then return it.', effectClass: 'write' }]);
    assert.equal(reading.savedStepEffect(step), undefined, 'same-description effect changes invalidate too');
    await reading.ensureWorkflowStepEffectsRead(workflow);
    rememberToolSchema(name, { type: 'object', properties: { record: { type: 'number' } } });
    assert.equal(reading.savedStepEffect(step), undefined, 'the current input contract remains part of the same packet');
  } finally { reading._setWorkflowStepEffectReaderForTests(null); }
});

test('capped or missing external semantics cannot become a read and give an available saved-step repair', async () => {
  const { recordCapabilityOperations } = await import('../memory/capability-index.js');
  const { rememberToolSchema } = await import('../tools/composio-schema-cache.js');
  let calls = 0;
  reading._setWorkflowStepEffectReaderForTests(async () => { calls++; return { effect: 'read' }; });
  try {
    for (const [name, description] of [['FIXTURE_CAPPED_EFFECT', 'x'.repeat(610) + 'send the message'], ['FIXTURE_MISSING_EFFECT', '']]) {
      recordCapabilityOperations([{ identifier: name!, carrierKind: 'mcp', carrier: 'fixture', displayName: name!, description: description!,
        effectClass: 'unknown', effectProvenance: 'none' }]);
      rememberToolSchema(name!, { type: 'object', properties: {} });
      const step = { id: name!, prompt: 'Use the controlled external tool.', allowedTools: [name!] };
      await assert.rejects(reading.ensureWorkflowStepEffectsRead({ steps: [step] }), error => {
        assert.ok(error instanceof reading.WorkflowStepEffectUnavailableError);
        assert.match(error.message, /declare the step read\/write\/send/);
        return true;
      });
      assert.equal(reading.savedStepEffect(step), undefined);
    }
    assert.equal(calls, 0);
  } finally { reading._setWorkflowStepEffectReaderForTests(null); }
});

test('a rehearsal cannot execute a later unmarked step after its effective skill changes mid-run', async () => {
  const runner = await import('./workflow-runner.js');
  const skillDir = path.join(BASE_DIR, 'skills', 'mid-run-effect-drift');
  mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  writeFileSync(skillPath, '---\nname: mid-run-effect-drift\n---\nRead the controlled note.');
  let modelEntries = 0;
  reading._setWorkflowStepEffectReaderForTests(async () => ({ effect: 'read' }));
  runner._setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    buildAgent: (async () => ({})) as never,
    prepareExternalCatalog: async () => ({ status: 'ready', manifestIds: [], operationIds: [], catalogIdentities: [] }),
    runConversation: (async (request: { sessionId: string }) => {
      modelEntries++;
      writeFileSync(skillPath, '---\nname: mid-run-effect-drift\n---\nCreate an unsent draft from the controlled note.');
      return { sessionId: request.sessionId, status: 'completed', steps: 1, lastTurn: 1,
        lastDecision: { summary: 'Controlled first read.', reply: 'Controlled first read.', done: true, nextAction: 'completed' } };
    }) as never,
  });
  try {
    const workflow = { name: 'Mid-run semantic drift', description: 'Controlled skill drift fixture.', enabled: false,
      trigger: { manual: true }, allowedTools: ['task_list'], steps: [
        { id: 'first-read', prompt: 'Read the first controlled note.', sideEffect: 'read' as const },
        { id: 'second-read', prompt: 'Handle the next controlled note.', usesSkill: 'mid-run-effect-drift', dependsOn: ['first-read'] },
      ] };
    await assert.rejects(runner.runCreationTest(workflow, 'mid-run-effect-drift', 'mid-run-effect-drift-run', {},
      { respond: async () => { throw new Error('legacy execution forbidden'); } } as never), reading.WorkflowStepEffectUnavailableError);
    assert.equal(modelEntries, 1, 'only the first controlled read reaches execution; changed later skill cannot run');
  } finally {
    reading._setWorkflowStepEffectReaderForTests(null);
    runner._setWorkflowHarnessLoopImplsForTests();
  }
});
