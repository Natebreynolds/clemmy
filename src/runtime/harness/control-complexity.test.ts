/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/control-complexity.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assessControlComplexity, generalSchedulerForbidden } from './control-complexity.js';

test('a fully bound retrieve is direct and must not pay the graph scheduler', () => {
  const assessed = assessControlComplexity({
    acceptedSourceDigest: 'src-1',
    goal: { construct: 'none', route: 'retrieve' },
    executableNodeCount: 1,
  });
  assert.equal(assessed.mode, 'direct');
  assert.equal(generalSchedulerForbidden(assessed.mode), true);
  assert.equal(assessed.requiresDurability, false);
});

test('plural sinks require a durable graph', () => {
  const assessed = assessControlComplexity({
    acceptedSourceDigest: 'src-2',
    goal: {
      construct: 'collect_then_construct',
      route: 'act',
      destinations: [
        { posture: 'create_new', family: 'a', handleRequired: true },
        { posture: 'named_existing', family: 'b', handleRequired: false },
      ],
    },
    executableNodeCount: 4,
  });
  assert.equal(assessed.mode, 'durable_graph');
  assert.equal(generalSchedulerForbidden(assessed.mode), false);
  assert.ok(assessed.reasons.includes('plural_sinks'));
});

test('the model cannot downgrade a human boundary off the assessment', () => {
  const assessed = assessControlComplexity({
    acceptedSourceDigest: 'src-3',
    goal: { construct: 'none', route: 'retrieve' },
    executableNodeCount: 1,
    openHumanDependency: true,
  });
  assert.equal(assessed.requiresHumanBoundary, true);
});

test('fanout is a bounded loop and does not hijack the one-node direct runner', () => {
  const assessed = assessControlComplexity({
    acceptedSourceDigest: 'src-4',
    goal: { construct: 'fanout', route: 'act' },
    executableNodeCount: 3,
  });
  assert.equal(assessed.mode, 'bounded_loop');
  assert.equal(generalSchedulerForbidden(assessed.mode), false);
});
