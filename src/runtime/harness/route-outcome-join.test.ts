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

const verdict = (data: Record<string, unknown>, id = `ev-${Math.random()}`) => ({ id, data: { lane: 'host_v1', kind: 'completion', sourceUserSeq: 7, continuation: false, ...data } });

test('a passed review is true, a rejection or a block is false, and nothing that is not a review of the shipped reply counts', () => {
  assert.deepEqual(join.objectiveFromVerdictRows([verdict({ fulfills: true }, 'a')], 7), { objectiveMet: true, verdictEventId: 'a' });
  assert.equal(join.objectiveFromVerdictRows([verdict({ fulfills: false, blocked: true })], 7).objectiveMet, false);
  assert.equal(join.objectiveFromVerdictRows([verdict({ fulfills: false, carriedVerdict: true })], 7).objectiveMet, false);
  for (const unknown of [{ failedOpen: true, fulfills: true }, { selfJudge: true, fulfills: true }, { awaitingUser: true, fulfills: false },
    { planDigest: 'p', fulfills: true }, { continuation: true, fulfills: false }]) {
    assert.equal(join.objectiveFromVerdictRows([verdict(unknown)], 7).objectiveMet, undefined, JSON.stringify(unknown));
  }
  // The last word wins: a rejection the next round fixed is a pass.
  assert.equal(join.objectiveFromVerdictRows([verdict({ fulfills: false, continuation: true }), verdict({ fulfills: true })], 7).objectiveMet, true);
  // The host deleting flagged claims is an edit; the reviewer's rejection stands.
  assert.equal(join.objectiveFromVerdictRows([verdict({ fulfills: false }), verdict({ fulfills: true, claimRemoval: { removed: ['x'] } })], 7).objectiveMet, false);
  // Another source's verdict, the watcher, and no rows say nothing.
  assert.deepEqual(join.objectiveFromVerdictRows([verdict({ fulfills: true, sourceUserSeq: 8 }), verdict({ kind: 'watcher', fulfills: false })], 7), {});
  assert.deepEqual(join.objectiveFromVerdictRows([], 7), {});
});

test('tool success counts dispatched calls only, and an empty result is a landed call', () => {
  const row = (execution_kind: string, outcome_kind: string) => ({ execution_kind, outcome_kind });
  assert.deepEqual(join.toolSuccessFromSettlements([]), { toolCalls: 0 });
  assert.deepEqual(join.toolSuccessFromSettlements([row('refused_pre_dispatch', 'policy_denial')]), { toolCalls: 0 });
  assert.deepEqual(join.toolSuccessFromSettlements([row('provider_execution', 'succeeded'), row('local_execution', 'empty_result'),
    row('refused_pre_dispatch', 'invalid_arguments'), row('provider_execution', 'input_required')]), { toolSuccess: true, toolCalls: 2 });
  assert.deepEqual(join.toolSuccessFromSettlements([row('provider_execution', 'succeeded'), row('provider_execution', 'invalid_arguments')]),
    { toolSuccess: false, toolCalls: 2 });
});

function settlementsDb(rows: Array<{ sessionId: string; seq: number; execution: string; outcome: string }>): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE logical_call_settlements (session_id TEXT, source_user_seq INTEGER, execution_kind TEXT, outcome_kind TEXT)');
  const insert = db.prepare('INSERT INTO logical_call_settlements VALUES (?, ?, ?, ?)');
  for (const row of rows) insert.run(row.sessionId, row.seq, row.execution, row.outcome);
  return db;
}

function brainCall(sessionId: string, sourceUserSeq: number, role: 'brain' | 'judge' | 'worker', at: string, status: 'success' | 'failed' = 'success'): string {
  const id = metrics.recordModelRouteDecision({ sessionId, role, resolvedModel: 'model-a', provider: 'claude', source: 'default',
    reason: { sourceUserSeq }, now: new Date(at) });
  metrics.recordModelRouteOutcome({ decisionId: id, status, latencyMs: 900, now: new Date(at) });
  return id;
}

function outcomeRow(decisionId: string) {
  return metrics.openModelRouteMetricsDb().prepare('SELECT * FROM model_route_outcomes WHERE decision_id = ?').get(decisionId) as Record<string, unknown>;
}

test('a reviewed turn\'s verdict and tool success land on the brain request that wrote its reply, once', () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Draft the note.' } });
  const later = new Date(Date.parse(source.createdAt) + 1_000).toISOString();
  const latest = new Date(Date.parse(source.createdAt) + 3_000).toISOString();
  const first = brainCall(session.id, source.seq, 'brain', later);
  const last = brainCall(session.id, source.seq, 'brain', latest);
  const judge = brainCall(session.id, source.seq, 'judge', latest);
  const otherSource = brainCall(session.id, source.seq + 50, 'brain', latest);
  const failedAfter = brainCall(session.id, source.seq, 'brain', new Date(Date.parse(source.createdAt) + 4_000).toISOString(), 'failed');
  const judged = eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'goal_alignment_judged',
    data: { lane: 'host_v1', kind: 'completion', sourceUserSeq: source.seq, fulfills: true, continuation: false } });
  const settlements = settlementsDb([{ sessionId: session.id, seq: source.seq, execution: 'provider_execution', outcome: 'succeeded' }]);
  const before = { first: outcomeRow(first), judge: outcomeRow(judge), otherSource: outcomeRow(otherSource), failedAfter: outcomeRow(failedAfter) };

  const result = join.joinRouteOutcomeVerdict({ sessionId: session.id, sourceUserSeq: source.seq }, { settlementsDb: settlements });
  assert.equal(result.decisionId, last);
  assert.equal(result.updated, true);
  const row = outcomeRow(last);
  assert.equal(row.objective_met, 1);
  assert.equal(row.tool_success, 1);
  assert.equal(row.tool_calls, 1);
  assert.equal(row.status, 'success', 'the provider-side outcome is untouched');
  assert.deepEqual(JSON.parse(String(row.metadata_json)).verdict, { sourceUserSeq: source.seq, turnRequests: 2, verdictEventId: judged.id });
  assert.deepEqual({ first: outcomeRow(first), judge: outcomeRow(judge), otherSource: outcomeRow(otherSource), failedAfter: outcomeRow(failedAfter) }, before,
    'earlier requests, the judge, another source and an unanswered request keep their rows');
  const recorded = eventlog.listEvents(session.id, { types: ['route_outcome_judged'] });
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0]!.data, { sourceUserSeq: source.seq, decisionId: last, routeRole: 'brain', objectiveMet: true,
    toolSuccess: true, toolCalls: 1, verdictEventId: judged.id });

  // A replayed terminal writes nothing new.
  assert.equal(join.joinRouteOutcomeVerdict({ sessionId: session.id, sourceUserSeq: source.seq }, { settlementsDb: settlements }).updated, false);
  assert.equal(eventlog.listEvents(session.id, { types: ['route_outcome_judged'] }).length, 1);

  // A later block on the same source is the last word.
  eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'goal_alignment_judged',
    data: { lane: 'host_v1', kind: 'completion', sourceUserSeq: source.seq, fulfills: false, blocked: true, continuation: false } });
  assert.equal(join.joinRouteOutcomeVerdict({ sessionId: session.id, sourceUserSeq: source.seq }, { settlementsDb: settlements }).updated, true);
  assert.equal(outcomeRow(last).objective_met, 0);
});

test('an unreviewed turn with no calls leaves its rows exactly as they were; a failed call with no review records only that', () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Hi.' } });
  const call = brainCall(session.id, source.seq, 'brain', new Date(Date.parse(source.createdAt) + 500).toISOString());
  const before = outcomeRow(call);
  const quiet = join.joinRouteOutcomeVerdict({ sessionId: session.id, sourceUserSeq: source.seq }, { settlementsDb: settlementsDb([]) });
  assert.equal(quiet.updated, false);
  assert.deepEqual(outcomeRow(call), before);
  assert.equal(eventlog.listEvents(session.id, { types: ['route_outcome_judged'] }).length, 0);

  // A review that failed open is not a verdict.
  eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'goal_alignment_judged',
    data: { lane: 'host_v1', kind: 'completion', sourceUserSeq: source.seq, fulfills: true, failedOpen: true, continuation: false } });
  const failedCall = settlementsDb([{ sessionId: session.id, seq: source.seq, execution: 'provider_execution', outcome: 'invalid_arguments' }]);
  assert.equal(join.joinRouteOutcomeVerdict({ sessionId: session.id, sourceUserSeq: source.seq }, { settlementsDb: failedCall }).updated, true);
  assert.equal(outcomeRow(call).objective_met, null, 'a failed-open review never reads as passed or failed');
  assert.equal(outcomeRow(call).tool_success, 0);
});

test('a helper\'s usable result is its route\'s tool signal', () => {
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Item 1.' } });
  const call = brainCall(session.id, source.seq, 'worker', new Date(Date.parse(source.createdAt) + 500).toISOString());
  const result = join.joinWorkerRouteOutcome({ sessionId: session.id, sourceUserSeq: source.seq, usable: false });
  assert.equal(result.decisionId, call);
  assert.equal(outcomeRow(call).tool_success, 0);
  assert.equal(outcomeRow(call).objective_met, null, 'a helper is not judged by the parent\'s review here');
});

test('the join never reaches the turn: broken storage returns quietly and a scheduled throw is swallowed', async () => {
  const broken = new Database(':memory:');
  broken.close();
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'x' } });
  eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'goal_alignment_judged',
    data: { lane: 'host_v1', kind: 'completion', sourceUserSeq: source.seq, fulfills: true, continuation: false } });
  assert.equal(join.joinRouteOutcomeVerdict({ sessionId: session.id, sourceUserSeq: source.seq },
    { metricsDb: broken, settlementsDb: settlementsDb([]) }).updated, false);
  assert.equal(metrics.updateModelRouteOutcomeVerdict('d', { objectiveMet: true }, broken), false);
  let ran = false;
  join.scheduleRouteOutcomeJoin(() => { ran = true; throw new Error('storage gone'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, true);
});

test('a routed request records the accepted source it worked on, only for its own session', async () => {
  const db = new Database(':memory:');
  db.exec(metrics.MODEL_ROUTE_METRICS_SCHEMA_SQL);
  const response = { output: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as unknown as ModelResponse;
  const inner = { getResponse: async () => response, getStreamedResponse: async function* () { yield { type: 'response_done', response } as never; } } as Model;
  const request = { input: 'x', modelSettings: {}, tools: [], handoffs: [] } as unknown as ModelRequest;
  const context = { role: 'brain' as const, resolvedModel: 'model-a', provider: 'claude', source: 'default' as const };
  await withHarnessRunContext({ sessionId: 'sess-a', sourceUserSeq: 41, counter: new ToolCallsCounter(10) },
    () => metrics.withModelRouteMetrics(inner, { ...context, sessionId: 'sess-a' }, db).getResponse(request));
  await withHarnessRunContext({ sessionId: 'sess-a', sourceUserSeq: 41, counter: new ToolCallsCounter(10) },
    () => metrics.withModelRouteMetrics(inner, { ...context, sessionId: 'sess-b' }, db).getResponse(request));
  const reasons = (db.prepare('SELECT session_id, reason_json FROM model_route_decisions ORDER BY rowid').all() as Array<{ session_id: string; reason_json: string }>)
    .map((row) => [row.session_id, JSON.parse(row.reason_json).sourceUserSeq]);
  assert.deepEqual(reasons, [['sess-a', 41], ['sess-b', undefined]]);
  db.close();
});
