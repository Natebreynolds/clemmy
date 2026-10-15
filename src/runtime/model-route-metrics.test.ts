import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

import {
  MODEL_ROUTE_METRICS_DB_PATH,
  MODEL_ROUTE_METRICS_SCHEMA_SQL,
  MODEL_ROUTE_METRICS_SCHEMA_VERSION,
  MODEL_ROUTE_METRICS_STATE_DIR,
  MODEL_ROUTE_METRICS_TABLES,
  openModelRouteMetricsDb,
  readRouteStandIn,
  recordModelRouteDecision,
  recordModelRouteOutcome,
  resetModelRouteMetricsForTest,
  successfulRouteOutcome,
  scoreModelRouteCandidate,
  selectBestRouteCandidate,
  summarizeRouteOutcomes,
  widenModelRouteMetricsDb,
  widenModelRouteRoleChecks,
  withModelRouteMetrics,
  withModelRouteObserver,
  type ObservedModelRoute,
} from './model-route-metrics.js';
import { clearRateLimitedBrainsForTest, withModelFallback } from './harness/fallback-model.js';

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

test('summarizeRouteOutcomes rates review and tool success over the samples that carry them', () => {
  const summary = summarizeRouteOutcomes([
    { status: 'success' },
    { status: 'success' },
    { status: 'success', objectiveMet: true, toolSuccess: true },
    { status: 'success' },
    { status: 'success', objectiveMet: false },
    { status: 'failed' },
  ]);
  assert.equal(summary.objectiveRate, 0.5, 'one of two reviewed turns passed; unreviewed requests are not failures');
  assert.equal(summary.toolSuccessRate, 1);
  assert.equal(summarizeRouteOutcomes([{ status: 'success' }]).objectiveRate, 0);
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


test('nested reviewer usage measures its own request on ordinary and streamed calls', async () => {
  const { withModelUsageAttribution, recordModelUsage, readUsageEventsForDate } = await import('./usage-log.js');
  const { estimateTokens } = await import('./harness/budget.js');
  const db = metricsDb();
  const source = 'reviewer-request-components-fixture';
  const record = () => recordModelUsage({
    sessionId: source, model: 'recording-reviewer', inputTokens: 1000, outputTokens: 1,
    cacheDialect: 'inclusive',
    // This is the ambient brain breakdown passed by today's provider adapters.
    promptComponents: { instructions: 5584, toolSchemas: 6983, memoryPrimer: 486 },
  });
  const response = responseWith({ inputTokens: 1000, outputTokens: 1, totalTokens: 1001 });
  const inner: Model = {
    getResponse: async () => { record(); return response; },
    getStreamedResponse: async function* () { record(); yield { type: 'response_done', response } as never; },
  };
  const model = withModelRouteMetrics(inner, {
    sessionId: source, role: 'judge', resolvedModel: 'recording-reviewer', provider: 'byo', source: 'explicit', reason: {},
  }, db);
  const request = { ...requestWithSentinel(), systemInstructions: 'Review the evidence.', input: 'First evidence packet.' };
  try {
    await withModelUsageAttribution({ sessionId: source, sourceUserSeq: 0, role: 'brain',
      promptComponents: { instructions: 9999 } }, async () => {
      await model.getResponse(request);
      for await (const _ of model.getStreamedResponse({ ...request, input: 'Repair.' })) { /* consume */ }
    });
    const rows = readUsageEventsForDate().filter(row => row.source === source);
    assert.equal(rows.length, 2);
    for (const [index, row] of rows.entries()) {
      assert.equal(row.role, 'reviewer');
      assert.equal(row.promptComponents?.instructions, estimateTokens(request.systemInstructions));
      assert.equal(row.promptComponents?.toolSchemas, estimateTokens('[]'));
      assert.equal(row.promptComponents?.history, estimateTokens(index === 0 ? request.input : 'Repair.'));
      assert.equal(row.promptComponents?.memoryPrimer, undefined);
      assert.equal(row.inputTokens, 1000, 'provider token totals remain unchanged');
    }
  } finally { db.close(); }
});

// The first build of this DB admitted only brain, worker and judge in both
// role CHECKs, so every writer (and would-be memory) row was dropped by
// INSERT OR IGNORE and its outcome failed the foreign key.
const FIRST_BUILD_SCHEMA_SQL = `
CREATE TABLE model_route_decisions (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, session_id TEXT, workflow_run_id TEXT,
  workflow_node_id TEXT, workspace_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('brain','worker','judge')),
  intent TEXT, requested_model TEXT, resolved_model TEXT NOT NULL, provider TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('default','binding','intent_binding','explicit','fallback','policy')),
  reason_json TEXT NOT NULL DEFAULT '{}', policy_version INTEGER
);
CREATE INDEX idx_model_route_decisions_created ON model_route_decisions(created_at DESC);
CREATE INDEX idx_model_route_decisions_role_intent ON model_route_decisions(role, intent, created_at DESC);
CREATE INDEX idx_model_route_decisions_workspace ON model_route_decisions(workspace_id, created_at DESC) WHERE workspace_id IS NOT NULL;
CREATE TABLE model_route_outcomes (
  decision_id TEXT PRIMARY KEY REFERENCES model_route_decisions(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success','failed','fallback','cancelled')),
  latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
  total_tokens INTEGER, cost_usd REAL, error_class TEXT, fallover_to_model TEXT, tool_calls INTEGER,
  tool_success INTEGER CHECK (tool_success IN (0,1)), objective_met INTEGER CHECK (objective_met IN (0,1)),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_model_route_outcomes_status_completed ON model_route_outcomes(status, completed_at DESC);
CREATE TABLE model_route_policy (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('brain','worker','judge')),
  intent TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, score REAL NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0,
  objective_met_count INTEGER NOT NULL DEFAULT 0, avg_latency_ms REAL, avg_cost_usd REAL,
  disabled_reason TEXT, policy_version INTEGER NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(role, intent, provider, model)
);
CREATE INDEX idx_model_route_policy_lookup ON model_route_policy(role, intent, disabled_reason, score DESC);
`;

function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test('a first-build metrics DB is rebuilt in place so writer and memory rows persist, keeping every row', () => {
  const db = new Database(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(FIRST_BUILD_SCHEMA_SQL);
    for (const [i, role] of (['brain', 'worker', 'judge'] as const).entries()) {
      recordModelRouteDecision({ id: `old-${i}`, role, resolvedModel: `${role}-model`, provider: 'codex', source: 'default',
        reason: { seam: 'kept' }, now: new Date(`2026-09-2${i}T00:00:00.000Z`) }, db);
      recordModelRouteOutcome({ decisionId: `old-${i}`, status: 'success', latencyMs: 10 + i, totalTokens: 100 + i,
        metadata: { actualModel: `${role}-served` } }, db);
    }
    db.prepare(`INSERT INTO model_route_policy (id, role, intent, provider, model, score, policy_version, updated_at)
      VALUES ('pol-1', 'judge', NULL, 'codex', 'judge-model', 0.9, 3, '2026-09-25T00:00:00.000Z')`).run();
    // Before the rebuild a memory row is silently dropped.
    recordModelRouteDecision({ id: 'dropped', role: 'memory', resolvedModel: 'm', provider: 'codex', source: 'default' }, db);
    assert.equal(countRows(db, 'model_route_decisions'), 3, 'fixture: the first-build CHECK drops a memory row');
    const before = {
      decisions: db.prepare('SELECT * FROM model_route_decisions ORDER BY id').all(),
      outcomes: db.prepare('SELECT * FROM model_route_outcomes ORDER BY decision_id').all(),
      policy: db.prepare('SELECT * FROM model_route_policy ORDER BY id').all(),
    };

    assert.deepEqual(widenModelRouteRoleChecks(db), ['model_route_decisions', 'model_route_policy']);
    assert.deepEqual(db.prepare('SELECT * FROM model_route_decisions ORDER BY id').all(), before.decisions, 'every decision kept exactly');
    assert.deepEqual(db.prepare('SELECT * FROM model_route_outcomes ORDER BY decision_id').all(), before.outcomes, 'no outcome cascaded away');
    assert.deepEqual(db.prepare('SELECT * FROM model_route_policy ORDER BY id').all(), before.policy);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign keys are back on');
    const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_model_route_%' ORDER BY name`)
      .all() as Array<{ name: string }>).map((row) => row.name);
    assert.deepEqual(indexes, [
      'idx_model_route_decisions_created', 'idx_model_route_decisions_role_intent', 'idx_model_route_decisions_workspace',
      'idx_model_route_outcomes_status_completed', 'idx_model_route_policy_lookup',
    ]);

    for (const role of ['writer', 'memory'] as const) {
      recordModelRouteDecision({ id: `new-${role}`, role, resolvedModel: `${role}-model`, provider: 'claude', source: 'binding' }, db);
      assert.equal(recordModelRouteOutcome({ decisionId: `new-${role}`, status: 'success' }, db), true, `${role} outcome joins its decision`);
      db.prepare(`INSERT INTO model_route_policy (id, role, intent, provider, model, score, policy_version, updated_at)
        VALUES (?, ?, NULL, 'claude', ?, 0.5, 4, '2026-09-26T00:00:00.000Z')`).run(`pol-${role}`, role, `${role}-model`);
    }
    assert.equal(countRows(db, 'model_route_decisions'), 5);
    assert.equal(countRows(db, 'model_route_outcomes'), 5);
    // The rebuilt decisions table still owns its outcomes.
    db.prepare(`DELETE FROM model_route_decisions WHERE id = 'old-0'`).run();
    assert.equal(countRows(db, 'model_route_outcomes'), 4, 'outcomes still cascade with their decision');
    assert.throws(() => recordModelRouteOutcomeStrict(db, 'no-such-decision'), /FOREIGN KEY/);

    assert.deepEqual(widenModelRouteRoleChecks(db), [], 'a current DB is left untouched');
  } finally {
    db.close();
  }
});

/** A raw insert, so the foreign key failure is visible (the recorder swallows it). */
function recordModelRouteOutcomeStrict(db: Database.Database, decisionId: string): void {
  db.prepare(`INSERT INTO model_route_outcomes (decision_id, completed_at, status) VALUES (?, '2026-09-26T00:00:00.000Z', 'success')`)
    .run(decisionId);
}

test('a fresh metrics DB admits every route role with nothing to rebuild', () => {
  const db = metricsDb();
  try {
    assert.deepEqual(widenModelRouteRoleChecks(db), []);
    for (const role of ['brain', 'worker', 'judge', 'writer', 'memory'] as const) {
      recordModelRouteDecision({ id: `fresh-${role}`, role, resolvedModel: 'm', provider: 'codex', source: 'default' }, db);
    }
    assert.equal(countRows(db, 'model_route_decisions'), 5);
  } finally {
    db.close();
  }
});

test('opening the shared metrics DB never rebuilds it; the daemon\'s boot upkeep does, once', () => {
  assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1', 'this test writes only an isolated home\'s metrics DB');
  resetModelRouteMetricsForTest();
  mkdirSync(MODEL_ROUTE_METRICS_STATE_DIR, { recursive: true });
  const seed = new Database(MODEL_ROUTE_METRICS_DB_PATH);
  seed.exec(FIRST_BUILD_SCHEMA_SQL);
  seed.close();
  try {
    // The first open happens inside a role resolution on the turn path.
    const db = openModelRouteMetricsDb();
    const decisionsSql = () => (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_route_decisions'`)
      .get() as { sql: string }).sql;
    assert.ok(!decisionsSql().includes(`'memory'`), 'the open path leaves the old CHECK alone');
    recordModelRouteDecision({ id: 'before-boot', role: 'memory', resolvedModel: 'm', provider: 'codex', source: 'default' }, db);
    assert.equal(countRows(db, 'model_route_decisions'), 0, 'until the boot upkeep runs, a memory row is dropped as before');

    assert.deepEqual(widenModelRouteMetricsDb(), ['model_route_decisions', 'model_route_policy']);
    assert.ok(decisionsSql().includes(`'memory'`) && decisionsSql().includes(`'writer'`));
    recordModelRouteDecision({ id: 'after-boot', role: 'memory', resolvedModel: 'm', provider: 'codex', source: 'default' }, db);
    assert.equal(countRows(db, 'model_route_decisions'), 1);
    assert.deepEqual(widenModelRouteMetricsDb(), [], 'the next boot finds nothing to do');
  } finally {
    resetModelRouteMetricsForTest();
  }
});

test('a job reads the route that served it, and a fallback lane is a stand-in by the route\'s own evidence', async () => {
  const db = metricsDb();
  try {
    const primary = {
      getResponse: async () => { throw { statusCode: 529, message: 'overloaded' }; },
      getStreamedResponse: async function* () { throw { statusCode: 529, message: 'overloaded' }; },
    } as Model;
    const rescue = responseModel(responseWith({ inputTokens: 5, outputTokens: 1, totalTokens: 6 }, { model: 'served-rescue' }));
    const fallback = withModelRouteMetrics(withModelFallback([
      // Labels of their own: an earlier test's overload cools down 'primary'.
      { label: 'memory-primary', provider: 'codex', model: 'memory-model', getModel: () => primary },
      { label: 'memory-rescue', provider: 'claude', model: 'rescue-model', getModel: () => rescue },
    ]), { role: 'memory', requestedModel: 'memory-model', resolvedModel: 'memory-model', provider: 'codex',
      source: 'default', reason: { seam: 'memory', job: 'learn' } }, db);
    const direct = withModelRouteMetrics(responseModel(responseWith({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })),
      { role: 'memory', requestedModel: 'memory-model', resolvedModel: 'memory-model', provider: 'codex', source: 'default' }, db);

    const directRoutes: ObservedModelRoute[] = [];
    await withModelRouteObserver(directRoutes, () => direct.getResponse(requestWithSentinel()));
    assert.equal(readRouteStandIn(directRoutes)?.standIn, false);
    assert.equal(readRouteStandIn(directRoutes)?.route.resolvedModel, 'memory-model');

    const fellOver: ObservedModelRoute[] = [];
    await withModelRouteObserver(fellOver, () => fallback.getResponse(requestWithSentinel()));
    assert.deepEqual(fellOver.map((route) => [route.resolvedModel, route.status, route.source]), [
      ['memory-model', 'failed', 'default'],
      ['rescue-model', 'success', 'fallback'],
    ]);
    const served = readRouteStandIn(fellOver);
    assert.equal(served?.standIn, true, 'the rescue lane stood in for the requested model');
    assert.equal(served?.route.resolvedModel, 'rescue-model');
    assert.equal(served?.route.servedModel, 'served-rescue', 'the provider-reported model is carried');
    assert.equal(readRouteStandIn([]), null, 'no call answered: no served route');
  } finally {
    db.close();
  }
});

// The public reader is optional only while these regressions run RED against
// the old producer. Positives then fail on missing actual author evidence,
// rather than preventing all existing tests from loading for a missing export.
import * as authorMetrics from './model-route-metrics.js';
import { RouterModelProvider } from './harness/router-model.js';
import { __brainBackupsTest__, BRAIN_BACKUPS_ENV } from './harness/brain-backups.js';
import os from 'node:os';
import path from 'node:path';

type CapturedResponseAuthor = Readonly<{ model: Model; modelId: string; provider: string; providerId?: string }>;
function completedAuthor(response: unknown): CapturedResponseAuthor | undefined {
  return (authorMetrics as typeof authorMetrics & {
    getCompletedResponseAuthor?: (value: unknown) => CapturedResponseAuthor | undefined;
  }).getCompletedResponseAuthor?.(response);
}

function authorResponse(id: string): ModelResponse {
  return { responseId: id, id,
    output: [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Controlled author fixture.' }] }],
    usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14, requests: 1,
      inputTokensDetails: [], outputTokensDetails: [] },
  } as unknown as ModelResponse;
}

function authorRoute(model: Model, db: Database.Database, modelId = 'author-fixture', provider: 'claude' | 'codex' | 'byo' | 'unknown' = 'claude') {
  return withModelRouteMetrics(model, { role: 'brain', resolvedModel: modelId,
    provider, source: 'explicit' }, db);
}

async function collectAuthorStream(model: Model, request = requestWithSentinel()) {
  const events = [];
  for await (const event of model.getStreamedResponse(request)) events.push(event);
  return events;
}

test('completed response author: actual router primary failure retains the exact rescue leaf on both transports', async () => {
  const keys = ['AUTH_MODE', 'MODEL_ROUTING_MODE', 'CLAUDE_MODEL', BRAIN_BACKUPS_ENV,
    'BYO_MODEL_BASE_URL', 'BYO_MODEL_ID', 'BYO_MODEL_API_KEY', 'BYO_PROVIDERS'] as const;
  const before = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  // The owner listed the Claude model as the brain's backup.
  Object.assign(process.env, { AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off',
    CLAUDE_MODEL: 'claude-sonnet-5', [BRAIN_BACKUPS_ENV]: JSON.stringify(['claude-sonnet-5']) });
  __brainBackupsTest__.reset(path.join(os.tmpdir(), `author-route-outage-${process.pid}.json`));
  __brainBackupsTest__.setOptions(() => [{ id: 'claude_oauth', value: 'claude_oauth:claude-sonnet-5', label: 'Claude — Sonnet 5', available: true, modelId: 'claude-sonnet-5' }]);
  try {
    for (const stream of [false, true]) {
      // Each transport starts with the brain unbenched and no outage counted.
      clearRateLimitedBrainsForTest();
      __brainBackupsTest__.reset(path.join(os.tmpdir(), `author-route-outage-${process.pid}.json`));
      __brainBackupsTest__.setOptions(() => [{ id: 'claude_oauth', value: 'claude_oauth:claude-sonnet-5', label: 'Claude — Sonnet 5', available: true, modelId: 'claude-sonnet-5' }]);
      const calls: string[] = [];
      const response = authorResponse(`author-router-${stream}`);
      const bytesBefore = JSON.stringify(response);
      const rescue: Model = {
        async getResponse() { calls.push('rescue'); return response; },
        async *getStreamedResponse() {
          calls.push('rescue');
          yield { type: 'response_done', response } as never;
        },
      };
      const primary: Model = {
        async getResponse() { calls.push('primary'); throw { statusCode: 529, message: 'overloaded' }; },
        async *getStreamedResponse() { calls.push('primary'); throw { statusCode: 529, message: 'overloaded' }; },
      };
      let rescueModelId: string | undefined;
      const router = new RouterModelProvider({
        codex: { getModel: () => primary },
        claude: { getModel(id) { rescueModelId = id; return rescue; } },
        resolveEffectiveProvider: (id) => (id.startsWith('claude') ? 'claude' : 'codex'), codexAvailable: () => true, claudeAvailable: () => true,
      });
      // The default model is the brain; its backup is the owner's listed one.
      const routed = router.getModel();
      const routes: ObservedModelRoute[] = [];
      if (stream) {
        const events = await withModelRouteObserver(routes, () => collectAuthorStream(routed));
        assert.equal((events.at(-1) as { response?: unknown }).response, response);
      } else {
        assert.equal(await withModelRouteObserver(routes, () => routed.getResponse(requestWithSentinel())), response);
      }
      assert.deepEqual(calls, ['primary', 'rescue']);
      const author = completedAuthor(response);
      assert.ok(author, 'successful original response needs private concrete-author evidence');
      assert.equal(author.model, rescue, 'the aggregate router/fallback is not a reusable author');
      assert.equal(author.modelId, rescueModelId);
      assert.equal(author.provider, 'claude');
      assert.equal(author.providerId, undefined, 'a route family cannot invent a backend registry or account identity');
      assert.equal(Object.isFrozen(author), true);
      assert.deepEqual(Object.keys(author).sort(), ['model', 'modelId', 'provider']);
      assert.equal(completedAuthor({ ...response }), undefined, 'a serialized or same-ID clone has no capsule');
      assert.equal(JSON.stringify(response), bytesBefore, 'capture never edits provider output or token quantities');
      assert.equal(routes.length, 2, 'one failed primary and one successful rescue, with no aggregate mirror');
      assert.equal(routes[1]?.resolvedModel, rescueModelId);
      // Reuse the captured instance without another registry/model resolution.
      await author.model.getResponse({ ...requestWithSentinel(), tools: [] });
      assert.deepEqual(calls, ['primary', 'rescue', 'rescue']);
    }
  } finally {
    __brainBackupsTest__.reset();
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('completed response author: recursively instrumented nested fallback preserves the deepest winning leaf', async () => {
  const db = metricsDb();
  try {
    for (const stream of [false, true]) {
      const response = authorResponse(`author-nested-${stream}`);
      const rescue = responseModel(response);
      const fail: Model = {
        async getResponse() { throw { statusCode: 529, message: 'overloaded' }; },
        async *getStreamedResponse() { throw { statusCode: 529, message: 'overloaded' }; },
      };
      const nested = withModelFallback([
        { label: `author-nested-primary-${stream}`, provider: 'claude', model: 'nested-primary', getModel: () => fail },
        { label: `author-nested-rescue-${stream}`, provider: 'byo', model: 'nested-rescue', getModel: () => rescue },
      ]);
      const routed = authorRoute(withModelFallback([
        { label: `author-outer-primary-${stream}`, provider: 'codex', model: 'outer-primary', getModel: () => fail },
        { label: `author-outer-wrapper-${stream}`, provider: 'claude', model: 'outer-wrapper', getModel: () => nested },
      ]), db, 'outer-primary', 'codex');
      if (stream) await collectAuthorStream(routed); else await routed.getResponse(requestWithSentinel());
      const author = completedAuthor(response);
      assert.ok(author);
      assert.equal(author.model, rescue);
      assert.equal(author.modelId, 'nested-rescue');
      assert.equal(author.provider, 'byo', 'outer fallback descriptor cannot replace the actual deeper winner');
    }
    assert.equal((db.prepare('SELECT COUNT(*) n FROM model_route_outcomes').get() as { n: number }).n, 6,
      'two failed targets and the deepest success per request remain the entire metrics inventory');
  } finally { db.close(); }
});

test('completed response author: streamed response is unavailable until the original successful drain finishes', async () => {
  const db = metricsDb();
  try {
    const response = authorResponse('author-drain-boundary');
    let release!: () => void;
    const finished = new Promise<void>(resolve => { release = resolve; });
    const leaf: Model = {
      async getResponse() { return response; },
      async *getStreamedResponse() { yield { type: 'response_done', response } as never; await finished; },
    };
    const iterator = authorRoute(leaf, db).getStreamedResponse(requestWithSentinel())[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).done, false);
    assert.equal(completedAuthor(response), undefined, 'response_done alone does not settle the stream');
    const drain = iterator.next();
    release();
    assert.equal((await drain).done, true);
    assert.equal(completedAuthor(response)?.model, leaf);
  } finally { db.close(); }
});

test('completed response author: interrupted, failed, aborted and contradictory streams never certify a leaf', async () => {
  const db = metricsDb();
  try {
    for (const mode of ['return', 'throw', 'abort', 'contradictory'] as const) {
      const response = authorResponse(`author-incomplete-${mode}`);
      const other = authorResponse(`author-other-${mode}`);
      const controller = new AbortController();
      const leaf: Model = {
        async getResponse() { return response; },
        async *getStreamedResponse() {
          yield { type: 'response_done', response } as never;
          if (mode === 'throw') throw new Error('controlled failure after done');
          if (mode === 'abort') controller.abort();
          if (mode === 'contradictory') yield { type: 'response_done', response: other } as never;
        },
      };
      const request = { ...requestWithSentinel(), signal: controller.signal };
      const iterator = authorRoute(leaf, db).getStreamedResponse(request)[Symbol.asyncIterator]();
      await iterator.next();
      if (mode === 'return') await iterator.return?.(undefined);
      else if (mode === 'throw') await assert.rejects(iterator.next(), /controlled failure after done/);
      else { while (!(await iterator.next()).done) { /* drain exact original stream */ } }
      assert.equal(completedAuthor(response), undefined, `${mode} cannot certify a completed author`);
      assert.equal(completedAuthor(other), undefined);
    }
  } finally { db.close(); }
});

test('completed response author: buffered failure or abort and unknown route do not fabricate author proof', async () => {
  const db = metricsDb();
  try {
    for (const mode of ['throw', 'abort', 'reported_failure', 'unknown'] as const) {
      const response = authorResponse(`author-buffered-${mode}`);
      if (mode === 'reported_failure') (response as unknown as { providerData: unknown }).providerData = { status: 'failed' };
      const controller = new AbortController();
      const leaf: Model = {
        async getResponse() {
          if (mode === 'throw') throw new Error('controlled buffered failure');
          if (mode === 'abort') controller.abort();
          return response;
        },
        async *getStreamedResponse() { throw new Error('unused'); },
      };
      const routed = authorRoute(leaf, db, 'author-buffered', mode === 'unknown' ? 'unknown' : 'claude');
      const call = routed.getResponse({ ...requestWithSentinel(), signal: controller.signal });
      if (mode === 'throw') await assert.rejects(call, /controlled buffered failure/); else assert.equal(await call, response);
      assert.equal(completedAuthor(response), undefined);
    }
    assert.equal(completedAuthor(authorResponse('unregistered-custom-response')), undefined);
    assert.equal(completedAuthor({ model: responseModel(authorResponse('forged')), modelId: 'forged', provider: 'claude' }), undefined);
  } finally { db.close(); }
});

test('completed response author: reusing an original response across different concrete leaves makes identity ambiguous', async () => {
  const db = metricsDb();
  try {
    const response = authorResponse('author-reused-original');
    const first = responseModel(response);
    const second = responseModel(response);
    await authorRoute(first, db, 'first-author').getResponse(requestWithSentinel());
    assert.equal(completedAuthor(response)?.model, first);
    await authorRoute(second, db, 'second-author').getResponse(requestWithSentinel());
    assert.equal(completedAuthor(response), undefined, 'later ownership cannot overwrite the first physical producer');
    await authorRoute(first, db, 'first-author').getResponse(requestWithSentinel());
    assert.equal(completedAuthor(response), undefined, 'an ambiguous object stays unavailable');
  } finally { db.close(); }
});

test('completed response author: a Proxy leaf is not inspected for new diagnostic prototype hooks', async () => {
  const db = metricsDb();
  try {
    const response = authorResponse('author-proxy-leaf');
    let prototypeReads = 0;
    const proxy = new Proxy(responseModel(response), {
      getPrototypeOf(target) { prototypeReads += 1; return Reflect.getPrototypeOf(target); },
    });
    const routed = authorRoute(proxy, db);
    const existingConstructionReads = prototypeReads;
    assert.equal(await routed.getResponse(requestWithSentinel()), response);
    assert.equal(prototypeReads, existingConstructionReads,
      'proof-only capture cannot add getPrototypeOf work to a custom model');
    assert.equal(completedAuthor(response), undefined);
  } finally { db.close(); }
});

test('completed response author: incomplete fallback identity remains display metadata and never concrete-author evidence', async () => {
  const db = metricsDb();
  try {
    for (const missing of ['provider', 'model'] as const) for (const stream of [false, true]) {
      const response = authorResponse(`author-unknown-target-${missing}-${stream}`);
      const leaf = responseModel(response);
      const fail: Model = {
        async getResponse() { throw { statusCode: 529, message: 'overloaded' }; },
        async *getStreamedResponse() { throw { statusCode: 529, message: 'overloaded' }; },
      };
      const routes: ObservedModelRoute[] = [];
      const label = `author-display-only-${missing}-${stream}`;
      const routed = authorRoute(withModelFallback([
        { label: `author-explicit-primary-${missing}-${stream}`, provider: 'codex', model: 'explicit-primary', getModel: () => fail },
        { label, ...(missing !== 'provider' ? { provider: 'byo' } : {}),
          ...(missing !== 'model' ? { model: 'declared-model' } : {}), getModel: () => leaf },
      ]), db, 'explicit-primary', 'codex');
      if (stream) await withModelRouteObserver(routes, () => collectAuthorStream(routed));
      else assert.equal(await withModelRouteObserver(routes, () => routed.getResponse(requestWithSentinel())), response);
      assert.equal(routes.length, 2);
      assert.equal(routes[1]?.resolvedModel, missing === 'model' ? label : 'declared-model');
      assert.equal(routes[1]?.provider, missing === 'provider' ? 'codex' : 'byo',
        'legacy metrics retain their parent-provider/display-label compatibility');
      assert.equal(completedAuthor(response), undefined, `${missing} is not proved by inherited metrics fields`);
    }
  } finally { db.close(); }
});

test('completed response author: an opaque internal fallback without a captured deeper leaf cannot certify the outer model', async () => {
  const db = metricsDb();
  try {
    for (const stream of [false, true]) {
      const response = authorResponse(`author-opaque-fallback-${stream}`);
      const fail: Model = {
        async getResponse() { throw { statusCode: 529, message: 'overloaded' }; },
        async *getStreamedResponse() { throw { statusCode: 529, message: 'overloaded' }; },
      };
      const internal = withModelFallback([
        { label: `author-opaque-primary-${stream}`, provider: 'claude', model: 'opaque-primary', getModel: () => fail },
        { label: `author-opaque-rescue-${stream}`, provider: 'byo', model: 'opaque-rescue', getModel: () => responseModel(response) },
      ]);
      const opaque: Model = { getResponse: request => internal.getResponse(request),
        getStreamedResponse: request => internal.getStreamedResponse(request) };
      const routed = authorRoute(opaque, db, 'opaque-primary', 'claude');
      if (stream) await collectAuthorStream(routed); else assert.equal(await routed.getResponse(requestWithSentinel()), response);
      assert.equal(completedAuthor(response), undefined,
        'actual rescue strings cannot turn the outer rerouting object into an exact concrete author');
    }
  } finally { db.close(); }
});

for (const stream of [false, true]) test(`completed response author: opaque first-target success is not a concrete leaf (${stream ? 'stream' : 'buffered'})`, async () => {
  const db = metricsDb();
  try {
    const response = authorResponse(`author-opaque-primary-success-${stream}`);
    let primaryCalls = 0;
    let rescueConstructions = 0;
    const primary: Model = {
      async getResponse() { primaryCalls += 1; return response; },
      async *getStreamedResponse() { primaryCalls += 1; yield { type: 'response_done', response } as never; },
    };
    const internal = withModelFallback([
      { label: `author-opaque-matching-${stream}`, provider: 'claude', model: 'opaque-matching-model', getModel: () => primary },
      { label: `author-opaque-unreached-${stream}`, provider: 'codex', model: 'unreached-rescue', getModel: () => {
        rescueConstructions += 1; throw new Error('unreached rescue must remain lazy');
      } },
    ]);
    const opaque: Model = { getResponse: request => internal.getResponse(request),
      getStreamedResponse: request => internal.getStreamedResponse(request) };
    const routed = authorRoute(opaque, db, 'opaque-matching-model', 'claude');
    if (stream) await collectAuthorStream(routed); else assert.equal(await routed.getResponse(requestWithSentinel()), response);
    assert.equal(primaryCalls, 1);
    assert.equal(rescueConstructions, 0);
    assert.equal(completedAuthor(response), undefined,
      'matching first-target labels do not prove the opaque graph is a reusable non-rerouting leaf');
  } finally { db.close(); }
});
