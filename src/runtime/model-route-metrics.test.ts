import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  MODEL_ROUTE_METRICS_SCHEMA_SQL,
  MODEL_ROUTE_METRICS_SCHEMA_VERSION,
  MODEL_ROUTE_METRICS_TABLES,
  recordModelRouteDecision,
  recordModelRouteOutcome,
  scoreModelRouteCandidate,
  selectBestRouteCandidate,
  summarizeRouteOutcomes,
} from './model-route-metrics.js';

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
