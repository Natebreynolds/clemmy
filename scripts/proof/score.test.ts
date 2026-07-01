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

import { openHarnessDb, sessionMetrics, narrationCheck, stormCheck, summarizeAllSessions } from './score.js';

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
