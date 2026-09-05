/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/plan-task-result-contract.test.ts
 *
 * The recovery surface derives from the exact typed plan_task contract, never
 * from prose. The missing-write refusal is ask-only: it names the exact
 * missing write as ONE tool_search and carries no capability list to pick
 * from (offering card writes as substitutes is the pinned
 * "offered greenhouse/airtable" incident). That ask-only shape must parse as a
 * structural tool_search recovery, and the exact same JSON minus
 * `recoveryTool` must keep parsing as the legacy member it always was.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-plan-task-result-contract-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { parseExactPlanTaskRefusal } = await import('./plan-task-result-contract.js');
const { projectHostNoProgressAttempt } = await import('./host-no-progress-projection.js');
const eventlog = await import('./eventlog.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

/** The bytes plan_task emits today for a draft that lacks the write its ask needs. */
const ASK_ONLY_MISSING_WRITE = Object.freeze({
  ok: false,
  code: 'plan_incomplete_missing_write',
  detail: 'The accepted request requires a write, but this draft contains no exactly bound host-attested write operation.',
  requestedEffectScope: 'mixed',
  repair: 'Use tool_search for the exact missing write capability, then call plan_task again with that exact capabilityRef bound to a local_write, external_write, or admin topology operation. Do not freeze or execute a read-only subset.',
  recoveryTool: 'tool_search',
});

function accepted(label: string) {
  const session = eventlog.createSession({ id: `plan-task-result-contract-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: label },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

function settledPlanTaskRefusal(
  identity: ReturnType<typeof accepted>,
  callId: string,
): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE logical_call_settlements (
      logical_tool_call_id TEXT NOT NULL,
      observer_call_id TEXT,
      execution_kind TEXT NOT NULL,
      outcome_kind TEXT NOT NULL,
      outcome_detail TEXT,
      recovery_action TEXT NOT NULL,
      business_call INTEGER NOT NULL,
      mutating INTEGER NOT NULL,
      requires_reconciliation INTEGER NOT NULL,
      physical_crossing_count INTEGER NOT NULL,
      host_crossing_count INTEGER,
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO logical_call_settlements
      (logical_tool_call_id, observer_call_id, execution_kind, outcome_kind,
       recovery_action, business_call, mutating, requires_reconciliation,
       physical_crossing_count, host_crossing_count, session_id, source_user_seq)
    VALUES (?, ?, 'local_execution', 'unknown', 'stop_and_explain', 0, 0, 0, 0, 1, ?, ?)
  `).run(callId, callId, identity.sessionId, identity.sourceUserSeq);
  return db;
}

function projectRefusal(label: string, payload: Record<string, unknown>) {
  const identity = accepted(label);
  const callId = `plan-${label}`;
  const db = settledPlanTaskRefusal(identity, callId);
  try {
    return projectHostNoProgressAttempt({
      ...identity,
      historyDelta: [
        { type: 'function_call', callId, name: 'plan_task', arguments: '{}' },
        {
          type: 'function_call_result',
          callId,
          name: 'plan_task',
          output: { type: 'text', text: JSON.stringify(payload) },
        },
      ],
    }, db);
  } finally {
    db.close();
  }
}

test('the ask-only missing-write refusal parses to a structural tool_search recovery', () => {
  const parsed = parseExactPlanTaskRefusal(JSON.stringify(ASK_ONLY_MISSING_WRITE));
  assert.ok(parsed, 'the shape plan_task emits must be a member of the closed union');
  assert.equal(parsed.disposition, 'settled_refusal');
  assert.equal(parsed.recoveryTool, 'tool_search');
  assert.equal(parsed.structural, true);
  assert.equal('admissibleCapabilities' in parsed.payload, false);

  const projected = projectRefusal('ask-only', { ...ASK_ONLY_MISSING_WRITE });
  assert.equal(projected.status, 'ok', JSON.stringify(projected));
  if (projected.status === 'ok') {
    assert.equal(projected.consequence?.stage, 'plan_incomplete:missing_write');
    assert.equal(projected.consequence?.recovery, 'repair_model');
    assert.deepEqual(
      projected.consequence?.recoveryToolNames,
      ['tool_search'],
      'the surface offers exactly the search the repair names — never a plan_task-only surface against a "use tool_search" repair',
    );
  }
});

test('the same JSON minus recoveryTool still parses as the legacy member, unchanged', () => {
  const { recoveryTool: _dropped, ...legacy } = ASK_ONLY_MISSING_WRITE;
  const parsed = parseExactPlanTaskRefusal(JSON.stringify(legacy));
  assert.ok(parsed, 'the historical shape must keep parsing');
  assert.equal(parsed.disposition, 'settled_refusal');
  assert.equal(parsed.recoveryTool, null);
  assert.equal(parsed.structural, false);

  // Old durable payloads did not carry recoveryTool and retain their recorded
  // plan_task-only recovery semantics in the projection.
  const projected = projectRefusal('legacy', { ...legacy });
  assert.equal(projected.status, 'ok');
  if (projected.status === 'ok') {
    assert.equal(projected.consequence?.stage, 'plan_incomplete:missing_write');
    assert.deepEqual(projected.consequence?.recoveryToolNames, ['plan_task']);
  }
});

test('recorded payloads that carried a capability list keep their recorded routing', () => {
  const advertised = {
    capabilityRef: 'cap:local:workflow_create:reversible',
    effect: 'local_write',
    purpose: 'author_workflow',
  };
  const emptyListSearch = parseExactPlanTaskRefusal(JSON.stringify({
    ...ASK_ONLY_MISSING_WRITE,
    admissibleCapabilities: [],
  }));
  assert.equal(emptyListSearch?.recoveryTool, 'tool_search');
  assert.equal(emptyListSearch?.structural, true);

  const listedPlan = parseExactPlanTaskRefusal(JSON.stringify({
    ...ASK_ONLY_MISSING_WRITE,
    admissibleCapabilities: [advertised],
    recoveryTool: 'plan_task',
  }));
  assert.equal(listedPlan?.recoveryTool, 'plan_task');
  assert.equal(listedPlan?.structural, true);

  const { recoveryTool: _dropped, ...withoutTool } = ASK_ONLY_MISSING_WRITE;
  const listedLegacy = parseExactPlanTaskRefusal(JSON.stringify({
    ...withoutTool,
    admissibleCapabilities: [advertised],
  }));
  assert.equal(listedLegacy?.recoveryTool, null);
  assert.equal(listedLegacy?.structural, false);

  // A list that contradicts its own recovery tool is not a member at all.
  assert.equal(parseExactPlanTaskRefusal(JSON.stringify({
    ...ASK_ONLY_MISSING_WRITE,
    admissibleCapabilities: [advertised],
  })), null);
  // The producer DOES emit this pairing: when the cited write is blocked on a
  // connected-account choice, no search can bind it, so the repair names the
  // gathering-stage door and routes back to plan_task (plan-tools.ts, live
  // 2026-09-03 run 28). It must be a member on the same 6-key set.
  const accountBlocked = parseExactPlanTaskRefusal(JSON.stringify({
    ...ASK_ONLY_MISSING_WRITE,
    recoveryTool: 'plan_task',
  }));
  assert.equal(accountBlocked?.recoveryTool, 'plan_task');
  assert.equal(accountBlocked?.structural, true);
});

test('a keyed plan_invalid_input refusal parses as the structural plan_task member and projects a path-keyed stage', () => {
  // Live 2026-09-01: four distinct plan_task complaints in a row all landed on
  // the flat 'schema_invalid' stage and a converging authoring turn was
  // terminalized. The host-authored repairKey (violated-path digest) keys the
  // stage so a new complaint is progress and the same complaint is the floor.
  const base = {
    ok: false,
    code: 'plan_invalid_input',
    detail: 'plan_task input did not match its schema — draft.bindings: bindings must cover every canonical topology operation exactly once',
    repair: 'Fix exactly the named paths and call plan_task again; do not resend the identical arguments.',
    recoveryTool: 'plan_task',
  };
  const keyedA = { ...base, repairKey: 'a'.repeat(32) };
  const keyedB = { ...base, repairKey: 'b'.repeat(32) };
  const parsed = parseExactPlanTaskRefusal(JSON.stringify(keyedA));
  assert.ok(parsed, 'the keyed shape is a member of the closed union');
  assert.equal(parsed.recoveryTool, 'plan_task');
  assert.equal(parsed.structural, true);
  assert.equal(parseExactPlanTaskRefusal(JSON.stringify(base))?.structural, true, 'the legacy unkeyed shape still parses');
  assert.equal(parseExactPlanTaskRefusal(JSON.stringify({ ...base, repairKey: 'not-hex' })), null, 'a malformed key is not a member');

  const first = projectRefusal('keyed-a', keyedA);
  const second = projectRefusal('keyed-b', keyedB);
  const legacy = projectRefusal('keyed-none', base);
  assert.equal(first.status, 'ok', JSON.stringify(first));
  assert.equal(second.status, 'ok', JSON.stringify(second));
  assert.equal(legacy.status, 'ok', JSON.stringify(legacy));
  if (first.status === 'ok' && second.status === 'ok' && legacy.status === 'ok') {
    assert.equal(first.consequence?.stage, `schema_invalid:${'a'.repeat(16)}`);
    assert.equal(second.consequence?.stage, `schema_invalid:${'b'.repeat(16)}`);
    assert.notEqual(first.consequence?.key, second.consequence?.key, 'a different violated-path set is a different stage');
    assert.match(legacy.consequence?.stage ?? '', /^schema_invalid:call:[a-f0-9]{16}$/);
    assert.deepEqual(first.consequence?.recoveryToolNames, ['plan_task']);
  }
});
