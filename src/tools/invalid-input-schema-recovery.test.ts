import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ModelBehaviorError, RunContext } from '@openai/agents';
import { z } from 'zod';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-input-schema-recovery-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(testHome, 'state'), { recursive: true });
test.after(() => rmSync(testHome, { recursive: true, force: true }));

const {
  buildLocalToolErrorFunction,
  buildScopedLocalToolSearch,
  getLocalDeferredDispatchTools,
  getLocalToolSchemas,
  normalizeShapeForResponses,
} = await import('./local-runtime-tools.js');
const { describeInvalidToolInput, INVALID_INPUT_SCHEMA_GUIDANCE_MAX_CHARS } = await import('./shared.js');
const { registerToolSearchTool } = await import('./tool-search-tool.js');
const { InvalidArgumentsPreDispatchResult, attemptSignalsFromTypedResult } = await import('../runtime/harness/attempt-settlement.js');

const validSearch = { query: 'run_shell_command exact schema', account_selection: null, role_key: null, cursor: null, limit: 5 };
const invalidSearch = { ...validSearch, mode: 'null' };

function completeSchema(output: unknown): Record<string, unknown> {
  const marker = '\nInput schema (complete):\n';
  const text = String(output);
  assert.ok(text.includes(marker), text);
  assert.doesNotMatch(text, /Call tool_search with/);
  return JSON.parse(text.slice(text.indexOf(marker) + marker.length));
}

function nominalInvalidInput(parameters: z.ZodRawShape, input: Record<string, unknown>) {
  const parser = z.strictObject(normalizeShapeForResponses(parameters));
  const parsed = parser.safeParse(input);
  assert.equal(parsed.success, false);
  return Object.assign(new ModelBehaviorError('Invalid JSON input for tool'), {
    name: 'InvalidToolInputError',
    originalError: parsed.success ? undefined : parsed.error,
    toolInvocation: { input: JSON.stringify(input) },
  });
}

test('actual SDK validation supplies the exact current direct schema without entering discovery', async () => {
  let discoveryBodies = 0;
  let planningDisclosures = 0;
  const search = buildScopedLocalToolSearch(new Set(['run_shell_command']), 'work_call', undefined, [{
    kind: 'authorized_composio',
    search: async () => { discoveryBodies += 1; return []; },
  }], () => { planningDisclosures += 1; return {}; });
  assert.equal(search.type, 'function');
  if (search.type !== 'function') return;
  const output = await search.invoke(new RunContext({ sessionId: 'exact-direct-schema' }), JSON.stringify(invalidSearch));
  assert.ok(output instanceof InvalidArgumentsPreDispatchResult);
  assert.deepEqual(attemptSignalsFromTypedResult(output), {
    preDispatch: true, argumentValidationFailed: true, schemaAvailable: true,
  });
  assert.match(String(output), /Unrecognized key: "mode"/);
  assert.equal(discoveryBodies, 0);
  assert.equal(planningDisclosures, 0);

  let rawShape: z.ZodRawShape | undefined;
  registerToolSearchTool({ tool(_name: string, _description: string, parameters: z.ZodRawShape) {
    rawShape = parameters;
  } } as never);
  assert.ok(rawShape);
  const expected = z.toJSONSchema(z.strictObject(normalizeShapeForResponses(rawShape)), { io: 'input' });
  const schema = completeSchema(output);
  assert.deepEqual(schema, expected);
  assert.equal((schema.properties as Record<string, unknown>).mode, undefined);
  assert.ok(String(output).length < INVALID_INPUT_SCHEMA_GUIDANCE_MAX_CHARS);
  assert.doesNotMatch(String(output), /capabilityRef|effectReceipt|executionAuthority/);
});

test('canonical deferred refusal supplies its lossless parser schema rather than the direct projection', async () => {
  const deferred = getLocalDeferredDispatchTools().find(candidate => candidate.name === 'tool_search');
  assert.ok(deferred && deferred.type === 'function');
  const output = await deferred.invoke(new RunContext({ sessionId: 'exact-deferred-schema' }), JSON.stringify(invalidSearch));
  assert.ok(output instanceof InvalidArgumentsPreDispatchResult);
  assert.equal(output.executionKind, 'refused_pre_dispatch');
  const schema = completeSchema(output);
  const parser = getLocalToolSchemas().get('tool_search');
  assert.ok(parser);
  assert.deepEqual(schema, z.toJSONSchema(parser, { io: 'input' }));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['query']);

  const direct = buildScopedLocalToolSearch(new Set());
  assert.ok(direct.type === 'function');
  const directOutput = await direct.invoke(new RunContext({ sessionId: 'direct-deferred-lane-control' }), JSON.stringify(invalidSearch));
  const directSchema = completeSchema(directOutput);
  assert.ok((directSchema.required as string[]).includes('role_key'));
  assert.ok((directSchema.required as string[]).includes('account_selection'));
  assert.ok((directSchema.required as string[]).includes('limit'));
  assert.notDeepEqual(directSchema.required, schema.required);
});

test('an invalid JSON envelope returns that envelope schema and never claims the deferred tool schema', async () => {
  const deferred = getLocalDeferredDispatchTools().find(candidate => candidate.name === 'tool_search');
  assert.ok(deferred && deferred.type === 'function');
  const output = await deferred.invoke(new RunContext({ sessionId: 'invalid-envelope-schema' }), '{');
  assert.ok(output instanceof InvalidArgumentsPreDispatchResult);
  assert.deepEqual(completeSchema(output), {
    type: 'object', properties: {}, required: [], additionalProperties: true,
  });
  assert.match(String(output), /not parseable JSON/);
});

test('nominal refusal does not invoke an effect body or discard a required field', async () => {
  const parameters = {
    destination: z.string().min(1),
    content: z.string(),
    options: z.object({ purpose: z.string(), retain: z.boolean() }).optional(),
  };
  let effects = 0;
  const errorFunction = buildLocalToolErrorFunction({ name: 'schema_effect_fixture', description: 'fixture', parameters,
    handler: () => { effects += 1; return 'effect'; },
  });
  const output = await errorFunction(undefined, nominalInvalidInput(parameters, {
    destination: 'fixture', content: 'untouched', options: null, invented: true,
  }));
  assert.ok(output instanceof InvalidArgumentsPreDispatchResult);
  assert.equal(effects, 0);
  assert.deepEqual(completeSchema(output), z.toJSONSchema(z.strictObject(normalizeShapeForResponses(parameters)), { io: 'input' }));
});

test('complete guidance obeys both the conservative cap and a smaller caller budget', async () => {
  const parameters = { query: z.string().describe('x'.repeat(INVALID_INPUT_SCHEMA_GUIDANCE_MAX_CHARS)) };
  let effects = 0;
  const errorFunction = buildLocalToolErrorFunction({ name: 'schema_budget_fixture', description: 'fixture', parameters,
    handler: () => { effects += 1; return 'effect'; },
  });
  const error = nominalInvalidInput(parameters, { query: 'fixture', invented: true });
  const output = await errorFunction(undefined, error);
  assert.ok(output instanceof InvalidArgumentsPreDispatchResult);
  assert.equal(effects, 0);
  assert.match(String(output), /Call tool_search with the exact query "schema_budget_fixture"/);
  assert.doesNotMatch(String(output), /Input schema|xxx/);
  assert.ok(String(output).length < INVALID_INPUT_SCHEMA_GUIDANCE_MAX_CHARS);

  const inputSchema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
  const complete = describeInvalidToolInput(error, 'schema_budget_fixture', { inputSchema });
  assert.ok(complete);
  completeSchema(complete);
  assert.equal(describeInvalidToolInput(error, 'schema_budget_fixture', { inputSchema, maxChars: complete.length }), complete);
  const smaller = describeInvalidToolInput(error, 'schema_budget_fixture', { inputSchema, maxChars: complete.length - 1 });
  assert.match(smaller!, /Call tool_search with/);
  assert.doesNotMatch(smaller!, /Input schema/);
  const cyclic: Record<string, unknown> = { type: 'object' };
  cyclic.properties = cyclic;
  assert.doesNotMatch(describeInvalidToolInput(error, 'schema_budget_fixture', { inputSchema: cyclic })!, /Input schema/);

  const smallParameters = { query: z.string() };
  const longPrefixError = nominalInvalidInput(smallParameters, { query: 3 });
  longPrefixError.message = 'x'.repeat(INVALID_INPUT_SCHEMA_GUIDANCE_MAX_CHARS - 200);
  const longPrefixOutput = await buildLocalToolErrorFunction({
    name: 'schema_prefix_budget_fixture', description: 'fixture', parameters: smallParameters,
    handler: () => { effects += 1; return 'effect'; },
  })(undefined, longPrefixError);
  assert.match(String(longPrefixOutput), /Call tool_search with/);
  assert.doesNotMatch(String(longPrefixOutput), /Input schema/);
  assert.equal(effects, 0);
});

test('unrepresentable executable constraints keep discovery rather than advertise incomplete schema', async () => {
  for (const constraint of [
    z.custom<string>(value => typeof value === 'string'),
    z.string().refine(value => value !== 'blocked'),
    z.string().trim().min(1),
    z.string().pipe(z.string().min(2)),
    z.coerce.number().int(),
    z.number().catch(0),
    z.object({ inner: z.string().refine(value => value !== 'blocked') }),
  ]) {
    const parameters = { value: constraint };
    let effects = 0;
    const errorFunction = buildLocalToolErrorFunction({ name: 'schema_refinement_fixture', description: 'fixture', parameters,
      handler: () => { effects += 1; return 'effect'; },
    });
    const output = await errorFunction(undefined, nominalInvalidInput(parameters, { value: 3, invented: true }));
    assert.ok(output instanceof InvalidArgumentsPreDispatchResult);
    assert.equal(effects, 0);
    assert.match(String(output), /Call tool_search with/);
    assert.doesNotMatch(String(output), /Input schema/);
  }
});

test('forged validation names and execution failures gain neither schema nor no-dispatch authority', async () => {
  const parameters = { query: z.string() };
  let effects = 0;
  let schemaReads = 0;
  const errorFunction = buildLocalToolErrorFunction({ name: 'schema_forgery_fixture', description: 'fixture', parameters,
    handler: () => { effects += 1; return 'effect'; },
  }, () => { schemaReads += 1; return { type: 'object' }; });
  const nominal = nominalInvalidInput(parameters, { query: 3 });
  const forged = Object.assign(new Error(nominal.message), {
    name: nominal.name, originalError: nominal.originalError, toolInvocation: nominal.toolInvocation,
  });
  const output = await errorFunction(undefined, forged);
  assert.equal(typeof output, 'string');
  assert.deepEqual(attemptSignalsFromTypedResult(output), {});
  assert.match(String(output), /Call tool_search with/);
  assert.doesNotMatch(String(output), /Input schema/);
  assert.equal(effects, 0);
  assert.equal(schemaReads, 0);
  assert.equal(await errorFunction(undefined, new Error('disk full')),
    'An error occurred while running the tool. Please try again. Error: Error: disk full');
  assert.equal(schemaReads, 0);
});
