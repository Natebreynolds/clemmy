/**
 * Run: npx tsx --test src/runtime/harness/hooks.test.ts
 *
 * Contracts the hook-to-event-log translator must keep:
 *   - the five SDK lifecycle events each become one event
 *   - tool_called and tool_returned correlate via the SDK call id
 *   - turn_ended carries the agent's final output (clipped)
 *   - missing session id is a silent no-op (the hook is shared)
 *   - detach() actually stops the listeners
 *
 * The Runner isn't constructed for these tests — we use a stub that
 * exposes the same on/off/emit surface. The shape we depend on is
 * documented at node_modules/@openai/agents-core/dist/lifecycle.d.ts.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-harness-hooks-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resetEventLog, createSession, listEvents } from './eventlog.js';
import { attachEventLogHooks, extractSessionIdFromContext, type RunHooksLike } from './hooks.js';

function makeStub(): RunHooksLike & { emit: EventEmitter['emit'] } {
  const ee = new EventEmitter();
  return {
    on: (event, listener) => ee.on(event, listener),
    off: (event, listener) => ee.off(event, listener),
    emit: ee.emit.bind(ee),
  };
}

function ctx(sessionId: string, turn = 0): unknown {
  return { context: { sessionId, turn } };
}

test('agent_start emits turn_started with the agent name', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });
  stub.emit('agent_start', ctx(sess.id), { name: 'orchestrator' });

  const events = listEvents(sess.id, { types: ['turn_started'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].role, 'orchestrator');
  assert.equal(events[0].data.agent, 'orchestrator');
});

test('agent_end emits turn_ended with output (clipped)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, {
    getSessionId: extractSessionIdFromContext,
    maxOutputChars: 20,
  });
  const longOutput = 'x'.repeat(200);
  stub.emit('agent_end', ctx(sess.id), { name: 'orchestrator' }, longOutput);

  const events = listEvents(sess.id, { types: ['turn_ended'] });
  assert.equal(events.length, 1);
  const out = String(events[0].data.output);
  assert.ok(out.startsWith('x'.repeat(20)));
  assert.ok(out.includes('+180 chars]'));
});

test('agent_handoff records from/to', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });
  stub.emit('agent_handoff', ctx(sess.id), { name: 'orchestrator' }, { name: 'researcher' });

  const events = listEvents(sess.id, { types: ['handoff'] });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.from, 'orchestrator');
  assert.equal(events[0].data.to, 'researcher');
  assert.equal(events[0].role, 'orchestrator');
});

test('tool_called and tool_returned correlate via callId', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });
  const callId = 'call_xyz';
  stub.emit(
    'agent_tool_start',
    ctx(sess.id),
    { name: 'executor' },
    { name: 'write_file' },
    { toolCall: { callId, arguments: '{"path":"/a"}' } },
  );
  stub.emit(
    'agent_tool_end',
    ctx(sess.id),
    { name: 'executor' },
    { name: 'write_file' },
    'ok',
    { toolCall: { callId } },
  );

  const called = listEvents(sess.id, { types: ['tool_called'] });
  const returned = listEvents(sess.id, { types: ['tool_returned'] });
  assert.equal(called.length, 1);
  assert.equal(returned.length, 1);
  assert.equal(returned[0].parentEventId, called[0].id, 'returned points at called');
  assert.equal(called[0].data.callId, callId);
  assert.equal(returned[0].data.result, 'ok');
});

test('two parallel tool calls correlate independently', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });

  stub.emit(
    'agent_tool_start',
    ctx(sess.id),
    { name: 'executor' },
    { name: 'read' },
    { toolCall: { callId: 'a' } },
  );
  stub.emit(
    'agent_tool_start',
    ctx(sess.id),
    { name: 'executor' },
    { name: 'read' },
    { toolCall: { callId: 'b' } },
  );
  stub.emit(
    'agent_tool_end',
    ctx(sess.id),
    { name: 'executor' },
    { name: 'read' },
    'res-b',
    { toolCall: { callId: 'b' } },
  );
  stub.emit(
    'agent_tool_end',
    ctx(sess.id),
    { name: 'executor' },
    { name: 'read' },
    'res-a',
    { toolCall: { callId: 'a' } },
  );

  const events = listEvents(sess.id);
  const calledA = events.find((e) => e.type === 'tool_called' && e.data.callId === 'a');
  const calledB = events.find((e) => e.type === 'tool_called' && e.data.callId === 'b');
  const returnedA = events.find((e) => e.type === 'tool_returned' && e.data.callId === 'a');
  const returnedB = events.find((e) => e.type === 'tool_returned' && e.data.callId === 'b');
  assert.ok(calledA && calledB && returnedA && returnedB);
  assert.equal(returnedA!.parentEventId, calledA!.id);
  assert.equal(returnedB!.parentEventId, calledB!.id);
});

test('missing session id is a silent no-op', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });
  // emit with an empty context (no sessionId)
  stub.emit('agent_start', { context: {} }, { name: 'orchestrator' });

  const events = listEvents(sess.id);
  assert.equal(events.length, 0, 'nothing was written for the foreign run');
});

test('detach() stops listeners from writing more events', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  const detach = attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });
  stub.emit('agent_start', ctx(sess.id), { name: 'orchestrator' });
  detach();
  stub.emit('agent_start', ctx(sess.id), { name: 'orchestrator' });

  const events = listEvents(sess.id, { types: ['turn_started'] });
  assert.equal(events.length, 1, 'second emit was not recorded');
});

test('uses fallback role labels when agent/tool have no name', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });
  stub.emit('agent_start', ctx(sess.id), {});
  stub.emit(
    'agent_tool_start',
    ctx(sess.id),
    {},
    {},
    { toolCall: { callId: 'c1' } },
  );

  const events = listEvents(sess.id);
  assert.equal(events[0].role, 'agent');
  const called = events.find((e) => e.type === 'tool_called');
  assert.ok(called);
  assert.equal(called!.role, 'agent');
  assert.equal(called!.data.tool, null);
});

test('extractSessionIdFromContext handles weird inputs without throwing', () => {
  assert.equal(extractSessionIdFromContext(undefined), undefined);
  assert.equal(extractSessionIdFromContext(null), undefined);
  assert.equal(extractSessionIdFromContext('not an object'), undefined);
  assert.equal(extractSessionIdFromContext({}), undefined);
  assert.equal(extractSessionIdFromContext({ context: null }), undefined);
  assert.equal(extractSessionIdFromContext({ context: { sessionId: 42 } }), undefined);
  assert.equal(extractSessionIdFromContext({ context: { sessionId: 'sess-1' } }), 'sess-1');
});

test('getTurn callback is threaded into the event row', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, {
    getSessionId: extractSessionIdFromContext,
    getTurn: (rc) => (rc as { context: { turn: number } }).context.turn,
  });
  stub.emit('agent_start', ctx(sess.id, 7), { name: 'orchestrator' });
  const events = listEvents(sess.id);
  assert.equal(events[0].turn, 7);
});
