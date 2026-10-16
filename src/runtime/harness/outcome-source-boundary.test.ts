/** Real private-store controls: settled reports do not end a human task's
 * steering, review, evidence or artifact interval. No model or provider calls. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-outcome-source-boundary-'));
process.env.CLEMENTINE_HOME = home;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const log = await import('./eventlog.js');
const steering = await import('./steer-notes.js');
const sourceKind = await import('./accepted-source-kind.js');
const publicPresentation = await import('./public-presentation.js');
const transcript = await import('./transcript.js');
const leases = await import('./dispatch-lease.js');
const authority = await import('./accepted-turn-call-authority.js');
const brackets = await import('./brackets.js');
const { reviewWithOwnerSteering } = await import('./completion-review-steering.js');
const { deliverOutcomeWithAcknowledgement } = await import('../outcome.js');
const { auditAcceptedSourceSettlementTruth } = await import('./accepted-source-settlement-audit.js');
const { prepareAcceptedTaskTerminal } = await import('./accepted-task-terminal-preparation.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const { activateActionExpectedWork } = await import('./expected-work-admission.js');
const artifacts = await import('./artifact-ledger.js');

after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
let serial = 0;
function foreground(text = 'Report the supplied foreground fixture status.') {
  const session = log.createSession({ id: `sess-outcome-boundary-${++serial}`, kind: 'chat', channel: 'desktop' });
  const attempt = log.beginRunAttempt(session.id, { runId: `boundary:${serial}` });
  const source = log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text } }, { armRunInFlight: true });
  return { session, attempt, source, sessionId: session.id, sourceUserSeq: source.seq };
}
function report(f: ReturnType<typeof foreground>) {
  const detail = `The independent background fixture ${serial} is ready.`;
  assert.equal(deliverOutcomeWithAcknowledgement({ status: 'done', detail }, {
    originSessionId: f.sessionId, sourceLabel: 'background fixture', sourceId: `result:${serial}`, proactiveTurn: true,
  }).acknowledged, true);
  const sources = log.listEvents(f.sessionId, { types: ['user_input_received'] }).filter(sourceKind.isBackgroundOutcomeSource);
  assert.equal(sources.length, 2, 'actual delivery retains its passive and public report sources');
  assert.ok(sources.every(source => !sourceKind.isExecutionSourceBoundary(source)));
  return detail;
}
function arm(f: ReturnType<typeof foreground>) {
  assert.equal(authority.armHostReadOnlyCallAuthority({ sessionId: f.sessionId, sourceUserSeq: f.sourceUserSeq,
    surfaceVersion: 'configured_harness_tools_v1', catalogRevisionDigest: digest('boundary-catalog'),
    bindingRevisionDigest: digest('boundary-binding'), maxLogicalCalls: 4, maxParallelCalls: 2 }).status, 'armed');
  const lease = leases.activateDispatchLease({ sessionId: f.sessionId, scopeId: `${f.sessionId}:host`, runAttemptId: f.attempt.attemptId });
  const owner = { sessionId: f.sessionId, sourceUserSeq: f.sourceUserSeq, attemptId: f.attempt.attemptId, lease };
  return { owner, context: { sessionId: f.sessionId, sourceUserSeq: f.sourceUserSeq,
    runAttemptId: f.attempt.attemptId, dispatchLease: lease, counter: new brackets.ToolCallsCounter(4) } };
}

test('an actual background report preserves adopted steering and its exact public receipt on reopen', () => {
  const f = foreground();
  const backgroundText = report(f);
  const note = steering.appendSteerNote(f.sessionId, 'Use the updated supplied status.', { expectedAttemptId: f.attempt.attemptId });
  assert.equal(steering.hasUndeliveredSteerNotes(f.sessionId, f.sourceUserSeq), true);
  assert.deepEqual(steering.takeUndeliveredSteerNotes(f.sessionId, f.sourceUserSeq, true).map(row => row.seq), [note.seq]);
  assert.deepEqual(steering.adoptedSteerNotesForSource(f).map(row => row.seq), [note.seq]);
  const receipts = publicPresentation.publicSteerReceiptsForSource(f.sessionId, f.sourceUserSeq);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.sourceUserSeq, f.sourceUserSeq);
  assert.equal(receipts[0]!.state, 'adopted');
  const reopened = transcript.reconstructHarnessTranscript(f.sessionId);
  assert.equal(reopened.find(turn => turn.steerNoteSeq === note.seq)?.steerReceipt?.sourceUserSeq, f.sourceUserSeq);
  assert.ok(reopened.some(turn => turn.role === 'assistant' && turn.text === backgroundText), 'the separate report remains visible');

  const next = log.appendEvent({ sessionId: f.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'A separate new request.' } });
  assert.equal(sourceKind.isExecutionSourceBoundary(next), true);
  const later = log.appendEvent({ sessionId: f.sessionId, turn: 2, role: 'user', type: 'user_steer_note', data: { text: 'Only for the new request.' } });
  assert.equal(steering.hasUndeliveredSteerNotes(f.sessionId, f.sourceUserSeq), false);
  assert.deepEqual(steering.takeUndeliveredSteerNotes(f.sessionId, f.sourceUserSeq, true), []);
  assert.deepEqual(steering.adoptedSteerNotesForSource(f).map(row => row.seq), [note.seq]);
  assert.equal(publicPresentation.publicSteerReceiptsForSource(f.sessionId, f.sourceUserSeq).some(row => row.noteSeq === later.seq), false);
});

test('a background report cannot hide a new foreground note from the completion review fence', async () => {
  const f = foreground();
  const { owner, context } = arm(f);
  report(f);
  const note = steering.appendSteerNote(f.sessionId, 'Use the amended premise before finishing.', { expectedAttemptId: f.attempt.attemptId });
  let reviews = 0;
  const result = await brackets.withHarnessRunContext(context,
    () => reviewWithOwnerSteering(owner, async () => { reviews++; return 'obsolete candidate'; }));
  assert.deepEqual(result, { status: 'superseded' });
  assert.equal(reviews, 0, 'the stale review is never started');
  assert.equal(leases.isDispatchLeaseCurrent(owner.lease), true);
  assert.deepEqual(steering.takeUndeliveredSteerNotes(f.sessionId, f.sourceUserSeq, true).map(row => row.seq), [note.seq]);
});

for (const cut of ['background_only', 'new_human', 'malformed_outcome'] as const) {
  test(`completion evidence keeps its human boundary after report delivery: ${cut}`, () => {
    const f = foreground('Create a daily digest workflow.');
    assert.ok(recordTurnGraphShadow({ identity: { sessionId: f.sessionId, sourceUserSeq: f.sourceUserSeq, turn: 1 } }));
    assert.ok(['activated', 'replayed'].includes(activateActionExpectedWork(f).status));
    report(f);
    if (cut !== 'background_only') {
      const boundary = log.appendEvent({ sessionId: f.sessionId, turn: 2, role: 'user', type: 'user_input_received',
        data: cut === 'new_human' ? { text: 'A different new task.' }
          : { text: 'Unproven synthetic input.', synthetic: true, source: 'outcome', deliveryPhase: 'report', sourceLabel: 'missing identity' } });
      assert.equal(sourceKind.isExecutionSourceBoundary(boundary), true, 'a malformed lookalike cannot suppress a boundary');
    }
    const callId = `canonical:workflow-create:${serial}`;
    const called = log.appendEvent({ sessionId: f.sessionId, turn: 1, role: 'Clem', type: 'tool_called',
      data: { sourceUserSeq: f.sourceUserSeq, tool: 'workflow_create', callId, canonicalCallId: callId, accounting: 'top_level', topologyRole: 'control' } });
    log.appendEvent({ sessionId: f.sessionId, turn: 1, role: 'tool', type: 'tool_returned', parentEventId: called.id,
      data: { sourceUserSeq: f.sourceUserSeq, tool: 'workflow_create', callId, canonicalCallId: callId,
        accounting: 'top_level', ok: true, successfulAuthoringResult: true } });
    const audit = auditAcceptedSourceSettlementTruth(f);
    assert.equal(audit.facts.successfulSdkAuthoringResults, cut === 'background_only' ? 1 : 0, JSON.stringify(audit));
    const prepared = prepareAcceptedTaskTerminal(f);
    assert.equal(prepared.status, cut === 'background_only' ? 'ready' : 'needs_verification', JSON.stringify(prepared));
  });
}

test('background sources and their terminals do not split artifact continuation or invent a new source root', () => {
  const f = foreground('Create the requested report.');
  const root = artifacts.resolveArtifactRunScopeId(f.sessionId, 'original-report', f.sourceUserSeq);
  log.appendEvent({ sessionId: f.sessionId, turn: 1, role: 'system', type: 'conversation_completed',
    data: { sourceUserSeq: f.sourceUserSeq, reason: 'awaiting_user_input', artifactRunScopeId: root } });
  report(f);
  assert.equal(artifacts.resolveArtifactRunScopeId(f.sessionId, 'same-source-fallback'), root);
  assert.equal(artifacts.getArtifactRunScope(f.sessionId, 'same-source-fallback')?.sourceUserSeq, f.sourceUserSeq);
  const answer = log.appendEvent({ sessionId: f.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Cover the production accounts.' } });
  assert.equal(artifacts.resolveArtifactRunScopeId(f.sessionId, 'answered-report', answer.seq), root);
  assert.equal(artifacts.getArtifactRunScope(f.sessionId, 'answered-report')?.reason, 'awaiting_user_input_reply');
  const next = log.appendEvent({ sessionId: f.sessionId, turn: 3, role: 'user', type: 'user_input_received', data: { text: 'Create a separate unrelated report.' } });
  assert.equal(artifacts.resolveArtifactRunScopeId(f.sessionId, 'separate-report', next.seq), 'separate-report');
});
