import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeVoiceControlBoundary, nativeVoiceStatus } from './mobile-native-voice-status.js';

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
