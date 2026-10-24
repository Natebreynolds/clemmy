import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-work-call-json-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const {
  buildWorkCall, WorkCallInputSchema, HostPlannedWorkCallInputSchema,
  workCallInputFromHostPlan, renderWorkCallReadyBlock, ownToolCarrierRepair,
} = await import('./work-call.js');
const { serializeAdvertisedTools } = await import('../runtime/harness/advertised-tool-wire.js');
const { durableLogicalCallContract } = await import('../runtime/harness/logical-call-contract.js');
const { toolCallCorrelationFingerprint } = await import('../runtime/harness/tool-correlation.js');
const { InvalidArgumentsPreDispatchResult } = await import('../runtime/harness/attempt-settlement.js');
const eventlog = await import('../runtime/harness/eventlog.js');

after(() => {
  eventlog.closeEventLog();
  rmSync(testHome, { recursive: true, force: true });
});

const payload = {
  slug: 'harness-structured-arguments',
  view_html: '<main data-label="Clem">quotes \\" \\ paths\n雪 🦊</main>',
  initial_data_json: { _mobile: { items: [{ title: 'a', done: false }] }, count: 7, ratio: 1.25, absent: null },
};

test('actual advertised work_call preserves heterogeneous object args without strict SDK conversion', () => {
  for (const requireHostPlan of [false, true]) {
    const configured = buildWorkCall({ requireHostPlan }) as never;
    const wire = serializeAdvertisedTools([configured])[0] as {
      strict: boolean;
      parameters: { additionalProperties: boolean; properties: Record<string, { anyOf?: Array<{ type?: string; additionalProperties?: unknown }> }> };
    };
    assert.equal(wire.strict, false, 'open target JSON uses the bounded non-strict carrier grammar');
    assert.equal(wire.parameters.additionalProperties, false, 'the exact outer parser still rejects unknown carrier fields');
    const alternatives = wire.parameters.properties.args_json!.anyOf!;
    assert.ok(alternatives.some((branch) => branch.type === 'string'), 'legacy text is advertised');
    const object = alternatives.find((branch) => branch.type === 'object');
    assert.ok(object, 'the advertised wire, not just the local parser, accepts object arguments');
    assert.notEqual(object.additionalProperties, false, 'heterogeneous target fields must not be narrowed to an empty object');
  }
});

test('object and legacy text keep the same effective arguments, logical digest and permission correlation', () => {
  const object = HostPlannedWorkCallInputSchema.parse({
    requirement_id: 'save', name: 'space_save', args_json: payload,
  });
  const text = { ...object, args_json: JSON.stringify(payload) };
  const liftedObject = workCallInputFromHostPlan(object);
  const liftedText = workCallInputFromHostPlan(text);
  assert.equal(liftedObject.args_json, liftedText.args_json);
  assert.deepEqual(JSON.parse(String(liftedObject.args_json)), payload);
  const objectContract = durableLogicalCallContract('accepted:structured-args', 'work_call', object);
  const textContract = durableLogicalCallContract('accepted:structured-args', 'work_call', text);
  assert.ok(objectContract);
  assert.deepEqual(objectContract, textContract, 'representation cannot mint a different effective invocation');
  assert.equal(toolCallCorrelationFingerprint('work_call', object), toolCallCorrelationFingerprint('work_call', text));
  assert.ok(WorkCallInputSchema.safeParse({ ...liftedObject, args_json: payload }).success);
});

test('raw JSON-schema tool still refuses invalid outer calls nominally before target dispatch', async () => {
  const configured = buildWorkCall({ requireHostPlan: true }) as unknown as {
    invoke: (context: unknown, input: string) => Promise<unknown>;
  };
  const valid = { requirement_id: 'save', name: 'space_save', args_json: payload };
  for (const input of [
    { ...valid, args_json: null }, { ...valid, args_json: [] },
    { ...valid, args_json: 1 }, { ...valid, args_json: false },
    { ...valid, name: '' }, { ...valid, requirement_id: '' },
    { ...valid, unexpected_authority: true },
    { name: valid.name, args_json: payload },
  ]) {
    const result = await configured.invoke({}, JSON.stringify(input));
    assert.ok(result instanceof InvalidArgumentsPreDispatchResult);
    const refusal = JSON.parse(result.output);
    assert.equal(refusal.dispatch_state, 'not_started');
    assert.equal(refusal.error, 'work_contract_invalid');
  }
});

test('a stray operation argument on the carrier is named with the fields work_call takes and where it belongs', async () => {
  const configured = buildWorkCall({ requireHostPlan: true }) as unknown as {
    invoke: (context: unknown, input: string) => Promise<unknown>;
  };
  const result = await configured.invoke({}, JSON.stringify({ requirement_id: 'run', name: 'composio_execute_tool', tool_slug: 'GMAIL_FETCH', args_json: {} }));
  assert.ok(result instanceof InvalidArgumentsPreDispatchResult);
  const refusal = JSON.parse(result.output);
  assert.ok(refusal.carrier_fields.includes('args_json') && refusal.carrier_fields.includes('name'));
  assert.match(refusal.move, /tool_slug is an argument of the operation named in name.*inside args_json/);
});

test('permission correlation includes opaque JSON data keys and still matches equivalent transport spellings', () => {
  const wire = (value: number) => ({
    name: 'space_save',
    args_json: JSON.parse(`{"slug":"fixture","initial_data_json":{"__proto__":{"fixture":${value}}}}`),
  });
  const first = wire(1);
  const changed = wire(2);
  assert.notEqual(toolCallCorrelationFingerprint('work_call', first), toolCallCorrelationFingerprint('work_call', changed));
  assert.equal(toolCallCorrelationFingerprint('work_call', first),
    toolCallCorrelationFingerprint('work_call', { ...first, args_json: JSON.stringify(first.args_json) }));
  assert.notEqual(durableLogicalCallContract('fixture', 'work_call', first)?.argumentDigest,
    durableLogicalCallContract('fixture', 'work_call', changed)?.argumentDigest);
});

test('ready-operation guidance teaches the supported object form', () => {
  const block = renderWorkCallReadyBlock([{
    id: 'cap:local:space_save:default', effect: 'write', purpose: 'save an authorized artifact',
  } as never]);
  assert.ok(block);
  assert.match(block, /"args_json":\{"<arg>":"<value>"\}/);
  assert.doesNotMatch(block, /JSON STRING, not an object/);
});

test('one of Clem\'s own tools sent through work_call without a plan is told its door, not sent to plan', () => {
  const repair = ownToolCarrierRepair('memory_remember');
  assert.match(repair ?? '', /memory_remember is one of Clem's own tools/);
  assert.match(repair ?? '', /call_tool\(\{name: "memory_remember"/);
  assert.doesNotMatch(repair ?? '', /plan_task/);
  assert.equal(ownToolCarrierRepair('composio_execute_tool'), null, 'a business operation keeps the plan barrier');
  assert.equal(ownToolCarrierRepair('no_such_tool'), null);
});
