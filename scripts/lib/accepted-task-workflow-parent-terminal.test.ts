import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readAcceptedTaskWorkflowParentTerminalIdentity } from './accepted-task-workflow-parent-terminal.js';
import type { WorkflowParentTerminalIdentityInput } from '../../src/execution/workflow-parent-terminal-proof-data.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-parent-accounting-'));
process.env.CLEMENTINE_HOME = home;
const events = await import('../../src/runtime/harness/eventlog.js');
const { isWorkflowParentTerminalIdentity } = await import('../../src/execution/workflow-parent-terminal-proof.js');
const { closeOperationalTelemetryDb } = await import('../../src/runtime/operational-telemetry.js');
test.after(() => { events.closeEventLog(); closeOperationalTelemetryDb(); rmSync(home, { recursive: true, force: true }); });

function admitted(label: string): WorkflowParentTerminalIdentityInput {
  const session = events.createSession({ id: `controlled-parent-${label}`, kind: 'chat', channel: 'desktop' });
  const attempt = events.beginRunAttempt(session.id, { attemptId: `controlled-attempt-${label}`, runId: `controlled-run-${label}` });
  const source = events.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: 'Controlled parent accounting.' } });
  const group = `controlled-group-${label}`;
  events.appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'workflow_parent_continuation_requested',
    data: { sourceUserSeq: source.seq, attemptId: attempt.attemptId, sourceGroupId: group, sourceGroupDigest: 'a'.repeat(64) } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1, attemptId: attempt.attemptId, runId: attempt.runId! };
  const outcomeId = `turn:${source.seq}`;
  const terminal = events.appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'conversation_completed', data: {
    terminalKey: outcomeId, sourceUserSeq: source.seq,
    presentation: { version: 1, id: `${outcomeId}:presentation`, outcomeId, audience: 'user', phase: 'final', identity,
      status: 'done', kind: 'answer', text: 'Controlled parent result.', resumable: false },
    turnOutcome: { version: 2, id: outcomeId, identity, status: 'done', resumable: false },
  } });
  events.finishRunAttempt(attempt, 'completed');
  return { sourceGroupId: group, sourceGroupDigest: 'a'.repeat(64), terminal: { eventId: terminal.id,
    outcomeId, sessionId: session.id, sourceUserSeq: source.seq, turn: 1, runId: attempt.runId! } };
}

test('read-only explicit-home parent proof agrees with actual production event and attempt producers', () => {
  const input = admitted('actual');
  const file = path.join(home, 'state', 'harness.db');
  const before = readFileSync(file);
  assert.equal(isWorkflowParentTerminalIdentity(input), true);
  assert.equal(readAcceptedTaskWorkflowParentTerminalIdentity(home, input), true);
  assert.deepEqual(readFileSync(file), before);
  // A later request in this chat cannot replace the exact old source proof.
  const unrelated = events.beginRunAttempt(input.terminal.sessionId, { attemptId: 'unrelated-later-attempt', runId: 'unrelated-run' });
  events.recordRunAttemptUserInput(unrelated, { turn: 2, role: 'user', data: { text: 'A distinct controlled task.' } });
  events.finishRunAttempt(unrelated, 'completed');
  assert.equal(isWorkflowParentTerminalIdentity(input), true);
  assert.equal(readAcceptedTaskWorkflowParentTerminalIdentity(home, input), true);
});

test('outer-turn corruption and contrary typed identity fail in both runtime and accounting readers', () => {
  const input = admitted('contrary');
  const db = events.openEventLog();
  db.prepare('UPDATE events SET turn = 2 WHERE id = ?').run(input.terminal.eventId);
  assert.equal(isWorkflowParentTerminalIdentity(input), false);
  assert.equal(readAcceptedTaskWorkflowParentTerminalIdentity(home, input), false);
  db.prepare('UPDATE events SET turn = 1, data_json = json_remove(data_json, ?) WHERE id = ?')
    .run('$.turnOutcome', input.terminal.eventId);
  assert.equal(isWorkflowParentTerminalIdentity(input), false);
  assert.equal(readAcceptedTaskWorkflowParentTerminalIdentity(home, input), false);
});

test('missing or foreign explicit home never migrates a store or adopts configured live/default state', () => {
  const input = admitted('home');
  const missing = path.join(home, 'missing-store');
  assert.equal(readAcceptedTaskWorkflowParentTerminalIdentity(missing, input), false);
  assert.equal(existsSync(missing), false);
  assert.equal(readAcceptedTaskWorkflowParentTerminalIdentity(home, { ...input,
    terminal: { ...input.terminal, eventId: 'foreign-terminal' } }), false);
});
