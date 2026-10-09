import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { measureAcceptedTask, measureAcceptedTurn, formatAcceptedTaskComparison } from './session-comparison.js';

const at = (second: number) => new Date(Date.parse('2026-08-08T00:00:00Z') + second * 1_000).toISOString();
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const responseDigest = (id: string) => createHash('sha256').update(id).digest('hex');

function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clementine-worker-measurement-'));
  const state = path.join(home, 'state');
  mkdirSync(path.join(state, 'token-usage'), { recursive: true });
  const dbPath = path.join(state, 'harness.db');
  const usageFile = path.join(state, 'token-usage', '2026-08-08.ndjson');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, session_id TEXT, turn INTEGER,
    role TEXT, type TEXT, parent_event_id TEXT, data_json TEXT, created_at TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT, metadata_json TEXT);
    CREATE TABLE run_attempts (attempt_id TEXT PRIMARY KEY, session_id TEXT, source_user_seq INTEGER,
      started_at TEXT, finished_at TEXT, status TEXT);
    CREATE TABLE logical_tool_calls (session_id TEXT, source_user_seq INTEGER, accepted_task_id TEXT,
      logical_tool_call_id TEXT, tool_name TEXT, argument_digest TEXT, state TEXT);
    CREATE TABLE run_dispatch_leases (scope_id TEXT, session_id TEXT, lease_id TEXT, run_attempt_id TEXT,
      parent_scope_id TEXT, parent_lease_id TEXT, source_user_seq INTEGER, accepted_task_id TEXT,
      logical_tool_call_id TEXT, recovery_tool_name TEXT, recovery_argument_digest TEXT);`);
  const event = (session: string, seq: number, type: string, data: Record<string, unknown>, second: number, parent: string | null = null) => {
    db.prepare('INSERT INTO events VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)').run(seq, `e${seq}`, session,
      type === 'user_input_received' ? 'user' : 'system', type, parent, JSON.stringify(data), at(second));
  };
  const attempt = (session: string, source: number, id: string, start: number, finish: number | null, status = 'completed') => {
    db.prepare('INSERT INTO run_attempts VALUES (?, ?, ?, ?, ?, ?)').run(id, session, source, at(start), finish === null ? null : at(finish), status);
  };
  const call = (session: string, source: number, id: string) => {
    db.prepare('INSERT INTO logical_tool_calls VALUES (?, ?, ?, ?, ?, ?, ?)').run(session, source,
      `task:${session}#${source}`, id, 'run_worker', sha(id), 'settled');
    db.prepare('INSERT INTO run_dispatch_leases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      `call:${session}:${id}`, session, `lease:${session}:${id}`, `attempt:${session}`, null, null,
      source, `task:${session}#${source}`, id, 'run_worker', sha(id));
  };
  const childLease = (session: string, id: string, parentSession: string, parentCall: string) => {
    db.prepare('INSERT INTO run_dispatch_leases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      `runner:${session}:${id}`, session, `lease:${session}:${id}`, id,
      `call:${parentSession}:${parentCall}`, `lease:${parentSession}:${parentCall}`, null, null, null, null, null);
  };
  event('root', 100, 'user_input_received', { text: 'Synthetic independently checked task.' }, 0);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('root', 'chat', '{}');
  attempt('root', 100, 'attempt:root', 0, 10);
  call('root', 100, 'run-workers');
  const child = (session: string, source: number, parentSession: string, parentSource: number, parentCall: string, second: number) => {
    const packet = { objective: 'Synthetic independent check', item: session, externalMcpToolNames: [], model: 'fixture-worker' };
    const lineage = { parentSessionId: parentSession, parentSourceUserSeq: parentSource,
      parentAcceptedTaskId: `task:${parentSession}#${parentSource}`, parentLogicalCallId: parentCall,
      packetKey: `packet:${session}`, packetDigest: sha(packet), item: session };
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(session, 'agent', JSON.stringify({
      source: 'delegated_worker', workerScope: true, ...lineage,
    }));
    event(session, source, 'user_input_received', { text: 'Delegated synthetic packet.',
      delegatedWorker: { ...lineage, composeOnly: true, packet } }, second, `e${parentSource}`);
    attempt(session, source, `attempt:${session}`, second, second + 2);
    childLease(session, `attempt:${session}`, parentSession, parentCall);
    event(parentSession, source + 1, 'worker_started', { ...lineage, childSessionId: session,
      childSourceUserSeq: source, childAttemptId: `attempt:${session}` }, second);
    event(session, source + 2, 'worker_model_response_completed', { sourceUserSeq: source,
      runAttemptId: `attempt:${session}`, modelCallId: `host-uuid:${session}`, model: 'fixture-worker',
      providerResponseIdDigest: responseDigest(`msg:${session}`) }, second + 2);
    event(session, source + 3, 'model_stream_diagnostic', { sourceUserSeq: source, attemptId: `attempt:${session}`,
      responseId: `msg:${session}`, settlement: 'completed', sawResponseDone: true }, second + 2);
  };
  child('child-a', 200, 'root', 100, 'run-workers', 1);
  child('child-b', 300, 'root', 100, 'run-workers', 2);
  call('child-a', 200, 'nested-workers');
  child('grandchild', 400, 'child-a', 200, 'nested-workers', 3);
  event('root', 900, 'conversation_completed', { sourceUserSeq: 100, terminalKey: 'turn:100',
    presentation: { version: 1, id: 'turn:100:presentation', outcomeId: 'turn:100', audience: 'user', phase: 'final',
      identity: { sessionId: 'root', sourceUserSeq: 100, turn: 1 }, status: 'done', kind: 'answer', text: 'Computed.', resumable: false },
    turnOutcome: { version: 2, id: 'turn:100', status: 'done', resumable: false } }, 10);
  // A later source in a deterministic helper session is a different task.
  event('child-a', 450, 'user_input_received', { text: 'Unrelated later task' }, 5);
  attempt('child-a', 450, 'attempt:unrelated', 5, 6);
  db.close();
  const usage = (session: string, source: number, tokens: number, extra: Record<string, unknown> = {}) => ({
    at: at(8), source: session, role: session === 'root' ? 'brain' : 'worker', kind: 'chat',
    model: session === 'root' ? 'fixture-main' : 'fixture-worker', cacheDialect: 'inclusive',
    inputTokens: tokens, cachedInputTokens: tokens / 10, outputTokens: tokens / 20,
    responseId: `msg:${session}`,
    trace: { acceptedSource: `${session}:${source}`, logicalTurnId: `turn:${source}`, attemptId: `attempt:${session}`,
      modelCallId: `msg:${session}` }, ...extra,
  });
  const rows = [usage('root', 100, 100), usage('child-a', 200, 200), usage('child-b', 300, 300),
    usage('grandchild', 400, 400), usage('child-a', 450, 9_000, { trace: { acceptedSource: 'child-a:450',
      logicalTurnId: 'turn:450', attemptId: 'attempt:unrelated', modelCallId: 'msg:unrelated' } })];
  writeFileSync(usageFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { home, dbPath, usageFile, usage, childLease: (session: string, id: string, parentSession: string, parentCall: string) => {
    const writer = new Database(dbPath);
    writer.prepare('INSERT INTO run_dispatch_leases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      `runner:${session}:${id}`, session, `lease:${session}:${id}`, id,
      `call:${parentSession}:${parentCall}`, `lease:${parentSession}:${parentCall}`, null, null, null, null, null);
    writer.close();
  } };
}

test('canonical task unions exact reciprocal helper descendants without changing public delivery or turn scope', () => {
  const f = fixture();
  try {
    const beforeDb = readFileSync(f.dbPath), beforeUsage = readFileSync(f.usageFile);
    const turn = measureAcceptedTurn(f.home, 'root', 100);
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(turn.promptTokens, 100);
    assert.deepEqual(task.sourceUserSeqs, [100]);
    assert.deepEqual(task.workerUsageParticipants.map(p => [p.sessionId, p.sourceUserSeq]),
      [['child-a', 200], ['child-b', 300], ['grandchild', 400]]);
    assert.equal(task.usageRecords, 4); assert.equal(task.promptTokens, 1_000);
    assert.equal(task.cachedInputTokens, 100); assert.equal(task.uncachedInputTokens, 900); assert.equal(task.outputTokens, 50);
    assert.equal(task.workerAttemptCount, 3); assert.equal(task.attemptCount, 1);
    assert.equal(task.taskWallMs, 10_000); assert.equal(task.segmentWallMs, 10_000);
    assert.equal(task.terminalSeq, 900); assert.equal(task.usageAttributionCertified, true);
    assert.deepEqual(task.workerLineageIssues, []); assert.equal(task.unprovenUsage.usageRecords, 0);
    assert.deepEqual(measureAcceptedTurn(f.home, 'root', 100), turn);
    assert.deepEqual(readFileSync(f.dbPath), beforeDb); assert.deepEqual(readFileSync(f.usageFile), beforeUsage);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('duplicate host markers are one edge, but distinct recorded physical calls are not deduplicated by equal payload', () => {
  const f = fixture();
  try {
    const db = new Database(f.dbPath);
    db.exec("INSERT INTO events SELECT 210, 'e210', session_id, turn, role, type, parent_event_id, data_json, created_at FROM events WHERE seq=201"); db.close();
    writeFileSync(f.usageFile, readFileSync(f.usageFile, 'utf8') + JSON.stringify(f.usage('child-a', 200, 200)) + '\n');
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(task.workerUsageParticipants.length, 3); assert.equal(task.usageRecords, 5);
    assert.equal(task.promptTokens, 1_200); assert.equal(task.usageAttributionCertified, true);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('failed child and retry usage are charged by exact ownership, not successful result or public terminal', () => {
  const f = fixture();
  try {
    const db = new Database(f.dbPath);
    db.exec("UPDATE run_attempts SET status='failed' WHERE attempt_id='attempt:child-a'; UPDATE logical_tool_calls SET state='open' WHERE session_id='child-a'");
    db.prepare('INSERT INTO run_attempts VALUES (?, ?, ?, ?, ?, ?)').run('child-retry', 'child-a', 200, at(4), at(5), 'failed');
    db.close(); f.childLease('child-a', 'child-retry', 'root', 'run-workers');
    const row = f.usage('child-a', 200, 50, { ok: false, role: 'reviewer', trace: { acceptedSource: 'child-a:200',
      logicalTurnId: 'turn:200', attemptId: 'child-retry', modelCallId: 'failed-provider-call' } });
    writeFileSync(f.usageFile, readFileSync(f.usageFile, 'utf8') + JSON.stringify(row) + '\n');
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(task.workerAttemptCount, 4); assert.equal(task.promptTokens, 1_050); assert.equal(task.usageRecords, 5);
    assert.equal(task.taskWallMs, 10_000); assert.equal(task.usageAttributionCertified, true);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

for (const [label, sql] of [
  ['packet changed', "UPDATE events SET data_json=json_set(data_json,'$.delegatedWorker.packet.objective','changed') WHERE seq=200"],
  ['wrong parent source', "UPDATE events SET data_json=json_set(data_json,'$.parentSourceUserSeq',999) WHERE seq=201"],
  ['wrong accepted task', "UPDATE events SET data_json=json_set(data_json,'$.parentAcceptedTaskId','task:root#999') WHERE seq=201"],
  ['wrong parent event', "UPDATE events SET parent_event_id='e300' WHERE seq=200"],
  ['wrong metadata', "UPDATE sessions SET metadata_json=json_set(metadata_json,'$.packetKey','other') WHERE id='child-a'"],
  ['not worker session', "UPDATE sessions SET kind='chat' WHERE id='child-a'"],
  ['not host marker', "UPDATE events SET role='assistant' WHERE seq=201"],
  ['wrong child attempt', "UPDATE events SET data_json=json_set(data_json,'$.childAttemptId','attempt:child-b') WHERE seq=201"],
  ['numeric string source', "UPDATE events SET data_json=json_set(data_json,'$.childSourceUserSeq','200') WHERE seq=201"],
  ['different child session', "UPDATE events SET data_json=json_set(data_json,'$.childSessionId','root') WHERE seq=201"],
  ['missing marker', 'DELETE FROM events WHERE seq=201'],
  ['malformed marker', "UPDATE events SET data_json='{bad' WHERE seq=201"],
  ['wrong child lease', "UPDATE run_dispatch_leases SET parent_lease_id='other-lease' WHERE session_id='child-a' AND run_attempt_id='attempt:child-a'"],
] as const) {
  test(`unproved ${label} preserves excluded child/descendant cost and cannot certify a cheaper task`, () => {
    const f = fixture();
    try {
      const db = new Database(f.dbPath); db.exec(sql); db.close();
      const task = measureAcceptedTask(f.home, 'root', 100);
      assert.equal(task.promptTokens, 400, label);
      assert.equal(task.unprovenUsage.promptTokens, 600, label);
      assert.equal(task.unprovenUsage.usageRecords, 2, label);
      assert.deepEqual(task.workerUsageParticipants.map(p => p.sessionId), ['child-b']);
      assert.equal(task.usageAttributionCertified, false); assert.ok(task.workerLineageIssues.length > 0);
      assert.equal(task.taskWallMs, 10_000, 'broken helper provenance does not rewrite public delivery timing');
      assert.match(formatAcceptedTaskComparison({ home: f.home, baseline: task, candidate: task }), /UNCERTIFIED lower bound/);
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  });
}

test('a parent call lease bound to an unrelated attempt cannot certify its nested worker', () => {
  const f = fixture();
  try {
    const db = new Database(f.dbPath);
    db.exec("UPDATE run_dispatch_leases SET run_attempt_id='attempt:unrelated' WHERE session_id='child-a' AND logical_tool_call_id='nested-workers'"); db.close();
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(task.promptTokens, 600); assert.equal(task.unprovenUsage.promptTokens, 400);
    assert.deepEqual(task.workerUsageParticipants.map(p => p.sessionId), ['child-a', 'child-b']);
    assert.equal(task.usageAttributionCertified, false);
    assert.ok(task.workerLineageIssues.includes('unproved_worker_attempt:grandchild:400:attempt:grandchild'));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('a conflicting parent claim poisons the edge and descendant attribution instead of first-claim wins', () => {
  const f = fixture();
  try {
    const db = new Database(f.dbPath);
    db.exec("INSERT INTO events SELECT 210, 'e210', session_id, turn, role, type, parent_event_id, json_set(data_json,'$.parentLogicalCallId','different-call'), created_at FROM events WHERE seq=201"); db.close();
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(task.promptTokens, 400); assert.equal(task.unprovenUsage.promptTokens, 600);
    assert.ok(task.workerLineageIssues.includes('conflicting_worker_parent:child-a:200'));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('missing/conflicted parent call authority cannot admit worker costs even with matching visible markers', () => {
  for (const sql of ["DELETE FROM logical_tool_calls WHERE session_id='root'", "UPDATE logical_tool_calls SET state='conflict' WHERE session_id='root'",
    "UPDATE run_dispatch_leases SET recovery_argument_digest='wrong' WHERE session_id='root'", 'DROP TABLE run_dispatch_leases']) {
    const f = fixture();
    try {
      const db = new Database(f.dbPath); db.exec(sql); db.close();
      const task = measureAcceptedTask(f.home, 'root', 100);
      assert.equal(task.promptTokens, 100, sql); assert.equal(task.unprovenUsage.promptTokens, 900, sql);
      assert.equal(task.usageAttributionCertified, false);
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  }
});

test('wrong child usage logical source/attempt remains unproven rather than borrowing an unrelated attempt', () => {
  const f = fixture();
  try {
    const rows = readFileSync(f.usageFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    rows[1].trace.attemptId = 'attempt:unrelated'; rows[2].trace.logicalTurnId = 'turn:200';
    writeFileSync(f.usageFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(task.promptTokens, 500); assert.equal(task.unprovenUsage.promptTokens, 500);
    assert.equal(task.usageAttributionCertified, false); assert.ok(task.usageCertificationIssues.includes('unproved_usage_attribution'));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('unfinished helper and completed provider response with absent usage are explicit incomplete coverage', () => {
  const f = fixture();
  try {
    const db = new Database(f.dbPath); db.exec("UPDATE run_attempts SET finished_at=NULL WHERE attempt_id='attempt:child-a'"); db.close();
    const rows = readFileSync(f.usageFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.trace.acceptedSource !== 'child-b:300');
    writeFileSync(f.usageFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(task.unfinishedWorkerAttempts, 1); assert.equal(task.unfinishedAttempts, 0);
    assert.equal(task.promptTokens, 700); assert.equal(task.usageAttributionCertified, false);
    assert.ok(task.usageCertificationIssues.includes('unfinished_worker_attempt:child-a:200'));
    assert.ok(task.usageCertificationIssues.includes('worker_model_without_exact_usage:child-b:300'));
    assert.ok(task.usageCertificationIssues.includes('worker_response_without_exact_usage:child-b:300:303'));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('observed failed provider attempts without failed usage stay explicitly unknown', () => {
  const f = fixture();
  try {
    const db = new Database(f.dbPath);
    db.prepare('INSERT INTO events VALUES (?, ?, ?, 1, ?, ?, NULL, ?, ?)').run(208, 'e208', 'child-a', 'system',
      'model_resilience_observed', JSON.stringify({ sourceUserSeq: 200, runAttemptId: 'attempt:child-a',
        failedAttemptCount: 1, phase: 'call_finished' }), at(3)); db.close();
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(task.promptTokens, 1_000); assert.equal(task.usageAttributionCertified, false);
    assert.ok(task.usageCertificationIssues.includes('worker_failed_attempt_usage_unknown:child-a:200'));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('a recorded failed usage row cannot certify aggregate coverage of additional failed calls', () => {
  const f = fixture();
  try {
    const db = new Database(f.dbPath);
    db.prepare('INSERT INTO events VALUES (?, ?, ?, 1, ?, ?, NULL, ?, ?)').run(208, 'e208', 'child-a', 'system',
      'model_resilience_observed', JSON.stringify({ sourceUserSeq: 200, runAttemptId: 'attempt:child-a',
        failedAttemptCount: 2, phase: 'call_finished' }), at(3)); db.close();
    writeFileSync(f.usageFile, readFileSync(f.usageFile, 'utf8') + JSON.stringify(f.usage('child-a', 200, 50, { ok: false })) + '\n');
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(task.promptTokens, 1_050); assert.equal(task.usageAttributionCertified, false);
    assert.ok(task.usageCertificationIssues.includes('worker_failed_attempt_usage_unknown:child-a:200'));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('provider response IDs alone cannot prove coverage of differently named host requests', () => {
  const f = fixture();
  try {
    const db = new Database(f.dbPath);
    db.exec("UPDATE events SET data_json=json_remove(data_json,'$.providerResponseIdDigest') WHERE seq=202"); db.close();
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(task.promptTokens, 1_000); assert.equal(task.unprovenUsage.usageRecords, 0);
    assert.equal(task.usageAttributionCertified, false);
    assert.ok(task.usageCertificationIssues.includes('worker_host_response_usage_unknown:child-a:200:202'));
    assert.ok(!task.usageCertificationIssues.includes('worker_response_without_exact_usage:child-a:200:203'));
    const report = formatAcceptedTaskComparison({ home: f.home, baseline: task, candidate: task });
    assert.match(report, /UNCERTIFIED lower bound/);
    assert.match(report, /helper request usage coverage is unknown\/incomplete/);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

for (const digest of [responseDigest('msg:wrong'), 'not-a-digest', '', 123] as const) {
  test(`invalid or unmatched host response bridge ${JSON.stringify(digest)} retains known cost without certification`, () => {
    const f = fixture();
    try {
      const db = new Database(f.dbPath);
      db.prepare("UPDATE events SET data_json=json_set(data_json,'$.providerResponseIdDigest',json(?)) WHERE seq=202")
        .run(JSON.stringify(digest)); db.close();
      const task = measureAcceptedTask(f.home, 'root', 100);
      assert.equal(task.promptTokens, 1_000); assert.equal(task.unprovenUsage.usageRecords, 0);
      assert.equal(task.usageAttributionCertified, false);
      assert.ok(task.usageCertificationIssues.includes('worker_host_response_usage_unknown:child-a:200:202'));
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  });
}

test('one exact provider digest cannot certify two distinct completed host calls', () => {
  const f = fixture();
  try {
    const db = new Database(f.dbPath);
    db.exec("INSERT INTO events SELECT 208, 'e208', session_id, turn, role, type, parent_event_id, json_set(data_json,'$.modelCallId','host-uuid:second-request'), created_at FROM events WHERE seq=202"); db.close();
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(task.promptTokens, 1_000); assert.equal(task.usageRecords, 4);
    assert.equal(task.usageAttributionCertified, false);
    assert.ok(task.usageCertificationIssues.includes('conflicting_worker_response_bridge:child-a:200:208'));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('a provider diagnostic and usage cannot certify an absent host completion record', () => {
  const f = fixture();
  try {
    const db = new Database(f.dbPath); db.exec('DELETE FROM events WHERE seq=202'); db.close();
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(task.promptTokens, 1_000); assert.equal(task.usageAttributionCertified, false);
    assert.ok(task.usageCertificationIssues.includes('worker_host_response_coverage_unknown:child-a:200'));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

for (const change of ["'$.sourceUserSeq',300", "'$.runAttemptId','attempt:child-b'"] as const) {
  test(`a second host completion with wrong ownership ${change} cannot escape partial-coverage diagnostics`, () => {
    const f = fixture();
    try {
      const db = new Database(f.dbPath);
      db.exec(`INSERT INTO events SELECT 208, 'e208', session_id, turn, role, type, parent_event_id,
        json_set(data_json,'$.modelCallId','host-uuid:second-request',${change}), created_at FROM events WHERE seq=202`); db.close();
      const task = measureAcceptedTask(f.home, 'root', 100);
      assert.equal(task.promptTokens, 1_000); assert.equal(task.usageAttributionCertified, false);
      assert.ok(task.usageCertificationIssues.includes('invalid_worker_response_ownership:child-a:200:208'));
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  });
}

test('a duplicate receipt for the same host call and exact response bridge adds no request ownership', () => {
  const f = fixture();
  try {
    const db = new Database(f.dbPath);
    db.exec("INSERT INTO events SELECT 208, 'e208', session_id, turn, role, type, parent_event_id, data_json, created_at FROM events WHERE seq=202"); db.close();
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(task.promptTokens, 1_000); assert.equal(task.usageRecords, 4);
    assert.equal(task.usageAttributionCertified, true);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('a parent accepted source cannot stand in for the exact worker source on child-owned usage', () => {
  const f = fixture();
  try {
    const rows = readFileSync(f.usageFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    rows[1].trace.acceptedSource = 'root:100'; rows[1].trace.logicalTurnId = 'turn:100';
    writeFileSync(f.usageFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(task.promptTokens, 800); assert.equal(task.unprovenUsage.promptTokens, 200);
    assert.equal(task.usageAttributionCertified, false);
    assert.ok(task.usageCertificationIssues.includes('unproved_usage_attribution'));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

for (const diagnostic of ['absent', 'corrupt', 'completed-without-usage'] as const) {
  test(`a second completed host request with ${diagnostic} diagnostic cannot borrow the first usage receipt`, () => {
    const f = fixture();
    try {
      const db = new Database(f.dbPath);
      db.prepare('INSERT INTO events VALUES (?, ?, ?, 1, ?, ?, NULL, ?, ?)').run(208, 'e208', 'child-a', 'system',
        'worker_model_response_completed', JSON.stringify({ sourceUserSeq: 200, runAttemptId: 'attempt:child-a',
          modelCallId: 'host-uuid:second-request', model: 'fixture-worker' }), at(3));
      if (diagnostic !== 'absent') db.prepare('INSERT INTO events VALUES (?, ?, ?, 1, ?, ?, NULL, ?, ?)').run(
        209, 'e209', 'child-a', 'system', 'model_stream_diagnostic', diagnostic === 'corrupt' ? '{bad' : JSON.stringify({
          sourceUserSeq: 200, attemptId: 'attempt:child-a', responseId: 'msg:second-request',
          settlement: 'completed', sawResponseDone: true }), at(3));
      db.close();
      const task = measureAcceptedTask(f.home, 'root', 100);
      assert.equal(task.promptTokens, 1_000); assert.equal(task.usageRecords, 4);
      assert.equal(task.usageAttributionCertified, false);
      assert.ok(task.usageCertificationIssues.includes('worker_host_response_usage_unknown:child-a:200:208'));
      if (diagnostic === 'corrupt') assert.ok(task.workerLineageIssues.includes('malformed_worker_session_events:child-a:200'));
      if (diagnostic === 'completed-without-usage') assert.ok(task.usageCertificationIssues.includes('worker_response_without_exact_usage:child-a:200:209'));
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  });
}

test('malformed child telemetry remains visible without discarding independently proved owned costs', () => {
  const f = fixture();
  try {
    const db = new Database(f.dbPath);
    db.exec("UPDATE events SET data_json='[]' WHERE seq=202"); db.close();
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(task.promptTokens, 1_000); assert.equal(task.workerUsageParticipants.length, 3);
    assert.equal(task.usageAttributionCertified, false);
    assert.ok(task.workerLineageIssues.includes('malformed_worker_session_events:child-a:200'));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('unprovable extra child attempt cannot inherit the source lease, while proved costs remain visible', () => {
  const f = fixture();
  try {
    const db = new Database(f.dbPath);
    db.prepare('INSERT INTO run_attempts VALUES (?, ?, ?, ?, ?, ?)').run('unbound-child-attempt', 'child-a', 200, at(4), at(5), 'failed'); db.close();
    writeFileSync(f.usageFile, readFileSync(f.usageFile, 'utf8') + JSON.stringify(f.usage('child-a', 200, 50, {
      trace: { acceptedSource: 'child-a:200', logicalTurnId: 'turn:200', attemptId: 'unbound-child-attempt' }, ok: false,
    })) + '\n');
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(task.promptTokens, 1_000); assert.equal(task.unprovenUsage.promptTokens, 50);
    assert.equal(task.workerAttemptCount, 3); assert.equal(task.usageAttributionCertified, false);
    assert.ok(task.workerLineageIssues.includes('unproved_worker_attempt:child-a:200:unbound-child-attempt'));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('backward/cyclic helper claims terminate and do not duplicate already-proven root usage', () => {
  const f = fixture();
  try {
    const db = new Database(f.dbPath);
    db.exec("INSERT INTO events SELECT 410, 'e410', session_id, turn, role, type, parent_event_id, json_set(data_json,'$.childSessionId','root','$.childSourceUserSeq',100,'$.childAttemptId','attempt:root'), created_at FROM events WHERE seq=401"); db.close();
    const task = measureAcceptedTask(f.home, 'root', 100);
    assert.equal(task.usageRecords, 4); assert.equal(task.promptTokens, 1_000);
    assert.equal(task.usageAttributionCertified, false); assert.ok(task.workerLineageIssues.includes('conflicting_worker_parent:root:100'));
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});
