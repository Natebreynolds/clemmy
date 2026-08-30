import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  executeWorkflowTransform,
  parseWorkflowTransformAuthoringValue,
  validateWorkflowTransform,
  WorkflowTransformError,
  WORKFLOW_TRANSFORM_MAX_ITEMS,
} from './workflow-transform.js';

test('literal and JSON workflow inputs produce exact data for downstream fan-out', () => {
  const literal = executeWorkflowTransform({
    transform: {
      version: 1,
      expression: {
        op: 'literal',
        value: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      },
    },
    inputs: {},
    stepOutputs: {},
  });
  assert.deepEqual(literal, [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);

  const fromInput = executeWorkflowTransform({
    transform: {
      version: 1,
      expression: {
        op: 'jsonParse',
        value: { op: 'get', from: 'input.competitors' },
      },
    },
    inputs: { competitors: '[{"name":"A"},{"name":"B"}]' },
    stepOutputs: {},
  });
  assert.deepEqual(fromInput, [{ name: 'A' }, { name: 'B' }]);
});

test('jsonStringify emits exact bounded JSON text for an artifact content argument', () => {
  const output = executeWorkflowTransform({
    transform: {
      version: 1,
      expression: {
        op: 'jsonStringify',
        value: {
          op: 'object',
          fields: [
            { key: 'title', value: { op: 'literal', value: 'Quarterly report' } },
            { key: 'rows', value: { op: 'get', from: 'steps.shape.output' } },
          ],
        },
      },
    },
    inputs: {},
    stepOutputs: { shape: [{ id: 'A', amount: 12 }] },
  });

  assert.equal(output, '{"title":"Quarterly report","rows":[{"id":"A","amount":12}]}');

  const invalid = validateWorkflowTransform({
    version: 1,
    expression: { op: 'jsonStringify', value: { op: 'literal', value: true }, pretty: true },
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.match(invalid.errors.join(' '), /unsupported field "pretty"/);
});

test('reshape composes upstream data, exact counts, literals, and mapped rows without code', () => {
  const output = executeWorkflowTransform({
    transform: {
      version: 1,
      expression: {
        op: 'object',
        fields: [
          { key: 'data', value: { op: 'get', from: 'steps.opportunities.output' } },
          {
            key: 'grid',
            value: {
              op: 'map',
              value: { op: 'get', from: 'steps.opportunities.output' },
              each: {
                op: 'array',
                items: [
                  { op: 'get', from: 'item.Id' },
                  { op: 'get', from: 'item.Name' },
                  { op: 'get', from: 'item.Amount' },
                ],
              },
            },
          },
          {
            key: 'counts',
            value: {
              op: 'object',
              fields: [{
                key: 'opportunities',
                value: { op: 'count', value: { op: 'get', from: 'steps.opportunities.output' } },
              }],
            },
          },
          { key: 'tabsWritten', value: { op: 'literal', value: ['Opportunities'] } },
        ],
      },
    },
    inputs: {},
    stepOutputs: {
      opportunities: [
        { Id: 'opp-1', Name: 'Alpha', Amount: 12 },
        { Id: 'opp-2', Name: 'Beta', Amount: 8 },
      ],
    },
  });

  assert.deepEqual(output, {
    data: [
      { Id: 'opp-1', Name: 'Alpha', Amount: 12 },
      { Id: 'opp-2', Name: 'Beta', Amount: 8 },
    ],
    grid: [
      ['opp-1', 'Alpha', 12],
      ['opp-2', 'Beta', 8],
    ],
    counts: { opportunities: 2 },
    tabsWritten: ['Opportunities'],
  });
});

test('select and aggregate reuse the reviewed table algebra exactly', () => {
  const rows = [
    { owner: 'Ada', status: 'open', amount: 10 },
    { owner: 'Ada', status: 'closed', amount: 20 },
    { owner: 'Grace', status: 'open', amount: 30 },
  ];
  const selected = executeWorkflowTransform({
    transform: {
      version: 1,
      expression: {
        op: 'select',
        value: { op: 'get', from: 'steps.pull.output' },
        where: { column: 'status', op: 'eq', value: 'open' },
        columns: ['owner', 'amount'],
      },
    },
    inputs: {},
    stepOutputs: { pull: rows },
  });
  assert.deepEqual(selected, [
    { owner: 'Ada', amount: 10 },
    { owner: 'Grace', amount: 30 },
  ]);

  const grouped = executeWorkflowTransform({
    transform: {
      version: 1,
      expression: {
        op: 'aggregate',
        value: { op: 'get', from: 'steps.pull.output' },
        groupBy: ['owner'],
        metrics: [{ fn: 'count' }, { fn: 'sum', column: 'amount' }],
      },
    },
    inputs: {},
    stepOutputs: { pull: rows },
  });
  assert.deepEqual(grouped, [
    { owner: 'Ada', count: 2, sum_amount: 30 },
    { owner: 'Grace', count: 1, sum_amount: 30 },
  ]);
});

test('the transform contract is strict, scoped, JSON-only, and resource bounded', () => {
  const unknownOp = validateWorkflowTransform({
    version: 1,
    expression: { op: 'javascript', source: 'process.exit()' },
  });
  assert.equal(unknownOp.ok, false);
  if (!unknownOp.ok) assert.match(unknownOp.errors.join(' '), /not a reviewed transform operation/);

  const ambientItem = validateWorkflowTransform({
    version: 1,
    expression: { op: 'get', from: 'item.secret' },
  });
  assert.equal(ambientItem.ok, false);
  if (!ambientItem.ok) assert.match(ambientItem.errors.join(' '), /outside a map\.each/);

  const extraAuthority = validateWorkflowTransform({
    version: 1,
    expression: { op: 'literal', value: true, command: 'touch /tmp/nope' },
  });
  assert.equal(extraAuthority.ok, false);
  if (!extraAuthority.ok) assert.match(extraAuthority.errors.join(' '), /unsupported field "command"/);

  const prototypeTraversal = validateWorkflowTransform({
    version: 1,
    expression: { op: 'get', from: 'item.constructor.name' },
  });
  assert.equal(prototypeTraversal.ok, false);
  if (!prototypeTraversal.ok) {
    assert.match(prototypeTraversal.errors.join(' '), /reserved path segment|outside a map\.each/);
  }

  assert.throws(
    () => executeWorkflowTransform({
      transform: { version: 1, expression: { op: 'get', from: 'steps.missing.output' } },
      inputs: {},
      stepOutputs: {},
    }),
    (error: unknown) => error instanceof WorkflowTransformError && /did not resolve/.test(error.message),
  );

  assert.throws(
    () => executeWorkflowTransform({
      transform: {
        version: 1,
        expression: {
          op: 'map',
          value: { op: 'get', from: 'steps.rows.output' },
          each: { op: 'get', from: 'item' },
        },
      },
      inputs: {},
      stepOutputs: { rows: Array.from({ length: WORKFLOW_TRANSFORM_MAX_ITEMS + 1 }, () => null) },
    }),
    /received 50001 items/,
  );
});

test('the authoring carrier parses exact JSON and the implementation imports no dynamic executor', () => {
  const parsed = parseWorkflowTransformAuthoringValue(JSON.stringify({
    version: 1,
    expression: { op: 'literal', value: { ok: true } },
  }));
  assert.equal(parsed.ok, true);

  const malformed = parseWorkflowTransformAuthoringValue('{"version":1');
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.match(malformed.message, /could not be parsed/);

  const source = readFileSync(new URL('./workflow-transform.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:child_process|\beval\s*\(|new Function|node:vm|run_shell|spawn\s*\(/);
});
