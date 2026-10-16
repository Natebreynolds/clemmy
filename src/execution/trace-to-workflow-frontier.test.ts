import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-learning-frontier-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
const log = await import('../runtime/harness/eventlog.js');
const trace = await import('./trace-to-workflow.js');
const { toolCallCorrelationFingerprint } = await import('../runtime/harness/tool-correlation.js');
after(() => { log.closeEventLog(); rmSync(TEST_HOME, { recursive: true, force: true }); });

function call(sessionId: string, callId: string, tool = 'read_file', args: unknown = { path: 'controlled.txt' }) {
  return log.appendEvent({ sessionId, turn: 1, role: 'Clem', type: 'tool_called',
    data: { tool, callId, arguments: JSON.stringify(args), accounting: 'top_level', effect: 'read' } });
}
function returned(sessionId: string, invoked: ReturnType<typeof call>, result: string) {
  return log.appendEvent({ sessionId, turn: 1, role: 'tool', type: 'tool_returned', parentEventId: invoked.id,
    data: { tool: invoked.data.tool, callId: invoked.data.callId, result, ok: true, accounting: 'top_level', effect: 'read' } });
}

test('a frozen trace keeps the cumulative earlier procedure prefix and excludes later calls and returns', () => {
  const session = log.createSession({ kind: 'chat' });
  const first = call(session.id, 'prefix-first');
  returned(session.id, first, 'earlier controlled result');
  log.appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Save this as a playbook.' } });
  const frontier = log.getLatestEventSeq(session.id);
  const later = call(session.id, 'late-second');
  returned(session.id, later, 'later result must not join this learning request');
  assert.deepEqual(trace.readSessionTrace(session.id, { throughSeq: frontier }).map(row => row.callId), ['prefix-first']);
  assert.deepEqual([...trace.readSessionToolReturns(session.id, { throughSeq: frontier })], [['prefix-first', 'earlier controlled result']]);
  assert.equal(trace.readSessionTrace(session.id).length, 2, 'automatic unbounded reader keeps its full-session default');
});

test('a late settled side-store output cannot cross a frozen frontier with no in-prefix return', () => {
  const session = log.createSession({ kind: 'chat' });
  const invoked = call(session.id, 'not-yet-returned');
  const throughSeq = log.getLatestEventSeq(session.id);
  returned(session.id, invoked, 'late parked result');
  log.writeToolOutput({ sessionId: session.id, callId: 'not-yet-returned', tool: 'read_file', output: 'late parked result' });
  assert.equal(trace.readSessionToolReturns(session.id).get('not-yet-returned'), 'late parked result');
  assert.equal(trace.readSessionToolReturns(session.id, { throughSeq }).has('not-yet-returned'), false);
});

test('bounded native mirror pairing retains one canonical call and only in-frontier mirror evidence', () => {
  const session = log.createSession({ kind: 'chat' });
  const args = { path: 'controlled-mirror.txt' };
  const correlationFingerprint = toolCallCorrelationFingerprint('read_file', args);
  log.appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'tool_called',
    data: { tool: 'read_file', callId: 'canonical-read', accounting: 'top_level', arguments: JSON.stringify(args), correlationFingerprint } });
  log.appendEvent({ sessionId: session.id, turn: 1, role: 'Clem', type: 'tool_called',
    data: { tool: 'read_file', callId: 'mirror-read', accounting: 'transport_mirror', args, correlationFingerprint } });
  const frontier = log.appendEvent({ sessionId: session.id, turn: 1, role: 'tool', type: 'tool_returned',
    data: { tool: 'read_file', callId: 'mirror-read', accounting: 'transport_mirror', result: 'exact mirror prefix' } }).seq;
  log.appendEvent({ sessionId: session.id, turn: 1, role: 'tool', type: 'tool_returned',
    data: { tool: 'read_file', callId: 'canonical-read', accounting: 'top_level', result: 'late canonical presentation' } });
  assert.deepEqual(trace.readSessionTrace(session.id, { throughSeq: frontier }).map(row => row.callId), ['canonical-read']);
  assert.equal(trace.readSessionToolReturns(session.id, { throughSeq: frontier }).get('canonical-read'), 'exact mirror prefix');
});

test('manual distillation and its generic carrier forms cannot learn their own invocation or return', () => {
  const session = log.createSession({ kind: 'chat' });
  const useful = call(session.id, 'useful-read');
  returned(session.id, useful, 'retain the real procedure');
  const direct = call(session.id, 'direct-distill', 'skill_distill', { objective: 'Learn controlled work' });
  returned(session.id, direct, 'not procedure evidence');
  const wrapped = call(session.id, 'wrapped-distill', 'call_tool', {
    name: 'skill_distill', args_json: { objective: 'Learn controlled work' },
  });
  returned(session.id, wrapped, 'not procedure evidence');
  const nested = call(session.id, 'nested-distill', 'work_call', {
    name: 'call_tool', args_json: JSON.stringify({ name: 'skill_distill', args_json: '{}' }),
  });
  returned(session.id, nested, 'not procedure evidence');
  const local = call(session.id, 'local-distill', 'mcp__clementine-local__skill_distill', {});
  returned(session.id, local, 'not procedure evidence');
  log.appendEvent({ sessionId: session.id, turn: 1, role: 'executor', type: 'tool_called',
    data: { tool: 'call_tool', callId: 'clipped-distill', accounting: 'top_level', effectiveTool: 'skill_distill',
      arguments: '{"name":"skill_dis…' } });
  assert.deepEqual(trace.readSessionTrace(session.id).map(row => row.callId), ['useful-read']);
  assert.deepEqual([...trace.readSessionToolReturns(session.id).keys()], ['useful-read']);
  assert.equal(trace.isPromotableTool('skill_distill'), false);
});

test('one pre-await read snapshot cannot learn a later fresh occurrence behind a replayed call id', () => {
  const session = log.createSession({ kind: 'chat' });
  const replay = call(session.id, 'replay-then-fresh', 'provider_search', { query: 'prior fixture' });
  log.appendEvent({ sessionId: session.id, turn: 1, role: 'executor', type: 'tool_returned', parentEventId: replay.id,
    data: { tool: 'provider_search', callId: 'replay-then-fresh', effect: 'read', providerDispatched: false,
      replayedFromCallId: 'physical-prior', replayKind: 'same_source_settled_read_replay', result: 'earlier replay presentation' } });
  const snapshot = trace.captureSessionTraceSnapshot(session.id);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.calls), true);
  assert.equal(Object.isFrozen(snapshot.returns), true);
  const captured = [...snapshot.returns];
  const fresh = call(session.id, 'replay-then-fresh', 'provider_search', { query: 'new fixture' });
  log.writeToolOutput({ sessionId: session.id, callId: 'replay-then-fresh', tool: 'provider_search',
    output: 'later fresh result must never join the prior manual snapshot' });
  returned(session.id, fresh, 'later fresh result must never join the prior manual snapshot');
  assert.equal(log.resolveToolOutputForAuthority(session.id, 'replay-then-fresh').status, 'ok',
    'the ordinary current resolver deliberately selects the fresh physical occurrence');
  assert.deepEqual([...snapshot.returns], captured);
  assert.equal(snapshot.returns.some(([, value]) => value.includes('later fresh result')), false);
  assert.equal(snapshot.calls.length, 1);
  assert.match(snapshot.calls[0]!.args, /prior fixture/);
});

test('invalid explicit frontiers refuse instead of falling back to the whole session', () => {
  const session = log.createSession({ kind: 'chat' });
  for (const throughSeq of [-1, NaN, 1.5, Infinity]) {
    assert.throws(() => trace.readSessionTrace(session.id, { throughSeq }));
    assert.throws(() => trace.readSessionToolReturns(session.id, { throughSeq }));
  }
});
