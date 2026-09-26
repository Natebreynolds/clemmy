/**
 * Run: npx tsx src/agents/agent-record.test.ts
 *
 * One agent store. An agent is a name plus the context it reaches for first;
 * these pins hold the storage honest (atomic writes, hand-edited files,
 * clearing fields, clean delete) and hold the phone's older JSON profiles
 * onto the same record.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-agent-record-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const {
  createAgentRecord,
  deleteAgentRecord,
  findAgentRecord,
  getAgentRecord,
  listAgentRecords,
  updateAgentRecord,
  HOST_AGENT_ID,
} = await import('./agent-record.js');
const { AGENTS_DIR, AGENT_STATE_DIR, agentFilePath } = await import('../tools/shared.js');

after(() => { rmSync(HOME, { recursive: true, force: true }); });

test('a phone-era JSON profile is folded into the one store on first read', () => {
  const legacy = path.join(HOME, 'agents');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, 'ads-desk.json'), JSON.stringify({
    id: 'ads-desk', name: 'Ads Desk', description: 'Budget questions.', skills: ['ads-hygiene'], workflows: [], model: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }));
  const imported = getAgentRecord('ads-desk');
  assert.ok(imported, 'the phone profile is now an agent.md record');
  assert.equal(imported?.createdFrom, 'phone');
  assert.deepEqual(imported?.skills, ['ads-hygiene']);
  assert.ok(existsSync(agentFilePath('ads-desk')));
  assert.ok(!existsSync(path.join(legacy, 'ads-desk.json')), 'the JSON is moved aside, not left as a second copy');
  assert.ok(existsSync(path.join(legacy, 'ads-desk.json.imported')));
});

test('an agent is created, readable by id or name, and listed', () => {
  const created = createAgentRecord({
    name: 'Prospect Research Desk',
    handles: 'Research on new prospects from the sheet.',
    instructions: 'Check mobile speed, schema and reviews first.',
    skills: ['prospect-research'],
    workflows: ['prospect-batch'],
    tools: ['sheets'],
    model: 'writer',
    createdFrom: 'console',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.agent.id, 'prospect-research-desk');
  assert.equal(getAgentRecord('prospect-research-desk')?.instructions, 'Check mobile speed, schema and reviews first.');
  assert.equal(findAgentRecord('prospect research desk')?.id, 'prospect-research-desk', 'a person types the name, not the id');
  assert.equal(listAgentRecords().length, 2);
  const onDisk = readFileSync(agentFilePath('prospect-research-desk'), 'utf8');
  assert.match(onDisk, /createdFrom: console/);
  assert.match(onDisk, /tools:\n {2}- sheets/);
});

test('a duplicate or reserved name is refused rather than overwriting', () => {
  const again = createAgentRecord({ name: 'prospect research desk' });
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.reason, 'name_taken');
  const host = createAgentRecord({ name: HOST_AGENT_ID });
  assert.equal(host.ok, false);
  if (!host.ok) assert.equal(host.reason, 'name_reserved');
});

test('a patch clears a field with an empty string and keeps untouched fields', () => {
  const updated = updateAgentRecord('prospect-research-desk', { model: '', handles: 'Prospect research.' });
  assert.equal(updated?.model, null, 'an empty string clears the model');
  assert.equal(updated?.handles, 'Prospect research.');
  assert.deepEqual(updated?.skills, ['prospect-research'], 'fields not in the patch stay');
  assert.ok((updated?.updatedAt ?? '') > (updated?.createdAt ?? 'z'), 'updatedAt moves');
});

test('a hand-written file with runtime-only fields keeps them across a save', () => {
  mkdirSync(path.join(AGENTS_DIR, 'hand-made'), { recursive: true });
  writeFileSync(agentFilePath('hand-made'), [
    '---', 'name: Hand Made', 'description: Written by hand.', 'canMessage:', '  - someone', 'project: acme', '---', 'Be careful.',
  ].join('\n'));
  updateAgentRecord('hand-made', { instructions: 'Be careful and quick.' });
  const onDisk = readFileSync(agentFilePath('hand-made'), 'utf8');
  assert.match(onDisk, /project: acme/, 'a field this product does not edit survives');
  assert.match(onDisk, /Be careful and quick\./);
});

test('the host identity is never listed as an agent', () => {
  mkdirSync(path.join(AGENTS_DIR, HOST_AGENT_ID), { recursive: true });
  writeFileSync(agentFilePath(HOST_AGENT_ID), '---\nname: Clementine\ndescription: host\n---\nYou are the host.');
  assert.ok(!listAgentRecords().some((agent) => agent.id === HOST_AGENT_ID));
  assert.equal(getAgentRecord(HOST_AGENT_ID), null);
  assert.equal(deleteAgentRecord(HOST_AGENT_ID), false);
});

test('delete removes the record and what the runtime kept about it', () => {
  mkdirSync(AGENT_STATE_DIR, { recursive: true });
  writeFileSync(path.join(AGENT_STATE_DIR, 'hand-made.json'), '{"slug":"hand-made"}');
  assert.equal(deleteAgentRecord('hand-made'), true);
  assert.ok(!existsSync(path.join(AGENTS_DIR, 'hand-made')));
  assert.ok(!existsSync(path.join(AGENT_STATE_DIR, 'hand-made.json')), 'no orphaned state file');
  assert.equal(deleteAgentRecord('hand-made'), false, 'a second delete says so');
});
