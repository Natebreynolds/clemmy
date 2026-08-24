/** Run: npx tsx --test src/runtime/graph/capability-edge-kinds.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';
import { kindsSatisfy, validateBoundCapabilityEdges } from './capability-edge-kinds.js';

test('locator satisfies collection and created_resource satisfies readback', () => {
  assert.equal(kindsSatisfy(['locator'], ['locator']), true);
  assert.equal(kindsSatisfy(['locator'], ['records']), false);
  assert.equal(kindsSatisfy(['created_resource'], ['created_resource']), true);
  assert.equal(kindsSatisfy(['created_resource'], ['records']), false);
  assert.equal(kindsSatisfy(['records'], ['records']), true);
});

test('bound capability edges reject locator→records and created_resource→records', () => {
  const errors = validateBoundCapabilityEdges({
    edges: [
      { id: 'e-source-collect', source: 'op-source', target: 'op-collect' },
      { id: 'e-write-readback', source: 'op-write', target: 'op-readback' },
    ],
    producedByNode: new Map([
      ['op-source', ['locator']],
      ['op-write', ['created_resource']],
    ]),
    acceptedByNode: new Map([
      ['op-collect', ['records']],
      ['op-readback', ['records']],
    ]),
  });
  assert.equal(errors.length, 2);
  const ok = validateBoundCapabilityEdges({
    edges: [
      { id: 'e-source-collect', source: 'op-source', target: 'op-collect' },
      { id: 'e-write-readback', source: 'op-write', target: 'op-readback' },
    ],
    producedByNode: new Map([
      ['op-source', ['locator']],
      ['op-write', ['created_resource']],
    ]),
    acceptedByNode: new Map([
      ['op-collect', ['locator']],
      ['op-readback', ['created_resource']],
    ]),
  });
  assert.deepEqual(ok, []);
});

test('executable edges missing kind metadata refuse admission', () => {
  const errors = validateBoundCapabilityEdges({
    edges: [{ id: 'e-source-collect', source: 'op-source', target: 'op-collect' }],
    producedByNode: new Map(),
    acceptedByNode: new Map(),
    executableNodeIds: new Set(['op-source', 'op-collect']),
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /missing capability kind metadata/);
});
