/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/dependency-request-cli-coverage.test.ts
 *
 * A question parked on a missing connection stops holding the session once a
 * connected, signed-in CLI reaches that app.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-dependency-cli-coverage-'));
process.env.CLEMENTINE_HOME = HOME;
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const dependencies = await import('./dependency-request.js');
const continuity = await import('../../memory/task-continuity.js');
const { CLI_CATALOG, recordConnectedCli } = await import('../../integrations/cli-catalog/catalog.js');

const QUESTION = 'GitHub needs to be connected before I can continue this task. Connect it in Clementine, or pause to change the request.';
const OPTIONS = ['I’ve connected GitHub — continue this same task', 'Pause so I can change this request'];

function health(authStatus: 'ok' | 'signed_out'): void {
  writeFileSync(path.join(HOME, 'state', 'cli-auth-health.json'), JSON.stringify({
    version: 'v1',
    entries: { github: { id: 'github', command: 'gh', installed: true, authStatus, checkedAt: new Date().toISOString() } },
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

test('a signed-in CLI that reaches the app satisfies the gap and releases its question', () => {
  health('ok');
  const sessionId = 'sess-cli-covers-connection';
  const parent = parkedConnectionQuestion(sessionId);
  assert.equal(continuity.peekTaskContinuityPacket({ sessionId }).status, 'available');
  assert.equal(dependencies.releaseConnectionDependenciesCoveredByCli(sessionId), true);
  assert.equal(dependencyStatus(sessionId, parent), 'satisfied');
  assert.notEqual(continuity.peekTaskContinuityPacket({ sessionId }).status, 'available');
  assert.equal(dependencies.releaseConnectionDependenciesCoveredByCli(sessionId), false, 'nothing left to release');
});

test('a CLI found signed out leaves the gap and its question open', () => {
  health('signed_out');
  const sessionId = 'sess-cli-signed-out';
  const parent = parkedConnectionQuestion(sessionId);
  assert.equal(dependencies.releaseConnectionDependenciesCoveredByCli(sessionId), false);
  assert.equal(dependencyStatus(sessionId, parent), 'open');
  assert.equal(continuity.peekTaskContinuityPacket({ sessionId }).status, 'available');
});
