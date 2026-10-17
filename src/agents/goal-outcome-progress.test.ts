import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { GoalRecord } from '../memory/goals-list.js';
import type { NoticingProposalRecord } from './noticing.js';
import type { NoticingApprovedTaskPacket } from '../runtime/harness/noticing-approved-task.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-goal-outcome-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const progress = await import('./goal-outcome-progress.js');
const log = await import('../runtime/harness/eventlog.js');
const approved = await import('../runtime/harness/noticing-approved-task.js');
const origins = await import('../execution/workflow-origin-group.js');
const plans = await import('./plan-proposals.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const definitions = await import('../execution/workflow-run-definition.js');
const artifacts = await import('../execution/workflow-run-workspace.js');
const events = await import('../execution/workflow-events.js');
const targets = await import('../execution/workflow-target-evidence.js');
const { upsertGoalRecord } = await import('../memory/goals-list.js');
let sequence = 0;
test.after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

function accepted() {
  const id = `goal-projection-${++sequence}`;
  const saved = upsertGoalRecord({ title: `Controlled business goal ${id}`,
    description: 'Produce the fixture result while keeping the account, scope and no-send rule.',
    nextActions: ['Save the controlled result'], blockers: ['External deployment is not accepted'] });
  assert.ok(saved.ok);
  const goal: GoalRecord = saved.goal;
  const packet: NoticingApprovedTaskPacket = { version: 1,
    proposal: { id, checkInId: `check-${id}`, title: 'Prepare the controlled result',
      action: 'Run the named controlled workflow and retain its result. Do not send anything.',
      why: 'A useful next step toward the saved business goal.', evidence: ['fixture source only'],
      goalId: goal.id, createdAt: '2026-10-17T00:00:00Z' },
    checkIn: { id: `check-${id}`, question: 'Prepare the result?', answer: 'Yes; keep my current account and do not send.',
      answeredAt: '2026-10-17T00:01:00Z' }, decision: { kind: 'do_it' },
    constraints: { rules: ['No provider substitution or sends.'], standingAnswers: [] }, goal: { ...goal } };
  const digest = approved.noticingApprovedTaskDigest(packet);
  const sessionId = `sess-${id}`;
  const requestId = `request-${id}`;
  const runId = `accepted-${id}`;
  log.createSession({ id: sessionId, kind: 'chat', channel: 'desktop' });
  const source = log.withEventPublicationTransaction(() => {
    log.claimHarnessChatRequestInTransaction(log.openEventLog(), { requestId, runId, sessionId, sinceSeq: 0, inputHash: digest });
    return log.acceptUserInputForRun({ sessionId, turn: 1, role: 'user', data: {
      text: packet.checkIn.answer, displayText: packet.checkIn.answer, runId, source: 'noticing_answer',
      noticingApprovedTask: { requestId, digest, packet },
    } });
  });
  const attempt = log.beginRunAttempt(sessionId, { runId });
  log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: packet.checkIn.answer } }, { existingEventSeq: source.seq });
  const proposal: NoticingProposalRecord = { ...packet.proposal, shapeKey: id, confidence: 0.9,
    status: 'answered', answer: { text: packet.checkIn.answer, decision: 'do_it', at: packet.checkIn.answeredAt },
    handoff: { version: 1, state: 'dispatched', answerDigest: digest, updatedAt: packet.checkIn.answeredAt,
      requestId, sessionId, sourceUserSeq: source.seq } };
  return { goal, proposal, packet, source, sessionId, requestId, attempt,
    project: (currentGoal = goal, currentProposal = proposal) =>
      progress.readGoalOutcomeProgress({ goals: [currentGoal], proposals: [currentProposal] })[currentGoal.id]! };
}

function workflow(f: ReturnType<typeof accepted>, label = 'one') {
  const runId = `workflow-${f.proposal.id}-${label}`;
  const workflowName = `controlled-${f.proposal.id}-${label}`;
  const objective = 'Return the exact controlled product without sending anything.';
  const successCriteria = ['The controlled product is 323.'];
  const definition = { name: workflowName, enabled: true, description: objective,
    trigger: { manual: true }, goal: { objective, successCriteria },
    steps: [{ id: 'compute', prompt: '', sideEffect: 'read' as const,
      transform: { version: 1 as const, expression: { op: 'literal' as const, value: { product: 323 } } } }] };
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const observer = { sessionId: f.sessionId, sourceUserSeq: f.source.seq, replyTarget: { type: 'origin_chat' as const } };
  const queueRequestDigest = origins.workflowChatDispatchQueueRequestDigest({ workflowName, normalizedInputs: {} });
  const authority = origins.createWorkflowChatDispatchPreparationAuthority({ runId, observer, queueRequestDigest });
  writeFileSync(file, JSON.stringify({ id: runId, workflow: workflowName, inputs: {}, status: 'awaiting_chat_dispatch_seal',
    createdAt: '2026-10-17T00:02:00Z', chatDispatchSourceGroupId: authority.sourceGroupId,
    chatDispatchQueueRequestDigest: queueRequestDigest,
    workflowDefinitionSnapshot: { version: 1, workflowSlug: workflowName, admittedAt: '2026-10-17T00:02:00Z',
      definition, definitionHash: definitions.workflowDefinitionHash(definition as never) } }));
  const preparedEvent = log.appendEvent({ sessionId: f.sessionId, turn: 1, role: 'system',
    type: 'async_work_dispatch_prepared', parentEventId: f.source.id, data: { ...authority } });
  const prepared = origins.recordWorkflowChatDispatchPreparation(origins.createWorkflowChatDispatchPreparedReceipt(authority,
    { eventId: preparedEvent.id, eventSeq: preparedEvent.seq, preparedAt: preparedEvent.createdAt }));
  const close = origins.createWorkflowOriginGroupCloseAuthority([prepared]);
  const closedEvent = log.appendAsyncWorkDispatchBatchClosedOnce({ sessionId: f.sessionId, turn: 1,
    sourceUserSeq: f.source.seq, data: { ...close } }).event;
  origins.recordWorkflowOriginGroupClosedBatch({ receipt: origins.createWorkflowOriginGroupClosedBatchReceipt(close,
    { eventId: closedEvent.id, eventSeq: closedEvent.seq, closedAt: closedEvent.createdAt }), preparedReceipts: [prepared] });
  const active = origins.finalizeWorkflowOriginGroupClosedBatch(close.sourceGroupId, { beforeMemberRelease: group => {
    log.appendAsyncWorkDispatchedOnce({ sessionId: f.sessionId, turn: 1, sourceUserSeq: f.source.seq,
      sourceGroupId: group.sealed.sourceGroupId, data: { ...group.publicDispatch, replyTarget: group.sealed.replyTarget } });
  } });
  const contract = plans.ensureWorkflowRunGoal({ workflowName, runId, objective, successCriteria })!;
  const perCriterion = [{ criterion: successCriteria[0]!, pass: true, method: 'deterministic' as const }];
  plans.recordGoalValidation(contract.id, perCriterion.map(row => ({ ...row, at: '2026-10-17T00:03:00Z', attempt: 1 })));
  plans.satisfyGoal(contract.id, 'Controlled review passed.');
  const artifact = artifacts.recordStepOutput({ workflowName, runId, stepId: 'compute', output: { product: 323 }, nowIso: '2026-10-17T00:03:00Z' });
  events.appendWorkflowEvent(workflowName, runId, { kind: 'step_completed', stepId: 'compute', output: { product: 323 },
    meta: { mode: 'transform', stepOutputArtifact: artifact } });
  const run = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(run, { status: 'completed', finishedAt: '2026-10-17T00:03:00Z', goalOutcome: 'satisfied',
    goalValidation: { version: 1, objective, successCriteria, pass: true, judgeFailedOpen: false, perCriterion,
      objectiveReview: { criterion: objective, scope: 'objective', pass: true, method: 'judge' }, validatedAt: '2026-10-17T00:03:00Z' } });
  writeFileSync(file, JSON.stringify(run));
  return { runId, workflowName, file, active, contract, run, artifact,
    artifactFile: path.join(artifacts.runWorkspaceDir(workflowName, runId), artifact.path) };
}

test('goal outcome exact source, sealed workflow and retained contract survive cold reopen without completing the goal', () => {
  const f = accepted();
  const w = workflow(f);
  const goalFile = path.join(home, 'goals', `${f.goal.id}.json`);
  const before = readFileSync(goalFile, 'utf8');
  const first = f.project();
  assert.equal(first.linkedTasks[0]?.goalBinding, 'current');
  assert.equal(first.linkedTasks[0]?.state, 'outcome_retained');
  assert.equal(first.linkedTasks[0]?.workflows[0]?.state, 'satisfied');
  assert.equal(first.linkedTasks[0]?.workflows[0]?.contractId, w.contract.id);
  assert.deepEqual(first.linkedTasks[0]?.workflows[0]?.criteria, { total: 1, passed: 1, remaining: [] });
  assert.equal(first.linkedTasks[0]?.workflows[0]?.artifactReadback, 'verified');
  log.closeEventLog();
  assert.deepEqual(f.project(), first);
  assert.equal(readFileSync(goalFile, 'utf8'), before, 'projection never changes the broad goal or its self-drive policy');
  assert.equal(JSON.parse(before).status, 'active');
  assert.equal(JSON.parse(before).autoSchedule, undefined);
});

test('goal outcome historical criteria do not become current acceptance after a goal edit or late unrelated task', () => {
  const f = accepted(); workflow(f);
  log.appendEvent({ sessionId: f.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'A separate later task.' } });
  const edited = { ...f.goal, description: 'Different current criteria; use another named account.' };
  const projected = f.project(edited);
  assert.equal(projected.linkedTasks[0]?.goalBinding, 'historical');
  assert.equal(projected.linkedTasks[0]?.sourceUserSeq, f.source.seq, 'late A never attaches to current B');
  assert.equal(projected.linkedTasks[0]?.workflows[0]?.state, 'satisfied', 'historical workflow verdict remains visible as historical');
  assert.match(projected.linkedTasks[0]?.detail ?? '', /earlier goal definition/);
  assert.equal(f.project({ ...f.goal, updatedAt: 'later', progressNotes: ['New human progress note.'] }).linkedTasks[0]?.goalBinding, 'current');
});

test('goal outcome current artifact changes are distinct from a historical satisfied workflow', () => {
  const f = accepted(); const w = workflow(f);
  assert.equal(f.project().linkedTasks[0]?.workflows[0]?.artifactReadback, 'verified');
  writeFileSync(w.artifactFile, '{"product":999}');
  const changed = f.project().linkedTasks[0]!.workflows[0]!;
  assert.equal(changed.state, 'satisfied');
  assert.equal(changed.artifactReadback, 'changed_or_unavailable');
  rmSync(w.artifactFile);
  assert.equal(f.project().linkedTasks[0]?.workflows[0]?.artifactReadback, 'changed_or_unavailable');
});

test('goal outcome refuses foreign, missing and ambiguous run or contract bindings and failed-open review', () => {
  for (const variant of ['foreign-run', 'missing-run', 'foreign-contract', 'ambiguous-contract', 'failed-open', 'changed-definition'] as const) {
    const f = accepted(); const w = workflow(f);
    if (variant === 'missing-run') rmSync(w.file);
    if (variant === 'foreign-run') writeFileSync(w.file, JSON.stringify({ ...w.run, id: 'another-run' }));
    if (variant === 'changed-definition') {
      const run = structuredClone(w.run); run.workflowDefinitionSnapshot.definition.goal.objective = 'An unaccepted objective';
      writeFileSync(w.file, JSON.stringify(run));
    }
    if (variant === 'failed-open') writeFileSync(w.file, JSON.stringify({ ...w.run,
      goalValidation: { ...w.run.goalValidation, judgeFailedOpen: true } }));
    if (variant === 'foreign-contract' || variant === 'ambiguous-contract') {
      const contractFile = path.join(home, 'state', 'plan-proposals', `${w.contract.id}.json`);
      const contract = JSON.parse(readFileSync(contractFile, 'utf8'));
      if (variant === 'foreign-contract') {
        contract.origin.runId = 'another-run'; writeFileSync(contractFile, JSON.stringify(contract));
      } else writeFileSync(path.join(path.dirname(contractFile), `duplicate-${w.contract.id}.json`), JSON.stringify({ ...contract, id: `duplicate-${w.contract.id}` }));
    }
    assert.notEqual(f.project().linkedTasks[0]?.workflows[0]?.state, 'satisfied', variant);
  }
});

test('goal outcome does not guess missing accepted identity, ambiguous dispatch or a stopped start as active', () => {
  const pending = accepted();
  assert.equal(pending.project().linkedTasks[0]?.state, 'in_progress');
  log.requestKill(pending.sessionId, 'Controlled Stop', { sourceUserSeq: pending.source.seq });
  assert.equal(pending.project().linkedTasks[0]?.state, 'needs_attention');
  const f = accepted(); workflow(f);
  const copied = { ...f.proposal, handoff: { ...f.proposal.handoff!, sourceUserSeq: f.source.seq + 1 } };
  assert.equal(f.project(f.goal, copied).linkedTasks[0]?.state, 'unavailable');
  const dispatch = log.listEvents(f.sessionId, { types: ['async_work_dispatched'] })[0]!;
  log.appendEvent({ sessionId: f.sessionId, turn: 1, role: 'system', type: 'async_work_dispatched',
    parentEventId: f.source.id, data: dispatch.data });
  assert.equal(f.project().linkedTasks[0]?.state, 'unavailable');
  const unknown = progress.unavailableGoalOutcomeProgress();
  assert.equal(unknown.availability, 'unavailable');
  assert.match(unknown.summary, /unavailable/);
});

test('goal outcome tampered accepted packet cannot borrow an otherwise successful workflow and target readback has no empty success', () => {
  const f = accepted(); workflow(f);
  const data = structuredClone(f.source.data);
  (data.noticingApprovedTask as { packet: NoticingApprovedTaskPacket }).packet.goal!.description = 'Changed after approval';
  log.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?').run(JSON.stringify(data), f.source.id);
  assert.equal(f.project().linkedTasks[0]?.state, 'unavailable');
  assert.equal(targets.readWorkflowTargetEvidence('no-execution').artifactReadback?.checked, 0);
  const unsafeGoal = { ...f.goal, id: '__proto__' };
  const empty = progress.readGoalOutcomeProgress({ goals: [unsafeGoal], proposals: [] });
  assert.equal(Object.getPrototypeOf(empty), null);
  assert.equal(empty.__proto__?.linkedTasks.length, 0);
});

test('goal outcome capture bounds total task and current artifact work without presenting omitted goals as empty', () => {
  const fixtures = Array.from({ length: 9 }, () => accepted());
  for (const f of fixtures) workflow(f);
  const snapshot = progress.readGoalOutcomeProgress({ goals: fixtures.map(f => f.goal), proposals: fixtures.map(f => f.proposal) });
  const projected = Object.values(snapshot).flatMap(goal => goal.linkedTasks);
  assert.equal(projected.length, 8);
  assert.equal(projected.flatMap(task => task.workflows).length, 8);
  assert.equal(projected.flatMap(task => task.workflows).filter(run => run.artifactReadback === 'verified').length, 2);
  assert.equal(projected.flatMap(task => task.workflows).filter(run => run.artifactReadback === 'not_checked').length, 6);
  const omitted = snapshot[fixtures[8]!.goal.id]!;
  assert.equal(omitted.omittedTasks, 1);
  assert.match(omitted.summary, /Omitted work is unqualified/);
});

test('goal outcome preserves known bad artifact bytes beside an uncovered retained write', async () => {
  const f = accepted(); const w = workflow(f);
  const shadow = await import('../runtime/graph/turn-graph-shadow.js');
  const ids = await import('../runtime/harness/attempt-identity.js');
  const dispatch = await import('../runtime/harness/dispatch-ledger.js');
  const settlements = await import('../runtime/harness/logical-call-settlement-store.js');
  const outcomes = await import('../runtime/harness/attempt-outcome.js');
  const session = log.createSession({ id: `workflow:${w.runId}:uncovered`, kind: 'chat', channel: 'desktop' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Controlled acknowledgement with no current-file contract.' } });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1,
    acceptedTaskId: ids.acceptedTaskIdFor(session.id, source.seq) };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }));
  const identity = { ...task, logicalToolCallId: 'controlled-uncovered-write', physicalDispatchId: 'controlled-uncovered-dispatch', ordinal: 0 };
  const args = { name: 'controlled-already-absent-workflow' };
  assert.equal(dispatch.beginPhysicalDispatch({ identity, tool: 'workflow_delete', args, executionSite: 'host' }).status, 'inserted');
  assert.equal(dispatch.settlePhysicalDispatch({ identity, tool: 'workflow_delete', outcome: 'returned' }).status, 'inserted');
  // A deterministic retained acknowledgement fixture; this test invokes no
  // deletion/provider body and claims no current artifact for this receipt.
  assert.equal(settlements.commitLogicalCallSettlement({ identity, contract: { toolName: 'workflow_delete', args },
    execution: { kind: 'local_execution' }, result: { payload: 'Controlled acknowledgement; no file output.' },
    outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }), recovery: { businessCall: true, mutating: true },
    observer: { lane: 'byo', turn: 1 } }).status, 'committed');
  assert.equal(targets.readWorkflowTargetEvidence(w.runId).artifactReadback?.uncoveredWrites, 1);
  assert.equal(f.project().linkedTasks[0]?.workflows[0]?.artifactReadback, 'not_checked', 'one good intermediate file cannot cover an unopened write target');
  writeFileSync(w.artifactFile, '{"product":999}');
  const current = targets.readWorkflowTargetEvidence(w.runId);
  assert.equal(current.artifactReadback?.unavailable, 1);
  assert.equal(current.artifactReadback?.uncoveredWrites, 1);
  assert.equal(f.project().linkedTasks[0]?.workflows[0]?.artifactReadback, 'changed_or_unavailable', 'the unknown write does not hide known contrary bytes');
});

test('goal outcome cannot establish a unique contract from a partial plan registry', () => {
  const f = accepted(); const w = workflow(f);
  const registry = path.join(home, 'state', 'plan-proposals');
  const unknown = path.join(registry, `unreadable-${w.contract.id}.json`);
  assert.equal(f.project().linkedTasks[0]?.workflows[0]?.state, 'satisfied');
  for (const variant of ['malformed', 'unreadable-entry', 'null', 'array', 'scalar'] as const) {
    try {
      if (variant === 'unreadable-entry') mkdirSync(unknown);
      else writeFileSync(unknown, variant === 'malformed' ? '{"origin":' : variant === 'array' ? '[]' : variant === 'null' ? 'null' : '42');
      assert.throws(() => plans.listPlanProposals({ status: 'all', strictRead: true }), variant);
      assert.equal(f.project().availability, 'unavailable', variant);
      if (variant === 'malformed' || variant === 'unreadable-entry') {
        assert.ok(plans.listPlanProposals({ status: 'all' }).some(contract => contract.id === w.contract.id),
          'legacy callers still skip unreadable entries; only proof captures opt into strict reads');
      }
    } finally { rmSync(unknown, { recursive: true, force: true }); }
  }
  assert.equal(f.project().linkedTasks[0]?.workflows[0]?.state, 'satisfied');
});
