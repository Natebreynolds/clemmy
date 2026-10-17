import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowParentTerminalIdentityFromSnapshot, type WorkflowParentTerminalIdentityInput,
  type WorkflowParentTerminalSnapshot } from './workflow-parent-terminal-proof-data.js';

function fixture(): { input: WorkflowParentTerminalIdentityInput; snapshot: WorkflowParentTerminalSnapshot } {
  const identity = { sessionId: 'controlled-parent', sourceUserSeq: 17, turn: 3,
    attemptId: 'controlled-attempt', runId: 'controlled-run' };
  return { input: { sourceGroupId: 'controlled-group', sourceGroupDigest: 'a'.repeat(64),
    terminal: { ...identity, eventId: 'controlled-terminal', outcomeId: 'turn:17' } },
  snapshot: { latestAttemptId: identity.attemptId,
    terminalEvent: { id: 'controlled-terminal', seq: 30, turn: 3, sessionId: identity.sessionId,
      role: 'system', type: 'conversation_completed', data: { terminalKey: 'turn:17',
        attemptId: identity.attemptId, runId: identity.runId, sourceUserSeq: identity.sourceUserSeq,
        presentation: { version: 1, id: 'turn:17:presentation', outcomeId: 'turn:17', audience: 'user', phase: 'final',
          identity, status: 'done', kind: 'answer', text: 'Controlled retained result.', resumable: false },
        turnOutcome: { version: 2, id: 'turn:17', identity: { ...identity }, status: 'done', resumable: false } } },
    continuationRequests: [{ id: 'controlled-request', seq: 20, turn: 2, sessionId: identity.sessionId,
      type: 'workflow_parent_continuation_requested', role: 'system', data: { sourceUserSeq: 17,
        attemptId: identity.attemptId, sourceGroupId: 'controlled-group', sourceGroupDigest: 'a'.repeat(64) } }] } };
}

test('parent proof binds full typed identity to the exact source attempt and earlier group request', () => {
  const { input, snapshot } = fixture();
  assert.equal(workflowParentTerminalIdentityFromSnapshot(input, snapshot), true);
  // Terminal identity is distinct from fulfillment. A valid blocked terminal
  // is a terminal; the group decoder separately validates its settlement.
  const data = snapshot.terminalEvent!.data as any;
  data.presentation.status = 'blocked'; data.presentation.kind = 'blocked'; data.turnOutcome.status = 'blocked';
  assert.equal(workflowParentTerminalIdentityFromSnapshot(input, snapshot), true);
});

test('contrary outer turn and duplicated typed projections cannot satisfy parent identity', () => {
  for (const corrupt of [
    (s: WorkflowParentTerminalSnapshot) => { s.terminalEvent!.turn = 4; },
    (s: WorkflowParentTerminalSnapshot) => { s.terminalEvent!.sessionId = 'foreign'; },
    (s: WorkflowParentTerminalSnapshot) => { s.terminalEvent!.type = 'tool_returned'; },
    (s: WorkflowParentTerminalSnapshot) => { delete s.terminalEvent!.data.turnOutcome; },
    (s: WorkflowParentTerminalSnapshot) => { (s.terminalEvent!.data.turnOutcome as any).identity.attemptId = 'other'; },
    (s: WorkflowParentTerminalSnapshot) => { s.terminalEvent!.data.sourceUserSeq = 18; },
    (s: WorkflowParentTerminalSnapshot) => { s.latestAttemptId = 'new-exact-source-attempt'; },
    (s: WorkflowParentTerminalSnapshot) => { s.latestAttemptId = null; },
  ]) {
    const { input, snapshot } = structuredClone(fixture()); corrupt(snapshot);
    assert.equal(workflowParentTerminalIdentityFromSnapshot(input, snapshot), false);
  }
});

test('matching prose, foreign group requests and late or non-system requests are not parent ownership', () => {
  for (const delta of [{ role: 'assistant' }, { seq: 31 }, { sessionId: 'foreign' },
    { type: 'workflow_run_started' }, { data: { sourceUserSeq: 18 } },
    { data: { sourceUserSeq: 17, attemptId: 'controlled-attempt', sourceGroupId: 'other', sourceGroupDigest: 'a'.repeat(64) } },
  ]) {
    const { input, snapshot } = fixture();
    snapshot.continuationRequests = [{ ...snapshot.continuationRequests[0]!, ...delta }];
    assert.equal(workflowParentTerminalIdentityFromSnapshot(input, snapshot), false);
  }
});
