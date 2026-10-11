/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/route-outcome-join.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-route-outcome-join-'));
process.env.CLEMENTINE_HOME = HOME;
mkdirSync(path.join(HOME, 'state'), { recursive: true });
const eventlog = await import('./eventlog.js');
const metrics = await import('../model-route-metrics.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('./brackets.js');
const join = await import('./route-outcome-join.js');
test.after(() => { eventlog.closeEventLog(); metrics.closeModelRouteMetricsDb(); rmSync(HOME, { recursive: true, force: true }); });

const ATTEMPT = 'attempt:fixture:one';
const at = (base: string, ms: number) => new Date(Date.parse(base) + ms).toISOString();

const verdictRow = (id: string, data: Record<string, unknown>) => ({ id, data: { lane: 'host_v1', kind: 'completion',
  sourceUserSeq: 7, continuation: false, ...data } });
const ref = (eventId: string, extra: Record<string, unknown> = {}) => ({ sourceUserSeq: 7, eventId, fulfills: true,
  verified: true, replyMatches: true, ...extra });

test('the verdict is the one the terminal was published under, and only a judged, standing review of the shipped reply counts', () => {
  assert.deepEqual(join.objectiveFromPublishedVerdict(ref('v'), verdictRow('v', { fulfills: true })),
    { objectiveMet: true, verdictEventId: 'v' });
  assert.equal(join.objectiveFromPublishedVerdict(ref('v', { fulfills: false }), verdictRow('v', { fulfills: false, blocked: true })).objectiveMet, false);
  // The host deleted the claims the reviewer flagged: the model's answer failed.
  assert.equal(join.objectiveFromPublishedVerdict(ref('v'), verdictRow('v', { fulfills: true, claimRemoval: { fromEventId: 'x' } })).objectiveMet, false);
  for (const [label, r, row] of [
    ['delivered reply is not the judged one', ref('v', { replyMatches: false }), verdictRow('v', { fulfills: true })],
    ['review no longer stands against what shipped', ref('v', { verified: false }), verdictRow('v', { fulfills: true })],
    ['failed open', ref('v', { failedOpen: true }), verdictRow('v', { fulfills: true, failedOpen: true })],
    ['self-judged', ref('v', { selfJudge: true }), verdictRow('v', { fulfills: true, selfJudge: true })],
    ['waiting on the owner', ref('v', { fulfills: false }), verdictRow('v', { fulfills: false, awaitingUser: true })],
    ['a plan review', ref('v'), verdictRow('v', { fulfills: true, planDigest: 'p' })],
    ['a verdict the turn went past', ref('v', { fulfills: false }), verdictRow('v', { fulfills: false, continuation: true })],
    ['the row is not the referenced one', ref('v'), verdictRow('other', { fulfills: true })],
  ] as const) {
    assert.equal(join.objectiveFromPublishedVerdict(r, row).objectiveMet, undefined, label);
  }
  assert.deepEqual(join.objectiveFromPublishedVerdict(undefined, null), {});
});

test('tool success: a failure is false, an uncertain write keeps the turn unknown and visible, and an empty result landed', () => {
  const row = (execution_kind: string, outcome_kind: string) => ({ execution_kind, outcome_kind });
  assert.deepEqual(join.toolSuccessFromSettlements([]), { toolCalls: 0, uncertainWrites: 0 });
  assert.deepEqual(join.toolSuccessFromSettlements([row('refused_pre_dispatch', 'policy_denial')]), { toolCalls: 0, uncertainWrites: 0 });
  assert.deepEqual(join.toolSuccessFromSettlements([row('provider_execution', 'succeeded'), row('local_execution', 'empty_result'),
    row('refused_pre_dispatch', 'invalid_arguments'), row('provider_execution', 'input_required')]),
  { toolSuccess: true, toolCalls: 2, uncertainWrites: 0 });
  // Confirmed siblings cannot make an uncertain write look landed.
  assert.deepEqual(join.toolSuccessFromSettlements([row('provider_execution', 'succeeded'), row('provider_execution', 'succeeded'),
    row('provider_execution', 'uncertain_write')]), { toolCalls: 2, uncertainWrites: 1 });
  // A failure outranks uncertainty.
  assert.deepEqual(join.toolSuccessFromSettlements([row('provider_execution', 'invalid_arguments'), row('provider_execution', 'uncertain_write')]),
    { toolSuccess: false, toolCalls: 1, uncertainWrites: 1 });
});

function settlementsDb(rows: Array<{ sessionId: string; seq: number; execution: string; outcome: string }>): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE logical_call_settlements (session_id TEXT, source_user_seq INTEGER, execution_kind TEXT, outcome_kind TEXT)');
  const insert = db.prepare('INSERT INTO logical_call_settlements VALUES (?, ?, ?, ?)');
  for (const row of rows) insert.run(row.sessionId, row.seq, row.execution, row.outcome);
  return db;
}

function routedCall(sessionId: string, role: 'brain' | 'judge' | 'worker', runAttemptId: string, when: string,
  status: 'success' | 'failed' = 'success'): string {
  const id = metrics.recordModelRouteDecision({ sessionId, role, resolvedModel: 'model-a', provider: 'claude', source: 'default',
    reason: { runAttemptId }, now: new Date(when) });
  metrics.recordModelRouteOutcome({ decisionId: id, status, latencyMs: 900, now: new Date(when) });
  return id;
}

function outcomeRow(decisionId: string) {
  return metrics.openModelRouteMetricsDb().prepare('SELECT * FROM model_route_outcomes WHERE decision_id = ?').get(decisionId) as Record<string, unknown>;
}

/** The published terminal as the join reads it (the committer hands over its event). */
let terminals = 0;
function terminalFor(sourceUserSeq: number, data: Record<string, unknown>, createdAt = at(new Date().toISOString(), 60_000)) {
  terminals += 1;
  return { id: `terminal-${terminals}`, createdAt, data: { sourceUserSeq, ...data } };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

test('the verdict lands on the request in the same attempt that answered before the review, once', async () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Draft the note.' } });
  const t0 = source.createdAt;
  const otherAttempt = routedCall(session.id, 'brain', 'attempt:fixture:earlier', at(t0, 1));
  const first = routedCall(session.id, 'brain', ATTEMPT, at(t0, 2));
  const wrote = routedCall(session.id, 'brain', ATTEMPT, at(t0, 3));
  const judge = routedCall(session.id, 'judge', ATTEMPT, at(t0, 4));
  await settle();
  const judged = eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'goal_alignment_judged',
    data: { lane: 'host_v1', kind: 'completion', sourceUserSeq: source.seq, fulfills: true, continuation: false } });
  // A request after the verdict (a closing narration) did not write the reviewed reply.
  const after = routedCall(session.id, 'brain', ATTEMPT, at(judged.createdAt, 5_000));
  const terminal = terminalFor(source.seq, { attemptId: ATTEMPT,
    completionVerdictRef: { sourceUserSeq: source.seq, eventId: judged.id, fulfills: true, verified: true, replyMatches: true } },
  at(judged.createdAt, 6_000));
  const settlements = settlementsDb([{ sessionId: session.id, seq: source.seq, execution: 'provider_execution', outcome: 'succeeded' }]);
  const before = { otherAttempt: outcomeRow(otherAttempt), first: outcomeRow(first), judge: outcomeRow(judge), after: outcomeRow(after) };

  const result = join.joinRouteOutcomeVerdict({ sessionId: session.id, sourceUserSeq: source.seq, terminal }, { settlementsDb: settlements });
  assert.equal(result.decisionId, wrote);
  assert.equal(result.updated, true);
  const row = outcomeRow(wrote);
  assert.equal(row.objective_met, 1);
  assert.equal(row.tool_success, 1);
  assert.equal(row.status, 'success', 'the provider-side outcome is untouched');
  assert.deepEqual(JSON.parse(String(row.metadata_json)).verdict, { sourceUserSeq: source.seq, runAttemptId: ATTEMPT,
    terminalEventId: terminal.id, attemptRequests: 2, verdictEventId: judged.id });
  assert.deepEqual({ otherAttempt: outcomeRow(otherAttempt), first: outcomeRow(first), judge: outcomeRow(judge), after: outcomeRow(after) },
    before, 'another attempt, an earlier request, the judge and a later request keep their rows');
  assert.equal(eventlog.listEvents(session.id, { types: ['route_outcome_judged'] }).length, 1);
  assert.equal(join.joinRouteOutcomeVerdict({ sessionId: session.id, sourceUserSeq: source.seq, terminal }, { settlementsDb: settlements }).updated, false,
    'a replayed terminal writes nothing new');
});

test('a terminal with no attempt, or with nothing proven, changes no row', () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Hi.' } });
  const call = routedCall(session.id, 'brain', ATTEMPT, at(source.createdAt, 1));
  const before = outcomeRow(call);
  const judged = eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'goal_alignment_judged',
    data: { lane: 'host_v1', kind: 'completion', sourceUserSeq: source.seq, fulfills: true, continuation: false } });
  const noAttempt = terminalFor(source.seq, {
    completionVerdictRef: { sourceUserSeq: source.seq, eventId: judged.id, fulfills: true, verified: true, replyMatches: true } });
  assert.equal(join.joinRouteOutcomeVerdict({ sessionId: session.id, sourceUserSeq: source.seq, terminal: noAttempt },
    { settlementsDb: settlementsDb([]) }).updated, false, 'no attempt, no binding');
  const unreviewed = terminalFor(source.seq, { attemptId: ATTEMPT });
  assert.equal(join.joinRouteOutcomeVerdict({ sessionId: session.id, sourceUserSeq: source.seq, terminal: unreviewed },
    { settlementsDb: settlementsDb([]) }).updated, false, 'no review, no calls');
  assert.deepEqual(outcomeRow(call), before);
});

test('an uncertain write is recorded beside the verdict and never as a landed result', () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Send both.' } });
  const call = routedCall(session.id, 'brain', ATTEMPT, at(source.createdAt, 1));
  const terminal = terminalFor(source.seq, { attemptId: ATTEMPT });
  const result = join.joinRouteOutcomeVerdict({ sessionId: session.id, sourceUserSeq: source.seq, terminal }, {
    settlementsDb: settlementsDb([
      { sessionId: session.id, seq: source.seq, execution: 'provider_execution', outcome: 'succeeded' },
      { sessionId: session.id, seq: source.seq, execution: 'provider_execution', outcome: 'uncertain_write' },
    ]) });
  assert.equal(result.updated, true);
  const row = outcomeRow(call);
  assert.equal(row.tool_success, null);
  assert.equal(JSON.parse(String(row.metadata_json)).verdict.uncertainWrites, 1);
  assert.equal(eventlog.listEvents(session.id, { types: ['route_outcome_judged'] }).at(-1)!.data.uncertainWrites, 1);
});

test('a helper\'s usable result is its own attempt\'s route signal', () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Item 1.' } });
  const other = routedCall(session.id, 'worker', 'attempt:fixture:other-helper', at(source.createdAt, 400));
  const call = routedCall(session.id, 'worker', ATTEMPT, at(source.createdAt, 500));
  const result = join.joinWorkerRouteOutcome({ sessionId: session.id, sourceUserSeq: source.seq, runAttemptId: ATTEMPT, usable: false });
  assert.equal(result.decisionId, call);
  assert.equal(outcomeRow(call).tool_success, 0);
  assert.equal(outcomeRow(other).tool_success, null);
});

test('the join never reaches the turn: broken storage returns quietly and a scheduled throw is swallowed', async () => {
  const broken = new Database(':memory:');
  broken.close();
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'x' } });
  const terminal = terminalFor(source.seq, { attemptId: ATTEMPT });
  assert.equal(join.joinRouteOutcomeVerdict({ sessionId: session.id, sourceUserSeq: source.seq, terminal },
    { metricsDb: broken, settlementsDb: settlementsDb([{ sessionId: session.id, seq: source.seq, execution: 'local_execution', outcome: 'succeeded' }]) }).updated, false);
  assert.equal(metrics.updateModelRouteOutcomeVerdict('d', { objectiveMet: true }, broken), false);
  let ran = false;
  join.scheduleRouteOutcomeJoin(() => { ran = true; throw new Error('storage gone'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, true);
});

test('a routed request records its accepted source and run attempt, only for its own session', async () => {
  const db = new Database(':memory:');
  db.exec(metrics.MODEL_ROUTE_METRICS_SCHEMA_SQL);
  const response = { output: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as unknown as ModelResponse;
  const inner = { getResponse: async () => response, getStreamedResponse: async function* () { yield { type: 'response_done', response } as never; } } as Model;
  const request = { input: 'x', modelSettings: {}, tools: [], handoffs: [] } as unknown as ModelRequest;
  const context = { role: 'brain' as const, resolvedModel: 'model-a', provider: 'claude', source: 'default' as const };
  const run = { sessionId: 'sess-a', sourceUserSeq: 41, runAttemptId: ATTEMPT, counter: new ToolCallsCounter(10) };
  await withHarnessRunContext(run, () => metrics.withModelRouteMetrics(inner, { ...context, sessionId: 'sess-a' }, db).getResponse(request));
  await withHarnessRunContext(run, () => metrics.withModelRouteMetrics(inner, { ...context, sessionId: 'sess-b' }, db).getResponse(request));
  const reasons = (db.prepare('SELECT session_id, reason_json FROM model_route_decisions ORDER BY rowid').all() as Array<{ session_id: string; reason_json: string }>)
    .map((row) => { const reason = JSON.parse(row.reason_json); return [row.session_id, reason.sourceUserSeq, reason.runAttemptId]; });
  assert.deepEqual(reasons, [['sess-a', 41, ATTEMPT], ['sess-b', undefined, undefined]]);
  db.close();
});
