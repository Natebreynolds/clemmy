import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-delivery-committer-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { actionBus } = await import('../action-bus.js');
const {
  AcceptedTaskTerminalPublicationError,
  appendEvent,
  appendTerminalEventOnce,
  createSession,
  listEvents,
} = await import('./eventlog.js');
const { commitTurnOutcome, completionDataForTurnOutcome } = await import('./delivery-committer.js');
const turnGraph = await import('../graph/turn-graph-shadow.js');
const expectedWork = await import('./expected-work-contract.js');
const acceptedAuthority = await import('./accepted-task-authority.js');
const {
  InvalidTurnOutcomeError,
  UnsafePresentationError,
  presentationEventForOutcome,
  presentationEventFromCompletionData,
  turnOutcomeId,
} = await import('./turn-outcome.js');
type TurnOutcome = import('./turn-outcome.js').TurnOutcome;

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function answer(sessionId: string, text: string): TurnOutcome {
  const identity = { sessionId, turn: 1, attemptId: `attempt-${sessionId}`, sourceUserSeq: 1 } as const;
  return {
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: { kind: 'answer', text },
    evidenceRefs: [{ kind: 'tool_result', id: 'tool-result-1' }],
  };
}

function acceptedAnswer(
  sessionId: string,
  text: string,
  options: { turn?: number; attemptId?: string; runId?: string } = {},
): TurnOutcome {
  const source = appendEvent({
    sessionId,
    turn: options.turn ?? 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Accepted request.' },
  });
  const identity = {
    sessionId,
    turn: source.turn,
    sourceUserSeq: source.seq,
    ...(options.attemptId ? { attemptId: options.attemptId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
  };
  return {
    ...answer(sessionId, text),
    id: turnOutcomeId(identity),
    identity,
  };
}

function acceptedFailedDiscoveryRead(sessionId: string) {
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Read the single most recent message in my Outlook Inbox and return its subject.',
    },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: source.seq,
      tool: 'tool_search',
      callId: 'failed-discovery',
      canonicalCallId: 'failed-discovery',
      accounting: 'top_level',
      topologyRole: 'control',
      effect: 'read',
      effectiveTool: 'tool_search',
    },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'discovery_governor_outcome',
    data: {
      sourceUserSeq: source.seq,
      callId: 'failed-discovery',
      outcome: 'timed_out',
    },
  });
  return { sessionId, turn: 1, sourceUserSeq: source.seq } as const;
}

function verifiedReadReceipt(outcome: TurnOutcome, salt = 'a'): Record<string, unknown> {
  return {
    version: 1,
    kind: 'single_collection_read',
    sourceUserSeq: outcome.identity.sourceUserSeq,
    attemptId: `verified-attempt-${salt}`,
    callId: `verified-call-${salt}`,
    toolName: 'PROOF_LIST_TASKS',
    outputDigest: createHash('sha256').update(`output-${salt}`).digest('hex'),
    objectiveDigest: createHash('sha256').update(`objective-${salt}`).digest('hex'),
    presentationDigest: createHash('sha256').update(outcome.presentation.text).digest('hex'),
  };
}

test('typed outcome projection ignores runtime-cast internal fields', () => {
  const outcome = {
    ...answer('projection', 'The account is healthy.'),
    internalSummary: 'judge chain and private prompt',
    rawModelOutput: 'summary: leaked',
  } as TurnOutcome;
  const presentation = presentationEventForOutcome(outcome);
  assert.equal(presentation.text, 'The account is healthy.');
  assert.equal('internalSummary' in presentation, false);
  assert.equal('rawModelOutput' in presentation, false);

  const data = completionDataForTurnOutcome(outcome, {
    metadata: {
      steps: 3,
      internalSummary: 'must not cross',
      reply: 'must not override the presentation',
    },
  });
  assert.equal(data.reply, 'The account is healthy.');
  assert.equal(data.steps, 3);
  assert.equal('internalSummary' in data, false);

  const nonWarm = completionDataForTurnOutcome(outcome, {
    metadata: {
      transport: 'host_harness',
      artifactId: 'not-a-procedure-artifact',
      laneDigest: 'not-a-digest',
      counters: { providerPayload: 'must not cross' },
      warmReadPolicyDigest: 'not-a-digest',
    },
  });
  assert.equal(nonWarm.transport, 'host_harness');
  assert.equal('artifactId' in nonWarm, false);
  assert.equal('laneDigest' in nonWarm, false);
  assert.equal('counters' in nonWarm, false);
  assert.equal('warmReadPolicyDigest' in nonWarm, false);
});

test('outcome id must be the canonical id derived from its exact turn identity', () => {
  const outcome = answer('noncanonical-id', 'This must not be published.');
  const forged = { ...outcome, id: 'brain:a-different-attempt' } as TurnOutcome;
  assert.throws(() => presentationEventForOutcome(forged), InvalidTurnOutcomeError);
  assert.throws(() => completionDataForTurnOutcome(forged), InvalidTurnOutcomeError);
});

test('the committer persists and publishes exactly one winning public answer', () => {
  const sessionId = 'commit-once';
  createSession({ id: sessionId, kind: 'chat' });
  const firstProposal = acceptedAnswer(sessionId, 'First committed answer.', {
    attemptId: 'attempt-first',
    runId: 'run-first',
  });
  const racedProposal = {
    ...firstProposal,
    identity: {
      sessionId,
      turn: firstProposal.identity.turn,
      sourceUserSeq: firstProposal.identity.sourceUserSeq,
      attemptId: 'attempt-fallover',
      runId: 'run-fallover',
    },
    presentation: { kind: 'answer', text: 'Losing retry answer.' },
  } as TurnOutcome;
  const publicEvents: unknown[] = [];
  const detach = actionBus.subscribe((event) => {
    if (event.kind === 'harness.public_event' && event.sessionId === sessionId) publicEvents.push(event);
  });
  try {
    const first = commitTurnOutcome(firstProposal);
    const raced = commitTurnOutcome(racedProposal, {
      metadata: { verifiedReadCompletionReceipt: verifiedReadReceipt(racedProposal, 'loser') },
    });
    assert.equal(first.inserted, true);
    assert.equal(raced.inserted, false);
    assert.equal(raced.presentation.text, 'First committed answer.');

    const completions = listEvents(sessionId, { types: ['conversation_completed'] });
    assert.equal(completions.length, 1);
    assert.equal(completions[0].data.reply, 'First committed answer.');
    assert.equal(
      completions[0].data.verifiedReadCompletionReceipt,
      undefined,
      'a losing attempt cannot append proof metadata to the first writer',
    );
    assert.equal(
      (completions[0].data.presentation as { audience?: string }).audience,
      'user',
    );
    assert.equal(publicEvents.length, 1, 'only the inserted terminal is published');
  } finally {
    detach();
  }
});

test('failed discovery for a current-state read is durably held instead of stamped success/done', () => {
  const identity = acceptedFailedDiscoveryRead('failed-discovery-current-read');
  const committed = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: {
      kind: 'answer',
      text: 'I cannot complete this read here. ASK: Could you re-run it?',
    },
  });

  assert.equal(committed.presentation.status, 'blocked');
  assert.equal(committed.presentation.kind, 'blocked');
  assert.equal(committed.event.data.reason, 'verification_required');
  assert.equal((committed.event.data.turnOutcome as { status?: unknown }).status, 'blocked');
  assert.equal(committed.event.data.delivered, false);
  assert.deepEqual(committed.event.data.verificationMissing, [
    'discovery_attempted_without_business_evidence',
  ]);
});

test('a judge cannot stamp success after plan_task accepted a read but no downstream operation ran', () => {
  const sessionId = 'accepted-read-plan-zero-downstream';
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Read the single most recent message in my Outlook Inbox and return its subject.',
    },
  });
  assert.ok(turnGraph.recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq: source.seq, turn: source.turn },
  }));
  acceptedAuthority.requireAcceptedTaskAuthority({
    sessionId,
    sourceUserSeq: source.seq,
  });
  const frozen = expectedWork.freezeActionExpectedWorkContract({
    sessionId,
    sourceUserSeq: source.seq,
    proposal: {
      version: 1,
      operations: [{
        id: 'read-latest-inbox',
        effect: 'read',
        coverage: 'single',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    },
  });
  assert.equal(frozen.status, 'fixed', JSON.stringify(frozen));
  const identity = { sessionId, sourceUserSeq: source.seq, turn: source.turn } as const;
  const committed = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'done',
    resumable: false,
    presentation: {
      kind: 'answer',
      text: 'I could not read the mailbox, so I do not have a source-backed subject yet.',
    },
  }, {
    presentationAlreadyDiscloses: true,
    terminalJudgeDisposition: 'deliver',
    legacyReason: 'success',
  });

  assert.equal(committed.presentation.status, 'blocked');
  assert.equal(committed.presentation.kind, 'blocked');
  assert.equal(committed.presentation.resumable, true);
  assert.equal(committed.event.data.reason, 'verification_required');
  assert.equal(committed.event.data.delivered, false);
  assert.notEqual(committed.event.data.reason, 'success');
  assert.deepEqual(committed.event.data.verificationMissing, ['requirement_unobserved']);
});

test('an authored ASK after failed discovery keeps its existing needs_input terminal', () => {
  const identity = acceptedFailedDiscoveryRead('failed-discovery-authored-ask');
  const committed = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: {
      kind: 'question',
      text: 'The Outlook read could not start. Would you like me to retry?',
    },
  });

  assert.equal(committed.presentation.status, 'needs_input');
  assert.equal(committed.presentation.kind, 'question');
  assert.equal(committed.event.data.reason, 'awaiting_user_input');
  assert.equal((committed.event.data.turnOutcome as { status?: unknown }).status, 'needs_input');
  assert.equal(committed.event.data.awaitingUser, true);
});

test('verified read receipt is strictly validated and atomically follows the winning answer', () => {
  const sessionId = 'atomic-verified-read-receipt';
  createSession({ id: sessionId, kind: 'chat' });
  const firstProposal = acceptedAnswer(sessionId, 'First verified answer.');
  const firstReceipt = verifiedReadReceipt(firstProposal, 'first');
  const winner = commitTurnOutcome(firstProposal, {
    metadata: { verifiedReadCompletionReceipt: firstReceipt },
  });
  assert.equal(winner.inserted, true);
  assert.deepEqual(winner.event.data.verifiedReadCompletionReceipt, firstReceipt);

  const racedProposal = {
    ...firstProposal,
    presentation: { kind: 'answer', text: 'A different losing answer.' },
  } as TurnOutcome;
  const racedReceipt = verifiedReadReceipt(racedProposal, 'raced');
  const loser = commitTurnOutcome(racedProposal, {
    metadata: { verifiedReadCompletionReceipt: racedReceipt },
  });
  assert.equal(loser.inserted, false);
  assert.equal(loser.presentation.text, 'First verified answer.');
  assert.deepEqual(loser.event.data.verifiedReadCompletionReceipt, firstReceipt);

  const badSource = { ...firstReceipt, sourceUserSeq: firstProposal.identity.sourceUserSeq + 1 };
  assert.throws(
    () => completionDataForTurnOutcome(firstProposal, {
      metadata: { verifiedReadCompletionReceipt: badSource },
    }),
    InvalidTurnOutcomeError,
  );
  const badDigest = { ...firstReceipt, presentationDigest: '0'.repeat(64) };
  assert.throws(
    () => completionDataForTurnOutcome(firstProposal, {
      metadata: { verifiedReadCompletionReceipt: badDigest },
    }),
    InvalidTurnOutcomeError,
  );
  const extraKey = { ...firstReceipt, untrusted: true };
  assert.throws(
    () => completionDataForTurnOutcome(firstProposal, {
      metadata: { verifiedReadCompletionReceipt: extraKey },
    }),
    InvalidTurnOutcomeError,
  );
});

test('invalid status/presentation combinations and narrated control text fail closed', () => {
  assert.throws(
    () => presentationEventForOutcome({
      ...answer('bad-shape', 'Question?'),
      status: 'needs_input',
      resumable: true,
      needs: { kind: 'input' },
      presentation: { kind: 'answer', text: 'Question?' },
    } as unknown as TurnOutcome),
    InvalidTurnOutcomeError,
  );

  assert.throws(
    () => presentationEventForOutcome(answer('unsafe', [
      'summary: internal',
      'reply: public',
      'done: true',
      'nextAction: completed',
      'reason: internal',
    ].join('\n'))),
    UnsafePresentationError,
  );

  assert.throws(
    () => presentationEventForOutcome(answer(
      'unsafe-compact',
      'done=true  \nnextAction=completed  \nReconciliation is unnecessary.',
    )),
    UnsafePresentationError,
  );

  const rawJsonEnvelope = JSON.stringify({
    summary: 'Reconciliation is unnecessary.',
    reply: 'Reconciliation is unnecessary.',
    done: true,
    nextAction: 'completed',
    reason: null,
  });
  assert.throws(
    () => presentationEventForOutcome(answer('unsafe-json-envelope', rawJsonEnvelope)),
    UnsafePresentationError,
    'the typed write boundary rejects the same whole JSON envelope as legacy projection',
  );

  assert.equal(
    presentationEventForOutcome(answer(
      'safe-natural-language',
      'The job is done. Next action: review tomorrow.',
    )).text,
    'The job is done. Next action: review tomorrow.',
  );

  const assignmentResult = 'summary = "Sales grew 5%"\nreason = "Higher conversion"';
  assert.equal(
    presentationEventForOutcome(answer('safe-assignment-result', assignmentResult)).text,
    assignmentResult,
  );

  const configExample = '```ini\ndone=true\nnextAction=completed\n```';
  assert.equal(
    presentationEventForOutcome(answer('safe-config-example', configExample)).text,
    configExample,
  );

  const prefixedJson = `Example config:\n${rawJsonEnvelope}`;
  assert.equal(
    presentationEventForOutcome(answer('safe-prefixed-json-example', prefixedJson)).text,
    prefixedJson,
  );

  const fencedJson = `\`\`\`json\n${rawJsonEnvelope}\n\`\`\``;
  assert.equal(
    presentationEventForOutcome(answer('safe-fenced-json-example', fencedJson)).text,
    fencedJson,
  );
});

test('approval outcome requires and preserves an exact approval id', () => {
  const identity = { sessionId: 'approval-shape', turn: 2, sourceUserSeq: 12 } as const;
  const presentation = presentationEventForOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'approval' },
    presentation: { kind: 'approval', text: 'Approve sending the message?', approvalId: 'apr-123' },
  });
  assert.equal(presentation.kind, 'approval');
  assert.equal(presentation.approvalId, 'apr-123');
});

test('typed completion decoder validates duplicated id, identity, and status authority fields', () => {
  const outcome = answer('strict-decode', 'Strictly decoded answer.');
  const canonical = completionDataForTurnOutcome(outcome);
  canonical.terminalKey = outcome.id;
  assert.equal(presentationEventFromCompletionData(canonical)?.text, 'Strictly decoded answer.');

  const contradictions: Array<[string, (data: Record<string, unknown>) => void]> = [
    ['presentation id', (data) => {
      (data.presentation as Record<string, unknown>).id = 'brain:foreign:presentation';
    }],
    ['outcome id', (data) => {
      (data.presentation as Record<string, unknown>).outcomeId = 'brain:foreign';
    }],
    ['top-level attempt identity', (data) => { data.attemptId = 'attempt-foreign'; }],
    ['durable status', (data) => {
      (data.turnOutcome as Record<string, unknown>).status = 'failed';
    }],
    ['terminal key', (data) => { data.terminalKey = 'brain:foreign'; }],
  ];
  for (const [label, mutate] of contradictions) {
    const data = structuredClone(canonical) as Record<string, unknown>;
    mutate(data);
    assert.throws(
      () => presentationEventFromCompletionData(data),
      InvalidTurnOutcomeError,
      `${label} contradiction must fail closed`,
    );
  }
});

test('the public writer rejects a contradictory typed winner before persistence', () => {
  const sessionId = 'contradictory-winner';
  createSession({ id: sessionId, kind: 'chat' });
  const outcome = acceptedAnswer(sessionId, 'Losing retry.');
  const corrupt = completionDataForTurnOutcome({
    ...outcome,
    presentation: { kind: 'answer', text: 'First writer text.' },
  } as TurnOutcome);
  (corrupt.turnOutcome as Record<string, unknown>).status = 'failed';
  assert.throws(
    () => appendTerminalEventOnce({
      sessionId,
      turn: outcome.identity.turn,
      role: 'system',
      data: corrupt,
    }, outcome.id),
    (error: unknown) => {
      assert.ok(error instanceof AcceptedTaskTerminalPublicationError);
      assert.equal(error.status, 'conflict');
      return true;
    },
  );
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0);
});

test('an explicit pre-typed terminal winner remains compatible', () => {
  const sessionId = 'legacy-winner';
  createSession({ id: sessionId, kind: 'chat' });
  const outcome = acceptedAnswer(sessionId, 'Losing modern retry.');
  appendTerminalEventOnce({
    sessionId,
    turn: outcome.identity.turn,
    role: 'system',
    data: {
      reply: 'First legacy answer.',
      summary: 'First legacy answer.',
      reason: 'success',
      delivered: true,
    },
  }, outcome.id);

  const result = commitTurnOutcome(outcome);
  assert.equal(result.inserted, false);
  assert.equal(result.presentation.text, 'First legacy answer.');
  assert.equal(result.presentation.outcomeId, outcome.id);
  assert.deepEqual(result.presentation.identity, outcome.identity);
});

test('a pre-upgrade typed brain terminal wins by exact source over a new turn-key retry', () => {
  const sessionId = 'upgrade-attempt-winner';
  createSession({ id: sessionId, kind: 'chat' });
  const proposed = acceptedAnswer(sessionId, 'Losing upgraded retry.');
  const legacyIdentity = {
    sessionId,
    turn: proposed.identity.turn,
    sourceUserSeq: proposed.identity.sourceUserSeq,
    attemptId: 'attempt-pre-upgrade',
    runId: 'run-pre-upgrade',
  };
  const legacyOutcome = {
    ...proposed,
    id: turnOutcomeId(legacyIdentity),
    identity: legacyIdentity,
    presentation: { kind: 'answer', text: 'The pre-upgrade answer already committed.' },
  } as TurnOutcome;
  const legacyData = completionDataForTurnOutcome(legacyOutcome);
  const legacyKey = `brain:${legacyIdentity.attemptId}`;
  (legacyData.presentation as Record<string, unknown>).id = `${legacyKey}:presentation`;
  (legacyData.presentation as Record<string, unknown>).outcomeId = legacyKey;
  (legacyData.turnOutcome as Record<string, unknown>).id = legacyKey;
  legacyData.terminalKey = legacyKey;
  appendEvent({
    sessionId,
    turn: legacyIdentity.turn,
    role: 'system',
    type: 'conversation_completed',
    data: legacyData,
  });

  const result = commitTurnOutcome(proposed);
  assert.equal(result.inserted, false);
  assert.equal(result.presentation.text, 'The pre-upgrade answer already committed.');
  assert.equal(result.presentation.outcomeId, proposed.id);
  assert.deepEqual(result.presentation.identity, proposed.identity);
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
});

test('committer rejects a source sequence whose accepted event has another turn', () => {
  const sessionId = 'wrong-accepted-turn';
  createSession({ id: sessionId, kind: 'chat' });
  const outcome = acceptedAnswer(sessionId, 'Must not publish.', { turn: 4 });
  const contradictory = {
    ...outcome,
    identity: { ...outcome.identity, turn: 5 },
  } as TurnOutcome;
  assert.throws(() => commitTurnOutcome(contradictory), InvalidTurnOutcomeError);
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0);
});

test('the public writer rejects a typed terminal whose event envelope names another turn', () => {
  const sessionId = 'wrong-turn-winner';
  createSession({ id: sessionId, kind: 'chat' });
  const outcome = acceptedAnswer(sessionId, 'Losing retry.');
  assert.throws(
    () => appendTerminalEventOnce({
      sessionId,
      turn: outcome.identity.turn + 1,
      role: 'system',
      data: completionDataForTurnOutcome({
        ...outcome,
        presentation: { kind: 'answer', text: 'First writer text.' },
      } as TurnOutcome),
    }, outcome.id),
    (error: unknown) => {
      assert.ok(error instanceof AcceptedTaskTerminalPublicationError);
      assert.equal(error.status, 'conflict');
      return true;
    },
  );
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 0);
});

test('physical attempts racing on one accepted source converge on the first terminal', () => {
  const sessionId = 'same-source-fallover';
  createSession({ id: sessionId, kind: 'chat' });
  const winner = acceptedAnswer(sessionId, 'First writer text.', {
    attemptId: 'attempt-original',
    runId: 'run-original',
  });
  appendTerminalEventOnce({
    sessionId,
    turn: winner.identity.turn,
    role: 'system',
    data: completionDataForTurnOutcome(winner),
  }, winner.id);
  const falloverRetry = {
    ...winner,
    identity: {
      sessionId,
      turn: winner.identity.turn,
      sourceUserSeq: winner.identity.sourceUserSeq,
      attemptId: 'attempt-fallover',
      runId: 'run-fallover',
    },
    presentation: { kind: 'answer', text: 'Losing retry.' },
  } as TurnOutcome;

  assert.equal(turnOutcomeId(falloverRetry.identity), winner.id);
  const result = commitTurnOutcome(falloverRetry);
  assert.equal(result.inserted, false);
  assert.equal(result.presentation.text, 'First writer text.');
  assert.equal(listEvents(sessionId, { types: ['conversation_completed'] }).length, 1);
});

test('a blocked terminal persists the host reason and bounded detail instead of the literal "blocked" (say why)', () => {
  const identity = { sessionId: 'say-why-blocked', turn: 1, attemptId: 'attempt-say-why', sourceUserSeq: 1 } as const;
  const text = 'I hit a bounded internal host error. Any completed work and retained results remain preserved, and no uncertain external change is pending.';
  const outcome: TurnOutcome = {
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'blocked',
    resumable: false,
    presentation: { kind: 'blocked', text },
  };
  const detail = 'catalog_entry_or_manifest_missing:candidates=0:proven=none';
  const named = completionDataForTurnOutcome(outcome, {
    metadata: { blockedReason: 'control_no_progress_exhausted', blockedDetail: detail },
  });
  assert.equal(named.blockedReason, 'control_no_progress_exhausted');
  assert.equal(named.blockedDetail, detail);
  assert.equal(named.reply, text, 'machine metadata never rewrites the user-facing text');
  assert.equal(named.reason, 'blocked', 'the legacy classifier is unchanged');

  const unnamed = completionDataForTurnOutcome(outcome);
  assert.equal(unnamed.blockedReason, 'blocked', 'callers that carry no reason keep the compatibility default');
  assert.equal('blockedDetail' in unnamed, false);
});

test('an ordinary answer with no refused work and no dispatch still delivers (delivery-truth control)', () => {
  createSession({ id: 'plain-conversational-answer', kind: 'chat' });
  const outcome = acceptedAnswer('plain-conversational-answer', 'Here is what I know from our earlier conversation.');
  const committed = commitTurnOutcome(outcome);
  assert.equal(committed.presentation.status, 'done');
  assert.equal(committed.event.data.delivered, true);
  assert.equal('verificationMissing' in committed.event.data, false);
});


for (const livePolicy of ['on', 'off']) {
  test(`unreadable captured policy publishes review unavailable without relabelling or holding successful work when live review is ${livePolicy}`, () => {
    const prior = process.env.CLEMMY_COMPLETION_REVIEW;
    process.env.CLEMMY_COMPLETION_REVIEW = livePolicy;
    try {
      const sessionId = `unreadable-policy-${livePolicy}`;
      createSession({ id: sessionId, kind: 'chat' });
      const outcome = acceptedAnswer(sessionId, 'Here is the requested answer.');
      appendEvent({ sessionId, turn: 0, role: 'system', type: 'completion_policy_captured', data: {
        version: 2, sourceUserSeq: outcome.identity.sourceUserSeq, enabled: 'damaged',
      } });
      // A retained fail-open verdict makes the old live-policy fallback hold
      // this turn when today's setting is ON. Policy unreadability alone must
      // never substitute today's policy or create a repeat-execution obligation.
      appendEvent({ sessionId, turn: 0, role: 'system', type: 'goal_alignment_judged', data: {
        lane: 'host_v1', kind: 'completion', sourceUserSeq: outcome.identity.sourceUserSeq,
        fulfills: true, failedOpen: true, reason: 'Earlier review unavailable.',
        objectiveDigest: createHash('sha256').update('Accepted request.').digest('hex'),
        replyDigest: createHash('sha256').update(outcome.presentation.text).digest('hex'),
      } });
      const committed = commitTurnOutcome(outcome);
      assert.equal(committed.presentation.status, 'done');
      assert.equal(committed.presentation.text, outcome.presentation.text);
      assert.equal(committed.event.data.delivered, true);
      const verdict = committed.event.data.completionVerdictRef as Record<string, unknown>;
      assert.equal(verdict.policyEvidence, 'unreadable');
      assert.equal(verdict.verified, false);
      assert.equal(verdict.disposition, 'enabled_unavailable');
    } finally {
      if (prior === undefined) delete process.env.CLEMMY_COMPLETION_REVIEW;
      else process.env.CLEMMY_COMPLETION_REVIEW = prior;
    }
  });
}


for (const [label, reason, expected] of [
  ['quota', 'The selected reviewer is rate-limited; no review was completed.', /reviewer is rate-limited/],
  ['retained-timeout', 'judge timed out — accepting completion', /judge timed out; no review was completed/],
] as const) {
test(`publication keeps the ${label} reason and never calls a missing review an acceptance`, () => {
  const sessionId = `${label}-unreviewed-publication`;
  createSession({ id: sessionId, kind: 'chat' });
  const outcome = acceptedAnswer(sessionId, 'Here is the requested answer.');
  appendEvent({ sessionId, turn: 0, role: 'system', type: 'completion_policy_captured', data: {
    version: 1, sourceUserSeq: outcome.identity.sourceUserSeq, enabled: true,
  } });
  appendEvent({ sessionId, turn: 0, role: 'system', type: 'goal_alignment_judged', data: {
    lane: 'host_v1', kind: 'completion', sourceUserSeq: outcome.identity.sourceUserSeq,
    fulfills: true, failedOpen: true,
    reason,
    objectiveDigest: createHash('sha256').update('Accepted request.').digest('hex'),
    replyDigest: createHash('sha256').update(outcome.presentation.text).digest('hex'),
  } });
  const committed = commitTurnOutcome(outcome);
  // OWNER DECISION 2026-09-09, landed with its pins 2026-09-10: a reviewer that
  // COULD NOT FIRE — rate-limited, timed out, or not signed in — follows the
  // brain, so finished work publishes rather than being held. Everything this
  // test actually guards is asserted below and is unchanged: the reason survives
  // verbatim, the text still says the result is unreviewed, it never reads as an
  // acceptance, and the verdict still records verified:false /
  // enabled_unavailable. A review that RAN and did not stand still blocks.
  assert.equal(committed.presentation.status, 'done');
  assert.match(committed.presentation.text, expected);
  assert.match(committed.presentation.text, /remains unreviewed/);
  assert.doesNotMatch(committed.presentation.text, /accepting completion|accepted this result|without actually checking it/);
  const verdict = committed.event.data.completionVerdictRef as Record<string, unknown>;
  assert.equal(verdict.verified, false);
  assert.equal(verdict.disposition, 'enabled_unavailable');
});
}
