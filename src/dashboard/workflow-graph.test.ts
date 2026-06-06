import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowGraph } from './workflow-graph.js';

test('maps steps to nodes and dependsOn to edges', () => {
  const g = buildWorkflowGraph([
    { id: 'a', prompt: 'Gather the inputs.' },
    { id: 'b', prompt: 'Analyze them.', dependsOn: ['a'] },
    { id: 'c', prompt: 'Write the report.', dependsOn: ['a', 'b'] },
  ]);
  assert.equal(g.nodes.length, 3);
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['a', 'b', 'c']);
  assert.equal(g.edges.length, 3);
  assert.ok(g.edges.some((e) => e.source === 'a' && e.target === 'b'));
  assert.ok(g.edges.some((e) => e.source === 'b' && e.target === 'c'));
});

test('node label is a short, human first-sentence', () => {
  const g = buildWorkflowGraph([{ id: 's', prompt: 'Pull the SEO data. Then do more stuff that is long.' }]);
  assert.equal(g.nodes[0].label, 'Pull the SEO data.');
});

test('flags forEach / approval / skill / deterministic', () => {
  const g = buildWorkflowGraph([
    { id: 'x', prompt: 'p', forEach: 'items', requiresApproval: true, usesSkill: 'proposal-builder', deterministic: { runner: 'export.py' } },
  ]);
  const f = g.nodes[0].flags;
  assert.equal(f.forEach, true);
  assert.equal(f.approval, true);
  assert.equal(f.skill, 'proposal-builder');
  assert.equal(f.deterministic, true);
});

test('drops dangling dependsOn (no half-edges)', () => {
  const g = buildWorkflowGraph([
    { id: 'a', prompt: 'p' },
    { id: 'b', prompt: 'p', dependsOn: ['a', 'ghost'] },
  ]);
  assert.equal(g.edges.length, 1);
  assert.equal(g.nodes.find((n) => n.id === 'b')?.dependsOn.length, 1);
});

test('de-dupes repeated dependsOn entries', () => {
  const g = buildWorkflowGraph([
    { id: 'a', prompt: 'p' },
    { id: 'b', prompt: 'p', dependsOn: ['a', 'a'] },
  ]);
  assert.equal(g.edges.length, 1);
});

test('handles empty / missing steps', () => {
  assert.deepEqual(buildWorkflowGraph([]), { nodes: [], edges: [] });
  assert.deepEqual(buildWorkflowGraph(undefined), { nodes: [], edges: [] });
  assert.deepEqual(buildWorkflowGraph(null), { nodes: [], edges: [] });
});
