/**
 * Run: npx tsx src/agents/agent-binding.test.ts
 *
 * Binding an agent into work: the rendered context carries the standing
 * instructions and the pinned skills' bodies, says which pinned skills are not
 * installed, and a run_worker call naming an agent resolves once — unknown
 * refused with the saved names listed, and an unavailable saved model role
 * refused before its default can be treated as the specialist's owner pin.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-agent-binding-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { createAgentRecord } = await import('./agent-record.js');
const { agentModelIsRole, bindAgent, resolveAgentBinding, resolveWorkerAgentRequest } = await import('./agent-binding.js');
const { SKILLS_DIR } = await import('../memory/skill-store.js');
const { workerPacketKey } = await import('./worker-job-packet.js');
const { resolveRoleModel } = await import('../runtime/harness/model-roles.js');

after(() => { rmSync(HOME, { recursive: true, force: true }); });

function installSkill(name: string, body: string): void {
  const dir = path.join(SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill\n---\n${body}\n`);
}

function withRoleConfig(overrides: Record<string, string>, work: () => void): void {
  const controlledKeys = ['AUTH_MODE', 'MODEL_ROUTING_MODE', 'BYO_MODEL_BASE_URL', 'BYO_MODEL_API_KEY',
    'BYO_MODEL_ID', 'BYO_MODEL_JUDGE_ID', 'BYO_PROVIDERS', 'OPENAI_MODEL_WORKER', 'CLEMMY_DEBATE_JUDGE',
    'CLEMMY_MODEL_ROLES_REGISTRY', 'CLEMMY_MODEL_ROLES'];
  const previous = Object.fromEntries(controlledKeys.map(key => [key, process.env[key]]));
  for (const key of controlledKeys) process.env[key] = '';
  Object.assign(process.env, { AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off',
    CLEMMY_MODEL_ROLES_REGISTRY: 'on' }, overrides);
  try { work(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('the context carries instructions, pinned skill bodies, and names missing skills', () => {
  installSkill('prospect-research', 'Check mobile speed, then schema, then reviews.');
  const created = createAgentRecord({
    name: 'Prospect Research Desk',
    handles: 'Research on new prospects.',
    instructions: 'Always flag missing call tracking.',
    skills: ['prospect-research', 'not-installed-skill'],
    workflows: ['prospect-batch'],
    model: 'writer',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const binding = bindAgent(created.agent);
  assert.match(binding.context, /Working as Prospect Research Desk/);
  assert.match(binding.context, /Always flag missing call tracking/);
  assert.match(binding.context, /Check mobile speed, then schema, then reviews/, 'the pinned skill body travels with the turn');
  assert.match(binding.context, /prospect-batch/);
  assert.deepEqual(binding.pinnedSkills, ['prospect-research']);
  assert.deepEqual(binding.missingSkills, ['not-installed-skill']);
  assert.match(binding.context, /not installed: not-installed-skill/, 'a missing pin is said, not hidden');
});

test('a binding resolves by id or by the name a person typed', () => {
  assert.equal(resolveAgentBinding('prospect-research-desk')?.agent.name, 'Prospect Research Desk');
  assert.equal(resolveAgentBinding('Prospect Research Desk')?.agent.id, 'prospect-research-desk');
  assert.equal(resolveAgentBinding('nobody'), null);
  assert.equal(resolveAgentBinding(''), null);
});

test('a run_worker call naming no agent is untouched', () => {
  assert.deepEqual(resolveWorkerAgentRequest({ agent: null, model: null }), { kind: 'none' });
});

test('an unknown agent is refused before any worker starts, with the saved names listed', () => {
  const request = resolveWorkerAgentRequest({ agent: 'Ads Desk', model: null });
  assert.equal(request.kind, 'refuse');
  if (request.kind !== 'refuse') return;
  assert.match(request.reason, /Prospect Research Desk/, 'the refusal lists what could have been named');
  assert.deepEqual(request.shapes, ['agent:not_saved']);
});

test('a live role preserves the saved pin while a packet model remains a proposal for the route gate', () => {
  const byRole = resolveWorkerAgentRequest({ agent: 'prospect research desk', model: null });
  assert.equal(byRole.kind, 'bound');
  if (byRole.kind !== 'bound') return;
  assert.equal(byRole.binding.agent.id, 'prospect-research-desk');
  assert.equal(typeof byRole.model, 'string', 'the writer role resolves to a model id');
  assert.notEqual(byRole.model, 'writer', 'a role name is never passed through as a model id');

  const named = resolveWorkerAgentRequest({ agent: 'prospect research desk', model: 'owner-named-model' });
  assert.equal(named.kind, 'bound');
  if (named.kind !== 'bound') return;
  assert.equal(named.model, 'owner-named-model', 'a packet model travels to the accepted-source route gate');
  assert.equal(named.pinnedModel, byRole.pinnedModel, 'the packet does not erase the saved role pin');
});

test('a saved specialist role with an inactive binding refuses its default and a packet substitute', () => {
  for (const role of ['worker', 'judge', 'writer']) {
    const created = createAgentRecord({ name: `Unavailable ${role} specialist`, model: ` ${role.toUpperCase()} ` });
    assert.ok(created.ok); if (!created.ok) continue;
    withRoleConfig({ CLEMMY_MODEL_ROLES: JSON.stringify([{ role, modelId: 'deepseek-chat',
      scope: 'durable', source: 'settings' }]) }, () => {
      const resolution = resolveRoleModel(role as 'worker' | 'judge' | 'writer');
      assert.equal(resolution.inactiveBinding?.modelId, 'deepseek-chat', 'fixture exercises the real stale-binding resolver');
      assert.notEqual(resolution.modelId, 'deepseek-chat', 'the role reader has a default that must not become the saved pin');
      for (const model of [null, resolution.modelId, 'packet-substitute']) {
        const request = resolveWorkerAgentRequest({ agent: created.agent.id, model });
        assert.equal(request.kind, 'refuse'); if (request.kind !== 'refuse') continue;
        assert.deepEqual(request.shapes, ['model:pinned_unavailable']);
        assert.match(request.reason, /deepseek-chat/);
        assert.match(request.reason, /No substitute was started/);
        assert.match(request.reason, new RegExp(created.agent.name));
      }
    });
  }
});

test('an exact saved ID and an unpinned agent keep their original binding behavior', () => {
  const exact = createAgentRecord({ name: 'Exact model specialist', model: 'explicit-saved-id' });
  const unpinned = createAgentRecord({ name: 'Unpinned specialist' });
  assert.ok(exact.ok && unpinned.ok); if (!exact.ok || !unpinned.ok) return;
  const exactRequest = resolveWorkerAgentRequest({ agent: exact.agent.id, model: 'packet-proposal' });
  assert.equal(exactRequest.kind, 'bound'); if (exactRequest.kind !== 'bound') return;
  assert.equal(exactRequest.pinnedModel, 'explicit-saved-id');
  assert.equal(exactRequest.model, 'packet-proposal');
  const defaultRequest = resolveWorkerAgentRequest({ agent: unpinned.agent.id, model: null });
  assert.equal(defaultRequest.kind, 'bound'); if (defaultRequest.kind !== 'bound') return;
  assert.equal(defaultRequest.pinnedModel, undefined);
  assert.equal(defaultRequest.model, undefined);
});

test('a live saved role still allows the exact accepted source to authorize a later model override', async (t) => {
  const { routeWorkerModel, _setWorkerRouteDepsForTests } = await import('../runtime/harness/worker-model-route.js');
  t.after(() => _setWorkerRouteDepsForTests(null));
  const created = createAgentRecord({ name: 'Live writer specialist', model: 'writer' });
  assert.ok(created.ok); if (!created.ok) return;
  let bound: ReturnType<typeof resolveWorkerAgentRequest> = { kind: 'none' };
  withRoleConfig({ BYO_MODEL_BASE_URL: 'https://byo.example.test/v1', BYO_MODEL_API_KEY: 'fixture-owned-key',
    BYO_MODEL_ID: 'deepseek-chat', CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'writer', modelId: 'deepseek-chat',
      scope: 'durable', source: 'settings' }]) }, () => {
    assert.equal(resolveRoleModel('writer').inactiveBinding, undefined);
    bound = resolveWorkerAgentRequest({ agent: created.agent.id, model: 'later-owner-model' });
  });
  const request = bound as ReturnType<typeof resolveWorkerAgentRequest>;
  assert.equal(request.kind, 'bound'); if (request.kind !== 'bound') return;
  assert.equal(request.pinnedModel, 'deepseek-chat');
  let checks = 0;
  _setWorkerRouteDepsForTests({
    catalog: () => [{ id: 'deepseek-chat', label: 'Saved Writer' }, { id: 'later-owner-model', label: 'Later Model' }],
    defaultWorker: () => ({ modelId: 'later-owner-model', provider: 'byo', source: 'default' }),
    brainModelId: () => 'later-owner-model', intentRules: () => [], providerFor: () => 'byo',
    requestText: (session, source) => { assert.equal(session, 'accepted-override'); assert.equal(source, 9);
      return 'For this request only, use Later Model on Live writer specialist.'; },
    intentRoutingEnabled: () => true,
    ask: async (input) => { checks++; assert.match(JSON.stringify(input.state), /For this request only/);
      return { ok: true, model: 'inert-check', answers: { asked: { type: 'noul', noul: 0.99 } },
        usage: { input_tokens: 0, output_tokens: 0 } }; },
  });
  const decision = await routeWorkerModel({ sessionId: 'accepted-override', sourceUserSeq: 9,
    model: request.model, ownerPinnedModel: request.pinnedModel, objective: 'Draft a controlled local brief.' });
  assert.equal(decision.kind, 'route'); if (decision.kind !== 'route') return;
  assert.equal(decision.model, 'later-owner-model');
  assert.equal(decision.exactModel, true);
  assert.equal(decision.trace.askCheck, 'asked');
  assert.equal(checks, 1, 'a packet/default alone did not establish the override');
});

// The memory model is a Settings-only background role. An agent record whose
// model says "memory" must name a model, never route its turns to the model
// that keeps the owner's memory.
test('memory is not a role an agent can run as', () => {
  for (const role of ['brain', 'worker', 'judge', 'writer']) assert.equal(agentModelIsRole(role), true, role);
  assert.equal(agentModelIsRole('memory'), false);
  assert.equal(agentModelIsRole('Memory'), false);
});

test('running as an agent changes the packet key; a packet without one keeps its key', () => {
  const base = {
    objective: 'Research the prospect', item: 'acme', resolvedTools: 'none needed', context: 'ctx',
    instructions: 'do it', expectedOutput: 'a line', intent: null,
  };
  const plain = workerPacketKey(base);
  assert.equal(workerPacketKey({ ...base, agent: null }), plain, 'null is the same as absent');
  assert.notEqual(workerPacketKey({ ...base, agent: 'prospect-research-desk' }), plain);
});
