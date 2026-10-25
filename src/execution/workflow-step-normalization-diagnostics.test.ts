import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-normalization-diagnostics-'));
process.env.CLEMENTINE_HOME = fixtureHome;
const { normalizeWorkflowSteps } = await import('./workflow-authoring.js');
after(() => rmSync(fixtureHome, { recursive: true, force: true }));

const aggregate = (groupBy?: string[]) => JSON.stringify({ version: 1, expression: {
  op: 'aggregate', value: { op: 'get', from: 'input.rows' },
  ...(groupBy ? { groupBy } : {}), metrics: [{ fn: 'count' }],
} });
type Steps = Parameters<typeof normalizeWorkflowSteps>[0];
const invalidCall = { tool: 'write_file', args_json: '{"content":{{steps.summary.output}}}' };
function rejected(steps: Steps): Error {
  let result: ReturnType<typeof normalizeWorkflowSteps> | undefined;
  let caught: unknown;
  try { result = normalizeWorkflowSteps(steps); } catch (error) { caught = error; }
  assert.equal(result, undefined, 'no partial executable graph escapes an invalid definition');
  assert.ok(caught instanceof Error);
  return caught;
}

test('one normalization refusal reports independent transform and call errors before the bounded repair', () => {
  const steps = [{ id: 'summary', transform: aggregate(), sideEffect: 'read' },
    { id: 'output', call: invalidCall, sideEffect: 'write' }] as unknown as Steps;
  const original = JSON.stringify(steps);
  const files = readdirSync(fixtureHome, { recursive: true });
  const error = rejected(steps);
  assert.match(error.message, /steps\[0\]\.transform/);
  assert.match(error.message, /groupBy must contain 1-32 field names/);
  assert.match(error.message, /steps\[1\]\.call/);
  assert.match(error.message, /args_json must contain valid JSON object text/);
  assert.equal(JSON.stringify(steps), original, 'diagnosis does not silently repair caller-owned bytes');
  assert.deepEqual(readdirSync(fixtureHome, { recursive: true }), files, 'pure normalization performs no write or dispatch');

  const fixed = structuredClone(steps);
  fixed[0].transform = aggregate(['category']);
  (fixed[1].call as unknown as { args_json: string }).args_json = '{"content":"{{steps.summary.output}}"}';
  const normalized = normalizeWorkflowSteps(fixed);
  assert.deepEqual(normalized[0].transform, JSON.parse(aggregate(['category'])));
  assert.deepEqual(normalized[1].call, { tool: 'write_file', args: { content: '{{steps.summary.output}}' } });
  assert.deepEqual(readdirSync(fixtureHome, { recursive: true }), files);
});

test('independent transform and call errors in the same step are both reported', () => {
  const error = rejected([{ id: 'both', transform: aggregate(), call: invalidCall }] as unknown as Steps);
  assert.match(error.message, /steps\[0\]\.transform/);
  assert.match(error.message, /steps\[0\]\.call/);
  assert.match(error.message, /groupBy/);
  assert.match(error.message, /args_json/);
});

test('diagnostics stay bounded and content-free while every invalid step still rejects the graph', () => {
  const secret = 'synthetic-private-argument-do-not-echo';
  const steps = Array.from({ length: 60 }, (_, index) => ({
    id: `${secret}-${index}`,
    transform: index % 2 ? '{"value":"' + secret + '"' : JSON.stringify({ version: 1,
      expression: { op: secret, [secret]: secret } }),
    call: { tool: 'write_file', args_json: '{"' + secret + '":' },
  })) as unknown as Steps;
  const error = rejected(steps);
  assert.ok(Buffer.byteLength(error.message, 'utf8') <= 4096);
  assert.ok(!error.message.includes(secret), 'neither JSON parse excerpts, unknown operations/keys nor step IDs enter feedback');
  assert.match(error.message, /additional normalization issues omitted/);
  assert.ok(error.message.split('\n').length <= 18);
  const allFixed = steps.map((_step, index) => ({ id: `valid-${index}`, transform: aggregate(['category']) }));
  assert.equal(normalizeWorkflowSteps(allFixed).length, 60, 'the diagnostic cap is not a graph size or execution limit');
  allFixed[59].transform = aggregate();
  assert.match(rejected(allFixed).message, /steps\[59\]\.transform/, 'a late invalid field cannot escape rejection');
});

test('valid typed values, legacy calls and literal templates retain their existing normalized bytes', () => {
  const raw = [{ id: 'read', call: { tool: 'read_file', args: { path: '{{input.path}}', max_chars: 20 } },
    sideEffect: 'read', allowedTools: ['read_file'] },
  { id: 'summary', transform: aggregate(['category']), dependsOn: ['read'], sideEffect: 'read' }] as unknown as Steps;
  const before = JSON.stringify(raw);
  const normalized = normalizeWorkflowSteps(raw);
  assert.deepEqual(normalized[0].call, raw[0].call);
  assert.deepEqual(normalized[1].transform, JSON.parse(aggregate(['category'])));
  assert.deepEqual(normalized[1].dependsOn, ['read']);
  assert.equal(JSON.stringify(raw), before);
});

test('dynamic validator operands and literal object paths cannot enter normalization feedback', () => {
  const secret = 'synthetic-private-metric-or-literal-key';
  const error = rejected([
    { id: secret, transform: JSON.stringify({ version: 1, expression: {
      op: 'aggregate', value: { op: 'get', from: 'input.rows' }, metrics: [{ fn: secret }],
    } }) },
    { id: secret, transform: { version: 1, expression: { op: 'literal', value: { [secret]: undefined } } } },
  ] as unknown as Steps);
  assert.ok(!error.message.includes(secret));
  assert.match(error.message, /groupBy must contain 1-32 field names/);
  assert.match(error.message, /metrics\[0\]\.fn must be count, sum, avg, min, or max/);
  assert.match(error.message, /steps\[1\]\.transform/);
});

test('a field or operation a transform does not take is refused by naming what it takes, never by echoing what was written', () => {
  const secret = 'synthetic-private-field-name';
  const error = rejected([
    { id: 'shape', transform: { version: 1, expression: { op: 'jsonParse', value: { op: 'get', from: 'input.rows' }, [secret]: 'rows' } } },
    { id: 'shape_two', transform: { version: 1, expression: { op: secret, value: 1 } } },
    { id: 'shape_three', transform: { version: 1, expression: { op: 'get', from: { op: 'jsonParse', value: { op: 'get', from: 'input.rows' } } } } },
  ] as unknown as Steps);
  assert.ok(!error.message.includes(secret));
  assert.match(error.message, /transform\.expression has a field it does not take \(it takes: op, value\)/);
  assert.match(error.message, /is not a reviewed transform operation \(the operations: aggregate, array, count, get, jsonParse/);
  assert.match(error.message, /to read a field of a computed value, compute it in its own transform step/);
  assert.doesNotMatch(error.message, /closed v1 expression schema/);
});
