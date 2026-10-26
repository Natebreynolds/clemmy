import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-review-after-delivery-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { appendEvent, createSession, listEvents } = await import('./eventlog.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { projectHarnessEventForPublic } = await import('./public-presentation.js');
const {
  NO_CORRECTION_REPLY, launchReviewAfterDelivery, registerReviewAfterDelivery, replyEndsOnQuestion, reviewAfterDeliveryRecorded, _resetReviewAfterDeliveryForTests,
} = await import('./review-after-delivery.js');
type TurnOutcome = import('./turn-outcome.js').TurnOutcome;

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

const OBJECTIVE = 'Summarize the controlled fixture notes.';

function acceptedAnswer(sessionId: string, text: string, objective = OBJECTIVE): TurnOutcome {
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: objective } });
  appendEvent({ sessionId, turn: 0, role: 'system', type: 'completion_policy_captured', data: {
    version: 1, sourceUserSeq: source.seq, enabled: true,
  } });
  const identity = { sessionId, turn: source.turn, sourceUserSeq: source.seq };
  return { version: 2, id: turnOutcomeId(identity), identity, status: 'done', resumable: false,
    presentation: { kind: 'answer', text } };
}

async function settled(sessionId: string): Promise<Record<string, unknown>> {
  const started = Date.now();
  for (;;) {
    const row = listEvents(sessionId, { types: ['completion_review_settled'] }).at(-1);
    if (row) return row.data;
    if (Date.now() - started > 5_000) throw new Error('the review never settled');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('only the host marker for this source and objective lets an answer publish before its review', () => {
  _resetReviewAfterDeliveryForTests();
  const outcome = acceptedAnswer('after-delivery-marker', 'The notes cover two controlled items.');
  const seq = outcome.identity.sourceUserSeq;
  assert.equal(reviewAfterDeliveryRecorded({ sessionId: outcome.identity.sessionId, sourceUserSeq: seq, objective: OBJECTIVE }), false);
  assert.equal(registerReviewAfterDelivery({ sessionId: outcome.identity.sessionId, sourceUserSeq: seq,
    objective: 'A different objective.', review: async () => ({ review: 'checked' }), correct: async () => undefined }), true);
  assert.equal(reviewAfterDeliveryRecorded({ sessionId: outcome.identity.sessionId, sourceUserSeq: seq, objective: OBJECTIVE }), false);
  assert.equal(reviewAfterDeliveryRecorded({ sessionId: outcome.identity.sessionId, sourceUserSeq: seq + 1, objective: 'A different objective.' }), false);
  // A marker for another objective is not this source's deferral: the answer
  // keeps the ordinary path and carries no checking chip.
  const committed = commitTurnOutcome(outcome);
  assert.notEqual(committed.event.data.review, 'checking');
});

test('a review that is not held in this process settles the chip as not checked', async () => {
  _resetReviewAfterDeliveryForTests();
  const outcome = acceptedAnswer('after-delivery-unheld', 'The notes cover two controlled items.');
  appendEvent({ sessionId: outcome.identity.sessionId, turn: 0, role: 'system', type: 'completion_review_deferred', data: {
    version: 1, sourceUserSeq: outcome.identity.sourceUserSeq,
    objectiveDigest: (await import('node:crypto')).createHash('sha256').update(OBJECTIVE, 'utf8').digest('hex'),
  } });
  const committed = commitTurnOutcome(outcome);
  assert.equal(committed.presentation.status, 'done');
  assert.equal(committed.event.data.review, 'checking');
  assert.equal((committed.event.data.completionReview as Record<string, unknown>).afterDelivery, true);
  const ruling = await settled(outcome.identity.sessionId);
  assert.equal(ruling.review, 'unchecked');
  assert.equal(ruling.reason, 'review_not_held');
});

test('a reviewer that throws settles as not checked, never as a pass', async () => {
  _resetReviewAfterDeliveryForTests();
  const outcome = acceptedAnswer('after-delivery-throws', 'The notes cover two controlled items.');
  registerReviewAfterDelivery({ sessionId: outcome.identity.sessionId, sourceUserSeq: outcome.identity.sourceUserSeq,
    objective: OBJECTIVE, review: async () => { throw new Error('reviewer offline'); }, correct: async () => 'unused' });
  const committed = commitTurnOutcome(outcome);
  assert.equal(committed.event.data.review, 'checking');
  assert.equal((await settled(outcome.identity.sessionId)).review, 'unchecked');
});

test('Clem may stand by her answer: a rejection she answers with NO_CORRECTION posts nothing', async () => {
  _resetReviewAfterDeliveryForTests();
  const outcome = acceptedAnswer('after-delivery-stands', 'The notes cover two controlled items.');
  let corrected = 0;
  registerReviewAfterDelivery({ sessionId: outcome.identity.sessionId, sourceUserSeq: outcome.identity.sourceUserSeq,
    objective: OBJECTIVE, review: async () => ({ review: 'rejected', finding: 'The notes have three items.' }),
    correct: async () => { corrected += 1; return NO_CORRECTION_REPLY; } });
  const committed = commitTurnOutcome(outcome);
  const ruling = await settled(outcome.identity.sessionId);
  assert.equal(ruling.review, 'rejected');
  assert.equal(ruling.reviewNote, 'The notes have three items.');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(corrected, 1);
  const terminals = listEvents(outcome.identity.sessionId, { types: ['conversation_completed'] });
  assert.deepEqual(terminals.map((row) => row.id), [committed.event.id], 'no follow-up message');
  // Reopened, the answer shows the ruling, never "still checking".
  const { reconstructHarnessTranscript } = await import('./transcript.js');
  const reopened = reconstructHarnessTranscript(outcome.identity.sessionId).find((turn) => turn.role === 'assistant');
  const terminal = (reopened as { terminal?: Record<string, unknown> } | undefined)?.terminal;
  assert.equal(terminal?.review, 'rejected');
  assert.equal(terminal?.reviewNote, 'The notes have three items.');
});

test('the settled ruling reaches the clients as a bounded, closed shape', () => {
  createSession({ id: 'after-delivery-public', kind: 'chat' });
  const row = appendEvent({ sessionId: 'after-delivery-public', turn: 0, role: 'system', type: 'completion_review_settled', data: {
    version: 1, sourceUserSeq: 7, terminalEventId: 'evt', review: 'rejected', reviewNote: 'Missing the third item.',
    verdictEventId: 'verdict', workSourceUserSeq: 5,
  } });
  const projected = projectHarnessEventForPublic(row);
  assert.deepEqual(projected?.data, { version: 1, sourceUserSeq: 7, review: 'rejected', reviewNote: 'Missing the third item.' });
  const forged = appendEvent({ sessionId: 'after-delivery-public', turn: 0, role: 'user', type: 'completion_review_settled', data: {
    version: 1, sourceUserSeq: 7, review: 'checked' } });
  assert.equal(projectHarnessEventForPublic(forged), null, 'only the host writes a ruling');
  const unknown = appendEvent({ sessionId: 'after-delivery-public', turn: 0, role: 'system', type: 'completion_review_settled', data: {
    version: 1, sourceUserSeq: 7, review: 'checking' } });
  assert.equal(projectHarnessEventForPublic(unknown), null, 'a ruling settles; it never re-opens the check');
});

test('a reply that ends by asking the owner something keeps its review before delivery', () => {
  for (const text of ['Which reporting period should I use?', 'Here is the draft.\n\nWant me to send it?**',
    'Two options:\n- A\n- B\n\nWhich one do you prefer?"', 'どちらにしますか？']) {
    assert.equal(replyEndsOnQuestion(text), true, text);
  }
  for (const text of ['The report is saved at https://example.test/report?id=1.', 'Done? Yes. The file is saved.',
    'The summary is below.\n\nIt covers both items.']) {
    assert.equal(replyEndsOnQuestion(text), false, text);
  }
});

test('a correction that ends by asking the owner is published waiting on them, not as a finished answer', async () => {
  _resetReviewAfterDeliveryForTests();
  const outcome = acceptedAnswer('after-delivery-asks', 'The notes cover two controlled items.');
  registerReviewAfterDelivery({ sessionId: outcome.identity.sessionId, sourceUserSeq: outcome.identity.sourceUserSeq,
    objective: OBJECTIVE, review: async () => ({ review: 'rejected', finding: 'The third item was never summarized.' }),
    correct: async () => 'I stopped short: the third item is missing. I would read it and add it now. Shall I proceed?' });
  commitTurnOutcome(outcome);
  await settled(outcome.identity.sessionId);
  for (let waited = 0; waited < 200; waited += 1) {
    if (listEvents(outcome.identity.sessionId, { types: ['conversation_completed'] }).length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const terminals = listEvents(outcome.identity.sessionId, { types: ['conversation_completed'] });
  assert.equal(terminals.length, 2, 'the correction is its own published turn');
  const correction = terminals.at(-1)!;
  assert.equal(correction.data.awaitingUser, true, 'a correction ending on a question waits on the owner');
  assert.match(String(correction.data.reply), /Shall I proceed\?$/);
});

for (const status of ['done', 'needs_input'] as const) {
  test(`an unreviewed deferred correction cannot teach a lasting lesson (${status})`, async (t) => {
    _resetReviewAfterDeliveryForTests();
    const { _setCheckLessonModelForTests } = await import('../../memory/check-lessons.js');
    const { getFact, rememberFact, searchFactsByText } = await import('../../memory/facts.js');
    t.after(() => _setCheckLessonModelForTests(null));
    const sessionId = `after-delivery-unreviewed-lesson-${status}`;
    const objective = `TEST FIXTURE ${sessionId}: remember the four controlled project labels.`;
    const original = 'The four controlled labels are stored as four separate memories.';
    const finding = 'No memory_remember calls ran, so none of the four labels were stored.';
    const correction = status === 'done'
      ? 'The four controlled labels were not stored.'
      : 'The four controlled labels were not stored. Shall I save them?';
    const unsafeLesson = `When retaining ${status} fixture labels, require explicit memory_remember calls because automatic storage never counts.`;
    const learningRequests: string[] = [];
    _setCheckLessonModelForTests(async (request) => {
      // Other fixtures can still finish their own background work. Only this
      // exact request may produce the deliberately unsupported lesson.
      if (JSON.parse(request).request !== objective) return { lessons: [] };
      learningRequests.push(request);
      return { lessons: [unsafeLesson] };
    });
    const outcome = acceptedAnswer(sessionId, original, objective);
    const fact = rememberFact({ kind: 'project', sessionId,
      content: 'Controlled labels: A Amber, B Cobalt, C Silver, D Indigo.' });
    const committed = commitTurnOutcome(outcome);
    assert.equal(committed.presentation.text, original);
    // Call the same deferred launcher the committer schedules, using a real
    // published terminal. Await its entire work, including any attempted
    // learning, rather than asserting absence after a timer.
    const reviewed: string[] = [];
    const corrected: Array<{ published: string; finding: string }> = [];
    const observedRulings: string[] = [];
    assert.equal(registerReviewAfterDelivery({ sessionId,
      sourceUserSeq: outcome.identity.sourceUserSeq, objective,
      review: async (published) => {
        reviewed.push(published);
        return { review: 'rejected', finding };
      },
      correct: async (published, rejectedFinding) => {
        corrected.push({ published, finding: rejectedFinding });
        return correction;
      },
    }), true);
    await launchReviewAfterDelivery({ sessionId,
      workSourceUserSeq: outcome.identity.sourceUserSeq,
      sourceUserSeq: outcome.identity.sourceUserSeq,
      terminalEventId: committed.event.id,
      publishedText: original,
      afterRuling: (ruling) => observedRulings.push(ruling),
    });
    const ruling = await settled(sessionId);
    assert.equal(ruling.terminalEventId, committed.event.id);
    assert.equal(ruling.review, 'rejected');
    assert.deepEqual(observedRulings, ['rejected']);
    assert.deepEqual(reviewed, [original]);
    assert.deepEqual(corrected, [{ published: original, finding }]);
    const terminals = listEvents(sessionId, { types: ['conversation_completed'] });
    assert.equal(terminals.length, 2, 'the correction still publishes exactly once');
    const replacement = terminals.at(-1)!;
    assert.equal(replacement.data.reply, correction);
    assert.equal((replacement.data.presentation as { status?: string }).status, status);
    assert.notEqual(replacement.data.sourceUserSeq, outcome.identity.sourceUserSeq);
    const child = listEvents(sessionId, { types: ['user_input_received'] })
      .find(row => row.seq === replacement.data.sourceUserSeq);
    assert.equal(child?.data.sourceId, `answer-check:${outcome.identity.sourceUserSeq}`);
    assert.equal(getFact(fact.id)?.content, fact.content, 'publication never changes the stored labels');
    assert.equal(learningRequests.length, 0, 'publication is not an accepting review of the correction');
    assert.equal(searchFactsByText(unsafeLesson, 20).filter(row => row.content.includes(unsafeLesson)).length, 0,
      'an unreviewed correction must not become persistent feedback');
  });
}
