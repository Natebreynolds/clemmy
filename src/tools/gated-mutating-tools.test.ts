import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolated home + gate flags BEFORE importing anything that reads them.
const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-gated-bridge-test-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_DESTINATION_GATE = 'on';
process.env.CLEMMY_TOOL_GUARDRAIL = 'off';
process.env.CLEMMY_EXECUTION_GATE = 'off';
process.env.CLEMMY_GROUNDING_GATE = 'off';
process.env.CLEMMY_GOAL_FIDELITY_GATE = 'off';
process.env.CLEMMY_CONFIRM_FIRST = 'off';
process.env.CLEMENTINE_MCP_GATED_MUTATIONS = 'on';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

const { createSession, appendEvent, listEvents, writeToolOutput } = await import('../runtime/harness/eventlog.js');
const destination = await import('../runtime/harness/destination-gate.js');
const { registerGatedMutatingTools, gatedMutationsEnabled, getGatedToolSchemas } = await import('./gated-mutating-tools.js');
const { getComputerTools } = await import('./computer-tools.js');
const { getComposioRuntimeTools } = await import('./composio-tools.js');
const { toolCallCorrelationFingerprint } = await import('../runtime/harness/tool-correlation.js');
const { harnessRunContextStorage } = await import('../runtime/harness/brackets.js');
const {
  claimClaudeLocalPermissionAdmission,
  recordClaudeLocalPermissionAdmission,
} = await import('../runtime/harness/claude-local-tool-correlation.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const currentCapabilityFixtures = await import('../runtime/harness/current-capability-manifest.fixture.js');
const priorCapabilityFactory = currentCapabilityFixtures.installCurrentCapabilityManifestFixtures([{
  operationId: 'PROOF_LIST_TASKS',
  providerKind: 'composio',
  effect: 'read',
}]);

/** The settlement spine refuses dispatch without an accepted source AND a
 *  persisted turn graph — every fixture that drives a wrapped tool anchors
 *  both. */
function anchorAcceptedTask(sessionId: string, text: string): { seq: number; turn: number } {
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const shadow = recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq: source.seq, turn: source.turn },
  });
  assert.ok(shadow, 'fixture persisted the turn graph for the accepted task');
  return { seq: source.seq, turn: source.turn };
}

type Handler = (input: Record<string, unknown>) => Promise<unknown>;

function mockServer(): { server: unknown; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (...args: unknown[]) => {
      const name = typeof args[0] === 'string' ? (args[0] as string) : '';
      const handler = args.find((a) => typeof a === 'function') as Handler | undefined;
      if (name && handler) handlers.set(name, handler);
    },
  };
  return { server, handlers };
}

test('bridge registers the mutating tools only when enabled + a session is present', () => {
  assert.equal(gatedMutationsEnabled(), true, 'env flag enables the bridge');
  process.env.CLEMENTINE_MCP_SESSION_ID = '';
  const noSession = mockServer();
  registerGatedMutatingTools(noSession.server as never);
  assert.equal(noSession.handlers.size, 0, 'no session id → bridge registers nothing');
});

test('bridge registers the full Composio discovery chain for Claude SDK workflow steps', () => {
  const sess = createSession({ kind: 'chat' });
  process.env.CLEMENTINE_MCP_SESSION_ID = sess.id;

  const { server, handlers } = mockServer();
  registerGatedMutatingTools(server as never);

  for (const name of ['composio_status', 'composio_search_tools', 'composio_list_tools', 'composio_execute_tool']) {
    assert.ok(handlers.has(name), `bridge registered ${name} on the MCP surface`);
  }
});

test('Claude worker identity reaches the gated inner context independently of direct-orchestrator status', async () => {
  const sess = createSession({ kind: 'chat' });
  const anchor = anchorAcceptedTask(sess.id, 'check composio status');
  let observedWorkerScope: boolean | undefined;
  const { server, handlers } = mockServer();
  registerGatedMutatingTools(server as never, {
    sessionId: sess.id,
    sourceUserSeq: anchor.seq,
    runScopeId: `${sess.id}::brain:worker-scope`,
    directOrchestrator: false,
    workerScope: true,
    runtimeToolsForTest: [{
      name: 'composio_status',
      invoke: async () => {
        observedWorkerScope = harnessRunContextStorage.getStore()?.workerScope;
        return 'status ok';
      },
    } as any],
  });
  const status = handlers.get('composio_status');
  assert.ok(status);
  await status({});
  assert.equal(observedWorkerScope, true, 'the inner gateway can distinguish a worker from a workflow step');
});

test('gate bridge: the destination gate FIRES when Claude calls run_shell_command through the bridge', async () => {
  destination._resetDestinationStateForTests?.();
  const sess = createSession({ kind: 'chat' });
  process.env.CLEMENTINE_MCP_SESSION_ID = sess.id;

  const { server, handlers } = mockServer();
  registerGatedMutatingTools(server as never);

  const shell = handlers.get('run_shell_command');
  assert.ok(shell, 'bridge registered run_shell_command on the MCP surface');

  // A publish verb with NO explicit destination → the destination gate soft-blocks.
  // The binary is intentionally nonexistent: even if a gate ever missed, this is a
  // harmless "command not found", never a real deploy.
  const command = `clemmy-fake-deploy-cli deploy --dir "/x/site" --prod --json # ${'private-shell-payload '.repeat(30)}`;
  assert.ok(command.length > 500);
  const out = await shell({ command });

  const tripped = listEvents(sess.id, { types: ['guardrail_tripped'] })
    .map((e) => (e.data as { kind?: string }).kind)
    .filter((k): k is string => typeof k === 'string');
  assert.ok(
    tripped.some((k) => k === 'implicit_destination' || k === 'unverified_destination'),
    `expected a destination guardrail to fire THROUGH THE BRIDGE, got: ${tripped.join(',') || '(none)'}`,
  );
  // Gate threw before execute → the result is the soft block message in the MCP
  // textResult shape ({ content: [{ type:'text', text }] }), not command output.
  const text = (out as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '';
  assert.ok(text.length > 0, 'bridge returns the gate block as a tool result');
  const mirrorCall = listEvents(sess.id, { types: ['tool_called'] }).find((event) => event.data.tool === 'run_shell_command');
  assert.equal(mirrorCall?.data.accounting, 'transport_mirror', 'inner MCP telemetry cannot inflate top-level call counts');
  assert.equal(
    mirrorCall?.data.correlationFingerprint,
    toolCallCorrelationFingerprint('run_shell_command', { command }),
    'mirror correlation uses the full input before previewArgs clips it',
  );
  assert.doesNotMatch(String(mirrorCall?.data.correlationFingerprint), /private-shell-payload/);
});

// ─── C3 conformance: gated schema is DERIVED from the base tool, never a fork ──

type JsonSchema = { properties?: Record<string, unknown>; required?: string[] };

function isNullableProp(p: unknown): boolean {
  const o = p as { type?: unknown; anyOf?: Array<{ type?: unknown }> } | undefined;
  if (!o) return false;
  if (o.type === 'null') return true;
  if (Array.isArray(o.type) && o.type.includes('null')) return true;
  if (Array.isArray(o.anyOf) && o.anyOf.some((x) => x?.type === 'null')) return true;
  return false;
}

test('gated schema field set matches each registered base tool + non-nullable base fields stay required (anti-drift)', () => {
  const base = new Map<string, JsonSchema>();
  for (const t of [...getComputerTools(), ...getComposioRuntimeTools()] as Array<{ name?: string; parameters?: JsonSchema }>) {
    if (t?.name && t.parameters) base.set(t.name, t.parameters);
  }
  const gatedSchemas = getGatedToolSchemas();
  for (const [name, shape] of Object.entries(gatedSchemas)) {
    const gated = z.toJSONSchema(z.object(shape)) as JsonSchema;
    const b = base.get(name);
    assert.ok(b, `base tool ${name} must be registered`);
    // FIELD SET must match the base tool exactly — a base param add/remove/rename
    // that a hand-mirror would miss (the ⅔ InvalidToolInputError class) fails here.
    assert.deepEqual(
      Object.keys(gated.properties ?? {}).sort(),
      Object.keys(b!.properties ?? {}).sort(),
      `${name}: gated field set must equal the base tool's`,
    );
    // Every truly-mandatory (non-nullable) base-required field stays required.
    const gatedReq = new Set(gated.required ?? []);
    for (const f of b!.required ?? []) {
      if (!isNullableProp(b!.properties?.[f])) {
        assert.ok(gatedReq.has(f), `${name}.${f} is a non-nullable base-required field and must stay required in the gated schema`);
      }
    }
  }
});

test('gated transform: nullable base fields are loosened to optional; the documented arguments divergence is required', () => {
  const gated = getGatedToolSchemas();
  const shellSchema = z.toJSONSchema(z.object(gated.run_shell_command)) as JsonSchema;
  // command is non-nullable → required; cwd/timeout_ms are nullable → optional.
  assert.ok((shellSchema.required ?? []).includes('command'));
  assert.ok(!(shellSchema.required ?? []).includes('cwd'), 'nullable base field is optional in the gated MCP schema');
  assert.ok(!(shellSchema.required ?? []).includes('timeout_ms'));
  // Documented divergence: composio_execute_tool.arguments stays REQUIRED.
  const execSchema = z.toJSONSchema(z.object(gated.composio_execute_tool)) as JsonSchema;
  assert.ok((execSchema.required ?? []).includes('arguments'), 'the gated executor requires an args string (documented override)');
  assert.ok(!(execSchema.required ?? []).includes('connected_account_id'), 'connected_account_id keeps the standard loosening');
});

test('Claude local Composio read claims the outer toolUseID before brackets and replays without provider dispatch', async () => {
  const previousGuardrail = process.env.CLEMMY_TOOL_GUARDRAIL;
  const previousSettled = process.env.CLEMMY_SETTLED_READ_REPEAT;
  process.env.CLEMMY_TOOL_GUARDRAIL = 'warn';
  process.env.CLEMMY_SETTLED_READ_REPEAT = 'on';
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Read the proof queue once.' },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: sess.id, sourceUserSeq: source.seq, turn: source.turn },
  }), 'fixture persisted the turn graph for the accepted task');
  const rawInput = { tool_slug: 'PROOF_LIST_TASKS', arguments: '{}' };
  const providerResult = JSON.stringify({
    successful: true,
    data: {
      sourceMarker: 'CLAUDE_CORRELATION_LOCAL_ONLY',
      items: [{ id: 'proof-1', status: 'done' }],
    },
  });
  const sourceScope = `${sess.id}::brain:source`;
  const sourceCalled = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: source.seq,
      runScopeId: sourceScope,
      tool: 'composio_execute_tool',
      callId: 'claude-source-read',
      canonicalCallId: 'claude-source-read',
      accounting: 'top_level',
      correlationFingerprint: toolCallCorrelationFingerprint('composio_execute_tool', rawInput),
      effect: 'read',
      effectiveTool: 'PROOF_LIST_TASKS',
      toolSlug: 'PROOF_LIST_TASKS',
      arguments: JSON.stringify(rawInput),
    },
  });
  writeToolOutput({
    sessionId: sess.id,
    callId: 'claude-source-read',
    invocationNonce: 'claude-source-nonce',
    tool: 'composio_execute_tool',
    output: providerResult,
  });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    parentEventId: sourceCalled.id,
    data: {
      sourceUserSeq: source.seq,
      runScopeId: sourceScope,
      tool: 'composio_execute_tool',
      callId: 'claude-source-read',
      canonicalCallId: 'claude-source-read',
      accounting: 'top_level',
      effect: 'read',
      effectiveTool: 'PROOF_LIST_TASKS',
      toolSlug: 'PROOF_LIST_TASKS',
      result: providerResult,
    },
  });

  const replayScope = `${sess.id}::brain:recovery`;
  const outerCallId = 'toolu_claude_settled_replay';
  const admission = recordClaudeLocalPermissionAdmission({
    sessionId: sess.id,
    sourceUserSeq: source.seq,
    runScopeId: replayScope,
    providerCallId: outerCallId,
    sdkToolName: 'mcp__clementine-local__composio_execute_tool',
    input: rawInput,
    directOrchestrator: true,
  });
  assert.ok(admission, 'the final Claude permission allow is durable');

  let providerDispatches = 0;
  const fakeComposio = {
    name: 'composio_execute_tool',
    description: 'test-only Composio reader',
    invoke: async () => {
      providerDispatches += 1;
      return providerResult;
    },
  } as any;
  const { server, handlers } = mockServer();
  registerGatedMutatingTools(server as never, {
    sessionId: sess.id,
    sourceUserSeq: source.seq,
    runScopeId: replayScope,
    directOrchestrator: true,
    runtimeToolsForTest: [fakeComposio],
  });
  const execute = handlers.get('composio_execute_tool');
  assert.ok(execute);
  try {
    const output = await execute(rawInput);
    const text = (output as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
    assert.equal(providerDispatches, 0, 'the repeated read never reaches the provider tool');
    assert.match(text, /CLAUDE_CORRELATION_LOCAL_ONLY/);
    assert.match(text, /\[harness settled-read replay\]/);

    const called = listEvents(sess.id, { types: ['tool_called'] });
    const outer = called.filter((event) =>
      event.data.accounting === 'top_level' && event.data.callId === outerCallId,
    );
    assert.equal(outer.length, 1, 'one canonical outer attempt is authored at handler entry');
    assert.equal(outer[0]?.data.sourceUserSeq, source.seq);
    assert.equal(outer[0]?.data.runScopeId, replayScope);
    const admissions = listEvents(sess.id, { types: ['claude_local_permission_admitted'] });
    assert.equal(admissions.length, 1);
    assert.equal(admissions[0]?.id, admission?.id);
    assert.equal(called.length, 3, 'permission admission does not inflate raw tool-call accounting');
    const mirror = called.find((event) =>
      event.data.accounting === 'transport_mirror'
      && typeof event.data.callId === 'string'
      && event.data.callId.startsWith('mcp-'),
    );
    assert.equal(mirror?.data.canonicalCallId, outerCallId);
    assert.equal(mirror?.data.canonicalCalledEventId, outer[0]?.id);
    const mirrorReturn = listEvents(sess.id, { types: ['tool_returned'] }).find((event) =>
      event.data.accounting === 'transport_mirror'
      && event.data.canonicalCallId === outerCallId,
    );
    assert.equal(mirrorReturn?.data.providerDispatched, false);
    const replayMarker = listEvents(sess.id, { types: ['guardrail_tripped'] }).find((event) =>
      event.data.kind === 'same_source_settled_read_replay'
      && event.data.replayCallId === outerCallId,
    );
    assert.equal(replayMarker?.data.replayCalledEventId, outer[0]?.id);
    assert.equal(claimClaudeLocalPermissionAdmission({
      sessionId: sess.id,
      sourceUserSeq: source.seq,
      runScopeId: replayScope,
      toolName: 'composio_execute_tool',
      rawInput,
      directOrchestrator: true,
    }), null, 'one permission admission cannot be consumed by a second handler');
  } finally {
    if (previousGuardrail === undefined) delete process.env.CLEMMY_TOOL_GUARDRAIL;
    else process.env.CLEMMY_TOOL_GUARDRAIL = previousGuardrail;
    if (previousSettled === undefined) delete process.env.CLEMMY_SETTLED_READ_REPEAT;
    else process.env.CLEMMY_SETTLED_READ_REPEAT = previousSettled;
  }
});

test('Claude local correlation fails open when identical permission admissions are ambiguous', async () => {
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Read the queue.' },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: sess.id, sourceUserSeq: source.seq, turn: source.turn },
  }), 'fixture persisted the turn graph for the accepted task');
  const input = { tool_slug: 'PROOF_LIST_TASKS', arguments: '{}' };
  const scope = `${sess.id}::brain:ambiguous`;
  for (const providerCallId of ['toolu_ambiguous_a', 'toolu_ambiguous_b']) {
    assert.ok(recordClaudeLocalPermissionAdmission({
      sessionId: sess.id,
      sourceUserSeq: source.seq,
      runScopeId: scope,
      providerCallId,
      sdkToolName: 'mcp__clementine-local__composio_execute_tool',
      input,
      directOrchestrator: true,
    }));
  }
  let providerDispatches = 0;
  const { server, handlers } = mockServer();
  registerGatedMutatingTools(server as never, {
    sessionId: sess.id,
    sourceUserSeq: source.seq,
    runScopeId: scope,
    directOrchestrator: true,
    runtimeToolsForTest: [{
      name: 'composio_execute_tool',
      invoke: async () => {
        providerDispatches += 1;
        return JSON.stringify({ successful: true, data: { items: [{ id: 'fresh' }] } });
      },
    } as any],
  });
  await handlers.get('composio_execute_tool')?.(input);
  assert.equal(providerDispatches, 1, 'ambiguity declines correlation and preserves the ordinary provider path');
  assert.equal(listEvents(sess.id, { types: ['claude_local_permission_admitted'] }).length, 2);
  assert.equal(
    listEvents(sess.id, { types: ['tool_called'] }).length,
    1,
    'only the real inner transport call is counted; admission markers are not phantom calls',
  );
  assert.equal(
    listEvents(sess.id, { types: ['tool_called'] }).filter((event) => event.data.accounting === 'top_level').length,
    0,
    'the bridge never guesses which outer call owns the handler',
  );
});

test.after(() => {
  currentCapabilityFixtures.restoreCurrentCapabilityManifestFixtures(priorCapabilityFactory);
  rmSync(TMP, { recursive: true, force: true });
});
