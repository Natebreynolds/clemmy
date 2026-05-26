import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { normalizeZodForCodexStrict } from './schema-normalizer.js';

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
