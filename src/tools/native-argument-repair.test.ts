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

test('an object whose strict schema types it as text moves whole into its JSON-text sibling, nothing coerced', () => {
  // Live 2026-10-15: workflow_update with steps[].call.args {max_chars: 20000,
  // formats: ["markdown"]} was refused "expected string, received number"
  // because the strict schema can only type the open object's values as text.
  const schema = z.strictObject({
    name: z.string(),
    steps: z.array(z.strictObject({
      id: z.string(),
      call: z.strictObject({
        tool: z.string(),
        args: z.record(z.string(), z.string()).optional(),
        args_json: z.string().optional(),
      }).optional(),
    })),
  });
  const input = {
    name: 'research-outreach',
    steps: [
      { id: 'load', call: { tool: 'read_file', args: { path: '/tmp/p.csv', max_chars: 20000 } } },
      { id: 'search', call: { tool: 'FIRECRAWL_SEARCH', args: { q: '{{item.company}}', limit: 3, formats: ['markdown'] } } },
    ],
  };
  const repaired = repairNativeArguments(schema, input, { sideEffect: 'write' });
  assert.ok(repaired, 'repaired');
  assert.equal(repaired.repair, 'json_text_sibling');
  const steps = repaired.args.steps as Array<{ call: { args?: unknown; args_json?: string } }>;
  assert.equal(steps[0]!.call.args, undefined);
  assert.deepEqual(JSON.parse(steps[0]!.call.args_json!), { path: '/tmp/p.csv', max_chars: 20000 });
  assert.deepEqual(JSON.parse(steps[1]!.call.args_json!), { q: '{{item.company}}', limit: 3, formats: ['markdown'] });
  // A field with no JSON-text sibling is not touched.
  const noSibling = z.strictObject({ options: z.record(z.string(), z.string()) });
  assert.equal(repairNativeArguments(noSibling, { options: { limit: 3 } }, { sideEffect: 'write' }), null);
  // A carrier nested in the open args moves as the call's args into the
  // declared args_json, never into an invented key inside the record.
  const gateway = repairNativeArguments(schema, { name: 'pull', steps: [{ id: 'get_events', call: { tool: 'composio_execute_tool',
    args: { tool_slug: 'FIXTURE_LIST_EVENTS', arguments: { user_id: 'me', top: 50 } } } }] }, { sideEffect: 'write' });
  assert.ok(gateway, 'repaired');
  const call = (gateway.args.steps as Array<{ call: { args?: unknown; args_json?: string } }>)[0]!.call;
  assert.equal(call.args, undefined);
  assert.deepEqual(JSON.parse(call.args_json!), { tool_slug: 'FIXTURE_LIST_EVENTS', arguments: { user_id: 'me', top: 50 } });
});

test('arguments sent in a carrier\'s shape are read as the call\'s own, for a read or an ordinary write', () => {
  // Live 2026-10-18: workflow_run_status received {name, args_json}.
  const status = z.strictObject({ run_id: z.string().min(1), step_id: z.string().nullable() });
  const carried = { name: 'workflow_run_status', args_json: JSON.stringify({ run_id: 'run-1', step_id: null }) };
  const repaired = repairNativeArguments(status, carried, { sideEffect: 'read' });
  assert.deepEqual(repaired?.args, { run_id: 'run-1', step_id: null });
  assert.equal(repaired?.repair, 'carrier_unwrapped');
  assert.equal(repairNativeArguments(status, carried, { sideEffect: 'write' })?.repair, 'carrier_unwrapped');
  assert.equal(repairNativeArguments(status, carried, { sideEffect: 'send' }), null, 'a send keeps its refusal');
  assert.equal(repairNativeArguments(status, { ...carried, args_json: '{not json' }, { sideEffect: 'read' }), null);
  assert.equal(repairNativeArguments(status, { ...carried, other: 1 }, { sideEffect: 'read' }), null,
    'any field beyond the carrier\'s two keeps the refusal');
});

test('a list or object sent as its own JSON text is read as that value, and nothing else is', () => {
  const steps = [{ find: 'old', replace: 'new' }];
  const repaired = repairNativeArguments(edit, { slug: 'my-day', edits: JSON.stringify(steps) }, { sideEffect: 'write' });
  assert.deepEqual(repaired?.args, { slug: 'my-day', edits: steps });
  assert.equal(repaired?.repair, 'canonical_scalar');
  for (const edits of ['[{"find": "old"', JSON.stringify({ find: 'old', replace: 'new' }), 'old -> new']) {
    assert.equal(repairNativeArguments(edit, { slug: 'my-day', edits }, { sideEffect: 'write' }), null, edits);
  }
  assert.equal(repairNativeArguments(edit, { slug: 'my-day', edits: JSON.stringify(steps) }, { sideEffect: 'send' }), null);
});
