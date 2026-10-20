import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingActionPublicResult, pendingActionResultBinding, type PendingActionResultEvidence, type PendingActionResultRecord } from './pending-action-public-result.js';
import { normalizePendingActionResultBinding } from '../../shared/pending-action-result-binding.js';
import { presentationEventForOutcome, turnOutcomeId, type TurnOutcome } from './turn-outcome.js';

function fixture(status: 'executed' | 'failed' = 'executed', uncertain = false) {
  const action: PendingActionResultRecord = {
    id: 'pa-test', approvalId: 'apr-test', sessionId: 'sess-result-fixture', payloadHash: '0123456789abcdef',
    updatedAt: '2026-10-19T20:00:00.000Z', status, resultSummary: 'Raw executor evidence. stdout: fixture stderr: diagnostic',
  };
  const source: PendingActionResultEvidence['source'] = {
    id: 'source-B', seq: 2, sessionId: action.sessionId!, turn: 1, role: 'user', type: 'user_input_received',
    parentEventId: null, createdAt: action.updatedAt,
    data: { synthetic: true, source: 'approval_resume', approvalId: action.approvalId, decision: 'approve' },
  };
  const identity = { sessionId: source.sessionId, sourceUserSeq: source.seq, turn: source.turn };
  const text = status === 'executed' ? 'Done — I ran it.\n\nfixture output'
    : uncertain ? 'I cannot confirm what changed. Check before retrying.' : 'The action needs review. Do not retry it automatically.';
  const outcome: TurnOutcome = status === 'executed'
    ? { version: 2, id: turnOutcomeId(identity), identity, status: 'done', resumable: false, presentation: { kind: 'answer', text } }
    : uncertain
      ? { version: 2, id: turnOutcomeId(identity), identity, status: 'uncertain', resumable: true, presentation: { kind: 'blocked', text } }
      : { version: 2, id: turnOutcomeId(identity), identity, status: 'failed', resumable: false, presentation: { kind: 'error', text } };
  const evidence: PendingActionResultEvidence = {
    source,
    approval: { approvalId: action.approvalId!, sessionId: source.sessionId, args: { pendingActionId: action.id, pendingAction: { id: action.id, payloadHash: action.payloadHash } },
      status: 'resolved', resolution: 'approved', presentation: null },
    terminal: { ...source, seq: 3, id: 'terminal-B', role: 'system', type: 'conversation_completed', data: {
      sourceUserSeq: source.seq, terminalKey: turnOutcomeId(identity), turnOutcome: outcome,
      presentation: presentationEventForOutcome(outcome), pendingActionResultBinding: pendingActionResultBinding(action, source),
    } },
  };
  return { action, evidence, text };
}

test('only an exact record/card/hash/revision/raw-result bound B terminal supplies rich public text', () => {
  const { action, evidence, text } = fixture();
  const result = pendingActionPublicResult(action, () => evidence);
  assert.equal(result?.source, 'terminal');
  assert.equal(result?.text, text);
  assert.deepEqual(result?.terminal, { eventId: 'terminal-B', sourceUserSeq: 2 });
  assert.equal(action.resultSummary, 'Raw executor evidence. stdout: fixture stderr: diagnostic', 'the raw record is untouched');
  assert.doesNotMatch(result!.text, /Raw executor|stderr/);
});

test('failed and uncertain exact terminals keep their warnings and cannot become success from prose', () => {
  for (const uncertain of [false, true]) {
    const { action, evidence, text } = fixture('failed', uncertain);
    assert.equal(pendingActionPublicResult(action, () => evidence)?.text, text);
    const success = fixture();
    action.resultSummary = 'SUCCESS done completed';
    evidence.terminal = success.evidence.terminal;
    const result = pendingActionPublicResult(action, () => evidence);
    assert.equal(result?.status, 'failed');
    assert.equal(result?.source, 'record');
    assert.match(result!.text, /check what changed/i);
    assert.doesNotMatch(result!.text, /nothing ran|nothing changed|unsent/i);
  }
});

test('foreign action/card/payload/revision/digest and ordinary forged B metadata never supply public terminal text', () => {
  const changes: Array<(evidence: PendingActionResultEvidence) => void> = [
    e => { e.approval.args!.pendingActionId = 'pa-foreign'; },
    e => { e.approval.approvalId = 'apr-else'; },
    e => { e.approval.sessionId = 'sess-foreign'; },
    e => { e.approval.args!.pendingAction = { id: 'pa-test', payloadHash: 'fedcba9876543210' }; },
    e => { e.approval.args!.pending_action_id = 'pa-foreign'; },
    e => { e.source.data.synthetic = false; },
    e => { e.source.data.source = 'ordinary_chat'; },
    e => { e.source.data.decision = 'reject'; },
    e => { e.source.data.approvalId = 'apr-else'; },
    e => { e.terminal.sessionId = 'sess-foreign'; },
    e => { e.terminal.turn += 1; },
    e => { (e.terminal.data.pendingActionResultBinding as Record<string, unknown>).sourceUserSeq = 1; },
    e => { (e.terminal.data.pendingActionResultBinding as Record<string, unknown>).payloadHash = 'fedcba9876543210'; },
    e => { (e.terminal.data.pendingActionResultBinding as Record<string, unknown>).recordUpdatedAt = '2026-10-19T19:00:00.000Z'; },
    e => { (e.terminal.data.pendingActionResultBinding as Record<string, unknown>).resultSummaryDigest = 'f'.repeat(64); },
    e => { delete e.terminal.data.turnOutcome; },
    e => { e.terminal.data.pendingActionResultBinding = null; },
    e => { (e.terminal.data.presentation as { identity: { sourceUserSeq: number } }).identity.sourceUserSeq = 99; },
  ];
  for (const change of changes) {
    const { action, evidence } = fixture();
    change(evidence);
    assert.equal(pendingActionPublicResult(action, () => evidence)?.source, 'record', change.toString());
  }
});

test('legacy, missing, unreadable and pre-terminal evidence use typed status without parsing raw summaries', () => {
  const { action, evidence } = fixture();
  delete evidence.terminal.data.pendingActionResultBinding;
  for (const read of [() => null, () => evidence, () => { throw new Error('unreadable'); }]) {
    const result = pendingActionPublicResult(action, read);
    assert.equal(result?.source, 'record');
    assert.equal(result?.status, 'executed');
    assert.doesNotMatch(result!.text, /stdout|stderr|executor/);
  }
  for (const status of ['executing', 'rejected', 'expired', 'cancelled'] as const) {
    assert.equal(pendingActionPublicResult({ ...action, status }, () => assert.fail('no terminal query for this status'))?.status, status);
  }
  assert.equal(pendingActionPublicResult({ ...action, status: 'approved' }, () => assert.fail('no query while queued')), null);
});

test('result binding has a closed bounded shape, and exact raw whitespace affects its digest', () => {
  const { action, evidence } = fixture();
  const binding = pendingActionResultBinding(action, evidence.source)!;
  assert.ok(normalizePendingActionResultBinding(binding));
  for (const invalid of [null, [], { ...binding, extra: true }, { ...binding, sourceUserSeq: 0 },
    { ...binding, recordStatus: { toString: () => 'executed' } }, { ...binding, payloadHash: 'a'.repeat(64) },
    { ...binding, resultSummaryDigest: 'a'.repeat(16) }, { ...binding, recordUpdatedAt: 'yesterday' },
    { ...binding, approvalId: 'approve anything' }]) assert.equal(normalizePendingActionResultBinding(invalid), null);
  assert.notEqual(binding.resultSummaryDigest, pendingActionResultBinding({ ...action, resultSummary: `${action.resultSummary} ` }, evidence.source)?.resultSummaryDigest);
});

test('production reader proves canonical B from real host execution and refuses duplicate sources, foreign pointers and missing authority', async () => {
  const events = await import('./eventlog.js');
  const registry = await import('./approval-registry.js');
  const actions = await import('./pending-actions.js');
  const resume = await import('./chat-approval-resume.js');
  const executor = await import('../../execution/pending-action-executor.js');
  const { pendingActionApprovalView } = await import('./pending-action-view.js');
  const { readPendingActionPublicResult } = await import('./pending-action-result-reader.js');
  const { loadAcceptedTaskAuthority } = await import('./accepted-task-authority.js');
  resume._resetChatApprovalResumeForTest();
  let dispatches = 0;
  executor._setApprovedCallDispatchForTests(async () => { dispatches += 1; throw new Error('Controlled unavailable result after dispatch.'); });
  const session = events.createSession({ kind: 'chat', channel: 'desktop' });
  async function executeControlled(index: number) {
    const action = actions.queuePendingAction({ title: `Controlled result ${index}`, summary: 'Named no-provider fixture.',
      kind: 'shell_command', toolName: 'run_shell_command', payload: { command: `echo controlled-result-${index}`, cwd: '/tmp' }, sessionId: session.id });
    const row = registry.register({ sessionId: session.id, subject: action.title, tool: 'request_approval',
      args: { pendingActionId: action.id, pendingAction: pendingActionApprovalView(action) } });
    const resolved = registry.resolve(row.approvalId, 'approved', 'desktop-chat-card').row!;
    assert.equal(await resume.handleResolvedApprovalForChatResume(resolved, async () => assert.fail('no model resumes an exact action')), true);
    const settled = actions.getPendingAction(action.id)!;
    assert.equal(settled.status, 'failed');
    const source = events.listEvents(session.id, { types: ['user_input_received'] }).find(event => event.data.approvalId === row.approvalId)!;
    const authority = loadAcceptedTaskAuthority(session.id, source.seq);
    assert.equal(authority.status, 'ok');
    if (authority.status !== 'ok') assert.fail('the real host source must have canonical authority');
    assert.ok(authority.authority.terminalEventId, 'non-done publication owns its exact terminal pointer');
    return { settled, source, terminalId: authority.authority.terminalEventId! };
  }
  try {
    const first = await executeControlled(1);
    const second = await executeControlled(2);
    const initial = readPendingActionPublicResult(first.settled)!;
    assert.equal(initial.source, 'terminal');
    assert.equal(initial.terminal?.eventId, first.terminalId);
    assert.equal(initial.terminal?.sourceUserSeq, first.source.seq);
    assert.match(initial.text, /can't tell|uncertain|can't fully prove/i);
    const db = events.openEventLog();
    db.prepare('UPDATE accepted_task_authority SET terminal_event_id = ? WHERE session_id = ? AND source_user_seq = ?')
      .run(second.terminalId, session.id, first.source.seq);
    assert.equal(readPendingActionPublicResult(first.settled)?.source, 'record', 'a real foreign canonical terminal cannot be borrowed');
    db.prepare('UPDATE accepted_task_authority SET terminal_event_id = ? WHERE session_id = ? AND source_user_seq = ?')
      .run(first.terminalId, session.id, first.source.seq);
    assert.equal(readPendingActionPublicResult(first.settled)?.source, 'terminal');
    const duplicate = events.appendEvent({ sessionId: session.id, turn: 99, role: 'user', type: 'user_input_received',
      data: { text: 'Unrelated controlled fixture.', approvalId: first.settled.approvalId, decision: 'approve' } });
    assert.equal(readPendingActionPublicResult(first.settled)?.source, 'record', 'two B candidates cannot select a convenient terminal');
    db.prepare('DELETE FROM events WHERE id = ? AND session_id = ?').run(duplicate.id, session.id);
    assert.equal(readPendingActionPublicResult(first.settled)?.source, 'terminal');
    // A separate legacy/unarmed source has no canonical authority to borrow.
    // Do not delete a real host's immutable completion evidence to manufacture
    // this negative case: even well-shaped terminal text alone proves nothing.
    const legacySession = events.createSession({ kind: 'chat', channel: 'desktop' });
    const legacyAction = actions.queuePendingAction({ title: 'Controlled legacy result', summary: 'No-dispatch missing-authority fixture.',
      kind: 'shell_command', toolName: 'run_shell_command', payload: { command: 'echo never-dispatched', cwd: '/tmp' }, sessionId: legacySession.id });
    const legacyCard = registry.register({ sessionId: legacySession.id, subject: legacyAction.title, tool: 'request_approval',
      args: { pendingActionId: legacyAction.id, pendingAction: pendingActionApprovalView(legacyAction) } });
    registry.resolve(legacyCard.approvalId, 'approved', 'desktop-chat-card');
    const claim = actions.claimPendingActionExecution(legacyAction.id, 'legacy-fixture', {
      expectedSessionId: legacySession.id, requireResolvedHumanCard: true,
    });
    assert.equal(claim.claimed, true);
    assert.ok(claim.claimToken);
    const legacySettled = actions.recordPendingActionResult(legacyAction.id, 'failed', 'Unproved legacy failure summary.',
      'legacy-fixture', claim.claimToken)!;
    assert.equal(legacySettled.status, 'failed');
    const legacySource = events.appendEvent({ sessionId: legacySession.id, turn: 1, role: 'user', type: 'user_input_received',
      data: { synthetic: true, source: 'approval_resume', approvalId: legacyCard.approvalId, decision: 'approve' } });
    const identity = { sessionId: legacySession.id, sourceUserSeq: legacySource.seq, turn: legacySource.turn };
    const legacyOutcome: TurnOutcome = { version: 2, id: turnOutcomeId(identity), identity, status: 'failed', resumable: false,
      presentation: { kind: 'error', text: 'This shaped legacy answer has no canonical authority.' } };
    db.prepare(`INSERT INTO events (id,session_id,turn,role,type,data_json,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(`legacy-unarmed-${legacyAction.id}`, legacySession.id, legacySource.turn, 'system', 'conversation_completed', JSON.stringify({
        sourceUserSeq: legacySource.seq, terminalKey: turnOutcomeId(identity), turnOutcome: legacyOutcome,
        presentation: presentationEventForOutcome(legacyOutcome), pendingActionResultBinding: pendingActionResultBinding(legacySettled, legacySource),
      }), new Date().toISOString());
    assert.equal(loadAcceptedTaskAuthority(legacySession.id, legacySource.seq).status, 'legacy');
    assert.equal(readPendingActionPublicResult(legacySettled)?.source, 'record', 'missing authority is not display authority');
    assert.equal(readPendingActionPublicResult(first.settled)?.source, 'terminal', 'the real host evidence stays intact');
    assert.equal(dispatches, 2, 'all projection reads leave the exact dispatch count unchanged');
  } finally {
    executor._setApprovedCallDispatchForTests(null);
    resume._resetChatApprovalResumeForTest();
  }
});
