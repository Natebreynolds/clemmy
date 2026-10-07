/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/tool-payload-shape.test.ts
 *
 * A card promises exactly what will run. The host completes a queued exact
 * payload from the tool's own declared schema before the card exists, and
 * names back what it cannot complete.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { completePayloadForToolSchema, payloadShapeRefusal } = await import('./tool-payload-shape.js');

// The SDK's strict JSON schema for a zod object with nullable fields.
const SHELL_LIKE = {
  type: 'object',
  properties: {
    command: { type: 'string', minLength: 1 },
    cwd: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    timeout_ms: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  },
  required: ['command', 'cwd', 'timeout_ms'],
  additionalProperties: false,
};

test('a required field the schema lets be null is completed as null, the rest untouched', () => {
  // Live 2026-10-07: {command, timeout_ms} was queued, shown, approved, then
  // refused before dispatch for the missing cwd.
  const shaped = completePayloadForToolSchema(SHELL_LIKE, { command: 'ssh -G -v localhost', timeout_ms: 30000 });
  assert.deepEqual(shaped.issues, []);
  assert.deepEqual(shaped.completed, ['cwd']);
  assert.deepEqual(shaped.payload, { command: 'ssh -G -v localhost', timeout_ms: 30000, cwd: null });
});

test('a payload that already fits passes through unchanged', () => {
  const payload = { command: 'ls', cwd: null, timeout_ms: null };
  const shaped = completePayloadForToolSchema(SHELL_LIKE, payload);
  assert.deepEqual(shaped, { payload, issues: [], completed: [] });
});

test('what the schema refuses is named back: a missing non-null field, a stray field, a wrong type', () => {
  const shaped = completePayloadForToolSchema(SHELL_LIKE, { cwd: '/tmp', timeout_ms: '30s', shell: 'zsh' });
  assert.deepEqual(shaped.issues, [
    'command: required',
    'shell: not a field of this tool',
    'timeout_ms: expected number, received string',
  ]);
  const refusal = payloadShapeRefusal('run_shell_command', shaped.issues);
  assert.match(refusal, /^pending_action_queue refused: the exact payload does not fit run_shell_command's schema — command: required;/);
  assert.match(refusal, /Nothing was queued\.$/);
});

test('a schema that declares no properties, or none at all, constrains nothing', () => {
  const payload = { anything: 1 };
  assert.deepEqual(completePayloadForToolSchema(null, payload), { payload, issues: [], completed: [] });
  assert.deepEqual(completePayloadForToolSchema({ type: 'object', additionalProperties: true }, payload), { payload, issues: [], completed: [] });
});

test('integers fit a number field and nested shapes are left to dispatch', () => {
  const schema = {
    type: 'object',
    properties: { n: { type: 'number' }, body: { type: 'object', properties: { deep: { type: 'string' } }, required: ['deep'] } },
    required: ['n', 'body'],
    additionalProperties: false,
  };
  const shaped = completePayloadForToolSchema(schema, { n: 3, body: { other: true } });
  assert.deepEqual(shaped.issues, []);
});

test('the real shell tool declares its working directory nullable, so the dispatcher completes it', async () => {
  const { innerDispatchToolParameters } = await import('./inner-dispatch.js');
  const schema = await innerDispatchToolParameters('run_shell_command');
  assert.ok(schema, 'the shell tool is known to the nested dispatcher');
  const shaped = completePayloadForToolSchema(schema, { command: 'ssh -G localhost', timeout_ms: 30000 });
  assert.deepEqual(shaped.issues, []);
  assert.equal(shaped.payload.cwd, null);
  assert.equal(await innerDispatchToolParameters('no_such_tool_fixture'), null);
});
