import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const PRIOR_HOME = process.env.CLEMENTINE_HOME;
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-task-continuity-runtime-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';

const eventlog = await import('./eventlog.js');
const continuity = await import('../../memory/task-continuity.js');
const runtime = await import('./task-continuity-runtime.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { discoveryGovernor } = await import('./discovery-governor.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
  if (PRIOR_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PRIOR_HOME;
});

function accepted(sessionId: string, text: string, kind: 'chat' | 'execution' = 'chat') {
  if (!eventlog.getSession(sessionId)) eventlog.createSession({ id: sessionId, kind });
  const attempt = eventlog.beginRunAttempt(sessionId);
  return eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text },
  });
}

function commitClarification(input: {
  sessionId: string;
  sourceSeq: number;
  question?: string;
  options?: string[];
  source?: string;
  reason?: string;
  purpose?: 'clarification' | 'approval' | 'mixed';
  bundled?: boolean;
  awaitingSourceSeq?: number;
  awaitingTurn?: number;
  withResolvedCapability?: boolean;
}) {
  const question = input.question ?? 'Which connected calendar should I use?';
  if (input.withResolvedCapability) {
    eventlog.appendEvent({
      sessionId: input.sessionId,
      turn: 1,
      role: 'system',
      type: 'capability_resolution',
      data: {
        sourceUserSeq: input.sourceSeq,
        registryAvailable: true,
        entries: [{
          intent: 'list calendar events',
          kind: 'builtin',
          identifier: 'calendar_list_events',
          status: 'proven',
          connection: 'not_applicable',
          effectClass: 'read',
        }],
      },
    });
  }
  eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: input.awaitingTurn ?? 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question,
      ...(input.options ? { options: input.options } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
      ...(input.bundled ? { bundled: true } : {}),
      sourceUserSeq: input.awaitingSourceSeq ?? input.sourceSeq,
    },
  });
  const identity = { sessionId: input.sessionId, turn: 1, sourceUserSeq: input.sourceSeq };
  return commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: question },
  });
}

test('typed clarification terminal creates a bounded exact-source packet only after commit', () => {
  const sessionId = 'continuity-terminal';
  const source = accepted(sessionId, 'List tomorrow’s calendar events.');
  assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId }), { status: 'none' });
  commitClarification({
    sessionId,
    sourceSeq: source.seq,
    options: ['Work calendar', 'Personal calendar'],
    withResolvedCapability: true,
  });
  const packet = continuity.peekTaskContinuityPacket({ sessionId });
  assert.equal(packet.status, 'available');
  if (packet.status === 'available') {
    assert.equal(packet.packet.originatingSourceUserSeq, source.seq);
    assert.deepEqual(packet.packet.pause.options, ['Work calendar', 'Personal calendar']);
    assert.deepEqual(packet.packet.capabilities.map((row) => row.identifier), ['calendar_list_events']);
    assert.ok(packet.packet.capabilities.every((row) => row.resourceRefs.length === 0));
  }
});

test('a user-resumable execution question receives the same exact-source continuity packet', () => {
  const sessionId = 'continuity-execution-terminal';
  const source = accepted(sessionId, 'Deploy the release.', 'execution');
  commitClarification({
    sessionId,
    sourceSeq: source.seq,
    question: 'Which environment should I use?',
    options: ['Staging', 'Production'],
  });
  const packet = continuity.peekTaskContinuityPacket({ sessionId });
  assert.equal(packet.status, 'available');
  if (packet.status === 'available') {
    assert.equal(packet.packet.originatingSourceUserSeq, source.seq);
    assert.equal(packet.packet.pause.question, 'Which environment should I use?');
  }
});

test('recovery, plan-first, and approval terminals do not mint generic clarification continuity', () => {
  for (const [suffix, sourceTag, reason] of [
    ['recovery', 'stall_recovery', undefined],
    ['plan', undefined, 'plan_first_needs_input'],
  ] as const) {
    const sessionId = `continuity-excluded-${suffix}`;
    const source = accepted(sessionId, 'Do the work.');
    commitClarification({ sessionId, sourceSeq: source.seq, source: sourceTag, reason });
    assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId }), { status: 'none' });
  }

  const sessionId = 'continuity-excluded-approval';
  const source = accepted(sessionId, 'Send the message.');
  const identity = { sessionId, turn: 1, sourceUserSeq: source.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'approval' },
    presentation: { kind: 'approval', text: 'Approve the send?', approvalId: 'approval-1' },
  });
  assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId }), { status: 'none' });

  for (const kind of ['workflow', 'agent'] as const) {
    const excludedSessionId = `continuity-excluded-${kind}`;
    eventlog.createSession({ id: excludedSessionId, kind });
    const excludedSource = eventlog.appendEvent({
      sessionId: excludedSessionId,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Continue the automated run.' },
    });
    commitClarification({ sessionId: excludedSessionId, sourceSeq: excludedSource.seq });
    assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId: excludedSessionId }), { status: 'none' });
  }
});

test('a modern awaiting event with a foreign source pointer cannot mint continuity', () => {
  const sessionId = 'continuity-foreign-awaiting-source';
  const source = accepted(sessionId, 'Deploy the release.');
  commitClarification({
    sessionId,
    sourceSeq: source.seq,
    awaitingSourceSeq: source.seq + 99,
  });
  assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId }), { status: 'none' });
});

test('a modern exact-source awaiting event survives a different internal loop turn', () => {
  const sessionId = 'continuity-awaiting-loop-turn';
  const source = accepted(sessionId, 'Inspect the local note.');
  commitClarification({
    sessionId,
    sourceSeq: source.seq,
    question: 'Should I update it?',
    options: ['Yes', 'No'],
    awaitingTurn: 7,
  });
  const packet = continuity.peekTaskContinuityPacket({ sessionId });
  assert.equal(packet.status, 'available');
  if (packet.status === 'available') {
    assert.equal(packet.packet.originatingSourceUserSeq, source.seq);
    assert.equal(packet.packet.pause.question, 'Should I update it?');
  }
});

test('clarification answer classification is conversational but question-shaped and fail-closed', () => {
  const binary = { kind: 'clarification' as const, question: 'Should I send it?', options: ['Yes', 'No'] };
  assert.deepEqual(runtime.classifyClarificationAnswer('Yes, please.', binary), { disposition: 'affirmed' });
  assert.deepEqual(runtime.classifyClarificationAnswer('No.', binary), {
    disposition: 'declined',
    selectedOption: 'No',
  });
  assert.deepEqual(
    runtime.classifyClarificationAnswer(
      'No—leave that note alone. Instead, what is 15 × 9? Answer that naturally without tools.',
      binary,
    ),
    {
      disposition: 'declined_with_new_task',
      activeTaskInput: 'what is 15 × 9? Answer that naturally without tools.',
    },
  );
  for (const answer of [
    'No, but send it to Alice instead',
    'No—use Alice instead. Then tell me when it is sent.',
    'No—leave that note alone. Instead, send it to Alice.',
    'Instead, what is 15 × 9?',
  ]) {
    assert.equal(runtime.classifyClarificationAnswer(answer, binary), null, answer);
  }

  const conversationalBinary = {
    kind: 'clarification' as const,
    question: 'Want me to create that small note, or leave it alone for now?',
    options: ['Create it', 'Leave it alone'],
  };
  assert.deepEqual(runtime.classifyClarificationAnswer('Create it', conversationalBinary), {
    disposition: 'affirmed',
    selectedOption: 'Create it',
  });
  assert.deepEqual(runtime.classifyClarificationAnswer('Leave it alone', conversationalBinary), {
    disposition: 'declined',
    selectedOption: 'Leave it alone',
  });
  assert.deepEqual(
    runtime.classifyClarificationAnswer(
      'No—leave that note alone. Instead, what is 15 × 9? Answer that naturally without tools.',
      conversationalBinary,
    ),
    {
      disposition: 'declined_with_new_task',
      activeTaskInput: 'what is 15 × 9? Answer that naturally without tools.',
    },
  );
  const namedWantChoice = {
    kind: 'clarification' as const,
    question: 'Want me to use the work calendar or the personal calendar?',
    options: [],
  };
  assert.equal(runtime.classifyClarificationAnswer('Yes', namedWantChoice), null);

  const choices = {
    kind: 'clarification' as const,
    question: 'Which connected calendar should I use?',
    options: ['Work calendar', 'Personal calendar'],
  };
  for (const answer of ['yes', 'go ahead', 'continue', 'proceed', 'do it', 'sure']) {
    assert.equal(
      runtime.classifyClarificationAnswer(answer, choices),
      null,
      `${answer} cannot fill a named slot`,
    );
  }
  assert.deepEqual(runtime.classifyClarificationAnswer('first', choices), {
    disposition: 'selected',
    selectedOption: 'Work calendar',
  });
  assert.equal(
    runtime.classifyClarificationAnswer('first', { ...choices, options: [] }),
    null,
    'an ordinal without options is not an answer',
  );
  assert.equal(runtime.classifyClarificationAnswer('Send it', choices), null);
  assert.equal(runtime.classifyClarificationAnswer('Explain graph databases', choices), null);
  assert.equal(runtime.classifyClarificationAnswer('No, but send it to Alice instead', choices), null);
  assert.deepEqual(runtime.classifyClarificationAnswer('Draft only', {
    kind: 'clarification',
    question: 'Send it now or keep it as a draft?',
    options: ['Send now', 'Draft only'],
  }), { disposition: 'declined', selectedOption: 'Draft only' });
  assert.deepEqual(runtime.classifyClarificationAnswer('Production', {
    kind: 'clarification',
    question: 'Which environment should I use?',
    options: [],
  }), { disposition: 'provided' });
});

test('approval, mixed, and bundled awaits cannot mint a generic clarification packet', () => {
  for (const [suffix, extra] of [
    ['approval-purpose', { purpose: 'approval' as const }],
    ['mixed-purpose', { purpose: 'mixed' as const }],
    ['bundle', { purpose: 'clarification' as const, bundled: true }],
  ] as const) {
    const sessionId = `continuity-awaiting-${suffix}`;
    const source = accepted(sessionId, 'Prepare the update.');
    commitClarification({ sessionId, sourceSeq: source.seq, ...extra });
    assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId }), { status: 'none' });
  }
});

test('a conversational ordinal answer resumes private task context while preserving literal user text', async () => {
  const sessionId = 'continuity-answer';
  const source = accepted(sessionId, 'List tomorrow’s calendar events.');
  commitClarification({
    sessionId,
    sourceSeq: source.seq,
    question: 'Work or personal calendar?',
    options: ['Work calendar', 'Personal calendar'],
    withResolvedCapability: true,
  });
  const answer = accepted(sessionId, 'I think the first one.');
  const enriched = await runtime.enrichAcceptedRequestWithTaskContinuity({
    sessionId,
    sourceUserSeq: answer.seq,
    message: 'I think the first one.',
  }, answer.seq);
  assert.equal(enriched.message, 'I think the first one.');
  assert.equal(enriched.displayMessage, undefined);
  assert.equal(enriched.taskContinuation?.answer, 'I think the first one.');
  assert.equal(enriched.taskContinuation?.disposition, 'selected');
  assert.equal(enriched.taskContinuation?.selectedOption, 'Work calendar');
  assert.match(enriched.semanticTaskInput ?? '', /List tomorrow’s calendar events/);
  assert.match(enriched.semanticTaskInput ?? '', /Work or personal calendar/);
  assert.ok((enriched.semanticTaskInput?.length ?? 0) <= 1_600);
  assert.ok(enriched.turnCandidates?.candidates.some((row) => row.identifier === 'calendar_list_events'));
  assert.equal(discoveryGovernor.getTaskState({ sessionId, sourceUserSeq: answer.seq })?.policy.knownCapability, true);
});

test('a decline keeps conversational context but inherits no capability authority', async () => {
  const sessionId = 'continuity-decline';
  const source = accepted(sessionId, 'Send the client email.');
  commitClarification({
    sessionId,
    sourceSeq: source.seq,
    question: 'Should I send it?',
    options: ['Yes', 'No'],
    purpose: 'clarification',
    withResolvedCapability: true,
  });
  const answer = accepted(sessionId, 'No.');
  const enriched = await runtime.enrichAcceptedRequestWithTaskContinuity({
    sessionId,
    sourceUserSeq: answer.seq,
    message: 'No.',
  }, answer.seq);
  assert.equal(enriched.message, 'No.');
  assert.equal(enriched.taskContinuation?.disposition, 'declined');
  assert.equal(enriched.semanticTaskInput, 'No.');
  assert.equal(enriched.taskContinuation?.parentInput, 'Send the client email.');
  assert.equal(enriched.taskContinuation?.question, 'Should I send it?');
  assert.equal(enriched.taskContinuation?.answer, 'No.');
  assert.deepEqual(enriched.turnCandidates?.candidates, []);
  assert.deepEqual(enriched.turnCandidates?.matches, []);
  assert.deepEqual(enriched.turnCandidates?.pinnedTools, []);
  assert.equal(
    enriched.turnCandidates?.candidates.some((row) => row.identifier === 'calendar_list_events'),
    false,
  );
  assert.notEqual(
    discoveryGovernor.getTaskState({ sessionId, sourceUserSeq: answer.seq })?.policy.knownCapability,
    true,
  );

  const later = accepted(sessionId, 'Yes.');
  const laterRequest = await runtime.enrichAcceptedRequestWithTaskContinuity({
    sessionId,
    sourceUserSeq: later.seq,
    message: 'Yes.',
  }, later.seq);
  assert.equal(laterRequest.taskContinuation, undefined);
  assert.equal(laterRequest.semanticTaskInput, undefined);
  assert.equal(laterRequest.taskContinuationResolved, true);
});

test('a parent decline with independent new work scopes semantics to only the fresh clause', async () => {
  const sessionId = 'continuity-decline-new-task';
  const source = accepted(sessionId, 'Update the local note.');
  commitClarification({
    sessionId,
    sourceSeq: source.seq,
    question: 'Should I update it?',
    options: ['Yes', 'No'],
    purpose: 'clarification',
    withResolvedCapability: true,
  });
  const text = 'No—leave that note alone. Instead, what is 15 × 9? Answer that naturally without tools.';
  const answer = accepted(sessionId, text);
  const request = { sessionId, sourceUserSeq: answer.seq, message: text };
  const enriched = await runtime.enrichAcceptedRequestWithTaskContinuity(request, answer.seq);
  assert.equal(enriched.message, text, 'provider-visible wording stays exact');
  assert.equal(enriched.taskContinuation?.disposition, 'declined_with_new_task');
  assert.equal(
    enriched.taskContinuation?.activeTaskInput,
    'what is 15 × 9? Answer that naturally without tools.',
  );
  assert.equal(
    enriched.semanticTaskInput,
    'what is 15 × 9? Answer that naturally without tools.',
  );
  assert.equal(enriched.taskContinuation?.parentInput, 'Update the local note.');
  assert.deepEqual(enriched.taskContinuation?.capabilities, []);
  assert.equal(
    enriched.turnCandidates?.candidates.some((row) => row.identifier === 'calendar_list_events'),
    false,
  );
  assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId }), { status: 'none' });

  eventlog.closeEventLog();
  const replay = await runtime.enrichAcceptedRequestWithTaskContinuity(request, answer.seq);
  assert.equal(replay.taskContinuation?.disposition, 'declined_with_new_task');
  assert.equal(replay.semanticTaskInput, 'what is 15 × 9? Answer that naturally without tools.');
  assert.equal(replay.message, text);
});

test('a conversational Want-me clarification revokes parent authority before independent new work', async () => {
  const sessionId = 'continuity-conversational-decline-new-task';
  const source = accepted(sessionId, 'Create the local note.');
  commitClarification({
    sessionId,
    sourceSeq: source.seq,
    question: 'Want me to create that small note at proof/conversation-switch-resume.md, or leave it alone for now?',
    options: ['Create it', 'Leave it alone'],
    purpose: 'clarification',
    withResolvedCapability: true,
  });
  const text = 'No—leave that note alone. Instead, what is 15 × 9? Answer that naturally without tools.';
  const answer = accepted(sessionId, text);
  const enriched = await runtime.enrichAcceptedRequestWithTaskContinuity({
    sessionId,
    sourceUserSeq: answer.seq,
    message: text,
  }, answer.seq);

  assert.equal(enriched.message, text);
  assert.equal(enriched.taskContinuation?.disposition, 'declined_with_new_task');
  assert.equal(enriched.semanticTaskInput, 'what is 15 × 9? Answer that naturally without tools.');
  assert.deepEqual(enriched.taskContinuation?.capabilities, []);
  assert.equal(
    enriched.turnCandidates?.candidates.some((row) => row.identifier === 'calendar_list_events'),
    false,
  );
  assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId }), { status: 'none' });
});

test('whitespace-equivalent caller text cannot inherit exact-source private context', async () => {
  const sessionId = 'continuity-byte-exact-answer';
  const source = accepted(sessionId, 'Deploy the release.');
  commitClarification({
    sessionId,
    sourceSeq: source.seq,
    question: 'Which environment should I use?',
  });
  const answer = accepted(sessionId, 'Use   production.');
  const enriched = await runtime.enrichAcceptedRequestWithTaskContinuity({
    sessionId,
    sourceUserSeq: answer.seq,
    message: 'Use production.',
  }, answer.seq);
  assert.equal(enriched.taskContinuation, undefined);
  assert.equal(enriched.semanticTaskInput, undefined);
  assert.equal(enriched.taskContinuationResolved, undefined);
  assert.equal(continuity.peekTaskContinuityPacket({ sessionId }).status, 'available');

  const exact = await runtime.enrichAcceptedRequestWithTaskContinuity({
    sessionId,
    sourceUserSeq: answer.seq,
    message: 'Use   production.',
  }, answer.seq);
  assert.equal(exact.taskContinuation?.answer, 'Use   production.');
});

test('a mismatched request source pointer cannot consume another accepted source packet', async () => {
  const sessionId = 'continuity-request-source-mismatch';
  const source = accepted(sessionId, 'Deploy the release.');
  commitClarification({ sessionId, sourceSeq: source.seq, question: 'Which environment?' });
  const answer = accepted(sessionId, 'Production');
  const enriched = await runtime.enrichAcceptedRequestWithTaskContinuity({
    sessionId,
    sourceUserSeq: source.seq,
    message: 'Production',
  }, answer.seq);
  assert.equal(enriched.taskContinuation, undefined);
  assert.equal(enriched.taskContinuationResolved, undefined);
  assert.equal(continuity.peekTaskContinuityPacket({ sessionId }).status, 'available');
});

test('fresh-topic B dismisses A without inheriting semantic context or convergence authority', async () => {
  const sessionId = 'continuity-topic-change';
  const source = accepted(sessionId, 'List tomorrow’s calendar events.');
  commitClarification({ sessionId, sourceSeq: source.seq, options: ['Work', 'Personal'] });
  const answer = accepted(sessionId, 'Actually, can you explain graph databases?');
  const enriched = await runtime.enrichAcceptedRequestWithTaskContinuity({
    sessionId,
    sourceUserSeq: answer.seq,
    message: 'Actually, can you explain graph databases?',
    semanticTaskInput: 'caller-forged context',
  }, answer.seq);
  assert.equal(enriched.semanticTaskInput, undefined);
  assert.equal(enriched.taskContinuation, undefined);
  assert.equal(enriched.taskContinuationResolved, true);
  assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId }), { status: 'none' });
});

test('the exact consumer rehydrates after daemon reopen, but a later source cannot', async () => {
  const sessionId = 'continuity-restart';
  const source = accepted(sessionId, 'List tomorrow’s calendar events.');
  commitClarification({ sessionId, sourceSeq: source.seq, options: ['Work', 'Personal'] });
  const answer = accepted(sessionId, '1');
  const request = { sessionId, sourceUserSeq: answer.seq, message: '1' };
  const first = await runtime.enrichAcceptedRequestWithTaskContinuity(request, answer.seq);
  assert.equal(first.taskContinuation?.parentSourceUserSeq, source.seq);

  eventlog.closeEventLog();
  const replay = await runtime.enrichAcceptedRequestWithTaskContinuity(request, answer.seq);
  assert.equal(replay.taskContinuation?.packetId, first.taskContinuation?.packetId);
  assert.equal(replay.message, '1');

  const later = accepted(sessionId, 'Continue.');
  const refused = await runtime.enrichAcceptedRequestWithTaskContinuity({
    sessionId,
    sourceUserSeq: later.seq,
    message: 'Continue.',
  }, later.seq);
  assert.equal(refused.taskContinuation, undefined);
});

test('an either/or clarification invites a slot answer even without an interrogative keyword', () => {
  // Live 2026-08-09, byte-for-byte. The question offers two alternatives but
  // contains none of the fifteen interrogative keywords the gate listed, so a
  // plain answer classified as null, the pending packet was dismissed as
  // 'topic_changed', and the answered turn re-derived the task from scratch
  // with consequential:false / multiItem:false.
  const pause = {
    kind: 'clarification' as const,
    question: "Salesforce shows only Brett Lorenzini and Bobby Romano (your 8 direct reports) with past-due open opportunities — that's 2 reps, not 5. Want me to just draft check-ins for those 2, or did you mean a different/broader group of 5 reps (e.g. org-wide, not just your direct team)?",
    options: [] as string[],
  };
  assert.deepEqual(
    runtime.classifyClarificationAnswer('Just the 2 with past due ops', pause),
    { disposition: 'provided' },
    'an ordinary answer to an ordinary either/or question was dismissed as a new topic',
  );

  // The shape rule is DISJUNCTION, not the mere presence of "or". A statement
  // that happens to contain "or" is not a question and must not consume a packet.
  const notAQuestion = {
    kind: 'clarification' as const,
    question: 'I will draft two emails or so and let you know.',
    options: [] as string[],
  };
  assert.equal(
    runtime.classifyClarificationAnswer('Just the 2 with past due ops', notAQuestion),
    null,
    'a non-question containing "or" must not open the slot path',
  );

  // Fail-closed behaviour is unchanged: a compound answer that starts new work
  // is still not a slot answer, however the question was phrased.
  assert.equal(
    runtime.classifyClarificationAnswer('Just the 2, and also email my brother', pause),
    null,
    'a compound answer must still be refused',
  );
});
