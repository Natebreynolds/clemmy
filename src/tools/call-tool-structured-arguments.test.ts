/** Run: node scripts/run-tests-isolated.mjs src/tools/call-tool-structured-arguments.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { z } from 'zod';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-call-tool-structured-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });

const { buildCallTool, registerCallToolMcp, resolvedDispatchPreparedWithoutExecution } = await import('./call-tool.js');
const { serializeAdvertisedTools } = await import('../runtime/harness/advertised-tool-wire.js');
const { durableLogicalCallContract } = await import('../runtime/harness/logical-call-contract.js');
const { InvalidArgumentsPreDispatchResult } = await import('../runtime/harness/attempt-settlement.js');
const { ToolCallsCounter, ToolCallsLimitExceeded, withHarnessRunContext, wrapToolForHarness } = await import('../runtime/harness/brackets.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { appendEvent, closeEventLog, createSession, openEventLog } = await import('../runtime/harness/eventlog.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const { closeOperationalTelemetryDb } = await import('../runtime/operational-telemetry.js');

test.after(() => {
  closeEventLog();
  closeOperationalTelemetryDb();
  rmSync(fixtureHome, { recursive: true, force: true });
});

type CarrierTool = {
  type: string;
  name: string;
  strict: boolean;
  parameters: Record<string, unknown>;
  invoke(context: unknown, input: string, details?: unknown): Promise<unknown>;
};

function preparationFixture() {
  const prepared: Array<{ targetName: string; targetArgs: unknown; targetInputSchema: unknown }> = [];
  let acquisitions = 0;
  const options = {
    reachableBuiltinNames: new Set(['run_shell_command']),
    onBuiltinAcquisition: () => { acquisitions += 1; },
    aroundResolvedDispatch: async (input: typeof prepared[number]) => {
      prepared.push(input);
      // This fixture stops at the existing preparation boundary. It never
      // invokes the shell or any other inner tool.
      return resolvedDispatchPreparedWithoutExecution();
    },
  };
  return { options, prepared, acquisitions: () => acquisitions,
    carrier: buildCallTool(options) as unknown as CarrierTool };
}

const payload = {
  command: 'Fixture text only: "quoted" \\path\n<div data-value="{braces}">🌿 café</div>',
  cwd: null,
  timeout_ms: 1200,
};

test('the final advertised call_tool schema accepts heterogeneous JSON objects and legacy strings', () => {
  const { carrier } = preparationFixture();
  const [wire] = serializeAdvertisedTools([carrier]) as Array<{ strict: boolean; parameters: object }>;
  assert.equal(carrier.strict, false);
  assert.equal(wire!.strict, false, 'free-form argument keys do not enter provider-strict conversion');
  const validate = new Ajv2020({ strict: false }).compile(wire!.parameters);
  const nested = { text: payload.command, number: 17, flag: false, empty: null,
    array: [1, 'two', null, { nested: true }], object: { name: 'data', method: 'data', arguments: { key: 3 } } };
  for (const args_json of [nested, JSON.stringify(nested), {}]) {
    assert.equal(validate({ name: 'fixture_tool', args_json }), true, JSON.stringify(validate.errors));
  }
  for (const args_json of [null, [], 1, true]) {
    assert.equal(validate({ name: 'fixture_tool', args_json }), false);
  }
  assert.equal(validate({ name: 'fixture_tool', args_json: {}, extra: 'not a carrier field' }), false);
});

test('object and legacy string carriers prepare identical target arguments and logical contracts', async () => {
  const fixture = preparationFixture();
  for (const args_json of [payload, JSON.stringify(payload, null, 2)]) {
    await fixture.carrier.invoke({ context: { sessionId: 'structured-preparation-fixture' } },
      JSON.stringify({ name: 'run_shell_command', args_json }));
  }
  assert.equal(fixture.prepared.length, 2);
  assert.equal(fixture.acquisitions(), 2);
  for (const prepared of fixture.prepared) {
    assert.equal(prepared.targetName, 'run_shell_command');
    assert.deepEqual(prepared.targetArgs, payload, 'quoted and Unicode text reaches the exact target schema unchanged');
    assert.ok(prepared.targetInputSchema);
  }
  const objectContract = durableLogicalCallContract('structured-call-tool-fixture', 'call_tool',
    { name: 'run_shell_command', args_json: payload });
  const stringContract = durableLogicalCallContract('structured-call-tool-fixture', 'call_tool',
    { name: 'run_shell_command', args_json: JSON.stringify(payload) });
  assert.ok(objectContract && stringContract, 'both forms must produce a real logical contract');
  assert.deepEqual(objectContract, stringContract);
  const refused = await fixture.carrier.invoke({ context: { sessionId: 'structured-preparation-fixture' } },
    JSON.stringify({ name: 'run_shell_command', args_json: { ...payload, unknown_argument: 'preserve the refusal' } }));
  assert.ok(refused instanceof InvalidArgumentsPreDispatchResult);
  assert.equal(fixture.prepared.length, 2, 'an invalid target object cannot reach preparation or dispatch');
  assert.equal(fixture.acquisitions(), 2);
});

test('invalid outer objects return nominal pre-dispatch refusals before any inner acquisition', async () => {
  const fixture = preparationFixture();
  const invalid = [
    { args_json: payload },
    { name: 'run_shell_command' },
    { name: 'run_shell_command', args_json: [] },
    { name: 'run_shell_command', args_json: null },
    { name: 'run_shell_command', args_json: payload, extra: 'not a carrier field' },
  ];
  for (const input of invalid) {
    const result = await fixture.carrier.invoke({ context: { sessionId: 'structured-invalid-fixture' } }, JSON.stringify(input));
    assert.ok(result instanceof InvalidArgumentsPreDispatchResult);
    assert.equal(result.executionKind, 'refused_pre_dispatch');
    assert.ok(result.repairKey);
    assert.match(String(result), /Input schema \(complete\)/);
  }
  const malformed = await fixture.carrier.invoke({ context: { sessionId: 'structured-invalid-fixture' } },
    JSON.stringify({ name: 'run_shell_command', args_json: '{"command":"unfinished"' }));
  assert.match(String(malformed), /args_json is not valid JSON/);
  assert.equal(fixture.acquisitions(), 0);
  assert.equal(fixture.prepared.length, 0);
});

for (const hostOwnsToolAccounting of [false, true]) {
  test(`wrapped invalid outer carrier is charged exactly once with ${hostOwnsToolAccounting ? 'host' : 'legacy'} accounting`, async () => {
    const fixture = preparationFixture();
    const session = createSession({ kind: 'chat' });
    const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
      data: { text: 'Controlled generic carrier argument-validation fixture.' } });
    assert.ok(recordTurnGraphShadow({ identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn } }));
    const wrapped = wrapToolForHarness(fixture.carrier as never) as unknown as CarrierTool;
    const counter = new ToolCallsCounter(1);
    if (hostOwnsToolAccounting) counter.increment();
    const context = { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn, counter, hostOwnsToolAccounting };
    const invoke = (callId: string) => withHarnessRunContext(context, () => wrapped.invoke(
      { context }, JSON.stringify({ name: 'run_shell_command', args_json: [] }), { toolCall: { callId } }));
    const output = await invoke('invalid-outer-once');
    assert.match(String(output), /InvalidToolInputError/);
    assert.match(String(output), /Input schema \(complete\)/);
    assert.equal(counter.calls, 1, 'the wrapper and local validator share one attempt owner');
    assert.equal(fixture.acquisitions(), 0);
    assert.equal(fixture.prepared.length, 0);
    const settlement = openEventLog().prepare(`SELECT outcome_kind, physical_crossing_count FROM logical_call_settlements
      WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`)
      .get(session.id, source.seq, 'invalid-outer-once') as { outcome_kind: string; physical_crossing_count: number } | undefined;
    assert.ok(settlement, 'the nominal local refusal settles the wrapped call');
    assert.equal(settlement.outcome_kind, 'invalid_arguments');
    assert.equal(settlement.physical_crossing_count, 0);
    if (!hostOwnsToolAccounting) {
      await assert.rejects(() => invoke('invalid-outer-over-cap'), ToolCallsLimitExceeded);
      assert.equal(counter.calls, 1, 'the cap stops another attempt before an additional charge');
    }
  });
}

test('Claude MCP uses the same closed outer schema and keeps structured arguments intact', async () => {
  const fixture = preparationFixture();
  let schema: z.ZodType | undefined;
  let handler: ((input: unknown) => Promise<unknown>) | undefined;
  registerCallToolMcp({ registerTool(name: string, config: { inputSchema: z.ZodType }, callback: typeof handler) {
    assert.equal(name, 'call_tool');
    schema = config.inputSchema;
    handler = callback;
  } } as never, fixture.options);
  assert.ok(schema && handler);
  const input = { name: 'run_shell_command', args_json: payload };
  assert.equal(schema.safeParse(input).success, true);
  assert.equal(schema.safeParse({ ...input, extra: 'not a carrier field' }).success, false);
  const before = JSON.stringify(input);
  await withToolOutputContext({ sessionId: 'structured-mcp-fixture' }, () => handler!(input));
  assert.equal(JSON.stringify(input), before, 'the adapter never rewrites the original MCP input');
  assert.equal(typeof input.args_json, 'object');
  assert.equal(fixture.prepared.length, 1);
  assert.deepEqual(fixture.prepared[0]!.targetArgs, payload);
});
