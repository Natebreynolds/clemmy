import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpaceSourceTransforms, transformSpaceSourceData } from './source-transforms.js';

const pipeline = [
  { id: 'preferred', transform: { version: 1, expression: { op: 'unique', keys: ['firm'], value: {
    op: 'sort', by: [{ column: 'primary', direction: 'desc' }, { column: 'date', direction: 'desc' }],
    value: { op: 'get', from: 'steps.read.output.records' },
  } } } },
  { id: 'document', transform: { version: 1, expression: { op: 'object', fields: [
    { key: 'contacts', value: { op: 'get', from: 'steps.preferred.output' } },
    { key: 'total', value: { op: 'count', value: { op: 'get', from: 'steps.preferred.output' } } },
    { key: 'pulledAt', value: { op: 'get', from: 'input.observed_at' } },
  ] } } },
];

test('source pipeline consumes read evidence and earlier outputs with host observation time', () => {
  const data = { records: [
    { firm: 'A', primary: false, date: '2026-09-19' },
    { firm: 'A', primary: true, date: '2026-09-12' },
  ] };
  const before = structuredClone(data);
  const actual = transformSpaceSourceData(JSON.stringify(pipeline), data, '2026-09-19T20:40:00Z');
  assert.deepEqual(actual, { contacts: [data.records[1]], total: 1, pulledAt: '2026-09-19T20:40:00Z' });
  assert.deepEqual(data, before);
});

test('source pipeline refuses ambient inputs, forward references, code, duplicate IDs and oversized plans', () => {
  const step = (id: string, from: string) => ({ id, transform: { version: 1, expression: { op: 'get', from } } });
  for (const bad of [
    [], [step('read', 'steps.read.output')], [step('constructor', 'steps.read.output')],
    [step('first', 'steps.later.output')], [step('first', 'input.secret')],
    [step('a', 'steps.read.output'), step('a', 'steps.read.output')],
    [{ id: 'a', transform: { version: 1, expression: { op: 'javascript', source: 'anything' } } }],
    [{ ...step('a', 'steps.read.output'), call: { tool: 'anything' } }],
    Array.from({ length: 17 }, (_, n) => step('a' + n, 'steps.read.output')),
  ]) assert.throws(() => parseSpaceSourceTransforms(bad));
});

test('shape failures do not mutate or return a partial replacement dataset', () => {
  const original = { records: [{ wrongKey: 'A' }] };
  assert.throws(() => transformSpaceSourceData(pipeline, original, '2026-09-19T20:40:00Z'), /must exist/);
  assert.deepEqual(original, { records: [{ wrongKey: 'A' }] });
});
