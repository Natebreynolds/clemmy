import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-auxiliary-models-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
const log = await import('../runtime/harness/eventlog.js');
const { readTaskAuxiliaryModels } = await import('./task-auxiliary-model-read.js');
const { readTaskHandlingDetails } = await import('./task-handling-read.js');
const { recordModelUsage } = await import('../runtime/usage-log.js');
const memory = await import('../memory/db.js');
const telemetry = await import('../runtime/operational-telemetry.js');
after(() => { log.closeEventLog(); memory.closeMemoryDb(); telemetry.closeOperationalTelemetryDb(); rmSync(home, { recursive: true, force: true }); });
let serial = 0;
function fixture(sessionId = `controlled-aux-${++serial}`) {
  if (!log.getSession(sessionId)) log.createSession({ id: sessionId, kind: 'chat' });
  const attempt = log.beginRunAttempt(sessionId, { runId: `desktop:${sessionId}:${serial}` });
  const source = log.recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: 'Controlled auxiliary observation fixture.' } });
  return { sessionId, sourceUserSeq: source.seq, attemptId: attempt.attemptId };
}
function event(owner: ReturnType<typeof fixture>, data: Record<string, unknown>) {
  return log.appendEvent({ sessionId: owner.sessionId, turn: 0, role: 'system', type: 'model_transport_observed', data: {
    version: 1, sourceUserSeq: owner.sourceUserSeq, logicalTurnId: `turn:${owner.sourceUserSeq}`, runAttemptId: owner.attemptId,
    ownerKind: 'accepted_source_scope', purpose: 'router', journalFailed: false, clock: 'host_epoch_ms', ...data,
  } });
}
function call(owner: ReturnType<typeof fixture>, callId = `controlled-call-${++serial}`, physicalAttempt = 1, callPurpose?: string) {
  const base = { modelCallId: callId, physicalAttempt, ...(callPurpose ? { callPurpose } : {}) };
  const dispatchId = `${callId}-dispatch-${physicalAttempt}`;
  const rows = [
    { ...base, phase: 'adapter_attempt_created', resultScope: 'local_adapter_attempt', dispatchIds: [], at: 10 },
    { ...base, phase: 'dispatch_started', transport: 'typesafe_systemone', dispatchId, wireSubattempt: 1, requestedModel: 'jev-request-v1', late: false, at: 11 },
    { ...base, phase: 'headers_received', transport: 'typesafe_systemone', dispatchId, wireSubattempt: 1, status: 200, ok: true, durationMs: 1, late: false, at: 12 },
    { ...base, phase: 'adapter_attempt_finished', outcome: 'returned', resultScope: 'owned_systemone_parser', dispatchIds: [dispatchId], usage: 'reported', remoteSettlement: 'parsed_response', providerReportedModel: 'jev-response-v2', at: 13 },
    { ...base, phase: 'model_result_completed', hostResultReceiptId: `${callId}-receipt-${physicalAttempt}`, outcome: 'returned', resultScope: 'owned_systemone_parser', dispatchIds: [dispatchId], usage: 'reported', remoteSettlement: 'parsed_response', providerReportedModel: 'jev-response-v2', wireUsageCoverage: 'unproved', at: 14 },
  ];
  const saved = rows.map(row => event(owner, row));
  return { callId, physicalAttempt, rows, saved, dispatchId };
}
function alter(row: ReturnType<typeof event>, patch: Record<string, unknown>) {
  log.openEventLog().prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(JSON.stringify({ ...row.data, ...patch }), row.seq);
}
test('exact parsed auxiliary calls remain separate from route rows, purposes and canonical totals', () => {
  const owner = fixture(); call(owner, 'turn-start-call', 1, 'jev-turn-start'); call(owner, 'completion-call', 1, 'jev-completion');
  recordModelUsage({ ...owner, model: 'jev-request-v1', role: 'router', cacheDialect: 'none', inputTokens: 12, outputTokens: 4 });
  const view = readTaskHandlingDetails(owner)!;
  assert.equal(view.models.length, 0); assert.equal(view.auxiliaryModels?.length, 2); assert.equal(view.usage?.totals.calls, 1, 'observation rows are never summed into the meter');
  assert.deepEqual(view.auxiliaryModels?.map(row => row.callPurpose), ['jev-turn-start', 'jev-completion']);
  assert.ok(view.auxiliaryModels?.every(row => row.responseCompleted && row.evidence === 'parsed_response' && row.dispatchCount === 1));
  assert.equal(view.auxiliaryModels?.[0]?.requestedModel, 'jev-request-v1'); assert.equal(view.auxiliaryModels?.[0]?.providerReportedModel, 'jev-response-v2');
});
test('phase mirrors and several physical dispatches are not extra model calls', () => {
  const owner = fixture(), item = call(owner);
  for (const data of item.rows) event(owner, data);
  const result = readTaskAuxiliaryModels(owner);
  assert.equal(result.models.length, 1); assert.equal(result.models[0]?.responseCompleted, true);
  assert.equal(result.models[0]?.dispatchCount, 1);
  call(owner, item.callId, 2);
  assert.equal(readTaskAuxiliaryModels(owner).models.length, 2, 'physical attempts are distinct even under one logical model ID');
});
test('main-route exclusion needs the exact call, accepted attempt and physical attempt', () => {
  const owner = fixture(), item = call(owner);
  const proof = { callId: item.callId, attemptId: owner.attemptId, physicalAttempt: item.physicalAttempt };
  assert.equal(readTaskAuxiliaryModels(owner, [{ ...proof, physicalAttempt: 2 }]).models.length, 1);
  assert.equal(readTaskAuxiliaryModels(owner, [{ ...proof, attemptId: 'foreign-attempt' }]).models.length, 1);
  assert.equal(readTaskAuxiliaryModels(owner, [proof]).models.length, 0);
});
test('headers and local retirement alone cannot claim a completed or provider-confirmed response', () => {
  const owner = fixture(), item = call(owner);
  log.openEventLog().prepare('DELETE FROM events WHERE seq IN (?,?)').run(item.saved[3]!.seq, item.saved[4]!.seq);
  const result = readTaskAuxiliaryModels(owner).models[0]!;
  assert.equal(result.responseCompleted, false); assert.equal(result.status, 'started'); assert.equal(result.providerReportedModel, undefined); assert.equal(result.usage, 'unknown');
});
test('missing, late, conflicting, malformed or unproved parse receipts stay unconfirmed', () => {
  for (const defect of ['created', 'header', 'late', 'journal', 'purpose', 'owner', 'provider', 'scope', 'receipt', 'model', 'dispatch-list'] as const) {
    const owner = fixture(), item = call(owner, `call-${defect}-${++serial}`, 1, 'jev-completion');
    if (defect === 'created') log.openEventLog().prepare('DELETE FROM events WHERE seq = ?').run(item.saved[0]!.seq);
    if (defect === 'header') log.openEventLog().prepare('DELETE FROM events WHERE seq = ?').run(item.saved[2]!.seq);
    if (defect === 'late') alter(item.saved[1]!, { late: true });
    if (defect === 'journal') alter(item.saved[4]!, { journalFailed: true });
    if (defect === 'purpose') alter(item.saved[4]!, { callPurpose: 'jev-turn-start' });
    if (defect === 'owner') alter(item.saved[4]!, { ownerKind: 'accounting_parent' });
    if (defect === 'provider') alter(item.saved[4]!, { providerReportedModel: 'other-provider-response' });
    if (defect === 'scope') alter(item.saved[4]!, { resultScope: 'local_retirement' });
    if (defect === 'receipt') alter(item.saved[4]!, { hostResultReceiptId: null });
    if (defect === 'model') alter(item.saved[1]!, { requestedModel: null });
    if (defect === 'dispatch-list') alter(item.saved[4]!, { dispatchIds: ['foreign-dispatch'] });
    const result = readTaskAuxiliaryModels(owner).models[0]!;
    assert.equal(result.responseCompleted, false, defect); assert.equal(result.providerReportedModel, undefined, defect);
    assert.equal(result.status, 'unconfirmed', defect); assert.equal(result.usage, 'unknown', defect);
  }
});
test('a completion from another attempt/source/session cannot settle the owned start', () => {
  const owner = fixture(), item = call(owner);
  const foreign = fixture();
  alter(item.saved[4]!, { runAttemptId: foreign.attemptId });
  assert.equal(readTaskAuxiliaryModels(owner).models[0]?.responseCompleted, false);
  alter(item.saved[4]!, { runAttemptId: owner.attemptId, sourceUserSeq: foreign.sourceUserSeq });
  assert.equal(readTaskAuxiliaryModels(owner).models[0]?.responseCompleted, false);
  assert.equal(readTaskAuxiliaryModels(foreign).models.length, 0);
  log.openEventLog().prepare('UPDATE events SET session_id = ? WHERE seq = ?').run(foreign.sessionId, item.saved[4]!.seq);
  assert.equal(readTaskAuxiliaryModels(foreign).models.length, 0, 'foreign session cannot borrow the original attempt');
});
test('historical missing/unknown purpose stays absent, memory role is preserved, and content fields never escape', () => {
  const owner = fixture(), item = call(owner);
  alter(item.saved[1]!, { url: 'https://private.invalid/secret', rawInput: 'NEVER_EXPOSE', accountId: 'NEVER_EXPOSE_ACCOUNT' });
  let result = readTaskAuxiliaryModels(owner).models[0]!;
  assert.equal(result.callPurpose, undefined); assert.equal(result.role, 'router');
  assert.doesNotMatch(JSON.stringify(result), /private.invalid|NEVER_EXPOSE/);
  for (const row of item.saved) alter(row, { purpose: 'memory', callPurpose: 'unrecognized-or-user-authored-stage' });
  result = readTaskAuxiliaryModels(owner).models[0]!;
  assert.equal(result.role, 'memory'); assert.equal(result.callPurpose, undefined);
});
test('known local failure/cancellation keeps usage unknown rather than becoming a successful review', () => {
  for (const outcome of ['failed', 'cancelled'] as const) {
    const owner = fixture(), item = call(owner);
    alter(item.saved[3]!, { outcome, resultScope: 'local_retirement', remoteSettlement: 'unknown', usage: 'unknown' });
    alter(item.saved[4]!, { phase: 'model_attempt_retired', outcome, resultScope: 'local_retirement', remoteSettlement: 'unknown', usage: 'unknown' });
    const result = readTaskAuxiliaryModels(owner).models[0]!;
    assert.equal(result.status, outcome); assert.equal(result.responseCompleted, false); assert.equal(result.usage, 'unknown');
  }
});
test('call caps remain visible and cannot silently certify the first hundred calls as a full inventory', () => {
  const owner = fixture();
  for (let i = 0; i < 102; i++) call(owner, `capped-call-${i}`);
  const result = readTaskAuxiliaryModels(owner);
  assert.equal(result.models.length, 100); assert.equal(result.truncated, true);
  assert.ok(result.models.every(row => row.responseCompleted === false && row.status === 'unconfirmed'));
});
test('read bounds use existing session index and passive reads change no rows', () => {
  const owner = fixture(); call(owner);
  const db = log.openEventLog(), before = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq').all(owner.sessionId);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT seq,data_json FROM events INDEXED BY idx_events_session_seq
    WHERE session_id = ? AND seq > ? AND type = 'model_transport_observed'`).all(owner.sessionId, owner.sourceUserSeq) as Array<{ detail: string }>;
  assert.ok(plan.some(row => /SEARCH events USING INDEX idx_events_session_seq/.test(row.detail)));
  readTaskAuxiliaryModels(owner); readTaskAuxiliaryModels(owner);
  assert.deepEqual(db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq').all(owner.sessionId), before);
});
test('accounting namespaces and a reused model-call ID cannot borrow parsed ownership', () => {
  const owner = fixture(), item = call(owner, 'namespace-call', 1, 'jev-completion');
  for (const row of item.saved) alter(row, { ownerKind: 'accounting_parent', usageJobId: 'memory-job-one' });
  assert.equal(readTaskAuxiliaryModels(owner).models[0]?.responseCompleted, false, 'a job name alone does not prove its durable parent link');
  alter(item.saved[4]!, { ownerKind: 'accounting_parent', usageJobId: 'memory-job-two' });
  assert.equal(readTaskAuxiliaryModels(owner).models[0]?.evidence, 'conflicting');
  assert.equal(readTaskAuxiliaryModels(owner).models[0]?.callPurpose, undefined);
  const clean = fixture(), prior = call(clean, 'reused-owned-call');
  const anotherAttempt = log.beginRunAttempt(clean.sessionId, { runId: 'desktop:second-controlled-attempt', sourceUserSeq: clean.sourceUserSeq });
  // Persist a second owned attempt against the same source as on a resume.
  log.openEventLog().prepare('UPDATE run_attempts SET source_user_seq = ? WHERE attempt_id = ?').run(clean.sourceUserSeq, anotherAttempt.attemptId);
  call({ ...clean, attemptId: anotherAttempt.attemptId }, prior.callId, 2);
  const rows = readTaskAuxiliaryModels(clean).models;
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.evidence === 'conflicting' && !row.responseCompleted));
});
test('provider-controlled model strings are sanitized and a shared completion receipt is conflicting', () => {
  const owner = fixture(), item = call(owner);
  const secret = 'sk-proj-controlledSecret123456789012345678901234';
  alter(item.saved[3]!, { providerReportedModel: secret }); alter(item.saved[4]!, { providerReportedModel: secret });
  const sanitized = readTaskAuxiliaryModels(owner).models[0]!;
  assert.equal(sanitized.responseCompleted, true);
  assert.doesNotMatch(JSON.stringify(sanitized), /controlledSecret/);
  const other = call(owner);
  alter(other.saved[4]!, { hostResultReceiptId: item.saved[4]!.data.hostResultReceiptId });
  assert.ok(readTaskAuxiliaryModels(owner).models.every(row => row.evidence === 'conflicting' && !row.responseCompleted));
});
test('a lifecycle row cap is explicit and never certifies a partially read call', () => {
  const owner = fixture(), item = call(owner);
  for (let i = 0; i < 2000; i++) event(owner, { ...item.rows[1], at: 100 + i });
  const result = readTaskAuxiliaryModels(owner);
  assert.equal(result.truncated, true); assert.equal(result.models[0]?.responseCompleted, false);
});
test('actual host transport receipts project one parsed call without any real network or model', async () => {
  const owner = fixture();
  const usage = await import('../runtime/usage-log.js');
  const transport = await import('../runtime/harness/model-transport-observation.js');
  await usage.withModelUsageAttribution({ ...owner, role: 'router' }, async () => {
    const scope = transport.createModelTransportAttempt('actual-host-auxiliary-receipts', 1, transport.captureModelTransportOwner(), 'jev-completion');
    await transport.withModelTransportAttempt(scope, () => transport.observeModelTransportFetch('typesafe_systemone', 'jev-request-v1', async () => ({ status: 200, ok: true })));
    transport.finishModelTransportAttempt(scope, 'returned', { usageKnown: true, providerReportedModel: 'jev-response-v2' });
  });
  const rows = readTaskAuxiliaryModels(owner).models;
  assert.equal(rows.length, 1); assert.equal(rows[0]?.responseCompleted, true);
  assert.equal(rows[0]?.callPurpose, 'jev-completion'); assert.equal(rows[0]?.dispatchCount, 1);
});
test('partial provider identity and malformed parent namespace never invent a confirmed model', () => {
  const owner = fixture(), item = call(owner);
  alter(item.saved[4]!, { providerReportedModel: null });
  assert.equal(readTaskAuxiliaryModels(owner).models[0]?.providerReportedModel, undefined);
  for (const row of item.saved) alter(row, { ownerKind: 'accounting_parent', usageJobId: 'invalid namespace with content' });
  const result = readTaskAuxiliaryModels(owner).models[0]!;
  assert.equal(result.responseCompleted, false); assert.equal(result.status, 'unconfirmed');
});
