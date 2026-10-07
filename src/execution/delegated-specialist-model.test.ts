/** Controlled local fixtures; every response executor is injected. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-specialist-model-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
const tasks = await import('./background-tasks.js');
const { enqueueDurableChatTask } = await import('./background-promote.js');
const { resolveTaskDelegation, resolveDelegatedAgentModel } = await import('../projects/task-delegation.js');
const { settleOpenAgentChoice, _setOpenAgentChooserForTests, InheritedAgentModelUnavailableError } = await import('../projects/inherited-delegation.js');
const projects = await import('../projects/project-record.js');
const { setSessionProject } = await import('../projects/session-project.js');
const { setSessionAgent } = await import('../agents/session-agent.js');
const { createAgentRecord } = await import('../agents/agent-record.js');
const { createSession, closeEventLog } = await import('../runtime/harness/eventlog.js');
const { resolveRoleModel } = await import('../runtime/harness/model-roles.js');

beforeEach(() => {
  for (const task of tasks.listBackgroundTasks({ includeArchived: true })) tasks.archiveBackgroundTask(task.id);
  tasks._setBackgroundResponseExecutorForTests(() => { throw new Error('Unexpected model activation'); });
  _setOpenAgentChooserForTests(null);
});
after(() => {
  tasks._setBackgroundResponseExecutorForTests(null);
  _setOpenAgentChooserForTests(null);
  projects._closeProjectStoreForTests();
  closeEventLog();
  rmSync(fixtureHome, { recursive: true, force: true });
});

function agent(name: string, model?: string) {
  const made = createAgentRecord({ name, model });
  assert.ok(made.ok); if (!made.ok) throw new Error('Fixture agent not created');
  return made.agent;
}
function delegation(saved: ReturnType<typeof agent>) {
  return { agentId: saved.id, agentName: saved.name, agentCreatedAt: saved.createdAt,
    projectId: null, projectName: null, assignedBy: 'owner' as const };
}
async function unavailableRole(work: () => void | Promise<void>) {
  const keys = ['AUTH_MODE', 'MODEL_ROUTING_MODE', 'BYO_MODEL_BASE_URL', 'BYO_MODEL_API_KEY',
    'BYO_MODEL_ID', 'BYO_MODEL_JUDGE_ID', 'BYO_PROVIDERS', 'OPENAI_MODEL_WORKER', 'CLEMMY_DEBATE_JUDGE',
    'CLEMMY_MODEL_ROLES_REGISTRY', 'CLEMMY_MODEL_ROLES'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = '';
  Object.assign(process.env, { AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', CLEMMY_MODEL_ROLES_REGISTRY: 'on',
    CLEMMY_MODEL_ROLES: JSON.stringify(['worker', 'writer', 'judge'].map(role => ({ role,
      modelId: 'deepseek-chat', scope: 'durable', source: 'settings' }))) });
  try { await work(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
const assistant = { getRuntime: () => ({}) } as never;
const complete = (request: { sessionId?: string }) => ({ text: 'Done. Controlled fixture saved.',
  sessionId: request.sessionId, stoppedReason: 'success' as const });

test('saved unavailable roles refuse their healthy defaults before named dispatch or fresh inherited enqueue', async () => {
  const origin = createSession({ id: 'unavailable-specialist-origin', kind: 'chat' });
  await unavailableRole(async () => {
    for (const role of ['worker', 'judge', 'writer'] as const) {
      const saved = agent(`Unavailable background ${role}`, role);
      assert.equal(resolveRoleModel(role).inactiveBinding?.modelId, 'deepseek-chat');
      assert.notEqual(resolveRoleModel(role).modelId, 'deepseek-chat');
      const before = tasks.listBackgroundTasks({ includeArchived: true }).length;
      const resolved = await resolveTaskDelegation({ sessionId: origin.id, objective: 'Controlled fixture', agent: saved.id });
      assert.equal(resolved.kind, 'refuse');
      if (resolved.kind === 'refuse') assert.match(resolved.reason, /deepseek-chat.*unavailable/);
      assert.equal(setSessionAgent(origin.id, saved.id, { by: 'owner' }).ok, true);
      assert.throws(() => enqueueDurableChatTask({ sessionId: origin.id, message: 'Controlled fixture', source: 'desktop' }),
        InheritedAgentModelUnavailableError);
      assert.equal(tasks.listBackgroundTasks({ includeArchived: true }).length, before, 'no task is enqueued on refusal');
    }
  });
});

test('saved literal and canonical role models retain exact pins while generic unpinned work stays unpinned', () => {
  const roleModel = (() => ({ modelId: 'glm-5.3', provider: 'byo', source: 'settings' })) as typeof resolveRoleModel;
  assert.deepEqual(resolveDelegatedAgentModel({ name: 'Configured specialist', model: 'worker' }, false, roleModel),
    { kind: 'bound', model: 'glm-5.3', executionModelPin: { modelId: 'glm-5.3', savedModel: 'worker' } });
  assert.deepEqual(resolveDelegatedAgentModel({ name: 'Literal specialist', model: 'glm-5.2' }),
    { kind: 'bound', model: 'glm-5.2', executionModelPin: { modelId: 'glm-5.2', savedModel: 'glm-5.2' } },
    'no new historical alias migration is invented');
  assert.deepEqual(resolveDelegatedAgentModel({ name: 'Unpinned agent', model: null }, true, roleModel), { kind: 'bound' });
  assert.equal(resolveDelegatedAgentModel({ name: 'Unverifiable saved role', model: 'writer' }, true,
    (() => { throw new Error('Role unavailable'); }) as typeof resolveRoleModel).kind, 'refuse');
});

test('fresh named-session promotion persists its pin and activation uses it despite mutable task model drift', async () => {
  const saved = agent('Fresh inherited specialist', 'claude-sonnet-4-6');
  const origin = createSession({ id: 'fresh-inherited-model-origin', kind: 'chat' });
  setSessionAgent(origin.id, saved.id, { by: 'owner' });
  const task = enqueueDurableChatTask({ sessionId: origin.id, message: 'Controlled local fixture', source: 'desktop' });
  const pin = { modelId: 'claude-sonnet-4-6', savedModel: 'claude-sonnet-4-6' };
  assert.deepEqual(tasks.getBackgroundTask(task.id)?.delegation?.executionModelPin, pin);
  assert.equal(task.model, pin.modelId);
  tasks.updateBackgroundTask(task.id, { model: 'gpt-5.5' });
  tasks.reviseBackgroundTaskContract(task.id, { instruction: 'Keep the controlled scope.' });
  const seen: unknown[] = [];
  tasks._setBackgroundResponseExecutorForTests((_assistant, request, retainedPin) => {
    seen.push([request.model, retainedPin]); return Promise.resolve(complete(request));
  });
  assert.equal(await tasks.processBackgroundTasks(assistant, 1), 1);
  assert.deepEqual(seen, [['claude-sonnet-4-6', pin]]);
  assert.deepEqual(tasks.getBackgroundTask(task.id)?.delegation?.executionModelPin, pin, 'contract revisions retain the original pin');
});

test('fresh open selection binds the saved pin and unavailable selection parks without activating unassigned', async () => {
  const made = projects.createProject({ name: 'Specialist model fixture' });
  assert.ok(made.ok); if (!made.ok) return;
  const saved = agent('Open-choice specialist', 'writer');
  projects.saveAssignment(made.project.id, { agentId: saved.id, agentCreatedAt: saved.createdAt });
  const origin = createSession({ id: 'open-specialist-model-origin', kind: 'chat' });
  setSessionProject(origin.id, made.project.id, { by: 'owner' });
  _setOpenAgentChooserForTests(async () => ({ id: saved.id }));
  const task = enqueueDurableChatTask({ sessionId: origin.id, message: 'Controlled open-choice fixture', source: 'desktop' });
  const selected = await settleOpenAgentChoice(task);
  assert.equal(selected.delegation.executionModelPin?.savedModel, 'writer');
  assert.equal(selected.model, selected.delegation.executionModelPin?.modelId);
  await unavailableRole(async () => {
    let choices = 0;
    _setOpenAgentChooserForTests(async () => { choices++; return { id: saved.id }; });
    assert.equal(await tasks.processBackgroundTasks(assistant, 1), 1);
    const parked = tasks.getBackgroundTask(task.id)!;
    assert.equal(parked.status, 'awaiting_input');
    assert.equal(parked.error, 'saved_agent_model_unavailable');
    assert.equal(parked.delegation?.agentChoice, undefined, 'the chosen unavailable specialist is settled once');
    assert.equal(parked.delegation?.agentId, saved.id);
    assert.deepEqual(parked.delegation?.executionModelPin, { modelId: 'deepseek-chat', savedModel: 'writer' },
      'the exact unavailable model is retained instead of the healthy default');
    assert.match(parked.delegation?.modelBindingRefusal ?? '', /start a new task/);
    const reopened = tasks.getBackgroundTask(task.id)!;
    assert.deepEqual(reopened.delegation, parked.delegation, 'closed identity and refusal reopen from durable task storage');
    assert.equal(tasks.queueBackgroundTaskInputResolution(reopened.pendingQuestionId!, 'Continue')?.status, 'pending');
    _setOpenAgentChooserForTests(async () => { choices++; throw new Error('Settled specialist must not be chosen again'); });
    assert.equal(await tasks.processBackgroundTasks(assistant, 1), 1);
    assert.equal(tasks.getBackgroundTask(task.id)?.status, 'awaiting_input');
    assert.deepEqual(tasks.getBackgroundTask(task.id)?.delegation, parked.delegation);
    assert.equal(choices, 1, 'Continue cannot choose a substitute or pay for another classifier');
  });
});

test('genuine foreground handoff retains its accepted model even when the current saved role is unavailable', async () => {
  const saved = agent('Handoff specialist', 'writer');
  const origin = createSession({ id: 'handoff-specialist-model-origin', kind: 'chat' });
  setSessionAgent(origin.id, saved.id, { by: 'owner' });
  await unavailableRole(async () => {
    const task = enqueueDurableChatTask({ sessionId: origin.id, message: 'Accepted foreground fixture', source: 'desktop',
      model: 'claude-sonnet-4-6', foregroundHandoff: { sessionId: origin.id, attemptId: 'accepted-foreground', sourceUserSeq: 1, throughSeq: 1 } });
    assert.equal(task.model, 'claude-sonnet-4-6');
    assert.equal(task.delegation?.executionModelPin, undefined, 'mutable role settings do not repin an accepted handoff');
    const made = projects.createProject({ name: 'Accepted open handoff fixture' });
    assert.ok(made.ok); if (!made.ok) return;
    projects.saveAssignment(made.project.id, { agentId: saved.id, agentCreatedAt: saved.createdAt });
    _setOpenAgentChooserForTests(async () => ({ id: saved.id }));
    const selected = await settleOpenAgentChoice({ ...task,
      delegation: { agentId: null, agentName: null, agentCreatedAt: null, projectId: made.project.id,
        projectName: made.project.name, assignedBy: 'clem', agentChoice: 'open' } });
    assert.equal(selected.refusal, undefined);
    assert.equal(selected.model, undefined, 'accepted checkpoint model is preserved by the caller');
    assert.equal(selected.delegation.executionModelPin, undefined);
  });
});

test('legacy positively identified specialist without retained pin parks; generic model alone never does', async () => {
  const saved = agent('Legacy saved specialist', 'claude-sonnet-4-6');
  const legacy = tasks.createBackgroundTask({ title: 'Legacy specialist', prompt: 'Controlled legacy fixture', source: 'desktop',
    model: 'gpt-5.5', delegation: delegation(saved) });
  assert.equal(await tasks.processBackgroundTasks(assistant, 1), 1);
  assert.equal(tasks.getBackgroundTask(legacy.id)?.status, 'awaiting_input');
  assert.equal(tasks.getBackgroundTask(legacy.id)?.error, 'saved_agent_model_pin_missing');
  assert.equal(tasks.getBackgroundTask(legacy.id)?.delegation?.executionModelPin, undefined, 'no original pin is invented');
  tasks.archiveBackgroundTask(legacy.id);
  const generic = tasks.createBackgroundTask({ title: 'Generic unpinned', prompt: 'Controlled generic fixture', source: 'desktop', model: 'gpt-5.5' });
  const seen: unknown[] = [];
  tasks._setBackgroundResponseExecutorForTests((_assistant, request, pin) => {
    seen.push([request.model, pin]); return Promise.resolve(complete(request));
  });
  assert.equal(await tasks.processBackgroundTasks(assistant, 1), 1);
  assert.deepEqual(seen, [['gpt-5.5', undefined]]);
  assert.notEqual(tasks.getBackgroundTask(generic.id)?.error, 'saved_agent_model_pin_missing');
  tasks.archiveBackgroundTask(generic.id);
  const unpinned = agent('Legacy generic named agent');
  const namedGeneric = tasks.createBackgroundTask({ title: 'Generic named agent', prompt: 'Controlled generic named fixture', source: 'desktop',
    model: 'gpt-5.5', delegation: delegation(unpinned) });
  assert.equal(await tasks.processBackgroundTasks(assistant, 1), 1);
  assert.deepEqual(seen.at(-1), ['gpt-5.5', undefined]);
  assert.notEqual(tasks.getBackgroundTask(namedGeneric.id)?.error, 'saved_agent_model_pin_missing');
});

test('persisted malformed specialist pin parks before activation instead of authorizing a default', async () => {
  const saved = agent('Malformed retained pin specialist', 'claude-sonnet-4-6');
  for (const pin of [{ modelId: '', savedModel: 'writer' }, { modelId: null, savedModel: 'writer' }, null]) {
    const task = tasks.createBackgroundTask({ title: 'Malformed pin fixture', prompt: 'Controlled malformed proof', source: 'desktop',
      model: 'gpt-5.5', delegation: { ...delegation(saved), executionModelPin: pin as never } });
    assert.deepEqual(tasks.getBackgroundTask(task.id)?.delegation?.executionModelPin, pin, 'fixture is persisted before activation');
    assert.equal(await tasks.processBackgroundTasks(assistant, 1), 1);
    assert.equal(tasks.getBackgroundTask(task.id)?.status, 'awaiting_input');
    assert.equal(tasks.getBackgroundTask(task.id)?.error, 'saved_agent_model_pin_invalid');
    tasks.archiveBackgroundTask(task.id);
  }
});

test('a stalled open selection cannot publish or activate against a revised or cancelled task', async () => {
  const made = projects.createProject({ name: 'Selection ownership fixture' });
  assert.ok(made.ok); if (!made.ok) return;
  const saved = agent('Selection ownership specialist', 'writer');
  projects.saveAssignment(made.project.id, { agentId: saved.id, agentCreatedAt: saved.createdAt });
  const origin = createSession({ id: 'choice-ownership-origin', kind: 'chat' });
  setSessionProject(origin.id, made.project.id, { by: 'owner' });
  let activations = 0;
  tasks._setBackgroundResponseExecutorForTests((_assistant, request) => {
    activations++; return Promise.resolve(complete(request));
  });
  for (const action of ['revise', 'cancel'] as const) {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const stalled = new Promise<void>(resolve => { release = resolve; });
    _setOpenAgentChooserForTests(async () => { entered(); await stalled; return { id: saved.id }; });
    const task = enqueueDurableChatTask({ sessionId: origin.id, message: `Controlled ${action} choice`, source: 'desktop' });
    const work = () => tasks.processBackgroundTasks(assistant, 1);
    const drained = action === 'revise' ? unavailableRole(async () => {
      const draining = work(); await started;
      tasks.reviseBackgroundTaskContract(task.id, { instruction: 'Use the revised scope.' });
      release(); await draining;
    }) : (async () => { const draining = work(); await started;
      tasks.cancelBackgroundTask(task.id, 'Owner stopped this task.'); release(); await draining; })();
    await drained;
    const current = tasks.getBackgroundTask(task.id)!;
    assert.equal(current.delegation?.agentChoice, 'open');
    assert.equal(current.delegation?.agentId, null, 'stale chooser result is never published');
    assert.equal(current.delegation?.executionModelPin, undefined);
    assert.equal(current.status, action === 'revise' ? 'pending' : 'aborted');
    tasks.archiveBackgroundTask(task.id);
  }
  assert.equal(activations, 0);
});
