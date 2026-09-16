import assert from 'node:assert/strict';
import test from 'node:test';
process.env.NODE_ENV = 'test';
const { snapshotFromAcceptedSource } = await import('./prepare-accepted-source.js');
const { HOST_LABEL_MAX_CHARS } = await import('./turn-semantic-proposal.js');

test('a long delivered question is clipped to the label cap in the host view, so the session can still be interpreted', () => {
  const longQuestion = `I attempted to reset the data source again, but it hit the identical error. ${'Current state: '.repeat(120)} Could you check?`;
  assert.ok(longQuestion.length > HOST_LABEL_MAX_CHARS, 'fixture must exceed the cap');
  const snapshot = snapshotFromAcceptedSource({
    sessionId: 'sess-long-question',
    sourceUserSeq: 42,
    acceptedText: 'Update my existing workspace and add the two sources back.',
    audienceKey: 'a',
    userId: 'u',
    conversationKey: 'c',
    policyRevision: 'p',
    packet: {
      kind: 'clarification',
      question: longQuestion,
      options: ['Yes, open it', { optionId: 'opt-x', label: `Option ${'x'.repeat(HOST_LABEL_MAX_CHARS + 50)}` }],
      originatingSourceUserSeq: 41,
    },
  });
  const [question] = snapshot.openQuestions ?? [];
  assert.ok(question, 'the open question is still exposed');
  assert.ok(question.question.length <= HOST_LABEL_MAX_CHARS, `question clipped: ${question.question.length}`);
  assert.match(question.question, /…$/);
  for (const option of question.options) {
    assert.ok(option.label.length <= HOST_LABEL_MAX_CHARS, 'option labels are clipped too');
  }
});
