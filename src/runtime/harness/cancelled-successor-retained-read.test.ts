import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { EventEmitter } from 'node:events';

// The outer isolated runner also removes credentials and blocks live models.
// Set this narrower home before importing any runtime module.
const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-cancelled-read-share-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'cancelled-read-share\n');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const dispatch = await import('./dispatch-ledger.js');
const identities = await import('./attempt-identity.js');
const outcomes = await import('./attempt-outcome.js');
const settlements = await import('./logical-call-settlement-store.js');
const delivery = await import('./delivery-committer.js');
const turnOutcomes = await import('./turn-outcome.js');
const selector = await import('./accepted-source-session-branch.js');
const shares = await import('./cancelled-successor-retained-read.js');
const reader = await import('./retained-output-read.js');
const authority = await import('./accepted-turn-call-authority.js');
const { reconstructHarnessTranscript } = await import('./transcript.js');
const { projectHarnessEventForPublic } = await import('./public-presentation.js');

after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });
let serial = 0;

function accept() {
  const n = ++serial;
  const continuity = { provider: 'desktop', scopeId: null, conversationId: `controlled-read-${n}`, audienceId: 'fixture-owner' };
  const parent = eventlog.createSession({ id: `cancelled-read-parent-${n}`, kind: 'chat', channel: 'desktop',
    userId: continuity.audienceId, metadata: { source: continuity.provider, channelId: continuity.conversationId, userId: continuity.audienceId } });
  const attempt = eventlog.beginRunAttempt(parent.id, { runId: `parent-run-${n}` });
  const source = eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user',
    data: { text: 'Read the named local fixture and explain its contents. Do not write or send.', attemptId: attempt.attemptId, runId: attempt.runId } });
  const task = { sessionId: parent.id, sourceUserSeq: source.seq, turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(parent.id, source.seq) };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }));
  return { n, continuity, parent, attempt, source, task };
}

function settle(fixture: ReturnType<typeof accept>, options: {
  tool?: string; payload?: unknown; mutating?: boolean; uncertain?: boolean; malformed?: boolean; label?: string;
} = {}) {
  const toolName = options.tool ?? 'read_file';
  const logicalToolCallId = `logical:${toolName}-${fixture.n}${options.label ? `-${options.label}` : ""}`;
  const args = { path: 'named-controlled-fixture.txt' };
  if (options.malformed) {
    const admitted = dispatch.admitLogicalCall({ identity: { ...fixture.task, logicalToolCallId }, tool: toolName, args });
    assert.equal(admitted.status, 'inserted', JSON.stringify(admitted));
  }
  if (!options.malformed) {
    const begun = dispatch.beginPhysicalDispatch({ identity: { ...fixture.task, logicalToolCallId,
      physicalDispatchId: `dispatch:${logicalToolCallId}`, ordinal: 0 }, tool: toolName, args, executionSite: 'host' });
    assert.equal(begun.status, 'inserted', JSON.stringify(begun));
    if (begun.status !== 'inserted') throw new Error('fixture dispatch not admitted');
    assert.equal(dispatch.settlePhysicalDispatch({ identity: begun.identity, tool: toolName, outcome: 'returned' }).status, 'inserted');
  }
  const settled = settlements.commitLogicalCallSettlement({
    identity: { ...fixture.task, logicalToolCallId }, contract: { toolName, args },
    execution: { kind: 'local_execution' },
    ...(!options.malformed ? { result: { payload: options.payload ?? 'FIRST\nREMAINING\n' } } : {}),
    outcome: options.malformed ? outcomes.classifyAttemptOutcome({ argumentValidationFailed: true })
      : options.uncertain ? outcomes.classifyAttemptOutcome({ mutating: true, acknowledged: false })
        : outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
    recovery: { businessCall: true, mutating: options.mutating ?? false }, observer: { lane: 'claude_sdk', turn: 1 },
  });
  assert.equal(settled.status, 'committed', JSON.stringify(settled));
  if (settled.status !== 'committed') throw new Error('fixture call did not settle');
  return { handleId: settled.settlement.resultHandleId!, logicalToolCallId };
}

function stop(fixture: ReturnType<typeof accept>, sourceOnly = false) {
  const identity = sourceOnly ? fixture.task
    : { ...fixture.task, attemptId: fixture.attempt.attemptId, runId: fixture.attempt.runId };
  delivery.commitTurnOutcome({ version: 2, id: turnOutcomes.turnOutcomeId(identity), identity,
    status: 'cancelled', resumable: false, presentation: { kind: 'stopped', text: 'Stopped.' } });
  eventlog.finishRunAttempt(fixture.attempt, 'cancelled');
  eventlog.updateSession(fixture.parent.id, { status: 'cancelled' });
}

function continueFixture(fixture: ReturnType<typeof accept>, text = 'Continue', arm = true) {
  const runId = `child-run-${fixture.n}`;
  const claimed = selector.claimSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: fixture.parent.id,
    durableSourceId: runId, continuity: fixture.continuity,
    receipt: { requestId: `child-request-${fixture.n}`, runId, inputHash: '1'.repeat(64) } });
  assert.equal(claimed.selection.disposition, 'branched');
  const sessionId = claimed.selection.sessionId;
  const attempt = eventlog.beginRunAttempt(sessionId, { runId });
  const source = eventlog.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user',
    data: { text, runId, attemptId: attempt.attemptId } });
  if (arm) {
    const armed = authority.armHostReadOnlyCallAuthority({ sessionId, sourceUserSeq: source.seq,
      surfaceVersion: 'configured_harness_tools_v1', catalogRevisionDigest: '2'.repeat(64),
      bindingRevisionDigest: '3'.repeat(64), maxLogicalCalls: 8, maxParallelCalls: 4 });
    assert.equal(armed.status, 'armed', JSON.stringify(armed));
  }
  return { sessionId, attempt, source, request: { sourceUserSeq: source.seq, attemptId: attempt.attemptId } };
}

function readContext(child: ReturnType<typeof continueFixture>) {
  return shares.renderCancelledSuccessorReadContextForModel(child.sessionId, child.source.seq);
}

test('an exact explicit Continue privately reuses settled read bytes once, through restart, without authority or a second dispatch', () => {
  const fixture = accept(), { handleId } = settle(fixture);
  stop(fixture);
  const child = continueFixture(fixture, 'Continue the stopped fixture objective. [named controlled fixture]');
  const before = eventlog.openEventLog().prepare('SELECT COUNT(*) n FROM physical_dispatches').get() as { n: number };
  const context = readContext(child);
  assert.match(context, /FIRST\\nREMAINING\\n/);
  assert.match(context, /record completeness unknown/);
  assert.equal(context.split('[EXACT RETAINED READS FOR THIS CONTINUATION]').length - 1, 1);
  assert.equal(reader.resolveRetainedOutputRead(child.sessionId, handleId).receipt, undefined, 'a bare reference has no cross-session authority');
  assert.equal(reader.resolveRetainedOutputRead(child.sessionId, handleId, child.request).receipt?.output, JSON.stringify('FIRST\nREMAINING\n'));
  eventlog.closeEventLog();
  assert.equal(readContext(child), context, 'the exact selector/share survives process storage reopen');
  assert.equal(reader.resolveRetainedOutputRead(child.sessionId, handleId, child.request).receipt?.output, JSON.stringify('FIRST\nREMAINING\n'));
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) n FROM physical_dispatches').get() as { n: number }).n, before.n);
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) n FROM logical_tool_calls WHERE session_id=?').get(child.sessionId) as { n: number }).n, 0);
  assert.equal(eventlog.getRunAttemptBySourceUserSeq(fixture.parent.id, fixture.source.seq)?.status, 'cancelled');
  const prefix = eventlog.listEvents(child.sessionId, { types: ['cross_session_prefix'] })[0]!;
  assert.equal((prefix.data.cancelledReadShares as unknown[]).length, 1);
  assert.ok(JSON.stringify(prefix.data).includes(handleId), 'private journal preserves the exact share');
  assert.doesNotMatch(String(prefix.data.text), /rh_|FIRST/, 'public historical prefix excludes the payload and private handle');
  assert.doesNotMatch(JSON.stringify(reconstructHarnessTranscript(fixture.parent.id)), /rh_|FIRST/);
  assert.doesNotMatch(JSON.stringify(reconstructHarnessTranscript(child.sessionId)), /rh_|FIRST/);
  const publicEvents = eventlog.listEvents(child.sessionId).map(projectHarnessEventForPublic).filter(Boolean);
  assert.doesNotMatch(JSON.stringify(publicEvents), /rh_|cancelledReadShares|EXACT RETAINED READS/);
});

test('a production source-only Stop projection shares reads through its exact enriched terminal executor', () => {
  const fixture = accept(), { handleId } = settle(fixture);
  stop(fixture, true);
  const terminal = eventlog.listEvents(fixture.parent.id, { types: ['conversation_completed'] })[0]!;
  const projection = terminal.data.presentation as { identity: Record<string, unknown> };
  assert.equal(projection.identity.sourceUserSeq, fixture.source.seq);
  assert.equal(projection.identity.attemptId, undefined, 'normal chat presentation retains its logical source identity');
  assert.equal(projection.identity.runId, undefined);
  assert.equal(terminal.data.attemptId, fixture.attempt.attemptId, 'the real committer enriches the durable terminal executor');
  assert.equal(terminal.data.runId, fixture.attempt.runId);
  const child = continueFixture(fixture);
  const prefix = eventlog.listEvents(child.sessionId, { types: ['cross_session_prefix'] })[0]!;
  const bindings = prefix.data.cancelledReadShares as Array<{
    parentAttemptId: string; parentRunId: string; sourceEventId: string; terminalEventId: string;
  }>;
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]!.parentAttemptId, fixture.attempt.attemptId);
  assert.equal(bindings[0]!.parentRunId, fixture.attempt.runId);
  assert.equal(bindings[0]!.sourceEventId, fixture.source.id);
  assert.equal(bindings[0]!.terminalEventId, terminal.id);
  const context = readContext(child);
  assert.match(context, /FIRST\\nREMAINING\\n/);
  assert.match(context, /record completeness unknown/);
  assert.equal(reader.resolveRetainedOutputRead(child.sessionId, handleId, child.request).receipt?.output, JSON.stringify('FIRST\nREMAINING\n'));
  const counts = () => eventlog.openEventLog().prepare(`SELECT
    (SELECT COUNT(*) FROM physical_dispatches WHERE session_id=?) AS parent,
    (SELECT COUNT(*) FROM logical_tool_calls WHERE session_id=?) AS child`).get(fixture.parent.id, child.sessionId);
  assert.deepEqual(counts(), { parent: 1, child: 0 });
  eventlog.closeEventLog();
  assert.equal(readContext(child), context, 'reopening storage preserves the exact normalized executor proof');
  assert.deepEqual(counts(), { parent: 1, child: 0 });
  assert.equal(eventlog.getRunAttemptBySourceUserSeq(fixture.parent.id, fixture.source.seq)?.status, 'cancelled');
  assert.doesNotMatch(JSON.stringify(reconstructHarnessTranscript(child.sessionId)), /rh_|FIRST/);
  assert.doesNotMatch(JSON.stringify(reconstructHarnessTranscript(fixture.parent.id)), /rh_|FIRST/);
});

test('missing or contradictory terminal executor, source ownership, or cancelled attempt cannot mint a read share', () => {
  for (const change of ['missing-attempt', 'missing-run', 'empty-attempt', 'empty-run',
    'nested-attempt', 'nested-run', 'source-attempt', 'source-run',
    'attempt-owner', 'attempt-run', 'attempt-not-cancelled', 'attempt-unfinished', 'duplicate-attempt'] as const) {
    const fixture = accept(), { handleId } = settle(fixture);
    stop(fixture, true);
    const terminal = eventlog.listEvents(fixture.parent.id, { types: ['conversation_completed'] })[0]!;
    const data = structuredClone(terminal.data), db = eventlog.openEventLog();
    if (change === 'missing-attempt') delete data.attemptId;
    if (change === 'missing-run') delete data.runId;
    if (change === 'empty-attempt') data.attemptId = ' ';
    if (change === 'empty-run') data.runId = ' ';
    if (change === 'nested-attempt' || change === 'nested-run') {
      const field = change === 'nested-attempt' ? 'attemptId' : 'runId';
      (data.presentation as { identity: Record<string, unknown> }).identity[field] = 'contradictory-owner';
    }
    if (change === 'source-attempt') data.attemptId = 'other-source-attempt';
    if (change === 'source-run') data.runId = 'other-source-run';
    db.prepare('UPDATE events SET data_json=? WHERE id=?').run(JSON.stringify(data), terminal.id);
    if (change === 'attempt-owner') db.prepare('UPDATE run_attempts SET attempt_id=? WHERE attempt_id=?')
      .run('other-cancelled-attempt', fixture.attempt.attemptId);
    if (change === 'attempt-run') db.prepare('UPDATE run_attempts SET run_id=? WHERE attempt_id=?')
      .run('other-cancelled-run', fixture.attempt.attemptId);
    if (change === 'attempt-not-cancelled') db.prepare("UPDATE run_attempts SET status='completed' WHERE attempt_id=?")
      .run(fixture.attempt.attemptId);
    if (change === 'attempt-unfinished') db.prepare('UPDATE run_attempts SET finished_at=NULL WHERE attempt_id=?')
      .run(fixture.attempt.attemptId);
    if (change === 'duplicate-attempt') db.prepare(`INSERT INTO run_attempts
      (attempt_id,session_id,run_id,started_at,finished_at,status,source_user_seq)
      SELECT ?,session_id,run_id,started_at,finished_at,status,source_user_seq FROM run_attempts WHERE attempt_id=?`)
      .run(`duplicate-cancelled-${fixture.n}`, fixture.attempt.attemptId);
    const child = continueFixture(fixture);
    const prefix = eventlog.listEvents(child.sessionId, { types: ['cross_session_prefix'] })[0]!;
    assert.equal(prefix?.data.cancelledReadShares, undefined, change);
    assert.equal(readContext(child), '', change);
    assert.equal(reader.resolveRetainedOutputRead(child.sessionId, handleId, child.request).receipt, undefined, change);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM logical_tool_calls WHERE session_id=?').get(child.sessionId) as { n: number }).n, 0, change);
  }
});

test('a larger unknown-completeness result is bounded in context and losslessly readable by its exact retained handle', () => {
  const fixture = accept(), payload = { data: 'fixture-data '.repeat(800) };
  const { handleId } = settle(fixture, { payload }); stop(fixture);
  const child = continueFixture(fixture), context = readContext(child);
  assert.match(context, /recall_tool_result/);
  assert.match(context, /record completeness unknown/);
  assert.ok(context.length < 6_500);
  assert.equal(reader.resolveRetainedOutputRead(child.sessionId, handleId, child.request).receipt?.output, JSON.stringify(payload));
  const review = shares.cancelledSuccessorReadReviewEvidence({ sessionId: child.sessionId, ...child.request })!;
  assert.match(review.summary, /open_evidence/);
  assert.match(review.summary, /not current-source tool executions/);
  for (const privateContext of [context]) {
    assert.equal(privateContext.match(/STOP \/ CONTINUE REASONING:/g)?.length, 1);
    assert.match(privateContext, /A fresh read of target state, including an empty or absent target, is not exact-operation settlement or no-dispatch proof/);
    assert.match(privateContext, /exact session, accepted source, attempt and run ownership/);
    assert.match(privateContext, /current accepted source and normal gates/);
    assert.match(privateContext, /durable parent-to-successor selector: repeated Continue rejoins/);
  }
  assert.doesNotMatch(review.summary, /STOP \/ CONTINUE REASONING:/,
    'the host reviewer carries its static rules once, separately from source evidence');
  assert.equal(review.coverage.length, 1);
  assert.deepEqual({ ref: review.coverage[0]!.logicalToolCallId, shown: review.coverage[0]!.shownByteCount,
    exhausted: review.coverage[0]!.sourceExhausted, complete: review.coverage[0]!.contentComplete },
    { ref: `inherited-read:${handleId}`, shown: 0, exhausted: false, complete: false });
  assert.equal(review.evidence.resolve(`inherited-read:${handleId}`)?.text, JSON.stringify(payload));
  assert.equal(review.evidence.resolve(handleId), undefined, 'review refs have a distinct historical namespace');
  assert.equal(review.consumer.sourceUserSeq, child.source.seq);
  assert.equal(review.consumer.attemptId, child.attempt.attemptId);
  assert.equal(review.consumer.sourceEventId, child.source.id);
  assert.equal(review.bindings[0]!.parentSessionId, fixture.parent.id);
  assert.equal(review.bindings[0]!.sourceUserSeq, fixture.source.seq);
  assert.equal(review.bindings[0]!.resultHandleId, handleId);
  const attestation = { kind: 'cancelled_successor_read_shares', semanticCompleteness: 'as_recorded',
    consumer: review.consumer, bindings: review.bindings };
  assert.equal(shares.cancelledSuccessorReadReviewIsAuthentic({ sessionId: child.sessionId, ...child.request }, attestation), true);
  eventlog.finishRunAttempt(child.attempt, 'completed');
  assert.equal(review.stillCurrent(), false);
  assert.equal(review.evidence.resolve(`inherited-read:${handleId}`), undefined, 'an inactive consumer cannot retain lookup authority');
  assert.equal(readContext(child), '');
  assert.equal(shares.cancelledSuccessorReadReviewIsAuthentic({ sessionId: child.sessionId, ...child.request }, attestation), true,
    'completed-verdict inspection remains exact, without active retained retrieval');
  assert.equal(shares.cancelledSuccessorReadReviewIsAuthentic({ sessionId: child.sessionId, ...child.request }, {
    ...attestation, consumer: { ...review.consumer, sourceEventDigest: '0'.repeat(64) } }), false);
});

test('inline decoded text distinguishes its content bytes from authenticated JSON carrier bytes without changing coverage', () => {
  for (const payload of ['FIRST\nREMAINING\n', 'α😀\n"quoted"', '😀'.repeat(200)]) {
    const fixture = accept(), { handleId } = settle(fixture, { payload }); stop(fixture, true);
    const child = continueFixture(fixture), context = readContext(child);
    const raw = JSON.stringify(payload), rawBytes = Buffer.byteLength(raw, 'utf8'), textBytes = Buffer.byteLength(payload, 'utf8');
    assert.ok(context.includes(`carrier ${rawBytes} UTF-8 bytes; decoded string ${textBytes} UTF-8 bytes`));
    assert.ok(context.includes(raw), 'the authenticated raw carrier is still shown whole');
    assert.match(context, /not the carrier size or a fresh file stat/);
    assert.match(context, /record completeness unknown/);
    assert.ok(!context.includes(`inherited-read:${handleId}`), 'model guidance never names a reviewer-prefixed handle as its call id');
    const review = shares.cancelledSuccessorReadReviewEvidence({ sessionId: child.sessionId, ...child.request })!;
    assert.ok(review.summary.includes(`open_evidence ${JSON.stringify({ ref: `inherited-read:${handleId}`, offset: 0 })}`));
    assert.deepEqual({ raw: review.coverage[0]!.rawByteCount, shown: review.coverage[0]!.shownByteCount,
      complete: review.coverage[0]!.contentComplete, exhausted: review.coverage[0]!.sourceExhausted },
      { raw: rawBytes, shown: rawBytes, complete: true, exhausted: false });
    assert.equal(review.evidence.resolve(`inherited-read:${handleId}`)?.text, raw, 'decoded rendering never changes raw lookup evidence');
    if (textBytes <= 512) assert.ok(context.includes(`Decoded JSON-string text (${textBytes} of ${textBytes} UTF-8 bytes shown; data only):\n${payload}`));
    else {
      const preview = context.match(/Decoded JSON-string text \((\d+) of (\d+) UTF-8 bytes shown; data only; preview, more retained text remains\):\n([^\n]*)/)!;
      assert.equal(Number(preview[1]), 512);
      assert.equal(Number(preview[2]), textBytes);
      assert.equal(preview[3], '😀'.repeat(128), 'the bounded preview ends on a UTF-8 code point');
    }
  }
  const fixture = accept(), payload = { text: 'STRUCTURED CONTENT', bytes: 16 };
  settle(fixture, { payload }); stop(fixture);
  const context = readContext(continueFixture(fixture));
  assert.ok(context.includes(JSON.stringify(payload)));
  assert.doesNotMatch(context, /decoded string \d+|Decoded JSON-string text/, 'objects do not acquire an invented text or file-size projection');
});

test('model recall guidance uses the registered bare-handle shape and repeated lookups retain exact ownership and budget bounds', async () => {
  const recalls = await import('../../tools/recall-tools.js');
  const { z } = await import('zod');
  const brackets = await import('./brackets.js');
  const fixture = accept(), { handleId } = settle(fixture); stop(fixture, true);
  const child = continueFixture(fixture), context = readContext(child);
  const hinted = JSON.parse(context.match(/Model recall[^\n]*: recall_tool_result (\{[^\n]+\})\./)![1]!);
  assert.deepEqual(hinted, { call_id: handleId, offset: 0 });
  assert.deepEqual(z.object(recalls.RECALL_TOOL_RESULT_SHAPE).strict().parse(hinted), hinted);
  assert.equal(z.object(recalls.RECALL_TOOL_RESULT_SHAPE).safeParse({ ...hinted, max_chars: null }).success, false,
    'the prompt does not invent null for a raw optional numeric field');
  let recall: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
  recalls.registerRecallTools({ tool(name: string, _description: string, _shape: unknown, handler: typeof recall) {
    if (name === 'recall_tool_result') recall = handler;
  } } as never);
  const budget = new brackets.RecallBudget(2, 60_000);
  const call = (callId: string, attemptId = child.attempt.attemptId) => brackets.withHarnessRunContext({
    sessionId: child.sessionId, sourceUserSeq: child.source.seq, runAttemptId: attemptId,
    counter: new brackets.ToolCallsCounter(8), recallBudget: budget,
  }, () => recall!({ call_id: callId, offset: 0 }));
  for (const invalid of [`inherited-read:${handleId}`, handleId.toUpperCase(), `${handleId}-unrelated`]) {
    assert.doesNotMatch(JSON.stringify(await call(invalid)), /FIRST|REMAINING/, invalid);
  }
  assert.doesNotMatch(JSON.stringify(await call(handleId, 'other-attempt')), /FIRST|REMAINING/);
  const db = eventlog.openEventLog();
  db.prepare('UPDATE sessions SET user_id=? WHERE id=?').run('other-owner', child.sessionId);
  assert.doesNotMatch(JSON.stringify(await call(handleId)), /FIRST|REMAINING/);
  db.prepare('UPDATE sessions SET user_id=? WHERE id=?').run(fixture.continuity.audienceId, child.sessionId);
  const other = accept(), otherResult = settle(other, { payload: 'UNSHARED-CONTROLLED-BYTES' });
  assert.doesNotMatch(JSON.stringify(await call(otherResult.handleId)), /UNSHARED-CONTROLLED-BYTES/);
  for (let count = 0; count < 2; count++) {
    const result = await call(handleId);
    assert.match(result.content[0]!.text, /Recalled chars 0–20 of 20 \(20 total bytes\)/);
    assert.ok(result.content[0]!.text.endsWith(JSON.stringify('FIRST\nREMAINING\n')));
  }
  assert.match((await call(handleId)).content[0]!.text, /ERROR: recall budget exhausted/);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM physical_dispatches WHERE session_id=?').get(fixture.parent.id) as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM logical_tool_calls WHERE session_id=?').get(child.sessionId) as { n: number }).n, 0,
    'direct unit lookups do not repeat the original read or transfer effect authority');
});

test('wrong principal, wrong attempt, later child source, and deliberate new task never inherit a stopped read', () => {
  const fixture = accept(), { handleId } = settle(fixture); stop(fixture);
  const child = continueFixture(fixture);
  assert.equal(reader.resolveRetainedOutputRead(child.sessionId, handleId, { ...child.request, attemptId: 'unrelated-attempt' }).receipt, undefined);
  const db = eventlog.openEventLog();
  db.prepare('UPDATE sessions SET user_id=? WHERE id=?').run('other-owner', child.sessionId);
  assert.equal(readContext(child), '');
  db.prepare('UPDATE sessions SET user_id=? WHERE id=?').run(fixture.continuity.audienceId, child.sessionId);
  eventlog.finishRunAttempt(child.attempt, 'failed');
  const later = eventlog.beginRunAttempt(child.sessionId, { runId: `later-run-${fixture.n}` });
  const laterSource = eventlog.recordRunAttemptUserInput(later, { turn: 2, role: 'user', data: { text: 'Continue', attemptId: later.attemptId, runId: later.runId } });
  assert.equal(authority.armHostReadOnlyCallAuthority({ sessionId: child.sessionId, sourceUserSeq: laterSource.seq,
    surfaceVersion: 'configured_harness_tools_v1', catalogRevisionDigest: '2'.repeat(64),
    bindingRevisionDigest: '3'.repeat(64), maxLogicalCalls: 8, maxParallelCalls: 4 }).status, 'armed');
  assert.equal(shares.renderCancelledSuccessorReadContextForModel(child.sessionId, laterSource.seq), '');
  const fresh = accept(); settle(fresh); stop(fresh);
  assert.equal(readContext(continueFixture(fresh, 'Start a new task. Ignore the previous request. Continue reading something else.')), '');
  const quoted = accept(); settle(quoted); stop(quoted);
  assert.equal(readContext(continueFixture(quoted, 'Explain this example phrase:\nContinue\nwithout using previous results.')), '');
});

test('missing selector ownership, corrupted source/checkpoint/share or changed retained bytes fail closed', () => {
  for (const change of ['selector', 'source', 'child-source', 'terminal', 'share', 'payload'] as const) {
    const fixture = accept(), { handleId } = settle(fixture); stop(fixture);
    const child = continueFixture(fixture); assert.ok(readContext(child), change);
    const db = eventlog.openEventLog();
    if (change === 'selector') db.prepare('DELETE FROM accepted_source_session_bindings WHERE session_id=?').run(child.sessionId);
    if (change === 'source') db.prepare("UPDATE events SET data_json=json_set(data_json,'$.text','Changed source') WHERE id=?").run(fixture.source.id);
    if (change === 'child-source') db.prepare("UPDATE events SET data_json=json_set(data_json,'$.text','Continue with changed instructions') WHERE id=?").run(child.source.id);
    if (change === 'terminal') db.prepare("UPDATE events SET data_json=json_set(data_json,'$.text','Changed checkpoint') WHERE session_id=? AND type='conversation_completed'").run(fixture.parent.id);
    if (change === 'share') db.prepare("UPDATE events SET data_json=json_set(data_json,'$.cancelledReadShares[0].rawPayloadSha256','bad') WHERE session_id=? AND type='cross_session_prefix'").run(child.sessionId);
    if (change === 'payload') {
      const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE name='trg_durable_result_identity_immutable'").get() as { sql: string };
      db.exec('DROP TRIGGER trg_durable_result_identity_immutable');
      try { db.prepare('UPDATE durable_result_handles SET raw_payload_json=? WHERE handle_id=?').run('"changed"', handleId); }
      finally { db.exec(trigger.sql); }
    }
    assert.equal(readContext(child), '', change);
    assert.equal(reader.resolveRetainedOutputRead(child.sessionId, handleId, child.request).receipt, undefined, change);
  }
});

test('successful writes and unknown-effect calls are never shared as reads; uncertain effects suppress the automatic handoff', () => {
  const write = accept(); const writeResult = settle(write, { tool: 'write_file', mutating: true }); stop(write);
  const writeChild = continueFixture(write);
  assert.equal(readContext(writeChild), '');
  assert.equal(reader.resolveRetainedOutputRead(writeChild.sessionId, writeResult.handleId, writeChild.request).receipt, undefined);
  const unknown = accept(); settle(unknown, { tool: 'unknown_transport' }); stop(unknown);
  assert.equal(readContext(continueFixture(unknown)), '');
  const uncertain = accept(); settle(uncertain); settle(uncertain, { tool: 'write_file', mutating: true, uncertain: true }); stop(uncertain);
  assert.equal(readContext(continueFixture(uncertain)), '', 'uncertain effects require reconciliation, not automatic continuation evidence');
});

test('a malformed later read is contrary evidence, never a successful saved result or a reason to discard the exact prior read', () => {
  const fixture = accept(), { handleId } = settle(fixture);
  settle(fixture, { tool: 'session_context_read', malformed: true }); stop(fixture);
  const child = continueFixture(fixture), context = readContext(child);
  assert.match(context, /FIRST/);
  assert.equal((eventlog.listEvents(child.sessionId, { types: ['cross_session_prefix'] })[0]!.data.cancelledReadShares as unknown[]).length, 1);
  assert.ok(reader.resolveRetainedOutputRead(child.sessionId, handleId, child.request).receipt);
  assert.doesNotMatch(context, /READ session_context_read/);
  assert.match(context, /session_context_read.*invalid_arguments/);
});

test('review coverage records each exact rendered ref even when equal small payloads exceed the shared context budget', () => {
  const fixture = accept(), payload = 'SAME-CONTROLLED-BYTES '.repeat(75);
  const handles = Array.from({ length: 8 }, (_, index) => settle(fixture, { payload, label: String(index) }).handleId);
  stop(fixture);
  const child = continueFixture(fixture);
  const review = shares.cancelledSuccessorReadReviewEvidence({ sessionId: child.sessionId, ...child.request })!;
  assert.ok(review.coverage.length >= 4 && review.coverage.length <= 8, 'only handles retained in the bounded Stop checkpoint are shared');
  assert.ok(review.coverage.some(row => row.contentComplete === true));
  assert.ok(review.coverage.some(row => row.contentComplete === false));
  for (const row of review.coverage) {
    assert.equal(row.sourceExhausted, false);
    assert.equal(row.shownByteCount, row.contentComplete ? row.rawByteCount : 0);
  }
  const omitted = review.coverage.find(row => row.contentComplete === false)!;
  assert.equal(review.evidence.resolve(omitted.logicalToolCallId!)?.text, JSON.stringify(payload));
  assert.equal(handles.length, 8, 'equal bytes under another ref never imply this ref was shown');
});

test('a zero-business-call Continue receives normal completion review with exact inherited lookup and a revalidated final binding', async t => {
  const host = await import('./host-turn-runner.js');
  const brackets = await import('./brackets.js');
  const envelopes = await import('../../agents/capability-envelope.js');
  for (const corruption of ['share', 'child-source', 'missing-attestation', 'adopted-steering', 'missing-review']) {
    const fixture = accept(), { handleId } = settle(fixture);
    const note = eventlog.appendEvent({ sessionId: fixture.parent.id, turn: 1, role: 'user', type: 'user_steer_note',
      data: { text: 'Explain both lines separately, keeping the original order.' } });
    eventlog.appendEvent({ sessionId: fixture.parent.id, turn: 1, role: 'system', type: 'user_steer_note_delivered',
      data: { sourceUserSeq: fixture.source.seq, noteSeqs: [note.seq] } });
    stop(fixture);
    const child = continueFixture(fixture, 'Continue', false);
    const answer = 'The retained read shows FIRST and REMAINING. I have not read it again.';
    let reviews = 0, modelCalls = 0;
    host._setHostObjectiveJudgeForTests(async (objective, reply, context) => {
      reviews += 1;
      assert.equal(reply, answer);
      assert.equal(objective, 'Continue');
      assert.match(context?.toolCallSummary ?? '', /Read the named local fixture and explain its contents\. Do not write or send\./);
      assert.match(context?.toolCallSummary ?? '', /Explain both lines separately, keeping the original order/);
      assert.match(context?.toolCallSummary ?? '', /whole effective objective together with current amendments/);
      assert.equal(context?.inheritedReadCoverage?.[0]?.sourceExhausted, false);
      assert.deepEqual(context?.verifiedReadResults, [], 'parent evidence never becomes current-source coverage');
      assert.match(context?.toolCallSummary ?? '', /Origin-qualified historical READ evidence/);
      assert.match(context?.toolCallSummary ?? '', /record completeness unknown/);
      assert.equal((context?.toolCallSummary ?? '').split(JSON.stringify('FIRST\nREMAINING\n')).length - 1, 1);
      assert.equal(context?.evidence?.resolve(`inherited-read:${handleId}`)?.text, JSON.stringify('FIRST\nREMAINING\n'));
      assert.equal(context?.historicalEvidence, undefined, 'unknown completeness cannot enter historical fast closure');
      return { done: true, reason: 'The exact original read supports this historical answer.' };
    });
    t.after(() => host._setHostObjectiveJudgeForTests(null));
    const agent = { tools: [], model: { async getResponse() {
      modelCalls += 1;
      return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, inputTokensDetails: [], outputTokensDetails: [] },
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer }] }],
        responseId: `controlled-inherited-read-${modelCalls}` };
    }, async *getStreamedResponse(this: { getResponse: () => Promise<{ output: unknown[]; usage: Record<string, unknown>; responseId: string }> }) {
      const response = await this.getResponse();
      yield { type: 'response_started' };
      yield { type: 'model', event: { type: 'finish', finishReason: 'stop' } };
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } };
    } } };
    const sealed = envelopes.sealAgentCapabilityUniverse({ sessionId: child.sessionId, universeTools: [], activeToolNames: [],
      policyHash: 'controlled-inherited-read-policy', budget: { maxUncachedTokens: 1_000, maxModelCalls: 8, maxToolCalls: 8, maxElapsedMs: 60_000 } });
    assert.equal(sealed.ok, true, JSON.stringify(sealed)); if (!sealed.ok) throw new Error('fixture surface not sealed');
    envelopes.bindAgentCapabilityEnvelope(agent, sealed.envelope);
    envelopes.bindAgentCapabilityRevision(agent, sealed.revision);
    const runner = new EventEmitter();
    Object.assign(runner, { run: () => { throw new Error('Runner.run must not be called'); } });
    const result = await brackets.withHarnessRunContext({ sessionId: child.sessionId, sourceUserSeq: child.source.seq,
      runAttemptId: child.attempt.attemptId, interactiveForeground: true, counter: new brackets.ToolCallsCounter(8) },
      () => host.hostRunRunner(runner as never, agent as never, [{ type: 'message', role: 'user', content: 'Continue' }] as never,
        { maxTurns: 4, hostTurnEngine: 'host_v1', hostJudgeCompletion: true,
          context: { sessionId: child.sessionId, sourceUserSeq: child.source.seq } } as never));
    assert.equal(result.finalOutput, answer);
    assert.equal(modelCalls, 1);
    assert.equal(reviews, 1, 'zero new tools must not skip evidence-based completion review');
    assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) n FROM physical_dispatches WHERE session_id=?').get(child.sessionId) as { n: number }).n, 0);
    const review = eventlog.listEvents(child.sessionId, { types: ['goal_alignment_judged'] }).find(event => event.data.kind === 'completion')!;
    assert.ok(review.data.judgedInheritedReadResults);
    assert.equal(review.data.inheritedReadReviewRequired, true);
    assert.equal(host.completionVerdictForAcceptedSource({ sessionId: child.sessionId, sourceUserSeq: child.source.seq })?.fulfills, true);
    eventlog.finishRunAttempt(child.attempt, 'completed');
    assert.equal(host.completionVerdictForAcceptedSource({ sessionId: child.sessionId, sourceUserSeq: child.source.seq })?.fulfills, true);
    const db = eventlog.openEventLog();
    if (corruption === 'share') db.prepare("UPDATE events SET data_json=json_set(data_json,'$.cancelledReadShares[0].rawPayloadSha256','changed') WHERE session_id=? AND type='cross_session_prefix'").run(child.sessionId);
    if (corruption === 'child-source') db.prepare("UPDATE events SET data_json=json_set(data_json,'$.text','Continue with altered instructions') WHERE id=?").run(child.source.id);
    if (corruption === 'missing-attestation') db.prepare("UPDATE events SET data_json=json_remove(data_json,'$.judgedInheritedReadResults') WHERE id=?").run(review.id);
    if (corruption === 'adopted-steering') db.prepare("UPDATE events SET data_json=json_set(data_json,'$.text','Different owner instruction') WHERE id=?").run(note.id);
    if (corruption === 'missing-review') db.prepare('DELETE FROM events WHERE id=?').run(review.id);
    const invalid = host.completionVerdictForAcceptedSource({ sessionId: child.sessionId, sourceUserSeq: child.source.seq });
    if (corruption === 'missing-review') assert.equal(invalid, null);
    else {
      assert.equal(invalid?.fulfills, false, 'a verdict cannot certify a changed inherited producer binding');
      assert.equal(invalid?.reviewFailure, 'invalid');
    }
    const identity = { sessionId: child.sessionId, sourceUserSeq: child.source.seq, turn: 1,
      attemptId: child.attempt.attemptId, runId: child.attempt.runId };
    const proposed = { version: 2 as const, id: turnOutcomes.turnOutcomeId(identity), identity,
      status: 'done' as const, resumable: false as const, presentation: { kind: 'answer' as const, text: answer } };
    if (corruption === 'child-source') {
      assert.throws(() => delivery.commitTurnOutcome(proposed), /host call authority does not recompute/);
      assert.equal(eventlog.listEvents(child.sessionId, { types: ['conversation_completed'] }).length, 0);
      continue;
    }
    const committed = delivery.commitTurnOutcome(proposed);
    assert.notEqual(committed.presentation.status, 'done', 'invalid inherited proof must fail closed at the public delivery boundary');
    // Clem's answer stands as written; the hold is the review chip's state.
    // A host evidence hold is never published as though it were Clem's reply.
    assert.equal(committed.presentation.text, answer.trim());
    assert.equal(committed.event.data.review, corruption === 'missing-review' ? 'unchecked' : 'needs_recheck');
    assert.equal(committed.event.data.reviewNote, undefined, 'host evidence text is not a reviewer finding');
    if (corruption !== 'missing-review') assert.equal(invalid?.hostEvidenceHold, true);
  }
});

test('a successor reader credits only the authorized bare producer and actual range, with diagnostic failures excluded', async () => {
  const recalls = await import('../../tools/recall-tools.js');
  const brackets = await import('./brackets.js');
  const { sourceSettledReadEvidence } = await import('./host-completion-work.js');
  const fixture = accept(), producer = settle(fixture, { payload: 'CONTROLLED_TEXT '.repeat(200) + 'TAIL' });
  stop(fixture);
  const child = continueFixture(fixture, 'Continue the stopped objective', false);
  const task = { sessionId: child.sessionId, sourceUserSeq: child.source.seq, turn: 1,
    acceptedTaskId: identities.acceptedTaskIdFor(child.sessionId, child.source.seq) };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }));
  let handler: (args: Record<string, unknown>) => Promise<any>;
  recalls.registerRecallTools({ tool(name: string, _description: string, _shape: unknown, callback: typeof handler) {
    if (name === 'recall_tool_result') handler = callback;
  } } as never);
  const call = (id: string, args: Record<string, unknown>, recallBudget?: InstanceType<typeof brackets.RecallBudget>) =>
    identities.withLogicalToolCall({ ...task, tool: 'recall_tool_result', args, logicalToolCallId: id }, async () => {
      const opened = dispatch.beginPhysicalDispatch({ identity: { ...task, logicalToolCallId: id,
        physicalDispatchId: `dispatch:${id}`, ordinal: 0 }, tool: 'recall_tool_result', args, executionSite: 'host' });
      assert.equal(opened.status, 'inserted', JSON.stringify(opened));
      if (opened.status !== 'inserted') throw new Error('child reader fixture admission failed');
      const payload = await brackets.withHarnessRunContext({ ...task, runAttemptId: child.attempt.attemptId,
        counter: new brackets.ToolCallsCounter(8), recallBudget }, () => handler!(args));
      dispatch.settlePhysicalDispatch({ identity: opened.identity, tool: 'recall_tool_result', outcome: 'returned' });
      const result = settlements.commitLogicalCallSettlement({ identity: { ...task, logicalToolCallId: id },
        contract: { toolName: 'recall_tool_result', args }, execution: { kind: 'local_execution' }, result: { payload },
        outcome: outcomes.classifyAttemptOutcome(payload.isError ? { executionFailed: true } : { envelopeSuccessful: true }),
        recovery: { businessCall: true, mutating: false }, observer: { lane: 'claude_sdk', turn: 1 } });
      assert.equal(result.status, 'committed', JSON.stringify(result));
      return payload;
    });
  const missing = await call('reviewer-only-ref', { call_id: `inherited-read:${producer.handleId}` });
  assert.equal(missing.isError, true);
  const spent = await call('no-reading-budget', { call_id: producer.handleId }, new brackets.RecallBudget(0, 0));
  assert.equal(spent.isError, true);
  await call('shared-partial-page', { call_id: producer.handleId, offset: 3, max_chars: 100 });
  const evidence = sourceSettledReadEvidence(task);
  for (const id of ['reviewer-only-ref', 'no-reading-budget']) {
    const row = evidence.results.find(r => r.logicalToolCallId === id)!;
    assert.equal(row.status, 'not_succeeded');
    assert.equal(row.evidenceKind, 'control_diagnostic');
    assert.equal(row.sourceResultHandleId, undefined);
  }
  const partial = evidence.results.find(r => r.logicalToolCallId === 'shared-partial-page')!;
  assert.equal(partial.evidenceKind, 'retained_projection');
  assert.equal(partial.sourceSessionId, fixture.parent.id);
  assert.equal(partial.sourceUserSeq, fixture.source.seq);
  assert.equal(partial.sourceLogicalToolCallId, producer.logicalToolCallId);
  assert.equal(partial.sourceResultHandleId, producer.handleId);
  assert.equal(partial.sourcePhysicalDispatchId, `dispatch:${producer.logicalToolCallId}`);
  assert.equal(partial.sourceSelectionComplete, false);
  assert.deepEqual(partial.sourceReadRange, { start: 3, end: 103, total: JSON.stringify('CONTROLLED_TEXT '.repeat(200) + 'TAIL').length });
  await call('shared-whole-stored-text', { call_id: producer.handleId, max_chars: 20_000 });
  const whole = sourceSettledReadEvidence(task).results.find(r => r.logicalToolCallId === 'shared-whole-stored-text')!;
  assert.equal(whole.evidenceKind, 'retained_projection');
  assert.equal(whole.sourceSelectionComplete, true);
  const inherited = shares.cancelledSuccessorReadReviewEvidence({ sessionId: child.sessionId, sourceUserSeq: child.source.seq });
  assert.equal(inherited?.coverage[0]?.sourceExhausted, false, 'full stored text does not prove unknown original semantic completeness');
  assert.equal(inherited?.coverage[0]?.resultHandleId, producer.handleId);
  eventlog.finishRunAttempt(child.attempt, 'completed');
  eventlog.closeEventLog();
  assert.equal(sourceSettledReadEvidence(task).results.find(r => r.logicalToolCallId === 'shared-whole-stored-text')?.evidenceKind,
    'retained_projection', 'finished consumer verification reopens proof without new read authority');
  eventlog.openEventLog().prepare('UPDATE sessions SET user_id=? WHERE id=?').run('different-owner', child.sessionId);
  const wrongPrincipal = sourceSettledReadEvidence(task).results.find(r => r.logicalToolCallId === 'shared-whole-stored-text')!;
  assert.equal(wrongPrincipal.evidenceKind, 'control_diagnostic');
  assert.equal(wrongPrincipal.sourceResultHandleId, undefined);
  assert.equal((eventlog.openEventLog().prepare('SELECT COUNT(*) n FROM physical_dispatches WHERE session_id=?')
    .get(fixture.parent.id) as { n: number }).n, 1, 'original provider read was never repeated');
});
