/** A card acknowledgment is display-only; the released action keeps its own result. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-card-decision-ack-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const log = await import('./eventlog.js');
const registry = await import('./approval-registry.js');
const { commitLiveApprovalControl } = await import('./live-approval-control.js');
const { approvalDecisionAckMetadata, publicApprovalDecisionAck } = await import('./approval-decision-ack.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { projectHarnessEventForPublic } = await import('./public-presentation.js');
const { reconstructHarnessTranscript } = await import('./transcript.js');
type EventRow = import('./eventlog.js').EventRow;

after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

let serial = 0;
const reasons = ['queued_action_decision_resolved', 'sdk_approval_resolved', 'workflow_approval_resolved',
  'workspace_runner_approval_refresh_started', 'workspace_approval_resolved', 'mobile_approval_resolved',
  'mobile_background_approval_queued'];

function fixture(decision: 'approve' | 'reject' = 'approve', reason = 'sdk_approval_resolved', metadataEnabled = true) {
  const n = ++serial;
  const session = log.createSession({ id: `approval-ack-${n}`, kind: 'chat', channel: 'desktop' });
  const attempt = log.beginRunAttempt(session.id, { runId: `approval-original-${n}` });
  const original = log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user',
    data: { text: 'Prepare the controlled change and wait for my decision.' } }, { armRunInFlight: true });
  const args = { name: 'fixture_write', args_json: '{"value":"controlled"}' };
  const card = registry.register({ sessionId: session.id, subject: 'Controlled change', tool: 'work_call', args });
  const carrier = log.appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'approval_requested',
    data: { approvalId: card.approvalId, tool: card.tool, args, sourceUserSeq: original.seq } });
  const owner = log.getSession(session.id)!.metadata.__run_in_flight_owner;
  const requestId = `approval-ack-request-${n}`;
  let issuedMetadata: Record<string, unknown> = {};
  let resolutions = 0;
  const submit = () => commitLiveApprovalControl({ sessionId: session.id, requestId,
    runId: `approval-ack-control-${n}`, inputHash: `controlled-ack-hash-${n}`,
    text: n % 2 ? 'Yes, go ahead.' : `Approve ${card.approvalId}.`,
    prepare: () => ({ sourceData: { approvalId: card.approvalId, decision,
      ...(n % 2 ? {} : { source: 'mobile_approval' }) }, commit: (source, resolve) => {
      const resolved = resolve(card.approvalId, decision === 'approve' ? 'approved' : 'rejected', 'controlled-owner');
      assert.equal(resolved.ok, true);
      resolutions++;
      issuedMetadata = metadataEnabled ? approvalDecisionAckMetadata(source, card.approvalId, decision) : {};
      const identity = { sessionId: session.id, turn: source.turn, sourceUserSeq: source.seq };
      commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'done', resumable: false,
        presentation: { kind: 'answer', text: decision === 'approve' ? 'Approved.' : 'Declined.' } },
      { legacyReason: reason, metadata: { steps: 0, ...issuedMetadata,
        ...(metadataEnabled ? {} : { hostNotice: { code: 'card_decision' } }) } });
    } }) });
  const result = submit();
  assert.ok(result);
  const terminal = log.listEvents(session.id, { types: ['conversation_completed'] })
    .find(event => event.data.sourceUserSeq === result.source.seq)!;
  assert.ok(terminal);
  return { session, attempt, original, card, carrier, owner, source: result.source, terminal, result, submit,
    metadata: issuedMetadata, resolutions: () => resolutions, decision };
}

function expected(f: ReturnType<typeof fixture>) {
  return { version: 1, sourceUserSeq: f.source.seq, approvalId: f.card.approvalId, decision: f.decision };
}

function replaceData(event: EventRow, data: Record<string, unknown>): EventRow {
  log.openEventLog().prepare('UPDATE events SET data_json=? WHERE id=?').run(JSON.stringify(data), event.id);
  return log.getEvent(event.id)!;
}

function assertNotAck(event: EventRow) {
  assert.equal(publicApprovalDecisionAck(event), null);
  const projected = projectHarnessEventForPublic(event);
  assert.equal(projected?.data.approvalDecisionAck, undefined);
  assert.notEqual((projected?.data.notice as Record<string, unknown> | undefined)?.code, 'card_decision');
}

test('successful host-only card decisions have one bounded public receipt across every acknowledgment reason', () => {
  for (const reason of reasons) for (const decision of ['approve', 'reject'] as const) {
    const f = fixture(decision, reason);
    assert.deepEqual(publicApprovalDecisionAck(f.terminal), expected(f), JSON.stringify({ reason,
      role: f.terminal.role, metadata: f.metadata, terminalKeys: Object.keys(f.terminal.data),
      recordedReason: f.terminal.data.reason, review: f.terminal.data.review,
      verification: f.terminal.data.verification, presentation: f.terminal.data.presentation }));
    const projected = projectHarnessEventForPublic(f.terminal)!;
    assert.deepEqual(projected.data.approvalDecisionAck, expected(f));
    assert.deepEqual(projected.data.notice, { code: 'card_decision' });
    if (reason === reasons[0] && decision === 'approve') {
      const directory = path.resolve('output/approval-stop-refinement');
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'actual-projected-ack.json'), `${JSON.stringify(projected, null, 2)}\n`);
    }
    assert.equal((projected.data.approvalDecisionAck as Record<string, unknown>).sourceEventId, undefined);
    assert.equal((projected.data.approvalDecisionAck as Record<string, unknown>).resolvedAt, undefined);
    assert.deepEqual(log.getSession(f.session.id)!.metadata.__run_in_flight_owner, f.owner);
    assert.equal(log.getRunAttemptBySourceUserSeq(f.session.id, f.original.seq)?.status, 'active');
    assert.equal(log.getRunAttemptBySourceUserSeq(f.session.id, f.source.seq), null);
    assert.equal(log.listEvents(f.session.id).some(event => ['tool_called', 'model_request_started', 'run_started'].includes(event.type)), false);
  }
});

test('duplicate submission and reopen retain one decision and the exact original executor without new execution', () => {
  const f = fixture();
  const before = log.getEvent(f.source.id);
  const replay = f.submit();
  assert.equal(replay?.replayed, true);
  assert.equal(replay?.source.seq, f.source.seq);
  assert.equal(f.resolutions(), 1);
  assert.equal(log.listEvents(f.session.id, { types: ['conversation_completed'] }).length, 1);
  assert.deepEqual(log.getEvent(f.source.id), before);
  log.closeEventLog();
  assert.deepEqual(publicApprovalDecisionAck(log.getEvent(f.terminal.id)!), expected(f));
  const turns = reconstructHarnessTranscript(f.session.id);
  const shown = turns.find(turn => (turn.terminal?.approvalDecisionAck as Record<string, unknown> | undefined)?.sourceUserSeq === f.source.seq);
  assert.ok(shown, 'transcript reopen carries the same exact validated acknowledgment');
  assert.deepEqual(shown.terminal?.notice, { code: 'card_decision' });
  assert.deepEqual(shown.terminal?.approvalDecisionAck, expected(f));
  assert.deepEqual(log.getSession(f.session.id)!.metadata.__run_in_flight_owner, f.owner);
});

test('copied card_decision notice alone never suppresses the result', () => {
  const f = fixture('approve', 'sdk_approval_resolved', false);
  assertNotAck(f.terminal);
  assert.equal(projectHarnessEventForPublic(f.terminal)?.data.reply, 'Approved.');
});

test('normalized session reopen restores only the exact acknowledged card with its resolved state', async () => {
  const { getUnifiedSessionDetail } = await import('../../dashboard/sessions-api.js');
  for (const decision of ['approve', 'reject'] as const) {
    const f = fixture(decision);
    const unrelated = registry.register({ sessionId: f.session.id, subject: 'Unrelated resolved card', tool: 'work_call', args: {} });
    log.appendEvent({ sessionId: f.session.id, turn: 1, role: 'Clem', type: 'approval_requested',
      data: { approvalId: unrelated.approvalId, tool: unrelated.tool, args: {}, sourceUserSeq: f.original.seq } });
    registry.resolve(unrelated.approvalId, 'approved', 'controlled-other-decision');
    log.closeEventLog();
    const detail = getUnifiedSessionDetail(`harness:${f.session.id}`)!;
    assert.ok(detail);
    const cards = detail.turns.filter(turn => turn.approval);
    assert.equal(cards.length, 1, 'unrelated resolved history is not revived by another card receipt');
    assert.equal(cards[0]!.approval!.approvalId, f.card.approvalId);
    assert.equal(cards[0]!.approval!.resolution, decision === 'approve' ? 'approved' : 'declined');
    const ack = detail.turns.find(turn => (turn.terminal?.approvalDecisionAck as Record<string, unknown> | undefined)?.sourceUserSeq === f.source.seq);
    assert.deepEqual(ack?.terminal?.approvalDecisionAck, expected(f));
    assert.deepEqual(ack?.terminal?.notice, { code: 'card_decision' });
    assert.equal(log.getRunAttemptBySourceUserSeq(f.session.id, f.original.seq)?.status, 'active');
  }
});

test('unretained, altered, foreign-session and mismatched-source terminal copies cannot earn the receipt', () => {
  const f = fixture();
  const foreign = log.createSession({ id: `approval-ack-foreign-${++serial}`, kind: 'chat' });
  for (const copied of [
    { ...f.terminal, id: 'unretained-card-ack', seq: f.terminal.seq + 10_000 },
    { ...f.terminal, sessionId: foreign.id },
    { ...f.terminal, data: { ...f.terminal.data, reply: 'Changed words.' } },
    { ...f.terminal, data: { ...f.terminal.data, sourceUserSeq: f.original.seq } },
  ]) assertNotAck(copied);
});

test('persisted source, card, decision, timestamp and earlier-carrier mismatches invalidate the acknowledgment', () => {
  for (const mutation of ['source-card', 'source-decision', 'source-confirm', 'source-inquiry', 'source-change', 'resolution', 'resolved-at', 'carrier']) {
    const f = fixture();
    if (mutation === 'source-card') replaceData(f.source, { ...f.source.data, approvalId: 'another-card' });
    if (mutation === 'source-decision') replaceData(f.source, { ...f.source.data, decision: 'reject' });
    if (mutation === 'source-confirm') replaceData(f.source, { ...f.source.data, confirm: 'approves' });
    if (mutation === 'source-inquiry') replaceData(f.source, { ...f.source.data, approvalInquiry: { approvalIds: [f.card.approvalId] } });
    if (mutation === 'source-change') replaceData(f.source, { ...f.source.data, changeRequested: true });
    if (mutation === 'resolution') log.openEventLog().prepare("UPDATE pending_approvals SET resolution='rejected' WHERE approval_id=?").run(f.card.approvalId);
    if (mutation === 'resolved-at') log.openEventLog().prepare("UPDATE pending_approvals SET resolved_at='2000-01-01T00:00:00.000Z' WHERE approval_id=?").run(f.card.approvalId);
    if (mutation === 'carrier') log.openEventLog().prepare('DELETE FROM events WHERE id=?').run(f.carrier.id);
    assertNotAck(log.getEvent(f.terminal.id)!);
  }
});

test('meaningful action results, questions, failures, evidence, retained work and review findings remain visible', () => {
  for (const mutation of ['failed', 'question', 'evidence', 'retained', 'outside-change', 'actual-action-reason', 'steps', 'review', 'artifact']) {
    const f = fixture();
    const data = structuredClone(f.terminal.data);
    const presentation = data.presentation as Record<string, unknown>;
    const outcome = data.turnOutcome as Record<string, unknown>;
    if (mutation === 'failed') {
      presentation.status = outcome.status = 'failed'; presentation.kind = 'error';
    }
    if (mutation === 'question') {
      presentation.status = outcome.status = 'needs_input'; presentation.kind = 'question';
      presentation.resumable = outcome.resumable = true;
      presentation.needs = outcome.needs = { kind: 'input' };
    }
    if (mutation === 'evidence') presentation.evidenceRefs = outcome.evidenceRefs = [{ kind: 'artifact', id: 'controlled-report' }];
    if (mutation === 'retained' || mutation === 'outside-change') {
      const text = 'The controlled result is ready.\n\nRetained work (durable checkpoint):\n'
        + (mutation === 'retained' ? '- 2 additional retained results.' : 'External write state: uncertain');
      presentation.text = data.reply = text;
    }
    if (mutation === 'actual-action-reason') data.reason = 'conversational_send_consent_resolved';
    if (mutation === 'steps') data.steps = 1;
    if (mutation === 'review') { data.review = 'rejected'; data.reviewNote = 'Controlled result needs another check.'; }
    if (mutation === 'artifact') data.artifactVerification = { status: 'verified', artifactId: 'controlled-report' };
    const retained = replaceData(f.terminal, data);
    assertNotAck(retained);
    const projected = projectHarnessEventForPublic(retained)!;
    assert.ok(typeof projected.data.reply === 'string' && projected.data.reply.length > 0, mutation);
    if (mutation === 'evidence') assert.deepEqual((projected.data.presentation as Record<string, unknown>).evidenceRefs,
      [{ kind: 'artifact', id: 'controlled-report' }]);
    if (mutation === 'retained') assert.equal((projected.data.retained as Record<string, unknown>)?.results, 2);
    if (mutation === 'outside-change') assert.equal((projected.data.retained as Record<string, unknown>)?.outsideChange, 'uncertain');
  }
});

test('metadata is not issued for an unretained input or a pending or differently resolved card', () => {
  const f = fixture();
  assert.deepEqual(approvalDecisionAckMetadata({ ...f.source, id: 'not-retained' }, f.card.approvalId, 'approve'), {});
  assert.deepEqual(approvalDecisionAckMetadata(f.source, f.card.approvalId, 'reject'), {});
  const pending = registry.register({ sessionId: f.session.id, subject: 'Other controlled change', tool: 'work_call', args: {} });
  assert.deepEqual(approvalDecisionAckMetadata(f.source, pending.approvalId, 'approve'), {});
});
