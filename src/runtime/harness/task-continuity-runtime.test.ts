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
const { presentationEventFromCompletionData, turnOutcomeId } = await import('./turn-outcome.js');
const { discoveryGovernor } = await import('./discovery-governor.js');
const attemptIdentity = await import('./attempt-identity.js');
const dispatchLedger = await import('./dispatch-ledger.js');
const schemaCache = await import('../../tools/composio-schema-cache.js');
const capabilityCandidates = await import('../read-path/capability-candidates.js');
const { recordAcceptedSourceGraph } = await import('./record-accepted-source-graph.js');
const turnControl = await import('./turn-control.js');
const sourceAdmission = await import('./source-strategy-admission.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
  if (PRIOR_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PRIOR_HOME;
});

function accepted(
  sessionId: string,
  text: string,
  kind: 'chat' | 'execution' = 'chat',
  data: Record<string, unknown> = {},
) {
  if (!eventlog.getSession(sessionId)) eventlog.createSession({ id: sessionId, kind });
  const attempt = eventlog.beginRunAttempt(sessionId);
  return eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text, ...data },
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
    assert.deepEqual(packet.packet.pause.options, [], 'hidden awaiting options are not durable answer authority');
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

test('an internal awaiting question that differs from the delivered terminal cannot mint lineage', () => {
  const sessionId = 'continuity-visible-question-mismatch';
  const source = accepted(sessionId, 'Send the private summary.');
  eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      sourceUserSeq: source.seq,
      purpose: 'clarification',
      question: 'Should I send Alice the private summary?',
      options: ['Send to Alice', 'Do not send'],
    },
  });
  const delivered = 'Should I send Bob the public summary?';
  const identity = { sessionId, turn: 1, sourceUserSeq: source.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: delivered },
  });
  assert.deepEqual(
    continuity.peekTaskContinuityPacket({ sessionId }),
    { status: 'none' },
    'Yes to visible Q2 must never inherit hidden Q1 recipient/effect authority',
  );
});

test('clarification answer classification is conversational but question-shaped and fail-closed', () => {
  const binary = { kind: 'clarification' as const, question: 'Should I send it?', options: ['Yes', 'No'] };
  assert.deepEqual(runtime.classifyClarificationAnswer('Yes, please.', binary), { disposition: 'affirmed' });
  const meantHost = {
    kind: 'clarification' as const,
    question: 'Nate, did you mean Acme.io (plural)? Example.com is a sale page; Acme.io has the active index.',
    options: [] as string[],
  };
  assert.equal(runtime.classifyClarificationAnswer('Yes', meantHost)?.disposition, 'affirmed');
  assert.equal(runtime.classifyClarificationAnswer('i did yes', meantHost)?.disposition, 'affirmed');
  assert.equal(runtime.classifyClarificationAnswer('yes acme.io', meantHost)?.disposition, 'affirmed');
  assert.equal(
    runtime.classifyClarificationAnswer('find five widgets and put them in a workbook', meantHost),
    null,
    'a new construct is not an answer to the parked host question',
  );
  assert.deepEqual(runtime.classifyClarificationAnswer('No.', binary), {
    disposition: 'declined',
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
  });
  assert.deepEqual(runtime.classifyClarificationAnswer('Leave it alone', conversationalBinary), {
    disposition: 'declined',
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
  assert.equal(runtime.classifyClarificationAnswer('first', choices), null);
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
  }), { disposition: 'declined' });
  assert.deepEqual(runtime.classifyClarificationAnswer('Production', {
    kind: 'clarification',
    question: 'Which environment should I use?',
    options: [],
  }), { disposition: 'provided' });

  const liveConfirmation = {
    kind: 'clarification' as const,
    question: 'Two quick confirmations before I run it: (1) "amplify" = Apify (the Google Maps scraper you\'ve used before) — yes? (2) The address came through as "nathan@scorpion..co"; I\'ll send to your Scorpion mailbox nathan.reynolds@scorpion.co unless you want a different one.',
    options: [] as string[],
  };
  for (const answer of [
    'Yes that’s all correct',
    "Yes that's all correct",
    'yes, correct',
  ]) {
    assert.deepEqual(
      runtime.classifyClarificationAnswer(answer, liveConfirmation),
      { disposition: 'affirmed' },
      `the exact live confirmation variant must close the durable question: ${answer}`,
    );
  }
  for (const [answer, question] of [
    ['Yes', 'Please provide the correct recipient email.'],
    ['Yes', 'Can you provide the correct recipient email?'],
    ['#general', 'Should I delete the old channel?'],
    ['attacker@example.com', 'Should I send the approved report now?'],
    ['Yes', 'Can you give me production tenant name?'],
    ['Yes', 'Can you clarify account scope?'],
  ] as const) {
    assert.equal(
      runtime.classifyClarificationAnswer(answer, {
        kind: 'clarification',
        question,
        options: [],
      }),
      null,
      `an unresolved slot or destructive confirmation cannot consume this literal: ${question} / ${answer}`,
    );
  }
  assert.deepEqual(runtime.classifyClarificationAnswer('owner@example.com', {
    kind: 'clarification',
    question: 'Which recipient email should I use?',
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

test('multiple distinct open clarification questions fail ambiguous instead of selecting the last', () => {
  const sessionId = 'continuity-multiple-open-questions';
  const source = accepted(sessionId, 'Prepare and send the report.');
  eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      sourceUserSeq: source.seq,
      purpose: 'clarification',
      question: 'Which account should I use?',
    },
  });
  commitClarification({
    sessionId,
    sourceSeq: source.seq,
    question: 'Which recipient should receive it?',
    purpose: 'clarification',
  });
  assert.deepEqual(
    continuity.peekTaskContinuityPacket({ sessionId }),
    { status: 'none' },
    'one short answer must not acquire either of two open task slots',
  );
});

test('a public slot answer resumes private task context while hidden option ordinals do not', async () => {
  const sessionId = 'continuity-answer';
  const source = accepted(sessionId, 'List tomorrow’s calendar events.');
  commitClarification({
    sessionId,
    sourceSeq: source.seq,
    question: 'Which connected calendar should I use?',
    options: ['Work calendar', 'Personal calendar'],
    withResolvedCapability: true,
  });
  const answer = accepted(sessionId, 'Use the work calendar.');
  const enriched = await runtime.enrichAcceptedRequestWithTaskContinuity({
    sessionId,
    sourceUserSeq: answer.seq,
    message: 'Use the work calendar.',
  }, answer.seq);
  assert.equal(enriched.message, 'Use the work calendar.');
  assert.equal(enriched.displayMessage, undefined);
  assert.equal(enriched.taskContinuation?.answer, 'Use the work calendar.');
  assert.equal(enriched.taskContinuation?.disposition, 'provided');
  assert.equal(enriched.taskContinuation?.selectedOption, undefined);
  assert.match(enriched.semanticTaskInput ?? '', /List tomorrow’s calendar events/);
  assert.match(enriched.semanticTaskInput ?? '', /Which connected calendar should I use/);
  assert.ok(enriched.turnCandidates?.candidates.some((row) => row.identifier === 'calendar_list_events'));
  assert.equal(discoveryGovernor.getTaskState({ sessionId, sourceUserSeq: answer.seq })?.policy.knownCapability, true);
});

test('an exact material-source answer inherits and re-promotes the durable parent binding', async () => {
  const sessionId = 'continuity-material-source-binding';
  const objective = 'Find five Pismo Beach restaurants and create one new Google Sheet.';
  const question = 'I will use the exact Apify restaurant source and create one new Google Sheet. Use that source?';
  const slug = 'APIFY_PISMO_PRIMARY_GET_ITEMS';
  const fallbackSlug = 'APIFY_PISMO_FALLBACK_GET_ITEMS';
  const initialObservation = Date.now() - 1_000;
  schemaCache.rememberToolSchema(slug, {
    type: 'object',
    properties: { actorId: { type: 'string' } },
    required: ['actorId'],
  }, initialObservation);
  schemaCache.rememberToolSchema(fallbackSlug, {
    type: 'object',
    properties: { actorId: { type: 'string' } },
    required: ['actorId'],
  }, initialObservation);
  const schemaFingerprint = schemaCache.liveComposioSchemaFingerprint(slug);
  const fallbackSchemaFingerprint = schemaCache.liveComposioSchemaFingerprint(fallbackSlug);
  assert.ok(schemaFingerprint);
  assert.ok(fallbackSchemaFingerprint);
  const sourceStrategyBinding = {
    version: 1,
    primary: {
      capabilityId: `capability:composio:${slug}`,
      schemaFingerprint: schemaFingerprint!,
    },
    equivalentFallbacks: [{
      capabilityId: `capability:composio:${fallbackSlug}`,
      schemaFingerprint: fallbackSchemaFingerprint!,
    }],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: 'd'.repeat(64),
    destination: { family: 'workbook', posture: 'create_new' },
    effect: 'external_write',
  } as const;
  const source = accepted(sessionId, objective);
  await recordAcceptedSourceGraph({
    identity: { sessionId, turn: source.turn, sourceUserSeq: source.seq },
    surface: 'direct',
    acceptedText: objective,
  });
  eventlog.appendEvent({
    sessionId,
    turn: 0,
    role: 'system',
    type: 'turn_preflight_decision',
    data: {
      phase: 'align',
      consequential: true,
      objective,
      intentKey: 'material-source-binding',
      reason: 'collect_then_construct',
      confirmationDisposition: 'material_source_strategy',
      sourceStrategyPosture: 'materially_variant',
      sourceStrategyBinding,
      sourceUserSeq: source.seq,
    },
  });
  eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question,
      purpose: 'clarification',
      source: 'preflight_alignment',
      sourceUserSeq: source.seq,
      intentKey: 'material-source-binding',
      confirmationDisposition: 'material_source_strategy',
      sourceStrategyBinding,
    },
  });
  const identity = { sessionId, turn: 1, sourceUserSeq: source.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: question },
  });
  const answerText = 'Use Apify as the restaurant source.';
  const answer = accepted(sessionId, answerText);
  const crowded = Array.from({ length: 12 }, (_, index) => ({
    identifier: `UNRELATED_SOURCE_${index}`,
    kind: 'composio',
    intent: `unrelated source ${index}`,
    klass: 'capability_only',
    via: 'exact' as const,
    score: 1 - index / 100,
  }));
  const enriched = await runtime.enrichAcceptedRequestWithTaskContinuity({
    sessionId,
    sourceUserSeq: answer.seq,
    message: answerText,
    turnCandidates: {
      candidates: crowded,
      requirements: [],
      matches: [],
      pinnedTools: [],
      semanticApplied: false,
    },
  }, answer.seq, {
    typedClassification: { disposition: 'provided' },
  });

  assert.equal(
    JSON.stringify(enriched.turnCandidates?.sourceStrategyBinding),
    JSON.stringify(sourceStrategyBinding),
    'the exact parent awaiting/decision bytes outrank a fresh continuation re-resolve',
  );
  assert.equal(enriched.turnCandidates?.candidates[0]?.identifier, slug,
    'the bound primary survives the continuation top-K as the first executable row');
  assert.equal(enriched.turnCandidates?.candidates[1]?.identifier, fallbackSlug,
    'every bounded fallback survives the continuation top-K beside the primary');
  assert.deepEqual(enriched.turnCandidates?.candidates.slice(0, 2).map((row) => row.requiredFields), [
    ['actorId'],
    ['actorId'],
  ]);
  assert.ok(enriched.turnCandidates?.pinnedTools.includes('composio_execute_tool'));
  const card = capabilityCandidates.renderCapabilityCandidateCard(enriched.turnCandidates);
  assert.match(card, new RegExp(`work_call[\\s\\S]*${slug}`));
  assert.match(card, /Required inner arguments: actorId/);
});

test('exact live primary-only A/Q/B consumes, narrows, approves, and leaves parameterized source I/O blocked', async () => {
  const sessionId = 'continuity-live-primary-only-pismo';
  const objective = 'Find the top 5 restaurants in Pismo Beach by Google review count. Include each restaurant name, review count, and phone number, then create one new Google Sheet containing those 5 rows. Do not email or share it.';
  const question = [
    "I want to pull this from Apify's Google Maps scraper (via the sync dataset-items run) to gather the top 5 Pismo Beach restaurants ranked by review count, pulling name, review count, and phone for each — with the alternate Apify actor-run endpoint as fallback if the primary one doesn't return clean results. Once I have those 5 rows, I'll create one brand-new Google Sheet with them, nothing shared or emailed.",
    'Does that source and approach work for you, or would you rather I pull from a different provider?',
  ].join('\n\n');
  const answerText = 'Yes—use exactly the primary source action you named, with the same parameters. Do not use the fallback.';
  const slug = 'APIFY_PISMO_CONTINUATION_PRIMARY_GET_ITEMS';
  const fallbackSlug = 'APIFY_PISMO_CONTINUATION_FALLBACK_GET_ITEMS';
  const initialObservation = Date.now() - 1_000;
  schemaCache.rememberToolSchema(slug, {
    type: 'object',
    properties: { actorId: { type: 'string' } },
    required: ['actorId'],
  }, initialObservation);
  schemaCache.rememberToolSchema(fallbackSlug, {
    type: 'object',
    properties: { actorId: { type: 'string' } },
    required: ['actorId'],
  }, initialObservation);
  const schemaFingerprint = schemaCache.liveComposioSchemaFingerprint(slug);
  const fallbackSchemaFingerprint = schemaCache.liveComposioSchemaFingerprint(fallbackSlug);
  assert.ok(schemaFingerprint);
  assert.ok(fallbackSchemaFingerprint);
  const sourceStrategyBinding = {
    version: 1,
    primary: {
      capabilityId: `capability:composio:${slug}`,
      accountIdentity: 'account-primary',
      schemaFingerprint: schemaFingerprint!,
    },
    equivalentFallbacks: [{
      capabilityId: `capability:composio:${fallbackSlug}`,
      schemaFingerprint: fallbackSchemaFingerprint!,
    }, {
      capabilityId: `capability:composio:${slug}`,
      accountIdentity: 'account-fallback',
      schemaFingerprint: schemaFingerprint!,
    }],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: 'f'.repeat(64),
    destination: { family: 'workbook', posture: 'create_new' },
    effect: 'external_write',
  } as const;
  const source = accepted(sessionId, objective);
  await recordAcceptedSourceGraph({
    identity: { sessionId, turn: source.turn, sourceUserSeq: source.seq },
    surface: 'direct',
    acceptedText: objective,
  });
  eventlog.appendEvent({
    sessionId,
    turn: 0,
    role: 'system',
    type: 'turn_preflight_decision',
    data: {
      phase: 'align',
      consequential: true,
      objective,
      intentKey: 'live-primary-only-pismo',
      reason: 'collect_then_construct',
      confirmationDisposition: 'material_source_strategy',
      sourceStrategyPosture: 'materially_variant',
      sourceStrategyBinding,
      sourceUserSeq: source.seq,
    },
  });
  eventlog.appendEvent({
    sessionId,
    turn: source.turn,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question,
      purpose: 'clarification',
      source: 'preflight_alignment',
      sourceUserSeq: source.seq,
      intentKey: 'live-primary-only-pismo',
      confirmationDisposition: 'material_source_strategy',
      sourceStrategyBinding,
    },
  });
  const identity = { sessionId, turn: source.turn, sourceUserSeq: source.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: question },
  });
  const parked = continuity.peekTaskContinuityPacket({ sessionId });
  assert.equal(parked.status, 'available');
  if (parked.status === 'available') {
    assert.equal(parked.packet.originatingSourceUserSeq, source.seq);
    assert.equal(parked.packet.pause.question, question.replace(/\s+/g, ' ').trim());
  }
  assert.deepEqual(
    turnControl.sourceStrategyBindingAffirmedByAnswer(answerText, sourceStrategyBinding),
    { ...sourceStrategyBinding, equivalentFallbacks: [] },
  );

  // The exact A/Q binding remains durable audit history, but the fallback's
  // provider contract drifts before B arrives. B revokes it, so only the
  // retained primary may participate in continuation validation/replay.
  schemaCache.rememberToolSchema(fallbackSlug, {
    type: 'object',
    properties: {
      actorId: { type: 'string' },
      locale: { type: 'string' },
    },
    required: ['actorId', 'locale'],
  }, Date.now());
  assert.notEqual(
    schemaCache.liveComposioSchemaFingerprint(fallbackSlug),
    fallbackSchemaFingerprint,
    'the revoked fallback is provably stale before B is consumed',
  );

  const answer = accepted(sessionId, answerText);
  const staleFallbackCandidate = {
    identifier: fallbackSlug,
    kind: 'composio',
    intent: 'stale fallback leaked from the caller surface',
    klass: 'capability_only',
    via: 'exact' as const,
    score: 1,
    effectClass: 'read' as const,
  };
  const sameSlugFallbackCandidate = {
    identifier: slug,
    kind: 'composio',
    accountIdentity: 'account-fallback',
    schemaFingerprint: schemaFingerprint!,
    intent: 'same action slug on the explicitly revoked fallback account',
    klass: 'capability_only',
    via: 'exact' as const,
    score: 1,
    effectClass: 'read' as const,
  };
  const continuationRequest = {
    sessionId,
    sourceUserSeq: answer.seq,
    message: answerText,
    turnCandidates: {
      candidates: [staleFallbackCandidate, sameSlugFallbackCandidate],
      requirements: [{
        roleKey: 'clause-0:read',
        clauseIndex: 0,
        text: 'collect the restaurant source set',
        effect: 'read' as const,
        resolved: true,
        resolvedCapabilities: [staleFallbackCandidate],
      }],
      matches: [],
      pinnedTools: ['composio_execute_tool'],
      semanticApplied: false,
      sourceStrategyBinding,
    },
  };
  const enriched = await runtime.enrichAcceptedRequestWithTaskContinuity(
    continuationRequest,
    answer.seq,
  );

  assert.equal(enriched.taskContinuation?.disposition, 'affirmed');
  assert.equal(enriched.taskContinuation?.parentSourceUserSeq, source.seq);
  assert.equal(enriched.taskContinuation?.question, question.replace(/\s+/g, ' ').trim());
  assert.equal(enriched.taskContinuation?.answer, answerText);
  const narrowedBinding = enriched.turnCandidates?.sourceStrategyBinding;
  assert.equal(narrowedBinding?.primary.capabilityId, `capability:composio:${slug}`);
  assert.deepEqual(narrowedBinding?.equivalentFallbacks, [], 'B explicitly revoked the fallback');
  assert.equal(
    enriched.turnCandidates?.candidates.some((candidate) => candidate.identifier === fallbackSlug),
    false,
    'the revoked fallback is absent from the merged executable candidate surface',
  );
  assert.equal(
    enriched.turnCandidates?.candidates.some((candidate) =>
      candidate.identifier === slug && candidate.accountIdentity === 'account-fallback'),
    false,
    'a same-slug fallback on a different account is pruned by full source identity',
  );
  assert.equal(
    enriched.turnCandidates?.candidates.some((candidate) =>
      candidate.identifier === slug && candidate.accountIdentity === 'account-primary'),
    true,
    'the retained same-slug primary account remains model-visible',
  );
  const narrowedCard = capabilityCandidates.renderCapabilityCandidateCard(enriched.turnCandidates);
  assert.doesNotMatch(narrowedCard, new RegExp(fallbackSlug));
  assert.doesNotMatch(narrowedCard, /account-fallback/);
  assert.match(narrowedCard, new RegExp(slug));
  assert.equal(enriched.turnCandidates?.requirements[0]?.resolved, true,
    'revoking a fallback does not reopen broad source discovery');
  assert.deepEqual(enriched.turnCandidates?.requirements[0]?.resolvedCapabilities, []);
  const consumed = continuity.readConsumedTaskContinuityPacket({
    sessionId,
    consumingSourceUserSeq: answer.seq,
  });
  assert.equal(consumed.status, 'consumed', 'the exact durable packet must not be dismissed as topic_changed');
  const replayed = await runtime.enrichAcceptedRequestWithTaskContinuity(
    continuationRequest,
    answer.seq,
  );
  assert.deepEqual(replayed.turnCandidates?.sourceStrategyBinding?.equivalentFallbacks, []);
  assert.equal(
    replayed.turnCandidates?.candidates.some((candidate) => candidate.identifier === fallbackSlug),
    false,
    'consumed-packet replay also validates and presents only the narrowed primary',
  );

  const childGraphEvent = await recordAcceptedSourceGraph({
    identity: { sessionId, turn: answer.turn, sourceUserSeq: answer.seq },
    surface: 'direct',
    acceptedText: answerText,
    verifiedTaskContinuation: enriched.taskContinuation,
  });
  assert.ok(childGraphEvent);
  assert.equal(childGraphEvent?.data.effectCeiling, 'external_write');
  const childGraph = childGraphEvent?.data.graph as {
    classification?: { externalEffectRequested?: boolean };
  } | undefined;
  assert.equal(childGraph?.classification?.externalEffectRequested, true,
    'B inherits A\'s external-write goal semantics through verified lineage');
  const lineage = childGraphEvent?.data.taskContinuationLineage as Record<string, unknown> | undefined;
  assert.ok(lineage);
  assert.equal(lineage?.parentSourceUserSeq, source.seq);
  assert.equal(lineage?.consumingSourceUserSeq, answer.seq);
  assert.equal(lineage?.disposition, 'affirmed');
  const decision = turnControl.classifyTurnPreflight({
    message: answerText,
    sessionId,
    sessionKind: 'chat',
    sourceUserSeq: answer.seq,
    sourceStrategyBinding: narrowedBinding,
  });
  assert.equal(decision.reason, 'continuation_approved');
  assert.equal(decision.consequential, true);
  assert.equal(decision.sourceStrategyPosture, 'confirmed_exact');
  assert.deepEqual(decision.sourceStrategyBinding?.primary, sourceStrategyBinding.primary,
    'primary account/schema/capability bytes remain unchanged');
  assert.deepEqual(decision.sourceStrategyBinding?.equivalentFallbacks, []);

  const admission = sourceAdmission.evaluateSourceStrategyPhysicalAdmission({
    requirementEffect: 'read',
    requirementRole: 'collection',
    decision,
    capability: {
      capabilityId: `capability:composio:${slug}`,
      accountIdentity: 'account-primary',
      schemaFingerprint: schemaFingerprint!,
    },
    args: { actorId: 'compass/google-maps-extractor' },
    requireDurableDecision: true,
  });
  assert.equal(admission.status, 'refused');
  if (admission.status === 'refused') {
    assert.equal(admission.kind, 'source_strategy_authority_invalid');
    assert.match(admission.message, /does not carry current call-bound authority/i);
  }

  turnControl.recordTurnPreflightDecision(sessionId, decision, answer.seq);
  let providerCallbacks = 0;
  let refusal: Error | null = null;
  try {
    await sourceAdmission.withSourceStrategyRequirement(
      { role: 'collection', effect: 'read' },
      () => attemptIdentity.withPhysicalDispatch({
        sessionId,
        sourceUserSeq: answer.seq,
        turn: answer.turn,
        tool: slug,
        args: { actorId: 'compass/google-maps-extractor' },
        sourceCapability: {
          capabilityId: `capability:composio:${slug}`,
          accountIdentity: 'account-primary',
          schemaFingerprint: schemaFingerprint!,
        },
      }, async () => {
        providerCallbacks += 1;
        return 'must not cross';
      }),
    );
  } catch (error) {
    refusal = error instanceof Error ? error : new Error(String(error));
  }
  assert.ok(refusal instanceof attemptIdentity.SourceStrategyPhysicalDispatchError);
  assert.match(refusal?.message ?? '', /no attested argument template/i);
  assert.equal(providerCallbacks, 0, 'callback0: provider carrier never ran');
  assert.deepEqual(
    dispatchLedger.physicalCrossingsFor(sessionId, answer.seq),
    [],
    'p0: no physical provider row exists',
  );
  const toolHistory = eventlog.listEvents(sessionId, { types: ['tool_called', 'tool_returned'] })
    .filter((event) => event.data.sourceUserSeq === answer.seq);
  assert.deepEqual(toolHistory, [], 'h0: no provider tool-history event exists');

  const blocked = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId({ sessionId, turn: answer.turn, sourceUserSeq: answer.seq }),
    identity: { sessionId, turn: answer.turn, sourceUserSeq: answer.seq },
    status: 'blocked',
    resumable: true,
    presentation: {
      kind: 'blocked',
      text: `No provider call was started. ${refusal?.message ?? 'The source authority was invalid.'}`,
    },
  });
  assert.ok(blocked, 'the pre-provider refusal publishes one blocked terminal');
  const blockedPresentations = eventlog.listEvents(sessionId, { types: ['conversation_completed'] })
    .map((event) => presentationEventFromCompletionData(event.data))
    .filter((presentation) => presentation.identity.sourceUserSeq === answer.seq);
  assert.equal(blockedPresentations.length, 1, 'the refused B has exactly one terminal');
  const [blockedPresentation] = blockedPresentations;
  assert.equal(blockedPresentation?.status, 'blocked');
  assert.equal(blockedPresentation?.kind, 'blocked');
  assert.match(blockedPresentation?.text ?? '', /no provider call was started/i);

  schemaCache._clearToolSchemaCacheForTest();
  const coldReplay = await runtime.enrichAcceptedRequestWithTaskContinuity(
    continuationRequest,
    answer.seq,
  );
  assert.deepEqual(coldReplay.turnCandidates?.sourceStrategyBinding?.equivalentFallbacks, [],
    'a process-cold replay keeps the selected primary; missing cache state is not schema drift');
  assert.equal(
    coldReplay.turnCandidates?.candidates.some((candidate) =>
      candidate.identifier === fallbackSlug || candidate.accountIdentity === 'account-fallback'),
    false,
  );

  schemaCache.rememberToolSchema(slug, {
    type: 'object',
    properties: {
      actorId: { type: 'string' },
      countryCode: { type: 'string' },
    },
    required: ['actorId', 'countryCode'],
  }, Date.now());
  const retainedPrimaryDrift = await runtime.enrichAcceptedRequestWithTaskContinuity(
    continuationRequest,
    answer.seq,
  );
  assert.equal(retainedPrimaryDrift.turnCandidates?.sourceStrategyBinding, undefined,
    'a stale retained primary has no executable source binding');
  assert.equal(
    retainedPrimaryDrift.turnCandidates?.candidates.some((candidate) =>
      candidate.identifier === fallbackSlug || candidate.accountIdentity === 'account-fallback'),
    false,
    'structural primary-only selection still prunes every revoked fallback when live primary validation fails',
  );
});

test('a materially different source answer cannot inherit the pending binding', async () => {
  const sessionId = 'continuity-material-source-substitution';
  const objective = 'Find the top 5 Pismo Beach restaurants by Google review count and create one new Google Sheet.';
  const question = 'I will use the exact Apify restaurant source and create one new Google Sheet. Use that source?';
  const slug = 'APIFY_ACT_RUN_SYNC_GET_DATASET_ITEMS_GET';
  schemaCache.rememberToolSchema(slug, {
    type: 'object',
    properties: { actorId: { type: 'string' } },
    required: ['actorId'],
  }, Date.now());
  const schemaFingerprint = schemaCache.liveComposioSchemaFingerprint(slug);
  assert.ok(schemaFingerprint);
  const sourceStrategyBinding = {
    version: 1,
    primary: {
      capabilityId: `capability:composio:${slug}`,
      schemaFingerprint: schemaFingerprint!,
    },
    equivalentFallbacks: [],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: 'e'.repeat(64),
    destination: { family: 'workbook', posture: 'create_new' },
    effect: 'external_write',
  } as const;
  const source = accepted(sessionId, objective);
  await recordAcceptedSourceGraph({
    identity: { sessionId, turn: source.turn, sourceUserSeq: source.seq },
    surface: 'direct',
    acceptedText: objective,
  });
  eventlog.appendEvent({
    sessionId,
    turn: 0,
    role: 'system',
    type: 'turn_preflight_decision',
    data: {
      phase: 'align',
      consequential: true,
      objective,
      intentKey: 'material-source-substitution',
      reason: 'collect_then_construct',
      confirmationDisposition: 'material_source_strategy',
      sourceStrategyPosture: 'materially_variant',
      sourceStrategyBinding,
      sourceUserSeq: source.seq,
    },
  });
  eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      question,
      purpose: 'clarification',
      source: 'preflight_alignment',
      sourceUserSeq: source.seq,
      intentKey: 'material-source-substitution',
      confirmationDisposition: 'material_source_strategy',
      sourceStrategyBinding,
    },
  });
  const identity = { sessionId, turn: 1, sourceUserSeq: source.seq };
  commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(identity),
    identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: question },
  });
  const answerText = 'Do not use Apify as the source; use DataForSEO instead.';
  const answer = accepted(sessionId, answerText);
  const enriched = await runtime.enrichAcceptedRequestWithTaskContinuity({
    sessionId,
    sourceUserSeq: answer.seq,
    message: answerText,
    turnCandidates: {
      candidates: [], requirements: [], matches: [], pinnedTools: [], semanticApplied: false,
      sourceStrategyBinding,
    },
  }, answer.seq, {
    typedClassification: { disposition: 'provided' },
  });

  assert.ok(enriched.taskContinuation, 'the conversational A/Q/B capsule remains available');
  assert.equal(enriched.turnCandidates?.sourceStrategyBinding, undefined,
    'an alternate named source cannot inherit or retain A’s exact Apify binding');
  await recordAcceptedSourceGraph({
    identity: { sessionId, turn: answer.turn, sourceUserSeq: answer.seq },
    surface: 'direct',
    acceptedText: answerText,
    verifiedTaskContinuation: enriched.taskContinuation,
  });
  const graphFacts = turnControl.compiledGraphPreflightFacts(sessionId, answer.seq);
  assert.equal(graphFacts?.construct, 'collect_then_construct', JSON.stringify(graphFacts));
  const decision = turnControl.classifyTurnPreflight({
    message: answerText,
    sessionId,
    sessionKind: 'chat',
    sourceUserSeq: answer.seq,
  });
  assert.equal(decision.phase, 'align');
  assert.equal(decision.reason, 'collect_then_construct');
  assert.notEqual(decision.reason, 'continuation_approved');
  assert.equal(decision.sourceStrategyPosture, 'materially_variant');
  assert.equal(decision.sourceStrategyBinding, undefined);
  const admission = sourceAdmission.evaluateSourceStrategyPhysicalAdmission({
    requirementEffect: 'read',
    requirementRole: 'collection',
    decision,
    requireDurableDecision: true,
    capability: { capabilityId: 'capability:composio:DATAFORSEO_MAPS_SEARCH' },
  });
  assert.equal(admission.status, 'refused', 'the alternate provider has zero physical dispatch authority');
});

test('an ordinal matching only hidden awaiting options cannot consume the parent action', async () => {
  const sessionId = 'continuity-hidden-option-ordinal';
  const source = accepted(sessionId, 'Deploy the release.');
  commitClarification({
    sessionId,
    sourceSeq: source.seq,
    question: 'Which environment should I use?',
    options: ['Staging', 'Production'],
  });
  const answer = accepted(sessionId, 'second');
  const enriched = await runtime.enrichAcceptedRequestWithTaskContinuity({
    sessionId,
    sourceUserSeq: answer.seq,
    message: 'second',
  }, answer.seq);
  assert.equal(enriched.taskContinuation, undefined);
  assert.equal(enriched.semanticTaskInput, undefined);
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

test('send-consent controls cannot also consume a generic clarification packet', async () => {
  const sessionId = 'continuity-consent-isolation';
  const channelData = {
    source: 'channel:discord',
    userId: 'discord-user-1',
    conversationKey: 'discord:shared-channel-1',
  };
  const source = accepted(sessionId, 'Prepare the client email.', 'chat', channelData);
  commitClarification({
    sessionId,
    sourceSeq: source.seq,
    question: 'Should I include the private appendix?',
    purpose: 'clarification',
  });
  const answerText = 'Yes';
  const answer = accepted(sessionId, answerText, 'chat', {
    source: 'channel_send_consent',
    userId: 'discord-user-1',
    conversationKey: 'discord:shared-channel-1',
    approvalId: 'send-consent-1',
    decision: 'approve',
  });
  const enriched = await runtime.enrichAcceptedRequestWithTaskContinuity({
    sessionId,
    sourceUserSeq: answer.seq,
    message: answerText,
  }, answer.seq);
  assert.equal(enriched.taskContinuation, undefined);
  assert.equal(
    continuity.peekTaskContinuityPacket({ sessionId }).status,
    'available',
    'approval-specific routing leaves the generic clarification edge untouched',
  );
});

test('the exact live A/Q/B confirmation closes one question and rehydrates its lineage across restart', async () => {
  const sessionId = 'continuity-live-compound-confirmation';
  const parent = 'Pull the top five restaurants in Ventura, California using amplify put them in a new Google sheet with their name rating address and the most recent review if possible and then go ahead and email me a link nathan@scorpion..co';
  const question = 'Two quick confirmations before I run it: (1) "amplify" = Apify (the Google Maps scraper you\'ve used before) — yes? (2) The address came through as "nathan@scorpion..co"; I\'ll send to your Scorpion mailbox nathan.reynolds@scorpion.co unless you want a different one.';
  const source = accepted(sessionId, parent);
  commitClarification({
    sessionId,
    sourceSeq: source.seq,
    question,
    purpose: 'clarification',
  });
  const answerText = 'Yes that’s all correct';
  const answer = accepted(sessionId, answerText);
  const request = { sessionId, sourceUserSeq: answer.seq, message: answerText };
  const enriched = await runtime.enrichAcceptedRequestWithTaskContinuity(request, answer.seq);

  assert.equal(enriched.taskContinuation?.parentSourceUserSeq, source.seq);
  assert.equal(enriched.taskContinuation?.consumingSourceUserSeq, answer.seq);
  assert.equal(enriched.taskContinuation?.disposition, 'affirmed');
  assert.equal(enriched.taskContinuation?.parentInput, parent);
  assert.equal(enriched.taskContinuation?.question, question);
  assert.match(enriched.semanticTaskInput ?? '', /Apify/);
  assert.match(enriched.semanticTaskInput ?? '', /nathan\.reynolds@scorpion\.co/);
  assert.deepEqual(continuity.peekTaskContinuityPacket({ sessionId }), { status: 'none' });

  eventlog.closeEventLog();
  const replay = await runtime.enrichAcceptedRequestWithTaskContinuity(request, answer.seq);
  assert.equal(replay.taskContinuation?.packetId, enriched.taskContinuation?.packetId);
  assert.equal(replay.taskContinuation?.parentSourceUserSeq, source.seq);
  assert.equal(replay.semanticTaskInput, enriched.semanticTaskInput);
  assert.deepEqual(
    runtime.verifyDurableClarificationContext({
      sessionId,
      sourceUserSeq: answer.seq,
      answer: answerText,
      context: replay.taskContinuation!,
    })?.packetId,
    enriched.taskContinuation?.packetId,
  );
});

test('an oversized accepted parent fails closed without truncating or consuming its authority', async () => {
  const sessionId = 'continuity-parent-explicit-bound';
  const parent = `Prepare the report. ${'context '.repeat(8_200)} Send the private report externally.`;
  assert.ok(parent.length > runtime.MAX_CLARIFICATION_PARENT_CHARS);
  assert.equal(runtime.canonicalClarificationTaskInput({
    parentInput: parent,
    question: 'Should I send it?',
    answer: 'Yes',
  }), null);
  const source = accepted(sessionId, parent);
  commitClarification({
    sessionId,
    sourceSeq: source.seq,
    question: 'Should I send it?',
    purpose: 'clarification',
  });
  const answer = accepted(sessionId, 'Yes');
  const enriched = await runtime.enrichAcceptedRequestWithTaskContinuity({
    sessionId,
    sourceUserSeq: answer.seq,
    message: 'Yes',
  }, answer.seq);
  assert.equal(enriched.taskContinuation, undefined);
  assert.equal(enriched.semanticTaskInput, undefined);
  assert.equal(
    continuity.peekTaskContinuityPacket({ sessionId }).status,
    'available',
    'oversized A is quarantined for a fresh ask instead of projected into B',
  );
});

test('the exact consumer rehydrates after daemon reopen, but a later source cannot', async () => {
  const sessionId = 'continuity-restart';
  const source = accepted(sessionId, 'List tomorrow’s calendar events.');
  commitClarification({ sessionId, sourceSeq: source.seq, options: ['Work', 'Personal'] });
  const answer = accepted(sessionId, 'Use the work calendar.');
  const request = { sessionId, sourceUserSeq: answer.seq, message: 'Use the work calendar.' };
  const first = await runtime.enrichAcceptedRequestWithTaskContinuity(request, answer.seq);
  assert.equal(first.taskContinuation?.parentSourceUserSeq, source.seq);

  eventlog.closeEventLog();
  const replay = await runtime.enrichAcceptedRequestWithTaskContinuity(request, answer.seq);
  assert.equal(replay.taskContinuation?.packetId, first.taskContinuation?.packetId);
  assert.equal(replay.message, 'Use the work calendar.');

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
