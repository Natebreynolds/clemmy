import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeVoiceControlBoundary, nativeVoiceStatus, nativeVoiceTerminalIsExact } from './mobile-native-voice-status.js';

function proof(): Parameters<typeof nativeVoiceTerminalIsExact>[0] {
  return {
    receipt: { sessionId: 'fixture', runId: 'run-exact', sinceSeq: 13 },
    attempt: { sessionId: 'fixture', attemptId: 'attempt-exact', runId: 'run-exact', sourceUserSeq: 14,
      status: 'completed', finishedAt: '2026-10-11T17:00:00Z' },
    source: { sessionId: 'fixture', seq: 14, turn: 1, type: 'user_input_received', role: 'user',
      data: { runId: 'run-exact', attemptId: 'attempt-exact' } },
    terminal: { sessionId: 'fixture', seq: 16, turn: 1, type: 'conversation_completed',
      data: { sourceUserSeq: 14, runId: 'run-exact', attemptId: 'attempt-exact' } },
    presentation: { version: 1, id: 'presentation-fixture', outcomeId: 'turn:14', audience: 'user', phase: 'final',
      identity: { sessionId: 'fixture', sourceUserSeq: 14, turn: 1 }, status: 'done', kind: 'answer',
      text: 'Done with the controlled fixture.', resumable: false },
  };
}

test('source-only public identity uses exact durable receipt/source/executor proof without borrowing a newer attempt', () => {
  assert.equal(nativeVoiceTerminalIsExact(proof()), true);
  const full = proof();
  full.presentation!.identity.attemptId = 'attempt-exact';
  full.presentation!.identity.runId = 'run-exact';
  assert.equal(nativeVoiceTerminalIsExact(full), true);
  const changes: Array<[string, (p: ReturnType<typeof proof>) => void]> = [
    ['foreign receipt', p => { p.receipt.sessionId = 'other'; }],
    ['foreign request run', p => { p.receipt.runId = 'other'; }],
    ['not after receipt', p => { p.receipt.sinceSeq = 14; }],
    ['missing attempt', p => { p.attempt = null; }],
    ['foreign attempt', p => { p.attempt!.sessionId = 'other'; }],
    ['foreign attempt run', p => { p.attempt!.runId = 'other'; }],
    ['unaccepted source', p => { p.attempt!.sourceUserSeq = null; }],
    ['missing source', p => { p.source = null; }],
    ['synthetic source', p => { p.source!.data.synthetic = true; }],
    ['foreign source executor', p => { p.source!.data.attemptId = 'other'; }],
    ['foreign source run', p => { p.source!.data.runId = 'other'; }],
    ['missing terminal executor', p => { delete p.terminal!.data.attemptId; }],
    ['foreign terminal executor', p => { p.terminal!.data.attemptId = 'other'; }],
    ['foreign terminal run', p => { p.terminal!.data.runId = 'other'; }],
    ['foreign terminal source', p => { p.terminal!.data.sourceUserSeq = 13; }],
    ['terminal before source', p => { p.terminal!.seq = 13; }],
    ['foreign presentation turn', p => { p.presentation!.identity.turn = 0; }],
    ['contrary presentation executor', p => { p.presentation!.identity.attemptId = 'other'; }],
    ['contrary presentation run', p => { p.presentation!.identity.runId = 'other'; }],
    ['unsettled done attempt', p => { p.attempt!.finishedAt = null; }],
    ['failed attempt is not done', p => { p.attempt!.status = 'failed'; }],
  ];
  for (const [name, change] of changes) {
    const input = proof(); change(input);
    assert.equal(nativeVoiceTerminalIsExact(input), false, name);
  }
});

test('an exact ordinary question remains eligible while its canonical input boundary waits', () => {
  const input = proof();
  input.presentation = { ...input.presentation!, status: 'needs_input', kind: 'question', resumable: true,
    needs: { kind: 'input' } };
  input.attempt!.status = 'active'; input.attempt!.finishedAt = null;
  assert.equal(nativeVoiceTerminalIsExact(input), true);
});

test('native voice waits for a committed terminal, not a draft', () => {
  assert.deepEqual(nativeVoiceStatus(null), { state: 'working', canResumeVoice: false });
});
test('only a committed answer or a proven ordinary question can restart listening', () => {
  const terminal = { sessionId: 'fixture', sourceUserSeq: 14, status: 'done', kind: 'answer', text: 'Done with the fixture.' };
  assert.equal(nativeVoiceStatus(terminal).state, 'answered');
  assert.equal(nativeVoiceStatus(terminal).canResumeVoice, true);
  for (const status of ['needs_input', 'blocked', 'failed', 'cancelled', 'transferred', 'uncertain']) {
    assert.equal(nativeVoiceStatus({ ...terminal, status }).state, 'needs_app');
  }
  for (const kind of ['approval', 'question', 'continue']) assert.equal(nativeVoiceStatus({ ...terminal, kind }).state, 'needs_app');
  assert.equal(nativeVoiceStatus({ ...terminal, text: '' }).state, 'needs_app');
});

const question = { sessionId: 'fixture', sourceUserSeq: 14, status: 'needs_input', kind: 'question',
  text: 'Which date should I use?', ordinaryQuestion: true };

test('a canonical ordinary clarification resumes even when the words mention approval', () => {
  const requiresApp = nativeVoiceControlBoundary({ sourceUserSeq: 14, completionData: {}, sourceData: {},
    awaitingInputData: [{ sourceUserSeq: 14, reason: 'question', question: 'Which date should I use?' }] });
  assert.equal(requiresApp, false);
  assert.equal(nativeVoiceStatus({ ...question, requiresApp }).canResumeVoice, true);
  assert.equal(nativeVoiceStatus({ ...question, text: 'Which approval date belongs on the report?', requiresApp }).canResumeVoice, true);
});

test('a question without positive ordinary-question proof never resumes', () => {
  assert.equal(nativeVoiceStatus({ ...question, ordinaryQuestion: undefined }).canResumeVoice, false);
  assert.equal(nativeVoiceStatus({ ...question, ordinaryQuestion: false }).state, 'needs_app');
  assert.equal(nativeVoiceStatus({ ...question, text: ' ' }).canResumeVoice, false);
});

test('approval/control metadata in either exact source or terminal prevents continuation', () => {
  for (const metadata of [
    { liveApprovalControl: { version: 1 } }, { liveApprovalControl: null },
    { approvalId: 'apr-fixture' }, { approvalInquiry: {} }, { reviewedPlanOwnerControl: {} },
    { source: 'mobile_approval_confirm' }, { source: 'mobile_approval_inquiry' },
    { reason: 'approval_confirmation_required' },
  ]) {
    for (const field of ['completionData', 'sourceData'] as const) {
      const requiresApp = nativeVoiceControlBoundary({ sourceUserSeq: 14, completionData: {}, sourceData: {},
        awaitingInputData: [], [field]: metadata });
      assert.equal(requiresApp, true);
      assert.equal(nativeVoiceStatus({ ...question, requiresApp }).state, 'needs_app');
      assert.equal(nativeVoiceStatus({ ...question, requiresApp }).canResumeVoice, false);
    }
  }
});

test('an exact-source approval confirmation remains in the app even when it looks like an ordinary question', () => {
  for (const marker of [{ approvalId: 'apr-fixture' }, { reason: 'approval_confirmation_required' }]) {
    const requiresApp = nativeVoiceControlBoundary({ sourceUserSeq: 14, completionData: {}, sourceData: {},
      awaitingInputData: [{ sourceUserSeq: 14, ...marker, question: question.text }] });
    assert.equal(nativeVoiceStatus({ ...question, requiresApp }).canResumeVoice, false);
  }
});

test('an approval belonging to another turn cannot block this ordinary clarification', () => {
  const requiresApp = nativeVoiceControlBoundary({ sourceUserSeq: 14, completionData: {}, sourceData: {},
    awaitingInputData: [{ sourceUserSeq: 13, approvalId: 'apr-previous', reason: 'approval_confirmation_required' }] });
  assert.equal(requiresApp, false);
  assert.equal(nativeVoiceStatus({ ...question, requiresApp }).canResumeVoice, true);
});

test('a control acknowledgement never restarts listening merely because it is done/answer', () => {
  const answer = { ...question, status: 'done', kind: 'answer', requiresApp: true };
  assert.equal(nativeVoiceStatus(answer).canResumeVoice, false);
});

test('a notice terminal is never spoken: no app line and no fallback sentence reach the voice', () => {
  for (const [status, kind, code, text] of [
    ['cancelled', 'stopped', 'stopped', 'Stopped. Nothing further runs for this turn.'],
    ['blocked', 'blocked', 'provider_quota', 'No Codex quota is available for this saved agent, so this turn did not start.'],
    ['failed', 'error', 'run_failed', 'This request stopped on an error before it finished.'],
    ['blocked', 'blocked', 'response_format_unmet', '```json\n{"value":"fixture"}\n```'],
  ] as const) {
    const voiced = nativeVoiceStatus({ sessionId: 'fixture', sourceUserSeq: 14, status, kind, text,
      notice: { code } });
    assert.equal(voiced.state, 'needs_app', code);
    assert.equal(voiced.canResumeVoice, false, code);
    // The widget speaks `text` whenever it is non-empty, and a missing field
    // falls back to a spoken line: the explicit empty string keeps it silent.
    assert.equal(voiced.text, '', code);
    assert.deepEqual(voiced.notice, { code }, code);
  }
  // An unknown code is no notice: Clem's finished answer is still spoken.
  const answered = nativeVoiceStatus({ sessionId: 'fixture', sourceUserSeq: 14, status: 'done', kind: 'answer',
    text: 'Done with the fixture.', notice: { code: 'not_a_notice' } as never });
  assert.equal(answered.state, 'answered');
  assert.equal(answered.text, 'Done with the fixture.');
  assert.equal('notice' in answered, false);
});
