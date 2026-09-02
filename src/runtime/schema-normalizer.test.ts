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

// Live 2026-09-01 (GLM 5.3): an omitted optional argument arrives as the STRING
// "null". Four exact shapes from one evening, each of which killed a turn.
test('the omission word "null" is an absent optional key, JSON null for a required nullable key, and a value only when required and non-nullable', () => {
  // task_list: priority is an optional enum — end-of-day died on it.
  const taskList = {
    type: 'object',
    properties: {
      status: { type: 'string' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'] },
      since: { type: 'string' },
      project: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['status'],
  };
  assert.deepEqual(
    materializeStrictNullableFields({ status: 'completed', priority: 'null', since: 'today', project: 'null', limit: 50 }, taskList),
    { status: 'completed', since: 'today', limit: 50 },
  );
  // workflow_get: step:"null" counted as "both section and step".
  const workflowGet = {
    type: 'object',
    properties: { name: { type: 'string' }, section: { type: 'string' }, step: { type: 'string' } },
    required: ['name'],
  };
  assert.deepEqual(
    materializeStrictNullableFields({ name: 'team-activity', section: 'metadata', step: 'null' }, workflowGet),
    { name: 'team-activity', section: 'metadata' },
  );
  // Codex-strict transports: a required nullable key is JSON null (tool_search
  // role_key/cursor; work_call lineage keys that must read as "no lineage").
  const strict = {
    type: 'object',
    properties: {
      query: { type: 'string' },
      role_key: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      source_call_ids: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
    },
    required: ['query', 'role_key', 'source_call_ids'],
  };
  assert.deepEqual(
    materializeStrictNullableFields({ query: 'run it', role_key: 'null', source_call_ids: 'None' }, strict),
    { query: 'run it', role_key: null, source_call_ids: null },
  );
  // A required, non-nullable string keeps the word so validation can name it.
  assert.deepEqual(
    materializeStrictNullableFields({ query: 'null' }, { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }),
    { query: 'null' },
  );
});

// Live 2026-09-02 (grok-4.6, the platform-49 sheet cleanup): work_call
// source_record_ids:[] was CORRECT for a fresh read with no lineage, but the
// field is nullable with minItems 1, so [] failed validation — and the SDK
// reports every parser failure as "Invalid JSON input for tool". The model was
// told its valid JSON was broken, re-sent the same correct call, and the
// no-progress governor ended the turn. An empty array IS the null the schema
// already accepts.
test('an empty array becomes null only when the schema rejects empty and accepts null', () => {
  const schema = {
    type: 'object',
    required: ['source_record_ids', 'source_call_ids', 'keep_empty', 'not_nullable'],
    properties: {
      source_record_ids: { anyOf: [{ type: 'array', items: { type: 'string' }, minItems: 1 }, { type: 'null' }] },
      source_call_ids: { anyOf: [{ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1 }, { type: 'null' }] },
      // No minItems: an empty list is legal, so it must be left alone.
      keep_empty: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
      // Rejects empty but does NOT accept null: leave it so validation names it.
      not_nullable: { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
  };
  const out = materializeStrictNullableFields({
    source_record_ids: [], source_call_ids: [], keep_empty: [], not_nullable: [],
  }, schema) as Record<string, unknown>;
  assert.equal(out.source_record_ids, null, 'nullable + minItems>=1 + [] => null');
  assert.equal(out.source_call_ids, null);
  assert.deepEqual(out.keep_empty, [], 'a list that legally accepts [] is untouched');
  assert.deepEqual(out.not_nullable, [], 'no null branch => leave it for validation to name');

  // A populated list is never touched.
  const populated = materializeStrictNullableFields({ source_record_ids: ['rec_1'] }, schema) as Record<string, unknown>;
  assert.deepEqual(populated.source_record_ids, ['rec_1']);
});
