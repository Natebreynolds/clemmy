import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FreshActionPlanDraftSchema,
  derivePlanConstructFromTopology,
} from './plan-tools.js';
import type { WorkTopologyV1 } from '../runtime/graph/work-topology.js';

function aggregate(): WorkTopologyV1 {
  return {
    version: 1,
    operations: [
      {
        id: 'read_source', effect: 'read', coverage: 'complete_set',
        dependsOn: [], dataFrom: [], cardinality: { kind: 'once' },
      },
      {
        id: 'write_once', effect: 'external_write',
        dependsOn: ['read_source'], dataFrom: ['read_source'], cardinality: { kind: 'once' },
      },
    ],
    universes: [],
  };
}

test('plan construct is host-derived from canonical topology, never item count or a copied label', () => {
  assert.equal(derivePlanConstructFromTopology(aggregate()), 'collect_then_construct');
  assert.equal(derivePlanConstructFromTopology({
    version: 1,
    operations: [
      {
        id: 'write_each', effect: 'external_write', dependsOn: [], dataFrom: [],
        cardinality: { kind: 'each', universeId: 'items' },
      },
    ],
    universes: [{ id: 'items', seal: 'accepted_input', members: ['a', 'b'] }],
  }), 'fanout');
  assert.equal(derivePlanConstructFromTopology({
    version: 1,
    operations: [{
      id: 'write_once', effect: 'external_write', dependsOn: [], dataFrom: [],
      cardinality: { kind: 'once' },
    }],
    universes: [],
  }), 'single_act');
});

test('fresh plan schema has one topology and capability-only bindings', () => {
  const valid = {
    criteria: ['Collect the exact set and create one artifact.'],
    cardinality: { count: 100, fields: ['id'] },
    destination: { posture: 'create_new', family: 'sheet', handleRequired: true },
    topology: {
      version: 1,
      operations: aggregate().operations.map((operation) => ({
        ...operation,
        coverage: operation.effect === 'read' ? operation.coverage : null,
      })),
      universes: [],
    },
    bindings: [
      { operationId: 'read_source', role: 'source', capabilityRef: 'cap:read', evidence: ['records'] },
      { operationId: 'write_once', role: 'destination', capabilityRef: 'cap:write', evidence: ['receipt'] },
    ],
    deliverables: [{ id: 'sheet', kind: 'sheet' }],
    evidenceRequirements: ['records', 'receipt'],
  };
  assert.equal(FreshActionPlanDraftSchema.safeParse(valid).success, true);
  assert.equal(FreshActionPlanDraftSchema.safeParse({
    ...valid,
    construct: 'fanout',
  }).success, false, 'model-authored construct label reintroduced a second topology');
  assert.equal(FreshActionPlanDraftSchema.safeParse({
    ...valid,
    bindings: valid.bindings.slice(0, 1),
  }).success, false, 'partial binding coverage crossed the plan boundary');
});

// REGRESSION PIN (live 2026-08-24): weekly-review died on
//   work.topology (operation[1].coverage and cardinality describe different read sets)
// `coverage` and `cardinality` are two views of one fact, and requiring an
// author to state both consistently was the last member of a class that killed
// real scheduled work -- alongside topologyHash (a host-computed sha256) and
// capability-binding effect/dependsOn (a hand-copied restatement of the
// canonical topology). Coverage is now HOST-DERIVED from cardinality.
//
// The direction matters as much as the reconciliation: an ambiguous `once`
// resolves to `single`, never `complete_set`. Widening a read's claimed coverage
// is exactly the unsupported universal claim honest-coverage forbids.
test('read coverage is derived from cardinality and never widened', async () => {
  const { validateWorkTopology } = await import('../runtime/graph/work-topology.js');
  // `each`/`set` consume a universe; `once` must not declare an unconsumed one.
  const read = (cardinality: unknown, coverage: string, withUniverse: boolean) => validateWorkTopology({
    version: 1,
    operations: [{ id: 'src', effect: 'read', coverage, dependsOn: [], dataFrom: [], cardinality }],
    universes: withUniverse ? [{ id: 'u1', seal: 'accepted_input', members: ['m1', 'm2'] }] : [],
  } as never);

  // Cardinality forces the answer: a mismatched declaration is NORMALIZED, not
  // refused. Each of these combinations used to be a hard validation error.
  const perItem = read({ kind: 'each', universeId: 'u1' }, 'complete_set', true);
  assert.equal(perItem.ok, true, `each+complete_set must reconcile: ${JSON.stringify(perItem)}`);
  if (perItem.ok) assert.equal(perItem.topology.operations[0].coverage, 'single');

  const overSet = read({ kind: 'set', universeId: 'u1' }, 'single', true);
  assert.equal(overSet.ok, true, `set+single must reconcile: ${JSON.stringify(overSet)}`);
  if (overSet.ok) assert.equal(overSet.topology.operations[0].coverage, 'accepted_set');

  // `once` genuinely admits both, so a legal declaration stands.
  const declaredComplete = read({ kind: 'once' }, 'complete_set', false);
  assert.equal(declaredComplete.ok, true, JSON.stringify(declaredComplete));
  if (declaredComplete.ok) {
    assert.equal(declaredComplete.topology.operations[0].coverage, 'complete_set');
  }

  // An ILLEGAL pairing on `once` falls back to the CONSERVATIVE value rather
  // than keeping an over-claim: widening a read's coverage is exactly the
  // unsupported universal claim honest-coverage forbids.
  const illegalOnce = read({ kind: 'once' }, 'accepted_set', false);
  assert.equal(illegalOnce.ok, true, JSON.stringify(illegalOnce));
  if (illegalOnce.ok) {
    assert.equal(
      illegalOnce.topology.operations[0].coverage,
      'single',
      'an ambiguous once must never be widened into a complete_set claim',
    );
  }
});
