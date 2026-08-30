import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  materializeStrictNullableFields,
  normalizeZodForCodexStrict,
  normalizeZodForDeferredJson,
} from './schema-normalizer.js';

function containsKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  return Object.values(value).some((item) => containsKey(item, key));
}

test('normalizeZodForCodexStrict rewrites records without JSON Schema propertyNames', () => {
  const schema = normalizeZodForCodexStrict(z.record(z.string(), z.string()));
  const json = z.toJSONSchema(schema) as Record<string, unknown>;

  assert.equal(containsKey(json, 'propertyNames'), false);
  assert.deepEqual(json.additionalProperties, { type: 'string' });
});

test('normalizeZodForCodexStrict keeps optional record fields required-and-nullable', () => {
  const schema = normalizeZodForCodexStrict(z.object({
    inputs: z.record(z.string(), z.object({
      type: z.enum(['string', 'number']).optional(),
      default: z.string().optional(),
      description: z.string().optional(),
    })).optional(),
  }));
  const json = z.toJSONSchema(schema) as any;

  assert.deepEqual(json.required, ['inputs']);
  assert.equal(containsKey(json, 'propertyNames'), false);
  const objectBranch = json.properties.inputs.anyOf[0];
  assert.deepEqual(objectBranch.properties, {});
  assert.ok(objectBranch.additionalProperties);
  assert.deepEqual(objectBranch.additionalProperties.required, ['type', 'default', 'description']);
});

test('deferred JSON preserves heterogeneous values inside open records', () => {
  const schema = normalizeZodForDeferredJson(z.object({
    args: z.record(z.string(), z.unknown()),
  }));
  const payload = {
    args: {
      text: 'inbox',
      limit: 1,
      fields: ['subject', 'receivedDateTime'],
      filter: { unread: true },
      nullable: null,
    },
  };

  assert.equal(schema.safeParse(payload).success, true);
  for (const invalid of [undefined, Number.POSITIVE_INFINITY, 1n, () => 'not JSON']) {
    assert.equal(schema.safeParse({ args: { invalid } }).success, false,
      `${String(invalid)} must not cross the ordinary JSON carrier`);
  }
  const json = z.toJSONSchema(schema) as any;
  assert.equal(typeof json.properties.args.additionalProperties, 'object');
  assert.notEqual(json.properties.args.additionalProperties, null,
    'the deferred schema advertises arbitrary JSON values instead of falsely narrowing them to strings');
});

test('deferred JSON preserves record key constraints as well as JSON values', () => {
  const schema = normalizeZodForDeferredJson(z.object({
    metrics: z.record(z.string().regex(/^data\.[a-z0-9_.]+$/), z.unknown()),
  }));

  assert.equal(schema.safeParse({ metrics: { 'data.value': 1 } }).success, true);
  assert.equal(schema.safeParse({ metrics: { unexpected: 1 } }).success, false,
    'normalization must not widen a constrained record into arbitrary keys');
  assert.equal(schema.safeParse({ metrics: { 'data.value': ['mixed', 2, null] } }).success, true,
    'the constrained record still carries arbitrary JSON values');
});

test('strict nullable materialization selects an object-union branch by its exact discriminator', () => {
  const strict = z.toJSONSchema(normalizeZodForCodexStrict(z.object({
    partition: z.discriminatedUnion('mode', [
      z.object({
        mode: z.literal('single'),
        outcomeAuthority: z.object({ version: z.literal(1) }).optional(),
      }).strict(),
      z.object({
        mode: z.literal('finite'),
        expected: z.number().int().positive(),
      }).strict(),
    ]),
  })));
  const finite = { partition: { mode: 'finite', expected: 120 } };

  assert.deepEqual(materializeStrictNullableFields(finite, strict), finite,
    'a nullable field from the single branch must not be injected into a finite payload');
  assert.deepEqual(materializeStrictNullableFields({ partition: { mode: 'single' } }, strict), {
    partition: { mode: 'single', outcomeAuthority: null },
  });
});

test('strict nullable materialization treats empty string as omitted, not too-short', () => {
  const strict = z.toJSONSchema(normalizeZodForCodexStrict(z.object({
    query: z.string().min(1),
    cursor: z.string().min(1).max(160).nullable().default(null),
  })));
  assert.deepEqual(
    materializeStrictNullableFields({ query: 'calendar', cursor: '' }, strict),
    { query: 'calendar', cursor: null },
  );
  assert.deepEqual(
    materializeStrictNullableFields({ query: 'calendar', cursor: '   ' }, strict),
    { query: 'calendar', cursor: null },
  );
  assert.deepEqual(
    materializeStrictNullableFields({ query: 'calendar', cursor: 'tool_search_page:v1:abc' }, strict),
    { query: 'calendar', cursor: 'tool_search_page:v1:abc' },
    'a real continuation is not coerced',
  );
});
