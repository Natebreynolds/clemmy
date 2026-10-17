import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { ModelRequest } from '@openai/agents-core';
import { BASE_DIR, REAL_DEFAULT_CLEMENTINE_HOME } from '../src/config.js';
import { CodexResponsesModel } from '../src/runtime/harness/codex-model.js';
import { harnessRunContextStorage } from '../src/runtime/harness/brackets.js';
import {
  appendEvent, beginRunAttempt, closeEventLog, createSession, finishRunAttempt,
  listEvents, recordRunAttemptUserInput,
} from '../src/runtime/harness/eventlog.js';
import { completedModelResponseBinding } from '../src/runtime/harness/model-response-binding.js';
import { createModelResilienceObservation } from '../src/runtime/harness/model-resilience-observation.js';
import { withModelResilienceTelemetry } from '../src/runtime/harness/resilient-model.js';
import { withModelTransportRecorder } from '../src/runtime/harness/model-transport-observation.js';
import { parseUsageLedger, usageFileForDate, withModelUsageAttribution } from '../src/runtime/usage-log.js';
import { modelUsageAttributionStorage, memoryAccountingParent } from '../src/runtime/usage-log.js';
import { automaticMemoryOriginsForCapture, autoCaptureProvenanceFromAcceptedEvent, extractAutoMemoryCandidates } from '../src/memory/auto-capture.js';
import { closeMemoryDb, openMemoryDb } from '../src/memory/db.js';
import { drainDurableConsolidationCandidates, enqueueAutoCaptureCandidates } from '../src/memory/durable-consolidation.js';
import { readMemoryCandidateAccountingOrigin } from '../src/memory/memory-causal-accounting.js';
import { inMemoryJobTurn, runMemoryModelJob } from '../src/memory/memory-job-context.js';
import { parseAutomaticStandingMemoryReview } from '../src/memory/standing-memory-review.js';
import { captureFreshSourceSessionContext } from '../src/runtime/harness/source-session-context.js';
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

test('task report distinguishes receipt-linked proactive operations from proved response usage', () => {
  const fixture = approvalTaskFixture();
  try {
    const task = measureAcceptedTask(fixture.home, 'task', 501);
    task.proactiveUsageParticipants = [{ usageJobId: 'noticing-job:11111111-1111-4111-8111-111111111111',
      operation: 'noticing_answer', operationId: 'controlled-checkin', revisionDigest: 'a'.repeat(64),
      parentAcceptedSources: ['task:501'], responseBindings: [], startedAt: null, finishedAt: null }];
    task.proactiveExactUsageRecords = 0;
    const report = formatAcceptedTaskComparison({ home: fixture.home, baseline: task, candidate: task });
    assert.match(report, /Receipt-linked proactive jobs\s+1\s+1/);
    assert.match(report, /Original-response-linked proactive usage rows\s+0\s+0/);
    assert.match(report, /only original-response-proved rows extend usage/);
    assert.match(report, /serving identity is not measured by the latest build pin/);
    assert.doesNotMatch(report, /proactive precursor usage is response-linked/);
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

function addTimingStore(db: Database.Database): void {
  db.exec(`ALTER TABLE events ADD COLUMN id TEXT;
    UPDATE events SET id = 'fixture-event-' || seq;
    CREATE TABLE model_request_provenance (
      source_user_seq INTEGER, request_ordinal INTEGER, protocol_version INTEGER,
      created_at TEXT, source_event_id TEXT, session_id TEXT
    )`);
}

function timingEvents(source: number, attempt: string, start: string, firstSeq: number, overrides: Record<string, unknown> = {}): FixtureEvent[] {
  const base = Date.parse(start);
  const identity = { version: 1, sourceUserSeq: source, stepId: `step-${source}`, runAttemptId: attempt,
    requestOrdinal: 1, retired: false, requestAborted: false, ...overrides };
  const event = (offset: number, ms: number, data: Record<string, unknown>): FixtureEvent => ({
    seq: firstSeq + offset, type: 'model_resilience_observed', at: new Date(base + ms).toISOString(),
    data: { ...identity, ...data },
  });
  return [
    event(0, 100, { phase: 'call_started', callId: `call-${source}`, at: base + 100 }),
    event(1, 1_100, { phase: 'attempt_finished', callId: `call-${source}`, at: base + 1_100,
      durationMs: 1_000, outcome: 'failed' }),
    event(2, 1_300, { phase: 'retry_wait_finished', callId: `call-${source}`, at: base + 1_300,
      durationMs: 200, outcome: 'completed' }),
    event(3, 2_500, { phase: 'call_finished', callId: `call-${source}`, at: base + 2_500,
      durationMs: 2_400, outcome: 'returned', attemptCount: 2, failedAttemptCount: 1,
      attemptMs: 2_200, failedAttemptMs: 1_000, retryWaitMs: 200 }),
    event(6, 3_000, { phase: 'host_step_finished', at: base + 3_000, durationMs: 3_000, outcome: 'returned',
      retired: false, requestAborted: false }),
  ];
}

function timingFixture() {
  const fixture = fixtureHome();
  const db = new Database(fixture.dbPath);
  const start = '2026-08-08T08:00:00.000Z';
  seedSession(db, 'timing', [
    { seq: 600, type: 'user_input_received', at: start },
    ...timingEvents(600, 'timing-attempt', start, 601),
    { seq: 609, type: 'conversation_completed', at: '2026-08-08T08:00:10.000Z', data: typedTerminal('timing', 600, 1) },
  ]);
  db.prepare('INSERT INTO run_attempts VALUES (?, ?, ?, ?, ?, ?)')
    .run('timing-attempt', 'timing', start, '2026-08-08T08:00:10.100Z', 'completed', 600);
  addTimingStore(db);
  db.prepare('INSERT INTO model_request_provenance VALUES (?, ?, ?, ?, ?, ?)')
    .run(600, 1, 1, '2026-08-08T08:00:00.050Z', 'fixture-event-600', 'timing');
  db.close();
  writeFileSync(fixture.usageFile, readFileSync(fixture.usageFile, 'utf8') + JSON.stringify({
    at: '2026-08-08T08:00:02.500Z', source: 'timing', trace: { acceptedSource: 'timing:600', logicalTurnId: 'turn:600', attemptId: 'timing-attempt' },
    model: 'fixture', kind: 'chat', cacheDialect: 'inclusive', inputTokens: 100, cachedInputTokens: 25,
    outputTokens: 10, durationMs: 700, providerApiDurationMs: 500,
  }) + '\n');
  return fixture;
}

test('canonical timing retains one failed physical attempt without changing usage or provider durations', () => {
  const fixture = timingFixture();
  try {
    const beforeDb = readFileSync(fixture.dbPath), beforeUsage = readFileSync(fixture.usageFile);
    const measured = measureAcceptedTurn(fixture.home, 'timing', 600);
    assert.deepEqual(measured.modelTiming, {
      scope: 'host_main_steps_only', coverage: 'observed_host_steps', physicalAttemptCoverage: 'observed_calls',
      provenanceRequests: 1, observedRequests: 1, observedHostSteps: 1, observedResilienceCalls: 1,
      hostStepMs: 3_000, resilienceCallMs: 2_400, physicalAttemptCount: 2, failedAttemptCount: 1,
      failedAttemptMs: 1_000, retryWaitMs: 200, retiredResilienceCalls: 0,
      requestAbortedResilienceCalls: 0, failedAttemptUsage: 'unknown',
    });
    assert.deepEqual(measured.modelTimingIssues, []);
    assert.equal(measured.promptTokens, 100); assert.equal(measured.cachedInputTokens, 25);
    assert.equal(measured.outputTokens, 10); assert.equal(measured.usageRecords, 1);
    assert.equal(measured.sdkDurationMs, 700); assert.equal(measured.providerDurationMs, 500);
    assert.equal(measured.turnWallMs, 10_000);
    const text = formatAcceptedTurnComparison({ home: fixture.home, baseline: measured, candidate: measured });
    assert.match(text, /Summed observed failed-attempt time.*1\.000s/);
    assert.match(text, /not task wall time or billable time/);
    assert.match(text, /token usage and billing remain unknown/);
    assert.deepEqual(readFileSync(fixture.dbPath), beforeDb); assert.deepEqual(readFileSync(fixture.usageFile), beforeUsage);
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('legacy timing and missing dispatch proof stay null, while generic host-only timing is visibly partial', () => {
  const fixture = timingFixture();
  try {
    const legacy = measureAcceptedTurn(fixture.home, 'multi', 201);
    assert.equal(legacy.modelTiming?.coverage, 'none'); assert.equal(legacy.modelTiming?.hostStepMs, null);
    assert.equal(legacy.modelTiming?.failedAttemptMs, null); assert.equal(legacy.modelTiming?.failedAttemptCount, null);
    const db = new Database(fixture.dbPath);
    db.exec("DELETE FROM events WHERE session_id = 'timing' AND type = 'model_resilience_observed' AND json_extract(data_json, '$.phase') != 'host_step_finished'");
    db.close();
    const generic = measureAcceptedTurn(fixture.home, 'timing', 600);
    assert.equal(generic.modelTiming?.hostStepMs, 3_000); assert.equal(generic.modelTiming?.coverage, 'partial');
    assert.equal(generic.modelTiming?.physicalAttemptCoverage, 'none'); assert.equal(generic.modelTiming?.failedAttemptMs, null);
    const old = new Database(fixture.dbPath); old.exec('DROP TABLE model_request_provenance'); old.close();
    const missing = measureAcceptedTurn(fixture.home, 'timing', 600);
    assert.equal(missing.modelTiming?.hostStepMs, null); assert.equal(missing.modelTiming?.provenanceRequests, null);
    assert.ok(missing.modelTimingIssues?.includes('timing_dispatch_provenance_unavailable'));
    assert.equal(missing.promptTokens, 100);
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('missing attempt timing columns cannot erase existing canonical usage or task lineage', () => {
  const fixture = timingFixture();
  try {
    const before = measureAcceptedTurn(fixture.home, 'timing', 600);
    const db = new Database(fixture.dbPath); db.exec('ALTER TABLE run_attempts DROP COLUMN started_at'); db.close();
    const measured = measureAcceptedTurn(fixture.home, 'timing', 600);
    assert.equal(measured.attemptCount, before.attemptCount); assert.equal(measured.exactUsageRecords, before.exactUsageRecords);
    assert.equal(measured.promptTokens, before.promptTokens); assert.equal(measured.providerDurationMs, before.providerDurationMs);
    assert.deepEqual(measured.usageCertificationIssues, before.usageCertificationIssues);
    assert.equal(measured.modelTiming?.hostStepMs, null); assert.equal(measured.modelTiming?.coverage, 'none');
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
  const taskFixture = approvalTaskFixture();
  try {
    const before = measureAcceptedTask(taskFixture.home, 'task', 501);
    const db = new Database(taskFixture.dbPath); db.exec('ALTER TABLE run_attempts DROP COLUMN started_at'); db.close();
    const task = measureAcceptedTask(taskFixture.home, 'task', 501);
    assert.deepEqual(task.sourceUserSeqs, before.sourceUserSeqs); assert.equal(task.promptTokens, before.promptTokens);
    assert.equal(task.attemptCount, before.attemptCount); assert.deepEqual(task.usageCertificationIssues, before.usageCertificationIssues);
    assert.equal(task.modelTiming?.failedAttemptMs, null);
  } finally { rmSync(taskFixture.home, { recursive: true, force: true }); }
});

test('retired physical child time is retained inside a live host step; post-step close is excluded', () => {
  const fixture = timingFixture();
  try {
    const db = new Database(fixture.dbPath);
    db.exec("UPDATE events SET data_json = json_set(data_json, '$.retired', json('true'), '$.requestAborted', json('true')) WHERE seq = 604");
    const call = JSON.parse(String((db.prepare('SELECT data_json FROM events WHERE seq = 604').get() as { data_json: string }).data_json));
    seedSession(db, 'timing', [
      { seq: 606, type: 'model_resilience_observed', at: '2026-08-08T08:00:02.500Z',
        data: { ...call, callId: 'overlapping-rescue-call', retired: false, requestAborted: false } },
      { seq: 610, type: 'model_resilience_observed', at: '2026-08-08T08:00:04.000Z',
        data: { ...call, callId: 'late-private-call', at: Date.parse('2026-08-08T08:00:04.000Z') } },
    ]);
    db.close();
    const measured = measureAcceptedTurn(fixture.home, 'timing', 600);
    assert.equal(measured.modelTiming?.failedAttemptMs, 2_000);
    assert.equal(measured.modelTiming?.retiredResilienceCalls, 1); assert.equal(measured.modelTiming?.requestAbortedResilienceCalls, 1);
    assert.equal(measured.modelTiming?.observedResilienceCalls, 2); assert.equal(measured.modelTiming?.coverage, 'partial');
    assert.equal(measured.modelTiming?.resilienceCallMs, 4_800, 'distinct overlapping calls remain a sum, not wall time');
    assert.equal(measured.modelTiming?.hostStepMs, 3_000, 'host time is neither added to nor replaced by physical-call sums');
    assert.equal(measured.usageRecords, 1, 'timing never manufactures usage records for physical calls');
    assert.ok(measured.modelTimingIssues?.includes('retired_resilience_call_timing'));
    assert.ok(measured.modelTimingIssues?.includes('late_resilience_call_timing'));
    assert.equal(measured.modelTiming?.failedAttemptUsage, 'unknown');
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('duplicate closes are never added and conflicting or unproved timing stays excluded', () => {
  const variants = [
    { sql: "INSERT INTO events SELECT 606, session_id, turn, role, type, data_json, created_at, 'duplicate' FROM events WHERE seq = 604", callMs: 2_400, issue: 'duplicate_resilience_call_close' },
    { sql: "INSERT INTO events SELECT 606, session_id, turn, role, type, json_set(data_json, '$.durationMs', 2399), created_at, 'conflict' FROM events WHERE seq = 604", callMs: null, issue: 'conflicting_resilience_call_close' },
    { sql: "UPDATE events SET data_json = json_set(data_json, '$.runAttemptId', 'foreign-attempt') WHERE seq = 607", callMs: null, issue: 'unproved_model_timing_owner' },
    { sql: "UPDATE model_request_provenance SET source_event_id = 'fixture-event-201'", callMs: null, issue: 'invalid_timing_dispatch_provenance' },
    { sql: "UPDATE events SET data_json = json_set(data_json, '$.failedAttemptMs', -1) WHERE seq = 604", callMs: null, issue: 'unbounded_resilience_call_timing' },
    { sql: "UPDATE events SET data_json = json_set(data_json, '$.requestOrdinal', 2) WHERE seq = 604", callMs: null, issue: 'unbounded_resilience_call_timing' },
    { sql: "UPDATE events SET data_json = json_set(data_json, '$.durationMs', 12000) WHERE seq = 607", callMs: null, issue: 'unbounded_host_step_timing' },
    { sql: "INSERT INTO model_request_provenance SELECT * FROM model_request_provenance; INSERT INTO model_request_provenance SELECT * FROM model_request_provenance", callMs: null, issue: 'duplicate_timing_dispatch_provenance' },
    { sql: "INSERT INTO events SELECT 608, session_id, turn, role, type, json_set(data_json, '$.stepId', 'second-step-claim'), created_at, 'duplicate-step' FROM events WHERE seq = 607", callMs: null, issue: 'duplicate_host_request_timing' },
  ];
  for (const variant of variants) {
    const fixture = timingFixture();
    try {
      const db = new Database(fixture.dbPath); db.exec(variant.sql); db.close();
      const measured = measureAcceptedTurn(fixture.home, 'timing', 600);
      assert.equal(measured.modelTiming?.resilienceCallMs, variant.callMs, variant.sql);
      assert.ok(measured.modelTimingIssues?.includes(variant.issue), variant.sql);
      assert.notEqual(measured.modelTiming?.coverage, 'observed_host_steps');
      assert.equal(measured.promptTokens, 100); assert.equal(measured.providerDurationMs, 500);
    } finally { rmSync(fixture.home, { recursive: true, force: true }); }
  }
});

test('an earlier same-source request cannot be reused by a later attempt or a mismatched physical call', () => {
  const fixture = timingFixture();
  try {
    const db = new Database(fixture.dbPath);
    db.prepare('INSERT INTO run_attempts VALUES (?, ?, ?, ?, ?, ?)').run('timing-later', 'timing',
      '2026-08-08T08:00:05.000Z', '2026-08-08T08:00:09.000Z', 'completed', 600);
    seedSession(db, 'timing', timingEvents(600, 'timing-later', '2026-08-08T08:00:05.000Z', 620,
      { stepId: 'later-step', requestOrdinal: 1, callId: 'later-call' }));
    // Remove the valid earlier observation, leaving an otherwise valid later
    // attempt whose ordinal was sealed before that attempt/step began.
    db.exec('DELETE FROM events WHERE seq BETWEEN 601 AND 607'); db.close();
    const later = measureAcceptedTurn(fixture.home, 'timing', 600);
    assert.equal(later.modelTiming?.hostStepMs, null);
    assert.ok(later.modelTimingIssues?.includes('unbounded_host_step_timing'));
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
  const mismatch = timingFixture();
  try {
    const db = new Database(mismatch.dbPath);
    db.prepare('INSERT INTO model_request_provenance VALUES (?, ?, ?, ?, ?, ?)').run(600, 2, 1,
      '2026-08-08T08:00:00.060Z', 'fixture-event-600', 'timing');
    db.exec("UPDATE events SET data_json = json_set(data_json, '$.requestOrdinal', 2) WHERE seq BETWEEN 601 AND 604"); db.close();
    const measured = measureAcceptedTurn(mismatch.home, 'timing', 600);
    assert.equal(measured.modelTiming?.hostStepMs, 3_000); assert.equal(measured.modelTiming?.resilienceCallMs, null);
    assert.ok(measured.modelTimingIssues?.includes('unbounded_resilience_call_timing'));
  } finally { rmSync(mismatch.home, { recursive: true, force: true }); }
});

test('task timing unions validated sources once, retains ancestor execution ownership, and excludes unrelated followups', () => {
  const fixture = approvalTaskFixture();
  try {
    const db = new Database(fixture.dbPath);
    addTimingStore(db);
    const dispatch = db.prepare('INSERT INTO model_request_provenance VALUES (?, ?, ?, ?, ?, ?)');
    for (const [source, attempt, start, firstSeq] of [
      [501, 'task-root', '2026-08-08T07:00:00.000Z', 700],
      [510, 'task-control-one', '2026-08-08T07:00:10.000Z', 710],
      [520, 'task-control-two', '2026-08-08T07:00:20.000Z', 720],
      [515, 'task-unrelated', '2026-08-08T07:00:16.000Z', 730],
    ] as const) {
      seedSession(db, 'task', timingEvents(source, attempt, start, firstSeq));
      dispatch.run(source, 1, 1, new Date(Date.parse(start) + 50).toISOString(), `fixture-event-${source}`, 'task');
    }
    db.close();
    const task = measureAcceptedTask(fixture.home, 'task', 501);
    assert.equal(task.modelTiming?.hostStepMs, 9_000); assert.equal(task.modelTiming?.resilienceCallMs, 7_200);
    assert.equal(task.modelTiming?.failedAttemptMs, 3_000); assert.equal(task.modelTiming?.observedHostSteps, 3);
    assert.equal(task.modelTiming?.provenanceRequests, 3); assert.equal(task.modelTiming?.coverage, 'observed_host_steps');
    assert.equal(task.promptTokens, 670); assert.equal(task.taskWallMs, 25_000);
    const legacy = new Database(fixture.dbPath);
    legacy.exec('DELETE FROM events WHERE seq BETWEEN 720 AND 726; DELETE FROM model_request_provenance WHERE source_user_seq = 520');
    legacy.close();
    const mixed = measureAcceptedTask(fixture.home, 'task', 501);
    assert.equal(mixed.modelTiming?.hostStepMs, 6_000); assert.equal(mixed.modelTiming?.coverage, 'partial');
    assert.ok(mixed.modelTimingIssues?.includes('timing_source_unobserved:520'));
    const restore = new Database(fixture.dbPath);
    seedSession(restore, 'task', timingEvents(520, 'task-control-two', '2026-08-08T07:00:20.000Z', 720));
    restore.prepare('INSERT INTO model_request_provenance VALUES (?, ?, ?, ?, ?, ?)').run(520, 1, 1,
      '2026-08-08T07:00:20.050Z', 'fixture-event-520', 'task'); restore.close();
    // Rebind the control step to the durable execution ancestor exactly as a
    // host approval continuation does; provenance remains exact to that owner.
    const ancestor = new Database(fixture.dbPath);
    ancestor.exec("UPDATE events SET data_json = json_set(data_json, '$.sourceUserSeq', 501, '$.requestOrdinal', 2) WHERE seq BETWEEN 710 AND 716; UPDATE model_request_provenance SET source_user_seq = 501, request_ordinal = 2, source_event_id = 'fixture-event-501' WHERE source_user_seq = 510");
    ancestor.close();
    const rebound = measureAcceptedTask(fixture.home, 'task', 501);
    assert.equal(rebound.modelTiming?.hostStepMs, 9_000); assert.equal(rebound.modelTiming?.failedAttemptMs, 3_000);
    const broken = new Database(fixture.dbPath); broken.exec("UPDATE pending_approvals SET resolution = 'rejected' WHERE approval_id = 'apr-one'"); broken.close();
    const partial = measureAcceptedTask(fixture.home, 'task', 501);
    assert.equal(partial.modelTiming?.hostStepMs, 3_000); assert.equal(partial.modelTiming?.observedHostSteps, 1);
    assert.equal(partial.modelTiming?.coverage, 'partial');
    assert.ok(partial.modelTimingIssues?.includes('unproved_task_timing_lineage'));
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

function mainCallCoverageFixture() {
  const fixture = fixtureHome();
  const db = new Database(fixture.dbPath);
  const start = Date.parse('2026-08-08T09:00:00.000Z');
  const at = (ms: number) => new Date(start + ms).toISOString();
  const owner = { version: 1, sourceUserSeq: 1000, runAttemptId: 'main-coverage-attempt', retired: false, requestAborted: false };
  const call = (ordinal: number, seq: number, begin: number, finish: number, stepBegin: number): FixtureEvent[] => {
    const identity = { ...owner, requestOrdinal: ordinal, stepId: `main-step-${ordinal}` };
    return [
      { seq, type: 'model_resilience_observed', at: at(begin), data: { ...identity,
        phase: 'call_started', callId: `host-main-${ordinal}`, at: start + begin } },
      { seq: seq + 1, type: 'model_resilience_observed', at: at(finish), data: { ...identity,
        phase: 'call_finished', callId: `host-main-${ordinal}`, at: start + finish,
        durationMs: finish - begin, outcome: 'returned', attemptCount: 1, failedAttemptCount: 0,
        attemptMs: finish - begin, failedAttemptMs: 0, retryWaitMs: 0 } },
      { seq: seq + 2, type: 'model_stream_diagnostic', at: at(finish + 10), data: {
        sourceUserSeq: 1000, attemptId: 'main-coverage-attempt', responseId: `provider-main-${ordinal}`,
        settlement: 'completed', sawResponseDone: true } },
      { seq: seq + 3, type: 'model_resilience_observed', at: at(finish + 20), data: { ...identity,
        phase: 'host_step_finished', at: start + finish + 20, durationMs: finish + 20 - stepBegin, outcome: 'returned' } },
    ];
  };
  seedSession(db, 'main-coverage', [
    { seq: 1000, type: 'user_input_received', at: at(0) },
    ...call(1, 1001, 100, 1000, 0),
    ...call(2, 1005, 2000, 3000, 1900),
    { seq: 1009, type: 'conversation_completed', at: at(5000), data: typedTerminal('main-coverage', 1000, 1) },
  ]);
  db.prepare('INSERT INTO run_attempts VALUES (?, ?, ?, ?, ?, ?)')
    .run('main-coverage-attempt', 'main-coverage', at(0), at(5100), 'completed', 1000);
  addTimingStore(db);
  const dispatch = db.prepare('INSERT INTO model_request_provenance VALUES (?, ?, ?, ?, ?, ?)');
  dispatch.run(1000, 1, 1, at(50), 'fixture-event-1000', 'main-coverage');
  dispatch.run(1000, 2, 1, at(1950), 'fixture-event-1000', 'main-coverage');
  db.close();
  const usage = [1, 2].map(ordinal => ({ at: at(ordinal === 1 ? 1000 : 3000), source: 'main-coverage',
    trace: { acceptedSource: 'main-coverage:1000', logicalTurnId: 'turn:1000', attemptId: 'main-coverage-attempt',
      modelCallId: `host-main-${ordinal}` }, responseId: `provider-main-${ordinal}`, model: 'fixture-main', kind: 'chat',
    cacheDialect: 'inclusive', inputTokens: ordinal * 100, cachedInputTokens: ordinal * 25,
    outputTokens: ordinal * 10, durationMs: ordinal === 1 ? 700 : 900, providerApiDurationMs: ordinal === 1 ? 500 : 600,
  }));
  writeFileSync(fixture.usageFile, readFileSync(fixture.usageFile, 'utf8') + usage.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { ...fixture, at, usage };
}

function replaceMainUsage(fixture: ReturnType<typeof mainCallCoverageFixture>, rows: unknown[]): void {
  const prior = readFileSync(fixture.usageFile, 'utf8').split('\n').filter(line => {
    try { return JSON.parse(line).source !== 'main-coverage'; } catch { return true; }
  });
  writeFileSync(fixture.usageFile, prior.filter(Boolean).join('\n') + '\n' + rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

function boundMainCallFixture() {
  const fixture = mainCallCoverageFixture();
  const db = new Database(fixture.dbPath);
  const rows = db.prepare("SELECT seq FROM events WHERE session_id='main-coverage' AND seq>1000 ORDER BY seq DESC").all() as { seq: number }[];
  for (const row of rows) db.prepare('UPDATE events SET seq=? WHERE seq=?').run(1000 + (row.seq - 1000) * 2, row.seq);
  for (const ordinal of [1, 2]) seedSession(db, 'main-coverage', [{ seq: ordinal === 1 ? 1003 : 1011,
    type: 'model_resilience_observed', at: fixture.at(ordinal === 1 ? 999 : 2999), data: {
      version: 1, sourceUserSeq: 1000, runAttemptId: 'main-coverage-attempt', requestOrdinal: ordinal,
      stepId: `main-step-${ordinal}`, callId: `host-main-${ordinal}`, phase: 'response_observed', attempt: 1,
      retired: false, requestAborted: false,
      providerResponseIdDigest: createHash('sha256').update(`provider-main-${ordinal}`).digest('hex'),
    } }]);
  db.close();
  return fixture;
}

test('producer completed-response digests certify only their exact same-source host-call usage and preserve totals', () => {
  const fixture = boundMainCallFixture();
  try {
    for (const measured of [measureAcceptedTurn(fixture.home, 'main-coverage', 1000), measureAcceptedTask(fixture.home, 'main-coverage', 1000)]) {
      assert.equal(measured.usageAttributionCertified, true);
      assert.deepEqual(measured.usageCertificationIssues, []);
      assert.equal(measured.promptTokens, 300); assert.equal(measured.outputTokens, 30);
      assert.equal(measured.sdkDurationMs, 1600); assert.equal(measured.modelTiming?.resilienceCallMs, 1900);
    }
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('wrong digest, call, attempt, late binding or duplicate response cannot certify a producer bridge', () => {
  for (const variant of ['digest', 'call', 'attempt', 'late', 'duplicate'] as const) {
    const fixture = boundMainCallFixture();
    try {
      const db = new Database(fixture.dbPath);
      if (variant === 'digest') db.prepare("UPDATE events SET data_json=json_set(data_json,'$.providerResponseIdDigest',?) WHERE seq=1011").run('0'.repeat(64));
      if (variant === 'call') db.exec("UPDATE events SET data_json=json_set(data_json,'$.callId','host-other') WHERE seq=1011");
      if (variant === 'attempt') db.exec("UPDATE events SET data_json=json_set(data_json,'$.runAttemptId','unrelated-attempt') WHERE seq=1011");
      if (variant === 'late') db.exec('UPDATE events SET seq=1017 WHERE seq=1011');
      if (variant === 'duplicate') db.exec('INSERT INTO events (seq,session_id,turn,role,type,data_json,created_at) SELECT 1013,session_id,turn,role,type,data_json,created_at FROM events WHERE seq=1011');
      db.close();
      for (const measured of [measureAcceptedTurn(fixture.home, 'main-coverage', 1000), measureAcceptedTask(fixture.home, 'main-coverage', 1000)]) {
        assert.equal(measured.usageAttributionCertified, false, variant);
        assert.ok(measured.usageCertificationIssues.some(issue => /main_.*(?:binding|bound_response|observation_ownership|physical_call)/.test(issue)), variant);
        assert.equal(measured.promptTokens, 300); assert.equal(measured.outputTokens, 30);
      }
    } finally { rmSync(fixture.home, { recursive: true, force: true }); }
  }
});

test('an exact producer response binding never converts cancelled or unaccounted retry usage into a certified task', () => {
  for (const variant of ['cancelled-with-usage', 'cancelled-unknown', 'retry'] as const) {
    const fixture = boundMainCallFixture();
    try {
      const db = new Database(fixture.dbPath);
      if (variant === 'retry') db.exec("UPDATE events SET data_json=json_set(data_json,'$.attemptCount',2,'$.failedAttemptCount',1) WHERE seq=1012");
      else db.exec("UPDATE events SET data_json=json_set(data_json,'$.outcome','cancelled','$.requestAborted',json('true')) WHERE seq=1012");
      db.close();
      if (variant === 'cancelled-unknown') replaceMainUsage(fixture, [fixture.usage[0]]);
      const measured = measureAcceptedTask(fixture.home, 'main-coverage', 1000);
      assert.equal(measured.usageAttributionCertified, false, variant);
      assert.ok(measured.usageCertificationIssues.includes('main_failed_or_aborted_attempt_usage_unknown:1000'), variant);
      assert.equal(measured.promptTokens, variant === 'cancelled-unknown' ? 100 : 300);
    } finally { rmSync(fixture.home, { recursive: true, force: true }); }
  }
});

test('exact same-tuple host and provider identities cover each main completed call without changing arithmetic or timing', () => {
  const fixture = mainCallCoverageFixture();
  try {
    const beforeDb = readFileSync(fixture.dbPath), beforeUsage = readFileSync(fixture.usageFile);
    for (const measured of [measureAcceptedTurn(fixture.home, 'main-coverage', 1000), measureAcceptedTask(fixture.home, 'main-coverage', 1000)]) {
      assert.equal(measured.usageAttributionCertified, true);
      assert.deepEqual(measured.usageCertificationIssues, []);
      assert.equal(measured.exactUsageRecords, 2);
      assert.equal(measured.promptTokens, 300); assert.equal(measured.cachedInputTokens, 75);
      assert.equal(measured.uncachedInputTokens, 225); assert.equal(measured.outputTokens, 30);
      assert.equal(measured.sdkDurationMs, 1600); assert.equal(measured.providerDurationMs, 1100);
      assert.equal(measured.modelTiming?.hostStepMs, 2140); assert.equal(measured.modelTiming?.resilienceCallMs, 1900);
      assert.equal(measured.modelTiming?.physicalAttemptCount, 2); assert.deepEqual(measured.modelTimingIssues, []);
    }
    assert.deepEqual(readFileSync(fixture.dbPath), beforeDb); assert.deepEqual(readFileSync(fixture.usageFile), beforeUsage);
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('a completed first call cannot certify a late cancelled second call after source closeout or unrelated input', () => {
  const fixture = mainCallCoverageFixture();
  try {
    replaceMainUsage(fixture, [fixture.usage[0]]);
    const db = new Database(fixture.dbPath);
    db.exec(`UPDATE events SET seq=1015, created_at='${fixture.at(5200)}',
      data_json=json_set(data_json,'$.outcome','cancelled','$.requestAborted',json('true'),'$.retired',json('true'),
        '$.failedAttemptCount',1,'$.at',${Date.parse(fixture.at(5200))},'$.durationMs',3200) WHERE seq=1006;
      UPDATE events SET seq=1016, created_at='${fixture.at(5210)}',
      data_json=json_set(data_json,'$.settlement','error','$.sawResponseDone',json('false')) WHERE seq=1007;
      UPDATE events SET created_at='${fixture.at(4990)}',
      data_json=json_set(data_json,'$.outcome','cancelled','$.at',${Date.parse(fixture.at(4990))},'$.durationMs',3090) WHERE seq=1008`);
    seedSession(db, 'main-coverage', [
      { seq: 1010, type: 'user_input_received', at: fixture.at(5150), turn: 2 },
      { seq: 1012, type: 'conversation_completed', at: fixture.at(5300), turn: 2, data: typedTerminal('main-coverage', 1010, 2) },
    ]);
    db.close();
    for (const measured of [measureAcceptedTurn(fixture.home, 'main-coverage', 1000), measureAcceptedTask(fixture.home, 'main-coverage', 1000)]) {
      assert.equal(measured.usageAttributionCertified, false);
      assert.ok(measured.usageCertificationIssues.includes('main_response_without_exact_usage:1000:1016'));
      assert.ok(measured.usageCertificationIssues.includes('main_failed_or_aborted_attempt_usage_unknown:1000'));
      assert.ok(measured.usageCertificationIssues.includes('main_host_call_usage_unknown:1000:1005'));
      assert.equal(measured.exactUsageRecords, 1); assert.equal(measured.promptTokens, 100);
      assert.equal(measured.outputTokens, 10); assert.equal(measured.providerDurationMs, 500);
      assert.equal(measured.modelTiming?.resilienceCallMs, 900, 'late cancelled closure is coverage evidence, not added timing');
      assert.ok(measured.modelTimingIssues?.includes('late_resilience_call_timing'));
    }
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('provider response coverage alone cannot bridge distinct main host call identities', () => {
  const fixture = mainCallCoverageFixture();
  try {
    replaceMainUsage(fixture, fixture.usage.map(row => ({ ...row, trace: { ...row.trace, modelCallId: row.responseId } })));
    for (const measured of [measureAcceptedTurn(fixture.home, 'main-coverage', 1000), measureAcceptedTask(fixture.home, 'main-coverage', 1000)]) {
      assert.equal(measured.usageAttributionCertified, false);
      assert.ok(measured.usageCertificationIssues.includes('main_host_call_usage_unknown:1000:1001'));
      assert.ok(measured.usageCertificationIssues.includes('main_host_call_usage_unknown:1000:1005'));
      assert.ok(!measured.usageCertificationIssues.some(issue => issue.startsWith('main_response_without_exact_usage')));
      assert.equal(measured.promptTokens, 300); assert.equal(measured.providerDurationMs, 1100);
    }
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('separate same-attempt host and provider rows cannot invent a bridge, and one provider response cannot cover two host calls', () => {
  for (const variant of ['separate-rows', 'reused-provider'] as const) {
    const fixture = mainCallCoverageFixture();
    try {
      if (variant === 'separate-rows') replaceMainUsage(fixture, fixture.usage.flatMap(row => [
        { ...row, responseId: undefined }, { ...row, trace: { ...row.trace, modelCallId: row.responseId } },
      ]));
      else {
        replaceMainUsage(fixture, [fixture.usage[0], { ...fixture.usage[1], responseId: fixture.usage[0].responseId }]);
        const db = new Database(fixture.dbPath);
        db.exec("UPDATE events SET data_json=json_set(data_json,'$.responseId','provider-main-1') WHERE seq=1007"); db.close();
      }
      for (const measured of [measureAcceptedTurn(fixture.home, 'main-coverage', 1000), measureAcceptedTask(fixture.home, 'main-coverage', 1000)]) {
        assert.equal(measured.usageAttributionCertified, false, variant);
        assert.ok(measured.usageCertificationIssues.some(issue => issue.startsWith(variant === 'separate-rows'
          ? 'main_response_host_bridge_unknown' : 'conflicting_main_response_bridge')), variant);
        assert.equal(measured.promptTokens, variant === 'separate-rows' ? 600 : 300, 'known rows remain charged without deduplication');
      }
    } finally { rmSync(fixture.home, { recursive: true, force: true }); }
  }
});

test('same-model time-overlapping or same-response foreign-source usage cannot fill a main response gap', () => {
  for (const variant of ['unrelated-source', 'wrong-attempt', 'wrong-turn', 'wrong-response'] as const) {
    const fixture = mainCallCoverageFixture();
    try {
      const second = fixture.usage[1];
      const trace = { ...second.trace,
        ...(variant === 'unrelated-source' ? { acceptedSource: 'main-coverage:1010', logicalTurnId: 'turn:1010', attemptId: 'foreign-main-attempt' } : {}),
        ...(variant === 'wrong-attempt' ? { attemptId: 'foreign-main-attempt' } : {}),
        ...(variant === 'wrong-turn' ? { logicalTurnId: 'turn:1010' } : {}),
        ...(variant === 'wrong-response' ? { modelCallId: 'host-unrelated' } : {}),
      };
      replaceMainUsage(fixture, [fixture.usage[0], { ...second, trace,
        ...(variant === 'wrong-response' ? { responseId: 'provider-unrelated' } : {}) }]);
      for (const measured of [measureAcceptedTurn(fixture.home, 'main-coverage', 1000), measureAcceptedTask(fixture.home, 'main-coverage', 1000)]) {
        assert.equal(measured.usageAttributionCertified, false, variant);
        assert.ok(measured.usageCertificationIssues.includes('main_response_without_exact_usage:1000:1007'), variant);
        assert.ok(measured.usageCertificationIssues.includes('main_host_call_usage_unknown:1000:1005'), variant);
      }
    } finally { rmSync(fixture.home, { recursive: true, force: true }); }
  }
});

test('failed or aborted main calls and zero usage placeholders remain unknown despite earlier completed coverage', () => {
  for (const variant of ['failed-retry', 'aborted', 'zero-placeholder', 'missing-close', 'unknown-attempt-count'] as const) {
    const fixture = mainCallCoverageFixture();
    try {
      const db = new Database(fixture.dbPath);
      if (variant === 'failed-retry') db.exec("UPDATE events SET data_json=json_set(data_json,'$.failedAttemptCount',1,'$.attemptCount',2) WHERE seq=1006");
      if (variant === 'aborted') db.exec("UPDATE events SET data_json=json_set(data_json,'$.requestAborted',json('true')) WHERE seq=1006");
      if (variant === 'missing-close') db.exec('DELETE FROM events WHERE seq=1006');
      if (variant === 'unknown-attempt-count') db.exec("UPDATE events SET data_json=json_remove(data_json,'$.attemptCount') WHERE seq=1006");
      db.close();
      if (variant === 'zero-placeholder') replaceMainUsage(fixture, [fixture.usage[0], {
        ...fixture.usage[1], ok: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
      }]);
      for (const measured of [measureAcceptedTurn(fixture.home, 'main-coverage', 1000), measureAcceptedTask(fixture.home, 'main-coverage', 1000)]) {
        assert.equal(measured.usageAttributionCertified, false, variant);
        assert.ok(measured.usageCertificationIssues.some(issue => issue.startsWith(variant === 'missing-close'
          ? 'main_unsettled_physical_call_usage_unknown' : variant === 'zero-placeholder'
            ? 'main_response_without_exact_usage' : variant === 'unknown-attempt-count'
              ? 'main_physical_attempt_membership_unknown' : 'main_failed_or_aborted_attempt_usage_unknown')), variant);
      }
    } finally { rmSync(fixture.home, { recursive: true, force: true }); }
  }
});

test('main provider observations require owned host membership and cannot reuse one host ID across steps', () => {
  const fixture = mainCallCoverageFixture();
  try {
    const db = new Database(fixture.dbPath);
    db.exec("UPDATE events SET data_json=json_set(data_json,'$.callId','host-main-1') WHERE seq IN (1005,1006)"); db.close();
    const conflict = measureAcceptedTask(fixture.home, 'main-coverage', 1000);
    assert.equal(conflict.usageAttributionCertified, false);
    assert.ok(conflict.usageCertificationIssues.some(issue => issue.startsWith('conflicting_main_host_call_identity')));
    const remove = new Database(fixture.dbPath);
    remove.exec("DELETE FROM events WHERE session_id='main-coverage' AND type='model_resilience_observed'"); remove.close();
    const providerOnly = measureAcceptedTurn(fixture.home, 'main-coverage', 1000);
    assert.equal(providerOnly.usageAttributionCertified, false);
    assert.ok(providerOnly.usageCertificationIssues.includes('main_host_call_membership_unknown:1000'));
    assert.equal(providerOnly.promptTokens, 300);
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('fresh main producer coverage remains separate from all-leg inventory and unmeasured billing', () => {
  const fixture = boundMainCallFixture();
  try {
    for (const measured of [measureAcceptedTurn(fixture.home, 'main-coverage', 1000), measureAcceptedTask(fixture.home, 'main-coverage', 1000)]) {
      const completeness = measured.usageCompleteness;
      assert.equal(measured.usageAttributionCertified, true, 'legacy attribution meaning is preserved');
      assert.deepEqual(completeness.mainProducerCoverage, {
        status: 'observed_completed_calls', observedCalls: 2, responseBoundCalls: 2, issues: [],
      });
      assert.equal(completeness.allLegUsageCertified, false);
      assert.equal(completeness.totals, 'recorded_lower_bound');
      assert.deepEqual(completeness.auxiliaryPhysicalInventory, { status: 'unproved', recordedRowsOutsideMainCalls: 0 },
        'no auxiliary row observed is not proof that no auxiliary call occurred');
      assert.deepEqual(completeness.cost, { providerPricedCost: 'not_measured', actualBilling: 'not_measured' });
      assert.equal(completeness.identityGaps.billedAccountRows, 2);
      assert.equal(completeness.identityGaps.backendRows, 2);
      assert.ok(completeness.issues.includes('all_leg_physical_inventory_unproved'));
      assert.equal(measured.promptTokens, 300); assert.equal(measured.sdkDurationMs, 1600);
    }
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('legacy exact main usage cannot supply a missing fresh response-observed producer phase', () => {
  const fixture = mainCallCoverageFixture();
  try {
    const measured = measureAcceptedTask(fixture.home, 'main-coverage', 1000);
    assert.equal(measured.usageAttributionCertified, true);
    assert.equal(measured.usageCompleteness.mainProducerCoverage.status, 'incomplete');
    assert.equal(measured.usageCompleteness.mainProducerCoverage.responseBoundCalls, 0);
    assert.ok(measured.usageCompleteness.mainProducerCoverage.issues.some(issue => issue.startsWith('main_fresh_producer_coverage_unproved')));
    assert.equal(measured.promptTokens, 300);
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('an exactly attributed failed auxiliary rank retains unknown usage instead of certifying its zero placeholder', () => {
  const fixture = boundMainCallFixture();
  try {
    const failedRank = { ...fixture.usage[0], role: 'router', channel: 'rank', ok: false,
      responseId: undefined, trace: { ...fixture.usage[0].trace, modelCallId: undefined },
      inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 2467 };
    replaceMainUsage(fixture, [...fixture.usage, failedRank]);
    for (const measured of [measureAcceptedTurn(fixture.home, 'main-coverage', 1000), measureAcceptedTask(fixture.home, 'main-coverage', 1000)]) {
      assert.equal(measured.usageAttributionCertified, true);
      assert.equal(measured.uncertifiedUsageCalls, 1);
      assert.equal(measured.usageCompleteness.mainProducerCoverage.status, 'observed_completed_calls');
      assert.deepEqual(measured.usageCompleteness.recordedTokenRows, { certified: 2, unknown: 1, invalid: 0, failed: 1 });
      assert.equal(measured.usageCompleteness.knownZeroCompletedMainCalls, 0);
      assert.equal(measured.usageCompleteness.auxiliaryPhysicalInventory.recordedRowsOutsideMainCalls, 1);
      assert.ok(measured.usageCompleteness.issues.includes('recorded_token_usage_unknown:1'));
      assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
      assert.equal(measured.promptTokens, 300); assert.equal(measured.outputTokens, 30);
      assert.equal(measured.sdkDurationMs, 4067);
    }
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('known zero requires a valid completed-call receipt rather than missing usage or a failed zero', async t => {
  for (const variant of ['completed', 'failed-zero', 'missing', 'missing-producer', 'cache-created'] as const) {
    await t.test(variant, () => {
      const fixture = boundMainCallFixture();
      try {
        const zeros = fixture.usage.map(row => ({ ...row, ok: true, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 }));
        if (variant === 'failed-zero') zeros[0].ok = false;
        if (variant === 'cache-created') Object.assign(zeros[0], { cacheCreationInputTokens: 1 });
        replaceMainUsage(fixture, variant === 'missing' ? [] : zeros);
        if (variant === 'missing-producer') {
          const db = new Database(fixture.dbPath);
          db.exec("DELETE FROM events WHERE session_id='main-coverage' AND json_extract(data_json,'$.phase')='response_observed'"); db.close();
        }
        const measured = measureAcceptedTask(fixture.home, 'main-coverage', 1000);
        assert.equal(measured.usageCompleteness.knownZeroCompletedMainCalls,
          variant === 'completed' ? 2 : variant === 'failed-zero' || variant === 'cache-created' ? 1 : 0);
        assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
        assert.equal(measured.usageCompleteness.recordedTokenRows.unknown, variant === 'failed-zero' ? 1 : 0);
        if (variant === 'missing') assert.equal(measured.usageCompleteness.mainProducerCoverage.status, 'incomplete');
      } finally { rmSync(fixture.home, { recursive: true, force: true }); }
    });
  }
  const fixture = fixtureHome();
  try {
    const replay = measureAcceptedTurn(fixture.home, 'multi', 210);
    assert.equal(replay.usageAttributionCertified, true);
    assert.equal(replay.usageCompleteness.knownZeroCompletedMainCalls, 0);
    assert.equal(replay.usageCompleteness.mainProducerCoverage.status, 'not_observed');
    assert.equal(replay.usageCompleteness.allLegUsageCertified, false);
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('exact reviewer and late memory rows are visible without inventing their physical inventory or billing proof', () => {
  const fixture = boundMainCallFixture();
  try {
    const auxiliary = ['reviewer', 'memory'].map((role, index) => ({ ...fixture.usage[0], role, channel: `${role}:fixture`,
      at: fixture.at(index ? 12_000 : 4000), model: 'fixture-auxiliary', requestModel: 'fixture-auxiliary',
      trace: { ...fixture.usage[0].trace, modelCallId: `auxiliary-${index}` }, responseId: `auxiliary-response-${index}`,
      providerReportedModel: 'fixture-reported', account: 'fixture-account', backendId: 'fixture-backend' }));
    replaceMainUsage(fixture, [...fixture.usage, ...auxiliary]);
    const measured = measureAcceptedTask(fixture.home, 'main-coverage', 1000);
    assert.equal(measured.usageAttributionCertified, true);
    assert.equal(measured.usageRecords, 4, 'late exact memory is retained once');
    assert.equal(measured.promptTokens, 500);
    assert.equal(measured.usageCompleteness.mainProducerCoverage.responseBoundCalls, 2);
    assert.equal(measured.usageCompleteness.auxiliaryPhysicalInventory.recordedRowsOutsideMainCalls, 2);
    assert.equal(measured.usageCompleteness.auxiliaryPhysicalInventory.status, 'unproved');
    assert.equal(measured.usageCompleteness.identityGaps.billedAccountRows, 2,
      'present auxiliary labels do not fill missing main accounts or prove actual billing');
    assert.equal(measured.usageCompleteness.cost.actualBilling, 'not_measured');
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('fresh producer completeness rejects late, mismatched, aborted and reused host bindings', async t => {
  for (const variant of ['digest', 'late', 'aborted', 'reused-call'] as const) {
    await t.test(variant, () => {
      const fixture = boundMainCallFixture();
      try {
        const db = new Database(fixture.dbPath);
        if (variant === 'digest') db.prepare("UPDATE events SET data_json=json_set(data_json,'$.providerResponseIdDigest',?) WHERE seq=1011").run('0'.repeat(64));
        if (variant === 'late') db.exec('UPDATE events SET seq=1021 WHERE seq=1011');
        if (variant === 'aborted') db.exec("UPDATE events SET data_json=json_set(data_json,'$.requestAborted',json('true')) WHERE seq=1012");
        if (variant === 'reused-call') db.exec("UPDATE events SET data_json=json_set(data_json,'$.callId','host-main-1') WHERE seq IN (1010,1011,1012)");
        db.close();
        const measured = measureAcceptedTask(fixture.home, 'main-coverage', 1000);
        assert.equal(measured.usageCompleteness.mainProducerCoverage.status, 'incomplete');
        assert.equal(measured.usageCompleteness.knownZeroCompletedMainCalls, 0);
        assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
        assert.equal(measured.promptTokens, 300); assert.equal(measured.sdkDurationMs, 1600);
      } finally { rmSync(fixture.home, { recursive: true, force: true }); }
    });
  }
});

test('formatted exact attribution never labels incomplete all-leg usage or billing as a certified baseline', () => {
  const fixture = boundMainCallFixture();
  try {
    const task = measureAcceptedTask(fixture.home, 'main-coverage', 1000);
    const turn = measureAcceptedTurn(fixture.home, 'main-coverage', 1000);
    for (const text of [formatAcceptedTaskComparison({ home: fixture.home, baseline: task, candidate: task }),
      formatAcceptedTurnComparison({ home: fixture.home, baseline: turn, candidate: turn })]) {
      assert.match(text, /attribution:.*certified/);
      assert.match(text, /All-leg usage: UNQUALIFIED lower bound; auxiliary physical-call inventory is unproved/);
      assert.match(text, /Provider-priced cost and actual billing are not measured/);
      assert.match(text, /all_leg_physical_inventory_unproved/);
    }
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

function transportObservationFixture() {
  const fixture = fixtureHome();
  const db = new Database(fixture.dbPath);
  const start = Date.parse('2026-08-08T12:00:00.000Z');
  const at = (ms: number) => new Date(start + ms).toISOString();
  const common = { version: 1, sourceUserSeq: 2000, logicalTurnId: 'turn:2000', runAttemptId: 'transport-attempt',
    clock: 'host_epoch_ms', journalFailed: false, physicalAttempt: 1, purpose: 'reviewer' };
  const observed = (seq: number, ms: number, call: string, data: Record<string, unknown>): FixtureEvent => ({
    seq, type: 'model_transport_observed', at: at(ms), data: { ...common, at: start + ms, modelCallId: call, ...data },
  });
  const dispatch = (seq: number, ms: number, call: string, id: string, ordinal = 1) => observed(seq, ms, call,
    { phase: 'dispatch_started', transport: 'raw_claude_messages', dispatchId: id, wireSubattempt: ordinal });
  const headers = (seq: number, ms: number, call: string, id: string, status: number, ordinal = 1) => observed(seq, ms, call,
    { phase: 'headers_received', transport: 'raw_claude_messages', dispatchId: id, wireSubattempt: ordinal, status, ok: status === 200 });
  const completed = (seq: number, ms: number, call: string, ids: string[], responseId: string) => observed(seq, ms, call,
    { phase: 'model_result_completed', resultScope: 'original_sdk_response', dispatchIds: ids,
      hostResultReceiptId: `receipt-${call}`, providerResponseIdDigest: createHash('sha256').update(responseId).digest('hex'), wireUsageCoverage: 'unproved' });
  seedSession(db, 'transport-task', [
    { seq: 2000, type: 'user_input_received', at: at(0) },
    dispatch(2001, 100, 'call-a', 'wire-a'), dispatch(2002, 200, 'call-b', 'wire-b'),
    headers(2003, 300, 'call-a', 'wire-a', 200),
    observed(2004, 450, 'call-b', { phase: 'dispatch_failed', transport: 'raw_claude_messages', dispatchId: 'wire-b', wireSubattempt: 1, usage: 'unknown' }),
    dispatch(2005, 500, 'call-c', 'wire-c'), headers(2006, 600, 'call-c', 'wire-c', 400),
    dispatch(2007, 700, 'call-c', 'wire-c-retry', 2),
    observed(2008, 800, 'call-b', { phase: 'model_attempt_retired', resultScope: 'local_retirement', dispatchIds: ['wire-b'],
      hostResultReceiptId: 'receipt-b', outcome: 'failed', remoteSettlement: 'unknown', usage: 'unknown' }),
    headers(2009, 900, 'call-c', 'wire-c-retry', 200, 2),
    completed(2010, 1000, 'call-a', ['wire-a'], 'provider-a'),
    completed(2011, 1100, 'call-c', ['wire-c', 'wire-c-retry'], 'provider-c'),
    { seq: 2012, type: 'conversation_completed', at: at(2500), data: typedTerminal('transport-task', 2000, 1) },
  ]);
  db.prepare('INSERT INTO run_attempts VALUES (?, ?, ?, ?, ?, ?)').run('transport-attempt', 'transport-task', at(0), at(2600), 'completed', 2000);
  db.close();
  const usage = [
    { id: 'call-a', responseId: 'provider-a', ms: 1000, input: 20, ok: true },
    { id: 'call-c', responseId: 'provider-c', ms: 1100, input: 30, ok: true },
    { id: 'call-b', responseId: undefined, ms: 800, input: 0, ok: false },
  ].map(row => ({ at: at(row.ms), source: 'transport-task', kind: 'chat', role: 'reviewer', model: 'fixture-model',
    providerReportedModel: row.ok ? 'fixture-model' : undefined, responseId: row.responseId,
    trace: { acceptedSource: 'transport-task:2000', logicalTurnId: 'turn:2000', attemptId: 'transport-attempt', modelCallId: row.id },
    inputTokens: row.input, outputTokens: row.ok ? 2 : 0, cacheDialect: row.ok ? 'inclusive' : 'unknown', ok: row.ok }));
  writeFileSync(fixture.usageFile, readFileSync(fixture.usageFile, 'utf8') + usage.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { ...fixture, at };
}

test('canonical transport journal distinguishes dispatches, original results, interval union and accepted delivery wall', () => {
  const fixture = transportObservationFixture();
  try {
    for (const measured of [measureAcceptedTask(fixture.home, 'transport-task', 2000), measureAcceptedTurn(fixture.home, 'transport-task', 2000)]) {
      const result = measured.transportObservation!;
      assert.equal(result.inventory, 'partial'); assert.equal(result.observedDispatches, 4);
      assert.equal(result.headersReceived, 3); assert.equal(result.fetchFailures, 1); assert.equal(result.localRetirements, 1);
      assert.equal(result.completedModelResults, 2); assert.equal(result.exactResponseUsageJoins, 2);
      assert.equal(result.dispatchToHeadersOrLocalFailureUnionMs, 650, 'overlapping real intervals do not sum to elapsed task time');
      assert.equal(result.observedCompletedModelSpanUnionMs, 1000);
      assert.equal(result.window.elapsedMs, 2500); assert.equal(result.criticalPath, 'not_established');
      assert.equal(result.dispatchesWithoutCompletedUsageProof, 4, 'SDK response joins do not close wire-local usage');
      assert.equal(result.accountAuthority, 'unproved'); assert.equal(result.schemaAndServingIdentity, 'not_bound_by_transport_journal');
      assert.equal(measured.promptTokens, 50); assert.equal(measured.uncertifiedUsageCalls, 1);
      assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
      assert.equal(measured.usageCompleteness.cost.actualBilling, 'not_measured');
    }
    assert.equal(measureAcceptedTask(fixture.home, 'transport-task', 2000).taskWallMs, 2500);
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('canonical transport proof rejects foreign attempts, reused wire/result IDs and missing clocks without changing token lower bounds', () => {
  for (const variant of ['foreign-attempt', 'duplicate-wire', 'duplicate-result', 'missing-clock', 'missing-header', 'wrong-header-transport', 'wrong-header-subattempt', 'contradictory-extra-endpoint'] as const) {
    const fixture = transportObservationFixture();
    try {
      const db = new Database(fixture.dbPath);
      if (variant === 'foreign-attempt') db.exec("UPDATE events SET data_json=json_set(data_json,'$.runAttemptId','foreign-attempt') WHERE session_id='transport-task' AND type='model_transport_observed'");
      if (variant === 'duplicate-wire') db.exec("UPDATE events SET data_json=json_set(data_json,'$.dispatchId','wire-a') WHERE seq=2007");
      if (variant === 'duplicate-result') db.exec("UPDATE events SET data_json=json_set(data_json,'$.hostResultReceiptId','receipt-call-a') WHERE seq=2011");
      if (variant === 'missing-clock') db.exec("UPDATE events SET data_json=json_remove(data_json,'$.clock') WHERE session_id='transport-task' AND type='model_transport_observed'");
      if (variant === 'missing-header') db.exec('DELETE FROM events WHERE seq=2009');
      if (variant === 'wrong-header-transport') db.exec("UPDATE events SET data_json=json_set(data_json,'$.transport','typesafe_systemone') WHERE seq=2009");
      if (variant === 'wrong-header-subattempt') db.exec("UPDATE events SET data_json=json_set(data_json,'$.wireSubattempt',1) WHERE seq=2009");
      if (variant === 'contradictory-extra-endpoint') db.exec(`
        UPDATE events SET seq=2013 WHERE seq=2012;
        UPDATE events SET seq=2012 WHERE seq=2011;
        UPDATE events SET seq=2011 WHERE seq=2010;
        INSERT INTO events (seq,session_id,turn,role,type,data_json,created_at)
          SELECT 2010,session_id,turn,role,type,json_set(data_json,'$.transport','typesafe_systemone','$.wireSubattempt',1),created_at
          FROM events WHERE seq=2009;
      `);
      db.close();
      const measured = measureAcceptedTask(fixture.home, 'transport-task', 2000); const result = measured.transportObservation!;
      assert.equal(measured.promptTokens, 50); assert.equal(measured.taskWallMs, 2500);
      assert.equal(result.allLegPhysicalInventory, 'unproved');
      assert.ok(result.issues.some(issue => /invalid_transport|duplicate_transport|unproved_completed|unbounded_transport|unsettled_transport/.test(issue)), variant);
      if (variant === 'missing-clock') {
        assert.equal(result.dispatchToHeadersOrLocalFailureUnionMs, null);
        assert.equal(result.observedCompletedModelSpanUnionMs, null);
      } else assert.ok((result.exactResponseUsageJoins ?? 0) < 2, variant);
      if (variant === 'contradictory-extra-endpoint') {
        assert.equal(result.exactResponseUsageJoins, 1);
        assert.equal(result.dispatchToHeadersOrLocalFailureUnionMs, 450, 'contradictory dispatch interval is omitted');
      }
    } finally { rmSync(fixture.home, { recursive: true, force: true }); }
  }
});

test('missing journal and after-delivery retirement stay explicit unknown rather than zero or an extended task wall', () => {
  const fixture = transportObservationFixture();
  try {
    const db = new Database(fixture.dbPath);
    db.exec(`UPDATE events SET data_json=json_set(data_json,'$.at',${Date.parse(fixture.at(3000))}), created_at='${fixture.at(3000)}' WHERE seq=2008`);
    db.close();
    const result = measureAcceptedTask(fixture.home, 'transport-task', 2000).transportObservation!;
    assert.equal(result.afterDeliveryEvents, 1); assert.equal(result.window.elapsedMs, 2500);
    const absent = measureAcceptedTask(fixture.home, 'multi', 201).transportObservation!;
    assert.equal(absent.inventory, 'not_observed'); assert.equal(absent.observedDispatches, null);
    assert.equal(absent.completedModelResults, null); assert.equal(absent.dispatchToHeadersOrLocalFailureUnionMs, null);
    assert.equal(absent.allLegPhysicalInventory, 'unproved');
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

function localAdapterFixture() {
  const fixture = fixtureHome(); const db = new Database(fixture.dbPath);
  const epoch = Date.parse('2026-08-09T12:00:00.000Z');
  const at = (ms: number) => new Date(epoch + ms).toISOString();
  const common = { version: 1, sourceUserSeq: 3000, logicalTurnId: 'turn:3000', runAttemptId: 'adapter-attempt',
    clock: 'host_epoch_ms', journalFailed: false, physicalAttempt: 1, purpose: 'reviewer', ownerKind: 'accepted_source_scope' };
  const event = (seq: number, ms: number, call: string, fields: Record<string, unknown>): FixtureEvent => ({
    seq, type: 'model_transport_observed', at: at(ms), data: { ...common, at: epoch + ms, modelCallId: call, ...fields },
  });
  const begin = (seq: number, call: string) => event(seq, seq - 3000, call,
    { phase: 'adapter_attempt_created', resultScope: 'local_adapter_attempt', dispatchIds: [] });
  const finish = (seq: number, call: string, fields: Record<string, unknown>) => event(seq, seq - 3000, call,
    { phase: 'adapter_attempt_finished', outcome: 'returned', resultScope: 'local_retirement', dispatchIds: [],
      usage: 'unknown', remoteSettlement: 'unknown', ...fields });
  const digest = (id: string) => createHash('sha256').update(id).digest('hex');
  seedSession(db, 'adapter-task', [
    { seq: 3000, type: 'user_input_received', at: at(0) },
    begin(3001, 'sdk-ok'), finish(3002, 'sdk-ok', { resultScope: 'original_sdk_response', providerResponseIdDigest: digest('provider-ok') }),
    begin(3003, 'sdk-empty'), finish(3004, 'sdk-empty', { outcome: 'failed', resultScope: 'original_sdk_response', providerResponseIdDigest: digest('provider-empty') }),
    begin(3005, 'cancelled'), finish(3006, 'cancelled', { outcome: 'cancelled' }),
    begin(3007, 'failed'), finish(3008, 'failed', { outcome: 'failed' }),
    begin(3009, 'parsed'),
    event(3010, 10, 'parsed', { phase: 'dispatch_started', transport: 'typesafe_systemone', dispatchId: 'wire-parsed', wireSubattempt: 1, late: false }),
    event(3011, 11, 'parsed', { phase: 'headers_received', transport: 'typesafe_systemone', dispatchId: 'wire-parsed', wireSubattempt: 1, status: 200, ok: true, late: false }),
    finish(3012, 'parsed', { resultScope: 'owned_systemone_parser', dispatchIds: ['wire-parsed'], usage: 'reported',
      remoteSettlement: 'parsed_response', providerReportedModel: 'systemone-actual' }),
    event(3013, 13, 'parsed', { phase: 'model_result_completed', resultScope: 'owned_systemone_parser',
      outcome: 'returned', dispatchIds: ['wire-parsed'], usage: 'reported', remoteSettlement: 'parsed_response', providerReportedModel: 'systemone-actual', hostResultReceiptId: 'parser-receipt' }),
    begin(3014, 'sdk-rowless'), finish(3015, 'sdk-rowless', { resultScope: 'original_sdk_response', providerResponseIdDigest: digest('provider-rowless') }),
    { seq: 3030, type: 'conversation_completed', at: at(100), data: typedTerminal('adapter-task', 3000, 1) },
  ]);
  db.prepare('INSERT INTO run_attempts VALUES (?, ?, ?, ?, ?, ?)').run('adapter-attempt', 'adapter-task', at(0), at(100), 'completed', 3000);
  db.close();
  const usage = [
    { call: 'sdk-ok', responseId: 'provider-ok', input: 20, model: 'sdk-actual', ok: true },
    { call: 'sdk-empty', responseId: 'provider-empty', input: 0, model: 'sdk-actual', ok: false },
    { call: 'parsed', responseId: undefined, input: 30, model: 'systemone-actual', ok: true },
  ].map(row => ({ at: at(50), source: 'adapter-task', kind: 'chat', role: 'reviewer', model: row.model,
    providerReportedModel: row.model, responseId: row.responseId, inputTokens: row.input, outputTokens: row.ok ? 2 : 0,
    cacheDialect: row.ok ? 'inclusive' : 'unknown', ok: row.ok,
    trace: { acceptedSource: 'adapter-task:3000', logicalTurnId: 'turn:3000', attemptId: 'adapter-attempt', modelCallId: row.call } }));
  writeFileSync(fixture.usageFile, readFileSync(fixture.usageFile, 'utf8') + usage.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { ...fixture, at, event, epoch };
}

test('local adapter outcomes include SDK paths without fetches and preserve unknown usage, wire counters and billing limits', () => {
  const fixture = localAdapterFixture();
  try {
    for (const measured of [measureAcceptedTask(fixture.home, 'adapter-task', 3000), measureAcceptedTurn(fixture.home, 'adapter-task', 3000)]) {
      const transport = measured.transportObservation!; const local = transport.localAdapterAttempts!;
      assert.equal(local.status, 'observed_local_endpoints'); assert.deepEqual(local.issues, []);
      assert.equal(local.createdAttempts, 6); assert.equal(local.localTerminals, 6);
      assert.equal(local.returnedAttempts, 3); assert.equal(local.failedAttempts, 2); assert.equal(local.cancelledAttempts, 1);
      assert.equal(local.noObservedDispatchAttempts, 5); assert.equal(local.originalSdkIdentities, 3);
      assert.equal(local.ownedParsedResults, 1); assert.equal(local.exactReportedUsageJoins, 2); assert.equal(local.unknownUsageAttempts, 4);
      assert.equal(local.allLegPhysicalInventory, 'unproved'); assert.equal(local.publicInvocationCoverage, 'unproved');
      assert.equal(local.accountAndBackendAuthority, 'unproved'); assert.equal(transport.observedDispatches, 1);
      assert.equal(transport.exactResponseUsageJoins, 1); assert.equal(transport.dispatchToHeadersOrLocalFailureUnionMs, 1);
      assert.equal(measured.promptTokens, 50); assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
      assert.equal(measured.usageCompleteness.cost.actualBilling, 'not_measured');
    }
    const db = new Database(fixture.dbPath); db.exec("DELETE FROM events WHERE type='model_transport_observed' AND json_extract(data_json,'$.modelCallId')='parsed'"); db.close();
    const transport = measureAcceptedTask(fixture.home, 'adapter-task', 3000).transportObservation!;
    assert.equal(transport.localAdapterAttempts!.createdAttempts, 5);
    assert.equal(transport.inventory, 'not_observed'); assert.equal(transport.observedDispatches, null);
    assert.equal(transport.completedModelResults, null); assert.equal(transport.exactResponseUsageJoins, null);
    const absent = measureAcceptedTask(fixture.home, 'multi', 201).transportObservation!.localAdapterAttempts!;
    assert.equal(absent.status, 'not_observed'); assert.equal(absent.createdAttempts, null); assert.equal(absent.unknownUsageAttempts, null);
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('local endpoint census rejects incomplete, foreign, conflicting and late evidence even when legacy late is false', () => {
  for (const variant of ['missing-start', 'duplicate-start', 'wrong-attempt', 'changed-job', 'changed-purpose', 'clock',
    'journal', 'late-dispatch', 'wire-namespace', 'digest-reused', 'bad-outcome', 'after-delivery', 'wrong-source',
    'object-purpose', 'object-owner-kind', 'object-outcome', 'nonboolean-journal', 'missing-parser-model',
    'persisted-after-delivery', 'attempt-ended-early', 'missing-attempt-bound', 'contradictory-result', 'duplicate-result', 'wrong-result-scope', 'reused-result-receipt'] as const) {
    const fixture = localAdapterFixture();
    try {
      const db = new Database(fixture.dbPath);
      if (variant === 'missing-start') db.exec('DELETE FROM events WHERE seq=3001');
      if (variant === 'duplicate-start') seedSession(db, 'adapter-task', [fixture.event(3016, 16, 'sdk-ok', { phase: 'adapter_attempt_created', resultScope: 'local_adapter_attempt', dispatchIds: [] })]);
      if (variant === 'wrong-attempt') db.exec("UPDATE events SET data_json=json_set(data_json,'$.runAttemptId','foreign') WHERE seq=3002");
      if (variant === 'changed-job') db.exec("UPDATE events SET data_json=json_set(data_json,'$.usageJobId','different-job') WHERE seq=3002");
      if (variant === 'changed-purpose') db.exec("UPDATE events SET data_json=json_set(data_json,'$.purpose','router') WHERE seq=3002");
      if (variant === 'clock') db.exec("UPDATE events SET data_json=json_remove(data_json,'$.clock') WHERE seq=3002");
      if (variant === 'journal') db.exec("UPDATE events SET data_json=json_set(data_json,'$.journalFailed',json('true')) WHERE seq=3002");
      if (variant === 'late-dispatch') seedSession(db, 'adapter-task', [fixture.event(3016, 16, 'sdk-ok', { phase: 'dispatch_started', transport: 'raw_claude_messages', dispatchId: 'late-wire', wireSubattempt: 1, late: false })]);
      if (variant === 'wire-namespace') db.exec("UPDATE events SET data_json=json_set(data_json,'$.ownerKind','accounting_parent') WHERE seq=3010");
      if (variant === 'digest-reused') db.exec("UPDATE events SET data_json=json_set(data_json,'$.providerResponseIdDigest',json_extract((SELECT data_json FROM events WHERE seq=3002),'$.providerResponseIdDigest')) WHERE seq=3015");
      if (variant === 'bad-outcome') db.exec("UPDATE events SET data_json=json_set(data_json,'$.outcome','done') WHERE seq=3002");
      if (variant === 'after-delivery') db.prepare("UPDATE events SET data_json=json_set(data_json,'$.at',?),created_at=? WHERE seq=3002").run(fixture.epoch + 150, fixture.at(150));
      if (variant === 'wrong-source') db.exec("UPDATE events SET data_json=json_set(data_json,'$.sourceUserSeq',499,'$.logicalTurnId','turn:499') WHERE seq=3002");
      if (variant === 'object-purpose') db.exec(`UPDATE events SET data_json=json_set(data_json,'$.purpose',json('{"toString":"invalid"}')) WHERE seq=3002`);
      if (variant === 'object-owner-kind') db.exec(`UPDATE events SET data_json=json_set(data_json,'$.ownerKind',json('{"toString":"invalid"}')) WHERE seq=3002`);
      if (variant === 'object-outcome') db.exec(`UPDATE events SET data_json=json_set(data_json,'$.outcome',json('{"toString":"invalid"}')) WHERE seq=3002`);
      if (variant === 'nonboolean-journal') db.exec("UPDATE events SET data_json=json_set(data_json,'$.journalFailed','false') WHERE seq=3002");
      if (variant === 'missing-parser-model') db.exec("UPDATE events SET data_json=json_remove(data_json,'$.providerReportedModel') WHERE seq=3012");
      if (variant === 'persisted-after-delivery') db.prepare('UPDATE events SET created_at=? WHERE seq=3002').run(fixture.at(150));
      if (variant === 'attempt-ended-early') db.prepare('UPDATE run_attempts SET finished_at=? WHERE attempt_id=?').run(fixture.at(1), 'adapter-attempt');
      if (variant === 'missing-attempt-bound') db.exec("UPDATE run_attempts SET finished_at=NULL WHERE attempt_id='adapter-attempt'");
      if (variant === 'contradictory-result') db.exec("UPDATE events SET data_json=json_set(data_json,'$.providerReportedModel','different-actual') WHERE seq=3013");
      if (variant === 'duplicate-result') seedSession(db, 'adapter-task', [fixture.event(3016, 16, 'parsed', { phase: 'model_result_completed',
        resultScope: 'owned_systemone_parser', outcome: 'returned', dispatchIds: ['wire-parsed'], usage: 'reported',
        remoteSettlement: 'parsed_response', providerReportedModel: 'systemone-actual', hostResultReceiptId: 'extra-result' })]);
      if (variant === 'wrong-result-scope') db.exec("UPDATE events SET data_json=json_set(data_json,'$.resultScope','original_sdk_response') WHERE seq=3013");
      if (variant === 'reused-result-receipt') seedSession(db, 'adapter-task', [fixture.event(3016, 16, 'other-call', { phase: 'model_result_completed',
        resultScope: 'owned_systemone_parser', outcome: 'returned', dispatchIds: ['other-wire'], usage: 'reported',
        remoteSettlement: 'parsed_response', providerReportedModel: 'systemone-actual', hostResultReceiptId: 'parser-receipt' })]);
      db.close();
      const measured = measureAcceptedTask(fixture.home, 'adapter-task', 3000); const local = measured.transportObservation!.localAdapterAttempts!;
      // Duplicate original response identity is a usage gap even with closed local endpoints.
      if (variant !== 'digest-reused') assert.equal(local.status, 'incomplete', variant);
      assert.ok(local.exactReportedUsageJoins! < 2, variant);
      assert.equal(measured.promptTokens, 50); assert.equal(measured.taskWallMs, 100);
      assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
      if (variant === 'after-delivery' || variant === 'persisted-after-delivery') assert.equal(local.afterDeliveryEvents, 1);
    } finally { rmSync(fixture.home, { recursive: true, force: true }); }
  }
});

test('SDK original wire result can precede the distinct local returned endpoint without merging their meanings', () => {
  const fixture = localAdapterFixture();
  try {
    const db = new Database(fixture.dbPath);
    db.prepare("UPDATE events SET seq=3028,created_at=?,data_json=json_set(data_json,'$.at',?,'$.dispatchIds',json('[\"sdk-wire\"]')) WHERE seq=3002").run(fixture.at(28), fixture.epoch + 28);
    seedSession(db, 'adapter-task', [
      fixture.event(3016, 16, 'sdk-ok', { phase: 'dispatch_started', transport: 'raw_claude_messages', dispatchId: 'sdk-wire', wireSubattempt: 1, late: false }),
      fixture.event(3017, 17, 'sdk-ok', { phase: 'headers_received', transport: 'raw_claude_messages', dispatchId: 'sdk-wire', wireSubattempt: 1, status: 200, ok: true, late: false }),
      fixture.event(3018, 18, 'sdk-ok', { phase: 'model_result_completed', resultScope: 'original_sdk_response',
        hostResultReceiptId: 'sdk-receipt', dispatchIds: ['sdk-wire'], providerResponseIdDigest: createHash('sha256').update('provider-ok').digest('hex') }),
    ]); db.close();
    const measured = measureAcceptedTask(fixture.home, 'adapter-task', 3000); const local = measured.transportObservation!.localAdapterAttempts!;
    assert.equal(local.status, 'observed_local_endpoints'); assert.equal(local.exactReportedUsageJoins, 2);
    assert.equal(measured.transportObservation!.observedDispatches, 2); assert.equal(measured.promptTokens, 50);
    assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('detached accounting parent keeps its whole local namespace without claiming the job or credit bucket is billing authority', () => {
  const fixture = localAdapterFixture();
  try {
    const db = new Database(fixture.dbPath);
    db.exec("UPDATE events SET data_json=json_set(data_json,'$.ownerKind','accounting_parent','$.usageJobId','memory-job') WHERE type='model_transport_observed'");
    db.close();
    const local = measureAcceptedTask(fixture.home, 'adapter-task', 3000).transportObservation!.localAdapterAttempts!;
    assert.equal(local.status, 'observed_local_endpoints'); assert.equal(local.exactReportedUsageJoins, 2);
    assert.equal(local.accountAndBackendAuthority, 'unproved'); assert.equal(local.publicInvocationCoverage, 'unproved');
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test('usage joins require the original same-call tuple, unique row, reported model and successful accounting', () => {
  for (const variant of ['foreign-source', 'foreign-call', 'model-mismatch', 'duplicate-row', 'failed-placeholder', 'second-ordinal'] as const) {
    const fixture = localAdapterFixture();
    try {
      const lines = readFileSync(fixture.usageFile, 'utf8').trim().split('\n');
      const rows = lines.map(line => { try { return JSON.parse(line); } catch { return undefined; } });
      const row = rows.find(item => item?.trace?.modelCallId === 'parsed');
      if (variant === 'foreign-source') row.trace.acceptedSource = 'adapter-task:499';
      if (variant === 'foreign-call') row.trace.modelCallId = 'different-call';
      if (variant === 'model-mismatch') row.providerReportedModel = 'configured-only';
      if (variant === 'duplicate-row') rows.push(row);
      if (variant === 'failed-placeholder') { row.ok = false; row.inputTokens = 0; row.outputTokens = 0; row.cacheDialect = 'unknown'; }
      if (variant === 'second-ordinal') {
        const db = new Database(fixture.dbPath);
        seedSession(db, 'adapter-task', [
          fixture.event(3016, 16, 'parsed', { physicalAttempt: 2, phase: 'adapter_attempt_created', resultScope: 'local_adapter_attempt', dispatchIds: [] }),
          fixture.event(3017, 17, 'parsed', { physicalAttempt: 2, phase: 'adapter_attempt_finished', outcome: 'returned',
            resultScope: 'owned_systemone_parser', dispatchIds: [], usage: 'reported', remoteSettlement: 'parsed_response', providerReportedModel: 'systemone-actual' }),
        ]); db.close();
      }
      writeFileSync(fixture.usageFile, rows.map((item, index) => item === undefined ? lines[index] : JSON.stringify(item)).join('\n') + '\n');
      const measured = measureAcceptedTask(fixture.home, 'adapter-task', 3000);
      assert.equal(measured.transportObservation!.localAdapterAttempts!.exactReportedUsageJoins, 1, variant);
      assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
    } finally { rmSync(fixture.home, { recursive: true, force: true }); }
  }
});

test('private memory payload is redacted before JS decoding while event metadata and malformed counters stay visible', () => {
  const fixture = localAdapterFixture();
  try {
    const db = new Database(fixture.dbPath);
    seedSession(db, 'adapter-task', [
      { seq: 3020, type: 'guardrail_tripped', at: fixture.at(20), data: { kind: 'model_memory_context', privateText: 'must-not-enter-measurement', sourceUserSeq: 3000 } },
      { seq: 3021, type: 'guardrail_tripped', at: fixture.at(21), data: { kind: 'ordinary_guardrail' } },
      { seq: 3022, type: 'guardrail_tripped', at: fixture.at(22) },
    ]);
    db.exec("UPDATE events SET data_json='{malformed' WHERE seq=3022"); db.close();
    const originalParse = JSON.parse; let privateDecoded = false;
    JSON.parse = ((text: string, ...args: unknown[]) => {
      if (text.includes('must-not-enter-measurement')) privateDecoded = true;
      return Reflect.apply(originalParse, JSON, [text, ...args]);
    }) as typeof JSON.parse;
    try {
      const session = measureSession(fixture.home, 'adapter-task');
      const task = measureAcceptedTask(fixture.home, 'adapter-task', 3000);
      assert.equal(privateDecoded, false); assert.equal(session.malformedEventPayloads, 1);
      assert.equal(task.promptTokens, 50); assert.equal(task.taskWallMs, 100);
      assert.equal(task.transportObservation!.localAdapterAttempts!.createdAttempts, 6);
      assert.equal(session.turnWallMs, 100); assert.equal(session.terminalType, 'conversation_completed');
    } finally { JSON.parse = originalParse; }
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

// Use the actual native producer, nominal original-response binder, host
// observation sinks and ledger writer. Only the protected provider stream is
// scripted; no telemetry or usage row is reconstructed from expected fields.
class AccountingCodexModel extends CodexResponsesModel {
  attempts = 0;
  constructor(private readonly script: (attempt: number) => AsyncGenerator<any>) {
    super('gpt-6.1-sol');
  }
  protected async *streamCodex(_request: ModelRequest): AsyncGenerator<any> {
    yield* this.script(++this.attempts);
  }
}

async function* accountingCodexSuccess(responseId: string, reportedModel: string | null = 'gpt-6.1-sol') {
  yield { type: 'response.created', response: { id: responseId } };
  yield { type: 'response.output_text.delta', delta: 'Synthetic accounting answer.', sequence_number: 1 };
  yield { type: 'response.output_item.done', item: {
    id: `message-${responseId}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'Synthetic accounting answer.' }],
  } };
  yield { type: 'response.completed', response: { id: responseId,
    ...(reportedModel === null ? {} : { model: reportedModel }),
    usage: { input_tokens: 40, output_tokens: 4, total_tokens: 44,
      input_tokens_details: { cached_tokens: 12 }, output_tokens_details: {} },
  } };
}

function nativeCodexAccountingFixture() {
  assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1', 'native stores require the isolated test launcher');
  assert.notEqual(path.resolve(BASE_DIR), REAL_DEFAULT_CLEMENTINE_HOME);
  const sessionId = `canonical-native-codex-${randomUUID()}`;
  createSession({ id: sessionId, kind: 'chat', channel: 'test' });
  const attempt = beginRunAttempt(sessionId);
  const source = recordRunAttemptUserInput(attempt, { turn: 1, role: 'user',
    data: { text: 'Synthetic native Codex accounting fixture.' } });
  return { home: BASE_DIR, sessionId, attempt, source, ordinal: 0 };
}

type NativeCodexAccountingFixture = ReturnType<typeof nativeCodexAccountingFixture>;

function nativeCodexAccountingRows(fixture: NativeCodexAccountingFixture) {
  const file = usageFileForDate(new Date(fixture.source.createdAt));
  return parseUsageLedger(readFileSync(file, 'utf8')).filter(row =>
    row.trace?.acceptedSource === `${fixture.sessionId}:${fixture.source.seq}`);
}

async function nativeCodexAccountingCall(fixture: NativeCodexAccountingFixture, model: AccountingCodexModel,
  mode: 'buffered' | 'streamed' | 'interrupted' = 'buffered'): Promise<unknown> {
  const ordinal = ++fixture.ordinal;
  const observation = createModelResilienceObservation({
    owner: { sessionId: fixture.sessionId, sourceUserSeq: fixture.source.seq, runAttemptId: fixture.attempt.attemptId },
    requestOrdinal: () => ordinal, retired: () => false,
  });
  const request = { input: 'Synthetic native Codex accounting fixture.', tools: [], handoffs: [],
    modelSettings: {}, outputType: 'text', tracing: false } as unknown as ModelRequest;
  const invoke = <T>(work: () => T): T => withModelTransportRecorder(data => {
    appendEvent({ sessionId: fixture.sessionId, turn: 1, role: 'system', type: 'model_transport_observed', data: { ...data } });
  }, () => withModelUsageAttribution({ sessionId: fixture.sessionId, sourceUserSeq: fixture.source.seq,
    attemptId: fixture.attempt.attemptId, role: 'brain', channel: 'test:native-codex' }, () =>
    harnessRunContextStorage.run({ sessionId: fixture.sessionId, sourceUserSeq: fixture.source.seq,
      runAttemptId: fixture.attempt.attemptId, turn: 1 } as never, () =>
      withModelResilienceTelemetry(observation.observer, work))));
  let outcome: 'returned' | 'failed' | 'cancelled' = 'failed';
  try {
    if (mode === 'buffered') {
      const response = await invoke(() => model.getResponse(request));
      outcome = 'returned';
      return response;
    }
    const stream = invoke(() => model.getStreamedResponse(request));
    if (mode === 'interrupted') {
      const iterator = stream[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).done, false);
      await iterator.return?.();
      outcome = 'cancelled';
      return undefined;
    }
    let original: unknown;
    for await (const event of stream) if (event.type === 'response_done') original = event.response;
    assert.ok(original, 'the native stream must yield its original response_done object');
    outcome = 'returned';
    return original;
  } finally { observation.close(outcome); }
}

function finishNativeCodexAccountingFixture(fixture: NativeCodexAccountingFixture, cancelled = false) {
  const data = typedTerminal(fixture.sessionId, fixture.source.seq, 1);
  if (cancelled) {
    data.presentation = { ...(data.presentation as Record<string, unknown>), status: 'cancelled', kind: 'stopped' };
    data.turnOutcome = { ...(data.turnOutcome as Record<string, unknown>), status: 'cancelled' };
  }
  appendEvent({ sessionId: fixture.sessionId, turn: 1, role: 'assistant', type: 'conversation_completed',
    data: { ...data, attemptId: fixture.attempt.attemptId } });
  finishRunAttempt(fixture.attempt, cancelled ? 'cancelled' : 'completed');
  return measureAcceptedTask(fixture.home, fixture.sessionId, fixture.source.seq);
}

test('native Codex producer feeds canonical original-call accounting without inventing wire, model or billing proof', async t => {
  const priorDelay = process.env.CLEMMY_CODEX_TRANSPARENT_RETRY_DELAY_MS;
  process.env.CLEMMY_CODEX_TRANSPARENT_RETRY_DELAY_MS = '0';
  try {
    for (const mode of ['buffered', 'streamed'] as const) await t.test(mode, async () => {
      const fixture = nativeCodexAccountingFixture();
      const model = new AccountingCodexModel(() => accountingCodexSuccess(`provider-${mode}`));
      const original = await nativeCodexAccountingCall(fixture, model, mode);
      const binding = completedModelResponseBinding(original)!;
      assert.ok(binding); assert.equal(completedModelResponseBinding({ ...(original as object) }), undefined);
      const rows = nativeCodexAccountingRows(fixture);
      assert.equal(rows.length, 1); assert.equal(rows[0].trace?.modelCallId, binding.modelCallId);
      assert.notEqual(rows[0].responseId, binding.modelCallId); assert.equal(binding.physicalAttempt, 1);
      assert.equal(rows[0].providerReportedModel, 'gpt-6.1-sol');
      assert.equal(rows[0].requestModel, undefined, 'scripted protected streams did not execute the actual outgoing-body constructor');
      const measured = finishNativeCodexAccountingFixture(fixture);
      assert.equal(measured.usageCompleteness.mainProducerCoverage.status, 'observed_completed_calls');
      assert.equal(measured.usageCompleteness.mainProducerCoverage.responseBoundCalls, 1);
      assert.equal(measured.promptTokens, 40); assert.equal(measured.cachedInputTokens, 12);
      assert.equal(measured.outputTokens, 4);
      const transport = measured.transportObservation!, local = transport.localAdapterAttempts!;
      assert.equal(local.createdAttempts, 1); assert.equal(local.originalSdkIdentities, 1);
      assert.equal(local.exactReportedUsageJoins, 1); assert.equal(local.noObservedDispatchAttempts, 1);
      assert.equal(transport.observedDispatches, null, 'a local SDK original is not a physical HTTP dispatch census');
      assert.equal(transport.allLegPhysicalInventory, 'unproved');
      assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
      assert.equal(measured.usageCompleteness.identityGaps.billedAccountRows, 1);
      assert.equal(measured.usageCompleteness.identityGaps.backendRows, 1);
      assert.equal(measured.usageCompleteness.cost.actualBilling, 'not_measured');
    });
    await t.test('missing reported model does not borrow the selected model', async () => {
      const fixture = nativeCodexAccountingFixture();
      await nativeCodexAccountingCall(fixture, new AccountingCodexModel(() => accountingCodexSuccess('provider-model-unknown', null)));
      const rows = nativeCodexAccountingRows(fixture);
      assert.equal(rows[0].model, 'gpt-6.1-sol'); assert.equal(rows[0].providerReportedModel, undefined);
      const measured = finishNativeCodexAccountingFixture(fixture);
      assert.equal(measured.usageCompleteness.mainProducerCoverage.responseBoundCalls, 1);
      assert.equal(measured.usageCompleteness.identityGaps.providerReportedModelRows, 1);
      assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
    });
    await t.test('transparent retry preserves unknown failed-attempt usage', async () => {
      const fixture = nativeCodexAccountingFixture();
      const model = new AccountingCodexModel(async function* (attempt) {
        if (attempt === 1) yield { type: 'response.created', response: { id: 'provider-truncated' } };
        else yield* accountingCodexSuccess('provider-retried');
      });
      const original = await nativeCodexAccountingCall(fixture, model);
      assert.equal(model.attempts, 2); assert.equal(completedModelResponseBinding(original)?.physicalAttempt, 2);
      const measured = finishNativeCodexAccountingFixture(fixture);
      assert.equal(measured.promptTokens, 40); assert.equal(measured.usageRecords, 1);
      assert.equal(measured.usageCompleteness.mainProducerCoverage.status, 'incomplete');
      assert.equal(measured.usageCompleteness.mainProducerCoverage.responseBoundCalls, 0);
      const local = measured.transportObservation!.localAdapterAttempts!;
      assert.equal(local.createdAttempts, 2); assert.equal(local.failedAttempts, 1);
      assert.equal(local.unknownUsageAttempts, 1); assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
    });
    await t.test('consumer interruption remains a cancelled local attempt with no completed original', async () => {
      const fixture = nativeCodexAccountingFixture();
      await nativeCodexAccountingCall(fixture, new AccountingCodexModel(() => accountingCodexSuccess('provider-interrupted')), 'interrupted');
      const measured = finishNativeCodexAccountingFixture(fixture, true);
      assert.equal(measured.usageRecords, 0); assert.equal(measured.terminalStatus, 'cancelled');
      assert.equal(measured.usageCompleteness.mainProducerCoverage.responseBoundCalls, 0);
      const local = measured.transportObservation!.localAdapterAttempts!;
      assert.equal(local.cancelledAttempts, 1); assert.equal(local.originalSdkIdentities, 0);
      assert.equal(local.unknownUsageAttempts, 1); assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
    });
    await t.test('concurrent separate owners sharing a provider ID retain distinct local UUIDs', async () => {
      const a = nativeCodexAccountingFixture(), b = nativeCodexAccountingFixture();
      const originals = await Promise.all([a, b].map(fixture => nativeCodexAccountingCall(fixture,
        new AccountingCodexModel(() => accountingCodexSuccess('provider-shared-cross-task')))));
      assert.notEqual(completedModelResponseBinding(originals[0])?.modelCallId, completedModelResponseBinding(originals[1])?.modelCallId);
      for (const [index, fixture] of [a, b].entries()) {
        const rows = nativeCodexAccountingRows(fixture);
        assert.equal(rows.length, 1); assert.equal(rows[0].trace?.attemptId, fixture.attempt.attemptId);
        assert.equal(rows[0].trace?.modelCallId, completedModelResponseBinding(originals[index])?.modelCallId);
        const measured = finishNativeCodexAccountingFixture(fixture);
        assert.equal(measured.promptTokens, 40); assert.equal(measured.usageCompleteness.mainProducerCoverage.responseBoundCalls, 1);
        assert.equal(measured.transportObservation!.localAdapterAttempts!.exactReportedUsageJoins, 1);
      }
    });
    await t.test('same-owner duplicate provider IDs retain both invocations but cannot prove unique provider usage', async () => {
      const fixture = nativeCodexAccountingFixture();
      const originals = await Promise.all([1, 2].map(() => nativeCodexAccountingCall(fixture,
        new AccountingCodexModel(() => accountingCodexSuccess('provider-shared-same-task')))));
      const callIds = originals.map(original => completedModelResponseBinding(original)!.modelCallId);
      assert.equal(new Set(callIds).size, 2);
      const rows = nativeCodexAccountingRows(fixture);
      assert.equal(rows.length, 2); assert.equal(new Set(rows.map(row => row.trace?.modelCallId)).size, 2);
      const measured = finishNativeCodexAccountingFixture(fixture);
      assert.equal(measured.promptTokens, 80); assert.equal(measured.outputTokens, 8);
      assert.equal(measured.usageCompleteness.mainProducerCoverage.observedCalls, 2);
      assert.equal(measured.usageCompleteness.mainProducerCoverage.responseBoundCalls, 2, 'local invocation membership is distinct from provider physical uniqueness');
      const transport = measured.transportObservation!, local = transport.localAdapterAttempts!;
      assert.equal(local.createdAttempts, 2);
      assert.equal(local.originalSdkIdentities, 0, 'a reused provider digest cannot certify two unique provider identities');
      assert.equal(local.exactReportedUsageJoins, 0); assert.equal(local.unknownUsageAttempts, 2);
      assert.equal(transport.observedDispatches, null); assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
      assert.ok(listEvents(fixture.sessionId).filter(event => event.type === 'model_resilience_observed')
        .every(event => event.data.sourceUserSeq === fixture.source.seq));
      assert.equal(listEvents(fixture.sessionId).filter(event => event.type === 'model_transport_observed'
        && event.data.phase === 'adapter_attempt_finished' && event.data.resultScope === 'original_sdk_response').length, 2,
      'both original local outcomes remain visible despite ambiguous provider identity');
    });
  } finally {
    if (priorDelay === undefined) delete process.env.CLEMMY_CODEX_TRANSPARENT_RETRY_DELAY_MS;
    else process.env.CLEMMY_CODEX_TRANSPARENT_RETRY_DELAY_MS = priorDelay;
    closeEventLog();
  }
});

// The actual durable producer restores bookkeeping only. A scripted native
// response runs under the drainer's existing harness, with no forced-A sink,
// reconstructed telemetry, restored source authority or model-route override.
function durableNativeCodexAccountingFixture(mode: 'owned' | 'source-only' | 'legacy' = 'owned') {
  assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1');
  assert.notEqual(path.resolve(BASE_DIR), REAL_DEFAULT_CLEMENTINE_HOME);
  const sessionId = `canonical-durable-codex-${randomUUID()}`;
  const message = 'Remember exactly: "Use short paragraphs for future reports."';
  createSession({ id: sessionId, kind: 'chat', channel: 'test' });
  const attempt = beginRunAttempt(sessionId);
  const source = recordRunAttemptUserInput(attempt, { turn: 1, role: 'user', data: { text: message } });
  assert.ok(captureFreshSourceSessionContext({ sessionId, sourceUserSeq: source.seq }));
  const candidates = extractAutoMemoryCandidates(message);
  assert.equal(candidates.length, 1);
  const origins = automaticMemoryOriginsForCapture({ sessionId, message, sourceEventId: `user-source:${source.seq}`,
    sourceProvenance: autoCaptureProvenanceFromAcceptedEvent(source) }, candidates);
  assert.equal(origins[0]?.claimMode, 'complete');
  const input = { sessionId, message, sourceEventId: `user-source:${source.seq}`, candidates, origins };
  const parent = { sessionId, sourceUserSeq: source.seq, attemptId: attempt.attemptId };
  const queued = mode === 'source-only' ? enqueueAutoCaptureCandidates(input)
    : withModelUsageAttribution(parent, () => enqueueAutoCaptureCandidates(input));
  assert.equal(queued.candidateIds.length, 1);
  const candidateId = queued.candidateIds[0]!;
  if (mode === 'legacy') openMemoryDb().prepare('DELETE FROM memory_candidate_accounting_origins WHERE candidate_id = ?').run(candidateId);
  closeMemoryDb();
  const retained = memoryAccountingParent(readMemoryCandidateAccountingOrigin(candidateId, openMemoryDb()));
  assert.deepEqual(retained, mode === 'owned' ? parent : { sessionId, sourceUserSeq: source.seq });
  return { home: BASE_DIR, sessionId, source, attempt, ordinal: 0, input, candidateId, retained };
}

test('durable memory native Codex producer keeps original scheduling accounting through replay without restoring execution authority', async t => {
  try {
    for (const kind of ['foreign', 'same-source', 'source-only', 'legacy', 'late', 'failed'] as const) {
      await t.test(kind, async () => {
        const mode = kind === 'source-only' || kind === 'legacy' ? kind : 'owned';
        const a = durableNativeCodexAccountingFixture(mode);
        const b = kind === 'same-source' || kind === 'source-only' || kind === 'legacy'
          ? { ...a, attempt: beginRunAttempt(a.sessionId) } : nativeCodexAccountingFixture();
        if (b.sessionId === a.sessionId) {
          const bound = recordRunAttemptUserInput(b.attempt, { turn: 1, role: 'user', data: a.source.data }, { existingEventSeq: a.source.seq });
          assert.equal(bound.seq, a.source.seq);
        }
        const bScope = { sessionId: b.sessionId, sourceUserSeq: b.source.seq, attemptId: b.attempt.attemptId };
        const retainedBefore = openMemoryDb().prepare('SELECT * FROM memory_candidate_accounting_origins WHERE candidate_id = ?').get(a.candidateId);
        withModelUsageAttribution(bScope, () => enqueueAutoCaptureCandidates(a.input));
        assert.deepEqual(openMemoryDb().prepare('SELECT * FROM memory_candidate_accounting_origins WHERE candidate_id = ?').get(a.candidateId), retainedBefore,
          'duplicate intake cannot fill legacy ownership or replace the original scheduling attempt');
        closeMemoryDb();
        if (kind === 'late') {
          finishNativeCodexAccountingFixture(a);
          await new Promise(resolve => setTimeout(resolve, 2));
        }
        const responseId = `provider-durable-${kind}-${randomUUID()}`;
        const model = new AccountingCodexModel(kind === 'failed' ? async function* () {
          throw new Error('Synthetic nonretryable native accounting failure.');
        } : () => accountingCodexSuccess(responseId));
        let original: unknown;
        let calls = 0;
        const result = await harnessRunContextStorage.run({ sessionId: b.sessionId, sourceUserSeq: b.source.seq,
          runAttemptId: b.attempt.attemptId, turn: 1 } as never, () => withModelUsageAttribution(bScope, () =>
          drainDurableConsolidationCandidates({ ids: [a.candidateId], standingReviewer: async (_source, _candidate, _mode, origin) => {
            assert.ok(origin);
            return runMemoryModelJob('standing', {}, async () => {
              calls++;
              assert.equal(harnessRunContextStorage.getStore()?.sessionId, b.sessionId);
              assert.equal(harnessRunContextStorage.getStore()?.runAttemptId, b.attempt.attemptId,
                'the actual provider work never runs under restored harness A');
              const usage = modelUsageAttributionStorage.getStore()!;
              assert.equal(usage.sessionId, ''); assert.equal(usage.sourceUserSeq, 0);
              assert.deepEqual(usage.usageParentTurn, a.retained);
              assert.match(usage.usageJobId!, /^memory:standing:/);
              const selected = inMemoryJobTurn(() => modelUsageAttributionStorage.getStore());
              assert.equal(selected?.sessionId, b.sessionId === a.sessionId ? a.sessionId : '');
              assert.equal(selected?.sourceUserSeq, b.sessionId === a.sessionId ? a.source.seq : 0);
              if (b.sessionId === a.sessionId) assert.equal(selected?.attemptId, b.attempt.attemptId,
                'same-source re-drive retains current selection B, independently of accounting A');
              original = await model.getResponse({ input: 'Synthetic memory accounting response.', tools: [], handoffs: [],
                modelSettings: {}, outputType: 'text', tracing: false } as unknown as ModelRequest);
              return parseAutomaticStandingMemoryReview({ durability: 'task', claim: origin.claim,
                destination: 'unresolved', destinationSpans: [], reason: 'Controlled accounting fixture only.' }, origin);
            }, () => ({ outcome: 'nothing_new' }));
          } })));
        assert.equal(calls, 1); assert.equal(model.attempts, 1);
        assert.equal(result.promoted, 0, 'this accounting test does not promote a standing memory');
        assert.equal(kind === 'failed' ? result.retried : result.skipped, 1);
        const file = usageFileForDate(new Date(a.source.createdAt));
        const allRows = (() => { try { return parseUsageLedger(readFileSync(file, 'utf8')); } catch { return []; } })();
        const rows = allRows.filter(row => row.responseId === responseId);
        const events = listEvents(a.sessionId).filter(event => event.type === 'model_transport_observed'
          && event.data.sourceUserSeq === a.source.seq);
        assert.equal(events.filter(event => event.data.phase === 'adapter_attempt_created').length, 1);
        if (kind === 'failed') {
          assert.equal(rows.length, 0); assert.equal(original, undefined);
          assert.equal(events.find(event => event.data.phase === 'adapter_attempt_finished')?.data.outcome, 'failed');
        } else {
          const binding = completedModelResponseBinding(original)!;
          assert.ok(binding); assert.equal(binding.physicalAttempt, 1);
          assert.equal(rows.length, 1); assert.equal(rows[0].trace?.modelCallId, binding.modelCallId);
          assert.notEqual(rows[0].responseId, binding.modelCallId);
          assert.equal(rows[0].trace?.acceptedSource, `${a.sessionId}:${a.source.seq}`);
          assert.equal(rows[0].trace?.attemptId, mode === 'owned' ? a.attempt.attemptId : undefined);
          assert.match(rows[0].source, /^memory:standing:/); assert.equal(rows[0].role, 'memory');
          assert.equal(rows[0].requestModel, undefined, 'scripted transport does not prove an actual outgoing body');
          assert.equal(rows[0].providerReportedModel, 'gpt-6.1-sol');
          assert.ok(events.every(event => event.data.modelCallId === binding.modelCallId));
        }
        const measured = kind === 'late' ? measureAcceptedTask(a.home, a.sessionId, a.source.seq)
          : finishNativeCodexAccountingFixture(a);
        finishRunAttempt(b.attempt, 'completed');
        const local = measured.transportObservation!.localAdapterAttempts!;
        if (mode === 'owned' && kind !== 'failed') {
          assert.equal(measured.promptTokens, 40); assert.equal(measured.outputTokens, 4);
          assert.equal(measured.exactUsageRecords, 1);
          assert.equal(local.exactReportedUsageJoins, kind === 'late' || kind === 'same-source' ? 0 : 1);
          if (kind === 'late') assert.ok(local.afterDeliveryEvents > 0, 'post-delivery endpoints cannot borrow the foreground clock');
          if (kind === 'same-source') assert.ok(local.issues.some(issue => issue.startsWith('unbounded_local_adapter_endpoint:')),
            'starting B closes A; correct accounting association cannot widen A foreground attempt bounds');
        } else if (kind === 'failed') {
          assert.equal(measured.usageRecords, 0); assert.equal(local.failedAttempts, 1);
          assert.equal(local.unknownUsageAttempts, 1); assert.equal(local.exactReportedUsageJoins, 0);
        } else {
          assert.equal(measured.exactUsageRecords, 0);
          assert.equal(measured.unprovenUsage.usageRecords, 1);
          assert.equal(local.exactReportedUsageJoins, 0);
          assert.ok(local.issues.some(issue => issue.startsWith('invalid_local_adapter_ownership:')));
        }
        assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
        assert.equal(measured.transportObservation!.observedDispatches, null);
        assert.equal(measured.transportObservation!.allLegPhysicalInventory, 'unproved');
        assert.equal(measured.usageCompleteness.cost.actualBilling, 'not_measured');
      });
    }
  } finally { closeMemoryDb(); closeEventLog(); }
});


// actual BYO SDK/resilience and ordinary event/usage
// writers feed the unchanged canonical reducer. No model telemetry is seeded.
test('BYO nominal producer feeds canonical single-invocation membership while empty capture remains unknown', async t => {
  const { getByoModel, resetByoModelCache } = await import('../src/runtime/harness/byo-model.js');
  const transportApi = await import('../src/runtime/harness/model-transport-observation.js');
  const parity = process.env.CLEMMY_MODEL_PARITY; process.env.CLEMMY_MODEL_PARITY = 'on';
  let responseId = '', retire = false;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.ok(String(url).startsWith('https://canonical-byo-fixture.invalid/'), 'all wire work must terminate at this fake');
    const sent = JSON.parse(String(init?.body)); assert.equal(sent.model, 'glm-5.3');
    if (retire) {
      const captured = transportApi.captureActiveModelTransportUsage(); assert.ok(captured);
      assert.ok(captured.attempt); transportApi.finishModelTransportAttempt(captured.attempt, 'cancelled');
    }
    const usage = { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 80 } };
    const result = { id: responseId, object: 'chat.completion', created: 1, model: 'glm-5.2', usage,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic accounting answer.' } }] };
    if (!sent.stream) return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
    const chunk = { ...result, object: 'chat.completion.chunk', choices: [{ index: 0,
      delta: { role: 'assistant', content: 'Synthetic accounting answer.' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    for (const mode of ['buffered', 'streamed', 'foreign-drain', 'retired', 'empty'] as const) await t.test(mode, async () => {
      const fixture = nativeCodexAccountingFixture(); responseId = `canonical-byo-${mode}-${randomUUID()}`; retire = mode === 'retired';
      const model = getByoModel('glm-5.3', { configured: true, baseURL: 'https://canonical-byo-fixture.invalid/v1',
        apiKey: 'synthetic-no-auth', providerId: 'zai', primaryId: 'glm-5.3', judgeId: 'glm-5.3' });
      // Keep one ordinal for the actual invocation; no phases are authored.
      fixture.ordinal = 1;
      const stableObservation = createModelResilienceObservation({
        owner: { sessionId: fixture.sessionId, sourceUserSeq: fixture.source.seq, runAttemptId: fixture.attempt.attemptId },
        requestOrdinal: () => fixture.ordinal, retired: () => false,
      });
      const request = { input: 'Synthetic accounting answer.', tools: [], handoffs: [], modelSettings: {}, outputType: 'text', tracing: false } as unknown as ModelRequest;
      const execute = async () => harnessRunContextStorage.run({ sessionId: fixture.sessionId,
        sourceUserSeq: fixture.source.seq, runAttemptId: fixture.attempt.attemptId, turn: 1 } as never, () =>
        withModelResilienceTelemetry(stableObservation.observer, async () => {
          if (mode === 'foreign-drain') return model.getStreamedResponse(request);
          if (mode !== 'streamed') return model.getResponse(request);
          let original: unknown;
          for await (const event of model.getStreamedResponse(request)) if (event.type === 'response_done') original = event.response;
          assert.ok(original); return original;
        }));
      let original: unknown;
      try {
        original = await withModelTransportRecorder(data => appendEvent({ sessionId: fixture.sessionId, turn: 1,
          role: 'system', type: 'model_transport_observed', data: { ...data } }), () => mode === 'empty'
          ? modelUsageAttributionStorage.run({ sessionId: 'unknown', sourceUserSeq: 0 }, execute)
          : withModelUsageAttribution({ sessionId: fixture.sessionId, sourceUserSeq: fixture.source.seq,
              attemptId: fixture.attempt.attemptId, role: 'brain', channel: 'test:byo-accounting' }, execute));
        if (mode === 'foreign-drain') {
          const foreign = nativeCodexAccountingFixture();
          try {
            original = await withModelUsageAttribution({ sessionId: foreign.sessionId, sourceUserSeq: foreign.source.seq,
              attemptId: foreign.attempt.attemptId, role: 'brain' }, () => harnessRunContextStorage.run({ sessionId: foreign.sessionId,
              sourceUserSeq: foreign.source.seq, runAttemptId: foreign.attempt.attemptId } as never, async () => {
                let response: unknown;
                for await (const event of original as AsyncIterable<{ type: string; response?: unknown }>) if (event.type === 'response_done') response = event.response;
                return response;
              }));
            assert.equal(nativeCodexAccountingRows(foreign).length, 0);
          } finally { finishRunAttempt(foreign.attempt, 'completed'); }
        }
      } finally { stableObservation.close('returned'); }
      const binding = completedModelResponseBinding(original); assert.ok(binding);
      const recorded = parseUsageLedger(readFileSync(usageFileForDate(new Date(fixture.source.createdAt)), 'utf8'))
        .filter(row => row.responseId === responseId);
      assert.equal(recorded.length, 1); const [row] = recorded;
      assert.equal(row.inputTokens, 100); assert.equal(row.cachedInputTokens, 80); assert.equal(row.outputTokens, 7);
      assert.equal(row.responseId, responseId); assert.equal(row.providerReportedModel, 'glm-5.2'); assert.equal(row.account, undefined);
      const measured = finishNativeCodexAccountingFixture(fixture);
      assert.equal(measured.usageCompleteness.mainProducerCoverage.observedCalls, 1);
      if (mode === 'buffered' || mode === 'streamed' || mode === 'foreign-drain') {
        assert.equal(row.trace?.modelCallId, binding.modelCallId); assert.notEqual(row.responseId, binding.modelCallId);
        assert.equal(measured.usageCompleteness.mainProducerCoverage.responseBoundCalls, 1);
        assert.equal(measured.promptTokens, 100); assert.equal(measured.cachedInputTokens, 80); assert.equal(measured.outputTokens, 7);
      } else {
        assert.equal(row.trace?.modelCallId, undefined);
        assert.equal(measured.usageCompleteness.mainProducerCoverage.responseBoundCalls, 0);
        assert.equal(measured.usageCompleteness.mainProducerCoverage.status, 'incomplete');
        if (mode === 'retired') assert.equal(row.trace?.attemptId, fixture.attempt.attemptId);
        else { assert.equal(row.source, 'byo:unowned'); assert.equal(row.trace?.acceptedSource, undefined); }
      }
      assert.equal(measured.usageCompleteness.allLegUsageCertified, false);
      assert.equal(measured.usageCompleteness.cost.actualBilling, 'not_measured');
      assert.equal(measured.transportObservation!.allLegPhysicalInventory, 'unproved');
    });
  } finally {
    resetByoModelCache(); t.mock.restoreAll();
    if (parity === undefined) delete process.env.CLEMMY_MODEL_PARITY; else process.env.CLEMMY_MODEL_PARITY = parity;
    closeEventLog();
  }
});
