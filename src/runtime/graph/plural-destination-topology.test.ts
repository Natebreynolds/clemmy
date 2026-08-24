/** Run: npx tsx --test src/runtime/graph/plural-destination-topology.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileAcceptedGoal, destinationsOf } from './accepted-goal.js';
import {
  fallbackProposedGraph,
  proposeTurnGraphFromGoal,
  validateProposedGraph,
} from './turn-graph-proposal.js';

function walkingSkeletonGoal(families: readonly [string, string]) {
  return compileAcceptedGoal({
    text: 'Read the source, derive evidence-backed changes, create one artifact, then update the tracker',
    sourceUserSeq: 9001,
    multiItem: { itemCount: 5, isMultiItem: false, collectThenConstruct: true },
    destinations: [
      { posture: 'create_new', family: families[0], handleRequired: true },
      { posture: 'named_existing', family: families[1], handleRequired: false },
    ],
  });
}

test('walking skeleton is a DAG: source, transform, two sinks, not a one-destination vertical', () => {
  const goal = walkingSkeletonGoal(['artifact-alpha', 'tracker-beta']);
  const { proposed } = proposeTurnGraphFromGoal(goal);
  const validated = validateProposedGraph(goal, proposed);
  assert.equal(validated.ok, true, validated.ok ? '' : validated.reason);

  const destWrites = proposed.nodes.filter((node) => (
    node.kind === 'execute' && (node.capabilityRole === 'destination' || node.capabilityRole === 'create')
  ));
  assert.equal(destWrites.length, 2);
  assert.ok(proposed.nodes.some((node) => node.capabilityRole === 'transform'));
  assert.equal(
    proposed.nodes.filter((node) => node.kind === 'retrieve' && node.capabilityRole !== 'readback').length,
    1,
  );
  assert.deepEqual(proposed.destinationFamilies, ['artifact-alpha', 'tracker-beta']);
  assert.equal(proposed.destinationFamily, 'artifact-alpha');
  assert.deepEqual(destinationsOf(goal).map((sink) => sink.family), ['artifact-alpha', 'tracker-beta']);
});

test('a multi-sink proposal that drops a destination is refused', () => {
  const goal = walkingSkeletonGoal(['artifact-alpha', 'tracker-beta']);
  const proposed = fallbackProposedGraph(goal);
  const truncated = {
    ...proposed,
    nodes: proposed.nodes.filter((node) => node.id !== 'op-write-1' && node.id !== 'op-readback-1'),
    destinationFamilies: ['artifact-alpha'],
  };
  const validated = validateProposedGraph(goal, truncated);
  assert.equal(validated.ok, false);
  if (!validated.ok) {
    assert.match(validated.reason, /destination/);
  }
});

test('renaming destination families keeps an isomorphic plan', () => {
  const original = proposeTurnGraphFromGoal(walkingSkeletonGoal(['artifact-alpha', 'tracker-beta'])).proposed;
  const renamed = proposeTurnGraphFromGoal(walkingSkeletonGoal(['sink-one', 'sink-two'])).proposed;
  const shapeOf = (proposed: typeof original) => ({
    kinds: proposed.nodes.map((node) => `${node.kind}:${node.capabilityRole ?? ''}`),
    destCount: proposed.destinationFamilies?.length,
    transform: proposed.nodes.some((node) => node.capabilityRole === 'transform'),
  });
  assert.deepEqual(shapeOf(renamed), shapeOf(original));
  assert.deepEqual(renamed.destinationFamilies, ['sink-one', 'sink-two']);
});
