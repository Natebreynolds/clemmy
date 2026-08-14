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
const { resetEventLog, createSession, listEvents, appendEvent, resolveToolOutputForAuthority } = await import('./eventlog.js');
const { attachEventLogHooks, extractSessionIdFromContext, effectiveReflectionTool } = await import('./hooks.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('./brackets.js');
const { activateDispatchLease } = await import('./dispatch-lease.js');
const { settledReadRepeatReplayMarker } = await import('./settled-read-repeat.js');
const { projectCanonicalTopLevelToolEvents } = await import('./tool-effect.js');
const { withTerminalAuthoringEvidenceReceipt } = await import('../../tools/tool-registry.js');
type RunHooksLike = import('./hooks.js').RunHooksLike;

test('effectiveReflectionTool unwraps composio_execute_tool to its action slug', () => {
  const details = { toolCall: { arguments: JSON.stringify({ tool_slug: 'SALESFORCE_GET_RECORD_BY_ID', arguments: '{}' }) } };
  assert.equal(effectiveReflectionTool('composio_execute_tool', details as never), 'SALESFORCE_GET_RECORD_BY_ID');
});

test('effectiveReflectionTool unwraps schema-on-demand call_tool to its exact inner tool', () => {
  const details = {
    toolCall: {
      arguments: JSON.stringify({
        name: 'composio_search_tools',
        args_json: '{"query":"Google Sheets values"}',
      }),
    },
  };
  assert.equal(effectiveReflectionTool('call_tool', details as never), 'composio_search_tools');
});

test('effectiveReflectionTool recursively unwraps deferred call_tool to the actual Composio action', () => {
  const details = {
    toolCall: {
      arguments: JSON.stringify({
        name: 'call_tool',
        args_json: JSON.stringify({
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: 'GOOGLEDRIVE_DOWNLOAD_FILE',
            arguments: '{"file_id":"file_1"}',
          }),
        }),
      }),
    },
  };
  assert.equal(effectiveReflectionTool('call_tool', details as never), 'GOOGLEDRIVE_DOWNLOAD_FILE');
});

test('effectiveReflectionTool unwraps namespaced and dynamic Composio carriers to the canonical action', () => {
  const namespaced = {
    toolCall: {
      arguments: JSON.stringify({
        tool_slug: 'SLACK_CONVERSATIONS_HISTORY',
        arguments: '{}',
      }),
    },
  };
  assert.equal(
    effectiveReflectionTool('mcp__clementine-local__composio_execute_tool', namespaced as never),
    'SLACK_CONVERSATIONS_HISTORY',
  );
  assert.equal(
    effectiveReflectionTool('mcp__clementine-local__cx_twitter_user_timeline', undefined),
    'TWITTER_USER_TIMELINE',
  );
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
  assert.equal(effectiveReflectionTool('call_tool', { toolCall: { arguments: 'not json' } } as never), 'call_tool');
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

test('tool hooks persist exact request ownership on calls and returns', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });
  const details = { toolCall: { callId: 'owned-call', arguments: '{}' } };

  withHarnessRunContext(
    {
      sessionId: sess.id,
      sourceUserSeq: 17,
      runAttemptId: 'attempt-owned-17',
      behaviorScopeId: 'owned-run',
      counter: new ToolCallsCounter(),
    },
    () => {
      stub.emit('agent_tool_start', ctx(sess.id), { name: 'orchestrator' }, { name: 'execution_complete' }, details);
      stub.emit('agent_tool_end', ctx(sess.id), { name: 'orchestrator' }, { name: 'execution_complete' }, 'Execution exec-1 completed.', details);
    },
  );

  const events = listEvents(sess.id, { types: ['tool_called', 'tool_returned'] });
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.data.sourceUserSeq === 17));
  assert.ok(events.every((event) => event.data.runScopeId === 'owned-run'));
  assert.ok(events.every((event) => event.data.attemptId === 'attempt-owned-17'));
});

test('tool hooks quarantine callbacks from a superseded physical dispatch generation', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });
  const staleLease = activateDispatchLease({
    sessionId: sess.id,
    scopeId: `${sess.id}::provider-attempt`,
  });
  const currentLease = activateDispatchLease({
    sessionId: sess.id,
    scopeId: `${sess.id}::provider-attempt`,
  });
  const staleDetails = { toolCall: { callId: 'reused-call', arguments: '{}' } };
  const currentDetails = { toolCall: { callId: 'reused-call', arguments: '{}' } };

  withHarnessRunContext(
    {
      sessionId: sess.id,
      sourceUserSeq: 17,
      behaviorScopeId: 'same-logical-run',
      counter: new ToolCallsCounter(),
      dispatchLease: staleLease,
    },
    () => {
      stub.emit('agent_start', ctx(sess.id), { name: 'stale' });
      stub.emit('agent_tool_start', ctx(sess.id), { name: 'stale' }, { name: 'composio_execute_tool' }, staleDetails);
      stub.emit('agent_tool_end', ctx(sess.id), { name: 'stale' }, { name: 'composio_execute_tool' }, 'Dispatch refused before provider I/O.', staleDetails);
      stub.emit('agent_end', ctx(sess.id), { name: 'stale' }, 'late output');
    },
  );
  withHarnessRunContext(
    {
      sessionId: sess.id,
      sourceUserSeq: 17,
      behaviorScopeId: 'same-logical-run',
      counter: new ToolCallsCounter(),
      dispatchLease: currentLease,
    },
    () => {
      stub.emit('agent_start', ctx(sess.id), { name: 'current' });
      stub.emit('agent_tool_start', ctx(sess.id), { name: 'current' }, { name: 'composio_execute_tool' }, currentDetails);
      stub.emit('agent_tool_end', ctx(sess.id), { name: 'current' }, { name: 'composio_execute_tool' }, '{"successful":true}', currentDetails);
      stub.emit('agent_end', ctx(sess.id), { name: 'current' }, 'fresh output');
    },
  );

  const events = listEvents(sess.id);
  assert.equal(events.some((event) => event.role === 'stale'), false);
  assert.deepEqual(
    events.filter((event) => event.type === 'tool_called' || event.type === 'tool_returned')
      .map((event) => [event.type, event.data.callId]),
    [
      ['tool_called', 'reused-call'],
      ['tool_returned', 'reused-call'],
    ],
  );
});

test('tool hooks pair a start admitted before lease rotation without consuming a reused current call id', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  const reflected: string[] = [];
  attachEventLogHooks(stub, {
    getSessionId: extractSessionIdFromContext,
    scheduleReflection: (input) => { reflected.push(input.output); },
  });
  const firstLease = activateDispatchLease({
    sessionId: sess.id,
    scopeId: `${sess.id}::provider-attempt`,
  });
  const firstDetails = { toolCall: { callId: 'same-sdk-id', arguments: '{}' } };

  withHarnessRunContext(
    {
      sessionId: sess.id,
      sourceUserSeq: 23,
      behaviorScopeId: 'same-logical-run',
      counter: new ToolCallsCounter(),
      dispatchLease: firstLease,
    },
    () => {
      stub.emit('agent_tool_start', ctx(sess.id), { name: 'first' }, { name: 'composio_execute_tool' }, firstDetails);
    },
  );
  const currentLease = activateDispatchLease({
    sessionId: sess.id,
    scopeId: `${sess.id}::provider-attempt`,
  });
  withHarnessRunContext(
    {
      sessionId: sess.id,
      sourceUserSeq: 23,
      behaviorScopeId: 'same-logical-run',
      counter: new ToolCallsCounter(),
      dispatchLease: firstLease,
    },
    () => {
      stub.emit(
        'agent_tool_end',
        ctx(sess.id),
        { name: 'first' },
        { name: 'composio_execute_tool' },
        `StaleDispatchLeaseError: Dispatch refused: provider attempt ${firstLease.leaseId} is no longer authoritative for ${firstLease.scopeId}.`,
        firstDetails,
      );
    },
  );
  const currentDetails = { toolCall: { callId: 'same-sdk-id', arguments: '{}' } };
  withHarnessRunContext(
    {
      sessionId: sess.id,
      sourceUserSeq: 23,
      behaviorScopeId: 'same-logical-run',
      counter: new ToolCallsCounter(),
      dispatchLease: currentLease,
    },
    () => {
      stub.emit('agent_tool_start', ctx(sess.id), { name: 'current' }, { name: 'composio_execute_tool' }, currentDetails);
      stub.emit('agent_tool_end', ctx(sess.id), { name: 'current' }, { name: 'composio_execute_tool' }, '{"successful":true}', currentDetails);
    },
  );

  const raw = listEvents(sess.id, { types: ['tool_called', 'tool_returned'] });
  assert.equal(raw.length, 4, 'the admitted superseded occurrence remains paired audit evidence');
  assert.equal(raw[1]!.parentEventId, raw[0]!.id);
  assert.equal(raw[1]!.data.providerDispatched, undefined,
    'end-time staleness plus error prose is not nominal proof that provider I/O never began');
  assert.equal(raw[3]!.parentEventId, raw[2]!.id,
    'the reused SDK call id pairs inside the current physical generation');
  assert.deepEqual(
    projectCanonicalTopLevelToolEvents(raw).map((event) => [event.type, event.data.dispatchLeaseId]),
    [
      ['tool_called', firstLease.leaseId],
      ['tool_returned', firstLease.leaseId],
      ['tool_called', currentLease.leaseId],
      ['tool_returned', currentLease.leaseId],
    ],
  );
  const authority = resolveToolOutputForAuthority(sess.id, 'same-sdk-id');
  assert.equal(authority.status, 'ambiguous',
    'without a nominal pre-dispatch marker, reused-id physical outcomes fail closed');
  assert.deepEqual(reflected, ['{"successful":true}'],
    'the losing physical generation remains audit-only and cannot teach memory');
});

test('settled-read replay stays visible but never becomes fresh tool-output authority', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Refresh the queue once.' },
  });
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });
  const callId = 'settled-replay-hook';
  const details = {
    toolCall: {
      callId,
      arguments: JSON.stringify({
        tool_slug: 'PROOF_LIST_TASKS',
        arguments: '{}',
        connected_account_id: null,
      }),
    },
  };

  withHarnessRunContext(
    {
      sessionId: sess.id,
      sourceUserSeq: source.seq,
      behaviorScopeId: `${sess.id}::turn:2`,
      counter: new ToolCallsCounter(),
    },
    () => {
      stub.emit('agent_tool_start', ctx(sess.id), { name: 'Clem' }, { name: 'composio_execute_tool' }, details);
      const replayCalled = listEvents(sess.id, { types: ['tool_called'], desc: true, limit: 1 })[0]!;
      appendEvent({
        sessionId: sess.id,
        turn: 1,
        role: 'system',
        type: 'guardrail_tripped',
        data: settledReadRepeatReplayMarker({
          replayCallId: callId,
          replayCalledEventId: replayCalled.id,
          sourceCallId: 'settled-original-hook',
          sourceUserSeq: source.seq,
          toolSlug: 'PROOF_LIST_TASKS',
          sourceBehaviorScopeId: `${sess.id}::turn:1`,
          replayBehaviorScopeId: `${sess.id}::turn:2`,
        }),
      });
      stub.emit(
        'agent_tool_end',
        ctx(sess.id),
        { name: 'Clem' },
        { name: 'composio_execute_tool' },
        '{"successful":true,"data":{"items":[{"id":"one"}]}}\n\n[harness settled-read replay]',
        details,
      );
    },
  );

  const returned = listEvents(sess.id, { types: ['tool_returned'] });
  assert.equal(returned.length, 1);
  assert.equal(returned[0]!.data.providerDispatched, false);
  assert.equal(returned[0]!.data.replayedFromCallId, 'settled-original-hook');
  assert.equal(resolveToolOutputForAuthority(sess.id, callId).status, 'missing',
    'replayed bytes are never parked as a new authoritative provider result');

  const freshSource = appendEvent({
    sessionId: sess.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Refresh it for my new request.' },
  });
  const reusedDetails = {
    toolCall: {
      callId,
      arguments: details.toolCall.arguments,
    },
  };
  const freshProvider = '{"successful":true,"data":{"items":[{"id":"fresh"}]}}';
  withHarnessRunContext(
    {
      sessionId: sess.id,
      sourceUserSeq: freshSource.seq,
      behaviorScopeId: `${sess.id}::turn:3`,
      counter: new ToolCallsCounter(),
    },
    () => {
      stub.emit('agent_tool_start', ctx(sess.id), { name: 'Clem' }, { name: 'composio_execute_tool' }, reusedDetails);
      stub.emit('agent_tool_end', ctx(sess.id), { name: 'Clem' }, { name: 'composio_execute_tool' }, freshProvider, reusedDetails);
    },
  );
  const reusedReturns = listEvents(sess.id, { types: ['tool_returned'] });
  assert.equal(reusedReturns.length, 2);
  assert.equal(reusedReturns[1]!.data.providerDispatched, undefined,
    'a later real occurrence reusing the SDK call id must not inherit replay disposition');
  const freshAuthority = resolveToolOutputForAuthority(sess.id, callId);
  assert.equal(freshAuthority.status, 'ok');
  if (freshAuthority.status === 'ok') assert.equal(freshAuthority.record.output, freshProvider);
});

test('settled-read steering is model-facing only and never enters authority or reflection', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'List the queue once.' },
  });
  const reflected: Array<{ output: string }> = [];
  const stub = makeStub();
  attachEventLogHooks(stub, {
    getSessionId: extractSessionIdFromContext,
    scheduleReflection: (input) => { reflected.push({ output: input.output }); },
  });
  const callId = 'settled-first-success';
  const details = {
    toolCall: {
      callId,
      arguments: JSON.stringify({
        tool_slug: 'PROOF_LIST_TASKS',
        arguments: '{}',
        connected_account_id: null,
      }),
    },
  };
  const provider = '{"successful":true,"data":{"items":[{"id":"one"}]}}';
  const modelFacing = `${provider}\n\n[harness settled-read] Fresh PROOF_LIST_TASKS data is above. Use it or answer naturally.`;

  withHarnessRunContext(
    {
      sessionId: sess.id,
      sourceUserSeq: source.seq,
      behaviorScopeId: `${sess.id}::turn:1`,
      counter: new ToolCallsCounter(),
    },
    () => {
      stub.emit('agent_tool_start', ctx(sess.id), { name: 'Clem' }, { name: 'composio_execute_tool' }, details);
      stub.emit('agent_tool_end', ctx(sess.id), { name: 'Clem' }, { name: 'composio_execute_tool' }, modelFacing, details);
    },
  );

  assert.deepEqual(reflected, [{ output: provider }]);
  const authority = resolveToolOutputForAuthority(sess.id, callId);
  assert.equal(authority.status, 'ok');
  if (authority.status === 'ok') assert.equal(authority.record.output, provider);
  assert.equal(listEvents(sess.id, { types: ['tool_returned'] })[0]!.data.result, modelFacing,
    'the model-facing lifecycle remains conversationally steered');
});

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
  assert.equal(called[0].data.canonicalCallId, callId);
  assert.equal(called[0].data.accounting, 'top_level');
  assert.equal(called[0].data.effect, 'local_write');
  assert.equal(returned[0].data.canonicalCallId, callId);
  assert.equal(returned[0].data.accounting, 'top_level');
  assert.equal(returned[0].data.effect, 'local_write');
  assert.equal(returned[0].data.result, 'ok');
});

test('tool hooks expose inner provider effects and dedupe duplicate open notifications', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });
  const details = {
    toolCall: {
      callId: 'call_provider_once',
      arguments: JSON.stringify({ tool_slug: 'HUBSPOT_FIND_OR_CREATE_CONTACT', arguments: '{}' }),
    },
  };
  for (let i = 0; i < 2; i++) {
    stub.emit('agent_tool_start', ctx(sess.id), { name: 'executor' }, { name: 'composio_execute_tool' }, details);
  }
  for (let i = 0; i < 2; i++) {
    stub.emit('agent_tool_end', ctx(sess.id), { name: 'executor' }, { name: 'composio_execute_tool' }, 'ok', details);
  }

  const called = listEvents(sess.id, { types: ['tool_called'] });
  const returned = listEvents(sess.id, { types: ['tool_returned'] });
  assert.equal(called.length, 1);
  assert.equal(returned.length, 1);
  assert.equal(called[0].data.toolSlug, 'HUBSPOT_FIND_OR_CREATE_CONTACT');
  assert.equal(called[0].data.effect, 'external_write');
  assert.equal(returned[0].data.toolSlug, 'HUBSPOT_FIND_OR_CREATE_CONTACT');
  assert.equal(returned[0].data.effect, 'external_write');
});

test('tool hooks preserve effective call_tool identity before an oversized argument preview is clipped', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });
  const callId = 'call_large_workflow_carrier';
  const argumentsJson = JSON.stringify({
    name: 'workflow_run',
    args_json: JSON.stringify({
      name: 'large-workflow',
      inputs: { brief: 'x'.repeat(9_000) },
    }),
  });

  stub.emit(
    'agent_tool_start',
    ctx(sess.id),
    { name: 'orchestrator' },
    { name: 'call_tool' },
    { toolCall: { callId, arguments: argumentsJson } },
  );
  // The SDK does not always repeat arguments on end; the start-side metadata
  // must own the whole occurrence and survive until its paired return.
  stub.emit(
    'agent_tool_end',
    ctx(sess.id),
    { name: 'orchestrator' },
    { name: 'call_tool' },
    'Queued "large-workflow" — it is now running in the BACKGROUND.',
    { toolCall: { callId } },
  );

  const called = listEvents(sess.id, { types: ['tool_called'] });
  const returned = listEvents(sess.id, { types: ['tool_returned'] });
  assert.equal(called.length, 1);
  assert.equal(returned.length, 1);
  assert.equal(called[0].data.effectiveTool, 'workflow_run');
  assert.equal(returned[0].data.effectiveTool, 'workflow_run');
  assert.notEqual(called[0].data.arguments, argumentsJson, 'event preview is bounded');
  assert.throws(() => JSON.parse(String(called[0].data.arguments)), 'clipped JSON cannot be reparsed');
});

test('Codex hooks grant workflow-create evidence only to an exact paired admitted return', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });

  const direct = {
    toolCall: {
      callId: 'authoring-direct-create',
      arguments: JSON.stringify({ name: 'daily-digest' }),
    },
  };
  stub.emit('agent_tool_start', ctx(sess.id), { name: 'orchestrator' }, { name: 'workflow_create' }, direct);
  stub.emit(
    'agent_tool_end',
    ctx(sess.id),
    { name: 'orchestrator' },
    { name: 'workflow_create' },
    withTerminalAuthoringEvidenceReceipt('workflow_create', 'Created workflow "daily-digest".'),
    direct,
  );

  const carried = {
    toolCall: {
      callId: 'authoring-carried-create',
      arguments: JSON.stringify({
        name: 'workflow_create',
        args_json: JSON.stringify({ name: 'weekly-digest' }),
      }),
    },
  };
  stub.emit('agent_tool_start', ctx(sess.id), { name: 'orchestrator' }, { name: 'call_tool' }, carried);
  stub.emit(
    'agent_tool_end',
    ctx(sess.id),
    { name: 'orchestrator' },
    { name: 'call_tool' },
    withTerminalAuthoringEvidenceReceipt('workflow_create', 'Created workflow "weekly-digest".'),
    carried,
  );

  const calledById = new Map(
    listEvents(sess.id, { types: ['tool_called'] })
      .map((event) => [String(event.data.callId), event]),
  );
  const returnedById = new Map(
    listEvents(sess.id, { types: ['tool_returned'] })
      .map((event) => [String(event.data.callId), event]),
  );
  for (const callId of ['authoring-direct-create', 'authoring-carried-create']) {
    const called = calledById.get(callId);
    const returned = returnedById.get(callId);
    assert.ok(called, `${callId}: admitted start exists`);
    assert.ok(returned, `${callId}: paired return exists`);
    assert.equal(returned.parentEventId, called.id, `${callId}: exact parent linkage`);
    assert.equal(returned.data.successfulAuthoringResult, true, `${callId}: host receipt is trusted`);
    assert.equal(returned.data.topologyRole, 'control');
  }
  assert.equal(returnedById.get('authoring-carried-create')!.data.effectiveTool, 'workflow_create');
});

test('Codex hooks reject orphan and error-like workflow-create returns as terminal evidence', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });

  const orphan = {
    toolCall: {
      callId: 'authoring-orphan-end',
      arguments: JSON.stringify({ name: 'orphan-digest' }),
    },
  };
  stub.emit(
    'agent_tool_end',
    ctx(sess.id),
    { name: 'orchestrator' },
    { name: 'workflow_create' },
    withTerminalAuthoringEvidenceReceipt('workflow_create', 'Created workflow "orphan-digest".'),
    orphan,
  );

  const errored = {
    toolCall: {
      callId: 'authoring-error-return',
      arguments: JSON.stringify({ name: 'failed-digest' }),
    },
  };
  stub.emit('agent_tool_start', ctx(sess.id), { name: 'orchestrator' }, { name: 'workflow_create' }, errored);
  stub.emit(
    'agent_tool_end',
    ctx(sess.id),
    { name: 'orchestrator' },
    { name: 'workflow_create' },
    withTerminalAuthoringEvidenceReceipt('workflow_create', 'ERROR: workflow creation failed before commit.'),
    errored,
  );

  const returnedById = new Map(
    listEvents(sess.id, { types: ['tool_returned'] })
      .map((event) => [String(event.data.callId), event]),
  );
  const orphanReturn = returnedById.get('authoring-orphan-end');
  const errorReturn = returnedById.get('authoring-error-return');
  assert.ok(orphanReturn);
  assert.equal(orphanReturn.parentEventId, null, 'an unadmitted end has no authoritative parent');
  assert.equal(orphanReturn.data.successfulAuthoringResult, undefined);
  assert.ok(errorReturn?.parentEventId, 'the negative error fixture is genuinely paired');
  assert.equal(errorReturn?.data.successfulAuthoringResult, undefined);
});

test('tool hooks admit a later occurrence that legitimately reuses a closed call id', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });
  const first = { toolCall: { callId: 'call_reused', arguments: '{"query":"first"}' } };
  const second = { toolCall: { callId: 'call_reused', arguments: '{"query":"second"}' } };

  stub.emit('agent_tool_start', ctx(sess.id), { name: 'executor' }, { name: 'query_workspace_artifact' }, first);
  stub.emit('agent_tool_end', ctx(sess.id), { name: 'executor' }, { name: 'query_workspace_artifact' }, 'first result', first);
  stub.emit('agent_tool_start', ctx(sess.id), { name: 'executor' }, { name: 'query_workspace_artifact' }, second);
  stub.emit('agent_tool_end', ctx(sess.id), { name: 'executor' }, { name: 'query_workspace_artifact' }, 'second result', second);

  const called = listEvents(sess.id, { types: ['tool_called'] });
  const returned = listEvents(sess.id, { types: ['tool_returned'] });
  assert.equal(called.length, 2);
  assert.equal(returned.length, 2);
  assert.equal(returned[0].parentEventId, called[0].id);
  assert.equal(returned[1].parentEventId, called[1].id);
  assert.equal(returned[0].data.result, 'first result');
  assert.equal(returned[1].data.result, 'second result');
});

test('tool hooks suppress an exact closed lifecycle notification replay', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const stub = makeStub();
  attachEventLogHooks(stub, { getSessionId: extractSessionIdFromContext });
  const details = { toolCall: { callId: 'call_exact_replay', arguments: '{}' } };

  for (let replay = 0; replay < 2; replay++) {
    stub.emit('agent_tool_start', ctx(sess.id), { name: 'executor' }, { name: 'read_file' }, details);
    stub.emit('agent_tool_end', ctx(sess.id), { name: 'executor' }, { name: 'read_file' }, 'same result', details);
  }

  const called = listEvents(sess.id, { types: ['tool_called'] });
  const returned = listEvents(sess.id, { types: ['tool_returned'] });
  assert.equal(called.length, 1);
  assert.equal(returned.length, 1);
  assert.equal(returned[0].parentEventId, called[0].id);
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
  assert.match(result, /recall_tool_result \{"call_id":"call_recall_test"\}/);
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
