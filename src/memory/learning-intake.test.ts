import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentationEventForOutcome, type TurnOutcome } from '../runtime/harness/turn-outcome.js';
import { _testOnlyLearningIntake } from './learning-intake.js';

function terminalRow(status: TurnOutcome['status']): {
  terminal_event_rowid: number;
  terminal_event_id: string;
  session_id: string;
  data_json: string;
} {
  const identity = { sessionId: 'learning-session', turn: 1, sourceUserSeq: 7 };
  const outcome = (status === 'done' ? {
    version: 2,
    id: 'turn:7',
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text: 'Finished.' },
  } : {
    version: 2,
    id: 'turn:7',
    identity,
    status: 'blocked',
    resumable: true,
    presentation: { kind: 'blocked', text: 'Blocked.' },
  }) satisfies TurnOutcome;
  return {
    terminal_event_rowid: 11,
    terminal_event_id: 'terminal-11',
    session_id: identity.sessionId,
    data_json: JSON.stringify({
      presentation: presentationEventForOutcome(outcome),
      turnOutcome: outcome,
      sourceUserSeq: identity.sourceUserSeq,
      terminalKey: outcome.id,
      logicalTerminalVersion: 1,
    }),
  };
}

test('learning intake accepts only the fully typed canonical done terminal shape', () => {
  const done = _testOnlyLearningIntake.completedTerminal(terminalRow('done'));
  assert.equal(done?.sourceUserSeq, 7);
  assert.equal(done?.sessionId, 'learning-session');
  assert.equal(done?.terminalDigest.length, 64);
  assert.equal(_testOnlyLearningIntake.completedTerminal(terminalRow('blocked')), null);
  assert.equal(_testOnlyLearningIntake.completedTerminal({
    terminal_event_rowid: 12,
    terminal_event_id: 'heuristic-terminal',
    session_id: 'learning-session',
    data_json: JSON.stringify({ sourceUserSeq: 7, status: 'done', done: true, reason: 'success' }),
  }), null, 'legacy done-like flags are not semantic-learning authority');
});

test('structured restaurant rows are deterministic task evidence, not extractor input', () => {
  assert.equal(_testOnlyLearningIntake.containsRecordCollection({
    records: [
      { name: 'Piccola Trattoria', rating: 4.8 },
      { name: 'Newhall Refinery', rating: 4.7 },
    ],
  }), true);
  assert.equal(_testOnlyLearningIntake.unstructuredText({
    records: [{ name: 'one' }, { name: 'two' }],
  }), null);
  assert.ok(_testOnlyLearningIntake.unstructuredText({
    text: 'Source-grounded meeting narrative. '.repeat(40),
  }));
});
