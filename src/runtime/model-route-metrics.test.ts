import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

import {
  MODEL_ROUTE_METRICS_SCHEMA_SQL,
  MODEL_ROUTE_METRICS_SCHEMA_VERSION,
  MODEL_ROUTE_METRICS_TABLES,
  recordModelRouteDecision,
  recordModelRouteOutcome,
  successfulRouteOutcome,
  scoreModelRouteCandidate,
  selectBestRouteCandidate,
  summarizeRouteOutcomes,
  withModelRouteMetrics,
} from './model-route-metrics.js';
import { withModelFallback } from './harness/fallback-model.js';

function metricsDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(MODEL_ROUTE_METRICS_SCHEMA_SQL);
  return db;
}

function requestWithSentinel(): ModelRequest {
  return {
    input: 'PRIVATE_PROMPT_SENTINEL',
    modelSettings: {},
    tools: [],
    handoffs: [],
  } as unknown as ModelRequest;
}

function responseModel(response: ModelResponse): Model {
  return {
    getResponse: async () => response,
    getStreamedResponse: async function* () {
      yield { type: 'response_done', response } as never;
    },
  } as Model;
}

function responseWith(
  usage: Record<string, unknown>,
  providerData: Record<string, unknown> = {},
): ModelResponse {
  return {
    output: [{ type: 'message', role: 'assistant', content: 'PRIVATE_RESPONSE_SENTINEL' }],
    usage,
    providerData,
  } as unknown as ModelResponse;
}

test('successful fallback is attributed to the brain that actually served it', () => {
  assert.deepEqual(successfulRouteOutcome({
    initialLabel: 'claude-opus',
    resolvedLabel: 'codex:rescue',
    provider: 'codex',
    model: 'gpt-5.6-mini',
    fellOver: true,
    reason: 'model.overloaded',
  }, { path: 'getResponse' }), {
    status: 'fallback',
    falloverToModel: 'gpt-5.6-mini',
    metadata: {
      path: 'getResponse',
      actualResolvedLabel: 'codex:rescue',
      actualProvider: 'codex',
      actualModel: 'gpt-5.6-mini',
      falloverReason: 'model.overloaded',
    },
  });
});

test('model route metrics schema metadata is explicit', () => {
  assert.equal(MODEL_ROUTE_METRICS_SCHEMA_VERSION, 1);
  assert.deepEqual(MODEL_ROUTE_METRICS_TABLES, [
    'model_route_decisions',
    'model_route_outcomes',
    'model_route_policy',
  ]);
});

test('model route metrics schema applies and cascades outcomes with decisions', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(MODEL_ROUTE_METRICS_SCHEMA_SQL);
    const rows = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    const names = new Set(rows.map((row) => row.name));
    for (const table of MODEL_ROUTE_METRICS_TABLES) assert.ok(names.has(table), `missing ${table}`);

    db.prepare(`
      INSERT INTO model_route_decisions (
        id, created_at, session_id, workspace_id, role, intent, requested_model,
        resolved_model, provider, source, reason_json, policy_version
      ) VALUES (
        'dec-1', '2026-06-30T00:00:00.000Z', 'sess-1', 'ws-1', 'worker', 'design',
        'claude-opus', 'claude-opus', 'claude', 'intent_binding', '{}', 1
      )
    `).run();
    db.prepare(`
      INSERT INTO model_route_outcomes (
        decision_id, completed_at, status, latency_ms, total_tokens, cost_usd,
        tool_success, objective_met
      ) VALUES (
        'dec-1', '2026-06-30T00:00:04.000Z', 'success', 4000, 1200, 0.02, 1, 1
      )
    `).run();

    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM model_route_outcomes').get() as { n: number }).n, 1);
    db.prepare('DELETE FROM model_route_decisions WHERE id = ?').run('dec-1');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM model_route_outcomes').get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});

test('summarizeRouteOutcomes computes success, objective, tool, latency, token, and cost metrics', () => {
  const summary = summarizeRouteOutcomes([
    { status: 'success', latencyMs: 1000, totalTokens: 1000, costUsd: 0.01, objectiveMet: true, toolSuccess: true },
    { status: 'success', latencyMs: 3000, totalTokens: 3000, costUsd: 0.03, objectiveMet: false, toolSuccess: true },
    { status: 'fallback', latencyMs: 6000, totalTokens: 6000, costUsd: 0.06, objectiveMet: false, toolSuccess: false },
    { status: 'failed', objectiveMet: false, toolSuccess: false },
  ]);

  assert.equal(summary.sampleCount, 4);
  assert.equal(summary.successCount, 2);
  assert.equal(summary.failureCount, 1);
  assert.equal(summary.fallbackCount, 1);
  assert.equal(summary.successRate, 0.5);
  assert.equal(summary.objectiveRate, 0.25);
  assert.equal(summary.toolSuccessRate, 0.5);
  assert.equal(summary.avgLatencyMs, 3333.3333333333335);
  assert.equal(summary.avgTokens, 3333.3333333333335);
  assert.equal(summary.avgCostUsd, 0.03333333333333333);
});

test('recordModelRouteDecision and recordModelRouteOutcome append route rows', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(MODEL_ROUTE_METRICS_SCHEMA_SQL);
    const decisionId = recordModelRouteDecision({
      id: 'dec-recorded',
      now: new Date('2026-06-30T00:00:00.000Z'),
      sessionId: 'sess-1',
      role: 'brain',
      requestedModel: 'gpt-5.4',
      resolvedModel: 'gpt-5.4',
      provider: 'codex',
      source: 'explicit',
      reason: { routingMode: 'standard' },
    }, db);
    recordModelRouteOutcome({
      decisionId,
      now: new Date('2026-06-30T00:00:03.000Z'),
      status: 'success',
      latencyMs: 3000,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      metadata: { path: 'getResponse' },
    }, db);

    const decision = db.prepare('SELECT * FROM model_route_decisions WHERE id = ?').get(decisionId) as { resolved_model: string; reason_json: string };
    assert.equal(decision.resolved_model, 'gpt-5.4');
    assert.deepEqual(JSON.parse(decision.reason_json), { routingMode: 'standard' });
    const outcome = db.prepare('SELECT * FROM model_route_outcomes WHERE decision_id = ?').get(decisionId) as { status: string; total_tokens: number; metadata_json: string };
    assert.equal(outcome.status, 'success');
    assert.equal(outcome.total_tokens, 15);
    assert.deepEqual(JSON.parse(outcome.metadata_json), { path: 'getResponse' });
  } finally {
    db.close();
  }
});

test('recordModelRouteOutcome tolerates missing decisions without throwing', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(MODEL_ROUTE_METRICS_SCHEMA_SQL);
    assert.doesNotThrow(() => {
      recordModelRouteOutcome({
        decisionId: 'missing',
        status: 'failed',
        errorClass: 'Error',
      }, db);
    });
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM model_route_outcomes').get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});

test('provider recording adapters persist explicit cost only and preserve token/cache fields', async () => {
  const db = metricsDb();
  try {
    const cases: Array<{
      id: string;
      provider: 'codex' | 'claude' | 'byo';
      response: ModelResponse;
      expected: { input: number; output: number; cached: number; total: number; cost: number | null };
    }> = [
      {
        id: 'codex-shaped',
        provider: 'codex',
        response: responseWith({
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          inputTokensDetails: { cachedTokens: 40 },
        }),
        expected: { input: 100, output: 20, cached: 40, total: 120, cost: null },
      },
      {
        id: 'claude-cost',
        provider: 'claude',
        response: responseWith({
          input_tokens: 80,
          output_tokens: 12,
          total_tokens: 92,
          input_tokens_details: { cache_read_input_tokens: 30 },
        }, { totalCostUsd: 0.125 }),
        expected: { input: 80, output: 12, cached: 30, total: 92, cost: 0.125 },
      },
      {
        id: 'claude-zero-cost',
        provider: 'claude',
        response: responseWith({ inputTokens: 5, outputTokens: 1, totalTokens: 6 }, { totalCostUsd: 0 }),
        expected: { input: 5, output: 1, cached: 0, total: 6, cost: 0 },
      },
      {
        id: 'byo-no-cost',
        provider: 'byo',
        response: responseWith({
          prompt_tokens: 70,
          completion_tokens: 9,
          total_tokens: 79,
          prompt_tokens_details: { cached_tokens: 25 },
        }),
        expected: { input: 70, output: 9, cached: 25, total: 79, cost: null },
      },
    ];

    for (const fixture of cases) {
      const recorded = withModelRouteMetrics(responseModel(fixture.response), {
        modelCallIdPrefix: fixture.id,
        sessionId: 'metrics-adapter-test',
        role: 'brain',
        resolvedModel: fixture.id,
        provider: fixture.provider,
        source: 'explicit',
        reason: { fixture: fixture.id },
      }, db);
      await recorded.getResponse(requestWithSentinel());
    }

    const rows = db.prepare(`
      SELECT d.resolved_model, d.reason_json, o.input_tokens, o.output_tokens,
             o.cached_tokens, o.total_tokens, o.cost_usd, o.metadata_json
      FROM model_route_decisions d
      JOIN model_route_outcomes o ON o.decision_id = d.id
      ORDER BY d.rowid ASC
    `).all() as Array<{
      resolved_model: string;
      reason_json: string;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number | null;
      total_tokens: number;
      cost_usd: number | null;
      metadata_json: string;
    }>;
    assert.equal(rows.length, cases.length);
    for (const [index, row] of rows.entries()) {
      const expected = cases[index]!.expected;
      assert.equal(row.input_tokens, expected.input);
      assert.equal(row.output_tokens, expected.output);
      assert.equal(row.cached_tokens ?? 0, expected.cached);
      assert.equal(row.total_tokens, expected.total);
      assert.equal(row.input_tokens - (row.cached_tokens ?? 0), expected.input - expected.cached,
        'uncached prompt tokens remain derivable without folding cached tokens twice');
      assert.equal(row.cost_usd, expected.cost);
      assert.doesNotMatch(`${row.reason_json}${row.metadata_json}`, /PRIVATE_(?:PROMPT|RESPONSE)_SENTINEL/);
    }

    const aggregate = db.prepare(`
      SELECT COUNT(*) AS attempts, COUNT(cost_usd) AS priced_attempts, SUM(cost_usd) AS actual_cost_usd
      FROM model_route_outcomes
    `).get() as { attempts: number; priced_attempts: number; actual_cost_usd: number };
    assert.deepEqual(aggregate, { attempts: 4, priced_attempts: 2, actual_cost_usd: 0.125 },
      'actual zero is available/priced while unavailable provider cost remains NULL');
  } finally {
    db.close();
  }
});

test('fallover records exactly one row for each provider attempt and no aggregate mirror row', async () => {
  const db = metricsDb();
  try {
    const primary = {
      getResponse: async () => { throw { statusCode: 529, message: 'overloaded' }; },
      getStreamedResponse: async function* () { throw { statusCode: 529, message: 'overloaded' }; },
    } as Model;
    const rescue = responseModel(responseWith(
      { inputTokens: 11, outputTokens: 3, totalTokens: 14 },
      { totalCostUsd: 0.02 },
    ));

    const recordedFallback = withModelRouteMetrics(withModelFallback([
      { label: 'primary', provider: 'codex', model: 'codex-primary', getModel: () => primary },
      { label: 'rescue', provider: 'claude', model: 'claude-rescue', getModel: () => rescue },
    ]), {
      sessionId: 'fallover-attempt-test',
      role: 'brain',
      resolvedModel: 'codex-primary',
      provider: 'codex',
      source: 'explicit',
    }, db);
    await recordedFallback.getResponse(requestWithSentinel());

    const rows = db.prepare(`
      SELECT d.resolved_model, o.status, o.total_tokens, o.cost_usd
      FROM model_route_decisions d
      JOIN model_route_outcomes o ON o.decision_id = d.id
      ORDER BY d.rowid ASC
    `).all();
    assert.deepEqual(rows, [
      { resolved_model: 'codex-primary', status: 'failed', total_tokens: null, cost_usd: null },
      { resolved_model: 'claude-rescue', status: 'success', total_tokens: 14, cost_usd: 0.02 },
    ]);
  } finally {
    db.close();
  }
});

test('duplicate retry/mirror finalization cannot overwrite or double-count an actual attempt', () => {
  const db = metricsDb();
  try {
    const decisionId = recordModelRouteDecision({
      id: 'immutable-attempt',
      role: 'brain',
      resolvedModel: 'claude-zero-cost',
      provider: 'claude',
      source: 'explicit',
    }, db);
    assert.equal(recordModelRouteOutcome({
      decisionId,
      status: 'success',
      inputTokens: 3,
      cachedTokens: 1,
      totalTokens: 4,
      costUsd: 0,
    }, db), true);
    assert.equal(recordModelRouteOutcome({
      decisionId,
      status: 'failed',
      totalTokens: 999,
      costUsd: 999,
      metadata: { accounting: 'transport_mirror' },
    }, db), false);
    recordModelRouteDecision({
      id: decisionId,
      role: 'brain',
      resolvedModel: 'mirror-must-not-replace-original',
      provider: 'unknown',
      source: 'fallback',
    }, db);
    assert.deepEqual(db.prepare(`
      SELECT d.resolved_model, o.status, o.input_tokens, o.cached_tokens, o.total_tokens, o.cost_usd
      FROM model_route_decisions d
      JOIN model_route_outcomes o ON o.decision_id = d.id
    `).all(), [{
      resolved_model: 'claude-zero-cost',
      status: 'success',
      input_tokens: 3,
      cached_tokens: 1,
      total_tokens: 4,
      cost_usd: 0,
    }]);
  } finally {
    db.close();
  }
});

test('an adapter-owned transport retry produces one canonical model-call row', async () => {
  const db = metricsDb();
  try {
    let transportAttempts = 0;
    const retryingAdapter: Model = {
      async getResponse() {
        for (;;) {
          transportAttempts += 1;
          try {
            if (transportAttempts === 1) throw new Error('retryable transport reset');
            return responseWith({ inputTokens: 9, outputTokens: 2, totalTokens: 11 });
          } catch (error) {
            // Simulate the adapter's bounded wire retry below the model-call
            // boundary. Only its terminal provider response owns accounting.
            if (transportAttempts >= 2) throw error;
          }
        }
      },
      async *getStreamedResponse() {
        throw new Error('unused');
      },
    };
    await withModelRouteMetrics(retryingAdapter, {
      sessionId: 'adapter-retry-test',
      role: 'brain',
      resolvedModel: 'codex-retrying-adapter',
      provider: 'codex',
      source: 'explicit',
    }, db).getResponse(requestWithSentinel());

    assert.equal(transportAttempts, 2);
    assert.deepEqual(db.prepare(`
      SELECT COUNT(*) AS attempts, SUM(total_tokens) AS total_tokens, COUNT(cost_usd) AS priced_attempts
      FROM model_route_outcomes
    `).get(), { attempts: 1, total_tokens: 11, priced_attempts: 0 });
  } finally {
    db.close();
  }
});

test('scoreModelRouteCandidate rewards outcomes and penalizes latency/cost/tokens/fallover', () => {
  const strong = summarizeRouteOutcomes([
    { status: 'success', latencyMs: 1000, totalTokens: 1000, costUsd: 0.01, objectiveMet: true, toolSuccess: true },
    { status: 'success', latencyMs: 1200, totalTokens: 1100, costUsd: 0.01, objectiveMet: true, toolSuccess: true },
  ]);
  const weak = summarizeRouteOutcomes([
    { status: 'success', latencyMs: 29_000, totalTokens: 60_000, costUsd: 0.22, objectiveMet: false, toolSuccess: false },
    { status: 'fallback', latencyMs: 30_000, totalTokens: 64_000, costUsd: 0.25, objectiveMet: false, toolSuccess: false },
  ]);

  assert.ok(scoreModelRouteCandidate(strong) > scoreModelRouteCandidate(weak));
  assert.equal(scoreModelRouteCandidate(summarizeRouteOutcomes([])), 0);
});

test('selectBestRouteCandidate skips disabled candidates and tie-breaks by sample count then model', () => {
  const summary = summarizeRouteOutcomes([
    { status: 'success', objectiveMet: true, toolSuccess: true },
  ]);
  const largerSummary = summarizeRouteOutcomes([
    { status: 'success', objectiveMet: true, toolSuccess: true },
    { status: 'success', objectiveMet: true, toolSuccess: true },
  ]);

  const best = selectBestRouteCandidate([
    {
      role: 'worker',
      provider: 'claude',
      model: 'claude-disabled',
      summary: largerSummary,
      disabledReason: 'manual override',
    },
    { role: 'worker', provider: 'byo', model: 'z-model', summary },
    { role: 'worker', provider: 'codex', model: 'a-model', summary },
    { role: 'worker', provider: 'claude', model: 'm-model', summary: largerSummary },
  ]);

  assert.equal(best?.model, 'm-model');
});
