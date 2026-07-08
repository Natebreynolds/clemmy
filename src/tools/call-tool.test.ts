/**
 * Run: npx tsx --test src/tools/call-tool.test.ts
 *
 * call_tool — the schema-on-demand generic dispatcher (Phase 1). Proves:
 *  - AUTHORITY: refuses a target that is not on the orchestrator surface (no escalation).
 *  - ARG VALIDATION: bad args return {error:'arg_validation', schema} with NO dispatch.
 *  - GATE PARITY: a mutating inner tool routed through call_tool trips the SAME
 *    write-boundary gate (keyed on the INNER name), via the _setCodeModeToolsForTests seam.
 *  - PROMOTION: a successful dispatch records the reached tool to the session hot-set.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-call-tool-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildCallTool, _resetCallToolSchemaCacheForTest } = await import('./call-tool.js');
const { _setCodeModeToolsForTests } = await import('./code-mode-tool.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { getHotSet, _resetHotSetForTest } = await import('../agents/tool-hotset.js');
const { resetEventLog, createSession, listEvents } = await import('../runtime/harness/eventlog.js');
const { getLocalToolSchemas } = await import('./local-runtime-tools.js');
const { deriveOrchestratorDiscoveryNames } = await import('./tool-registry.js');

type ToolLike = { invoke?: (ctx: unknown, input: string, details: unknown) => Promise<unknown> };

function invokeCallTool(sessionId: string, name: string, argsJson: string): Promise<unknown> {
  const callTool = buildCallTool() as unknown as ToolLike;
  return withToolOutputContext({ sessionId }, () =>
    callTool.invoke!(
      { context: { sessionId } },
      JSON.stringify({ name, args_json: argsJson }),
      { toolCall: { callId: `call-${Math.random()}` } },
    ) as Promise<unknown>,
  );
}

test('refuses a target that is not on the orchestrator surface (no escalation)', async () => {
  // cron_list is a cli-only tool (never on the chat surface); nonexistent is unknown.
  for (const target of ['cron_list', 'nonexistent_tool_xyz']) {
    const out = JSON.parse(String(await invokeCallTool('sess-auth', target, '{}')));
    assert.equal(out.error, 'not_reachable', `${target} should be refused`);
  }
  // sanity: the guard is not refusing everything — an orchestrator tool is reachable.
  assert.ok(deriveOrchestratorDiscoveryNames().has('composio_execute_tool'));
});

test('bad args return the schema with error=arg_validation and NO dispatch', async () => {
  _resetHotSetForTest();
  _resetCallToolSchemaCacheForTest();
  // Find a lane-orchestrator tool whose schema rejects {} (has a required field).
  const schemas = getLocalToolSchemas();
  const allowed = deriveOrchestratorDiscoveryNames();
  const target = [...allowed].find((n) => {
    const s = schemas.get(n);
    return s ? !s.safeParse({}).success : false;
  });
  assert.ok(target, 'expected at least one orchestrator tool with a required arg');

  const out = JSON.parse(String(await invokeCallTool('sess-argval', target!, '{}')));
  assert.equal(out.error, 'arg_validation');
  assert.ok(out.schema && typeof out.schema === 'object', 'returns the target JSON schema');
  assert.ok(typeof out.detail === 'string' && out.detail.length > 0, 'returns a detail message');
  // No dispatch happened → the tool was never promoted to the hot-set.
  assert.ok(!getHotSet('sess-argval').includes(target!), 'a validation miss must not dispatch');
});

test('invalid JSON in args_json returns arg_validation with no dispatch', async () => {
  const out = JSON.parse(String(await invokeCallTool('sess-json', 'composio_execute_tool', '{not json')));
  assert.equal(out.error, 'arg_validation');
});

test('gate parity: a mutating inner tool routed through call_tool trips the write boundary (keyed on inner name)', async () => {
  const prev = {
    brackets: process.env.HARNESS_TOOL_BRACKETS,
    confirm: process.env.CLEMMY_CONFIRM_FIRST,
    execGate: process.env.CLEMMY_EXECUTION_GATE,
  };
  process.env.HARNESS_TOOL_BRACKETS = 'on';
  process.env.CLEMMY_CONFIRM_FIRST = 'on';
  process.env.CLEMMY_EXECUTION_GATE = 'off'; // isolate the confirm-first batch gate
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  // Inject a fake inner composio_execute_tool. dispatchBatchItemTool wraps THIS via
  // wrapToolForHarness, so the write boundary keys on 'composio_execute_tool' (inner).
  _setCodeModeToolsForTests(
    new Map([['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'sent' }]]),
  );
  try {
    const send = (n: number) =>
      invokeCallTool(
        sess.id,
        'composio_execute_tool',
        JSON.stringify({ tool_slug: 'GMAIL_SEND_EMAIL', arguments: JSON.stringify({ to: `p${n}@x.com` }) }),
      );
    let sawInnerKeyedNudge = false;
    for (let n = 1; n <= 3; n += 1) {
      const out = String(await send(n));
      assert.ok(out.startsWith('sent'), `send #${n} passes through the gated inner tool`);
      // The write-boundary guardrail fires keyed on the INNER slug — not "call_tool".
      if (out.includes('GMAIL_SEND_EMAIL') && out.includes('fan-out')) sawInnerKeyedNudge = true;
    }
    assert.ok(sawInnerKeyedNudge, 'the write-boundary guardrail keyed on the INNER tool (GMAIL_SEND_EMAIL), proving gate parity');
    // Direct signal: the harness recorded external_write events for the inner tool.
    const writes = listEvents(sess.id, { types: ['external_write'] });
    assert.ok(writes.length >= 3, `write-boundary ledger recorded the inner sends (got ${writes.length})`);
  } finally {
    _setCodeModeToolsForTests(null);
    process.env.HARNESS_TOOL_BRACKETS = prev.brackets;
    process.env.CLEMMY_CONFIRM_FIRST = prev.confirm;
    process.env.CLEMMY_EXECUTION_GATE = prev.execGate;
  }
});

test('a successful dispatch records the reached tool to the session hot-set', async () => {
  _resetHotSetForTest();
  // Fake read inner tool (a read slug → no gate) so dispatch is deterministic.
  _setCodeModeToolsForTests(
    new Map([['composio_execute_tool', { name: 'composio_execute_tool', invoke: async () => 'ok' }]]),
  );
  try {
    const out = await invokeCallTool(
      'sess-lru',
      'composio_execute_tool',
      JSON.stringify({ tool_slug: 'APIFY_GET_DATASET_ITEMS', arguments: '{}' }),
    );
    assert.equal(String(out), 'ok');
    assert.ok(getHotSet('sess-lru').includes('composio_execute_tool'), 'reached tool is promoted to the hot-set');
  } finally {
    _setCodeModeToolsForTests(null);
  }
});
