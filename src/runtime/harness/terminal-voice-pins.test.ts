/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/terminal-voice-pins.test.ts
 *
 * Clem's reply is Clem's words. A review outcome, what a stopped turn kept and
 * an app status travel as terminal data for the clients' chrome; the committed
 * public text is never extended or replaced by a host-written sentence for
 * these causes. Regression note: review notes, retained-work sentences, the
 * format hold and the Stop/quota lines were all written in Clem's voice.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-terminal-voice-pins-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-terminal-voice-pins\n', 'utf8');

const eventlog = await import('./eventlog.js');
const { appendEvent, createSession, listEvents, closeEventLog, openEventLog } = eventlog;
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { presentationEventForOutcome, turnOutcomeId } = await import('./turn-outcome.js');
const {
  projectHarnessEventForPublic,
  publicCompletionText,
  publicPresentationText,
} = await import('./public-presentation.js');
const { HOST_TOOL_UNCERTAIN_BLOCKED_TEXT, captureEffectiveCompletionPolicyOnce } = await import('./host-turn-runner.js');
const { WHOLE_JSON_OBJECT_FORMAT_FINDING } = await import('./response-format-repair.js');
const { OWNER_STOP_RESULTS_KEPT_TERMINAL_TEXT, OWNER_STOP_TERMINAL_TEXT } = await import('./terminal-notice.js');
const presentationModule = await import('./public-presentation.js');
const { reconstructHarnessTranscript } = await import('./transcript.js');
const { pullRecentTurnsForSession } = await import('./session-transcript.js');
const loop = await import('./loop.js');
type TurnOutcome = import('./turn-outcome.js').TurnOutcome;
type EventRow = import('./eventlog.js').EventRow;

test.after(() => {
  closeEventLog();
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

const BANNED = [
  'Verification note:',
  'for when we continue',
  'No changes to another app',
  'My answer is saved, but',
  'latest Codex usage check',
  'Stopped — this turn was cancelled',
  'Stopped as requested',
] as const;

/** Every committed public text these pins produce, for the sweep below. */
const committedPublicTexts: Array<{ cause: string; text: string }> = [];

function record(cause: string, event: EventRow): Record<string, unknown> {
  const projected = projectHarnessEventForPublic(event);
  assert.ok(projected, `${cause}: the terminal projects`);
  const data = projected.data as Record<string, unknown>;
  for (const text of [
    String(data.reply ?? ''),
    String((data.presentation as { text?: string } | undefined)?.text ?? ''),
    publicCompletionText(event.data, ''),
  ]) committedPublicTexts.push({ cause, text });
  return data;
}

const OBJECTIVE = 'Accepted request.';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function acceptedAnswer(sessionId: string, text: string): TurnOutcome {
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: OBJECTIVE } });
  const identity = { sessionId, turn: source.turn, sourceUserSeq: source.seq };
  return { version: 2, id: turnOutcomeId(identity), identity, status: 'done', resumable: false,
    presentation: { kind: 'answer', text } };
}

function verdict(outcome: TurnOutcome, data: Record<string, unknown>): void {
  captureEffectiveCompletionPolicyOnce({ ...outcome.identity, enabled: true });
  appendEvent({ sessionId: outcome.identity.sessionId, turn: 0, role: 'system', type: 'goal_alignment_judged', data: {
    lane: 'host_v1', kind: 'completion', sourceUserSeq: outcome.identity.sourceUserSeq,
    objectiveDigest: sha(OBJECTIVE), replyDigest: sha(outcome.presentation.text), ...data,
  } });
}

const REVIEW_CAUSES: ReadonlyArray<{
  cause: string;
  verdict: (outcome: TurnOutcome) => Record<string, unknown>;
  review: 'checked' | 'unchecked' | 'rejected' | 'needs_recheck';
  status: 'done' | 'blocked';
  note?: string;
  notice?: string;
  /** The verdict was recorded against different reply bytes. */
  otherReply?: true;
}> = [
  { cause: 'reviewed', verdict: () => ({ fulfills: true, settledEvidenceAvailable: true }), review: 'checked', status: 'done' },
  { cause: 'unavailable', verdict: () => ({ fulfills: true, failedOpen: true, reviewFailure: 'unavailable',
    reason: 'The fixture reviewer route was unavailable.' }), review: 'unchecked', status: 'done' },
  { cause: 'timeout', verdict: () => ({ fulfills: true, failedOpen: true, reviewFailure: 'timeout',
    reason: 'The completion reviewer timed out; no review was completed.' }), review: 'unchecked', status: 'done' },
  { cause: 'answered_unqualified', verdict: () => ({ fulfills: false, failedOpen: true, reviewFailure: 'invalid',
    reviewDisposition: 'answered_unqualified', reason: 'The required same-output assessment was missing.' }),
  review: 'unchecked', status: 'blocked' },
  { cause: 'negative', verdict: () => ({ fulfills: false, reason: 'The count in the reply does not match the read.' }),
    review: 'rejected', status: 'blocked', note: 'The count in the reply does not match the read.' },
  { cause: 'format_only', verdict: () => ({ fulfills: false, repairScope: 'reply_format',
    responseFormatContract: { kind: 'whole_json_object', candidateValid: false },
    reason: `The reply covers the request.\n${WHOLE_JSON_OBJECT_FORMAT_FINDING}` }),
  review: 'rejected', status: 'blocked', notice: 'response_format_unmet' },
  { cause: 'format_and_semantic', verdict: () => ({ fulfills: false,
    responseFormatContract: { kind: 'whole_json_object', candidateValid: false },
    reason: `The total omits one office.\n${WHOLE_JSON_OBJECT_FORMAT_FINDING}` }),
  review: 'rejected', status: 'blocked', note: 'The total omits one office.', notice: 'response_format_unmet' },
  // A finished answer never carries a notice: clients draw a notice terminal
  // in place of the bubble, so a notice here would hide Clem's answer.
  { cause: 'format_miss_review_unreachable', verdict: () => ({ fulfills: true, failedOpen: true, reviewFailure: 'unavailable',
    responseFormatContract: { kind: 'whole_json_object', candidateValid: false },
    reason: 'The fixture reviewer route was unavailable.' }), review: 'unchecked', status: 'done' },
  // A negative verdict about other reply bytes is not a finding about these.
  { cause: 'negative_other_reply', verdict: () => ({ fulfills: false, replyDigest: sha('An earlier draft of the answer.'),
    reason: 'The earlier draft claims all offices grew.' }), review: 'unchecked', status: 'blocked', otherReply: true },
  { cause: 'format_other_reply', verdict: () => ({ fulfills: false, replyDigest: sha('An earlier draft of the answer.'),
    responseFormatContract: { kind: 'whole_json_object', candidateValid: false },
    reason: `The earlier draft omits one office.\n${WHOLE_JSON_OBJECT_FORMAT_FINDING}` }),
  review: 'unchecked', status: 'blocked', otherReply: true },
  { cause: 'objective_mismatch', verdict: () => ({ fulfills: true, objectiveDigest: sha('A different request.') }),
    review: 'unchecked', status: 'blocked' },
  { cause: 'reply_mismatch', verdict: () => ({ fulfills: true, replyDigest: sha('A different reply.') }),
    review: 'unchecked', status: 'blocked', otherReply: true },
  { cause: 'evidence_unreadable', verdict: () => ({ fulfills: true, settledEvidenceAvailable: false }),
    review: 'unchecked', status: 'blocked' },
  { cause: 'host_evidence_hold', verdict: () => ({ fulfills: true, inheritedReadReviewRequired: true }),
    review: 'needs_recheck', status: 'blocked' },
];

for (const entry of REVIEW_CAUSES) {
  test(`review cause ${entry.cause}: committed public text is byte-equal to Clem's text and the terminal carries review ${entry.review}`, () => {
    const authored = `Fixture answer for ${entry.cause}: alpha, beta, gamma.`;
    const outcome = acceptedAnswer(`voice-review-${entry.cause}`, authored);
    verdict(outcome, entry.verdict(outcome));
    const committed = commitTurnOutcome(outcome);
    assert.equal(committed.presentation.text, authored, 'the durable presentation is the authored text');
    assert.equal(committed.presentation.status, entry.status);
    assert.equal(committed.event.data.review, entry.review);
    assert.equal(committed.event.data.reviewNote, entry.note);
    const data = record(`review:${entry.cause}`, committed.event);
    assert.equal((data.presentation as { text: string }).text, authored, 'SSE shows Clem\'s words alone');
    assert.equal(data.reply, authored);
    assert.equal(data.review, entry.review);
    assert.equal(data.reviewNote, entry.note);
    assert.deepEqual(data.notice, entry.notice ? { code: entry.notice } : undefined);
    assert.doesNotMatch(JSON.stringify(data), /owner required one whole-output JSON object/,
      'the host format finding is model-facing and never quoted');
    const ref = committed.event.data.completionVerdictRef as Record<string, unknown>;
    assert.equal(ref.deliveredTextIsJudgedText, entry.otherReply !== true,
      'judged-text equality is the real byte comparison of the published text');
    if (entry.otherReply) assert.doesNotMatch(JSON.stringify(data), /earlier draft/i,
      'a finding about other reply bytes is never quoted beside these');
  });
}

test('a terminal carrying the retained header projects to exactly its head on every transport while the durable row keeps the rh_ handles', () => {
  const sessionId = 'voice-retained-transports';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop' });
  const source = appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Read the named fixtures.' } });
  const identity = { sessionId, turn: source.turn, sourceUserSeq: source.seq };
  const head = OWNER_STOP_TERMINAL_TEXT;
  const durable = `${head}\n\nRetained work (durable checkpoint):\n`
    + '- Source/tool fixture_read: completed result retained as rh_voice_pin_one.\n'
    + '- 2 additional retained results.\n'
    + 'External write state (fixture_write): refused by the app in its reply. Nothing reruns on its own; a changed attempt goes to the owner first.';
  const outcome: TurnOutcome = { version: 2, id: turnOutcomeId(identity), identity, status: 'cancelled', resumable: false,
    presentation: { kind: 'stopped', text: durable } };
  const presentation = presentationEventForOutcome(outcome);
  const event = appendEvent({ sessionId, turn: source.turn, role: 'system', type: 'conversation_completed', data: {
    terminalKey: outcome.id, sourceUserSeq: source.seq, reply: durable, presentation, hostNotice: { code: 'stopped' },
    turnOutcome: { version: 2, id: outcome.id, status: 'cancelled', resumable: false },
  } });
  // SSE / event replay.
  const data = record('retained:sse', event);
  assert.equal((data.presentation as { text: string }).text, head);
  assert.equal(data.reply, head);
  assert.deepEqual(data.retained, { results: 3, outsideChange: 'refused' });
  assert.deepEqual(data.notice, { code: 'stopped' });
  // Bridge replies, console and mobile terminal routes read these two.
  assert.equal(publicPresentationText(presentation), head);
  assert.equal(publicCompletionText(event.data), head);
  // Transcript reopen and the model-history transcript.
  const reopened = reconstructHarnessTranscript(sessionId).filter(turn => turn.role === 'assistant');
  assert.deepEqual(reopened.map(turn => turn.text), [head]);
  // A reopened reply carries the same typed facts as live delivery, so the
  // desktop draws its pill and status line instead of a plain bubble.
  const reopenedTerminal = reopened[0]!.terminal as Record<string, unknown>;
  assert.deepEqual(reopenedTerminal.presentation, { status: 'cancelled', kind: 'stopped' });
  assert.deepEqual(reopenedTerminal.notice, { code: 'stopped' });
  assert.deepEqual(reopenedTerminal.retained, { results: 3, outsideChange: 'refused' });
  assert.equal((reopenedTerminal.turnOutcome as { status: string }).status, 'cancelled');
  const prior = pullRecentTurnsForSession(openEventLog(), sessionId, 10);
  assert.equal(prior.at(-1)?.text, head);
  for (const text of [...reopened.map(turn => turn.text), prior.at(-1)?.text ?? '']) {
    committedPublicTexts.push({ cause: 'retained:transcripts', text });
  }
  // The durable row still names every redeemable handle.
  const stored = listEvents(sessionId, { types: ['conversation_completed'] })[0]!;
  assert.match((stored.data.presentation as { text: string }).text, /rh_voice_pin_one/);
  assert.match(String(stored.data.reply), /Retained work \(durable checkpoint\):/);
});

test('an owner Stop reduced by the loop is an app-voice line with a stopped notice, and the format hold is Clem\'s draft with a format notice', () => {
  const stopSession = 'voice-loop-stop';
  createSession({ id: stopSession, kind: 'chat' });
  const stopSource = appendEvent({ sessionId: stopSession, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Read everything.' } });
  loop._testOnly_reduceStandardConversationTerminal({
    result: { sessionId: stopSession, status: 'killed', steps: 1, lastTurn: stopSource.turn } as never,
    sourceUserSeq: stopSource.seq,
  });
  const stop = listEvents(stopSession, { types: ['conversation_completed'] })[0]!;
  assert.equal((stop.data.presentation as { status: string }).status, 'cancelled');
  assert.equal((stop.data.presentation as { text: string }).text, OWNER_STOP_TERMINAL_TEXT);
  assert.doesNotMatch(OWNER_STOP_TERMINAL_TEXT, /\b(?:I|I’ll|I'll|me|my)\b/);
  assert.deepEqual(record('stop:loop', stop).notice, { code: 'stopped' });

  for (const [reason, code] of [
    ['owner_response_format_unmet', 'response_format_unmet'],
    ['owner_response_format_unqualified', 'response_format_unqualified'],
  ] as const) {
    const sessionId = `voice-format-hold-${code}`;
    createSession({ id: sessionId, kind: 'chat' });
    const source = appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Return exactly one JSON object.' } });
    const draft = '```json\n{"value":"fixture"}\n```\nIts completeness is unknown.';
    loop._testOnly_reduceStandardConversationTerminal({
      result: { sessionId, status: 'blocked', steps: 1, lastTurn: source.turn, error: draft, blockedReason: reason } as never,
      sourceUserSeq: source.seq,
    });
    const held = listEvents(sessionId, { types: ['conversation_completed'] })[0]!;
    assert.equal((held.data.presentation as { text: string }).text, draft, 'Clem\'s own draft is the published text');
    assert.equal(held.data.blockedReason, reason);
    const data = record(`format_hold:${code}`, held);
    assert.deepEqual(data.notice, { code });
    assert.equal(data.reply, draft);
  }
});

test('the committer\'s Stop over a host-only uncertain block is an app-voice line with a stopped notice', () => {
  const sessionId = 'voice-committer-stop';
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Do the fixture work.' } });
  const attempt = eventlog.beginRunAttempt(sessionId, { runId: 'voice-committer-stop-run' });
  eventlog.bindRunAttemptSourceUserEvent(attempt, source.seq);
  eventlog.requestKill(sessionId, 'owner stop', { attemptId: attempt.attemptId });
  const identity = { sessionId, turn: source.turn, sourceUserSeq: source.seq };
  const committed = commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'blocked', resumable: false,
    presentation: { kind: 'blocked', text: HOST_TOOL_UNCERTAIN_BLOCKED_TEXT } }, { metadata: { blockedReason: 'tool_effect_uncertain' } });
  assert.equal(committed.presentation.status, 'cancelled');
  assert.equal(committed.presentation.text, OWNER_STOP_RESULTS_KEPT_TERMINAL_TEXT);
  assert.deepEqual(record('stop:committer', committed.event).notice, { code: 'stopped' });
});

const FIRST_PERSON = /\b(?:I|I’m|I'm|I’ll|I'll|I’ve|I've|me|my)\b/;

test('a failed run is an app-voice line with a notice for every failure kind', () => {
  const cases: ReadonlyArray<{ name: string; result: Record<string, unknown>; code: string; providerSaid?: string }> = [
    { name: 'codex-expired', result: { failureKind: 'codex.auth_expired', error: 'PRIVATE revoked' }, code: 'codex_sign_in_expired' },
    { name: 'empty', result: { failureKind: 'model.empty_completion', error: 'PRIVATE empty' }, code: 'model_stalled' },
    { name: 'credit', result: { error: 'Your credit balance is too low to access the API.' }, code: 'provider_out_of_credit',
      providerSaid: 'Your credit balance is too low to access the API.' },
    { name: 'usage', result: { error: "You're out of extra usage." }, code: 'provider_quota', providerSaid: "You're out of extra usage." },
    { name: 'generic', result: { error: 'PRIVATE socket hang up' }, code: 'run_failed' },
  ];
  for (const entry of cases) {
    const sessionId = `voice-failed-${entry.name}`;
    createSession({ id: sessionId, kind: 'chat' });
    const source = appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: OBJECTIVE } });
    loop._testOnly_reduceStandardConversationTerminal({
      result: { sessionId, status: 'failed', steps: 1, lastTurn: source.turn, ...entry.result } as never,
      sourceUserSeq: source.seq,
    });
    const terminal = listEvents(sessionId, { types: ['conversation_completed'] })[0]!;
    const data = record(`failed:${entry.name}`, terminal);
    assert.deepEqual(data.notice, { code: entry.code, ...(entry.providerSaid ? { providerSaid: entry.providerSaid } : {}) });
    assert.doesNotMatch(String(data.reply), FIRST_PERSON, `${entry.name}: ${String(data.reply)}`);
    assert.doesNotMatch(JSON.stringify(data), /PRIVATE/);
  }
  for (const line of [
    presentationModule.PUBLIC_RUN_FAILURE_TEXT,
    presentationModule.PUBLIC_MODEL_EMPTY_COMPLETION_TEXT,
    presentationModule.PUBLIC_CODEX_AUTH_EXPIRED_TEXT,
    presentationModule.PUBLIC_VAULT_NOT_READY_TEXT,
    presentationModule.PUBLIC_MODEL_RUNTIME_UNAVAILABLE_TEXT,
    presentationModule.publicProviderCapacityText('Your credit balance is too low to access the API.') ?? '',
    presentationModule.publicProviderCapacityText("You're out of extra usage.") ?? '',
  ]) assert.doesNotMatch(line, FIRST_PERSON, line);
});

test('the stop and quota sites never author the old first-person lines', () => {
  // These sites need a live approval executor or a quota sample to run end to
  // end (their behavior is pinned in respond-bridge and chat-approval tests);
  // their source must not carry the retired sentences either.
  for (const file of ['loop.ts', 'delivery-committer.ts', 'chat-approval-resume.ts', 'respond-bridge.ts',
    'host-turn-runner.ts', 'retained-work-checkpoint.ts', 'public-presentation.ts', '../../execution/workflow-origin-terminal.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const banned of BANNED) assert.ok(!source.includes(banned), `${file} still authors "${banned}"`);
  }
});

test('sweep: no committed public text for these causes contains a retired host sentence', () => {
  assert.ok(committedPublicTexts.length >= REVIEW_CAUSES.length * 3, 'every cause above was recorded');
  for (const { cause, text } of committedPublicTexts) {
    for (const banned of BANNED) assert.ok(!text.includes(banned), `${cause}: "${banned}" in ${JSON.stringify(text)}`);
  }
});
