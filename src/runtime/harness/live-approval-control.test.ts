import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-paused-card-control-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(home, 'state'), { recursive: true });
const log = await import('./eventlog.js');
const registry = await import('./approval-registry.js');
const { commitLiveApprovalControl } = await import('./live-approval-control.js');
const { isLiveApprovalAcknowledgement } = await import('./accepted-source-kind.js');
const { approvalConfirmationAlreadyAsked } = await import('./approval-reply-routing.js');
const { turnOutcomeId } = await import('./turn-outcome.js');
const { commitTurnOutcome } = await import('./delivery-committer.js');
const { projectHarnessEventForPublic, projectHarnessEventsForPublic } = await import('./public-presentation.js');

test.after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });
let serial = 0;
function cardFixture(existingSession?: import('./eventlog.js').SessionRow) {
  serial++;
  const session = existingSession ?? log.createSession({ id: `paused-card-${serial}`, kind: 'chat' });
  const attempt = log.beginRunAttempt(session.id, { runId: `original-${serial}` });
  const source = log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: 'Prepare a controlled local change.' } });
  const args = { name: 'fixture_write', args_json: '{"value":"pinned","account":"fixture-account"}' };
  const row = registry.register({ sessionId: session.id, subject: 'Controlled change', tool: 'work_call', args });
  const carrier = log.appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'approval_requested',
    data: { approvalId: row.approvalId, tool: row.tool, args, sourceUserSeq: source.seq } });
  log.finishRunAttempt(attempt, 'interrupted');
  return { session, attempt, source, row, carrier };
}

function inquire(cards: ReturnType<typeof cardFixture>[], requestId: string, tryDecision = false) {
  const sessionId = cards[0]!.session.id;
  return commitLiveApprovalControl({ sessionId, requestId, runId: `control-${requestId}`, inputHash: 'fixture-inquiry-hash',
    text: 'Yes.', prepare: () => ({ inquiryCardIds: cards.map(card => card.row.approvalId), commit: (source, resolveDecision) => {
      if (tryDecision) resolveDecision(cards[0]!.row.approvalId, 'approved', 'fixture');
      log.appendEvent({ sessionId, turn: source.turn, role: 'Clem', type: 'awaiting_user_input',
        data: { sourceUserSeq: source.seq, reason: 'approval_choice_required', approvalIds: cards.map(card => card.row.approvalId),
          question: 'Which exact card do you mean?' } });
      const identity = { sessionId, turn: source.turn, sourceUserSeq: source.seq };
      commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'needs_input', resumable: true,
        needs: { kind: 'input' }, presentation: { kind: 'question', text: 'Which exact card do you mean?' } });
    } }) });
}

test('multi-card inquiry binds every independent source and one replayed terminal without selecting an owner or releasing a card', async () => {
  const first = cardFixture();
  const second = cardFixture(first.session);
  const results = await Promise.all([1, 2].map(() => Promise.resolve().then(() => inquire([first, second], 'inquiry-concurrent'))));
  const result = results[0]!;
  assert.ok(result);
  assert.equal(results[1]?.source.seq, result.source.seq);
  assert.equal(results[1]?.replayed, true);
  assert.equal(result.source.parentEventId, null);
  const marker = result.source.data.liveApprovalControl as { mode: string; cards: unknown[]; ownerAttemptId?: string };
  assert.equal(marker.mode, 'card_inquiry');
  assert.equal(marker.ownerAttemptId, undefined);
  assert.deepEqual(marker.cards, [first, second].sort((a, b) => a.row.approvalId.localeCompare(b.row.approvalId)).map(f => ({
    approvalId: f.row.approvalId, ownerAttemptId: f.attempt.attemptId, ownerSourceUserSeq: f.source.seq,
  })));
  assert.equal(isLiveApprovalAcknowledgement(result.source), true);
  assert.deepEqual(projectHarnessEventForPublic(result.source)?.data, { text: 'Yes.' });
  assert.equal(log.getActiveRunAttempt(first.session.id), null);
  assert.equal(log.getLatestRunAttemptByRunId(first.session.id, result.receipt.runId), null);
  assert.equal(log.listEvents(first.session.id, { types: ['conversation_completed'] }).length, 1);
  assert.equal(projectHarnessEventForPublic(log.listEvents(first.session.id, { types: ['conversation_completed'] })[0]!)?.data.liveApprovalControl, undefined);
  assert.equal(registry.get(first.row.approvalId)?.status, 'pending');
  assert.equal(registry.get(second.row.approvalId)?.status, 'pending');
  log.closeEventLog();
  registry.resolve(first.row.approvalId, 'rejected', 'later-exact-choice');
  assert.equal(inquire([first, second], 'inquiry-concurrent')?.replayed, true, 'later card settlement does not re-run an accepted inquiry');
  const replay = projectHarnessEventsForPublic(log.listEvents(first.session.id));
  assert.equal(replay.filter(event => event.seq === result.source.seq).length, 1, 'the accepted owner reply survives replay');
  assert.equal(replay.filter(event => event.type === 'conversation_completed' && event.data.sourceUserSeq === result.source.seq).length, 1);
  assert.equal(replay.find(event => event.seq === result.source.seq)?.data.liveApprovalControl, undefined);
});

test('an inquiry refuses stale, foreign, incomplete binding and decision callbacks before accepting a request', () => {
  for (const mutation of ['resolved', 'set_changed', 'foreign', 'missing_binding', 'decision'] as const) {
    const first = cardFixture();
    const second = cardFixture(first.session);
    const cards = [first, second];
    if (mutation === 'resolved') registry.resolve(second.row.approvalId, 'rejected', 'fixture-owner');
    if (mutation === 'set_changed') cardFixture(first.session);
    if (mutation === 'foreign') cards[1] = cardFixture();
    if (mutation === 'missing_binding') log.openEventLog().prepare('DELETE FROM events WHERE seq=?').run(second.carrier.seq);
    assert.throws(() => inquire(cards, `refused-inquiry-${serial}`, mutation === 'decision'), /cards changed|cannot resolve a decision/i, mutation);
    assert.equal(log.getHarnessChatRequestReceipt(`refused-inquiry-${serial}`), null, mutation);
    assert.equal(log.listEvents(first.session.id, { types: ['conversation_completed'] }).length, 0, mutation);
    assert.equal(registry.get(first.row.approvalId)?.status, 'pending', mutation);
    assert.equal(log.getActiveRunAttempt(first.session.id), null, mutation);
  }
});
function confirm(f: ReturnType<typeof cardFixture>, requestId = `confirm-${serial}`) {
  return commitLiveApprovalControl({ sessionId: f.session.id, requestId, runId: `control-${requestId}`,
    inputHash: 'fixture-confirm-hash', text: 'Yes, do that.', prepare: () => {
      if (approvalConfirmationAlreadyAsked(f.session.id, f.row.approvalId)) return null;
      return { pausedCardId: f.row.approvalId, sourceData: { approvalId: f.row.approvalId, confirm: 'unread' }, commit: (source) => {
        log.appendEvent({ sessionId: f.session.id, turn: source.turn, role: 'Clem', type: 'awaiting_user_input',
          data: { sourceUserSeq: source.seq, approvalId: f.row.approvalId, reason: 'approval_confirmation_required',
            question: 'Should I do the controlled change?', leaning: 'unread', replyText: 'Yes, do that.' } });
        const identity = { sessionId: source.sessionId, turn: source.turn, sourceUserSeq: source.seq };
        commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'needs_input', resumable: true,
          needs: { kind: 'input' }, presentation: { kind: 'question', text: 'Should I do the controlled change?' } },
        { metadata: { liveApprovalControl: source.data.liveApprovalControl } });
      } };
    } });
}

test('a paused exact card accepts one source-bound confirmation without acquiring an execution lease, including reopen/replay', () => {
  const f = cardFixture();
  const result = confirm(f);
  assert.ok(result);
  assert.equal(result.source.parentEventId, f.source.id);
  assert.deepEqual(result.source.data.liveApprovalControl, { version: 1, mode: 'paused_card', approvalId: f.row.approvalId,
    ownerAttemptId: f.attempt.attemptId, ownerSourceUserSeq: f.source.seq });
  assert.equal(isLiveApprovalAcknowledgement(result.source), true);
  assert.deepEqual(projectHarnessEventForPublic(result.source)?.data, { text: 'Yes, do that.' });
  assert.equal(log.getActiveRunAttempt(f.session.id), null);
  assert.equal(log.getLatestRunAttemptByRunId(f.session.id, result.receipt.runId), null);
  assert.equal(registry.get(f.row.approvalId)?.status, 'pending');
  assert.deepEqual(registry.get(f.row.approvalId)?.args, f.row.args);
  const terminal = log.listEvents(f.session.id, { types: ['conversation_completed'] })[0]!;
  assert.equal(projectHarnessEventForPublic(terminal)?.data.liveApprovalControl, undefined,
    'historical identity must not be published as a live executor');
  assert.equal(projectHarnessEventForPublic(terminal)?.data.sourceUserSeq, result.source.seq);
  log.closeEventLog();
  const replay = confirm(f);
  assert.equal(replay?.replayed, true);
  assert.equal(replay?.source.seq, result.source.seq);
  assert.equal(confirm(f, 'distinct-later-reply'), null, 'the exact card has only one confirmation allowance');
  assert.equal(log.listEvents(f.session.id, { types: ['conversation_completed'] }).length, 1);
  const publicReplay = projectHarnessEventsForPublic(log.listEvents(f.session.id));
  assert.equal(publicReplay.filter(event => event.seq === result.source.seq).length, 1);
  assert.equal(publicReplay.find(event => event.seq === terminal.seq)?.data.sourceUserSeq, result.source.seq);
});

test('paused ownership fails closed for missing, malformed, conflicting, changed operation or resolved card evidence', () => {
  for (const mutation of ['missing', 'malformed', 'conflicting', 'changed_args', 'resolved'] as const) {
    const f = cardFixture();
    if (mutation === 'missing') log.openEventLog().prepare('DELETE FROM events WHERE seq=?').run(f.carrier.seq);
    if (mutation === 'malformed') log.openEventLog().prepare("UPDATE events SET data_json=json_remove(data_json,'$.sourceUserSeq') WHERE seq=?").run(f.carrier.seq);
    if (mutation === 'conflicting') {
      const other = log.appendEvent({ sessionId: f.session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Unrelated request.' } });
      log.appendEvent({ sessionId: f.session.id, turn: 2, role: 'Clem', type: 'approval_requested', data: { ...f.carrier.data, sourceUserSeq: other.seq } });
    }
    if (mutation === 'changed_args') log.openEventLog().prepare("UPDATE pending_approvals SET args_json=? WHERE approval_id=?")
      .run(JSON.stringify({ ...f.row.args, args_json: '{"value":"different","account":"other-account"}' }), f.row.approvalId);
    if (mutation === 'resolved') registry.resolve(f.row.approvalId, 'rejected', 'fixture-owner');
    assert.equal(confirm(f), null, mutation);
    assert.equal(log.getHarnessChatRequestReceipt(`confirm-${serial}`), null, mutation);
    assert.equal(log.listEvents(f.session.id, { types: ['conversation_completed'] }).length, 0, mutation);
    assert.equal(log.getActiveRunAttempt(f.session.id), null, mutation);
  }
});

test('the actual public confirmation projection binds the exact accepted reply and historical card, including resolved-card replay', () => {
  const f = cardFixture();
  const result = confirm(f)!;
  const question = log.listEvents(f.session.id, { types: ['awaiting_user_input'] })[0]!;
  const projected = projectHarnessEventForPublic({ ...question,
    data: { ...question.data, ownerAttemptId: 'PRIVATE OWNER', args: { account: 'PRIVATE ACCOUNT' } } })!;
  assert.deepEqual(projected.data, { question: 'Should I do the controlled change?', options: [], approvalId: f.row.approvalId,
    reason: 'approval_confirmation_required', sourceUserSeq: result.source.seq, leaning: 'unread', replyText: 'Yes, do that.' });
  assert.equal(projected.parentEventId, null);
  for (const patch of [
    { sourceUserSeq: f.source.seq }, { sourceUserSeq: question.seq }, { sourceUserSeq: -1 },
    { approvalId: 'apr-foreign' }, { leaning: 'future' }, { leaning: 'approves' }, { replyText: 'Unrecorded words.' },
  ]) assert.equal(projectHarnessEventForPublic({ ...question, data: { ...question.data, ...patch } })?.data.reason, undefined);
  assert.equal(projectHarnessEventForPublic({ ...question, role: 'system' })?.data.reason, undefined);
  const ordinary = projectHarnessEventForPublic({ ...question, data: { ...question.data, reason: 'approval_choice_required' } })!;
  assert.equal(ordinary.data.reason, undefined, 'inquiry stays an ordinary question');
  assert.equal(ordinary.data.replyText, undefined);
  registry.resolve(f.row.approvalId, 'rejected', 'later-card-answer');
  log.closeEventLog();
  const replay = projectHarnessEventsForPublic(log.listEvents(f.session.id));
  assert.equal(replay.find(row => row.seq === question.seq)?.data.reason, 'approval_confirmation_required');
  assert.equal(replay.filter(row => row.type === 'conversation_completed' && row.data.sourceUserSeq === result.source.seq).length, 1);
  for (const mutation of ['owner', 'parent', 'carrier', 'source_card', 'source_leaning'] as const) {
    const fixture = cardFixture();
    const accepted = confirm(fixture)!;
    const asked = log.listEvents(fixture.session.id, { types: ['awaiting_user_input'] })[0]!;
    const db = log.openEventLog();
    if (mutation === 'owner') db.prepare("UPDATE events SET data_json=json_set(data_json,'$.liveApprovalControl.ownerAttemptId','unknown-owner') WHERE seq=?").run(accepted.source.seq);
    if (mutation === 'parent') db.prepare('UPDATE events SET parent_event_id=? WHERE seq=?').run('unknown-parent', accepted.source.seq);
    if (mutation === 'carrier') db.prepare('DELETE FROM events WHERE seq=?').run(fixture.carrier.seq);
    if (mutation === 'source_card') db.prepare("UPDATE events SET data_json=json_set(data_json,'$.approvalId','apr-foreign') WHERE seq=?").run(accepted.source.seq);
    if (mutation === 'source_leaning') db.prepare("UPDATE events SET data_json=json_set(data_json,'$.confirm','approves') WHERE seq=?").run(accepted.source.seq);
    assert.equal(projectHarnessEventForPublic(asked)?.data.reason, undefined, mutation);
  }
});

test('unknown control modes are not acknowledgements and an unrelated active owner is not replaced', () => {
  const f = cardFixture();
  const unrelated = log.beginRunAttempt(f.session.id, { runId: 'unrelated-active' });
  const unrelatedSource = log.recordRunAttemptUserInput(unrelated, { turn: 2, role: 'user', data: { text: 'Unrelated work.' } });
  const result = confirm(f)!;
  assert.equal(log.getActiveRunAttempt(f.session.id)?.attemptId, unrelated.attemptId);
  assert.equal(log.getRunAttemptSourceUserEvent(unrelated)?.seq, unrelatedSource.seq);
  assert.equal(result.source.parentEventId, f.source.id);
  assert.equal(isLiveApprovalAcknowledgement({ ...result.source, data: { ...result.source.data,
    liveApprovalControl: { ...(result.source.data.liveApprovalControl as object), mode: 'unrecognized' } } }), false);
  assert.equal(projectHarnessEventForPublic({ ...result.source, data: { ...result.source.data,
    liveApprovalControl: { ...(result.source.data.liveApprovalControl as object), mode: 'unrecognized' } } }), null);
  assert.equal(projectHarnessEventForPublic({ ...result.source, data: { synthetic: true, text: 'Hidden internal input.' } }), null);
});
