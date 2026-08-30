/**
 * Run: npx tsx src/memory/agent-store.test.ts
 *
 * Named agents are the user's own standing helpers: a name plus the skills and
 * workflows it leans on. They are stored like skills and workflows already are
 * — one readable JSON file per agent — so they need no schema migration and a
 * person can hand-edit or back them up.
 *
 * The pins are a PREFERENCE, never an authority grant. These pins hold that
 * line, and hold the storage honest about hand-edited or partly-broken files.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-agent-store-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const {
  AGENTS_DIR,
  agentIdFor,
  agentTurnPreamble,
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  updateAgent,
  MAX_AGENT_PINS,
} = await import('./agent-store.js');

after(() => { rmSync(HOME, { recursive: true, force: true }); });

test('an agent is created, readable, and listed', () => {
  const created = createAgent({
    name: 'Sales Desk',
    description: 'Handles pipeline questions.',
    skills: ['crm-hygiene'],
    workflows: ['weekly-pipeline'],
    model: 'claude',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.agent.id, 'sales-desk', 'the id is a stable readable slug');
  assert.equal(created.agent.name, 'Sales Desk');
  assert.deepEqual(created.agent.skills, ['crm-hygiene']);
  assert.equal(getAgent('sales-desk')?.name, 'Sales Desk');
  assert.equal(listAgents().length, 1);
});

test('a duplicate name is refused rather than silently overwriting', () => {
  const again = createAgent({ name: 'sales desk' });
  assert.equal(again.ok, false, 'two agents answering to the same name is a trap');
  if (again.ok) return;
  assert.equal(again.reason, 'name_taken');
  assert.equal(listAgents().length, 1, 'the original is untouched');
});

test('a nameless agent is refused', () => {
  const blank = createAgent({ name: '   ' });
  assert.equal(blank.ok, false);
  if (blank.ok) return;
  assert.equal(blank.reason, 'name_required');
});

test('editing preserves untouched fields', () => {
  const updated = updateAgent('sales-desk', { description: 'Pipeline and renewals.' });
  assert.ok(updated);
  assert.equal(updated!.description, 'Pipeline and renewals.');
  assert.deepEqual(updated!.skills, ['crm-hygiene'], 'an unmentioned field is not cleared');
  assert.equal(updated!.model, 'claude');
  assert.ok(updated!.updatedAt >= updated!.createdAt);
});

test('pins are de-duplicated and bounded', () => {
  const many = Array.from({ length: MAX_AGENT_PINS + 20 }, (_, index) => `skill-${index}`);
  const created = createAgent({ name: 'Bounded', skills: [...many, 'skill-0', 'skill-0'] });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.ok(created.agent.skills.length <= MAX_AGENT_PINS, 'a runaway pin list cannot grow a turn without bound');
  assert.equal(new Set(created.agent.skills).size, created.agent.skills.length);
});

test('a hand-edited unparseable file is skipped, not fatal', () => {
  mkdirSync(AGENTS_DIR, { recursive: true });
  writeFileSync(path.join(AGENTS_DIR, 'broken.json'), '{ not json', 'utf8');
  const listed = listAgents();
  assert.ok(listed.some((agent) => agent.id === 'sales-desk'),
    'one broken file must not hide every other agent');
  assert.equal(getAgent('broken'), null);
});

test('deleting removes exactly one agent', () => {
  assert.equal(deleteAgent('bounded'), true);
  assert.equal(getAgent('bounded'), null);
  assert.ok(getAgent('sales-desk'), 'its neighbour survives');
  assert.equal(deleteAgent('never-existed'), false);
});

test('an id can never escape the agents directory', () => {
  assert.equal(getAgent('../../etc/passwd'), null);
  assert.equal(getAgent('nested/path'), null);
  assert.equal(agentIdFor('../../evil'), 'evil');
});

test('the turn preamble states preference, never authority', () => {
  const agent = getAgent('sales-desk')!;
  const preamble = agentTurnPreamble(agent);
  assert.match(preamble, /Sales Desk/);
  assert.match(preamble, /crm-hygiene/);
  assert.match(preamble, /starting points, not limits/,
    'pins bias where Clem looks first; they must never read as a grant or a cage');
  assert.match(preamble, /never claim work you did not do/);
});
