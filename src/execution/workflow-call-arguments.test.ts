import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeWorkflowCallArguments } from './workflow-call-arguments.js';
import { tool } from '@openai/agents';
import { z } from 'zod';
import { normalizeZodForCodexStrict } from '../runtime/schema-normalizer.js';

test('JSON argument carrier survives actual SDK strict tool projection', () => {
  const projected = tool({ name: 'workflow_call_projection', description: 'Projection check',
    parameters: normalizeZodForCodexStrict(z.object({ call: z.object({
      args: z.record(z.string(), z.unknown()).optional(),
      args_json: z.string().optional(),
    }) })), execute: async () => '' });
  const schema = projected.parameters as any;
  const fields = schema.properties.call.properties;
  // This reproduces why the old open-object contract only emitted {}.
  assert.equal(fields.args.anyOf[0].additionalProperties, false);
  assert.deepEqual(fields.args.anyOf[0].properties, {});
  assert.ok(fields.args_json.anyOf.some((entry: any) => entry.type === 'string'));
});

test('JSON call arguments retain types and templates without persisting their carrier', () => {
  const args = { path: '{{input.path}}', max_chars: 1000, enabled: false, nested: { values: [null, 3] } };
  assert.deepEqual(normalizeWorkflowCallArguments({ tool: 'read_file', args: {}, args_json: JSON.stringify(args) }),
    { tool: 'read_file', args });
});

test('legacy arguments remain intact and conflicting or malformed carriers fail before save', () => {
  const call = { tool: 'read_file', args: { path: '/a' } };
  assert.deepEqual(normalizeWorkflowCallArguments(call), call);
  assert.deepEqual(normalizeWorkflowCallArguments({ ...call, args_json: '{"path":"/a"}' }), call);
  for (const args_json of ['{', '[]', 'null', '3', '{"path":"/b"}']) {
    assert.throws(() => normalizeWorkflowCallArguments({ ...call, args_json }));
  }
});
