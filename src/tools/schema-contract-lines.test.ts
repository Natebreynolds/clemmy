import assert from 'node:assert/strict';
import test from 'node:test';
import { compactContract, contractFieldLimits } from './schema-contract-lines.js';

test('every field keeps its type, nullability and limits however long the descriptions before it are', () => {
  const schema = {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: `Search syntax. ${'Long syntax guide sentence. '.repeat(120)}` },
      order: { type: ['string', 'null'], enum: ['newest', 'oldest', null], description: 'Sort order of the results.' },
      size: { type: 'integer', minimum: 1, maximum: 25, default: 25, description: 'Results per page (1-25).' },
      since: { type: 'string', format: 'date-time', nullable: true },
    },
  };
  assert.deepEqual(compactContract(schema), { complete: true, lines: [
    'query*: string — Search syntax.',
    'order: string or null (one of: "newest", "oldest", null) — Sort order of the results.',
    'size: integer (1 to 25; default 25) — Results per page (1-25).',
    'since: string or null (format date-time)',
  ] });
});

test('nested fields are listed with their own required markers and limits', () => {
  const schema = {
    type: 'object',
    properties: {
      recipients: { type: 'array', maxItems: 10, items: { type: 'object', required: ['address'], properties: {
        address: { type: 'string', format: 'email' }, kind: { type: 'string', enum: ['to', 'cc'] } } } },
      window: { type: ['object', 'null'], properties: { start: { type: 'string', minLength: 10 }, end: { type: 'string' } } },
    },
  };
  assert.deepEqual(compactContract(schema), { complete: true, lines: [
    'recipients: array of objects (up to 10 items)',
    '  address*: string (format email)',
    '  kind: string (one of: "to", "cc")',
    'window: object or null',
    '  start: string (at least 10 characters)',
    '  end: string',
  ] });
});

test('structure a line cannot state makes the summary incomplete, never silently partial', () => {
  const incomplete = (field: Record<string, unknown>) => compactContract({ type: 'object', properties: { f: field } }).complete;
  assert.equal(incomplete({ anyOf: [{ type: 'string' }, { type: 'object', properties: { a: { type: 'string' } } }] }), false);
  assert.equal(incomplete({ $ref: '#/$defs/x' }), false);
  assert.equal(incomplete({ type: 'object', additionalProperties: { type: 'object', properties: { a: { type: 'string' } } } }), false, 'map values with fields');
  assert.equal(incomplete({ type: 'array', items: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } } }), false, 'objects inside an array of arrays');
  assert.equal(incomplete({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { a: { type: 'string' } } }] } }), false, 'a union with structure on the elements');
  assert.equal(incomplete({ anyOf: [{ type: 'string', maxLength: 5 }, { type: 'integer' }] }), false, 'a union whose branches carry their own limits');
  assert.equal(incomplete({ type: 'object', description: 'x'.repeat(401) }), false, 'a free-form value whose description cannot be kept whole');
  assert.equal(incomplete({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'string' } } } } } } }), false, 'deeper than the summary renders');
  assert.equal(compactContract({ type: 'object', oneOf: [{}], properties: { a: { type: 'string' } } }).complete, false);
  const many = { type: 'object', properties: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, { type: 'string' }])) };
  assert.equal(compactContract(many, { maxFields: 3 }).complete, false);
  assert.equal(compactContract({ type: 'object' }).complete, false, 'no declared fields is not a contract');
});

test('limits read the way a person says them', () => {
  assert.equal(contractFieldLimits({ type: 'string', maxLength: 200 }), 'up to 200 characters');
  assert.equal(contractFieldLimits({ type: 'integer', minimum: 0 }), 'at least 0');
  assert.equal(contractFieldLimits({ type: 'array', minItems: 1, maxItems: 1, uniqueItems: true }), 'exactly 1 items; no repeats');
  assert.equal(contractFieldLimits({ type: 'string', pattern: '^[a-z]+$', const: 'x' }), 'always "x"; matching /^[a-z]+$/');
});

test('array elements keep their own limits, and nullable elements say so', () => {
  const schema = { type: 'object', properties: {
    labels: { type: 'array', maxItems: 5, uniqueItems: true, items: { type: 'string', enum: ['red', 'blue'], maxLength: 20 } },
    ids: { type: 'array', items: { type: ['integer', 'null'], minimum: 1 } },
    when: { type: 'array', items: { type: 'string', format: 'date' } },
    grid: { type: 'array', items: { type: 'array', maxItems: 3, items: { type: 'number', minimum: 0 } } },
  } };
  assert.deepEqual(compactContract(schema), { complete: true, lines: [
    'labels: array of string (up to 5 items; no repeats; each [one of: "red", "blue"; up to 20 characters])',
    'ids: array of integer (each [at least 1; may be null])',
    'when: array of string (each [format date])',
    'grid: array of array of number (each [up to 3 items; each [at least 0]])',
  ] });
});

test('object rules are stated: no other fields, field counts, maps and empty objects', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['filter'],
    properties: {
      filter: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['open', 'closed'] } } },
      rows: { type: 'array', items: { type: 'object', additionalProperties: false, maxProperties: 4, properties: { cell: { type: 'string' } } } },
      tags: { type: 'object', additionalProperties: { type: 'string', maxLength: 50 } },
      extra: { type: 'object', properties: { note: { type: 'string' } }, additionalProperties: { type: 'integer' } },
      empty: { type: 'object', additionalProperties: false },
      sets: { type: 'array', items: { type: 'object', additionalProperties: { type: 'boolean' } } },
    },
  };
  assert.deepEqual(compactContract(schema), { complete: true, lines: [
    'filter*: object (no other fields)',
    '  status: string (one of: "open", "closed")',
    'rows: array of objects (each [no other fields; at most 4 fields])',
    '  cell: string',
    'tags: object (any keys, each value string [up to 50 characters])',
    'extra: object (other keys allowed, each value integer)',
    '  note: string',
    'empty: object (must be empty)',
    'sets: array of objects (each [any keys, each value boolean])',
    '(top level: no other fields)',
  ] });
});

test('an optional value and a plain type union are stated without loss', () => {
  const schema = { type: 'object', properties: {
    folder: { anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }], default: null, description: 'Folder to search.' },
    ids: { anyOf: [{ type: 'array', items: { type: 'integer', minimum: 1 } }, { type: 'null' }] },
    window: { anyOf: [{ type: 'object', additionalProperties: false, properties: { days: { type: 'integer', maximum: 30 } } }, { type: 'null' }] },
    cell: { anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'number' }] },
    flag: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
  } };
  assert.deepEqual(compactContract(schema), { complete: true, lines: [
    'folder: string or null (up to 64 characters) — Folder to search.',
    'ids: array of integer or null (each [at least 1])',
    'window: object or null (no other fields)',
    '  days: integer (at most 30)',
    'cell: string or integer or number',
    'flag: boolean or null',
  ] });
});

test('a free-form value keeps its whole description, which is where its shape lives', () => {
  const description = 'JSON object to override the input. Keys not given here keep their defaults. Example: {"maxItems": 10}.';
  const schema = { type: 'object', properties: {
    overrides: { type: 'object', additionalProperties: true, description },
    options: { type: 'object', description: 'Run options.' },
    filters: { type: 'array', description: 'Each filter is [field, operator, value]. Up to 8 filters.' },
    rows: { type: 'array', maxItems: 5, items: { type: 'object' }, description: 'Rows to add. Keys are column names.' },
  } };
  assert.deepEqual(compactContract(schema), { complete: true, lines: [
    `overrides: object (any keys) — ${description}`,
    'options: object (any keys) — Run options.',
    'filters: array — Each filter is [field, operator, value]. Up to 8 filters.',
    'rows: array of objects (up to 5 items; each [any keys]) — Rows to add. Keys are column names.',
  ] });
});
