import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-task-handling-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
const log = await import('../runtime/harness/eventlog.js');
const { recordModelUsage } = await import('../runtime/usage-log.js');
const memory = await import('../runtime/harness/model-memory-evidence.js');
const recall = await import('../memory/recall-usage.js');
const { closeMemoryDb } = await import('../memory/db.js');
const { closeOperationalTelemetryDb } = await import('../runtime/operational-telemetry.js');
const { readTaskHandlingDetails } = await import('./task-handling-read.js');
after(() => { log.closeEventLog(); closeMemoryDb(); closeOperationalTelemetryDb(); rmSync(home, { recursive: true, force: true }); });
function accepted(id: string) {
  if (!log.getSession(id)) log.createSession({ id, kind: 'chat' });
  const source = log.appendEvent({ sessionId: id, turn: 0, role: 'user', type: 'user_input_received', data: { text: 'synthetic task' } });
  return { sessionId: id, sourceUserSeq: source.seq };
}
function append(owner: ReturnType<typeof accepted>, type: Parameters<typeof log.appendEvent>[0]['type'], data: Record<string, unknown>, parentEventId?: string) {
  return log.appendEvent({ sessionId: owner.sessionId, turn: 0, role: 'system', type, data: { ...data, sourceUserSeq: owner.sourceUserSeq }, ...(parentEventId ? { parentEventId } : {}) });
}
test('accepted identity is required; no latest or foreign-source fallback', () => {
  const one = accepted('exact-source');
  assert.equal(readTaskHandlingDetails({ sessionId: 'not-this-session', sourceUserSeq: one.sourceUserSeq }), null);
  assert.equal(readTaskHandlingDetails({ ...one, sourceUserSeq: 0 }), null);
  assert.equal(readTaskHandlingDetails({ ...one, sourceUserSeq: NaN }), null);
  assert.equal(readTaskHandlingDetails(one)?.sourceUserSeq, one.sourceUserSeq);
});
test('tool rows keep source, occurrence, transport mirrors, outcomes and selection distinct', () => {
  const one = accepted('tools-source');
  append(one, 'proven_operation_selected', { tools: ['fixture_read', 'fixture_other'], nativeTools: [], strategyId: 'fixture-strategy',
    ownerRule: { factId: 23, text: 'Use my fixture read. api_key=synthetic-secret' } });
  const first = append(one, 'tool_called', { callId: 'one', tool: 'fixture_read', effect: 'read', accounting: 'top_level', attemptId: 'attempt-one',
    arguments: 'NEVER_EXPOSE_ARGUMENTS' });
  append(one, 'tool_called', { callId: 'one', tool: 'fixture_read', accounting: 'transport_mirror', attemptId: 'attempt-one' });
  const two = accepted(one.sessionId);
  append(two, 'tool_called', { callId: 'foreign', tool: 'foreign_read' });
  append(one, 'tool_returned', { callId: 'one', tool: 'fixture_read', attemptId: 'attempt-one', accounting: 'top_level', result: 'NEVER_EXPOSE_OUTPUT' }, first.id);
  const second = append(one, 'tool_called', { callId: 'two', tool: 'fixture_other', attemptId: 'attempt-two' });
  append(one, 'tool_returned', { callId: 'two', tool: 'fixture_other', attemptId: 'attempt-two', ok: false }, second.id);
  const reused = append(one, 'tool_called', { callId: 'reused', tool: 'fixture_read', attemptId: 'attempt-two' });
  append(one, 'tool_returned', { callId: 'reused', tool: 'fixture_read', attemptId: 'attempt-two', providerDispatched: false, replayKind: 'retained_read' }, reused.id);
  const view = readTaskHandlingDetails(one)!;
  assert.deepEqual(view.tools.map(row => [row.name, row.status]), [['fixture_read', 'returned'], ['fixture_other', 'failed'], ['fixture_read', 'reused']]);
  assert.equal(view.tools[0].dispatchEvidence, 'lifecycle');
  assert.equal(view.tools[2].dispatchEvidence, 'reused');
  assert.equal(view.tools[0].selection?.kind, 'owner_preference');
  assert.equal(view.tools[1].selection?.kind, 'prepared_approach', 'rule belongs only to the selected first operation');
  assert.deepEqual(view.attemptIds, ['attempt-one', 'attempt-two']);
  assert.doesNotMatch(JSON.stringify(view), /NEVER_EXPOSE|synthetic-secret|foreign_read/);
  assert.match(view.tools[0].selection!.text!, /REDACTED/);
});
test('an unparented or wrong-attempt return never settles another occurrence', () => {
  const owner = accepted('occurrence-source');
  append(owner, 'tool_called', { callId: 'same-id', tool: 'fixture_read', attemptId: 'attempt-a' });
  const second = append(owner, 'tool_called', { callId: 'same-id', tool: 'fixture_read', attemptId: 'attempt-b' });
  append(owner, 'tool_returned', { callId: 'same-id', tool: 'fixture_read', attemptId: 'attempt-b' });
  append(owner, 'tool_returned', { callId: 'same-id', tool: 'fixture_read', attemptId: 'attempt-b' }, second.id);
  assert.deepEqual(readTaskHandlingDetails(owner)!.tools.map(row => row.status), ['started', 'returned']);
});
test('memory recall is linked by an exact primer receipt, never a session time window', () => {
  const owner = accepted('memory-source');
  const exact = recall.recordRecallRun({ sessionId: owner.sessionId, objective: 'synthetic exact', surface: 'primer', answerability: 'supported',
    candidateRefs: [{ type: 'fact', id: '42', snippet: 'Retained text for this request.' }] });
  append(owner, 'turn_memory_primer', { recallId: exact.id });
  recall.recordRecallRun({ sessionId: owner.sessionId, objective: 'unowned later recall', surface: 'tool', answerability: 'supported',
    candidateRefs: [{ type: 'fact', id: '99', snippet: 'NEVER_ATTACH_LATER_MEMORY' }] });
  const later = accepted(owner.sessionId);
  const laterRecall = recall.recordRecallRun({ sessionId: owner.sessionId, objective: 'later', surface: 'primer', answerability: 'supported',
    candidateRefs: [{ type: 'fact', id: '100', snippet: 'NEVER_ATTACH_LATER_MEMORY' }] });
  append(later, 'turn_memory_primer', { recallId: laterRecall.id });
  memory.recordAcceptedModelMemory(owner, [{ text: 'NEVER_EXPOSE_MEMORY_FRAGMENT', manifest: [{ section: 'Relevant', tier: 'relevant', tokens: 4, bytes: 16, refs: [{ type: 'fact', id: '42' }] }] }]);
  const view = readTaskHandlingDetails(owner)!;
  assert.deepEqual(view.memory.recall.map(row => row.id), [exact.id]);
  assert.equal(view.memory.recall[0].refs[0].outcome, 'offered');
  assert.equal(view.memory.provided?.manifest[0].refs[0].id, '42');
  assert.doesNotMatch(JSON.stringify(view), /NEVER_ATTACH|NEVER_EXPOSE_MEMORY_FRAGMENT/);
});
test('usage reuses indexed accepted-source arithmetic and keeps unknown failed cost visible', () => {
  const owner = accepted('usage-source');
  const other = accepted(owner.sessionId);
  recordModelUsage({ ...owner, model: 'fixture-model', role: 'brain', cacheDialect: 'inclusive', inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, durationMs: 50 });
  recordModelUsage({ ...owner, model: 'fixture-judge', role: 'reviewer', inputTokens: 0, outputTokens: 0, ok: false });
  recordModelUsage({ ...other, model: 'fixture-other', role: 'brain', inputTokens: 5000, outputTokens: 2 });
  const usage = readTaskHandlingDetails(owner)!.usage!;
  assert.equal(usage.totals.calls, 2);
  assert.equal(usage.totals.promptTokens, 100);
  assert.equal(usage.totals.cachedReadTokens, 80);
  assert.equal(usage.totals.unknownCostCalls, 1);
  assert.equal(usage.byRole.reviewer.calls, 1);
});
test('model routes remain source-bound and distinguish intent from completed provider identity', () => {
  const owner = accepted('models-source');
  const other = accepted(owner.sessionId);
  const file = path.join(home, 'state', 'model-route-metrics.db');
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`CREATE TABLE model_route_decisions(id TEXT PRIMARY KEY,created_at TEXT,session_id TEXT,role TEXT,provider TEXT,requested_model TEXT,resolved_model TEXT,reason_json TEXT);
    CREATE TABLE model_route_outcomes(decision_id TEXT,status TEXT,latency_ms INTEGER,fallover_to_model TEXT,metadata_json TEXT);`);
  const time = new Date().toISOString();
  const decision = db.prepare('INSERT INTO model_route_decisions VALUES(?,?,?,?,?,?,?,?)');
  decision.run('model-one', time, owner.sessionId, 'brain', 'fixture-provider', 'request-one', 'resolved-one', JSON.stringify({ sourceUserSeq: owner.sourceUserSeq, runAttemptId: 'first-attempt', secret: 'NEVER_EXPOSE_MODEL_REASON' }));
  decision.run('model-two', time, owner.sessionId, 'brain', 'fixture-provider', 'request-two', 'resolved-two', JSON.stringify({ sourceUserSeq: owner.sourceUserSeq, runAttemptId: 'second-attempt' }));
  decision.run('model-other', time, owner.sessionId, 'brain', 'fixture-provider', 'request-other', 'resolved-other', JSON.stringify({ sourceUserSeq: other.sourceUserSeq }));
  db.prepare('INSERT INTO model_route_outcomes VALUES(?,?,?,?,?)').run('model-one', 'success', 150, null, JSON.stringify({ responseCompleted: true, actualModel: 'actual-one', actualProvider: 'actual-provider', providerReportedModel: 'provider-one', output: 'NEVER_EXPOSE_MODEL_OUTPUT' }));
  db.prepare('INSERT INTO model_route_outcomes VALUES(?,?,?,?,?)').run('model-two', 'failed', 75, 'backup-model', JSON.stringify({ responseCompleted: false, actualModel: 'NOT_A_COMPLETED_MODEL' }));
  db.close();
  const view = readTaskHandlingDetails(owner)!;
  assert.equal(view.models.length, 2);
  const one = view.models.find(row => row.callId === 'model-one')!;
  assert.equal(one.servedModel, 'actual-one');
  assert.equal(one.servedProvider, 'actual-provider');
  assert.equal(one.provider, 'fixture-provider');
  assert.equal(one.providerReportedModel, 'provider-one');
  const two = view.models.find(row => row.callId === 'model-two')!;
  assert.equal(two.responseCompleted, false);
  assert.equal(two.servedModel, undefined);
  assert.equal(two.fallbackToModel, 'backup-model');
  assert.doesNotMatch(JSON.stringify(view), /resolved-other|NEVER_EXPOSE|NOT_A_COMPLETED_MODEL/);
});
test('large histories are explicitly capped without stealing later-source calls', () => {
  const owner = accepted('bounded-source');
  for (let i = 0; i < 105; i++) append(owner, 'tool_called', { callId: `fixture-${i}`, tool: 'fixture_read' });
  const other = accepted(owner.sessionId);
  append(other, 'tool_called', { callId: 'foreign', tool: 'NEVER_INCLUDE_FOREIGN' });
  const view = readTaskHandlingDetails(owner)!;
  assert.equal(view.tools.length, 100);
  assert.equal(view.limits.toolsTruncated, true);
  assert.doesNotMatch(JSON.stringify(view), /NEVER_INCLUDE_FOREIGN/);
});
test('many transport mirrors and duplicate notifications cannot hide a real call at the cap', () => {
  const owner = accepted('mirror-cap-source');
  for (let i = 0; i < 105; i++) append(owner, 'tool_called', { callId: `mirror-${i}`, tool: 'fixture_mirror', accounting: 'transport_mirror' });
  for (let i = 0; i < 105; i++) append(owner, 'tool_called', { callId: 'duplicate', tool: 'fixture_read', attemptId: 'attempt-one' });
  append(owner, 'tool_called', { callId: 'next-real', tool: 'fixture_next', attemptId: 'attempt-one' });
  const view = readTaskHandlingDetails(owner)!;
  assert.deepEqual(view.tools.map(row => row.callId), ['duplicate', 'next-real']);
  assert.equal(view.limits.toolsTruncated, false);
});
test('a foreign recall run referenced by an owned primer cannot expose its refs', () => {
  const owner = accepted('foreign-recall-source');
  const foreign = recall.recordRecallRun({ sessionId: 'foreign-session', objective: 'synthetic foreign', surface: 'primer', answerability: 'supported',
    candidateRefs: [{ type: 'fact', id: '1', snippet: 'NEVER_EXPOSE_FOREIGN_RECALL' }] });
  append(owner, 'turn_memory_primer', { recallId: foreign.id });
  assert.deepEqual(readTaskHandlingDetails(owner)!.memory.recall, []);
});
test('selection without a call remains advisory and cannot become tool usage', () => {
  const owner = accepted('selection-only-source');
  append(owner, 'proven_operation_selected', { tools: ['fixture_not_called'], ownerRule: { factId: 21, text: 'Use a fixture preference.' } });
  assert.deepEqual(readTaskHandlingDetails(owner)!.tools, []);
});
test('physical dispatch evidence requires the exact logical call and available lease owner', async () => {
  const owner = accepted('physical-source');
  const shadow = await import('../runtime/graph/turn-graph-shadow.js');
  const identity = await import('../runtime/harness/attempt-identity.js');
  assert.ok(shadow.recordTurnGraphShadow({ identity: { ...owner, turn: 0 } }));
  await identity.withLogicalToolCall({ ...owner, tool: 'fixture_physical', logicalToolCallId: 'fixture-physical-call', args: {} }, async () => {
    await identity.withPhysicalDispatch({ ...owner, tool: 'fixture_physical', args: {} }, async () => 'synthetic fixture result');
  });
  const call = append(owner, 'tool_called', { callId: 'fixture-physical-call', tool: 'fixture_physical' });
  append(owner, 'tool_returned', { callId: 'fixture-physical-call', tool: 'fixture_physical' }, call.id);
  const wrong = append(owner, 'tool_called', { callId: 'fixture-physical-call', tool: 'fixture_physical', attemptId: 'unrelated-attempt' });
  append(owner, 'tool_returned', { callId: 'fixture-physical-call', tool: 'fixture_physical', attemptId: 'unrelated-attempt' }, wrong.id);
  const view = readTaskHandlingDetails(owner)!;
  assert.equal(view.tools[0].dispatchEvidence, 'physical');
  assert.equal(view.tools[0].physicalDispatches, 1);
  assert.equal(view.tools[1].dispatchEvidence, 'lifecycle', 'source/logical identity alone cannot lend another physical attempt a dispatch');
});
test('memory caps survive empty primers and unexpected total fields are never serialized', () => {
  const owner = accepted('manifest-limits-source');
  memory.recordAcceptedModelMemory(owner, [{ text: 'fixture memory', manifest: Array.from({ length: 105 }, (_, i) => ({
    section: `Section ${i}`, tier: 'relevant' as const, tokens: 1, bytes: 4, refs: [],
  })) }]);
  const event = log.listEvents(owner.sessionId, { types: ['guardrail_tripped'] }).at(-1)!;
  const data = { ...event.data, totals: { ...event.data.totals as Record<string, unknown>, unexpected: 'NEVER_SERIALIZE_EXTRA_TOTAL' } };
  log.openEventLog().prepare('UPDATE events SET data_json = ? WHERE seq = ?').run(JSON.stringify(data), event.seq);
  const view = readTaskHandlingDetails(owner)!;
  assert.equal(view.limits.memoryTruncated, true);
  assert.equal(view.memory.provided?.manifest.length, 100);
  assert.doesNotMatch(JSON.stringify(view), /NEVER_SERIALIZE_EXTRA_TOTAL/);
});
