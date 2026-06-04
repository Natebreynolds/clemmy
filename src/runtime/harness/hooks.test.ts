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
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-harness-hooks-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// Dynamic imports — see eventlog.test.ts for why.
const { resetEventLog, createSession, listEvents } = await import('./eventlog.js');
const { attachEventLogHooks, extractSessionIdFromContext, effectiveReflectionTool } = await import('./hooks.js');
type RunHooksLike = import('./hooks.js').RunHooksLike;

test('effectiveReflectionTool unwraps composio_execute_tool to its action slug', () => {
  const details = { toolCall: { arguments: JSON.stringify({ tool_slug: 'SALESFORCE_GET_RECORD_BY_ID', arguments: '{}' }) } };
  assert.equal(effectiveReflectionTool('composio_execute_tool', details as never), 'SALESFORCE_GET_RECORD_BY_ID');
});

test('effectiveReflectionTool passes through non-composio tools unchanged', () => {
  assert.equal(effectiveReflectionTool('read_file', undefined), 'read_file');
  assert.equal(effectiveReflectionTool(null, undefined), null);
});

test('effectiveReflectionTool unwraps run_shell_command to a recognized connector CLI', () => {
  const sf = { toolCall: { arguments: JSON.stringify({ command: 'sf data query --json "SELECT Id FROM Account"', cwd: null }) } };
  assert.equal(effectiveReflectionTool('run_shell_command', sf as never), 'sf');
  // Ordinary shell stays attributed to the wrapper (no provenance churn).
  const ls = { toolCall: { arguments: JSON.stringify({ command: 'ls -la', cwd: null }) } };
  assert.equal(effectiveReflectionTool('run_shell_command', ls as never), 'run_shell_command');
  const git = { toolCall: { arguments: JSON.stringify({ command: 'git status' }) } };
  assert.equal(effectiveReflectionTool('run_shell_command', git as never), 'run_shell_command');
  assert.equal(effectiveReflectionTool('run_shell_command', undefined), 'run_shell_command');
});

test('effectiveReflectionTool falls back to the wrapper name when the slug is missing/unparseable', () => {
  assert.equal(effectiveReflectionTool('composio_execute_tool', { toolCall: { arguments: 'not json' } } as never), 'composio_execute_tool');
  assert.equal(effectiveReflectionTool('composio_execute_tool', { toolCall: {} } as never), 'composio_execute_tool');
  assert.equal(effectiveReflectionTool('composio_execute_tool', undefined), 'composio_execute_tool');
});

test.after(() => {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

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

test('large tool_returned result uses recall_tool_result marker when callId present', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, {
    getSessionId: extractSessionIdFromContext,
    maxResultChars: 50,
  });
  const callId = 'call_recall_test';
  const longResult = 'A'.repeat(500);
  stub.emit(
    'agent_tool_start',
    ctx(sess.id),
    { name: 'executor' },
    { name: 'composio_execute_tool' },
    { toolCall: { callId, arguments: '{}' } },
  );
  stub.emit(
    'agent_tool_end',
    ctx(sess.id),
    { name: 'executor' },
    { name: 'composio_execute_tool' },
    longResult,
    { toolCall: { callId } },
  );

  const returned = listEvents(sess.id, { types: ['tool_returned'] });
  assert.equal(returned.length, 1);
  const result = String(returned[0].data.result);
  // Head preserved
  assert.ok(result.startsWith('A'.repeat(50)), 'head preserved');
  // Marker references the callId in the recall_tool_result form
  assert.match(result, /recall_tool_result\("call_recall_test"\)/);
  // Original length surfaced in the marker
  assert.match(result, /returned 500 chars/);
  // Tool name surfaced
  assert.match(result, /composio_execute_tool/);
});

test('large tool_returned without callId falls back to basic +N chars marker', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, {
    getSessionId: extractSessionIdFromContext,
    maxResultChars: 50,
  });
  const longResult = 'B'.repeat(500);
  stub.emit(
    'agent_tool_start',
    ctx(sess.id),
    { name: 'executor' },
    { name: 'mystery_tool' },
    // No callId — recall_tool_result can't recover this anyway
    { toolCall: {} },
  );
  stub.emit(
    'agent_tool_end',
    ctx(sess.id),
    { name: 'executor' },
    { name: 'mystery_tool' },
    longResult,
    { toolCall: {} },
  );

  const returned = listEvents(sess.id, { types: ['tool_returned'] });
  assert.equal(returned.length, 1);
  const result = String(returned[0].data.result);
  assert.ok(result.startsWith('B'.repeat(50)), 'head preserved');
  // Falls back to the basic marker — recall isn't possible without callId
  assert.match(result, /\+450 chars\]/);
  assert.ok(!result.includes('recall_tool_result'), 'no false recall hint when callId absent');
});

test('small tool_returned passes through unchanged regardless of callId', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, {
    getSessionId: extractSessionIdFromContext,
    maxResultChars: 50,
  });
  stub.emit(
    'agent_tool_start',
    ctx(sess.id),
    { name: 'executor' },
    { name: 'read_file' },
    { toolCall: { callId: 'call_small' } },
  );
  stub.emit(
    'agent_tool_end',
    ctx(sess.id),
    { name: 'executor' },
    { name: 'read_file' },
    'tiny',
    { toolCall: { callId: 'call_small' } },
  );

  const returned = listEvents(sess.id, { types: ['tool_returned'] });
  assert.equal(String(returned[0].data.result), 'tiny');
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
