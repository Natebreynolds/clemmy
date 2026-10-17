import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mock } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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

function accepted(existingGoal?: GoalRecord) {
  const id = `goal-projection-${++sequence}`;
  const saved = existingGoal ? { ok: true as const, goal: existingGoal } : upsertGoalRecord({ title: `Controlled business goal ${id}`,
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

function workflow(f: ReturnType<typeof accepted>, label = 'one', options: {
  workflowName?: string; settleContract?: boolean; pinContract?: boolean; extraMembers?: number;
  workspaceWrite?: { slug: string; value: number };
} = {}) {
  const runId = `workflow-${f.proposal.id}-${label}`;
  const workflowName = options.workflowName ?? `controlled-${f.proposal.id}-${label}`;
  const objective = 'Return the exact controlled product without sending anything.';
  const successCriteria = ['The controlled product is 323.'];
  const definition = { name: workflowName, enabled: true, description: objective,
    trigger: { manual: true }, goal: { objective, successCriteria },
    steps: [{ id: 'compute', prompt: '', sideEffect: 'read' as const,
      transform: { version: 1 as const, expression: { op: 'literal' as const, value: { product: 323 } } } },
    ...(options.workspaceWrite ? [{ id: 'publish', prompt: '', sideEffect: 'write' as const,
      call: { tool: 'space_set_data', args: { slug: options.workspaceWrite.slug, source_id: 'result',
        data_json: JSON.stringify({ value: options.workspaceWrite.value }) } } }] : [])] };
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const file = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  const observer = { sessionId: f.sessionId, sourceUserSeq: f.source.seq, replyTarget: { type: 'origin_chat' as const } };
  const prepareMember = (memberRunId: string, inputs: Record<string, unknown>) => {
    const queueRequestDigest = origins.workflowChatDispatchQueueRequestDigest({ workflowName, normalizedInputs: inputs });
    const authority = origins.createWorkflowChatDispatchPreparationAuthority({ runId: memberRunId, observer, queueRequestDigest });
    const memberFile = path.join(WORKFLOW_RUNS_DIR, `${memberRunId}.json`);
    writeFileSync(memberFile, JSON.stringify({ id: memberRunId, workflow: workflowName, inputs, status: 'awaiting_chat_dispatch_seal',
    createdAt: '2026-10-17T00:02:00Z', chatDispatchSourceGroupId: authority.sourceGroupId,
    chatDispatchQueueRequestDigest: queueRequestDigest,
    workflowDefinitionSnapshot: { version: 1, workflowSlug: workflowName, admittedAt: '2026-10-17T00:02:00Z',
      definition, definitionHash: definitions.workflowDefinitionHash(definition as never) } }));
    const preparedEvent = log.appendEvent({ sessionId: f.sessionId, turn: 1, role: 'system',
      type: 'async_work_dispatch_prepared', parentEventId: f.source.id, data: { ...authority } });
    const prepared = origins.recordWorkflowChatDispatchPreparation(origins.createWorkflowChatDispatchPreparedReceipt(authority,
      { eventId: preparedEvent.id, eventSeq: preparedEvent.seq, preparedAt: preparedEvent.createdAt }));
    return { runId: memberRunId, file: memberFile, prepared };
  };
  const members = [prepareMember(runId, {}), ...Array.from({ length: options.extraMembers ?? 0 }, (_, index) =>
    prepareMember(`${runId}-extra-${index}`, { controlledMember: index }))];
  const preparedReceipts = members.map(member => member.prepared);
  const close = origins.createWorkflowOriginGroupCloseAuthority(preparedReceipts);
  const closedEvent = log.appendAsyncWorkDispatchBatchClosedOnce({ sessionId: f.sessionId, turn: 1,
    sourceUserSeq: f.source.seq, data: { ...close } }).event;
  origins.recordWorkflowOriginGroupClosedBatch({ receipt: origins.createWorkflowOriginGroupClosedBatchReceipt(close,
    { eventId: closedEvent.id, eventSeq: closedEvent.seq, closedAt: closedEvent.createdAt }), preparedReceipts });
  const active = origins.finalizeWorkflowOriginGroupClosedBatch(close.sourceGroupId, { beforeMemberRelease: group => {
    log.appendAsyncWorkDispatchedOnce({ sessionId: f.sessionId, turn: 1, sourceUserSeq: f.source.seq,
      sourceGroupId: group.sealed.sourceGroupId, data: { ...group.publicDispatch, replyTarget: group.sealed.replyTarget } });
  } });
  const contract = plans.ensureWorkflowRunGoal({ workflowName, runId, objective, successCriteria })!;
  const perCriterion = [{ criterion: successCriteria[0]!, pass: true, method: 'deterministic' as const }];
  plans.recordGoalValidation(contract.id, perCriterion.map(row => ({ ...row, at: '2026-10-17T00:03:00Z', attempt: 1 })));
  if (options.settleContract !== false) plans.satisfyGoal(contract.id, 'Controlled review passed.');
  const artifact = artifacts.recordStepOutput({ workflowName, runId, stepId: 'compute', output: { product: 323 }, nowIso: '2026-10-17T00:03:00Z' });
  events.appendWorkflowEvent(workflowName, runId, { kind: 'step_completed', stepId: 'compute', output: { product: 323 },
    meta: { mode: 'transform', stepOutputArtifact: artifact } });
  const run = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(run, { status: 'completed', finishedAt: '2026-10-17T00:03:00Z', goalOutcome: 'satisfied',
    ...(options.pinContract ? { goalContractId: contract.id } : {}),
    goalValidation: { version: 1, objective, successCriteria, pass: true, judgeFailedOpen: false, perCriterion,
      objectiveReview: { criterion: objective, scope: 'objective', pass: true, method: 'judge' }, validatedAt: '2026-10-17T00:03:00Z' } });
  writeFileSync(file, JSON.stringify(run));
  return { runId, workflowName, file, active, contract, run, artifact, extraMembers: members.slice(1),
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

test('goal outcome exact contract pins join independent runs of one goal without donating either run validation', () => {
  const first = accepted();
  const workflowName = `controlled-shared-contract-${first.proposal.id}`;
  const a = workflow(first, 'first', { workflowName, settleContract: false, pinContract: true });
  const second = accepted(first.goal);
  const b = workflow(second, 'independent', { workflowName, pinContract: true });
  assert.equal(b.contract.id, a.contract.id, 'the real contract producer reuses its active contract');
  assert.equal(b.contract.origin?.runId, a.runId, 'origin continues to name the first run');
  assert.equal(b.run.requeuedFromRunId, undefined, 'an independent fire needs no fabricated retry lineage');
  const failed = structuredClone(a.run);
  failed.goalOutcome = 'gap'; failed.goalValidation.pass = false;
  failed.goalValidation.perCriterion[0].pass = false; failed.goalValidation.objectiveReview.pass = false;
  writeFileSync(a.file, JSON.stringify(failed));
  const goalFile = path.join(home, 'goals', `${first.goal.id}.json`);
  const goalBefore = readFileSync(goalFile, 'utf8');
  const projectBoth = () => progress.readGoalOutcomeProgress({ goals: [first.goal],
    proposals: [first.proposal, second.proposal] })[first.goal.id]!;
  const projected = projectBoth();
  const byProposal = new Map(projected.linkedTasks.map(task => [task.proposalId, task]));
  assert.equal(byProposal.get(first.proposal.id)?.workflows[0]?.contractId, a.contract.id);
  assert.equal(byProposal.get(first.proposal.id)?.workflows[0]?.state, 'not_satisfied');
  assert.equal(byProposal.get(second.proposal.id)?.workflows[0]?.contractId, a.contract.id);
  assert.equal(byProposal.get(second.proposal.id)?.workflows[0]?.state, 'satisfied');
  log.closeEventLog(); assert.deepEqual(projectBoth(), projected, 'the exact cross-run link survives reopen');
  assert.equal(readFileSync(goalFile, 'utf8'), goalBefore, 'subtask links never complete the broad goal');
  for (const patch of [
    { goalValidation: undefined },
    { goalValidation: { ...b.run.goalValidation, judgeFailedOpen: true } },
    { goalValidation: { ...b.run.goalValidation, successCriteria: ['An unrelated criterion.'] } },
  ]) {
    writeFileSync(b.file, JSON.stringify({ ...b.run, ...patch }));
    assert.notEqual(second.project().linkedTasks[0]?.workflows[0]?.state, 'satisfied',
      'the shared contract does not replace this run’s own exact review');
  }
});

test('goal outcome legacy independent runs join a uniquely retained contract epoch even after it is satisfied', () => {
  const first = accepted(); const workflowName = `controlled-legacy-contract-${first.proposal.id}`;
  const a = workflow(first, 'first', { workflowName, settleContract: false });
  const second = accepted(first.goal); const b = workflow(second, 'independent', { workflowName });
  const file = path.join(home, 'state', 'plan-proposals', `${a.contract.id}.json`);
  const contract = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(contract.status, 'satisfied'); assert.equal(contract.origin.runId, a.runId);
  contract.proposedAt = '2026-10-17T00:00:00Z'; contract.resolvedAt = '2026-10-17T00:04:00Z';
  writeFileSync(file, JSON.stringify(contract));
  assert.equal(b.run.goalContractId, undefined);
  assert.equal(second.project().linkedTasks[0]?.workflows[0]?.contractId, a.contract.id);
  assert.equal(second.project().linkedTasks[0]?.workflows[0]?.state, 'satisfied');
  const duplicateFile = path.join(path.dirname(file), `other-epoch-${contract.id}.json`);
  try {
    writeFileSync(duplicateFile, JSON.stringify({ ...contract, id: `other-epoch-${contract.id}`,
      proposedAt: '2026-10-17T00:05:00Z', resolvedAt: '2026-10-17T00:08:00Z' }));
    assert.equal(second.project().linkedTasks[0]?.workflows[0]?.state, 'satisfied', 'a disjoint later epoch does not replace the old run’s own epoch');
    writeFileSync(duplicateFile, JSON.stringify({ ...contract, id: `other-epoch-${contract.id}` }));
    assert.equal(second.project().linkedTasks[0]?.workflows[0]?.state, 'unavailable', 'overlapping compatible epochs are ambiguous, never latest-wins');
  } finally { rmSync(duplicateFile, { force: true }); }
  const changed = structuredClone(b.run);
  changed.workflowDefinitionSnapshot.definition.description = 'A later workflow revision with other constraints.';
  changed.workflowDefinitionSnapshot.definitionHash = definitions.workflowDefinitionHash(changed.workflowDefinitionSnapshot.definition);
  writeFileSync(b.file, JSON.stringify(changed));
  assert.equal(second.project().linkedTasks[0]?.workflows[0]?.state, 'unavailable', 'legacy session identity cannot donate across admitted revisions');
});

test('goal outcome explicit contract identity never falls back through a malformed, missing, foreign or ambiguous pin', () => {
  const f = accepted(); const w = workflow(f, 'pinned', { pinContract: true });
  const foreign = accepted(); const other = workflow(foreign);
  for (const goalContractId of ['', null, 42, 'missing-controlled-contract', other.contract.id]) {
    writeFileSync(w.file, JSON.stringify({ ...w.run, goalContractId }));
    assert.equal(f.project().linkedTasks[0]?.workflows[0]?.state, 'unavailable', String(goalContractId));
  }
  writeFileSync(w.file, JSON.stringify(w.run));
  const contractFile = path.join(home, 'state', 'plan-proposals', `${w.contract.id}.json`);
  const duplicateFile = path.join(path.dirname(contractFile), `copy-${w.contract.id}.json`);
  try {
    writeFileSync(duplicateFile, readFileSync(contractFile));
    assert.equal(f.project().linkedTasks[0]?.workflows[0]?.state, 'unavailable', 'a duplicate retained ID cannot establish uniqueness');
  } finally { rmSync(duplicateFile, { force: true }); }
  const unrelated = { ...f.goal, id: `${f.goal.id}-unrelated` };
  assert.deepEqual(progress.readGoalOutcomeProgress({ goals: [unrelated], proposals: [f.proposal] })[unrelated.id]?.linkedTasks, []);
});

test('goal outcome legacy retry uses exact retained predecessor proof and rejects a foreign or cyclic chain', () => {
  const first = accepted(); const workflowName = `controlled-retry-contract-${first.proposal.id}`;
  const a = workflow(first, 'first', { workflowName, settleContract: false });
  const second = accepted(first.goal); const b = workflow(second, 'retry', { workflowName });
  const retry = { ...b.run, requeuedFromRunId: a.runId, recoveryIntent: { sourceRunId: a.runId } };
  writeFileSync(b.file, JSON.stringify(retry));
  assert.equal(second.project().linkedTasks[0]?.workflows[0]?.contractId, a.contract.id);
  assert.equal(second.project().linkedTasks[0]?.workflows[0]?.state, 'satisfied');
  for (const patch of [
    { recoveryIntent: { sourceRunId: 'foreign-run' } },
    { requeuedFromRunId: b.runId, recoveryIntent: { sourceRunId: b.runId } },
    { requeuedFromRunId: '../outside', recoveryIntent: { sourceRunId: '../outside' } },
  ]) {
    writeFileSync(b.file, JSON.stringify({ ...retry, ...patch }));
    assert.equal(second.project().linkedTasks[0]?.workflows[0]?.state, 'unavailable');
  }
});

test('goal outcome historical criteria do not become current acceptance after a goal edit or late unrelated task', () => {
  const f = accepted(); workflow(f);
  log.appendEvent({ sessionId: f.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'A separate later task.' } });
  const edited = { ...f.goal, description: 'Different current criteria; use another named account.' };
  const projected = f.project(edited);
  assert.equal(projected.linkedTasks[0]?.goalBinding, 'historical');
  assert.equal(projected.linkedTasks[0]?.sourceUserSeq, f.source.seq, 'late A never attaches to current B');
  assert.equal(projected.linkedTasks[0]?.workflows[0]?.state, 'satisfied', 'historical workflow verdict remains visible as historical');
  assert.match(projected.linkedTasks[0]?.detail ?? '', /earlier version of your goal/);
  assert.equal(f.project({ ...f.goal, updatedAt: 'later', progressNotes: ['New human progress note.'] }).linkedTasks[0]?.goalBinding, 'current');
});

test('goal outcome current artifact changes are distinct from a historical satisfied workflow', () => {
  const f = accepted(); const w = workflow(f);
  assert.equal(f.project().linkedTasks[0]?.workflows[0]?.artifactReadback, 'verified');
  writeFileSync(w.artifactFile, '{"product":999}');
  const changed = f.project().linkedTasks[0]!.workflows[0]!;
  assert.equal(changed.state, 'satisfied');
  assert.equal(changed.artifactReadback, 'changed_or_unavailable');
  assert.equal(f.project().linkedTasks[0]?.state, 'needs_attention', 'historical success does not hide changed current bytes');
  rmSync(w.artifactFile);
  assert.equal(f.project().linkedTasks[0]?.workflows[0]?.artifactReadback, 'changed_or_unavailable');
});

test('goal outcome keeps a proved historical Workspace result superseded without false attention after another run writes', async () => {
  const runner = await import('../execution/workflow-runner.js');
  const local = await import('../runtime/harness/reviewed-local-tool-carrier.js');
  const adapters = await import('../runtime/harness/production-capability-adapters.js');
  const manifests = await import('../runtime/harness/capability-manifest-store.js');
  const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
  const ports = await import('../runtime/harness/production-capability-ports.js');
  const observations = await import('../runtime/harness/independent-capability-observation.js');
  const spaces = await import('../spaces/store.js');
  const workspaceDb = await import('../spaces/workspace-db.js');
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  ports.clearProductionCapabilityPorts(); observations.clearIndependentCapabilityObservations();
  const slug = 'goal-proved-superseded-source';
  spaces.spaceStore.save({ id: slug, title: 'Controlled goal result', status: 'active',
    viewEntry: 'view/index.html', viewContent: '<!doctype html><title>Controlled goal result</title>', dataSources: [], actions: [] });
  const observed = local.observeReviewedLocalTool('space_set_data'); assert.ok(observed);
  const manifest = local.reviewedLocalCapabilityManifest(observed); assert.ok(manifest);
  assert.equal(ports.registerFixtureCapabilityPort(ports.productionPortIdentityFromManifest(manifest), {
    invoke: adapters.invokeForSealedManifest(manifest), reconcile: adapters.reconcileForSealedManifest(manifest),
  }).ok, true);
  const a = accepted(); const aw = workflow(a, 'prior-dataset', { workspaceWrite: { slug, value: 1 }, pinContract: true });
  const b = accepted(a.goal); const bw = workflow(b, 'current-dataset', { workspaceWrite: { slug, value: 2 }, pinContract: true });
  const publish = async (w: typeof aw) => {
    // The existing fixture supplies goal-review receipts. Only the controlled
    // write uses production dispatch here; no model or judge is invoked.
    const definition = w.run.workflowDefinitionSnapshot.definition;
    const step = definition.steps.find((entry: { id: string }) => entry.id === 'publish'); assert.ok(step);
    writeFileSync(w.file, JSON.stringify({ ...w.run, status: 'running', finishedAt: undefined, terminalOutcome: undefined }));
    try {
      await runner.executeStep(step, { workflow: definition, workflowSlug: w.workflowName, runId: w.runId,
        inputs: {}, stepOutputs: { compute: { product: 323 } },
        assistant: new Proxy({}, { get: () => { throw new Error('No model may run for this controlled write.'); } }),
        completedItems: new Map(), forEachFailures: [], qualityAdvisories: [] } as unknown as Parameters<typeof runner.executeStep>[1]);
    } finally { writeFileSync(w.file, JSON.stringify(w.run)); }
  };
  try {
    await publish(aw);
    assert.equal(a.project().linkedTasks[0]?.workflows[0]?.artifactReadback, 'verified');
    const aObservation = workspaceDb.getCurrentWorkspaceDatasetObservation(slug, 'result')!.id;
    await publish(bw);
    assert.notEqual(workspaceDb.getCurrentWorkspaceDatasetObservation(slug, 'result')!.id, aObservation);
    const old = a.project().linkedTasks[0]!;
    assert.equal(old.workflows[0]?.state, 'satisfied', 'A retains only its own historical review');
    assert.equal(old.workflows[0]?.artifactReadback, 'superseded');
    assert.equal(old.state, 'outcome_retained', 'verified supersession alone is not a failure or request for attention');
    assert.equal(b.project().linkedTasks[0]?.workflows[0]?.artifactReadback, 'verified');
    log.closeEventLog(); workspaceDb.closeWorkspaceDb();
    assert.equal(a.project().linkedTasks[0]?.workflows[0]?.artifactReadback, 'superseded');
    const dataFile = spaces.resolveInSpace(slug, 'data.json'); const currentBytes = readFileSync(dataFile);
    try {
      writeFileSync(dataFile, '{"result":{"value":999}}');
      const contrary = a.project().linkedTasks[0]!;
      assert.equal(contrary.workflows[0]?.artifactReadback, 'changed_or_unavailable');
      assert.equal(contrary.state, 'needs_attention', 'historical proof cannot hide actual current tampering');
    } finally { writeFileSync(dataFile, currentBytes); }
  } finally {
    workspaceDb.closeWorkspaceDb(); ports.clearProductionCapabilityPorts(); observations.clearIndependentCapabilityObservations();
    catalogs.installHostCapabilityCatalogFactory(null);
  }
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
    const projected = f.project().linkedTasks[0]?.workflows[0];
    assert.notEqual(projected?.state, 'satisfied', variant);
    if (variant === 'missing-run' || variant === 'foreign-run') assert.equal(projected?.workflowName, '',
      'an unknown run supplies no fabricated workflow name for navigation');
  }
});

test('goal workflow navigation retains the full known workflow identity', () => {
  const f = accepted(); const name = `controlled-${'long-name-'.repeat(16)}`;
  workflow(f, 'long-name', { workflowName: name, pinContract: true });
  assert.equal(f.project().linkedTasks[0]?.workflows[0]?.workflowName, name,
    'display clipping must not change the workflow route identity');
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
  assert.match(unknown.summary, /Couldn’t load/);
});

test('goal outcome pending handoffs are readable without inventing accepted identity or execution', () => {
  const f = accepted();
  const pending: NoticingProposalRecord = { ...f.proposal, id: `${f.proposal.id}-pending`,
    handoff: { version: 1, state: 'not_started', answerDigest: 'retained-controlled-answer', updatedAt: f.proposal.createdAt } };
  const before = log.listEvents(f.sessionId).length;
  const row = f.project(f.goal, pending).linkedTasks[0]!;
  assert.equal(row.state, 'pending');
  assert.equal(row.goalBinding, 'pending');
  assert.equal(row.sessionId, undefined);
  assert.equal(row.sourceUserSeq, undefined);
  assert.deepEqual(row.workflows, []);
  assert.match(row.detail, /start is not confirmed/i);
  assert.equal(log.listEvents(f.sessionId).length, before, 'the display does not accept or start work');
  assert.equal(f.project(f.goal, { ...pending, handoff: { ...pending.handoff!, state: 'needs_attention' } }).linkedTasks[0]?.state, 'needs_attention');
  assert.equal(f.project(f.goal, { ...pending, handoff: { ...pending.handoff!, sourceUserSeq: f.source.seq } }).linkedTasks[0]?.state,
    'unavailable', 'a partial claimed identity is not a fresh unaccepted handoff');
});

test('goal outcome known failures and attention outrank unavailable siblings without inventing criterion passes', () => {
  const f = accepted(); const w = workflow(f, 'failed-and-unknown', { extraMembers: 1 });
  const extra = w.extraMembers[0]!;
  const unknown = JSON.parse(readFileSync(extra.file, 'utf8'));
  Object.assign(unknown, { status: 'completed', finishedAt: '2026-10-17T00:03:00Z' });
  writeFileSync(extra.file, JSON.stringify(unknown));
  for (const terminalOutcome of ['failed', 'blocked', 'partial', 'cancelled'] as const) {
    writeFileSync(w.file, JSON.stringify({ ...w.run, terminalOutcome,
      status: terminalOutcome === 'cancelled' ? 'cancelled' : 'error', goalValidation: undefined, goalContractId: undefined }));
    const task = f.project().linkedTasks[0]!;
    assert.equal(task.state, 'needs_attention', terminalOutcome);
    const failed = task.workflows.find(row => row.runId === w.runId)!;
    assert.equal(failed.state, 'not_satisfied');
    assert.match(failed.detail, /outstanding|could not finish|was stopped|failed/);
    assert.equal(failed.criteria.passed, 0);
    assert.equal(failed.artifactReadback, 'not_checked');
    assert.equal(task.workflows.find(row => row.runId === extra.runId)?.state, 'unavailable');
  }
  writeFileSync(w.file, JSON.stringify(w.run));
  assert.equal(f.project().linkedTasks[0]?.state, 'unavailable', 'unknown evidence alone stays unknown');
  log.requestKill(f.sessionId, 'Controlled exact Stop with unreadable sibling', { sourceUserSeq: f.source.seq });
  assert.equal(f.project().linkedTasks[0]?.state, 'needs_attention', 'known exact Stop survives unavailable sibling proof');
});

test('goal outcome active work survives an unknown sibling and caps stay partial without claiming done or active work', () => {
  const f = accepted(); const w = workflow(f, 'bounded-group', { pinContract: true, extraMembers: 4 });
  for (const extra of w.extraMembers) {
    const queued = JSON.parse(readFileSync(extra.file, 'utf8'));
    writeFileSync(extra.file, JSON.stringify({ ...w.run, ...queued, status: 'completed', finishedAt: w.run.finishedAt,
      goalContractId: w.contract.id, goalValidation: w.run.goalValidation, goalOutcome: 'satisfied' }));
  }
  const partial = f.project().linkedTasks[0]!;
  assert.equal(partial.workflows.length, 4);
  assert.equal(partial.omittedWorkflows, 1);
  assert.equal(partial.state, 'partial', 'view limits alone are neither unavailable, executing nor done');
  const shown = w.extraMembers.filter(extra => partial.workflows.some(row => row.runId === extra.runId));
  assert.ok(shown.length >= 2);
  const first = shown[0]!, second = shown[1]!;
  const firstRun = JSON.parse(readFileSync(first.file, 'utf8'));
  const secondRun = JSON.parse(readFileSync(second.file, 'utf8'));
  writeFileSync(first.file, JSON.stringify({ ...firstRun, status: 'running', finishedAt: undefined }));
  writeFileSync(second.file, JSON.stringify({ ...secondRun, goalValidation: undefined }));
  assert.equal(f.project().linkedTasks[0]?.state, 'in_progress', 'exact active workflow progress survives other missing evidence and the display cap');
  writeFileSync(first.file, JSON.stringify({ ...firstRun, status: 'pending_approval', finishedAt: undefined }));
  assert.equal(f.project().linkedTasks[0]?.state, 'needs_attention', 'an exact approval wait outranks progress, caps and unknown siblings');
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
  assert.match(omitted.summary, /Tasks outside this view haven’t been checked/);
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
  const f = accepted(); const w = workflow(f, 'healthy-pin', { pinContract: true });
  const legacy = accepted(f.goal); workflow(legacy, 'legacy-unpinned');
  const registry = path.join(home, 'state', 'plan-proposals');
  const unknown = path.join(registry, `unreadable-${w.contract.id}.json`);
  assert.equal(f.project().linkedTasks[0]?.workflows[0]?.state, 'satisfied');
  for (const variant of ['malformed', 'unreadable-entry', 'null', 'array', 'scalar', 'status-array', 'kind-array'] as const) {
    try {
      if (variant === 'unreadable-entry') mkdirSync(unknown);
      else if (variant === 'status-array' || variant === 'kind-array') writeFileSync(unknown, JSON.stringify({
        ...w.contract, id: path.basename(unknown, '.json'),
        ...(variant === 'status-array' ? { status: ['active'] } : { origin: { ...w.contract.origin, kind: ['workflow'] } }),
      }));
      else writeFileSync(unknown, variant === 'malformed' ? '{"origin":' : variant === 'array' ? '[]' : variant === 'null' ? 'null' : '42');
      if (variant !== 'status-array' && variant !== 'kind-array') {
        assert.throws(() => plans.listPlanProposals({ status: 'all', strictRead: true }), variant);
      }
      assert.equal(f.project().availability, 'available', variant);
      assert.equal(f.project().linkedTasks[0]?.workflows[0]?.state, 'satisfied', 'an exact canonical pin survives unrelated corruption');
      assert.equal(legacy.project().linkedTasks[0]?.workflows[0]?.state, 'unavailable', 'legacy uniqueness needs the whole registry');
      if (variant === 'malformed' || variant === 'unreadable-entry') {
        assert.ok(plans.listPlanProposals({ status: 'all' }).some(contract => contract.id === w.contract.id),
          'legacy callers still skip unreadable entries; only proof captures opt into strict reads');
      }
    } finally { rmSync(unknown, { recursive: true, force: true }); }
  }
  assert.equal(f.project().linkedTasks[0]?.workflows[0]?.state, 'satisfied');
  assert.equal(legacy.project().linkedTasks[0]?.workflows[0]?.state, 'satisfied');
});

test('goal outcome shares one fresh proposal capture across multiple goals', () => {
  const a = accepted(); workflow(a, 'capture-a', { pinContract: true });
  const b = accepted(); workflow(b, 'capture-b', { pinContract: true });
  const registry = path.join(home, 'state', 'plan-proposals');
  const read = fs.readFileSync, list = fs.readdirSync;
  const reads = new Map<string, number>(); let lists = 0;
  const readSpy = mock.method(fs, 'readFileSync', (...args: any[]) => {
    if (String(args[0]).startsWith(registry + path.sep)) reads.set(String(args[0]), (reads.get(String(args[0])) ?? 0) + 1);
    return Reflect.apply(read, fs, args);
  });
  const listSpy = mock.method(fs, 'readdirSync', (...args: any[]) => {
    if (String(args[0]) === registry) lists += 1;
    return Reflect.apply(list, fs, args);
  });
  syncBuiltinESMExports();
  try {
    const projected = progress.readGoalOutcomeProgress({ goals: [a.goal, b.goal], proposals: [a.proposal, b.proposal] });
    assert.equal(projected[a.goal.id]?.linkedTasks[0]?.workflows[0]?.state, 'satisfied');
    assert.equal(projected[b.goal.id]?.linkedTasks[0]?.workflows[0]?.state, 'satisfied');
    assert.equal(lists, 2, 'one directory capture plus one freshness recheck, independent of goal count');
    assert.ok(reads.size >= 2);
    assert.ok([...reads.values()].every(count => count === 1), 'each registry file is parsed only once per projection');
  } finally { readSpy.mock.restore(); listSpy.mock.restore(); syncBuiltinESMExports(); }
});
