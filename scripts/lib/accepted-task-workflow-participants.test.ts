import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { closedCanonicalJson } from '../../src/shared/closed-canonical-json.js';
import { exactOriginDeliveryReceiptForTarget } from '../../src/runtime/exact-origin-delivery.js';
import { readAcceptedTaskWorkflowParticipants } from './accepted-task-workflow-participants.js';

// Only the test imports runtime producers, after binding a disposable home.
// The reader itself has no config/eventlog/queue imports or write APIs.
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-participants-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
const [log, groups, definitions, authority, plans, memory, usage, comparison, approvals, callAuthority, contracts, leases] = await Promise.all([
  import('../../src/runtime/harness/eventlog.js'), import('../../src/execution/workflow-origin-group.js'),
  import('../../src/execution/workflow-run-definition.js'), import('../../src/runtime/harness/authored-workflow-write-authority.js'),
  import('../../src/agents/plan-scope.js'), import('../../src/memory/db.js'),
  import('../../src/runtime/usage-log.js'), import('../session-comparison.js'), import('../../src/runtime/harness/approval-registry.js'),
  import('../../src/runtime/harness/accepted-turn-call-authority.js'), import('../../src/runtime/harness/logical-call-contract.js'),
  import('../../src/runtime/harness/dispatch-lease.js'),
]);
const runsDir = path.join(home, 'workflows', 'runs');
mkdirSync(runsDir, { recursive: true });
const proof = { isWorkflowParentTerminalIdentity: () => false };
const digest = (value: unknown): string => createHash('sha256').update(closedCanonicalJson(value)).digest('hex');
let serial = 0;
test.after(() => { groups.registerWorkflowRunDrainKick(null); log.closeEventLog(); memory.closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });

function parent(label: string) {
  const session = log.createSession({ id: `sess-workflow-participant-${label}-${++serial}`, kind: 'chat', channel: 'desktop' });
  const attempt = log.beginRunAttempt(session.id, { runId: `parent-run-${serial}` });
  const source = log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: 'Run the controlled workflow fixture.' } });
  return { sessionId: session.id, sourceUserSeq: source.seq, source, attempt,
    observer: { sessionId: session.id, sourceUserSeq: source.seq, replyTarget: { type: 'origin_chat' as const } } };
}
function describeRun(runId: string, source: ReturnType<typeof parent>) {
  const stepId = 'inspect'; const slug = `controlled-${runId}`; const name = `Controlled workflow ${runId}`;
  const definition = { name, description: 'Controlled immutable descriptor.', enabled: true,
    trigger: { manual: true as const }, steps: [{ id: stepId, prompt: 'Inspect the controlled fixture and return its retained result.',
      sideEffect: 'read' as const, requiresApproval: false }] };
  const snapshot = definitions.createWorkflowRunDefinitionSnapshot(slug, definition, new Date().toISOString());
  const queueDigest = groups.workflowChatDispatchQueueRequestDigest({ workflowName: slug, normalizedInputs: {} });
  const file = path.join(runsDir, `${runId}.json`);
  const record = { id: runId, workflow: slug, inputs: {}, status: 'awaiting_chat_dispatch_seal', createdAt: new Date().toISOString(),
    chatDispatchSourceGroupId: groups.workflowOriginSourceGroupId(source.observer), chatDispatchQueueRequestDigest: queueDigest,
    workflowDefinitionSnapshot: snapshot };
  writeFileSync(file, JSON.stringify(record));
  return { runId, file, stepId, slug, name, snapshot, queueDigest };
}
function publishGroup(source: ReturnType<typeof parent>, runs: ReturnType<typeof describeRun>[]) {
  const prepared = runs.map(run => {
    const input = groups.createWorkflowChatDispatchPreparationAuthority({ runId: run.runId,
      observer: source.observer, queueRequestDigest: run.queueDigest });
    groups.recordWorkflowChatDispatchAdmission(input);
    const event = log.appendEvent({ sessionId: source.sessionId, turn: source.source.turn, role: 'system',
      type: 'async_work_dispatch_prepared', parentEventId: source.source.id, data: { ...input } });
    return groups.recordWorkflowChatDispatchPreparation(groups.createWorkflowChatDispatchPreparedReceipt(input,
      { eventId: event.id, eventSeq: event.seq, preparedAt: event.createdAt }));
  });
  const close = groups.createWorkflowOriginGroupCloseAuthority(prepared);
  const event = log.appendEvent({ sessionId: source.sessionId, turn: source.source.turn, role: 'system',
    type: 'async_work_dispatch_batch_closed', parentEventId: source.source.id, data: { ...close } });
  groups.recordWorkflowOriginGroupClosedBatch({ receipt: groups.createWorkflowOriginGroupClosedBatchReceipt(close,
    { eventId: event.id, eventSeq: event.seq, closedAt: event.createdAt }), preparedReceipts: prepared });
  return groups.finalizeWorkflowOriginGroupClosedBatch(close.sourceGroupId, { beforeMemberRelease: active => {
    log.appendEvent({ sessionId: source.sessionId, turn: source.source.turn, role: 'system', type: 'async_work_dispatched',
      parentEventId: source.source.id, data: { ...active.publicDispatch, replyTarget: active.sealed.replyTarget } });
  } });
}
function hostStep(run: ReturnType<typeof describeRun>) {
  const retained = JSON.parse(readFileSync(run.file, 'utf8'));
  writeFileSync(run.file, JSON.stringify({ ...retained, status: 'running' }));
  const session = log.createSession({ id: `workflow:${run.runId}:${run.stepId}`, kind: 'workflow', channel: 'workflow',
    metadata: { source: 'workflow', workflowName: run.name, workflowRunId: run.runId, stepId: run.stepId,
      sessionIdSuffix: `${run.runId}:${run.stepId}` } });
  const attempt = log.beginRunAttempt(session.id, { runId: `workflow-step:${run.runId}:${run.stepId}`,
    attemptId: `attempt:workflow:${run.runId}:original` });
  const source = log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: {
    text: 'Controlled hosted step inputs.', workflowName: run.name, workflowRunId: run.runId, stepId: run.stepId, attemptId: attempt.attemptId,
  } });
  const planId = `workflow:${run.name}:${run.runId}:${run.stepId}`;
  plans.openPlanScope({ sessionId: session.id, planProposalId: planId, approvedPlanObjective: 'Inspect controlled fixture only.',
    allowedTools: ['*'], ttlMs: 600_000 });
  const recorded = authority.recordAuthoredWorkflowWriteAuthority({ sessionId: session.id, sourceUserSeq: source.seq,
    attemptId: attempt.attemptId, workflowRunId: run.runId, workflowSlug: run.slug, stepId: run.stepId,
    expectedPlanProposalId: planId, catalogIdentities: [] });
  assert.equal(recorded.status, 'ready', 'the actual production receipt producer accepts the exact controlled hosted source');
  const receipt = log.listEvents(session.id, { types: ['authored_workflow_write_authority'] })[0]!;
  return { sessionId: session.id, sourceUserSeq: source.seq, source, attempt, receipt };
}
function fixture(count = 1) {
  const source = parent('root');
  const runs = Array.from({ length: count }, (_, index) => describeRun(`participant-${serial}-${index}`, source));
  const active = publishGroup(source, runs);
  const steps = runs.map(hostStep);
  return { source, runs, active, steps, read: () => readAcceptedTaskWorkflowParticipants(home, [source], proof) };
}
type Owner = { sessionId: string; sourceUserSeq: number; source: import('../../src/runtime/harness/eventlog.js').EventRow;
  attempt: import('../../src/runtime/harness/eventlog.js').RunAttemptRef };
function complete(owner: Owner): void {
  const outcomeId = `turn:${owner.sourceUserSeq}`;
  log.appendEvent({ sessionId: owner.sessionId, turn: owner.source.turn, role: 'system', type: 'conversation_completed', data: {
    sourceUserSeq: owner.sourceUserSeq, attemptId: owner.attempt.attemptId, terminalKey: outcomeId,
    presentation: { version: 1, id: `${outcomeId}:presentation`, outcomeId, audience: 'user', phase: 'final',
      identity: { sessionId: owner.sessionId, turn: owner.source.turn, sourceUserSeq: owner.sourceUserSeq,
        attemptId: owner.attempt.attemptId, runId: owner.attempt.runId },
      status: 'done', kind: 'answer', text: 'Controlled accounting fixture answer.', resumable: false },
    turnOutcome: { version: 2, id: outcomeId, status: 'done', resumable: false },
  } });
  log.finishRunAttempt(owner.attempt, 'completed');
}
function recordBound(owner: Owner, label: string, inputTokens: number, role: 'brain' | 'reviewer' | 'worker' = 'brain', failed = false): void {
  usage.withModelUsageAttribution({ sessionId: owner.sessionId, sourceUserSeq: owner.sourceUserSeq,
    attemptId: owner.attempt.attemptId, role }, () => usage.recordModelUsage({ sessionId: 'unknown',
    model: 'controlled-accounting-model', inputTokens, outputTokens: 1, cacheDialect: 'inclusive',
    responseId: `${label}-${owner.sourceUserSeq}`, trace: { modelCallId: `${label}-call-${owner.sourceUserSeq}` },
    ...(failed ? { ok: false, failReason: 'Controlled failed response accounting.' } : {}) }));
}

test('actual group and authored receipt producers bind only exact hosted step sources and attempts', () => {
  const f = fixture(2); const before = f.runs.map(run => readFileSync(run.file, 'utf8'));
  const result = f.read();
  assert.equal(result.participants.length, 2); assert.deepEqual(result.issues, []);
  for (const [index, step] of f.steps.entries()) {
    const participant = result.participants.find(row => row.sourceUserSeq === step.sourceUserSeq)!;
    assert.equal(participant.sourceGroupId, f.active.sealed.sourceGroupId);
    assert.equal(participant.sourceGroupDigest, f.active.sealed.sourceGroupDigest);
    assert.equal(participant.runId, f.runs[index]!.runId); assert.equal(participant.stepId, f.runs[index]!.stepId);
    assert.equal(participant.sessionId, step.sessionId); assert.deepEqual(participant.attemptIds, [step.attempt.attemptId]);
    assert.equal(participant.sourceReceiptDigest, step.receipt.data.authorityDigest);
    assert.deepEqual(participant.parentAcceptedSources, [`${f.source.sessionId}:${f.source.sourceUserSeq}`]);
    assert.equal(Object.hasOwn(participant, 'tokens'), false); assert.equal(Object.hasOwn(participant, 'completed'), false);
  }
  assert.deepEqual(result.claimedRunIds, f.runs.map(run => run.runId).sort());
  assert.deepEqual(readAcceptedTaskWorkflowParticipants(home, [f.source, f.source], proof), result);
  assert.deepEqual(f.runs.map(run => readFileSync(run.file, 'utf8')), before, 'read-only proof never rewrites queued/run descriptors');
  assert.doesNotMatch(JSON.stringify(result), /Inspect the controlled|Controlled hosted|Controlled immutable|Controlled workflow/);
});

test('failed and restarted attempts preserve exact source ownership while a foreign durable run stays only claimed', () => {
  const f = fixture(); const step = f.steps[0]!; const run = f.runs[0]!;
  log.finishRunAttempt(step.attempt, 'failed');
  const retry = log.beginRunAttempt(step.sessionId, { runId: `workflow-step:${run.runId}:${run.stepId}`, attemptId: `${step.attempt.attemptId}:retry` });
  log.recordRunAttemptUserInput(retry, { turn: 1, role: 'user', data: {} }, { existingEventSeq: step.sourceUserSeq });
  log.finishRunAttempt(retry, 'failed');
  const foreign = log.beginRunAttempt(step.sessionId, { runId: 'foreign-workflow-step', attemptId: `${step.attempt.attemptId}:foreign` });
  log.recordRunAttemptUserInput(foreign, { turn: 1, role: 'user', data: {} }, { existingEventSeq: step.sourceUserSeq });
  const record = JSON.parse(readFileSync(run.file, 'utf8')); writeFileSync(run.file, JSON.stringify({ ...record, status: 'failed' }));
  const result = f.read();
  assert.equal(result.participants.length, 1);
  assert.deepEqual(result.participants[0]?.attemptIds, [step.attempt.attemptId, retry.attemptId].sort());
  assert.ok(result.claimedAttemptIds.includes(foreign.attemptId));
  assert.ok(result.issues.includes('workflow_participant_foreign_attempt_claim'));
});

test('approval control claims await canonical card proof instead of becoming authored roots or automatic helper failures', () => {
  const f = fixture(); const step = f.steps[0]!;
  const control = log.appendEvent({ sessionId: step.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: {
    synthetic: true, source: 'approval_resume', approvalId: 'controlled-unproved-card', decision: 'approve',
  } });
  const result = f.read(); assert.equal(result.participants.length, 1); assert.deepEqual(result.issues, []);
  assert.equal(result.participants[0]?.sourceUserSeq, step.sourceUserSeq);
  assert.ok(result.claimedSources.some(row => row.sourceUserSeq === control.seq));
  assert.equal(result.participants.some(row => row.sourceUserSeq === control.seq), false,
    'a serialized control hint is not proof of approval or usage ownership');
});

test('later valid observer membership cannot inherit the original creation group cost', () => {
  const f = fixture(); const late = parent('observer');
  const observed = publishGroup(late, f.runs);
  assert.ok(groups.readActiveWorkflowOriginGroup(observed.sealed.sourceGroupId), 'this is a valid durable later observer group');
  const result = readAcceptedTaskWorkflowParticipants(home, [late], proof);
  assert.equal(result.participants.length, 0); assert.deepEqual(result.claimedRunIds, f.runs.map(run => run.runId));
  assert.ok(result.claimedSources.some(row => row.sourceUserSeq === f.steps[0]!.sourceUserSeq));
  assert.ok(result.issues.includes('workflow_participant_run_creation_binding_unproved'));
});

test('contrary source target and dispatch target cannot borrow an otherwise valid group', () => {
  for (const variant of ['source-target', 'dispatch-target', 'dispatch-digest'] as const) {
    const f = fixture();
    const row = variant === 'source-target' ? f.source.source
      : log.listEvents(f.source.sessionId, { types: ['async_work_dispatched'] })[0]!;
    const data = { ...row.data };
    if (variant === 'source-target') data.originReplyTargetDigest = 'f'.repeat(64);
    if (variant === 'dispatch-target') data.replyTarget = { type: 'discord_channel', channelId: 'controlled-foreign-route' };
    if (variant === 'dispatch-digest') data.sourceGroupDigest = 'f'.repeat(64);
    log.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?').run(JSON.stringify(data), row.id);
    const result = f.read(); assert.equal(result.participants.length, 0);
    assert.ok(result.issues.includes('workflow_participant_dispatch_binding_unproved'));
  }
});

test('source, authored receipt and admitted descriptor forgeries stay unproved without losing claims', () => {
  for (const variant of ['source', 'parent', 'duplicate-receipt', 'rehash-prompt', 'snapshot', 'creation-group', 'queue-digest'] as const) {
    const f = fixture(); const step = f.steps[0]!; const run = f.runs[0]!;
    if (variant === 'source') log.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...step.source.data, stepId: 'foreign-step' }), step.source.id);
    if (variant === 'parent') log.openEventLog().prepare('UPDATE events SET parent_event_id = ? WHERE id = ?')
      .run('foreign-source-event', step.receipt.id);
    if (variant === 'duplicate-receipt') log.appendEvent({ sessionId: step.sessionId, turn: 1, role: 'system',
      type: 'authored_workflow_write_authority', parentEventId: step.source.id, data: step.receipt.data });
    if (variant === 'rehash-prompt') {
      const altered: Record<string, unknown> = { ...step.receipt.data, promptDigest: 'f'.repeat(64) };
      const { authorityDigest: _old, ...body } = altered;
      log.openEventLog().prepare('UPDATE events SET data_json = ? WHERE id = ?')
        .run(closedCanonicalJson({ ...body, authorityDigest: digest(body) }), step.receipt.id);
    }
    if (['snapshot', 'creation-group', 'queue-digest'].includes(variant)) {
      const record = JSON.parse(readFileSync(run.file, 'utf8'));
      if (variant === 'snapshot') delete record.workflowDefinitionSnapshot;
      if (variant === 'creation-group') record.chatDispatchSourceGroupId = 'foreign-creation-group';
      if (variant === 'queue-digest') record.chatDispatchQueueRequestDigest = 'f'.repeat(64);
      writeFileSync(run.file, JSON.stringify(record));
    }
    const result = f.read(); assert.equal(result.participants.length, 0, variant);
    assert.ok(result.claimedRunIds.includes(run.runId)); assert.ok(result.claimedAttemptIds.includes(step.attempt.attemptId));
    assert.ok(result.issues.length > 0); assert.doesNotMatch(JSON.stringify(result), /Controlled hosted|Inspect the controlled/);
  }
});

test('missing legacy receipt and namespace-only workflow rows cannot establish a hosted participant', () => {
  const f = fixture(); const step = f.steps[0]!;
  log.openEventLog().prepare('DELETE FROM events WHERE id = ?').run(step.receipt.id);
  log.createSession({ id: `workflow:${f.runs[0]!.runId}:namespace-only`, kind: 'workflow', channel: 'workflow' });
  const result = f.read(); assert.equal(result.participants.length, 0);
  assert.deepEqual(result.claimedSources, [{ sessionId: step.sessionId, sourceUserSeq: step.sourceUserSeq }]);
  assert.ok(result.issues.includes('workflow_participant_authored_receipt_unproved'));
});

test('settled compacted group retention keeps a retained sibling exact and a reaped run descriptor unknown', () => {
  const f = fixture(2); const detail = 'Controlled terminal fixture.';
  const receipt = groups.createWorkflowOriginGroupSettlementReceipt({ sourceGroupId: f.active.sealed.sourceGroupId,
    exactDeliveryReceipt: exactOriginDeliveryReceiptForTarget(f.active.sealed.replyTarget)!,
    notificationId: `workflow-origin-group-${f.active.sealed.sourceGroupDigest}`,
    terminal: { eventId: `controlled-terminal-${serial}`, outcomeId: `turn:${f.source.sourceUserSeq}`, sessionId: f.source.sessionId,
      sourceUserSeq: f.source.sourceUserSeq, turn: 1, runId: f.active.sealed.sourceGroupId, status: 'done', text: detail },
    memberReportBackDigests: f.runs.map(run => ({ runId: run.runId,
      reportBackDigest: groups.workflowRunReportBackContentDigest({ workflowName: run.slug, outcome: 'done', detail }) })),
    settledAt: new Date().toISOString(),
  });
  groups.recordWorkflowOriginGroupSettlement(receipt);
  for (const run of f.runs) {
    const record = JSON.parse(readFileSync(run.file, 'utf8'));
    const reportBackDigest = groups.workflowRunReportBackContentDigest({ workflowName: run.slug, outcome: 'done', detail });
    writeFileSync(run.file, JSON.stringify({ ...record, status: 'completed', reportBack: { version: 1, workflowName: run.slug,
      outcome: 'done', detail, acknowledgedOriginSessionIds: [], acknowledgedOriginObserverIds: [f.active.sealed.observerId],
      acknowledgedOriginObserverSettlements: { [f.active.sealed.observerId]: { settlementDigest: receipt.settlementDigest, reportBackDigest } } },
      reportBackAcknowledgedAt: new Date().toISOString() }));
  }
  groups.compactSettledWorkflowOriginGroup(f.active.sealed.sourceGroupId);
  rmSync(f.runs[0]!.file);
  const result = f.read(); assert.equal(result.participants.length, 1);
  assert.equal(result.participants[0]?.runId, f.runs[1]!.runId);
  assert.deepEqual(result.claimedRunIds, f.runs.map(run => run.runId).sort());
  assert.ok(result.issues.includes('workflow_participant_run_creation_binding_unproved'));
});

test('ordinary optional-schema reads never create or migrate a passed home', () => {
  const ordinary = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-participants-ordinary-'));
  try {
    mkdirSync(path.join(ordinary, 'state')); const db = new Database(path.join(ordinary, 'state', 'harness.db'));
    db.exec(`CREATE TABLE events (seq INTEGER, session_id TEXT, turn INTEGER, role TEXT, type TEXT, data_json TEXT);
      INSERT INTO events VALUES (1,'sms:+15550000000',1,'user','user_input_received','{}');`); db.close();
    const before = readdirSync(path.join(ordinary, 'state'));
    assert.deepEqual(readAcceptedTaskWorkflowParticipants(ordinary, [{ sessionId: 'sms:+15550000000', sourceUserSeq: 1 }], proof), {
      participants: [], claimedRunIds: [], claimedSources: [], claimedAttemptIds: [], issues: [],
    });
    assert.deepEqual(readdirSync(path.join(ordinary, 'state')), before);
    assert.deepEqual(readAcceptedTaskWorkflowParticipants(ordinary, [], proof).issues, []);
  } finally { rmSync(ordinary, { recursive: true, force: true }); }
});

test('canonical task accounting unions hosted brain, review, memory and failure rows once without expanding foreground time or authority', () => {
  const f = fixture(); const step = f.steps[0]!; const run = f.runs[0]!;
  log.finishRunAttempt(step.attempt, 'failed'); complete(f.source);
  const before = comparison.measureAcceptedTask(home, f.source.sessionId, f.source.sourceUserSeq);
  recordBound(f.source, 'foreground', 10);
  recordBound(step, 'hosted-brain', 20);
  recordBound(step, 'hosted-review', 3, 'reviewer');
  recordBound(step, 'hosted-failure', 5, 'reviewer', true);
  usage.withModelUsageAttribution({ sessionId: '', sourceUserSeq: 0,
    memoryAccountingOrigin: usage.createMemoryAccountingOrigin({ sessionId: step.sessionId,
      sourceUserSeq: step.sourceUserSeq, attemptId: step.attempt.attemptId }),
    usageJobId: `memory:skills:controlled-bound-${step.sourceUserSeq}`, channel: 'memory:skills', role: 'memory',
  }, () => usage.recordModelUsage({ sessionId: 'unknown', model: 'controlled-memory-model', inputTokens: 4, outputTokens: 1,
    cacheDialect: 'inclusive', responseId: `memory-bound-${step.sourceUserSeq}`, trace: { modelCallId: `memory-bound-call-${step.sourceUserSeq}` } }));
  // The group establishes ownership metadata, never a source ancestry edge
  // that could pair a foreground trace with a hosted physical attempt.
  usage.recordModelUsage({ sessionId: f.source.sessionId, sourceUserSeq: f.source.sourceUserSeq,
    attemptId: step.attempt.attemptId, model: 'controlled-forged-model', inputTokens: 100, outputTokens: 1,
    cacheDialect: 'inclusive', responseId: `forged-splice-${step.sourceUserSeq}` });
  usage.recordModelUsage({ sessionId: `workflow:${run.runId}`, model: 'controlled-run-level-model', inputTokens: 7, outputTokens: 1,
    cacheDialect: 'inclusive', responseId: `run-only-${step.sourceUserSeq}` });
  usage.withModelUsageAttribution({ sessionId: '', sourceUserSeq: 0, memoryAccountingOrigin: usage.createMemoryAccountingOrigin(),
    usageJobId: `memory:skills:controlled-unbound-${step.sourceUserSeq}`, channel: 'memory:skills', role: 'memory',
  }, () => usage.recordModelUsage({ sessionId: 'unknown', model: 'controlled-unbound-model', inputTokens: 200, outputTokens: 1,
    cacheDialect: 'inclusive', responseId: `unbound-memory-${step.sourceUserSeq}` }));
  const unrelated = parent('foreign-accounting'); complete(unrelated); recordBound(unrelated, 'foreign-task', 999);

  const measured = comparison.measureAcceptedTask(home, f.source.sessionId, f.source.sourceUserSeq);
  assert.equal(measured.workflowUsageParticipants.length, 1); assert.equal(measured.workflowExactUsageRecords, 4);
  assert.equal(measured.exactUsageRecords, 5); assert.equal(measured.usageRecords, 5);
  assert.equal(measured.promptTokens, 42); assert.equal(measured.outputTokens, 5);
  assert.equal(measured.unprovenUsage.usageRecords, 2); assert.equal(measured.unprovenUsage.promptTokens, 107);
  assert.equal(measured.usageCompleteness.recordedTokenRows.failed, 1);
  assert.deepEqual(measured.sourceUserSeqs, [f.source.sourceUserSeq]); assert.equal(measured.attemptCount, 1);
  assert.equal(measured.unfinishedAttempts, 0); assert.equal(measured.workflowAttemptCount, 1);
  assert.equal(measured.unfinishedWorkflowAttempts, 0);
  assert.equal(measured.taskWallMs, before.taskWallMs); assert.equal(measured.segmentWallMs, before.segmentWallMs);
  assert.equal(measured.terminalSeq, before.terminalSeq);
  assert.deepEqual(measured.workflowUsageScope, { scope: 'recorded_hosted_steps_only', servingIdentity: 'not_measured', executionWindowUnaffected: true });
  assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
  assert.deepEqual(comparison.measureAcceptedTask(home, f.source.sessionId, f.source.sourceUserSeq), measured);
});

test('canonical accounting keeps missing-receipt and later-observer workflow spend unproven', () => {
  for (const variant of ['missing-receipt', 'later-observer'] as const) {
    const f = fixture(); const step = f.steps[0]!; log.finishRunAttempt(step.attempt, 'completed');
    let owner = f.source;
    if (variant === 'missing-receipt') log.openEventLog().prepare('DELETE FROM events WHERE id = ?').run(step.receipt.id);
    else { owner = parent('canonical-late-observer'); publishGroup(owner, f.runs); }
    complete(owner); recordBound(owner, `foreground-${variant}`, 10); recordBound(step, `unproved-hosted-${variant}`, 20);
    const measured = comparison.measureAcceptedTask(home, owner.sessionId, owner.sourceUserSeq);
    assert.equal(measured.workflowUsageParticipants.length, 0, variant); assert.equal(measured.workflowExactUsageRecords, 0, variant);
    assert.equal(measured.exactUsageRecords, 1); assert.equal(measured.promptTokens, 10);
    assert.equal(measured.unprovenUsage.usageRecords, 1); assert.equal(measured.unprovenUsage.promptTokens, 20);
    assert.deepEqual(measured.sourceUserSeqs, [owner.sourceUserSeq]); assert.equal(measured.attemptCount, 1);
    assert.ok(measured.workflowUsageIssues.length > 0); assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
  }
});

test('canonical hosted approval accounting uses exact card and resume proof while leaving the foreground source unchanged', () => {
  const f = fixture(); const step = f.steps[0]!;
  recordBound(step, 'before-approval', 11); log.finishRunAttempt(step.attempt, 'interrupted');
  const card = approvals.register({ sessionId: step.sessionId, channel: 'workflow', subject: 'Controlled accounting-only fixture card.' });
  const resolved = approvals.resolve(card.approvalId, 'approved', 'controlled-fixture-owner');
  assert.equal(resolved.ok, true); assert.equal(resolved.row?.resolution, 'approved');
  const resumed = log.beginRunAttempt(step.sessionId, { runId: `workflow-step:${f.runs[0]!.runId}:${f.runs[0]!.stepId}`,
    attemptId: `${step.attempt.attemptId}:approved-control` });
  const control = log.recordRunAttemptUserInput(resumed, { turn: 2, role: 'user', data: {
    source: 'approval_resume', synthetic: true, approvalId: card.approvalId, decision: 'approve',
  } });
  log.appendEvent({ sessionId: step.sessionId, turn: 2, role: 'system', type: 'run_resumed', data: {
    approvalId: card.approvalId, decision: 'approve', deliverySourceUserSeq: control.seq,
    executionSourceUserSeq: step.sourceUserSeq, reviewContinuationVersion: 1,
  } });
  const controlOwner = { sessionId: step.sessionId, sourceUserSeq: control.seq, source: control, attempt: resumed };
  recordBound(controlOwner, 'after-approval', 13, 'reviewer'); complete(controlOwner); complete(f.source); recordBound(f.source, 'approval-root', 10);
  const measured = comparison.measureAcceptedTask(home, f.source.sessionId, f.source.sourceUserSeq);
  assert.equal(measured.workflowUsageParticipants.length, 1); assert.equal(measured.workflowApprovalContinuations.length, 1);
  assert.equal(measured.workflowApprovalContinuations[0]?.sessionId, step.sessionId);
  assert.equal(measured.workflowApprovalContinuations[0]?.executionSourceUserSeq, step.sourceUserSeq);
  assert.equal(measured.workflowApprovalContinuations[0]?.controlSourceUserSeq, control.seq);
  assert.equal(measured.workflowExactUsageRecords, 2); assert.equal(measured.exactUsageRecords, 3);
  assert.equal(measured.promptTokens, 34); assert.deepEqual(measured.sourceUserSeqs, [f.source.sourceUserSeq]);
  assert.equal(measured.attemptCount, 1); assert.equal(measured.workflowAttemptCount, 2);
  assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
});

test('canonical hosted workers require their actual parent lease attempt to belong to the admitted workflow source', () => {
  for (const variant of ['admitted-parent', 'foreign-run-parent'] as const) {
    const f = fixture(); const step = f.steps[0]!;
    let parentAttempt = step.attempt;
    if (variant === 'foreign-run-parent') {
      log.finishRunAttempt(step.attempt, 'failed');
      parentAttempt = log.beginRunAttempt(step.sessionId, { runId: `foreign-run-${serial}`,
        attemptId: `${step.attempt.attemptId}:foreign-worker-owner` });
      log.recordRunAttemptUserInput(parentAttempt, { turn: 1, role: 'user', data: {} }, { existingEventSeq: step.sourceUserSeq });
    }
    const armed = callAuthority.armHostCallAuthority({ sessionId: step.sessionId, sourceUserSeq: step.sourceUserSeq,
      catalogRevisionDigest: 'a'.repeat(64), bindingRevisionDigest: 'b'.repeat(64), maxLogicalCalls: 10, maxParallelCalls: 2 });
    assert.equal(armed.status, 'armed', 'the controlled source owns an actual durable parent-call root');
    const callId = `controlled-worker-call-${serial}`;
    const packet = { objective: 'Inspect the controlled accounting item.', item: `controlled-item-${serial}`,
      externalMcpToolNames: [], model: 'controlled-accounting-model' };
    const lineage = { parentSessionId: step.sessionId, parentSourceUserSeq: step.sourceUserSeq,
      parentAcceptedTaskId: `task:${step.sessionId}#${step.sourceUserSeq}`, parentLogicalCallId: callId,
      packetKey: `controlled-packet-${serial}`, packetDigest: createHash('sha256').update(JSON.stringify(packet)).digest('hex'), item: packet.item };
    const material = contracts.durableLogicalCallRecoveryMaterial(lineage.parentAcceptedTaskId, 'run_worker', { item: packet.item })!;
    log.openEventLog().prepare(`INSERT INTO logical_tool_calls
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id, tool_name, argument_digest, raw_argument_digest, state, opened_at)
      VALUES (?, ?, ?, ?, 'run_worker', ?, ?, 'open', ?)`).run(step.sessionId, step.sourceUserSeq,
      lineage.parentAcceptedTaskId, callId, material.argumentDigest, material.argumentDigest, new Date().toISOString());
    const parentLease = leases.activateDispatchLease({ sessionId: step.sessionId, scopeId: `${step.sessionId}::${callId}`,
      runAttemptId: parentAttempt.attemptId, sourceUserSeq: step.sourceUserSeq, acceptedTaskId: lineage.parentAcceptedTaskId,
      logicalToolCallId: callId, recovery: { material, effect: 'local_write', businessCall: false } });
    const child = log.createSession({ id: `controlled-workflow-worker-${serial}`, kind: 'agent',
      metadata: { source: 'delegated_worker', workerScope: true, ...lineage } });
    const attempt = log.beginRunAttempt(child.id, { runId: `controlled-worker-run-${serial}` });
    const source = log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', parentEventId: step.source.id,
      data: { text: 'Inspect the controlled delegated item.', delegatedWorker: { ...lineage, composeOnly: true, packet } } });
    log.appendEvent({ sessionId: step.sessionId, turn: 1, role: 'system', type: 'worker_started', data: {
      ...lineage, childSessionId: child.id, childSourceUserSeq: source.seq, childAttemptId: attempt.attemptId,
    } });
    // This is a genuine reciprocal lease admitted by the existing runtime.
    // In the negative case it genuinely belongs to B, a different durable run
    // sharing A's accepted source; that does not make B a workflow participant.
    const childLease = leases.activateDispatchLease({ sessionId: child.id, scopeId: `${child.id}::host`,
      runAttemptId: attempt.attemptId, parentLease });
    assert.equal(childLease.parentLeaseId, parentLease.leaseId);
    const worker = { sessionId: child.id, sourceUserSeq: source.seq, source, attempt };
    const label = `hosted-worker-${variant}-${serial}`;
    recordBound(worker, label, 17, 'worker');
    log.appendEvent({ sessionId: child.id, turn: 1, role: 'system', type: 'worker_model_response_completed', data: {
      sourceUserSeq: source.seq, runAttemptId: attempt.attemptId, modelCallId: `${label}-call-${source.seq}`,
      model: 'controlled-accounting-model', providerResponseIdDigest: createHash('sha256').update(`${label}-${source.seq}`).digest('hex'),
    } });
    log.appendEvent({ sessionId: child.id, turn: 1, role: 'system', type: 'model_stream_diagnostic', data: {
      sourceUserSeq: source.seq, attemptId: attempt.attemptId, responseId: `${label}-${source.seq}`,
      settlement: 'completed', sawResponseDone: true,
    } });
    complete(worker); log.finishRunAttempt(parentAttempt, 'completed');
    recordBound(step, `hosted-parent-${variant}`, 11); complete(f.source); recordBound(f.source, `worker-root-${variant}`, 10);
    const measured = comparison.measureAcceptedTask(home, f.source.sessionId, f.source.sourceUserSeq);
    assert.equal(measured.workflowUsageParticipants.length, 1); assert.equal(measured.workflowExactUsageRecords, 1);
    assert.deepEqual(measured.sourceUserSeqs, [f.source.sourceUserSeq]); assert.equal(measured.attemptCount, 1);
    assert.equal(measured.workflowAttemptCount, 1); assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
    if (variant === 'admitted-parent') {
      assert.deepEqual(measured.workerUsageParticipants.map(row => [row.sessionId, row.sourceUserSeq]), [[child.id, source.seq]]);
      assert.equal(measured.exactUsageRecords, 3); assert.equal(measured.promptTokens, 38);
      assert.equal(measured.unprovenUsage.usageRecords, 0); assert.deepEqual(measured.workerLineageIssues, []);
    } else {
      assert.deepEqual(measured.workerUsageParticipants, []); assert.equal(measured.exactUsageRecords, 2);
      assert.equal(measured.promptTokens, 21); assert.equal(measured.unprovenUsage.usageRecords, 1);
      assert.equal(measured.unprovenUsage.promptTokens, 17);
      assert.ok(measured.workerLineageIssues.includes(`unproved_worker_attempt:${child.id}:${source.seq}:${attempt.attemptId}`));
    }
  }
});
