import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

const TEST_HOME = '/tmp/clemmy-test-turn-graph-shadow';
process.env.CLEMENTINE_HOME = TEST_HOME;

const {
  appendEvent,
  createSession,
  HARNESS_DB_PATH,
  listEvents,
  resetEventLog,
} = await import('../harness/eventlog.js');
const {
  listOperationalEvents,
  resetOperationalTelemetryForTest,
} = await import('../operational-telemetry.js');
const { projectHarnessEventForPublic } = await import('../harness/public-presentation.js');
const { actionBus } = await import('../action-bus.js');
const { recordTurnGraphShadow } = await import('./turn-graph-shadow.js');

beforeEach(() => {
  delete process.env.CLEMMY_EVENTLOG_OPERATIONAL_MIRROR;
  resetEventLog();
  resetOperationalTelemetryForTest();
});

after(() => {
  resetEventLog();
  resetOperationalTelemetryForTest();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function acceptedTurn(opts: { sessionId: string; kind?: 'chat' | 'execution'; text?: string }) {
  createSession({ id: opts.sessionId, kind: opts.kind ?? 'chat' });
  return appendEvent({
    sessionId: opts.sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: opts.text ?? 'hello' },
  });
}

test('shadow recorder persists one source-owned private graph and dedupes retries', () => {
  const source = acceptedTurn({ sessionId: 'shadow-once', text: 'What is the Acme account status?' });
  const identity = { sessionId: 'shadow-once', turn: source.turn, sourceUserSeq: source.seq };
  const first = recordTurnGraphShadow({
    identity,
    surface: 'home',
    allowedToolNames: ['tool_search'],
  });
  const retry = recordTurnGraphShadow({
    identity,
    surface: 'discord',
  });

  assert.ok(first);
  assert.equal(retry?.id, first.id, 'same logical source reuses the first shadow graph');
  const events = listEvents('shadow-once', { types: ['turn_graph_compiled'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].parentEventId, source.id);
  assert.equal(events[0].data.sourceUserSeq, source.seq);
  assert.equal(events[0].data.shadow, true);
  assert.equal(events[0].data.route, 'retrieve');
  // CONTRACT CHANGE (2026-08-07, "see the graph"): the compiled plan projects
  // publicly as SHAPE ONLY — route/fastPath/nodeCount. Hashes, the graph body,
  // and source internals stay private.
  const projected = projectHarnessEventForPublic(events[0]);
  assert.ok(projected, 'the plan shape reaches the public stream');
  const projectedData = (projected as { data: Record<string, unknown> }).data;
  assert.equal(projectedData.route, 'retrieve');
  assert.equal(typeof projectedData.nodeCount, 'number');
  assert.doesNotMatch(
    JSON.stringify(projected),
    /graphHash|policyHash|"graph"|surface/,
    'internals never leak into the projection',
  );
  assert.equal((events[0].data.graph as { source?: { surface?: unknown } }).source?.surface, 'home');
});

test('accepted event text is authoritative and neither it nor tool input is persisted raw', () => {
  const source = acceptedTurn({ sessionId: 'shadow-private', text: 'hello' });
  const event = recordTurnGraphShadow({
    identity: { sessionId: 'shadow-private', turn: source.turn, sourceUserSeq: source.seq },
    input: 'Send the zephyr-secret-9831 email to alex@example.com.',
    surface: 'home',
  } as Parameters<typeof recordTurnGraphShadow>[0] & { input: string });
  assert.ok(event);
  assert.equal(event.data.route, 'direct_reply', 'fallback input cannot replace accepted intent');
  const serialized = JSON.stringify(event.data);
  assert.equal(serialized.includes('zephyr-secret-9831'), false);
  assert.equal(serialized.includes('alex@example.com'), false);
  const graph = event.data.graph as { source?: { inputHash?: unknown } };
  assert.match(String(graph.source?.inputHash), /^[a-f0-9]{64}$/);
});

test('missing accepted text cannot be replaced by a private runtime fallback', () => {
  createSession({ id: 'shadow-no-fallback', kind: 'chat' });
  const source = appendEvent({
    sessionId: 'shadow-no-fallback',
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { source: 'legacy-control' },
  });
  const event = recordTurnGraphShadow({
    identity: { sessionId: source.sessionId, turn: source.turn, sourceUserSeq: source.seq },
    input: 'Email private-fallback-secret-882@example.com now.',
    surface: 'home',
  } as Parameters<typeof recordTurnGraphShadow>[0] & { input: string });
  assert.ok(event);
  assert.equal(event.data.route, 'direct_reply');
  assert.equal(JSON.stringify(event.data).includes('private-fallback-secret-882'), false);
});

test('shadow graph emits ONE public plan row, shape-only — internals stay off the bus', () => {
  const source = acceptedTurn({ sessionId: 'shadow-public-bus', text: 'Look up Acme.' });
  const publicRows: Array<Record<string, unknown>> = [];
  const detach = actionBus.subscribe((message) => {
    if (message.kind === 'harness.public_event' && message.sessionId === source.sessionId) {
      publicRows.push(message.event as unknown as Record<string, unknown>);
    }
  });
  try {
    recordTurnGraphShadow({
      identity: { sessionId: source.sessionId, turn: source.turn, sourceUserSeq: source.seq },
      surface: 'home',
    });
  } finally {
    detach();
  }
  // CONTRACT CHANGE (2026-08-07, "see the graph"): the chat strip renders
  // "Planned: … · N steps" from exactly this row. Shape only — never the
  // graph body, hashes, or surface internals.
  assert.equal(publicRows.length, 1);
  assert.equal(publicRows[0].type, 'turn_graph_compiled');
  assert.doesNotMatch(
    JSON.stringify(publicRows[0]),
    /graphHash|policyHash|"graph"|surface/,
    'the bus row is the bounded shape summary',
  );
});

test('operational mirror receives only the bounded graph summary', () => {
  createSession({ id: 'shadow-ops', kind: 'chat', title: 'private-first-turn-title-774' });
  const source = appendEvent({
    sessionId: 'shadow-ops',
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Email alex@example.com with the update.' },
  });
  recordTurnGraphShadow({
    identity: { sessionId: 'shadow-ops', turn: source.turn, sourceUserSeq: source.seq },
    surface: 'home',
  });
  const events = listOperationalEvents({
    sessionId: 'shadow-ops',
    type: 'turn_graph_shadow_compiled',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.route, 'act');
  assert.equal(events[0].payload.effectCeiling, 'external_write');
  assert.equal(events[0].payload.graph, undefined);
  assert.equal(events[0].payload.inputHash, undefined);
  assert.equal(events[0].payload.sessionTitle, undefined);
  assert.equal(JSON.stringify(events[0].payload).includes('private-first-turn-title-774'), false);
});

test('invalid or non-chat observations fail open without writing an event', () => {
  const chatSource = acceptedTurn({ sessionId: 'shadow-invalid' });
  assert.doesNotThrow(() => {
    const event = recordTurnGraphShadow({
      identity: { sessionId: 'shadow-invalid', turn: chatSource.turn, sourceUserSeq: 0 },
      surface: 'home',
    });
    assert.equal(event, null);
  });
  assert.equal(listEvents('shadow-invalid', { types: ['turn_graph_compiled'] }).length, 0);

  const executionSource = acceptedTurn({ sessionId: 'shadow-execution', kind: 'execution' });
  const skipped = recordTurnGraphShadow({
    identity: {
      sessionId: 'shadow-execution',
      turn: executionSource.turn,
      sourceUserSeq: executionSource.seq,
    },
    surface: 'background',
  });
  assert.equal(skipped, null);
  assert.equal(listEvents('shadow-execution', { types: ['turn_graph_compiled'] }).length, 0);

  const wrongTurn = recordTurnGraphShadow({
    identity: {
      sessionId: 'shadow-invalid',
      turn: chatSource.turn + 1,
      sourceUserSeq: chatSource.seq,
    },
    surface: 'home',
  });
  assert.equal(wrongTurn, null);
});

test('a contended eventlog writer cannot add the normal lock wait to a live turn', () => {
  const source = acceptedTurn({ sessionId: 'shadow-lock', text: 'Look up Acme.' });
  const contender = new Database(HARNESS_DB_PATH);
  contender.pragma('journal_mode = WAL');
  contender.exec('BEGIN IMMEDIATE');
  try {
    const startedAt = performance.now();
    const skipped = recordTurnGraphShadow({
      identity: { sessionId: source.sessionId, turn: source.turn, sourceUserSeq: source.seq },
      surface: 'home',
    });
    const elapsedMs = performance.now() - startedAt;
    assert.equal(skipped, null);
    assert.ok(elapsedMs < 500, `shadow observer waited ${elapsedMs.toFixed(1)}ms on a telemetry lock`);
    assert.equal(listEvents(source.sessionId, { types: ['turn_graph_compiled'] }).length, 0);
  } finally {
    contender.exec('ROLLBACK');
    contender.close();
  }

  const retry = recordTurnGraphShadow({
    identity: { sessionId: source.sessionId, turn: source.turn, sourceUserSeq: source.seq },
    surface: 'home',
  });
  assert.ok(retry, 'a later exact-source observer fills the skipped shadow row');
});
