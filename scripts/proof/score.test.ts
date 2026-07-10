/**
 * Scorer self-test: builds a synthetic harness.db fixture (same schema slice
 * the daemon writes) and asserts the metrics/checks are computed
 * deterministically — keeps the proof scorer CI-testable with no daemon and
 * no model. Run via `npm run proof:selftest`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import {
  exactBrainRouteChecks,
  exactWorkflowStepRouteChecks,
  narrationCheck,
  openHarnessDb,
  sessionMetrics,
  sessionRouteEvidence,
  stormCheck,
  summarizeAllSessions,
  workflowStepRouteEvidence,
} from './score.js';

function buildFixtureHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'proof-score-fixture-'));
  mkdirSync(path.join(home, 'state'), { recursive: true });
  const db = new Database(path.join(home, 'state', 'harness.db'));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, kind TEXT, channel TEXT, user_id TEXT,
      created_at TEXT, updated_at TEXT, status TEXT, title TEXT, objective TEXT,
      token_budget INTEGER, tokens_used INTEGER DEFAULT 0, current_plan_id TEXT,
      metadata_json TEXT DEFAULT '{}'
    );
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, session_id TEXT,
      turn INTEGER, role TEXT, type TEXT, parent_event_id TEXT,
      data_json TEXT, created_at TEXT
    );
  `);
  const base = Date.parse('2026-07-01T10:00:00.000Z');
  const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, kind, channel, created_at, updated_at, status, tokens_used) VALUES (?,?,?,?,?,?,?)`,
  ).run('sess-1', 'chat', 'cli', at(0), at(60_000), 'completed', 12_345);
  const insert = db.prepare(
    `INSERT INTO events (id, session_id, turn, role, type, data_json, created_at) VALUES (?,?,?,?,?,?,?)`,
  );
  let n = 0;
  const ev = (type: string, data: unknown, offsetMs: number, turn = 1) =>
    insert.run(`ev-${++n}`, 'sess-1', turn, 'Clem', type, JSON.stringify(data), at(offsetMs));

  ev('turn_started', {}, 0);
  ev('turn_memory_primer', { injectedBytes: 512 }, 100);
  ev('tool_called', { tool: 'run_worker', callId: 'c1' }, 2_000);
  ev('tool_called', { tool: 'run_worker', callId: 'c2' }, 2_500);
  ev('tool_called', { tool: 'remember_fact', callId: 'c3' }, 9_000);
  ev('worker_result', { item: 'firm-1', ok: true }, 9_500);
  ev('worker_result', { item: 'firm-2', ok: false }, 9_800);
  ev('guardrail_tripped', { kind: 'test' }, 10_000);
  ev('turn_ended', {}, 30_000);
  ev('conversation_completed', { reply: 'done' }, 30_100);
  db.close();
  return home;
}

function addRouteMarker(home: string, sessionId: string, data: unknown, suffix: string): void {
  const db = new Database(path.join(home, 'state', 'harness.db'));
  db.prepare(
    `INSERT INTO events (id, session_id, turn, role, type, data_json, created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(`route-${suffix}`, sessionId, 0, 'system', 'turn_model_routed', JSON.stringify(data), new Date().toISOString());
  db.close();
}

function addWorkflowRouteMarker(
  home: string,
  sessionId: string,
  type: 'turn_model_routed' | 'worker_model_routed',
  data: unknown,
  suffix: string,
): void {
  const db = new Database(path.join(home, 'state', 'harness.db'));
  db.prepare(
    `INSERT INTO events (id, session_id, turn, role, type, data_json, created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(`workflow-route-${suffix}`, sessionId, 0, 'system', type, JSON.stringify(data), new Date().toISOString());
  db.close();
}

function addOperationalFallover(home: string, sessionId: string): void {
  const db = new Database(path.join(home, 'state', 'operational-telemetry.db'));
  db.exec(`
    CREATE TABLE operational_events (
      event_id TEXT PRIMARY KEY, ts TEXT, source TEXT, type TEXT, severity TEXT,
      workspace_id TEXT, workflow_run_id TEXT, workflow_node_run_id TEXT,
      session_id TEXT, model_call_id TEXT, tool_call_id TEXT, actor TEXT,
      payload_json TEXT
    );
  `);
  db.prepare(
    `INSERT INTO operational_events (event_id, ts, source, type, severity, session_id, payload_json) VALUES (?,?,?,?,?,?,?)`,
  ).run('fallover-1', new Date().toISOString(), 'model', 'model_fallover', 'warn', sessionId, '{}');
  db.close();
}

test('sessionMetrics computes counts, TTFT, and latency from the fixture', () => {
  const home = buildFixtureHome();
  try {
    const db = openHarnessDb(home);
    const m = sessionMetrics(db, 'sess-1');
    db.close();
    assert.ok(m, 'session found');
    assert.equal(m.status, 'completed');
    assert.equal(m.tokensUsed, 12_345);
    assert.equal(m.turns, 1);
    assert.equal(m.toolCalls['run_worker'], 2);
    assert.equal(m.toolCalls['remember_fact'], 1);
    assert.equal(m.toolCallTotal, 3);
    assert.equal(m.guardrailsTripped, 1);
    assert.equal(m.workerResults, 2);
    assert.equal(m.workerFailures, 1);
    assert.equal(m.completedEvents, 1);
    assert.equal(m.limitExceededEvents, 0);
    assert.equal(m.primerInjectedBytes, 512);
    assert.equal(m.latency.length, 1);
    assert.equal(m.latency[0].wallMs, 30_000);
    // First model ACTION is the tool call at +2s (the primer at +100ms is
    // harness prep and must not count as TTFT).
    assert.equal(m.latency[0].ttftMs, 2_000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('summarizeAllSessions returns every session', () => {
  const home = buildFixtureHome();
  try {
    const db = openHarnessDb(home);
    const all = summarizeAllSessions(db);
    db.close();
    assert.equal(all.length, 1);
    assert.equal(all[0].sessionId, 'sess-1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('sessionMetrics returns null for an unknown session', () => {
  const home = buildFixtureHome();
  try {
    const db = openHarnessDb(home);
    assert.equal(sessionMetrics(db, 'nope'), null);
    db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('narrationCheck flags tool-call-shaped replies and passes prose', () => {
  assert.equal(narrationCheck('Here is your summary — all five firms are covered.').pass, true);
  assert.equal(narrationCheck('Tool call: composio_execute_tool\n{"tool_slug":"GMAIL_SEND"}').pass, false);
});

test('stormCheck trips on repeated provider-error markers', () => {
  assert.equal(stormCheck('all quiet').pass, true);
  const noisy = Array.from({ length: 5 }, (_, i) => `request failed with 529 overloaded (attempt ${i})`).join('\n');
  assert.equal(stormCheck(noisy).pass, false);
});

test('exact route evidence is session-scoped, not satisfied by an unrelated provider marker', () => {
  const home = buildFixtureHome();
  try {
    addRouteMarker(home, 'other-session', { provider: 'claude', model: 'claude-opus-4-8' }, 'other');
    addRouteMarker(home, 'sess-1', { provider: 'codex', model: 'gpt-5.4' }, 'one');
    addRouteMarker(home, 'sess-1', { provider: 'codex', model: 'gpt-5.4' }, 'two');
    assert.equal(exactBrainRouteChecks(home, 'sess-1', 'codex', 2).every((check) => check.pass), true);
    assert.equal(exactBrainRouteChecks(home, 'sess-1', 'claude', 2)[1].pass, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('explicit BYO provider identity wins over a gpt-shaped model id', () => {
  const home = buildFixtureHome();
  try {
    addRouteMarker(home, 'sess-1', { provider: 'byo', model: 'gpt-4o', transport: 'openai_agents_harness' }, 'byo-one');
    addRouteMarker(home, 'sess-1', { provider: 'byo', model: 'gpt-4o', transport: 'openai_agents_harness' }, 'byo-two');
    const evidence = sessionRouteEvidence(home, 'sess-1');
    assert.deepEqual([...new Set(evidence.families)], ['byo']);
    assert.equal(exactBrainRouteChecks(home, 'sess-1', 'glm', 2).every((check) => check.pass), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('mixed same-session providers and a same-session fallover fail the exact route gate', () => {
  const home = buildFixtureHome();
  try {
    addRouteMarker(home, 'sess-1', { provider: 'codex', model: 'gpt-5.4' }, 'mixed-one');
    addRouteMarker(home, 'sess-1', { provider: 'claude', model: 'claude-opus-4-8' }, 'mixed-two');
    addOperationalFallover(home, 'sess-1');
    const checks = exactBrainRouteChecks(home, 'sess-1', 'codex', 2);
    assert.equal(checks[1].pass, false, 'mixed providers are not an exact Codex route');
    assert.equal(checks[2].pass, false, 'a recorded fallover fails the route gate');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('workflow step route accepts the Claude SDK nested route marker and exact transport', () => {
  const home = buildFixtureHome();
  try {
    addWorkflowRouteMarker(home, 'workflow:run-1:write', 'worker_model_routed', {
      provider: 'claude',
      modelId: 'claude-sonnet-4-6',
      modelRoute: {
        provider: 'claude',
        effectiveModel: 'claude-sonnet-4-6',
        transport: 'claude_agent_sdk_workflow_step',
      },
    }, 'claude');
    const evidence = workflowStepRouteEvidence(home, 'workflow:run-1:write');
    assert.deepEqual([...new Set(evidence.families)], ['claude']);
    assert.deepEqual([...new Set(evidence.transports)], ['claude_agent_sdk_workflow_step']);
    assert.equal(exactWorkflowStepRouteChecks(home, 'workflow:run-1:write', 'claude').every((check) => check.pass), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('workflow step route preserves BYO identity for a gpt-shaped model on the harness transport', () => {
  const home = buildFixtureHome();
  try {
    addWorkflowRouteMarker(home, 'workflow:run-2:write', 'turn_model_routed', {
      provider: 'byo',
      model: 'gpt-shaped-private-model',
      transport: 'openai_agents_harness',
    }, 'byo');
    assert.equal(exactWorkflowStepRouteChecks(home, 'workflow:run-2:write', 'glm').every((check) => check.pass), true);
    assert.equal(exactWorkflowStepRouteChecks(home, 'workflow:run-2:write', 'codex')[1].pass, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('workflow step route fails a wrong transport and same-step fallover', () => {
  const home = buildFixtureHome();
  try {
    addWorkflowRouteMarker(home, 'workflow:run-3:write', 'worker_model_routed', {
      modelRoute: {
        provider: 'claude',
        effectiveModel: 'claude-sonnet-4-6',
        transport: 'openai_agents_harness',
      },
    }, 'wrong-transport');
    addOperationalFallover(home, 'workflow:run-3:write');
    const checks = exactWorkflowStepRouteChecks(home, 'workflow:run-3:write', 'claude');
    assert.equal(checks[2].pass, false, 'wrong workflow transport fails');
    assert.equal(checks[3].pass, false, 'same-step fallover fails');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
