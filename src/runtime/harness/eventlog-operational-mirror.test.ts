/**
 * Run: npx tsx --test src/runtime/harness/eventlog-operational-mirror.test.ts
 *
 * The eventlog → operational-telemetry mirror: every whitelisted harness event
 * becomes exactly one operational row (right source/type/sessionId), excluded and
 * unmapped types emit nothing, the kill-switch disables it, and a malformed
 * payload never throws. Isolated CLEMENTINE_HOME so the mirror's real-DB writes
 * land in a temp home (binding house rule).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mirror-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { mirrorEventToOperational } = await import('./eventlog-operational-mirror.js');
const { listOperationalEvents } = await import('../operational-telemetry.js');
type EventRow = import('./eventlog.js').EventRow;
type EventType = import('./eventlog.js').EventType;
type SessionRow = import('./eventlog.js').SessionRow;

let seq = 0;
function nextSession(): string {
  seq += 1;
  return `sess-mirror-${seq}-${Math.random().toString(16).slice(2, 8)}`;
}

function ev(type: string, data: Record<string, unknown> = {}, sessionId = nextSession()): EventRow {
  return {
    seq: 1,
    id: `evt-${Math.random().toString(16).slice(2)}`,
    sessionId,
    turn: 0,
    role: 'system',
    type: type as EventType,
    parentEventId: null,
    data,
    createdAt: new Date().toISOString(),
  };
}

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-x',
    kind: 'chat',
    channel: null,
    userId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active',
    title: 'My Chat',
    objective: null,
    tokenBudget: null,
    tokensUsed: 0,
    currentPlanId: null,
    metadata: {},
    ...overrides,
  };
}

/** All operational rows this session produced (isolated by unique sessionId). */
function rowsFor(sessionId: string) {
  return listOperationalEvents({ sessionId, limit: 100 });
}

test('mirror: each whitelisted eventlog type produces exactly one correct operational row', () => {
  const cases: Array<[string, string, string]> = [
    // eventlogType, expected operational type, expected source
    ['turn_started', 'harness_turn_started', 'harness'],
    ['turn_ended', 'harness_turn_completed', 'harness'],
    ['run_completed', 'harness_run_completed', 'harness'],
    ['conversation_completed', 'harness_run_completed', 'harness'],
    ['run_failed', 'harness_run_failed', 'harness'],
    ['worker_capped', 'worker_capped', 'harness'],
    ['sdk_auto_continue', 'auto_continue', 'harness'],
    ['guardrail_tripped', 'gate_verdict', 'safety'],
    ['goal_alignment_judged', 'judge_verdict', 'safety'],
    ['output_grounding_judged', 'judge_verdict', 'safety'],
    ['brain_fallover', 'model_fallover', 'model'],
    ['approval_requested', 'approval_required', 'safety'],
    ['approval_resolved', 'approval_resolved', 'safety'],
  ];
  for (const [eventType, opType, opSource] of cases) {
    const sid = nextSession();
    mirrorEventToOperational(ev(eventType, { note: eventType }, sid), session({ id: sid }));
    const rows = rowsFor(sid);
    assert.equal(rows.length, 1, `${eventType} should mirror to exactly one row`);
    assert.equal(rows[0].type, opType, `${eventType} → ${opType}`);
    assert.equal(rows[0].source, opSource, `${eventType} source`);
    assert.equal(rows[0].sessionId, sid, `${eventType} carries the sessionId`);
  }
});

test('mirror: worker_result branches on ok (completed vs failed)', () => {
  const okSid = nextSession();
  mirrorEventToOperational(ev('worker_result', { item: 'a', ok: true }, okSid), session({ id: okSid }));
  const okRows = rowsFor(okSid);
  assert.equal(okRows.length, 1);
  assert.equal(okRows[0].type, 'worker_completed');
  assert.equal(okRows[0].severity, 'info');

  const failSid = nextSession();
  mirrorEventToOperational(ev('worker_result', { item: 'b', ok: false }, failSid), session({ id: failSid }));
  const failRows = rowsFor(failSid);
  assert.equal(failRows.length, 1);
  assert.equal(failRows[0].type, 'worker_failed');
  assert.equal(failRows[0].severity, 'error');
});

test('mirror: excluded high-frequency types emit NOTHING', () => {
  for (const excluded of ['tool_called', 'tool_returned', 'stream_token', 'heartbeat', 'memory_signals_captured']) {
    const sid = nextSession();
    mirrorEventToOperational(ev(excluded, {}, sid), session({ id: sid }));
    assert.equal(rowsFor(sid).length, 0, `${excluded} must not mirror`);
  }
});

test('mirror: an unmapped (but valid) eventlog type emits nothing', () => {
  const sid = nextSession();
  mirrorEventToOperational(ev('session_started', {}, sid), session({ id: sid }));
  assert.equal(rowsFor(sid).length, 0);
});

test('mirror: kill-switch off → zero rows', () => {
  const prev = process.env.CLEMMY_EVENTLOG_OPERATIONAL_MIRROR;
  process.env.CLEMMY_EVENTLOG_OPERATIONAL_MIRROR = 'off';
  try {
    const sid = nextSession();
    mirrorEventToOperational(ev('turn_started', {}, sid), session({ id: sid }));
    assert.equal(rowsFor(sid).length, 0, 'flag off disables the mirror');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_EVENTLOG_OPERATIONAL_MIRROR;
    else process.env.CLEMMY_EVENTLOG_OPERATIONAL_MIRROR = prev;
  }
});

test('mirror: enriches payload with session kind/title and event data', () => {
  const sid = nextSession();
  mirrorEventToOperational(
    ev('sdk_auto_continue', { attempt: 3, stillLimited: true }, sid),
    session({ id: sid, kind: 'execution', title: 'Deep run' }),
  );
  const [row] = rowsFor(sid);
  assert.equal(row.payload.sessionKind, 'execution');
  assert.equal(row.payload.sessionTitle, 'Deep run');
  assert.equal(row.payload.attempt, 3);
  assert.equal(row.payload.stillLimited, true);
  assert.equal(row.payload.eventType, 'sdk_auto_continue');
});

test('mirror: brain_fallover is tagged stage=step_boundary', () => {
  const sid = nextSession();
  mirrorEventToOperational(ev('brain_fallover', { reason: '529', toModel: 'codex' }, sid), session({ id: sid }));
  const [row] = rowsFor(sid);
  assert.equal(row.type, 'model_fallover');
  assert.equal(row.payload.stage, 'step_boundary');
});

test('mirror: workflow step session id yields a workflowRunId correlation', () => {
  const sid = 'workflow:run-abc:step-1';
  mirrorEventToOperational(ev('run_failed', {}, sid), session({ id: sid, kind: 'workflow' }));
  const [row] = rowsFor(sid);
  assert.equal(row.workflowRunId, 'run-abc');
});

test('mirror: a huge/malformed payload never throws and still records the envelope', () => {
  const sid = nextSession();
  const huge = 'x'.repeat(6000);
  assert.doesNotThrow(() => {
    mirrorEventToOperational(ev('turn_started', { blob: huge }, sid), session({ id: sid }));
  });
  const [row] = rowsFor(sid);
  assert.equal(row.type, 'harness_turn_started');
  // Oversized data is summarized rather than inlined.
  assert.equal(row.payload.data, `[omitted: ${JSON.stringify({ blob: huge }).length} bytes]`);
});

test('mirror: never throws even when the session row is null', () => {
  const sid = nextSession();
  assert.doesNotThrow(() => mirrorEventToOperational(ev('run_completed', {}, sid), null));
  assert.equal(rowsFor(sid).length, 1);
});
