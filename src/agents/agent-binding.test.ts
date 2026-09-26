/**
 * Run: npx tsx src/agents/agent-binding.test.ts
 *
 * Binding an agent into work: the rendered context carries the standing
 * instructions and the pinned skills' bodies, says which pinned skills are not
 * installed, and a run_worker call naming an agent resolves once — unknown
 * refused with the saved names listed, the agent's model role honored only
 * when the caller named no model.
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
const { bindAgent, resolveAgentBinding, resolveWorkerAgentRequest } = await import('./agent-binding.js');
const { SKILLS_DIR } = await import('../memory/skill-store.js');
const { workerPacketKey } = await import('./worker-job-packet.js');

after(() => { rmSync(HOME, { recursive: true, force: true }); });

function installSkill(name: string, body: string): void {
  const dir = path.join(SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill\n---\n${body}\n`);
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

test('a bound call asks for the agent\'s model role only when the caller named no model', () => {
  const byRole = resolveWorkerAgentRequest({ agent: 'prospect research desk', model: null });
  assert.equal(byRole.kind, 'bound');
  if (byRole.kind !== 'bound') return;
  assert.equal(byRole.binding.agent.id, 'prospect-research-desk');
  assert.equal(typeof byRole.model, 'string', 'the writer role resolves to a model id');
  assert.notEqual(byRole.model, 'writer', 'a role name is never passed through as a model id');

  const named = resolveWorkerAgentRequest({ agent: 'prospect research desk', model: 'owner-named-model' });
  assert.equal(named.kind, 'bound');
  if (named.kind !== 'bound') return;
  assert.equal(named.model, 'owner-named-model', 'a model the caller named wins over the agent\'s role');
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
