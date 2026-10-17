import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { readAcceptedTaskNoticingParticipants } from './accepted-task-noticing-participants.js';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ids = { answer: 'noticing-job:11111111-1111-4111-8111-111111111111',
  proposal: 'noticing-job:22222222-2222-4222-8222-222222222222',
  failed: 'noticing-job:33333333-3333-4333-8333-333333333333',
  foreign: 'noticing-job:44444444-4444-4444-8444-444444444444' };
type Tuple = { usageJobId: string; operation: 'noticing_answer' | 'noticing_proposal'; operationId: string; revisionDigest: string };
function fixture(t: TestContext) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-noticing-participants-'));
  mkdirSync(path.join(home, 'state')); mkdirSync(path.join(home, 'check-ins'));
  const harness = new Database(path.join(home, 'state', 'harness.db'));
  harness.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY, session_id TEXT, role TEXT, type TEXT, data_json TEXT);
    CREATE TABLE harness_chat_requests (request_id TEXT PRIMARY KEY, session_id TEXT, run_id TEXT, input_hash TEXT, since_seq INTEGER);`);
  const operational = new Database(path.join(home, 'state', 'operational-telemetry.db'));
  operational.exec(`CREATE TABLE operational_events (event_id TEXT PRIMARY KEY, ts TEXT, source TEXT, type TEXT,
    actor TEXT, model_call_id TEXT, session_id TEXT, workflow_run_id TEXT, workflow_node_run_id TEXT, tool_call_id TEXT, payload_json TEXT);`);
  t.after(() => { harness.close(); operational.close(); rmSync(home, { recursive: true, force: true }); });
  const at = '2026-10-17T12:00:00.000Z';
  const packet = { version: 1, proposal: { id: 'controlled-proposal', checkInId: 'chk-controlled',
    title: 'Controlled private fixture title', action: 'Prepare the controlled private fixture.', why: 'Controlled private reason.',
    evidence: ['controlled private evidence'], goalId: null, createdAt: at },
    checkIn: { id: 'chk-controlled', question: 'Controlled private question?', contextSummary: 'noticing:controlled-proposal',
      answer: 'Controlled private answer; draft only.', answeredAt: at },
    decision: { kind: 'do_it' }, constraints: { rules: ['controlled private standing rule'], standingAnswers: [] }, goal: null };
  const source = { sessionId: 'sess-controlled-noticing', sourceUserSeq: 4 };
  const requestId = 'controlled-noticing-request'; const runId = 'controlled-noticing-run';
  const sourceData = { source: 'noticing_answer', runId, text: packet.checkIn.answer, displayText: packet.checkIn.answer,
    noticingApprovedTask: { requestId, digest: hash(packet), packet } };
  harness.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)').run(source.sourceUserSeq, source.sessionId,
    'user', 'user_input_received', JSON.stringify(sourceData));
  harness.prepare('INSERT INTO harness_chat_requests VALUES (?, ?, ?, ?, ?)').run(requestId, source.sessionId, runId, hash(packet), 0);
  const answerDigest = hash({ proposalId: packet.proposal.id, checkInId: packet.checkIn.id,
    answer: packet.checkIn.answer, answeredAt: packet.checkIn.answeredAt });
  const answer: Tuple = { usageJobId: ids.answer, operation: 'noticing_answer', operationId: packet.checkIn.id, revisionDigest: answerDigest };
  const proposal: Tuple = { usageJobId: ids.proposal, operation: 'noticing_proposal', operationId: 'ntc-controlled', revisionDigest: 'a'.repeat(64) };
  const savedAnswer = { text: packet.checkIn.answer, decision: 'do_it', at, modelAccountingJobId: answer.usageJobId };
  const thinking = { tickId: proposal.operationId, at, source: 'heartbeat', durationMs: 10,
    read: { goals: 1, runs: 0, waits: 0, drafts: 0, calendar: 0, conversations: 0, memories: 0 },
    considered: [], proposalId: packet.proposal.id, model: 'controlled-model', modelAccountingJobId: proposal.usageJobId,
    quiet: false, summary: 'Controlled private thinking.' };
  const state = { version: 1, proposals: { [packet.proposal.id]: { ...packet.proposal, shapeKey: 'shape', confidence: 0.9,
    status: 'answered', answer: savedAnswer, handoff: { version: 1, answerDigest, state: 'dispatched', updatedAt: at,
      sessionId: source.sessionId, sourceUserSeq: source.sourceUserSeq, requestId } } }, thinking: [thinking] };
  const stateFile = path.join(home, 'state', 'noticing.json');
  const saveState = () => writeFileSync(stateFile, JSON.stringify(state)); saveState();
  writeFileSync(path.join(home, 'check-ins', `${packet.checkIn.id}.json`), JSON.stringify({ ...packet.checkIn,
    status: 'answered', agentSlug: 'clementine', askedAt: at, urgency: 'normal' }));
  let eventIndex = 0;
  const event = (own: Tuple, phase: string, extra: Record<string, unknown> = {}, options: { actor?: string; parent?: string } = {}) => {
    const transport = !['job_started', 'job_finished', 'operation_receipt'].includes(phase);
    const payload = { version: 1, ownerKind: 'accounting_job', ...own, phase, at: 1000 + eventIndex++, clock: 'host_epoch_ms',
      ...(transport ? { modelCallId: `call-${own.operation}`, physicalAttempt: 1, purpose: 'reviewer', journalFailed: false } : {}), ...extra };
    operational.prepare('INSERT INTO operational_events VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)').run(
      `event-${eventIndex}`, at, 'model', 'model_accounting_observed', options.actor ?? (transport ? 'model-transport-observation' : 'noticing'),
      transport ? payload.modelCallId : null, options.parent ?? null, JSON.stringify(payload));
  };
  const retain = (own: Tuple, receipt: unknown) => {
    event(own, 'job_started'); event(own, 'job_finished', { outcome: 'returned', usage: 'unknown' });
    event(own, 'operation_receipt', { receiptDigest: hash(receipt) });
  };
  const completed = (own: Tuple) => {
    const responseDigest = (own.operation === 'noticing_answer' ? 'b' : 'c').repeat(64);
    event(own, 'adapter_attempt_created', { resultScope: 'local_adapter_attempt', dispatchIds: [] });
    event(own, 'dispatch_started', { dispatchId: 'controlled-dispatch' });
    event(own, 'model_result_completed', { resultScope: 'original_sdk_response', hostResultReceiptId: 'controlled-original-receipt',
      dispatchIds: ['controlled-dispatch'], providerResponseIdDigest: responseDigest });
    event(own, 'adapter_attempt_finished', { resultScope: 'original_sdk_response', outcome: 'returned', usage: 'unknown',
      providerResponseIdDigest: responseDigest });
  };
  return { home, harness, operational, source, sourceData, packet, state, stateFile, saveState, answer, proposal,
    savedAnswer, thinking, event, retain, completed };
}

test('exact retained answer and proposal jobs expose original response bindings without inventing usage or authority', t => {
  const f = fixture(t); f.retain(f.answer, f.savedAnswer); f.retain(f.proposal, f.thinking);
  f.completed(f.answer); f.completed(f.proposal);
  const before = readFileSync(f.stateFile, 'utf8'); const schema = f.harness.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
  const result = readAcceptedTaskNoticingParticipants(f.home, [f.source, f.source]);
  assert.equal(result.jobs.length, 2); assert.deepEqual(result.claimedJobIds, [ids.answer, ids.proposal]);
  assert.deepEqual(result.issues, []);
  for (const job of result.jobs) {
    assert.deepEqual(job.parentAcceptedSources, [`${f.source.sessionId}:${f.source.sourceUserSeq}`]);
    assert.equal(job.responseBindings.length, 1);
    assert.equal(job.responseBindings[0]?.providerResponseIdDigest, (job.operation === 'noticing_answer' ? 'b' : 'c').repeat(64));
    assert.equal(job.responseBindings[0]?.physicalAttempt, 1); assert.equal(typeof job.startedAt, 'number');
    assert.ok(job.finishedAt! >= job.startedAt!); assert.equal(Object.hasOwn(job, 'tokens'), false);
    assert.equal(Object.hasOwn(job, 'sourceUserSeq'), false);
  }
  assert.doesNotMatch(JSON.stringify(result), /Controlled private|controlled private|standing rule|thinking/);
  assert.equal(readFileSync(f.stateFile, 'utf8'), before);
  assert.deepEqual(f.harness.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(), schema);
  assert.deepEqual(readdirSync(path.join(f.home, 'state')).sort(), ['harness.db', 'noticing.json', 'operational-telemetry.db']);
});

test('ordinary accepted sources need no Noticing request, check-in, state or operational tables', t => {
  const f = fixture(t);
  f.harness.prepare('UPDATE events SET data_json = ?').run(JSON.stringify({ text: 'ordinary private task' }));
  f.harness.exec('DROP TABLE harness_chat_requests'); rmSync(f.stateFile);
  rmSync(path.join(f.home, 'check-ins'), { recursive: true }); f.operational.exec('DROP TABLE operational_events');
  assert.deepEqual(readAcceptedTaskNoticingParticipants(f.home, [f.source]), { jobs: [], claimedJobIds: [], issues: [] });
});

test('ordinary established phone and Unicode session IDs do not become Noticing gaps', t => {
  for (const sessionId of ['sms:+15550000000', 'chat:contrôle-会話']) {
    const f = fixture(t); f.source.sessionId = sessionId;
    f.harness.prepare('UPDATE events SET session_id = ?, data_json = ?').run(sessionId, JSON.stringify({ text: 'ordinary controlled task' }));
    f.harness.exec('DROP TABLE harness_chat_requests'); f.operational.exec('DROP TABLE operational_events'); rmSync(f.stateFile);
    assert.deepEqual(readAcceptedTaskNoticingParticipants(f.home, [f.source]), { jobs: [], claimedJobIds: [], issues: [] });
  }
});

test('foreign exact tuples, forged parent scope and conflicting job reuse cannot supply a response binding', t => {
  for (const variant of ['foreign-revision', 'foreign-parent', 'foreign-actor', 'conflicting-job'] as const) {
    const f = fixture(t); f.retain(f.answer, f.savedAnswer);
    f.state.thinking = []; f.saveState();
    if (variant === 'foreign-revision') f.completed({ ...f.answer, revisionDigest: 'f'.repeat(64) });
    if (variant === 'conflicting-job') f.event({ ...f.answer, operationId: 'chk-foreign' }, 'job_started');
    if (variant === 'foreign-parent') f.event(f.answer, 'model_result_completed', { resultScope: 'original_sdk_response',
      providerResponseIdDigest: 'b'.repeat(64) }, { parent: 'foreign-turn' });
    if (variant === 'foreign-actor') f.event(f.answer, 'model_result_completed', { resultScope: 'original_sdk_response',
      providerResponseIdDigest: 'b'.repeat(64) }, { actor: 'foreign-writer' });
    const result = readAcceptedTaskNoticingParticipants(f.home, [f.source]);
    assert.ok(result.claimedJobIds.includes(ids.answer));
    assert.equal(result.jobs.flatMap(job => job.responseBindings).length, 0, variant);
    if (variant !== 'foreign-actor') assert.equal(result.jobs.length, 0, variant);
    assert.ok(result.issues.length > 0);
  }
});

test('failed exact answer retries stay visible as unproved claims while foreign revisions stay unrelated', t => {
  const f = fixture(t); f.retain(f.answer, f.savedAnswer); f.state.thinking = []; f.saveState();
  const failed = { ...f.answer, usageJobId: ids.failed };
  f.event(failed, 'job_started'); f.event(failed, 'job_finished', { outcome: 'failed', usage: 'unknown' });
  f.event({ ...failed, usageJobId: ids.foreign, revisionDigest: 'e'.repeat(64) }, 'job_started');
  const result = readAcceptedTaskNoticingParticipants(f.home, [f.source]);
  assert.deepEqual(result.claimedJobIds, [ids.answer, ids.failed]); assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0]?.usageJobId, ids.answer); assert.deepEqual(result.jobs[0]?.responseBindings, []);
  assert.ok(result.issues.includes('noticing_unproved_job_claim')); assert.ok(result.issues.includes('noticing_original_response_unknown'));
});

test('missing receipt events and rotated proposal history remain unknown instead of latest or title matches', t => {
  const f = fixture(t); f.retain(f.proposal, f.thinking);
  f.state.thinking = [{ ...f.thinking, proposalId: 'foreign-proposal', modelAccountingJobId: ids.foreign }]; f.saveState();
  f.event(f.answer, 'job_started'); f.event(f.answer, 'job_finished', { outcome: 'returned', usage: 'unknown' });
  const result = readAcceptedTaskNoticingParticipants(f.home, [f.source]);
  assert.equal(result.jobs.length, 0); assert.deepEqual(result.claimedJobIds, [ids.answer]);
  assert.ok(result.issues.includes('noticing_proposal_job_receipt_unavailable'));
  assert.ok(result.issues.includes('noticing_operation_receipt_unproved'));
});

test('missing operation state still inventories exact answer job claims without promoting them', t => {
  const f = fixture(t); f.event(f.answer, 'job_started'); rmSync(f.stateFile);
  const result = readAcceptedTaskNoticingParticipants(f.home, [f.source]);
  assert.equal(result.jobs.length, 0); assert.deepEqual(result.claimedJobIds, [ids.answer]);
  assert.ok(result.issues.includes('noticing_operation_state_unavailable'));
});

test('invalid packet, first-source, saved revision and check-in bindings cannot borrow current jobs', t => {
  for (const variant of ['packet', 'first-source', 'saved-answer', 'saved-proposal', 'check-in', 'control'] as const) {
    const f = fixture(t); f.retain(f.answer, f.savedAnswer); f.retain(f.proposal, f.thinking);
    if (variant === 'packet') f.sourceData.noticingApprovedTask.digest = 'c'.repeat(64);
    if (variant === 'control') f.sourceData.source = 'approval_control';
    f.harness.prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(JSON.stringify(f.sourceData), f.source.sourceUserSeq);
    if (variant === 'first-source') f.harness.prepare('INSERT INTO events VALUES (1, ?, ?, ?, ?)')
      .run(f.source.sessionId, 'user', 'user_input_received', '{}');
    if (variant === 'saved-answer') f.state.proposals[f.packet.proposal.id]!.answer.text = 'later private answer';
    if (variant === 'saved-proposal') f.state.proposals[f.packet.proposal.id]!.action = 'later private action';
    if (variant === 'check-in') writeFileSync(path.join(f.home, 'check-ins', `${f.packet.checkIn.id}.json`), JSON.stringify({
      ...f.packet.checkIn, status: 'answered', agentSlug: 'foreign-agent' }));
    f.saveState();
    const result = readAcceptedTaskNoticingParticipants(f.home, [f.source]);
    assert.equal(result.jobs.length, 0, variant); assert.ok(result.issues.length > 0);
    assert.doesNotMatch(JSON.stringify(result), /later private|Controlled private|foreign-agent/);
  }
});

test('raw Claude original no-fetch retirement remains unknown to this dispatch-completion reader', t => {
  const f = fixture(t); f.retain(f.answer, f.savedAnswer); f.state.thinking = []; f.saveState();
  f.event(f.answer, 'adapter_attempt_created', { resultScope: 'local_adapter_attempt', dispatchIds: [] });
  f.event(f.answer, 'adapter_attempt_finished', { resultScope: 'original_sdk_response', outcome: 'returned',
    dispatchIds: [], providerResponseIdDigest: 'b'.repeat(64), usage: 'unknown' });
  const result = readAcceptedTaskNoticingParticipants(f.home, [f.source]);
  assert.equal(result.jobs.length, 1); assert.deepEqual(result.jobs[0]?.responseBindings, []);
  assert.ok(result.issues.includes('noticing_original_response_unknown'));
});

test('duplicate or contrary attempt finishes cannot prove original response usage', t => {
  for (const variant of ['duplicate', 'digest', 'journal'] as const) {
    const f = fixture(t); f.retain(f.answer, f.savedAnswer); f.state.thinking = []; f.saveState(); f.completed(f.answer);
    if (variant === 'duplicate') f.event(f.answer, 'adapter_attempt_finished', { resultScope: 'original_sdk_response',
      providerResponseIdDigest: 'c'.repeat(64), outcome: 'cancelled' });
    else f.operational.prepare(`UPDATE operational_events SET payload_json = json_set(payload_json, ?, ?)
      WHERE json_extract(payload_json, '$.phase') = 'adapter_attempt_finished'`).run(
      variant === 'digest' ? '$.providerResponseIdDigest' : '$.journalFailed', variant === 'digest' ? 'c'.repeat(64) : 1);
    const result = readAcceptedTaskNoticingParticipants(f.home, [f.source]);
    assert.equal(result.jobs.length, 1); assert.deepEqual(result.jobs[0]?.responseBindings, []);
    assert.ok(result.issues.includes('noticing_original_response_binding_unproved'));
  }
});

test('one matching operation receipt cannot hide a second contrary or invalid receipt', t => {
  for (const variant of ['digest', 'actor', 'null-call'] as const) {
    const f = fixture(t); f.retain(f.answer, f.savedAnswer); f.state.thinking = []; f.saveState(); f.completed(f.answer);
    f.event(f.answer, 'operation_receipt', { receiptDigest: variant === 'digest' ? 'f'.repeat(64) : hash(f.savedAnswer),
      ...(variant === 'null-call' ? { modelCallId: 'foreign-receipt-call' } : {}) },
    variant === 'actor' ? { actor: 'foreign-receipt-writer' } : {});
    const result = readAcceptedTaskNoticingParticipants(f.home, [f.source]);
    assert.equal(result.jobs.length, 0); assert.deepEqual(result.claimedJobIds, [ids.answer]);
    assert.ok(result.issues.includes('noticing_operation_receipt_unproved'));
  }
});

test('missing or malformed extra lifecycle phases retain the job claim but cannot admit original response usage', t => {
  for (const variant of ['missing-start', 'missing-finish', 'duplicate-invalid-start', 'duplicate-invalid-finish', 'invalid-finish'] as const) {
    const f = fixture(t); f.retain(f.answer, f.savedAnswer); f.state.thinking = []; f.saveState(); f.completed(f.answer);
    if (variant === 'missing-start' || variant === 'missing-finish') f.operational.prepare(`DELETE FROM operational_events
      WHERE json_extract(payload_json, '$.phase') = ?`).run(variant === 'missing-start' ? 'job_started' : 'job_finished');
    else if (variant === 'invalid-finish') f.operational.prepare(`UPDATE operational_events
      SET payload_json = json_set(payload_json, '$.clock', 'foreign_clock')
      WHERE json_extract(payload_json, '$.phase') = 'job_finished'`).run();
    else f.event(f.answer, variant === 'duplicate-invalid-start' ? 'job_started' : 'job_finished',
      { clock: 'foreign_clock', outcome: 'invented', usage: 'reported' }, { actor: 'foreign-lifecycle-writer' });
    const result = readAcceptedTaskNoticingParticipants(f.home, [f.source]);
    assert.equal(result.jobs.length, 1); assert.equal(result.jobs[0]?.usageJobId, ids.answer);
    assert.deepEqual(result.claimedJobIds, [ids.answer]); assert.deepEqual(result.jobs[0]?.responseBindings, [], variant);
    assert.ok(result.issues.includes('noticing_job_lifecycle_unknown'));
  }
});

test('the explicit-home decoder accepts an actual production Noticing accepted packet and operation receipt', async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-noticing-participants-production-'));
  const previousHome = process.env.CLEMENTINE_HOME; const previousGuard = process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT;
  process.env.CLEMENTINE_HOME = home;
  process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';
  const [runtime, noticing, checkIns, ports, log, approved, usage, transport, raw, resilience, registry] = await Promise.all([
    import('../../src/agents/noticing-runtime.js'), import('../../src/agents/noticing.js'), import('../../src/agents/check-ins.js'),
    import('../../src/runtime/semantic-boundary/turn-semantic-port-registry.js'), import('../../src/runtime/harness/eventlog.js'),
    import('../../src/runtime/harness/noticing-approved-task.js'),
    import('../../src/runtime/usage-log.js'), import('../../src/runtime/harness/model-transport-observation.js'),
    import('../../src/runtime/harness/claude-model.js'), import('../../src/runtime/harness/resilient-model.js'),
    import('../../src/runtime/harness/model-wire-registry.js'),
  ]);
  t.after(() => { runtime.bindNoticingRespond(null); ports.installTurnSemanticModelPort(null); log.closeEventLog();
    if (previousHome === undefined) delete process.env.CLEMENTINE_HOME; else process.env.CLEMENTINE_HOME = previousHome;
    if (previousGuard === undefined) delete process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT; else process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = previousGuard;
    rmSync(home, { recursive: true, force: true }); });
  const id = 'controlled-production-proposal';
  const checkIn = checkIns.createCheckIn({ agentSlug: 'clementine', question: 'May I prepare the controlled production-fixture draft?', contextSummary: `noticing:${id}` });
  assert.equal(checkIns.answerCheckIn(checkIn.id, 'Yes, draft only; use the controlled local fixture.')?.status, 'answered');
  const state = noticing.emptyNoticingState();
  state.proposals[id] = { id, shapeKey: 'controlled-production-shape', title: 'Controlled production draft',
    action: 'Prepare a controlled local draft only.', why: 'Controlled retained evidence.', evidence: ['controlled evidence'],
    goalId: null, confidence: 0.9, createdAt: new Date().toISOString(), status: 'open', checkInId: checkIn.id };
  runtime.saveNoticingState(state);
  const responseId = 'controlled-noticing-original-response';
  const original = { id: responseId, responseId, output: [{ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'Controlled fixture decision.' }] }],
    usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 } };
  const model = raw.withRawClaudeUsageRecording(resilience.withResilience({
    getResponse: async () => {
      await transport.observeModelTransportFetch('raw_claude_messages', 'controlled-noticing-model', async () => ({ status: 200, ok: true }));
      return original;
    }, getStreamedResponse: async function* () { throw new Error('unused controlled stream'); },
  } as never, { label: 'controlled-noticing-model', capability: registry.resolveModelCapability('claude-opus-4-8'), maxRetries: 0 }),
  'controlled-noticing-model', usage.recordModelUsage, () => {}, () => {});
  ports.installTurnSemanticModelPort({ readNoticingAnswer: input => usage.withOwnModelRequestAttribution({
    role: 'reviewer', channel: 'semantic:noticing_answer',
  }, async () => {
    await model.getResponse({ input: 'controlled fixture', modelSettings: {}, tools: [], handoffs: [] } as never);
    return { decision: 'do_it', instruction: 'Draft only.', evidenceDigest: input.evidenceDigest, modelIdentity: 'controlled-reader' };
  }) } as import('../../src/runtime/semantic-boundary/turn-semantic-model-port.js').TurnSemanticModelPort);
  runtime.bindNoticingRespond(async () => { /* Actual ingress accepts; no runner/model/attempt is fabricated. */ });
  const earlier = Date.now() - 60_000;
  const clock = t.mock.method(Date, 'now', () => earlier);
  try { await runtime.settleNoticingAnswers(); } finally { clock.mock.restore(); }
  const saved = runtime.readNoticingStateStrict().state.proposals[id]!;
  const source = { sessionId: saved.handoff!.sessionId!, sourceUserSeq: saved.handoff!.sourceUserSeq! };
  assert.ok(approved.readAcceptedNoticingTask(source));
  const result = readAcceptedTaskNoticingParticipants(home, [source]);
  assert.equal(result.jobs.length, 1); assert.equal(result.jobs[0]?.operation, 'noticing_answer');
  assert.equal(result.jobs[0]?.usageJobId, saved.answer!.modelAccountingJobId);
  assert.deepEqual(result.jobs[0]?.parentAcceptedSources, [`${source.sessionId}:${source.sourceUserSeq}`]);
  assert.equal(result.jobs[0]?.responseBindings.length, 1);
  assert.equal(result.jobs[0]?.responseBindings[0]?.providerResponseIdDigest, createHash('sha256').update(responseId).digest('hex'));
  assert.ok(result.issues.includes('noticing_proposal_job_receipt_unavailable'));
  assert.deepEqual(readAcceptedTaskNoticingParticipants(home, [source, source]), result, 'overlapping named sources retain one participant');

  // Canonical accepted-task accounting includes both exact rows once. The
  // predecessor's deliberately earlier diagnostic clock never widens delivery.
  const ingress = log.listEvents(source.sessionId, { types: ['user_input_received'], sinceSeq: source.sourceUserSeq - 1, limit: 1 })[0]!;
  const attempt = log.beginRunAttempt(source.sessionId, { runId: ingress.data.runId as string });
  const accepted = log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: saved.answer!.text } },
    { existingEventSeq: source.sourceUserSeq });
  usage.withModelUsageAttribution({ sessionId: source.sessionId, sourceUserSeq: source.sourceUserSeq,
    attemptId: attempt.attemptId, role: 'brain' }, () => usage.recordModelUsage({ sessionId: source.sessionId,
    model: 'controlled-main-model', responseId: 'controlled-main-original-response', inputTokens: 10, outputTokens: 2,
    cacheDialect: 'inclusive', trace: { modelCallId: 'controlled-main-local-call' } }));
  const outcomeId = `turn:${source.sourceUserSeq}`;
  const terminal = log.appendEvent({ sessionId: source.sessionId, turn: 1, role: 'system', type: 'conversation_completed', data: {
    sourceUserSeq: source.sourceUserSeq, attemptId: attempt.attemptId, terminalKey: outcomeId,
    presentation: { version: 1, id: `${outcomeId}:presentation`, outcomeId, audience: 'user', phase: 'final',
      identity: { sessionId: source.sessionId, turn: 1, sourceUserSeq: source.sourceUserSeq }, status: 'done', kind: 'answer',
      text: 'Controlled measurement fixture completed.', resumable: false },
    turnOutcome: { version: 2, id: outcomeId, status: 'done', resumable: false },
  } });
  log.finishRunAttempt(attempt, 'completed');
  const { measureAcceptedTask } = await import('../session-comparison.js');
  const measurement = measureAcceptedTask(home, source.sessionId, source.sourceUserSeq);
  assert.equal(measurement.proactiveExactUsageRecords, 1); assert.equal(measurement.exactUsageRecords, 2);
  assert.equal(measurement.usageRecords, 2); assert.equal(measurement.promptTokens, 19); assert.equal(measurement.outputTokens, 5);
  assert.equal(measurement.taskWallMs, Date.parse(terminal.createdAt) - Date.parse(accepted.createdAt));
  assert.ok(result.jobs[0]!.startedAt! <= Date.parse(accepted.createdAt) - 59_000);
  assert.deepEqual(measureAcceptedTask(home, source.sessionId, source.sourceUserSeq), measurement);
  assert.equal(measurement.usageCompleteness.allLegUsageCertified, false);
});
