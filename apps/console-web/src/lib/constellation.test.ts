import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeLabel, layoutConstellation, starLabel } from './constellation.js';

const nodes = [
  { id: 'fact:1', label: 'Pelta Law is in Proposal at $96k', type: 'fact' },
  { id: 'entity:7', label: 'Dana Pelta', type: 'entity' },
  { id: 'file:vault/notes/pelta.md', label: 'vault/notes/pelta.md', type: 'file' },
  { id: 'entity:9', label: 'Pelta Law', type: 'entity' },
  { id: 'fact:2', label: 'Two-phase proposal', type: 'fact' },
];
const edges = [
  { id: 'e1', source: 'fact:1', target: 'entity:7', type: 'mentions', truth: 'stored' as const },
  { id: 'e2', source: 'fact:1', target: 'file:vault/notes/pelta.md', type: 'source', truth: 'stored' as const },
  { id: 'e3', source: 'entity:7', target: 'entity:9', type: 'works_at', truth: 'stored' as const },
  { id: 'e4', source: 'entity:9', target: 'fact:2', type: 'mentions', truth: 'inferred' as const },
];

test('the seed sits at the center, neighbors on ring one, their neighbors on ring two, edges labelled', () => {
  const c = layoutConstellation('fact:1', nodes, edges);
  assert.equal(c.nodes[0].id, 'fact:1');
  assert.equal(c.nodes[0].ring, 0);
  assert.deepEqual(c.nodes.filter((n) => n.ring === 1).map((n) => n.id).sort(), ['entity:7', 'file:vault/notes/pelta.md']);
  assert.deepEqual(c.nodes.filter((n) => n.ring === 2).map((n) => n.id), ['entity:9'], 'second ring is bounded to what ring one touches');
  assert.equal(c.edges.find((e) => e.id === 'e1')?.label, 'mentions');
  assert.equal(c.edges.find((e) => e.id === 'e3')?.label, 'works at');
  assert.equal(c.edges.find((e) => e.id === 'e3')?.weak, true, 'a ring-two edge draws light');
  assert.equal(c.edges.find((e) => e.id === 'e4'), undefined, 'edges to nodes outside the caps are not drawn');
  assert.ok(c.nodes.every((n) => n.x >= 0 && n.x <= 356 && n.y >= 0 && n.y <= 170), 'everything stays inside the box');
});

test('labels stay short and files keep their basename', () => {
  assert.equal(starLabel({ id: 'file:x', label: 'vault/notes/pelta.md', type: 'file' }), 'pelta.md');
  assert.equal(starLabel({ id: 'fact:1', label: 'A very long memory text that goes on', type: 'fact' }), 'A very long memor…');
  assert.equal(edgeLabel('FACT_TO_RESOURCE'), 'resource');
});

test('an unknown seed yields an empty constellation, never a throw', () => {
  assert.deepEqual(layoutConstellation('fact:404', nodes, edges), { nodes: [], edges: [] });
});
