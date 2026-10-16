/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/dependency-request-cli-coverage.test.ts
 *
 * A signed-out CLI never satisfies an exact provider gap. A CLI whose sign-in
 * was confirmed in its latest check reaches its app, so the host never asks
 * the owner to connect that app (owner, 2026-10-16: with gh signed in, Clem
 * uses it and never asks to connect GitHub).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-dependency-cli-coverage-'));
process.env.CLEMENTINE_HOME = HOME;
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const dependencies = await import('./dependency-request.js');
const continuity = await import('../../memory/task-continuity.js');
const { CLI_CATALOG, recordConnectedCli, readConnectedClis } = await import('../../integrations/cli-catalog/catalog.js');
const { connectedCliCandidatesForApp } = await import('../../integrations/cli-catalog/connected-cli-coverage.js');

const QUESTION = 'GitHub needs to be connected before I can continue this task. Connect it in Clementine, or pause to change the request.';
const OPTIONS = ['I’ve connected GitHub — continue this same task', 'Pause so I can change this request'];

function health(authStatus: 'ok' | 'signed_out'): void {
  writeFileSync(path.join(HOME, 'state', 'cli-auth-health.json'), JSON.stringify({
    version: 'v1',
    entries: { github: { id: 'github', command: 'gh', installed: true, authStatus, binaryPath: '/controlled/bin/gh',
      connectionRevision: readConnectedClis().github?.connectionRevision,
      username: 'fixture-owner', checkedAt: new Date().toISOString() } },
  }));
}

function parkedConnectionQuestion(sessionId: string): number {
  eventlog.createSession({ id: sessionId, kind: 'chat', userId: 'user' });
  const parent = eventlog.appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Build a Space for the site and its repository.' },
  });
  dependencies.parkDependencyRequest({
    sessionId,
    sourceUserSeq: parent.seq,
    turn: parent.turn,
    kind: 'connection_missing',
    text: QUESTION,
    connectionSubject: {
      kind: 'exact_capability_connection',
      provider: 'authorized_composio',
      toolkit: 'github',
      capability: 'GITHUB_GET_A_REPOSITORY',
      capabilityRef: 'cap:resolved:github_get_a_repository',
      discoveryQuery: 'site repository on GitHub',
      continueOptionId: 'opt-1',
      continueOptionLabel: OPTIONS[0]!,
    },
  });
  const awaiting = eventlog.appendEvent({
    sessionId, turn: parent.turn, role: 'Clem', type: 'awaiting_user_input',
    data: { sourceUserSeq: parent.seq, question: QUESTION, options: OPTIONS },
  });
  const terminal = eventlog.appendEvent({
    sessionId, turn: parent.turn, role: 'system', type: 'conversation_completed',
    data: { sourceUserSeq: parent.seq, reply: QUESTION },
  });
  continuity.createTaskContinuityPacket({
    sessionId,
    originatingSourceUserSeq: parent.seq,
    pause: { kind: 'clarification', question: QUESTION, options: OPTIONS },
    publicDeliveryBinding: { awaitingEventId: awaiting.id, terminalEventId: terminal.id },
  });
  return parent.seq;
}

function dependencyStatus(sessionId: string, sourceUserSeq: number): string | undefined {
  return (eventlog.openEventLog().prepare(
    `SELECT status FROM dependency_requests WHERE session_id = ? AND source_user_seq = ?`,
  ).get(sessionId, sourceUserSeq) as { status: string } | undefined)?.status;
}

recordConnectedCli(CLI_CATALOG.find((entry) => entry.id === 'github')!);

after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

function searchFoundNoGithubConnection(sessionId: string, parent: number, callId: string): void {
  const query = 'site repository on GitHub';
  const output = JSON.stringify({ query, brokerCoverage: 'authorized_external_v1', results: [], unavailable: [{
    source: 'authorized_composio', code: 'no_connections', dependencySubject: {
      version: 1, kind: 'exact_capability_connection', source: 'authorized_composio', query,
      toolkit: 'github', capability: 'GITHUB_GET_A_REPOSITORY', capabilityRef: 'cap:resolved:github_get_a_repository',
    },
  }] });
  eventlog.writeToolOutput({ sessionId, callId, tool: 'tool_search', output });
  eventlog.appendEvent({ sessionId, turn: 1, role: 'tool', type: 'tool_returned',
    data: { sourceUserSeq: parent, tool: 'tool_search', callId, accounting: 'top_level', topologyRole: 'control', result: output } });
}

test('a signed-in same-vendor CLI reaches its app: a search that found no connection asks the owner nothing', () => {
  health('ok');
  const sessionId = 'sess-cli-reaches-provider-ok';
  eventlog.createSession({ id: sessionId, kind: 'chat', userId: 'user' });
  const parent = eventlog.appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Build a Space for the site and its repository.' },
  }).seq;
  const candidates = connectedCliCandidatesForApp('github');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.authentication.state, 'confirmed');
  searchFoundNoGithubConnection(sessionId, parent, 'search-ok');
  assert.equal(dependencies.observedConnectionDependencyPresentationForSource({ sessionId, sourceUserSeq: parent }) ?? null, null,
    'the connection question is never put to the owner');
  assert.equal(dependencies.parkObservedConnectionDependencyForSource({ sessionId, sourceUserSeq: parent, turn: 1 }) ?? null, null,
    'nothing is parked');
});

for (const status of ['signed_out'] as const) test(`a ${status} same-vendor CLI remains a candidate without satisfying the exact dependency`, () => {
  health(status);
  const sessionId = `sess-cli-does-not-prove-provider-${status}`;
  const parent = parkedConnectionQuestion(sessionId);
  const before = continuity.peekTaskContinuityPacket({ sessionId });
  const candidates = connectedCliCandidatesForApp('github');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.authentication.state, 'signed_out');
  assert.equal(candidates[0]?.operationReadiness, 'unverified');
  assert.equal(candidates[0]?.intendedAccount, 'unverified');
  const query = 'site repository on GitHub';
  const output = JSON.stringify({ query, brokerCoverage: 'authorized_external_v1', results: [], unavailable: [{
    source: 'authorized_composio', code: 'no_connections', dependencySubject: {
      version: 1, kind: 'exact_capability_connection', source: 'authorized_composio', query,
      toolkit: 'github', capability: 'GITHUB_GET_A_REPOSITORY', capabilityRef: 'cap:resolved:github_get_a_repository',
    },
  }] });
  const callId = `search-${status}`;
  eventlog.writeToolOutput({ sessionId, callId, tool: 'tool_search', output });
  eventlog.appendEvent({ sessionId, turn: 1, role: 'tool', type: 'tool_returned',
    data: { sourceUserSeq: parent, tool: 'tool_search', callId, accounting: 'top_level', topologyRole: 'control', result: output } });
  const missing = dependencies.observedConnectionDependencyPresentationForSource({ sessionId, sourceUserSeq: parent });
  assert.equal(missing?.subject.kind, 'exact_capability_connection');
  assert.equal(missing?.subject.provider, 'authorized_composio');
  const parked = dependencies.parkObservedConnectionDependencyForSource({ sessionId, sourceUserSeq: parent, turn: 1 });
  assert.equal(parked?.status, 'open');
  assert.equal(dependencyStatus(sessionId, parent), 'open');
  assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId }), before, 'discovery cannot dismiss the held task capsule');
  assert.equal(eventlog.listEvents(sessionId, { types: ['tool_called'] }).length, 0);
});
