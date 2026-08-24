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
