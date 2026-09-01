import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FreshActionPlanDraftSchema,
  collectConstructLineageCompleteness,
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
  assert.equal(derivePlanConstructFromTopology({
    version: 1,
    operations: [
      {
        id: 'read_gate', effect: 'read', coverage: 'single',
        dependsOn: [], dataFrom: [], cardinality: { kind: 'once' },
      },
      {
        id: 'ordered_static_write', effect: 'external_write',
        dependsOn: ['read_gate'], dataFrom: [], cardinality: { kind: 'once' },
      },
    ],
    universes: [],
  }), 'single_act', 'dependsOn alone is ordering, never inferred payload lineage');
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
  assert.deepEqual(collectConstructLineageCompleteness(valid), { ok: true });
  const missingLineage = structuredClone(valid);
  missingLineage.topology.operations[1]!.dataFrom = [];
  assert.deepEqual(collectConstructLineageCompleteness(missingLineage), {
    ok: false,
    writeOperationIds: ['write_once'],
    sourceOperationIds: ['read_source'],
  });
  assert.equal(FreshActionPlanDraftSchema.safeParse({
    ...valid,
    construct: 'fanout',
  }).success, false, 'model-authored construct label reintroduced a second topology');
  assert.equal(FreshActionPlanDraftSchema.safeParse({
    ...valid,
    bindings: valid.bindings.slice(0, 1),
  }).success, false, 'partial binding coverage crossed the plan boundary');
});

test('fresh plan schema exposes truthful bounded resolved-operation root reads', () => {
  const draft = {
    criteria: ['Run one bounded current-news lookup and create one grounded Workspace.'],
    cardinality: {
      count: 5,
      fields: ['body', 'citations'],
      locator: {
        contract: 'workspace_social_posts_v1',
        collectionPointer: '/posts',
        visibleMirrorPointer: '/_mobile/records/items',
        calendarPointer: '/calendar',
        calendarRequiredFields: ['date', 'channel', 'theme'],
        sourceEvidence: {
          operationId: 'research',
          recordsPointer: '/news',
          minDistinctRecords: 3,
          titlePointer: '/title',
          urlPointer: '/url',
          publishedDatePointer: '/date',
          findingPointers: ['/snippet', '/description', '/content', '/markdown'],
          publisherPointer: '/publisher',
          maxAgeDays: 30,
        },
      },
    },
    destination: { posture: 'create_new', family: 'workspace', handleRequired: true },
    topology: {
      version: 1,
      operations: [
        {
          id: 'research', effect: 'read', coverage: 'resolved_operation',
          dependsOn: [], dataFrom: [], cardinality: { kind: 'once' },
        },
        {
          id: 'author', effect: 'local_write', coverage: null,
          dependsOn: ['research'], dataFrom: ['research'], cardinality: { kind: 'once' },
        },
      ],
      universes: [],
    },
    bindings: [
      { operationId: 'research', role: 'source', capabilityRef: 'cap:read', evidence: ['records'] },
      { operationId: 'author', role: 'destination', capabilityRef: 'cap:write', evidence: ['receipt'] },
    ],
    deliverables: [{ id: 'workspace', kind: 'workspace' }],
    evidenceRequirements: ['records', 'receipt'],
  };
  const parsed = FreshActionPlanDraftSchema.safeParse(draft);
  assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
  assert.equal(
    parsed.success && parsed.data.topology.operations[0]?.coverage,
    'resolved_operation',
    'the producer/parser retains the exact non-exhaustive coverage declaration',
  );
  assert.equal(FreshActionPlanDraftSchema.safeParse({
    ...draft,
    cardinality: { count: 5, fields: ['body', 'citations'] },
  }).success, false, 'a counted Workspace cannot omit its exact structured locator');
  assert.equal(FreshActionPlanDraftSchema.safeParse({
    ...draft,
    cardinality: {
      ...draft.cardinality,
      locator: { ...draft.cardinality.locator, collectionPointer: '/_proof' },
    },
  }).success, false, 'a hidden array cannot replace the canonical visible posts collection');
  assert.equal(FreshActionPlanDraftSchema.safeParse({
    ...draft,
    cardinality: { count: 5, fields: ['name', 'rating', 'phone'] },
  }).success, true, 'non-social counted Workspaces retain their existing generic record contract');
  const widened = structuredClone(draft);
  widened.topology.operations[0]!.cardinality = { kind: 'set', universeId: 'rows' } as never;
  widened.topology.universes = [{ id: 'rows', seal: 'accepted_input', members: ['a'] }] as never;
  assert.equal(FreshActionPlanDraftSchema.safeParse(widened).success, false,
    'resolved-operation cannot be advertised as a finite/set cardinality read');
});

// ─── A door that cannot open must not be offered ─────────────────────────────
//
// Every plan_task binding must carry a capabilityRef, and admission refuses any
// ref the host did not disclose. With an empty catalog the schema demands a
// value the description explicitly forbids inventing, and the gate rejects it
// unconditionally — there is no action the model can take that succeeds.
//
// Measured on the real home before this pin: 16 plan_task calls, 16
// `plan_not_admitted` refusals, zero successes; one turn burned six consecutive
// attempts before falling back to the direct route that worked all along.
test('plan_task is not offered when the host disclosed no citable capability', async () => {
  const { buildPlanTaskTool } = await import('./plan-tools.js');
  const identity = { sessionId: 'plan-empty-catalog', sourceUserSeq: 1 };
  const emptyCatalog = buildPlanTaskTool({
    planning: { authority: Object.freeze({}), identity, capabilities: [], digest: 'empty' },
  } as never) as unknown as { isEnabled?: () => Promise<boolean> };
  assert.equal(
    await emptyCatalog.isEnabled?.(),
    false,
    'an empty planning catalog makes every possible proposal inadmissible',
  );
});
