import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AcceptedTaskWorkContractV1,
  ExpectedWorkOperationV1,
  ExpectedWorkUniverseV1,
} from './expected-work-contract.js';
import {
  matchExpectedWork,
  type ObservedExpectedWorkHistoryV1,
  type ObservedExpectedWorkOperationV1,
} from './expected-work-matcher.js';

function contract(input: {
  operations: ExpectedWorkOperationV1[];
  universes?: ExpectedWorkUniverseV1[];
  plannerSource?: AcceptedTaskWorkContractV1['plannerSource'];
}): AcceptedTaskWorkContractV1 {
  return {
    version: 1,
    contractId: 'expected-work:v1:test-only',
    identity: { sessionId: 'matcher', sourceUserSeq: 7, turn: 1 },
    acceptedTaskId: 'task:matcher#7',
    graphEventId: 'graph-event',
    graphId: 'turn-graph:v1:7',
    graphHash: 'a'.repeat(64),
    plannerSource: input.plannerSource ?? 'structured_model',
    operations: input.operations,
    universes: input.universes ?? [],
  };
}

function once(input: {
  id: string;
  effect: ExpectedWorkOperationV1['effect'];
  coverage?: ExpectedWorkOperationV1['coverage'];
  dependsOn?: string[];
  dataFrom?: string[];
}): ExpectedWorkOperationV1 {
  return {
    id: input.id,
    effect: input.effect,
    ...(input.coverage ? { coverage: input.coverage } : {}),
    dependsOn: input.dependsOn ?? [],
    dataFrom: input.dataFrom ?? [],
    cardinality: { kind: 'once' },
  };
}

function observed(input: Partial<ObservedExpectedWorkOperationV1> & {
  id: string;
  effect: ObservedExpectedWorkOperationV1['effect'];
}): ObservedExpectedWorkOperationV1 {
  return {
    id: input.id,
    effect: input.effect,
    outcome: input.outcome ?? 'succeeded',
    evidenceMode: input.evidenceMode ?? (
      input.effect === 'read' ? 'point_read'
        : input.effect === 'compute' ? 'compute'
          : 'unknown_write'
    ),
    coverage: input.coverage ?? (input.effect === 'read' ? 'observed' : 'not_applicable'),
    ...(input.requirementId ? { requirementId: input.requirementId } : {}),
    ...(input.universeItemId ? { universeItemId: input.universeItemId } : {}),
  };
}

function finalized(
  operations: ObservedExpectedWorkOperationV1[],
  overrides: Partial<ObservedExpectedWorkHistoryV1> = {},
): ObservedExpectedWorkHistoryV1 {
  return { finalized: true, operations, universes: [], ...overrides };
}

function gapKinds(result: ReturnType<typeof matchExpectedWork>): string[] {
  return result.gaps.map((gap) => gap.kind).sort();
}

const PIPELINE = contract({
  operations: [
    once({ id: 'source', effect: 'read', coverage: 'complete_set' }),
    once({
      id: 'commit',
      effect: 'external_write',
      dependsOn: ['source'],
      dataFrom: ['source'],
    }),
  ],
});

test('a finalized observed history remains incomplete when expected operations are absent', () => {
  const result = matchExpectedWork(PIPELINE, finalized([]));
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.bindings, []);
  assert.deepEqual(
    result.gaps.filter((gap) => gap.kind === 'requirement_unobserved')
      .map((gap) => gap.requirementId).sort(),
    ['commit', 'source'],
  );
});

test('extra operations cannot substitute for a missing expected operation', () => {
  const result = matchExpectedWork(PIPELINE, finalized([
    observed({ id: 'extra-read', effect: 'read', evidenceMode: 'point_read' }),
    observed({ id: 'commit-call', requirementId: 'commit', effect: 'external_write' }),
  ]));
  assert.equal(result.status, 'incomplete');
  assert.ok(result.gaps.some((gap) =>
    gap.kind === 'requirement_unobserved' && gap.requirementId === 'source'));
  assert.ok(result.gaps.some((gap) =>
    gap.kind === 'dependency_unsatisfied' && gap.requirementId === 'commit'));
  assert.deepEqual(result.extras, ['extra-read']);
});

test('effect matching is exact across local, external, and admin writes', () => {
  const external = contract({ operations: [once({ id: 'send', effect: 'external_write' })] });
  const wrongExternal = matchExpectedWork(external, finalized([
    observed({ id: 'local-call', requirementId: 'send', effect: 'local_write' }),
  ]));
  assert.equal(wrongExternal.status, 'conflict');
  assert.ok(wrongExternal.gaps.some((gap) => gap.kind === 'effect_mismatch'));

  const admin = contract({ operations: [once({ id: 'delete-account', effect: 'admin' })] });
  const wrongAdmin = matchExpectedWork(admin, finalized([
    observed({ id: 'local-call', requirementId: 'delete-account', effect: 'local_write' }),
  ]));
  assert.equal(wrongAdmin.status, 'conflict');
  assert.ok(wrongAdmin.gaps.some((gap) => gap.kind === 'effect_mismatch'));
});

test('explicit requirement ids bind a compound history; unbound action calls do not', () => {
  const source = observed({
    id: 'source-call',
    requirementId: 'source',
    effect: 'read',
    evidenceMode: 'collection_read',
    coverage: 'complete',
  });
  const commit = observed({
    id: 'commit-call',
    requirementId: 'commit',
    effect: 'external_write',
  });
  assert.equal(matchExpectedWork(PIPELINE, finalized([source, commit])).status, 'complete');
  const unbound = matchExpectedWork(PIPELINE, finalized([
    { ...source, requirementId: undefined },
    { ...commit, requirementId: undefined },
  ]));
  assert.equal(unbound.status, 'conflict');
  assert.ok(unbound.gaps.some((gap) =>
    gap.kind === 'unexpected_effectful_observation'
    && gap.observedOperationId === 'commit-call'));
  assert.deepEqual(unbound.extras.sort(), ['commit-call', 'source-call']);
});

test('implicit binding is limited to the deterministic one-operation retrieve contract', () => {
  const retrieve = contract({
    plannerSource: 'deterministic',
    operations: [once({ id: 'retrieve', effect: 'read', coverage: 'resolved_operation' })],
  });
  const read = observed({ id: 'read-call', effect: 'read', evidenceMode: 'point_read' });
  const implicit = matchExpectedWork(retrieve, finalized([read]));
  assert.equal(implicit.status, 'complete');
  assert.deepEqual(implicit.bindings, [{
    requirementId: 'retrieve',
    observedOperationId: 'read-call',
  }]);

  const modelAuthored = contract({
    operations: [once({ id: 'retrieve', effect: 'read', coverage: 'resolved_operation' })],
  });
  const refused = matchExpectedWork(modelAuthored, finalized([read]));
  assert.equal(refused.status, 'incomplete');
  assert.ok(refused.gaps.some((gap) => gap.kind === 'requirement_unobserved'));
});

test('implicit retrieve conflicts instead of arbitrarily choosing among multiple eligible reads', () => {
  const retrieve = contract({
    plannerSource: 'deterministic',
    operations: [once({ id: 'retrieve', effect: 'read', coverage: 'resolved_operation' })],
  });
  const result = matchExpectedWork(retrieve, finalized([
    observed({ id: 'first-read', effect: 'read', evidenceMode: 'point_read' }),
    observed({ id: 'second-read', effect: 'read', evidenceMode: 'point_read' }),
  ]));
  assert.equal(result.status, 'conflict');
  assert.ok(result.gaps.some((gap) =>
    gap.kind === 'requirement_ambiguous' && gap.requirementId === 'retrieve'));
  assert.deepEqual(result.bindings, []);
});

test('an undeclared effectful business operation conflicts with otherwise complete work', () => {
  const retrieve = contract({
    plannerSource: 'deterministic',
    operations: [once({ id: 'retrieve', effect: 'read', coverage: 'resolved_operation' })],
  });
  const result = matchExpectedWork(retrieve, finalized([
    observed({ id: 'expected-read', effect: 'read', evidenceMode: 'point_read' }),
    observed({ id: 'unexpected-send', effect: 'external_write' }),
  ]));
  assert.equal(result.status, 'conflict');
  assert.ok(result.gaps.some((gap) =>
    gap.kind === 'unexpected_effectful_observation'
    && gap.observedOperationId === 'unexpected-send'));
  assert.deepEqual(result.extras, ['unexpected-send']);
});

test('resolved-operation coverage delegates point versus collection proof to host evidence mode', () => {
  const retrieve = contract({
    plannerSource: 'deterministic',
    operations: [once({ id: 'retrieve', effect: 'read', coverage: 'resolved_operation' })],
  });
  assert.equal(matchExpectedWork(retrieve, finalized([
    observed({ id: 'point', effect: 'read', evidenceMode: 'point_read', coverage: 'observed' }),
  ])).status, 'complete');
  const partial = matchExpectedWork(retrieve, finalized([
    observed({ id: 'page-one', effect: 'read', evidenceMode: 'collection_read', coverage: 'partial' }),
  ]));
  assert.equal(partial.status, 'incomplete');
  assert.ok(partial.gaps.some((gap) => gap.kind === 'coverage_unproven'));
  assert.equal(matchExpectedWork(retrieve, finalized([
    observed({ id: 'all-pages', effect: 'read', evidenceMode: 'collection_read', coverage: 'complete' }),
  ])).status, 'complete');
});

test('a downstream operation stays incomplete until its dependency is fully proved', () => {
  const result = matchExpectedWork(PIPELINE, finalized([
    observed({
      id: 'source-page',
      requirementId: 'source',
      effect: 'read',
      evidenceMode: 'collection_read',
      coverage: 'partial',
    }),
    observed({ id: 'commit-call', requirementId: 'commit', effect: 'external_write' }),
  ]));
  assert.equal(result.status, 'incomplete');
  assert.ok(result.gaps.some((gap) =>
    gap.kind === 'coverage_unproven' && gap.requirementId === 'source'));
  assert.ok(result.gaps.some((gap) =>
    gap.kind === 'dependency_unsatisfied' && gap.requirementId === 'commit'));
});

test('accepted-input fanout requires one explicitly bound operation per exact item', () => {
  const fanout = contract({
    operations: [{
      id: 'send_each',
      effect: 'external_write',
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'each', universeId: 'recipients' },
    }],
    universes: [{ id: 'recipients', seal: 'accepted_input', members: ['alice', 'bob'] }],
  });
  const alice = observed({
    id: 'send-alice',
    requirementId: 'send_each',
    universeItemId: 'alice',
    effect: 'external_write',
  });
  const missing = matchExpectedWork(fanout, finalized([alice]));
  assert.equal(missing.status, 'incomplete');
  assert.ok(missing.gaps.some((gap) =>
    gap.kind === 'cardinality_item_missing' && gap.universeItemId === 'bob'));

  const unknown = matchExpectedWork(fanout, finalized([
    alice,
    observed({
      id: 'send-charlie',
      requirementId: 'send_each',
      universeItemId: 'charlie',
      effect: 'external_write',
    }),
  ]));
  assert.equal(unknown.status, 'conflict');
  assert.ok(unknown.gaps.some((gap) => gap.kind === 'universe_item_unknown'));

  const complete = matchExpectedWork(fanout, finalized([
    alice,
    observed({
      id: 'send-bob',
      requirementId: 'send_each',
      universeItemId: 'bob',
      effect: 'external_write',
    }),
  ]));
  assert.equal(complete.status, 'complete');
});

test('source-derived fanout fails closed until its universe is completely sealed and covered', () => {
  const fanout = contract({
    operations: [
      once({ id: 'source', effect: 'read', coverage: 'complete_set' }),
      {
        id: 'write_each',
        effect: 'local_write',
        dependsOn: ['source'],
        dataFrom: ['source'],
        cardinality: { kind: 'each', universeId: 'source_items' },
      },
    ],
    universes: [{
      id: 'source_items',
      seal: 'complete_source_receipt',
      producedBy: 'source',
    }],
  });
  const source = observed({
    id: 'source-call',
    requirementId: 'source',
    effect: 'read',
    evidenceMode: 'collection_read',
    coverage: 'complete',
  });
  const noSeal = matchExpectedWork(fanout, finalized([source]));
  assert.equal(noSeal.status, 'incomplete');
  assert.ok(noSeal.gaps.some((gap) => gap.kind === 'universe_unsealed'));

  const sealedHistory: ObservedExpectedWorkHistoryV1 = finalized([
    source,
    observed({
      id: 'write-a',
      requirementId: 'write_each',
      universeItemId: 'a',
      effect: 'local_write',
    }),
  ], {
    universes: [{
      universeId: 'source_items',
      seal: 'complete_source_receipt',
      producerRequirementId: 'source',
      complete: true,
      members: ['a', 'b'],
    }],
  });
  const missingItem = matchExpectedWork(fanout, sealedHistory);
  assert.equal(missingItem.status, 'incomplete');
  assert.ok(missingItem.gaps.some((gap) =>
    gap.kind === 'cardinality_item_missing' && gap.universeItemId === 'b'));

  const complete = matchExpectedWork(fanout, {
    ...sealedHistory,
    operations: [
      ...sealedHistory.operations,
      observed({
        id: 'write-b',
        requirementId: 'write_each',
        universeItemId: 'b',
        effect: 'local_write',
      }),
    ],
  });
  assert.equal(complete.status, 'complete');
});

test('duplicate once bindings, unknown requirement ids, and an open history fail closed', () => {
  const retrieve = contract({
    plannerSource: 'deterministic',
    operations: [once({ id: 'retrieve', effect: 'read', coverage: 'resolved_operation' })],
  });
  const duplicate = matchExpectedWork(retrieve, finalized([
    observed({ id: 'read-one', requirementId: 'retrieve', effect: 'read' }),
    observed({ id: 'read-two', requirementId: 'retrieve', effect: 'read' }),
  ]));
  assert.equal(duplicate.status, 'conflict');
  assert.ok(duplicate.gaps.some((gap) => gap.kind === 'requirement_ambiguous'));

  const unknown = matchExpectedWork(retrieve, finalized([
    observed({ id: 'read-one', requirementId: 'not-in-contract', effect: 'read' }),
  ]));
  assert.equal(unknown.status, 'conflict');
  assert.ok(unknown.gaps.some((gap) => gap.kind === 'requirement_unknown'));

  const open = matchExpectedWork(retrieve, {
    finalized: false,
    operations: [observed({ id: 'read-one', effect: 'read' })],
    universes: [],
  });
  assert.equal(open.status, 'incomplete');
  assert.deepEqual(gapKinds(open), ['history_not_finalized']);
});
