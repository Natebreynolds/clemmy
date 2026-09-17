import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { repairNativeArguments } from './native-argument-repair.js';

const read = z.strictObject({ slug: z.string().min(2), source_id: z.string().nullable() });
const edit = z.strictObject({
  slug: z.string().min(2),
  edits: z.array(z.strictObject({ find: z.string().min(1), replace: z.string() })).min(1),
});

test('a read with an identifier under another name is completed from its own schema', () => {
  const repaired = repairNativeArguments(read, { space_id: 'my-day', source_id: null }, { sideEffect: 'read' });
  assert.deepEqual(repaired?.args, { slug: 'my-day', source_id: null });
  assert.equal(repaired?.repair, 'renamed_field');
});

test('a rename never completes a write, and never guesses between several unknown fields', () => {
  assert.equal(repairNativeArguments(read, { space_id: 'my-day', source_id: null }, { sideEffect: 'write' }), null);
  assert.equal(repairNativeArguments(read, { space_id: 'my-day', workspace: 'my-day', source_id: null }, { sideEffect: 'read' }), null);
  assert.equal(repairNativeArguments(read, { space_id: 42, source_id: null }, { sideEffect: 'read' }), null, 'the value must validate');
});

test('one item sent where a list is expected is wrapped for a write, but never for a send', () => {
  const repaired = repairNativeArguments(edit, { slug: 'my-day', find: 'old', replace: 'new' }, { sideEffect: 'write' });
  assert.deepEqual(repaired?.args, { slug: 'my-day', edits: [{ find: 'old', replace: 'new' }] });
  assert.equal(repaired?.repair, 'wrapped_single_item');
  assert.equal(repairNativeArguments(edit, { slug: 'my-day', find: 'old', replace: 'new' }, { sideEffect: 'send' }), null);
  assert.equal(repairNativeArguments(edit, { slug: 'my-day', find: 'old', replace: 'new' }, { sideEffect: 'admin' }), null);
  assert.equal(repairNativeArguments(edit, { slug: 'my-day', find: 'old', replace: 'new', note: 'x' }, { sideEffect: 'write' }), null,
    'an extra field that does not belong to the item keeps the refusal');
});

test('other invalid calls are left for the ordinary refusal', () => {
  assert.equal(repairNativeArguments(edit, { slug: 'my-day', edits: [{ find: 'a', replace: 'b', replace_note: 'x' }] }, { sideEffect: 'write' }), null);
  assert.equal(repairNativeArguments(read, { slug: 'x', source_id: null }, { sideEffect: 'read' }), null, 'a failing value is not a shape problem');
  assert.equal(repairNativeArguments(read, { slug: 'my-day', source_id: null }, { sideEffect: 'read' }), null, 'a valid call needs nothing');
});

test('a number or boolean sent as its exact canonical text is read as that value', () => {
  const preview = z.strictObject({
    slug: z.string().min(2),
    width: z.number().int().min(360).max(4000).nullable().optional(),
    offset_y: z.number().int().nullable().optional(),
    dark: z.boolean().optional(),
    edits: z.array(z.strictObject({ line: z.number().int(), text: z.string() })).optional(),
  });
  const repaired = repairNativeArguments(preview, { slug: 'my-day', width: '1440', offset_y: '0', dark: 'false', edits: [{ line: '3', text: '42' }] }, { sideEffect: 'read' });
  assert.deepEqual(repaired?.args, { slug: 'my-day', width: 1440, offset_y: 0, dark: false, edits: [{ line: 3, text: '42' }] });
  assert.equal(repaired?.repair, 'canonical_scalar');
  assert.ok(repairNativeArguments(preview, { slug: 'my-day', width: '1440' }, { sideEffect: 'write' }), 'an ordinary write takes the same datum');
  for (const width of ['1e3', '01440', ' 1440', '1440.0', '1440px', '']) {
    assert.equal(repairNativeArguments(preview, { slug: 'my-day', width }, { sideEffect: 'read' }), null, `"${width}" is not the canonical spelling`);
  }
  assert.equal(repairNativeArguments(preview, { slug: 'my-day', width: '1440.5' }, { sideEffect: 'read' }), null, 'the value must still validate');
  assert.equal(repairNativeArguments(preview, { slug: 'my-day', width: '1440' }, { sideEffect: 'send' }), null);
  assert.equal(repairNativeArguments(preview, { slug: 'my-day', text: 'x', width: '1440' }, { sideEffect: 'read' }), null, 'a remaining unknown field keeps the refusal');
});

test('a nullable number compiled from JSON Schema takes the same canonical text', () => {
  const schema = z.fromJSONSchema({
    type: 'object',
    properties: { slug: { type: 'string' }, limit: { anyOf: [{ type: 'integer' }, { type: 'null' }] } },
    required: ['slug', 'limit'],
    additionalProperties: false,
  } as Parameters<typeof z.fromJSONSchema>[0]);
  assert.deepEqual(repairNativeArguments(schema, { slug: 'my-day', limit: '25' }, { sideEffect: 'read' })?.args, { slug: 'my-day', limit: 25 });
});
