import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  compareAcceptedTurns,
  compareAcceptedTasks,
  compareSessions,
  formatAcceptedTurnComparison,
  formatAcceptedTaskComparison,
  formatSessionComparison,
  measureAcceptedTurn,
  measureAcceptedTask,
  measureSession,
  parseAcceptedTurnComparisonArgs,
  parseMeasurementComparisonArgs,
  parseSessionComparisonArgs,
} from './session-comparison.js';

interface FixtureEvent {
  seq: number;
  type: string;
  at: string;
  data?: Record<string, unknown>;
  turn?: number;
  role?: string;
}

function typedTerminal(
  sessionId: string,
  sourceUserSeq: number,
  turn: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const outcomeId = `turn:${sourceUserSeq}`;
  return {
    terminalKey: outcomeId,
    sourceUserSeq,
    presentation: {
      version: 1,
      id: `${outcomeId}:presentation`,
      outcomeId,
      audience: 'user',
      phase: 'final',
      identity: { sessionId, turn, sourceUserSeq },
      status: 'done',
      kind: 'answer',
      text: 'Fixture answer.',
      resumable: false,
    },
    turnOutcome: { version: 2, id: outcomeId, status: 'done', resumable: false },
    ...extra,
  };
}

function seedSession(db: Database.Database, sessionId: string, events: FixtureEvent[]): void {
  const insert = db.prepare(
    `INSERT INTO events (seq, session_id, turn, role, type, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const event of events) {
    insert.run(
      event.seq,
      sessionId,
      event.turn ?? 1,
      event.role ?? (event.type === 'user_input_received' ? 'user' : 'system'),
      event.type,
      JSON.stringify(event.data ?? {}),
      event.at,
    );
  }
}

function fixtureHome(): { home: string; usageFile: string; dbPath: string } {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clementine-session-comparison-'));
  const state = path.join(home, 'state');
  const usageDir = path.join(state, 'token-usage');
  mkdirSync(usageDir, { recursive: true });
  const dbPath = path.join(state, 'harness.db');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE events (
    seq INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    role TEXT NOT NULL,
    type TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  seedSession(db, 'baseline', [
    { seq: 1, type: 'user_input_received', at: '2026-08-08T00:00:00.000Z' },
    { seq: 2, type: 'turn_started', at: '2026-08-08T00:00:00.100Z' },
    { seq: 3, type: 'tool_called', at: '2026-08-08T00:00:01.000Z', data: { tool: 'tool_search', callId: 'search-1', accounting: 'top_level' } },
    { seq: 4, type: 'tool_returned', at: '2026-08-08T00:00:01.100Z', data: { tool: 'tool_search', callId: 'search-1', accounting: 'top_level' } },
    { seq: 5, type: 'tool_called', at: '2026-08-08T00:00:02.000Z', data: { tool: 'call_tool', effectiveTool: 'composio_search_tools', callId: 'search-2', accounting: 'top_level', arguments: '{"name":"composio_search_tools","args_json":"{\\"query\\":\\"outlook draft\\"}"}' } },
    { seq: 6, type: 'tool_called', at: '2026-08-08T00:00:02.010Z', data: { tool: 'composio_search_tools', callId: 'mirror-1', accounting: 'transport_mirror', args: { query: 'outlook draft', limit: null } } },
    { seq: 7, type: 'tool_returned', at: '2026-08-08T00:00:02.100Z', data: { tool: 'composio_search_tools', callId: 'mirror-1', accounting: 'transport_mirror' } },
    { seq: 8, type: 'tool_returned', at: '2026-08-08T00:00:02.110Z', data: { tool: 'call_tool', effectiveTool: 'composio_search_tools', callId: 'search-2', accounting: 'top_level' } },
    { seq: 9, type: 'tool_called', at: '2026-08-08T00:00:03.000Z', data: { tool: 'call_tool', effectiveTool: 'run_batch', callId: 'batch-outer', accounting: 'top_level' } },
    { seq: 10, type: 'tool_returned', at: '2026-08-08T00:00:03.100Z', data: { tool: 'call_tool', effectiveTool: 'run_batch', callId: 'batch-outer', accounting: 'top_level' } },
    { seq: 11, type: 'tool_called', at: '2026-08-08T00:00:04.000Z', data: { tool: 'composio_execute_tool', callId: 'batch-child', batchMode: true, args: '{"tool_slug":"OUTLOOK_CREATE_DRAFT","arguments":{}}' } },
    { seq: 12, type: 'tool_returned', at: '2026-08-08T00:00:04.100Z', data: { tool: 'composio_execute_tool', callId: 'batch-child', batchMode: true } },
    { seq: 13, type: 'warm_schema_metadata_refresh', at: '2026-08-08T00:00:04.200Z', data: {
      sourceUserSeq: 1, attemptId: 'attempt-1', artifactId: 'pa_fixture', durationMs: 25, outcome: 'matched',
    } },
    { seq: 14, type: 'conversation_completed', at: '2026-08-08T00:00:10.000Z', data: { sourceUserSeq: 1 } },
  ]);
  seedSession(db, 'candidate', [
    { seq: 101, type: 'user_input_received', at: '2026-08-08T01:00:00.000Z' },
    { seq: 102, type: 'turn_started', at: '2026-08-08T01:00:00.100Z' },
    { seq: 103, type: 'tool_called', at: '2026-08-08T01:00:01.000Z', data: { tool: 'tool_search', callId: 'candidate-search', accounting: 'top_level' } },
    { seq: 104, type: 'tool_returned', at: '2026-08-08T01:00:01.100Z', data: { tool: 'tool_search', callId: 'candidate-search', accounting: 'top_level' } },
    { seq: 105, type: 'conversation_completed', at: '2026-08-08T01:00:05.000Z', data: { sourceUserSeq: 101 } },
  ]);
  seedSession(db, 'multi', [
    { seq: 201, type: 'user_input_received', at: '2026-08-08T02:00:00.000Z', turn: 1 },
    { seq: 202, type: 'turn_model_routed', at: '2026-08-08T02:00:00.050Z', data: { transport: 'claude_agent_sdk' } },
    { seq: 203, type: 'tool_called', at: '2026-08-08T02:00:01.000Z', data: { tool: 'tool_search', callId: 'multi-search', accounting: 'top_level', sourceUserSeq: 201 } },
    { seq: 204, type: 'tool_returned', at: '2026-08-08T02:00:01.100Z', data: { tool: 'tool_search', callId: 'multi-search', accounting: 'top_level', sourceUserSeq: 201 } },
    { seq: 205, type: 'conversation_completed', at: '2026-08-08T02:00:05.000Z', data: typedTerminal('multi', 201, 1, { transport: 'claude_agent_sdk', steps: 1 }) },
    // Closeout work can land after the public terminal but before the exact
    // run attempt finishes. It still belongs to source 201.
    { seq: 206, type: 'turn_model_routed', at: '2026-08-08T02:00:05.100Z', data: { transport: 'claude_headless_judge', sourceUserSeq: 201, attemptId: 'attempt-multi-1' } },
    { seq: 210, type: 'user_input_received', at: '2026-08-08T03:00:00.000Z', turn: 2 },
    { seq: 211, type: 'conversation_completed', at: '2026-08-08T03:00:00.080Z', turn: 2, data: typedTerminal('multi', 210, 2, { transport: 'completed_answer_replay', steps: 0 }) },
    { seq: 212, type: 'turn_graph_compiled', at: '2026-08-08T03:00:00.095Z', turn: 2, data: { sourceUserSeq: 210 } },
    { seq: 220, type: 'user_input_received', at: '2026-08-08T04:00:00.000Z', turn: 3 },
    { seq: 221, type: 'turn_model_routed', at: '2026-08-08T04:00:00.050Z', turn: 3 },
    { seq: 222, type: 'conversation_completed', at: '2026-08-08T04:00:02.000Z', turn: 3, data: typedTerminal('multi', 220, 3, { transport: 'openai_agents_harness', steps: 1 }) },
  ]);
  seedSession(db, 'invalid-attribution', [
    { seq: 301, type: 'user_input_received', at: '2026-08-08T05:00:00.000Z' },
    { seq: 302, type: 'turn_model_routed', at: '2026-08-08T05:00:00.010Z', data: { sourceUserSeq: 301, attemptId: 'attempt-invalid-real' } },
    { seq: 303, type: 'conversation_completed', at: '2026-08-08T05:00:01.000Z', data: typedTerminal('invalid-attribution', 301, 1, { transport: 'claude_agent_sdk', steps: 1 }) },
  ]);
  seedSession(db, 'post-closeout-route', [
    { seq: 401, type: 'user_input_received', at: '2026-08-08T06:00:00.000Z' },
    { seq: 402, type: 'turn_model_routed', at: '2026-08-08T06:00:00.050Z', data: { transport: 'legacy-route' } },
    { seq: 403, type: 'conversation_completed', at: '2026-08-08T06:00:01.000Z', data: typedTerminal('post-closeout-route', 401, 1, { transport: 'claude_agent_sdk', steps: 1 }) },
    { seq: 404, type: 'turn_model_routed', at: '2026-08-08T06:00:01.002Z', data: { transport: 'claude_agent_sdk', sourceUserSeq: 401, attemptId: 'attempt-post-closeout' } },
    { seq: 405, type: 'turn_model_routed', at: '2026-08-08T06:00:01.003Z', data: { transport: 'late-legacy-route' } },
    { seq: 406, type: 'turn_model_routed', at: '2026-08-08T06:00:00.900Z', data: { transport: 'foreign-attempt-route', sourceUserSeq: 401, attemptId: 'attempt-foreign' } },
  ]);
  db.exec(`CREATE TABLE run_attempts (
    attempt_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    source_user_seq INTEGER
  )`);
  const insertAttempt = db.prepare(
    `INSERT INTO run_attempts (attempt_id, session_id, started_at, finished_at, status, source_user_seq)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertAttempt.run('attempt-multi-1', 'multi', '2026-08-08T02:00:00.000Z', '2026-08-08T02:00:05.200Z', 'completed', 201);
  insertAttempt.run('attempt-multi-replay', 'multi', '2026-08-08T03:00:00.000Z', '2026-08-08T03:00:00.100Z', 'completed', 210);
  insertAttempt.run('attempt-multi-legacy', 'multi', '2026-08-08T04:00:00.000Z', '2026-08-08T04:00:02.050Z', 'completed', 220);
  insertAttempt.run('attempt-invalid-real', 'invalid-attribution', '2026-08-08T05:00:00.000Z', '2026-08-08T05:00:01.050Z', 'completed', 301);
  insertAttempt.run('attempt-post-closeout', 'post-closeout-route', '2026-08-08T06:00:00.000Z', '2026-08-08T06:00:01.001Z', 'completed', 401);
  db.exec(`CREATE TABLE discovery_governor_tasks (
    session_id TEXT NOT NULL,
    source_user_seq INTEGER NOT NULL,
    known_capability INTEGER NOT NULL,
    PRIMARY KEY (session_id, source_user_seq)
  );
  CREATE TABLE discovery_governor_claims (
    session_id TEXT NOT NULL,
    source_user_seq INTEGER NOT NULL,
    category TEXT NOT NULL,
    call_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    PRIMARY KEY (session_id, source_user_seq, category)
  );`);
  db.prepare(`INSERT INTO discovery_governor_tasks (session_id, source_user_seq, known_capability) VALUES (?, ?, ?)`)
    .run('multi', 201, 0);
  db.prepare(`INSERT INTO discovery_governor_claims (session_id, source_user_seq, category, call_id, outcome) VALUES (?, ?, ?, ?, ?)`)
    .run('multi', 201, 'broad_discovery', 'multi-search', 'succeeded');
  db.prepare(`INSERT INTO discovery_governor_tasks (session_id, source_user_seq, known_capability) VALUES (?, ?, ?)`)
    .run('multi', 220, 1);
  db.close();

  const usageFile = path.join(usageDir, '2026-08-08.ndjson');
  const usage = [
    { at: '2026-08-08T00:00:05Z', source: 'baseline', kind: 'chat', model: 'inclusive-model', cacheDialect: 'inclusive', inputTokens: 100, cachedInputTokens: 60, outputTokens: 10, totalTokens: 110, durationMs: 1_000, providerApiDurationMs: 500 },
    { at: '2026-08-08T00:00:06Z', source: 'baseline-worker', trace: { acceptedSource: 'baseline', brain: 'claude' }, kind: 'chat', model: 'exclusive-model', cacheDialect: 'exclusive', inputTokens: 20, cachedInputTokens: 80, outputTokens: 5, totalTokens: 105, durationMs: 2_000, providerApiDurationMs: 1_000 },
    { at: '2026-08-08T01:00:02Z', source: 'candidate', kind: 'chat', model: 'inclusive-model', cacheDialect: 'inclusive', inputTokens: 50, cachedInputTokens: 30, outputTokens: 4, totalTokens: 54, durationMs: 750, providerApiDurationMs: 400 },
    { at: '2026-08-08T01:00:03Z', source: 'unrelated', kind: 'chat', model: 'other', cacheDialect: 'none', inputTokens: 999, outputTokens: 1, totalTokens: 1_000 },
    { at: '2026-08-08T02:00:04Z', source: 'multi', trace: { acceptedSource: 'multi:201', logicalTurnId: 'turn:201', attemptId: 'attempt-multi-1' }, kind: 'chat', model: 'claude-main', cacheDialect: 'inclusive', inputTokens: 120, cachedInputTokens: 20, outputTokens: 8, totalTokens: 128, durationMs: 400 },
    { at: '2026-08-08T02:00:05.150Z', source: 'judge-worker', trace: { acceptedSource: 'multi:201', logicalTurnId: 'turn:201', attemptId: 'attempt-multi-1' }, kind: 'background', model: 'claude-judge', cacheDialect: 'exclusive', inputTokens: 10, cachedInputTokens: 30, outputTokens: 2, totalTokens: 12, durationMs: 150 },
    { at: '2026-08-08T04:00:01Z', source: 'multi', trace: { acceptedSource: 'multi' }, kind: 'chat', model: 'legacy-model', cacheDialect: 'inclusive', inputTokens: 50, cachedInputTokens: 10, outputTokens: 5, totalTokens: 55, durationMs: 500 },
    { at: '2026-08-08T05:00:00.500Z', source: 'invalid-attribution', trace: { acceptedSource: 'invalid-attribution:301', logicalTurnId: 'turn:301', attemptId: 'attempt-for-another-source' }, kind: 'chat', model: 'invalid-model', cacheDialect: 'inclusive', inputTokens: 70, outputTokens: 7, totalTokens: 77 },
  ];
  writeFileSync(usageFile, `${usage.map((event) => JSON.stringify(event)).join('\n')}\nnot-json\n`, 'utf8');
  return { home, usageFile, dbPath };
}

test('measureSession reads canonical tool, discovery, usage, latency, and wall accounting without mutating fixtures', () => {
  const fixture = fixtureHome();
  try {
    const dbBefore = statSync(fixture.dbPath).mtimeMs;
    const usageBefore = readFileSync(fixture.usageFile, 'utf8');
    const measured = measureSession(fixture.home, 'baseline');

    assert.equal(measured.canonicalTopLevelToolCalls, 4);
    assert.equal(measured.explicitTopLevelToolCalls, 3);
    assert.equal(measured.nestedBatchToolCalls, 1);
    assert.equal(measured.toolCalledRows, 5);
    assert.equal(measured.toolReturnedRows, 5);
    assert.equal(measured.toolLifecycleEvents, 10);
    assert.equal(measured.transportMirrorCalls, 1);
    assert.equal(measured.transportMirrorEvents, 2);
    assert.equal(measured.topLevelToolSearches, 1);
    assert.equal(measured.composioSearchDispatches, 1, 'canonical wrapper + mirror is one physical discovery dispatch');
    assert.equal(measured.discoveryOperations, 2);
    assert.equal(measured.schemaMetadataRefreshes, 1);
    assert.deepEqual(measured.perTool, {
      tool_search: 1,
      composio_search_tools: 1,
      run_batch: 1,
      OUTLOOK_CREATE_DRAFT: 1,
    });
    assert.equal(measured.usageRecords, 2);
    assert.equal(measured.promptTokens, 200);
    assert.equal(measured.cachedInputTokens, 140);
    assert.equal(measured.uncachedInputTokens, 60);
    assert.equal(measured.outputTokens, 15);
    assert.equal(measured.sdkDurationMs, 3_000);
    assert.equal(measured.providerDurationMs, 1_500);
    assert.equal(measured.turnWallMs, 10_000);
    assert.equal(measured.wallStartType, 'user_input_received');
    assert.equal(measured.terminalType, 'conversation_completed');
    assert.equal(measured.malformedUsageLines, 1);
    assert.equal(statSync(fixture.dbPath).mtimeMs, dbBefore);
    assert.equal(readFileSync(fixture.usageFile, 'utf8'), usageBefore);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('comparison formatter emits candidate deltas and percentages for the isolated sessions', () => {
  const fixture = fixtureHome();
  try {
    const comparison = compareSessions({ home: fixture.home, baseline: 'baseline', candidate: 'candidate' });
    const text = formatSessionComparison(comparison);
    assert.match(text, /Canonical tool calls \(no mirrors\).*4\s+1\s+-3 \(-75\.0%\)/);
    assert.match(text, /Canonical prompt tokens.*200\s+50\s+-150 \(-75\.0%\)/);
    assert.match(text, /Summed SDK latency.*3\.000s\s+0\.750s\s+-2\.250s \(-75\.0%\)/);
    assert.match(text, /Usage records \(agent runs \+ auxiliaries\)/);
    assert.match(text, /Provider schema metadata refreshes \(non-business\).*1\s+0\s+-1 \(-100\.0%\)/);
    assert.match(text, /Usage records by model/);
    assert.match(text, /OUTLOOK_CREATE_DRAFT/);
    assert.match(text, /malformed usage line/);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('CLI arguments require explicit baseline and candidate while accepting an isolated home', () => {
  const parsed = parseSessionComparisonArgs([
    '--candidate', 'new-session',
    '--home', '/tmp/clementine-comparison-home',
    '--baseline', 'old-session',
  ]);
  assert.deepEqual(parsed, {
    baseline: 'old-session',
    candidate: 'new-session',
    home: '/tmp/clementine-comparison-home',
  });
  assert.throws(() => parseSessionComparisonArgs(['--baseline', 'only-one']), /--baseline and --candidate are required/);
  assert.deepEqual(parseSessionComparisonArgs(['--help']), { help: true });
});

test('measureAcceptedTurn isolates an exact source, includes attempt closeout, and joins auxiliary usage', () => {
  const fixture = fixtureHome();
  try {
    const measured = measureAcceptedTurn(fixture.home, 'multi', 201);
    assert.equal(measured.acceptedTurns, 1);
    assert.equal(measured.terminalSeq, 205);
    assert.equal(measured.terminalTransport, 'claude_agent_sdk');
    assert.equal(measured.terminalStatus, 'done');
    assert.equal(measured.terminalSteps, 1);
    assert.equal(measured.modelRouteEvents, 2, 'post-terminal route before attempt finish belongs to the turn');
    assert.equal(measured.exactModelRouteEvents, 1);
    assert.equal(measured.legacyWindowModelRouteEvents, 1);
    assert.equal(measured.canonicalTopLevelToolCalls, 1);
    assert.equal(measured.discoveryOperations, 1);
    assert.equal(measured.exactUsageRecords, 2, 'cross-session judge usage joins by accepted source');
    assert.equal(measured.legacyWindowUsageRecords, 0);
    assert.equal(measured.promptTokens, 160);
    assert.equal(measured.outputTokens, 10);
    assert.equal(measured.usageAttribution, 'exact');
    assert.equal(measured.usageAttributionCertified, true);
    assert.equal(measured.governorKnownCapability, false);
    assert.deepEqual(measured.discoveryClaimsByCategory, { broad_discovery: 1 });
    assert.deepEqual(measured.discoveryClaimsByOutcome, { succeeded: 1 });
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('measureAcceptedTurn joins exact post-closeout routes by attempt while bounding legacy routes', () => {
  const fixture = fixtureHome();
  try {
    const measured = measureAcceptedTurn(fixture.home, 'post-closeout-route', 401);
    assert.equal(measured.exactModelRouteEvents, 1, 'the exact route survives its 1ms post-closeout append');
    assert.equal(measured.legacyWindowModelRouteEvents, 1, 'only the in-window legacy route is admitted');
    assert.equal(measured.modelRouteEvents, 2, 'the foreign-attempt and post-closeout legacy rows are excluded');
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('completed-answer replay certifies zero model, usage, tool, and discovery work', () => {
  const fixture = fixtureHome();
  try {
    const measured = measureAcceptedTurn(fixture.home, 'multi', 210);
    assert.equal(measured.terminalTransport, 'completed_answer_replay');
    assert.equal(measured.terminalSteps, 0);
    assert.equal(measured.modelRouteEvents, 0);
    assert.equal(measured.usageRecords, 0);
    assert.equal(measured.canonicalTopLevelToolCalls, 0);
    assert.equal(measured.discoveryOperations, 0);
    assert.equal(measured.usageAttribution, 'none');
    assert.equal(measured.usageAttributionCertified, true);
    assert.deepEqual(measured.usageCertificationIssues, []);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('legacy window usage remains measurable but cannot certify a turn', () => {
  const fixture = fixtureHome();
  try {
    const measured = measureAcceptedTurn(fixture.home, 'multi', 220);
    assert.equal(measured.exactUsageRecords, 0);
    assert.equal(measured.legacyWindowUsageRecords, 1);
    assert.equal(measured.usageAttribution, 'legacy_window');
    assert.equal(measured.usageAttributionCertified, false);
    assert.ok(measured.usageCertificationIssues.includes('legacy_window_usage'));
    assert.ok(measured.usageCertificationIssues.includes('model_route_without_exact_usage'));
    assert.equal(measured.governorKnownCapability, true);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('an exact-looking usage row with a foreign attempt is excluded and invalidates certification', () => {
  const fixture = fixtureHome();
  try {
    const measured = measureAcceptedTurn(fixture.home, 'invalid-attribution', 301);
    assert.equal(measured.exactUsageRecords, 0);
    assert.equal(measured.invalidUsageAttributions, 1);
    assert.equal(measured.promptTokens, 0, 'invalid-attribution tokens entered the turn total');
    assert.equal(measured.usageAttributionCertified, false);
    assert.ok(measured.usageCertificationIssues.includes('invalid_attempt_attribution'));
    assert.ok(measured.usageCertificationIssues.includes('model_route_without_exact_usage'));
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('turn comparison CLI and formatter use separate session/source selectors', () => {
  const fixture = fixtureHome();
  try {
    const args = parseAcceptedTurnComparisonArgs([
      '--candidate-source', '210',
      '--baseline-session', 'multi',
      '--home', fixture.home,
      '--candidate-session', 'multi',
      '--baseline-source', '201',
    ]);
    assert.deepEqual(args, {
      baselineSession: 'multi',
      baselineSource: 201,
      candidateSession: 'multi',
      candidateSource: 210,
      home: fixture.home,
    });
    if ('help' in args) assert.fail('unexpected help result');
    const comparison = compareAcceptedTurns(args);
    const text = formatAcceptedTurnComparison(comparison);
    assert.match(text, /Model routes.*2\s+0\s+-2 \(-100\.0%\)/);
    assert.match(text, /completed_answer_replay/);
    assert.match(text, /exact \(certified\) → none \(certified\)/);
    assert.throws(
      () => parseAcceptedTurnComparisonArgs(['--baseline-session', 'multi']),
      /baseline-source.*candidate-session.*candidate-source/,
    );
    assert.throws(
      () => parseAcceptedTurnComparisonArgs([
        '--baseline-session', 'multi', '--baseline-source', '0',
        '--candidate-session', 'multi', '--candidate-source', '210',
      ]),
      /positive event sequence/,
    );
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});


test('causally owned background memory after delivery is included exactly once in task totals', () => {
  const fixture = fixtureHome();
  try {
    const before = measureAcceptedTurn(fixture.home, 'multi', 201);
    const row = {at:'2026-08-08T03:30:00.000Z', source:'memory:standing:job-fixture', kind:'background', channel:'memory:standing', role:'reviewer',
      trace:{acceptedSource:'multi:201', logicalTurnId:'turn:201', attemptId:'attempt-multi-1'},
      model:'fixture-memory', cacheDialect:'inclusive', inputTokens:123, outputTokens:7, totalTokens:130};
    writeFileSync(fixture.usageFile, readFileSync(fixture.usageFile, 'utf8') + JSON.stringify(row) + '\n');
    const after = measureAcceptedTurn(fixture.home, 'multi', 201);
    assert.equal(after.promptTokens - before.promptTokens, 123);
    assert.equal(after.outputTokens - before.outputTokens, 7);
    assert.equal(after.usageRecords - before.usageRecords, 1);
  } finally { rmSync(fixture.home, {recursive:true, force:true}); }
});

function approvalTaskFixture(): ReturnType<typeof fixtureHome> {
  const fixture = fixtureHome();
  const db = new Database(fixture.dbPath);
  db.exec(`CREATE TABLE pending_approvals (
    approval_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
    resolution TEXT, requested_at TEXT, resolved_at TEXT
  )`);
  seedSession(db, 'task', [
    { seq: 501, type: 'user_input_received', at: '2026-08-08T07:00:00.000Z' },
    { seq: 502, type: 'turn_model_routed', at: '2026-08-08T07:00:01.000Z', data: { sourceUserSeq: 501, attemptId: 'task-root' } },
    { seq: 503, type: 'tool_called', at: '2026-08-08T07:00:02.000Z', data: { tool: 'fixture_read', callId: 'root-call', accounting: 'top_level' } },
    { seq: 504, type: 'conversation_completed', at: '2026-08-08T07:00:05.000Z', data: typedTerminal('task', 501, 1) },
    { seq: 510, type: 'user_input_received', at: '2026-08-08T07:00:10.000Z', data: { approvalId: 'apr-one', decision: 'approve', source: 'desktop_approval' } },
    { seq: 511, type: 'run_resumed', at: '2026-08-08T07:00:10.100Z', data: { approvalId: 'apr-one', decision: 'approve', deliverySourceUserSeq: 510, executionSourceUserSeq: 501, reviewContinuationVersion: 1 } },
    { seq: 512, type: 'turn_model_routed', at: '2026-08-08T07:00:11.000Z', data: { sourceUserSeq: 501, attemptId: 'task-control-one' } },
    { seq: 513, type: 'tool_called', at: '2026-08-08T07:00:12.000Z', data: { tool: 'fixture_write', callId: 'control-call', accounting: 'top_level' } },
    { seq: 514, type: 'conversation_completed', at: '2026-08-08T07:00:15.000Z', data: typedTerminal('task', 510, 1) },
    // A normal human message between approvals is not part of this task.
    { seq: 515, type: 'user_input_received', at: '2026-08-08T07:00:16.000Z' },
    { seq: 516, type: 'tool_called', at: '2026-08-08T07:00:16.100Z', data: { tool: 'unrelated_tool', callId: 'unrelated-call', accounting: 'top_level' } },
    { seq: 517, type: 'conversation_completed', at: '2026-08-08T07:00:17.000Z', data: typedTerminal('task', 515, 1) },
    // Synthetic control inputs are admitted only through the durable proof.
    { seq: 520, type: 'user_input_received', at: '2026-08-08T07:00:20.000Z', data: { approvalId: 'apr-two', decision: 'approve', source: 'approval_resume', synthetic: true } },
    { seq: 521, type: 'run_resumed', at: '2026-08-08T07:00:20.100Z', data: { approvalId: 'apr-two', decision: 'approve', deliverySourceUserSeq: 520, executionSourceUserSeq: 510, reviewContinuationVersion: 1 } },
    { seq: 522, type: 'turn_model_routed', at: '2026-08-08T07:00:21.000Z', data: { sourceUserSeq: 501, attemptId: 'task-control-two' } },
    { seq: 523, type: 'tool_called', at: '2026-08-08T07:00:22.000Z', data: { tool: 'fixture_verify', callId: 'verify-call', accounting: 'top_level' } },
    { seq: 524, type: 'conversation_completed', at: '2026-08-08T07:00:25.000Z', data: typedTerminal('task', 520, 1) },
    // Exact post-closeout route must not require a timestamp-window guess.
    { seq: 525, type: 'turn_model_routed', at: '2026-08-08T07:00:25.101Z', data: { sourceUserSeq: 501, attemptId: 'task-control-two' } },
  ]);
  const attempt = db.prepare('INSERT INTO run_attempts VALUES (?, ?, ?, ?, ?, ?)');
  attempt.run('task-root', 'task', '2026-08-08T07:00:00.000Z', '2026-08-08T07:00:05.100Z', 'interrupted', 501);
  attempt.run('task-control-one', 'task', '2026-08-08T07:00:10.000Z', '2026-08-08T07:00:15.100Z', 'interrupted', 510);
  attempt.run('task-unrelated', 'task', '2026-08-08T07:00:16.000Z', '2026-08-08T07:00:17.000Z', 'completed', 515);
  attempt.run('task-control-two', 'task', '2026-08-08T07:00:20.000Z', '2026-08-08T07:00:25.100Z', 'completed', 520);
  const approval = db.prepare('INSERT INTO pending_approvals VALUES (?, ?, ?, ?, ?, ?)');
  approval.run('apr-one', 'task', 'resolved', 'approved', '2026-08-08T07:00:03.000Z', '2026-08-08T07:00:10.000Z');
  approval.run('apr-two', 'task', 'resolved', 'approved', '2026-08-08T07:00:12.000Z', '2026-08-08T07:00:20.000Z');
  db.close();
  const row = (seq: number, attemptId: string, at: string, inputTokens: number, cachedInputTokens: number, outputTokens: number, cacheDialect = 'inclusive') => ({
    at: `2026-08-08T07:00:${at}Z`, source: 'auxiliary-worker', kind: 'chat', model: 'fixture-model',
    trace: { acceptedSource: `task:${seq}`, logicalTurnId: `turn:${seq}`, attemptId },
    inputTokens, cachedInputTokens, outputTokens, cacheDialect,
  });
  const rows = [
    row(501, 'task-root', '04.000', 100, 30, 5),
    row(501, 'task-control-one', '14.000', 200, 50, 6),
    row(510, 'task-control-one', '14.500', 10, 20, 2, 'exclusive'),
    row(501, 'task-control-two', '24.000', 300, 100, 8),
    row(520, 'task-control-two', '30.000', 40, 10, 2),
    row(515, 'task-unrelated', '16.500', 999, 0, 99),
  ];
  writeFileSync(fixture.usageFile, readFileSync(fixture.usageFile, 'utf8') + rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return fixture;
}

test('task scope unions proved approval descendants and their own reviews without changing single-turn totals', () => {
  const fixture = approvalTaskFixture();
  try {
    const beforeDb = readFileSync(fixture.dbPath);
    const beforeUsage = readFileSync(fixture.usageFile);
    const initial = measureAcceptedTurn(fixture.home, 'task', 501);
    assert.equal(initial.usageRecords, 1);
    assert.equal(initial.promptTokens, 100);
    assert.equal(initial.turnWallMs, 5_000);
    const task = measureAcceptedTask(fixture.home, 'task', 501);
    assert.deepEqual(task.sourceUserSeqs, [501, 510, 520]);
    assert.equal(task.approvalContinuations.length, 2);
    assert.deepEqual(task.approvalContinuations.map(link => link.executionSourceUserSeq), [501, 510]);
    assert.equal(task.usageRecords, 5, 'root trace, control traces, and late auxiliary each counted once');
    assert.equal(task.promptTokens, 670, 'exclusive cache rows use the canonical normalizer');
    assert.equal(task.cachedInputTokens, 210);
    assert.equal(task.uncachedInputTokens, 460);
    assert.equal(task.outputTokens, 23);
    assert.equal(task.canonicalTopLevelToolCalls, 3, 'unrelated intervening turn excluded');
    assert.equal(task.perTool.unrelated_tool, undefined);
    assert.equal(task.attemptCount, 3);
    assert.equal(task.modelRouteEvents, 4, 'includes exact route emitted after attempt closeout');
    assert.equal(task.taskWallMs, 25_000);
    assert.equal(task.segmentWallMs, 15_300);
    assert.equal(task.recordedApprovalWaitMs, 15_000);
    assert.equal(task.turnWallMs, null, 'task wall is explicit, never the last segment mislabeled');
    assert.equal(task.usageAttributionCertified, true);
    assert.deepEqual(task.usageCertificationIssues, []);
    assert.deepEqual(measureAcceptedTurn(fixture.home, 'task', 501), initial);
    assert.deepEqual(readFileSync(fixture.dbPath), beforeDb);
    assert.deepEqual(readFileSync(fixture.usageFile), beforeUsage);
    assert.throws(() => measureAcceptedTurn(fixture.home, 'task', 520), /not an accepted human/);
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('ambiguous or missing approval proof cannot certify a cheaper task and preserves excluded candidate cost', () => {
  const corruptions = [
    "UPDATE pending_approvals SET resolution = 'rejected' WHERE approval_id = 'apr-one'",
    "UPDATE events SET data_json = json_set(data_json, '$.decision', 'reject') WHERE seq = 511",
    "UPDATE events SET data_json = json_set(data_json, '$.reviewContinuationVersion', 2) WHERE seq = 511",
    "UPDATE events SET data_json = '{bad json' WHERE seq = 511",
    'DROP TABLE pending_approvals',
    `INSERT INTO events VALUES (509, 'task', 1, 'user', 'user_input_received', '{"approvalId":"apr-one","decision":"approve"}', '2026-08-08T07:00:09.000Z')`,
    `INSERT INTO events VALUES (519, 'task', 1, 'system', 'run_resumed', '{"approvalId":"apr-one","decision":"approve","deliverySourceUserSeq":510,"executionSourceUserSeq":515,"reviewContinuationVersion":1}', '2026-08-08T07:00:19.000Z')`,
  ];
  for (const sql of corruptions) {
    const fixture = approvalTaskFixture();
    try {
      const db = new Database(fixture.dbPath); db.exec(sql); db.close();
      const task = measureAcceptedTask(fixture.home, 'task', 501);
      assert.deepEqual(task.sourceUserSeqs, [501], sql);
      assert.equal(task.usageAttributionCertified, false, sql);
      const unreadableEdge = sql.includes('{bad json');
      assert.equal(task.unprovenUsage.usageRecords, unreadableEdge ? 2 : 4,
        'readable claimed descendants preserve their own review cost too; unreadable edges cannot invent links');
      assert.equal(task.unprovenUsage.promptTokens, unreadableEdge ? 500 : 570);
      assert.ok(task.usageCertificationIssues.includes('unproved_usage_attribution'));
      const text = formatAcceptedTaskComparison({ home: fixture.home, baseline: task, candidate: task });
      assert.match(text, /UNCERTIFIED lower bound/);
      assert.match(text, /Unproven candidate prompt tokens \(excluded\).*5[07]0/);
      assert.match(text, /not comparable whole-task cost/);
    } finally { rmSync(fixture.home, { recursive: true, force: true }); }
  }
});

test('task attribution rejects mismatched logical identities and ancestor direction without deduplicating legitimate calls', () => {
  const fixture = approvalTaskFixture();
  try {
    const row = { at: '2026-08-08T07:00:24.000Z', source: 'judge', kind: 'chat', model: 'fixture',
      trace: { acceptedSource: 'task:501', logicalTurnId: 'turn:501', attemptId: 'task-control-two' },
      cacheDialect: 'inclusive', inputTokens: 20, outputTokens: 2 };
    const rows = [row, row,
      { ...row, trace: { ...row.trace, logicalTurnId: 'turn:510' } },
      { ...row, trace: { ...row.trace, attemptId: 'task-unrelated' } },
      { ...row, trace: { acceptedSource: 'task:510', logicalTurnId: 'turn:510', attemptId: 'task-root' } },
    ];
    writeFileSync(fixture.usageFile, readFileSync(fixture.usageFile, 'utf8') + rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const task = measureAcceptedTask(fixture.home, 'task', 501);
    assert.equal(task.usageRecords, 7, 'equal payloads are distinct physical calls, not member-sum duplicates');
    assert.equal(task.promptTokens, 710);
    assert.equal(task.unprovenUsage.usageRecords, 3);
    assert.equal(task.unprovenUsage.promptTokens, 60);
    assert.equal(task.usageAttributionCertified, false);
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('missing terminal, unfinished attempt, and unknown approval wait remain explicitly incomplete', () => {
  const fixture = approvalTaskFixture();
  try {
    const db = new Database(fixture.dbPath);
    db.exec("DELETE FROM events WHERE seq = 524; UPDATE run_attempts SET finished_at = NULL WHERE attempt_id = 'task-control-two'; UPDATE pending_approvals SET resolved_at = NULL WHERE approval_id = 'apr-two'");
    db.close();
    const task = measureAcceptedTask(fixture.home, 'task', 501);
    assert.equal(task.usageRecords, 5, 'partial completion does not hide already incurred exact cost');
    assert.equal(task.taskWallMs, null);
    assert.equal(task.recordedApprovalWaitMs, null);
    assert.equal(task.unfinishedAttempts, 1);
    assert.equal(task.usageAttributionCertified, false);
    assert.ok(task.usageCertificationIssues.includes('missing_terminal:520'));
    assert.ok(task.usageCertificationIssues.includes('unfinished_source_attempt:520'));
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('task scope requires explicit CLI opt-in and reports linked totals separately', () => {
  const fixture = approvalTaskFixture();
  try {
    const base = ['--baseline-session', 'task', '--baseline-source', '501', '--candidate-session', 'task', '--candidate-source', '501', '--home', fixture.home];
    assert.deepEqual(parseMeasurementComparisonArgs(base), parseAcceptedTurnComparisonArgs(base));
    const args = parseMeasurementComparisonArgs([...base, '--scope', 'task']);
    if ('help' in args) assert.fail('unexpected help');
    assert.equal(args.scope, 'task');
    const text = formatAcceptedTaskComparison(compareAcceptedTasks(args));
    assert.match(text, /sources 501, 510, 520/);
    assert.match(text, /Proven task usage records.*5\s+5/);
    assert.match(text, /Recorded approval request → decision wait/);
    assert.throws(() => parseMeasurementComparisonArgs([...base, '--scope', 'everything']), /--scope must be/);
    assert.throws(() => parseMeasurementComparisonArgs([...base, '--scope', 'task', '--scope', 'turn']), /only be supplied once/);
    assert.deepEqual(parseMeasurementComparisonArgs(['--help']), { help: true });
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('approval wait timing is independently unknown when old columns are absent, and overlapping waits are unioned', () => {
  const fixture = approvalTaskFixture();
  try {
    const db = new Database(fixture.dbPath);
    db.exec("UPDATE pending_approvals SET requested_at = '2026-08-08T07:00:04.000Z' WHERE approval_id = 'apr-two'");
    db.close();
    assert.equal(measureAcceptedTask(fixture.home, 'task', 501).recordedApprovalWaitMs, 17_000);
    const oldDb = new Database(fixture.dbPath);
    oldDb.exec('ALTER TABLE pending_approvals DROP COLUMN requested_at; ALTER TABLE pending_approvals DROP COLUMN resolved_at');
    oldDb.close();
    const task = measureAcceptedTask(fixture.home, 'task', 501);
    assert.equal(task.usageRecords, 5);
    assert.equal(task.usageAttributionCertified, true, 'missing timing is not missing identity');
    assert.equal(task.recordedApprovalWaitMs, null);
    assert.equal(task.approvalWaitIssues.length, 2);
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('exact foreign-source usage never becomes a same-session legacy row through time adjacency', () => {
  const fixture = approvalTaskFixture();
  try {
    const row = { at: '2026-08-08T07:00:24.000Z', source: 'task', kind: 'other', model: 'unrelated',
      trace: { acceptedSource: 'task:515', logicalTurnId: 'turn:515', attemptId: 'task-unrelated' },
      cacheDialect: 'inclusive', inputTokens: 999, outputTokens: 99 };
    writeFileSync(fixture.usageFile, readFileSync(fixture.usageFile, 'utf8') + JSON.stringify(row) + '\n');
    const task = measureAcceptedTask(fixture.home, 'task', 501);
    assert.equal(task.promptTokens, 670);
    assert.equal(task.legacyWindowUsageRecords, 0);
    assert.equal(task.unscopedWindowUsageRecords, 0);
    assert.equal(task.usageAttributionCertified, true);
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('malformed foreign-looking traces remain visible instead of certifying a cheaper task', () => {
  const fixture = approvalTaskFixture();
  try {
    const rows = ['garbage', 'task:515'].map(acceptedSource => ({
      at: '2026-08-08T07:00:24.000Z', source: 'task', kind: 'chat', model: 'unproved',
      trace: { acceptedSource, logicalTurnId: 'turn:not-a-source' },
      cacheDialect: 'inclusive', inputTokens: 99, outputTokens: 9,
    }));
    writeFileSync(fixture.usageFile, readFileSync(fixture.usageFile, 'utf8') + rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const task = measureAcceptedTask(fixture.home, 'task', 501);
    assert.equal(task.promptTokens, 670);
    assert.equal(task.legacyWindowUsageRecords, 2);
    assert.equal(task.usageAttributionCertified, false);
    assert.ok(task.usageCertificationIssues.includes('excluded_legacy_window_usage'));
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});
