/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/worker-call-record.test.ts
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-worker-call-record-'));
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { appendEvent, createSession } = await import('./eventlog.js');
const { workerCallRecord, workerScopeCallRecord, renderWorkerCallRecord } = await import('./worker-call-record.js');

test('the host record says which business calls ran, failed or never reached the provider', () => {
  const session = createSession({ kind: 'agent', title: 'record fixture' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Gather one block.' } });
  const settled = (tool: string, kind: string, businessCall = true) => appendEvent({ sessionId: session.id, turn: 1, role: 'system',
    type: 'tool_attempt_settled', data: { sourceUserSeq: source.seq, tool, kind, businessCall } });
  settled('tool_search', 'succeeded', false);
  settled('write_file', 'succeeded');
  settled('fixture__api_request', 'failed');
  appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'guardrail_tripped', data: { sourceUserSeq: source.seq,
    kind: 'refused_pre_dispatch', calls: [
      { name: 'call_tool', argumentsJson: JSON.stringify({ name: 'fixture__api_request', args_json: '{}' }) },
      { name: 'call_tool', argumentsJson: JSON.stringify({ name: 'fixture__api_request', args_json: '{}' }) },
    ] } });
  const record = workerCallRecord(session.id, source.seq);
  assert.deepEqual(record.byTool, {
    write_file: { succeeded: 1, failed: 0, refusedBeforeDispatch: 0 },
    fixture__api_request: { succeeded: 0, failed: 1, refusedBeforeDispatch: 2 },
  }, 'control tools are not business work');
  assert.equal(record.businessCallSucceeded, true);
  assert.equal(record.businessCallAttempted, true);
  const text = renderWorkerCallRecord(record);
  assert.match(text, /written by Clementine, not the worker/);
  assert.match(text, /fixture__api_request: 0 succeeded; 1 failed; 2 refused before dispatch — no request reached the provider/);
  assert.match(text, /the record is right: rerun the item/);
});

test('a worker that ran no business tool is recorded as such', () => {
  const session = createSession({ kind: 'agent', title: 'empty fixture' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Gather one block.' } });
  const record = workerCallRecord(session.id, source.seq);
  assert.equal(record.businessCallSucceeded, false);
  assert.equal(record.businessCallAttempted, false, 'a worker that needed no tool attempted none');
  assert.match(renderWorkerCallRecord(record), /No business tool ran\./);
});

test('an agent-SDK worker gets the same record from its scoped calls in the parent session', () => {
  const session = createSession({ kind: 'chat', title: 'sdk worker fixture' });
  const scope = `${session.id}::worker:fixture-packet`;
  const before = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Fan out.' } });
  const returned = (data: Record<string, unknown>) => appendEvent({ sessionId: session.id, turn: 1, role: 'system', type: 'tool_returned', data });
  returned({ runScopeId: scope, accounting: 'top_level', topologyRole: 'business', tool: 'call_tool', effectiveTool: 'fixture__api_request', ok: false });
  returned({ runScopeId: scope, accounting: 'transport_mirror', tool: 'fixture__api_request', ok: false });
  returned({ runScopeId: scope, accounting: 'top_level', topologyRole: 'control', tool: 'tool_search' });
  returned({ runScopeId: `${session.id}::worker:other`, accounting: 'top_level', topologyRole: 'business', effectiveTool: 'write_file', ok: true });
  const record = workerScopeCallRecord(session.id, scope, before.seq);
  assert.deepEqual(record.byTool, { fixture__api_request: { succeeded: 0, failed: 1, refusedBeforeDispatch: 0 } });
  assert.equal(record.businessCallSucceeded, false);
  assert.equal(record.businessCallAttempted, true, 'tried business work that never succeeded');
});
