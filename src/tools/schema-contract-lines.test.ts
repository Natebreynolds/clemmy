import assert from 'node:assert/strict';
import test from 'node:test';
import { compactContractLines, contractFieldLimits } from './schema-contract-lines.js';

test('every field keeps its type and limits however long the descriptions before it are', () => {
  const schema = {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: `Search syntax. ${'Long syntax guide sentence. '.repeat(120)}` },
      order: { type: 'string', enum: ['newest', 'oldest'], description: 'Sort order of the results.' },
      ids: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string' } } }, maxItems: 10 },
      size: { type: 'integer', minimum: 1, maximum: 25, default: 25, description: 'Results per page (1-25).' },
      filter: { type: ['object', 'null'], properties: { from: { type: 'string' } } },
    },
  };
  assert.deepEqual(compactContractLines(schema), [
    'query*: string — Search syntax.',
    'order: string (one of: "newest", "oldest") — Sort order of the results.',
    'ids: array of {id, kind} (up to 10 items)',
    'size: integer (1 to 25; default 25) — Results per page (1-25).',
    'filter: object {from}',
  ]);
  assert.equal(compactContractLines({ type: 'object' }).length, 0);
  assert.equal(contractFieldLimits({ type: 'string', maxLength: 200 }), 'up to 200 characters');
});

test('a description is cut at its first sentence and a bounded length; extra fields are counted, not dropped silently', () => {
  const many = { type: 'object', properties: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, { type: 'string', description: 'x'.repeat(200) }])) };
  const lines = compactContractLines(many, { maxFields: 3, descriptionChars: 20 });
  assert.equal(lines.length, 4);
  assert.equal(lines[0], `f0: string — ${'x'.repeat(19)}…`);
  assert.match(lines[3]!, /^… 2 more fields; tool_search with the exact name returns the whole schema$/);
});
