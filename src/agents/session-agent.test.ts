/**
 * Run: npx tsx --test src/agents/session-agent.test.ts
 *
 * Switching who answers a conversation: the pointer moves (or clears back to
 * Clem), every agent that took part is remembered, unrelated metadata is left
 * alone, a Space dock refuses an agent, the turn after a switch is told the
 * earlier replies were written under other instructions, and an agent's page
 * lists every conversation it answered in.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-session-agent-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const { createAgentRecord } = await import('./agent-record.js');
const { agentHandoffNote, sessionAgentState, setSessionAgent } = await import('./session-agent.js');
const { createSession, getSession } = await import('../runtime/harness/eventlog.js');
const { buildUnifiedSessionList } = await import('../dashboard/sessions-api.js');
const { sessionAgentFields } = await import('../runtime/harness/session-composition.js');

after(() => { rmSync(HOME, { recursive: true, force: true }); });

function agent(name: string) {
  const created = createAgentRecord({ name, handles: `${name} work`, instructions: `Work as ${name}.` });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error('agent not created');
  return created.agent;
}

const social = agent('Instagram Manager');
const research = agent('Prospect Research');

test('a switch moves the pointer, remembers who took part, and leaves other metadata alone', () => {
  const session = createSession({ kind: 'chat', title: 'switching', metadata: { source: 'desktop', pinned: true } });
  const first = setSessionAgent(session.id, social.id, { by: 'owner' });
  assert.deepEqual(first, { ok: true, changed: true, agentId: social.id, agentName: 'Instagram Manager' });
  assert.deepEqual(sessionAgentFields(session.id), { agentId: social.id, agentName: 'Instagram Manager' });

  const again = setSessionAgent(session.id, social.id, { by: 'owner' });
  assert.equal(again.ok && again.changed, false, 'the same choice twice is a no-op');

  setSessionAgent(session.id, research.id, { by: 'clem' });
  const back = setSessionAgent(session.id, null, { by: 'owner' });
  assert.deepEqual(back, { ok: true, changed: true, agentId: null, agentName: null });

  const metadata = getSession(session.id)!.metadata;
  assert.equal(metadata.source, 'desktop');
  assert.equal(metadata.pinned, true);
  assert.equal(metadata.agentSetBy, 'owner');
  assert.deepEqual(sessionAgentState(metadata), { agentId: null, agentName: null, agentIds: [social.id, research.id] });
  assert.deepEqual(sessionAgentFields(session.id), {}, 'the next turn runs as Clem');
});

test('a conversation opened in an agent before switching existed counts that agent as taking part', () => {
  assert.deepEqual(
    sessionAgentState({ agentId: social.id, agentName: 'Instagram Manager' }),
    { agentId: social.id, agentName: 'Instagram Manager', agentIds: [social.id] },
  );
});

test('unknown agents, unknown sessions and Space docks are refused', () => {
  const session = createSession({ kind: 'chat', title: 'plain' });
  assert.deepEqual(setSessionAgent(session.id, 'not-saved', { by: 'owner' }), { ok: false, reason: 'agent_not_found' });
  assert.deepEqual(setSessionAgent('sess-missing', social.id, { by: 'owner' }), { ok: false, reason: 'session_not_found' });
  const dock = createSession({ id: 'space-weekly-pipeline', kind: 'chat', title: 'dock' });
  assert.deepEqual(setSessionAgent(dock.id, social.id, { by: 'owner' }), { ok: false, reason: 'not_a_conversation' });
  assert.equal(getSession(dock.id)!.metadata.agentId, undefined);
});

test('the turn after a switch is told earlier replies came from another agent', () => {
  const session = createSession({ kind: 'chat', title: 'handoff' });
  assert.equal(agentHandoffNote(session.id), '', 'never switched: nothing to say');
  setSessionAgent(session.id, social.id, { by: 'owner' });
  assert.equal(agentHandoffNote(session.id), '', 'Clem to an agent: the agent context says who is answering');
  setSessionAgent(session.id, null, { by: 'owner' });
  const toClem = agentHandoffNote(session.id);
  assert.match(toClem, /working as Instagram Manager/);
  assert.match(toClem, /now answering as Clem/);
  setSessionAgent(session.id, research.id, { by: 'owner' });
  const toResearch = agentHandoffNote(session.id);
  assert.match(toResearch, /working as Instagram Manager\./);
  assert.match(toResearch, /now working as Prospect Research/);
});

test("an agent's page lists every conversation it answered in, including ones switched away", () => {
  const stayed = createSession({ kind: 'chat', title: 'stayed with research' });
  setSessionAgent(stayed.id, research.id, { by: 'owner' });
  const moved = createSession({ kind: 'chat', title: 'research then Clem' });
  setSessionAgent(moved.id, research.id, { by: 'owner' });
  setSessionAgent(moved.id, null, { by: 'owner' });
  const never = createSession({ kind: 'chat', title: 'never research' });
  setSessionAgent(never.id, social.id, { by: 'owner' });

  const titles = buildUnifiedSessionList({ agent: research.id }).map((s) => s.title).sort();
  assert.ok(titles.includes('stayed with research'));
  assert.ok(titles.includes('research then Clem'));
  assert.ok(!titles.includes('never research'));
  const movedSummary = buildUnifiedSessionList({ agent: research.id }).find((s) => s.title === 'research then Clem')!;
  assert.equal(movedSummary.agentId, null, 'the summary names who answers next, not who answered before');
  assert.deepEqual(movedSummary.agentIds, [research.id]);
});
