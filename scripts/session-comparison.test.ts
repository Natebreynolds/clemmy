import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  compareAcceptedTurns,
  compareSessions,
  formatAcceptedTurnComparison,
  formatSessionComparison,
  measureAcceptedTurn,
  measureSession,
  parseAcceptedTurnComparisonArgs,
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
