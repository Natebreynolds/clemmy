/**
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/source-refused-attempts.test.ts
 *
 * Two candidates in a row were reported "zero refused attempts" when they had
 * one, because each evidence source alone misses a real failure shape.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-refuse-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'refuse\n', 'utf8');

const { sourceRefusedAttempts } = await import('./source-refused-attempts.js');
const eventlog = await import('./eventlog.js');
after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

function source(rows: Array<{ type: string; data: Record<string, unknown> }>) {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'refuse' });
  const src = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'go' },
  });
  for (const row of rows) {
    eventlog.appendEvent({
      sessionId: session.id, turn: 1, role: 'system', type: row.type,
      data: { sourceUserSeq: src.seq, ...row.data },
    });
  }
  return { sessionId: session.id, sourceUserSeq: src.seq };
}

test('a SETTLEMENT-only refusal is counted (the C19 create shape)', () => {
  // executionKind refused_pre_dispatch, no ok:false anywhere, no guardrail row.
  const id = source([{
    type: 'tool_attempt_settled',
    data: { logicalToolCallId: 'call_a', tool: 'workflow_create',
      executionKind: 'refused_pre_dispatch', kind: 'invalid_arguments' },
  }]);
  const r = sourceRefusedAttempts(id);
  assert.equal(r.count, 1);
  assert.equal(r.attempts[0]!.source, 'settlement');
  assert.equal(r.attempts[0]!.kind, 'invalid_arguments');
});

test('a GUARDRAIL-only refusal is counted (the C17 schema-reader shape)', () => {
  const id = source([{
    type: 'guardrail_tripped',
    data: { callId: 'call_b', tool: 'call_tool', kind: 'refused_pre_dispatch' },
  }]);
  const r = sourceRefusedAttempts(id);
  assert.equal(r.count, 1);
  assert.equal(r.attempts[0]!.source, 'guardrail');
});

test('one refusal emitting BOTH forms is counted once', () => {
  const id = source([
    { type: 'tool_attempt_settled', data: { logicalToolCallId: 'call_c', tool: 't', executionKind: 'refused_pre_dispatch', kind: 'invalid_arguments' } },
    { type: 'guardrail_tripped', data: { logicalToolCallId: 'call_c', tool: 't', kind: 'refused_pre_dispatch' } },
  ]);
  const r = sourceRefusedAttempts(id);
  assert.equal(r.count, 1, 'dedupe on the logical call');
  assert.equal(r.attempts[0]!.source, 'settlement', 'the canonical kind wins');
});

test('a SUCCESSFUL settlement is not a refusal', () => {
  const id = source([{
    type: 'tool_attempt_settled',
    data: { logicalToolCallId: 'call_d', tool: 'workflow_create', executionKind: 'dispatched', kind: 'ok' },
  }]);
  assert.equal(sourceRefusedAttempts(id).count, 0);
});

test('an unrelated guardrail is not a refused attempt', () => {
  // no_progress_decision and budget notices are not attempts that failed.
  const id = source([{ type: 'guardrail_tripped', data: { callId: 'call_e', kind: 'no_progress_decision', reason: 'retry_available' } }]);
  assert.equal(sourceRefusedAttempts(id).count, 0);
});

test('another source’s refusal is never attributed to this one', () => {
  const session = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'x' });
  const first = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'a' } });
  eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'system', type: 'tool_attempt_settled',
    data: { sourceUserSeq: first.seq, logicalToolCallId: 'call_f', tool: 't', executionKind: 'refused_pre_dispatch', kind: 'invalid_arguments' },
  });
  const second = eventlog.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'b' } });
  assert.equal(sourceRefusedAttempts({ sessionId: session.id, sourceUserSeq: second.seq }).count, 0);
});
