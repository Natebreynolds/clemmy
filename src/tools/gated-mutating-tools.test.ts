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

const { createSession, listEvents } = await import('../runtime/harness/eventlog.js');
const destination = await import('../runtime/harness/destination-gate.js');
const { registerGatedMutatingTools, gatedMutationsEnabled, getGatedToolSchemas } = await import('./gated-mutating-tools.js');
const { getComputerTools } = await import('./computer-tools.js');
const { getComposioRuntimeTools } = await import('./composio-tools.js');
const { toolCallCorrelationFingerprint } = await import('../runtime/harness/tool-correlation.js');

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

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
});
