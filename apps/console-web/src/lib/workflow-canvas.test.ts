import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANVAS_COL,
  CANVAS_ROW,
  NEW_STEP_PROMPT,
  findCycle,
  graphDiffersFrom,
  layoutGraph,
  loadPositions,
  newStepId,
  nextFreePosition,
  positionStorageKey,
  resolvePositions,
  SAVED_PLAINLY,
  saveOutcome,
  savePositions,
  toStepPatch,
  type CanvasGraph,
} from './workflow-canvas.js';

/** A three-step fan-in, shaped like the daemon's own graph payload. */
const graph: CanvasGraph = {
  nodes: [
    { id: 'collect', label: 'Pull opportunities', dependsOn: [], plan: { levelIndex: 0, laneIndex: 0 }, meta: { sideEffect: 'read' } },
    { id: 'enrich', label: 'Enrich', dependsOn: ['collect'], plan: { levelIndex: 1, laneIndex: 0 }, meta: { sideEffect: 'read' } },
    { id: 'digest', label: 'Write the digest', dependsOn: ['collect', 'enrich'], plan: { levelIndex: 2, laneIndex: 0 } },
  ],
  edges: [
    { id: 'e1', source: 'collect', target: 'enrich' },
    { id: 'e2', source: 'collect', target: 'digest' },
    { id: 'e3', source: 'enrich', target: 'digest' },
  ],
};

const nodesOnly = (g: CanvasGraph) => g.nodes;
const edgesOnly = (g: CanvasGraph) => g.edges;

test('layout follows the daemon’s own level/lane plan', () => {
  const pos = layoutGraph(graph);
  assert.deepEqual(pos.collect, { x: 0, y: 0 });
  assert.deepEqual(pos.enrich, { x: CANVAS_COL, y: 0 });
  assert.deepEqual(pos.digest, { x: 2 * CANVAS_COL, y: 0 });
});

test('a node with no plan is layered from its dependencies, and peers get their own lanes', () => {
  // Neither node carries a plan, so both fall back to derived layering. `b` and
  // `c` both depend on `a`, so they share a level and must not overlap.
  const pos = layoutGraph({
    nodes: [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
    ],
    edges: [],
  });
  assert.deepEqual(pos.a, { x: 0, y: 0 });
  assert.equal(pos.b.x, CANVAS_COL);
  assert.equal(pos.c.x, CANVAS_COL);
  assert.notDeepEqual(pos.b, pos.c, 'two steps on one level must not stack');
  assert.equal(pos.c.y, pos.b.y + CANVAS_ROW);
});

test('a cyclic graph still lays out instead of hanging', () => {
  const pos = layoutGraph({
    nodes: [
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
    ],
    edges: [],
  });
  assert.ok(Number.isFinite(pos.a.x) && Number.isFinite(pos.b.x));
});

test('saved positions win, unsaved fall back to the computed layout', () => {
  const pos = resolvePositions(graph, { enrich: { x: 999, y: 42 } });
  assert.deepEqual(pos.enrich, { x: 999, y: 42 });
  assert.deepEqual(pos.collect, { x: 0, y: 0 }, 'unsaved node keeps its planned spot');
});

test('a corrupt saved position is ignored rather than drawn at NaN', () => {
  const pos = resolvePositions(graph, { enrich: { x: Number.NaN, y: 10 } });
  assert.deepEqual(pos.enrich, { x: CANVAS_COL, y: 0 });
});

test('a new node is placed clear of everything already on the canvas', () => {
  const spot = nextFreePosition(layoutGraph(graph));
  assert.equal(spot.x, 3 * CANVAS_COL);
  assert.deepEqual(nextFreePosition({}), { x: 0, y: 0 });
});

test('a new step id never collides with an existing one', () => {
  assert.equal(newStepId(['a', 'b']), 'step');
  assert.equal(newStepId(['step']), 'step-2');
  assert.equal(newStepId(['step', 'step-2']), 'step-3');
  assert.equal(newStepId([], 'Send The Digest!'), 'send-the-digest');
  assert.equal(newStepId([], '!!!'), 'step', 'an id that sanitizes to nothing still gets one');
});

test('the step patch sends every node, with edges as the authority on dependsOn', () => {
  const patch = toStepPatch(nodesOnly(graph), edgesOnly(graph));
  assert.deepEqual(patch.map((s) => s.id), ['collect', 'enrich', 'digest'], 'dependencies come first');
  assert.deepEqual(patch.find((s) => s.id === 'digest')?.dependsOn, ['collect', 'enrich']);
  assert.deepEqual(patch.find((s) => s.id === 'collect')?.dependsOn, []);
});

test('a step the canvas did not create carries no prompt, so the PATCH merge keeps the authored one', () => {
  const patch = toStepPatch(nodesOnly(graph), edgesOnly(graph));
  assert.ok(patch.every((s) => s.prompt === undefined), 'sending a prompt would clobber the stored one');
});

test('a step the canvas created carries a prompt, because there is nothing to merge over', () => {
  const nodes = [...nodesOnly(graph), { id: 'notify', dependsOn: [] }];
  const patch = toStepPatch(nodes, edgesOnly(graph), ['notify']);
  assert.equal(patch.find((s) => s.id === 'notify')?.prompt, NEW_STEP_PROMPT);
});

test('disconnecting an edge actually clears the dependency', () => {
  // `dependsOn` on the node still says collect+enrich; the edges no longer do.
  const patch = toStepPatch(nodesOnly(graph), [{ id: 'e1', source: 'collect', target: 'enrich' }]);
  assert.deepEqual(patch.find((s) => s.id === 'digest')?.dependsOn, [], 'stale node deps must not resurrect');
});

test('edges to a removed node, and self-edges, are dropped from the patch', () => {
  const nodes = nodesOnly(graph).filter((n) => n.id !== 'enrich');
  const edges = [...edgesOnly(graph), { id: 'self', source: 'digest', target: 'digest' }];
  const patch = toStepPatch(nodes, edges);
  assert.deepEqual(patch.map((s) => s.id).sort(), ['collect', 'digest']);
  assert.deepEqual(patch.find((s) => s.id === 'digest')?.dependsOn, ['collect'], 'no dep on a deleted step, no self-dep');
});

test('a cyclic graph still emits every step rather than silently dropping one', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }];
  const edges = [
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'b', target: 'a' },
  ];
  assert.deepEqual(toStepPatch(nodes, edges).map((s) => s.id).sort(), ['a', 'b']);
});

test('findCycle reports the loop, and stays quiet on a DAG', () => {
  assert.equal(findCycle(nodesOnly(graph), edgesOnly(graph)), null);

  const cycle = findCycle(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
      { id: 'e3', source: 'c', target: 'a' },
    ],
  );
  assert.ok(cycle, 'a three-node loop is a cycle');
  assert.equal(cycle[0], cycle[cycle.length - 1], 'the path closes on itself');
  assert.deepEqual([...new Set(cycle)].sort(), ['a', 'b', 'c']);
});

test('findCycle catches a self-edge', () => {
  assert.ok(findCycle([{ id: 'a' }], [{ id: 'e', source: 'a', target: 'a' }]));
});

test('a diamond is not a cycle', () => {
  const cycle = findCycle(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'a', target: 'c' },
      { id: 'e3', source: 'b', target: 'd' },
      { id: 'e4', source: 'c', target: 'd' },
    ],
  );
  assert.equal(cycle, null, 'fan-out then fan-in is a DAG, not a loop');
});

test('an unchanged graph is not dirty; a rewire, an add and a delete all are', () => {
  assert.equal(graphDiffersFrom(graph, toStepPatch(nodesOnly(graph), edgesOnly(graph))), false);

  const rewired = toStepPatch(nodesOnly(graph), [{ id: 'e1', source: 'collect', target: 'enrich' }]);
  assert.equal(graphDiffersFrom(graph, rewired), true, 'a removed dependency is a change');

  const added = toStepPatch([...nodesOnly(graph), { id: 'extra' }], edgesOnly(graph), ['extra']);
  assert.equal(graphDiffersFrom(graph, added), true, 'a new step is a change');

  const removed = toStepPatch(nodesOnly(graph).filter((n) => n.id !== 'digest'), edgesOnly(graph));
  assert.equal(graphDiffersFrom(graph, removed), true, 'a deleted step is a change');
});

test('dirtiness ignores the order dependencies are listed in', () => {
  const reordered = toStepPatch(nodesOnly(graph), [
    { id: 'e3', source: 'enrich', target: 'digest' },
    { id: 'e2', source: 'collect', target: 'digest' },
    { id: 'e1', source: 'collect', target: 'enrich' },
  ]);
  assert.equal(graphDiffersFrom(graph, reordered), false, 'same dependencies, different order, no change');
});

test('a save that turned the workflow off says so, rather than reporting a plain success', () => {
  assert.equal(
    saveOutcome({ enabled: false, verificationQueued: true, message: 'Testing the new shape first.' }),
    'Testing the new shape first.',
    'the daemon’s own wording wins when it sent one',
  );

  const queuedWithoutMessage = saveOutcome({ enabled: false, verificationQueued: true });
  assert.match(queuedWithoutMessage, /turned off/, 'a queued verification must not read as "Saved."');

  assert.match(saveOutcome({ enabled: false }), /off/, 'a workflow left off must say so');
});

test('automatic repairs are reported, and a blank message does not win over the fallback', () => {
  assert.equal(
    saveOutcome({ repairs: ['Removed pinned model "x" from step "a".'] }),
    'Saved, with 1 automatic repair: Removed pinned model "x" from step "a".',
  );
  assert.match(saveOutcome({ repairs: ['one', 'two'] }), /2 automatic repairs: one; two/);
  assert.match(
    saveOutcome({ verificationQueued: true, message: '   ' }),
    /turned off/,
    'a whitespace message is not a message',
  );
});

test('an ordinary save is plain, and a missing or empty result never invents an outcome', () => {
  assert.equal(saveOutcome({}), SAVED_PLAINLY);
  assert.equal(saveOutcome(null), SAVED_PLAINLY);
  assert.equal(saveOutcome(undefined), SAVED_PLAINLY);
  assert.equal(saveOutcome({ enabled: true, repairs: [] }), SAVED_PLAINLY);
});

/** A localStorage stand-in; the module must never require a real browser. */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    dump: () => Object.fromEntries(map),
  };
}

test('positions round-trip through storage, namespaced per workflow', () => {
  const store = fakeStorage();
  savePositions('friday-digest', { collect: { x: 10, y: 20 } }, store);
  assert.deepEqual(loadPositions('friday-digest', store), { collect: { x: 10, y: 20 } });
  assert.deepEqual(loadPositions('other-workflow', store), {}, 'another workflow sees none of it');
  assert.ok(Object.keys(store.dump())[0].includes('friday-digest'));
  assert.notEqual(positionStorageKey('a'), positionStorageKey('b'));
});

test('unreadable, malformed and non-numeric stored positions all degrade to none', () => {
  assert.deepEqual(loadPositions('w', fakeStorage({ [positionStorageKey('w')]: 'not json' })), {});
  assert.deepEqual(loadPositions('w', fakeStorage({ [positionStorageKey('w')]: '[1,2]' })), {});
  assert.deepEqual(
    loadPositions('w', fakeStorage({ [positionStorageKey('w')]: '{"a":{"x":"1","y":2},"b":{"x":3,"y":4}}' })),
    { b: { x: 3, y: 4 } },
    'a bad entry is skipped, a good one survives',
  );

  const throwing = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  assert.deepEqual(loadPositions('w', throwing), {}, 'blocked site data must not break the canvas');
  assert.doesNotThrow(() => savePositions('w', { a: { x: 1, y: 2 } }, throwing));
});
