/**
 * Run: node scripts/run-tests-isolated.mjs src/agents/session-agent-model.test.ts
 *
 * A conversation switched to an agent the owner pinned a model to answers on
 * that model, until the owner picks one for the conversation on the model
 * chip. Owner, 10-02: "I would like to be able to pin a model to an agent."
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-session-agent-model-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'session-agent-model\n');

const { createAgentRecord } = await import('./agent-record.js');
const { setSessionAgent } = await import('./session-agent.js');
const { createSession } = await import('../runtime/harness/eventlog.js');
const { sessionAgentAnsweringModel, recordBrainChosenForSession, nextAnsweringAgentModel } = await import('./session-agent-model.js');

after(() => { rmSync(HOME, { recursive: true, force: true }); });

const live = { live: () => true };

test('switching to an agent pinned to a model answers on that model; the owner\'s later chip choice wins; switching again restores it', async () => {
  const designer = createAgentRecord({ name: 'Model Test Designer', handles: 'Design', model: 'claude-opus-5-5' });
  assert.ok(designer.ok);
  if (!designer.ok) return;
  const session = createSession({ id: 'sess-agent-model-1', kind: 'chat', channel: 'desktop', title: 't' });
  assert.equal(sessionAgentAnsweringModel(session.id, live), null, 'no agent, no agent model');

  assert.equal(setSessionAgent(session.id, designer.agent.id, { by: 'owner' }).ok, true);
  assert.deepEqual(sessionAgentAnsweringModel(session.id, live),
    { modelId: 'claude-opus-5-5', agentId: designer.agent.id, agentName: 'Model Test Designer' });

  // The owner picks a model for this conversation afterwards: theirs answers.
  recordBrainChosenForSession(session.id, new Date(Date.now() + 1_000));
  assert.equal(sessionAgentAnsweringModel(session.id, live), null);

  // Switching away and back is a new switch: the agent's model answers again.
  await new Promise((r) => setTimeout(r, 5));
  setSessionAgent(session.id, null, { by: 'owner' });
  assert.equal(sessionAgentAnsweringModel(session.id, live), null, 'back with Clem, no agent model');
  await new Promise((r) => setTimeout(r, 1_100));
  setSessionAgent(session.id, designer.agent.id, { by: 'owner' });
  assert.equal(sessionAgentAnsweringModel(session.id, live)?.modelId, 'claude-opus-5-5');
});

test('a pinned model that is not signed in, or an agent with no model, answers on the owner\'s model', () => {
  const pinned = createAgentRecord({ name: 'Model Test Signed Out', handles: 'x', model: 'claude-opus-5-5' });
  const unpinned = createAgentRecord({ name: 'Model Test Unpinned', handles: 'x' });
  assert.ok(pinned.ok && unpinned.ok);
  if (!pinned.ok || !unpinned.ok) return;
  const a = createSession({ id: 'sess-agent-model-2', kind: 'chat', channel: 'desktop', title: 't' });
  setSessionAgent(a.id, pinned.agent.id, { by: 'owner' });
  assert.equal(sessionAgentAnsweringModel(a.id, { live: () => false }), null, 'never a model that cannot answer now');
  const b = createSession({ id: 'sess-agent-model-3', kind: 'chat', channel: 'desktop', title: 't' });
  setSessionAgent(b.id, unpinned.agent.id, { by: 'owner' });
  assert.equal(sessionAgentAnsweringModel(b.id, live), null);
});

test('the model chip reads what answers the next message, including an agent choice not yet sent', () => {
  const designer = createAgentRecord({ name: 'Model Test Chip Designer', handles: 'Design', model: 'claude-opus-5-5' });
  const other = createAgentRecord({ name: 'Model Test Chip Other', handles: 'x', model: 'gpt-5.5' });
  assert.ok(designer.ok && other.ok);
  if (!designer.ok || !other.ok) return;
  // A new conversation about to open inside the agent.
  assert.equal(nextAnsweringAgentModel(null, designer.agent.id, live)?.modelId, 'claude-opus-5-5');
  assert.equal(nextAnsweringAgentModel(null, null, live), null);
  assert.equal(nextAnsweringAgentModel(null, undefined, live), null);

  const session = createSession({ id: 'sess-agent-model-chip', kind: 'chat', channel: 'desktop', title: 't' });
  setSessionAgent(session.id, designer.agent.id, { by: 'owner' });
  recordBrainChosenForSession(session.id, new Date(Date.now() + 1_000));
  // The conversation's own agent: the owner's later pick answers.
  assert.equal(nextAnsweringAgentModel(session.id, undefined, live), null);
  assert.equal(nextAnsweringAgentModel(session.id, designer.agent.id, live), null);
  // A different agent chosen on the chip switches on send: its model answers.
  assert.equal(nextAnsweringAgentModel(session.id, other.agent.id, live)?.modelId, 'gpt-5.5');
  // Back to Clem on the chip: no agent model.
  assert.equal(nextAnsweringAgentModel(session.id, null, live), null);
});
