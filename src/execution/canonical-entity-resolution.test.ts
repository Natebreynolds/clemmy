import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CanonicalEntityContractError,
  applyCoveragePage,
  createDatasetCoverageState,
  createEntityObservation,
  createEntityResolutionPolicySnapshot,
  createEntityResolutionState,
  summarizeDatasetCoverage,
  upsertEntityObservation,
  upsertEntityObservationBatch,
  type EntityObservationInput,
  type EntityResolutionPolicy,
} from './canonical-entity-resolution.js';

const POLICY: EntityResolutionPolicy = {
  policyId: 'policy-v1',
  mergeThreshold: 10,
  distinctThreshold: 2,
  ambiguityMargin: 1,
  weights: {
    defaultExactIdentifierMatch: 10,
    defaultCompoundSignalMatch: 4,
  },
  exclusiveIdentifierNamespaces: ['index'],
};

function observed(input: {
  key: string;
  at?: string;
  label?: string;
  confidence?: number;
  exact?: readonly { namespace: string; value: string }[];
  signals?: EntityObservationInput['compoundSignals'];
}): EntityObservationInput {
  const at = input.at ?? '2026-01-01T00:00:00.000Z';
  return {
    entityKind: 'unit',
    origin: { sourceId: 'source', recordId: input.key },
    observedAt: at,
    fields: {
      label: {
        value: input.label ?? input.key,
        provenance: { sourceId: 'source', recordId: input.key, path: 'label' },
        confidence: input.confidence ?? 0.8,
        observedAt: at,
      },
    },
    exactIdentifiers: input.exact,
    compoundSignals: input.signals,
  };
}

const sharedSignal = (left = 'Blue', right = 'North'): EntityObservationInput['compoundSignals'] => [{
  name: 'descriptor',
  components: { left, right },
}];

test('observation identity is stable across semantic ordering and generic signal normalization', () => {
  const first = createEntityObservation({
    entityKind: ' UNIT ',
    origin: { sourceId: 's', recordId: 'r', revision: 'v1' },
    observedAt: '2026-01-01T00:00:00Z',
    fields: {
      Alpha: {
        value: { z: 2, a: 1 },
        provenance: { sourceId: 's', recordId: 'r', path: 'a' },
        confidence: 0.7,
        observedAt: '2026-01-01T00:00:00Z',
      },
      Beta: {
        value: ['x', 1],
        provenance: { sourceId: 's', recordId: 'r', path: 'b' },
        confidence: 0.6,
        observedAt: '2026-01-01T00:00:00Z',
      },
    },
    exactIdentifiers: [
      { namespace: 'b', value: '2' },
      { namespace: 'a', value: '1' },
    ],
    compoundSignals: [{ name: ' Pair ', components: { Right: ' NORTH ', Left: 'BLUE' } }],
  });
  const second = createEntityObservation({
    entityKind: 'unit',
    origin: { sourceId: 's', recordId: 'r', revision: 'v1' },
    observedAt: '2025-12-31T16:00:00-08:00',
    fields: {
      beta: {
        value: ['x', 1],
        provenance: { sourceId: 's', recordId: 'r', path: 'b' },
        confidence: 0.6,
        observedAt: '2025-12-31T16:00:00-08:00',
      },
      alpha: {
        value: { a: 1, z: 2 },
        provenance: { sourceId: 's', recordId: 'r', path: 'a' },
        confidence: 0.7,
        observedAt: '2025-12-31T16:00:00-08:00',
      },
    },
    exactIdentifiers: [
      { namespace: 'a', value: '1' },
      { namespace: 'b', value: '2' },
    ],
    compoundSignals: [{ name: 'pair', components: { left: 'blue', right: 'north' } }],
  });

  assert.equal(first.observationId, second.observationId);
  assert.deepEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.fields.alpha));
  assert.match(first.observationId, /^entity-observation:v1:[a-f0-9]{64}$/);
});

test('compound signal fingerprints are labeled and length-safe', () => {
  const first = createEntityObservation(observed({
    key: 'a',
    signals: [{ name: 'pair', components: { left: 'a|b', right: 'c' } }],
  }));
  const second = createEntityObservation(observed({
    key: 'a',
    signals: [{ name: 'pair', components: { left: 'a', right: 'b|c' } }],
  }));
  assert.notEqual(
    first.compoundSignals[0].fingerprint,
    second.compoundSignals[0].fingerprint,
    'different labeled tuples cannot collide through delimiter concatenation',
  );
});

test('exact identifiers remain opaque and byte-exact', () => {
  const upper = createEntityObservation(observed({
    key: 'a',
    exact: [{ namespace: 'index', value: 'X' }],
  }));
  const lower = createEntityObservation(observed({
    key: 'a',
    exact: [{ namespace: 'index', value: 'x' }],
  }));
  assert.notEqual(upper.observationId, lower.observationId);
  assert.throws(
    () => createEntityObservation(observed({ key: 'a', exact: [{ namespace: 'index', value: ' X' }] })),
    (error: unknown) => error instanceof CanonicalEntityContractError
      && error.code === 'invalid_exact_identifier',
  );
});

test('opaque Unicode authority ordering is permutation-stable and locale-independent', () => {
  const exactIdentifiers = [
    { namespace: 'opaque', value: 'é' },
    { namespace: 'opaque', value: 'é' },
    { namespace: 'opaque', value: '\u{10000}' },
    { namespace: 'opaque', value: '\uE000' },
  ];
  const forward = createEntityObservation(observed({
    key: 'unicode-order',
    exact: exactIdentifiers,
  }));
  const reversed = createEntityObservation(observed({
    key: 'unicode-order',
    exact: [...exactIdentifiers].reverse(),
  }));

  assert.deepEqual(forward, reversed);
  assert.equal(forward.observationId, reversed.observationId);
  assert.deepEqual(
    forward.exactIdentifiers.map((identifier) => identifier.value),
    [...exactIdentifiers]
      .sort((left, right) => Buffer.compare(Buffer.from(
        JSON.stringify([left.namespace, left.value]),
      ), Buffer.from(JSON.stringify([right.namespace, right.value]))))
      .map((identifier) => identifier.value),
  );
  for (const malformed of ['\uD800', '\uDC00']) {
    assert.throws(
      () => createEntityObservation(observed({
        key: 'ill-formed-unicode',
        exact: [{ namespace: 'opaque', value: malformed }],
      })),
      (error: unknown) => error instanceof CanonicalEntityContractError
        && error.code === 'invalid_unicode',
    );
  }
});

test('reserved object keys cannot alter normalized field, signal, or policy maps', () => {
  const fieldValue = {
    value: 'x',
    provenance: { sourceId: 'source', recordId: 'reserved', path: 'x' },
    confidence: 1,
    observedAt: '2026-01-01T00:00:00.000Z',
  };
  const fields = Object.create(null) as Record<string, typeof fieldValue>;
  fields.__proto__ = fieldValue;
  assert.throws(
    () => createEntityObservation({
      entityKind: 'unit',
      origin: { sourceId: 'source', recordId: 'reserved' },
      observedAt: '2026-01-01T00:00:00.000Z',
      fields,
    }),
    (error: unknown) => error instanceof CanonicalEntityContractError
      && error.code === 'reserved_map_key',
  );

  const components = Object.create(null) as Record<string, string>;
  components.left = 'a';
  Object.defineProperty(components, 'constructor', {
    configurable: true, enumerable: true, writable: true, value: 'b',
  });
  assert.throws(
    () => createEntityObservation(observed({
      key: 'reserved-signal',
      signals: [{ name: 'pair', components }],
    })),
    (error: unknown) => error instanceof CanonicalEntityContractError
      && error.code === 'reserved_map_key',
  );

  const weights = Object.create(null) as Record<string, number>;
  weights.prototype = 2;
  assert.throws(
    () => createEntityResolutionPolicySnapshot({
      ...POLICY,
      weights: { ...POLICY.weights, compoundSignalMatches: weights },
    }),
    (error: unknown) => error instanceof CanonicalEntityContractError
      && error.code === 'reserved_map_key',
  );
});

test('opaque prototype-like values and identifiers cannot alias inherited object state', () => {
  const base = observed({ key: 'prototype-json' });
  const protoValue = JSON.parse('{"__proto__":null}') as Record<string, unknown>;
  assert.throws(
    () => createEntityObservation({
      ...base,
      fields: {
        label: {
          ...base.fields.label,
          value: protoValue,
        },
      },
    }),
    (error: unknown) => error instanceof CanonicalEntityContractError
      && error.code === 'reserved_map_key',
  );

  const first = upsertEntityObservation(
    createEntityResolutionState(),
    observed({ key: 'prototype-id-a', exact: [{ namespace: 'constructor', value: 'shared' }] }),
    POLICY,
  );
  const second = upsertEntityObservation(
    first.state,
    observed({ key: 'prototype-id-b', exact: [{ namespace: 'constructor', value: 'shared' }] }),
    POLICY,
  );
  assert.equal(second.decision.decision, 'merge', 'opaque exact namespaces use the default weight');

  const coverage = createDatasetCoverageState(
    'prototype-partition-dataset',
    { kind: 'closed', partitionIds: ['constructor'] },
    { kind: 'exact', total: 1 },
  );
  const advanced = applyCoveragePage(coverage, {
    partitionId: 'constructor',
    inputCursor: null,
    outputCursor: null,
    exhaustion: 'exhausted',
    denominator: { kind: 'exact', total: 1 },
    itemIds: ['item-1'],
  });
  assert.equal(advanced.ok, true);
  if (advanced.ok) {
    assert.equal(Object.prototype.hasOwnProperty.call(advanced.state.partitions, 'constructor'), true);
  }
});

test('canonical JSON is closed, side-effect-free, and explicitly bounded', () => {
  const base = observed({ key: 'closed-json' });
  let getterCalls = 0;
  const accessor = {} as Record<string, unknown>;
  Object.defineProperty(accessor, 'secret', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'not-authority';
    },
  });
  const values: unknown[] = [
    accessor,
    Object.assign([1, 2], { extra: true }),
    [1, , 3],
    { [Symbol('hidden')]: 'value' },
    '\uD800',
    'x'.repeat(1_048_577),
  ];
  let deep: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < 66; index += 1) deep = { child: deep };
  values.push(deep);
  for (const value of values) {
    assert.throws(
      () => createEntityObservation({
        ...base,
        fields: { label: { ...base.fields.label, value } },
      }),
      (error: unknown) => error instanceof CanonicalEntityContractError
        && (error.code === 'non_json_value'
          || error.code === 'invalid_unicode'
          || error.code === 'json_limit_exceeded'),
    );
  }
  const expectLimit = (value: unknown) => assert.throws(
    () => createEntityObservation({
      ...base,
      fields: { label: { ...base.fields.label, value } },
    }),
    (error: unknown) => error instanceof CanonicalEntityContractError
      && error.code === 'json_limit_exceeded',
  );
  expectLimit(Array.from({ length: 50_001 }, () => null));
  expectLimit(Array.from(
    { length: 4 },
    () => Array.from({ length: 50_000 }, () => null),
  ));
  expectLimit(Object.fromEntries(Array.from(
    { length: 17 },
    (_, index) => [`part-${index}`, 'x'.repeat(1_000_000)],
  )));
  assert.equal(getterCalls, 0, 'canonicalization inspects descriptors without invoking accessors');
});

test('timestamps with unsupported sub-millisecond precision cannot content-alias', () => {
  for (const at of ['2026-01-01T00:00:00.000000001Z', '2026-01-01T00:00:00.000000999Z']) {
    assert.throws(
      () => createEntityObservation(observed({ key: `submillis-${at}`, at })),
      (error: unknown) => error instanceof CanonicalEntityContractError
        && error.code === 'invalid_timestamp',
    );
  }
});

test('merge retains every conflicting field assertion and its provenance', () => {
  const firstInput = observed({
    key: 'a',
    label: 'Alpha',
    confidence: 0.6,
    exact: [{ namespace: 'index', value: 'one' }],
    signals: sharedSignal(),
  });
  const secondInput: EntityObservationInput = {
    ...observed({
      key: 'b',
      at: '2026-01-02T00:00:00Z',
      label: 'Beta',
      confidence: 0.9,
      exact: [{ namespace: 'index', value: 'one' }],
      signals: sharedSignal(' blue ', 'NORTH'),
    }),
    fields: {
      label: {
        value: 'Beta',
        provenance: { sourceId: 'source-b', recordId: 'b', path: 'display' },
        confidence: 0.9,
        observedAt: '2026-01-02T00:00:00Z',
      },
      measure: {
        value: 3,
        provenance: { sourceId: 'source-b', recordId: 'b', path: 'measure' },
        confidence: 0.7,
        observedAt: '2026-01-02T00:00:00Z',
      },
    },
  };
  const created = upsertEntityObservation(createEntityResolutionState(), firstInput, POLICY);
  assert.equal(created.decision.decision, 'distinct');
  const before = Object.values(created.state.records)[0];
  const merged = upsertEntityObservation(created.state, secondInput, POLICY);

  assert.equal(merged.decision.decision, 'merge');
  assert.equal(Object.keys(merged.state.records).length, 1);
  const record = Object.values(merged.state.records)[0];
  assert.equal(record.fields.label.evidence.length, 2);
  assert.equal(record.fields.label.conflicting, true);
  const selected = record.fields.label.evidence.find(
    (entry) => entry.evidenceId === record.fields.label.selectedEvidenceId,
  );
  assert.equal(selected?.value, 'Beta');
  assert.deepEqual(selected?.provenance, { sourceId: 'source-b', recordId: 'b', path: 'display' });
  assert.equal(record.audit.length, 2);
  assert.equal(record.audit[1].action, 'merge');
  assert.equal(record.audit[1].fieldChanges.find((change) => change.field === 'label')?.conflicting, true);

  assert.equal(before.fields.label.evidence.length, 1, 'the prior immutable state is unchanged');
  assert.ok(Object.isFrozen(record.audit));
  assert.ok(Object.isFrozen(record.audit[1]));

  const replay = upsertEntityObservation(merged.state, secondInput, {
    ...POLICY,
    policyId: 'later-policy',
    mergeThreshold: 20,
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.state, merged.state);
  assert.deepEqual(replay.decision, merged.decision, 'policy drift cannot silently re-resolve an accepted observation');
});

test('a score at the distinct boundary creates a separate canonical record', () => {
  const weakPolicy: EntityResolutionPolicy = {
    ...POLICY,
    weights: { ...POLICY.weights, defaultCompoundSignalMatch: 2 },
  };
  const first = upsertEntityObservation(
    createEntityResolutionState(),
    observed({ key: 'a', signals: sharedSignal() }),
    weakPolicy,
  );
  const second = upsertEntityObservation(
    first.state,
    observed({ key: 'b', at: '2026-01-02T00:00:00Z', signals: sharedSignal() }),
    weakPolicy,
  );
  assert.equal(second.decision.decision, 'distinct');
  assert.equal(Object.keys(second.state.records).length, 2);
});

test('equal eligible candidates quarantine instead of depending on record order', () => {
  const seedPolicy: EntityResolutionPolicy = {
    ...POLICY,
    weights: { ...POLICY.weights, defaultCompoundSignalMatch: 1 },
  };
  let state = upsertEntityObservation(
    createEntityResolutionState(),
    observed({ key: 'a', signals: sharedSignal() }),
    seedPolicy,
  ).state;
  state = upsertEntityObservation(
    state,
    observed({ key: 'b', at: '2026-01-02T00:00:00Z', signals: sharedSignal() }),
    seedPolicy,
  ).state;
  assert.equal(Object.keys(state.records).length, 2);

  const decision = upsertEntityObservation(
    state,
    observed({ key: 'c', at: '2026-01-03T00:00:00Z', signals: sharedSignal() }),
    { ...POLICY, ambiguityMargin: 0, weights: { ...POLICY.weights, defaultCompoundSignalMatch: 10 } },
  ).decision;
  assert.equal(decision.decision, 'quarantine');
  if (decision.decision === 'quarantine') {
    assert.equal(decision.reason, 'ambiguous_candidates');
    assert.equal(decision.candidates.length, 2);
    assert.deepEqual(
      decision.candidates.map((candidate) => candidate.score),
      [10, 10],
    );
  }
});

test('conflicting exclusive identifiers and underweighted exact bindings fail closed', () => {
  const first = upsertEntityObservation(
    createEntityResolutionState(),
    observed({
      key: 'a',
      exact: [{ namespace: 'index', value: 'one' }],
      signals: sharedSignal(),
    }),
    POLICY,
  );
  const conflict = upsertEntityObservation(
    first.state,
    observed({
      key: 'b',
      exact: [{ namespace: 'index', value: 'two' }],
      signals: sharedSignal(),
    }),
    { ...POLICY, weights: { ...POLICY.weights, defaultCompoundSignalMatch: 10 } },
  );
  assert.equal(conflict.decision.decision, 'quarantine');
  if (conflict.decision.decision === 'quarantine') {
    assert.equal(conflict.decision.reason, 'conflicting_exact_identifier');
  }

  const underweighted = upsertEntityObservation(
    first.state,
    observed({
      key: 'c',
      at: '2026-01-03T00:00:00Z',
      exact: [{ namespace: 'index', value: 'one' }],
    }),
    { ...POLICY, weights: { ...POLICY.weights, defaultExactIdentifierMatch: 0 } },
  );
  assert.equal(underweighted.decision.decision, 'quarantine');
  assert.equal(Object.keys(underweighted.state.records).length, 1);
});

test('batch resolution is invariant to input order and reports duplicate semantic inputs', () => {
  const inputs = [
    observed({ key: 'a', exact: [{ namespace: 'index', value: 'one' }], signals: sharedSignal() }),
    observed({
      key: 'b',
      at: '2026-01-02T00:00:00Z',
      exact: [{ namespace: 'index', value: 'one' }],
      signals: sharedSignal(),
    }),
    observed({ key: 'c', exact: [{ namespace: 'index', value: 'two' }], signals: sharedSignal('red', 'south') }),
  ];
  const forward = upsertEntityObservationBatch(createEntityResolutionState(), [...inputs, inputs[0]], POLICY);
  const reverse = upsertEntityObservationBatch(createEntityResolutionState(), [...inputs].reverse(), POLICY);

  assert.equal(forward.batchId, reverse.batchId);
  assert.deepEqual(forward.state, reverse.state);
  assert.deepEqual(forward.results, reverse.results);
  assert.deepEqual(forward.duplicateObservationIds, [createEntityObservation(inputs[0]).observationId]);
  assert.equal(Object.keys(forward.state.records).length, 2);
});

test('contract failures reject the whole batch before any returned state exists', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => upsertEntityObservationBatch(createEntityResolutionState(), [
      observed({ key: 'valid' }),
      {
        ...observed({ key: 'invalid' }),
        fields: {
          cycle: {
            value: cyclic,
            provenance: { sourceId: 'source', recordId: 'invalid' },
            confidence: 0.5,
            observedAt: '2026-01-01T00:00:00Z',
          },
        },
      },
    ], POLICY),
    (error: unknown) => error instanceof CanonicalEntityContractError
      && error.code === 'cyclic_json_value',
  );

  assert.throws(
    () => createEntityObservation({
      ...observed({ key: 'collision' }),
      fields: {
        Name: {
          value: 'a',
          provenance: { sourceId: 'source', recordId: 'collision' },
          confidence: 0.5,
          observedAt: '2026-01-01T00:00:00Z',
        },
        ' name ': {
          value: 'b',
          provenance: { sourceId: 'source', recordId: 'collision' },
          confidence: 0.5,
          observedAt: '2026-01-01T00:00:00Z',
        },
      },
    }),
    (error: unknown) => error instanceof CanonicalEntityContractError
      && error.code === 'normalized_key_collision',
  );

  assert.throws(
    () => upsertEntityObservation(createEntityResolutionState(), observed({ key: 'policy' }), {
      ...POLICY,
      distinctThreshold: POLICY.mergeThreshold,
    }),
    (error: unknown) => error instanceof CanonicalEntityContractError
      && error.code === 'invalid_resolution_policy',
  );
});

test('entity state retains every key without a fixed-size eviction boundary', () => {
  const inputs = Array.from({ length: 320 }, (_, index) => observed({
    key: `unit-${index.toString().padStart(4, '0')}`,
    label: `value-${index}`,
  }));
  const result = upsertEntityObservationBatch(createEntityResolutionState(), inputs, POLICY);
  assert.equal(Object.keys(result.state.records).length, 320);
  assert.equal(Object.keys(result.state.observations).length, 320);
  assert.equal(Object.keys(result.state.decisions).length, 320);
  assert.equal(result.results.length, 320);
});

test('coverage is complete only with a closed universe, exact denominator, and exhausted partitions', () => {
  let state = createDatasetCoverageState(
    'set-a',
    { kind: 'closed', partitionIds: ['p2', 'p1'] },
    { kind: 'exact', total: 4 },
  );
  const first = applyCoveragePage(state, {
    partitionId: 'p1',
    inputCursor: null,
    outputCursor: 'p1-next',
    exhaustion: 'more',
    denominator: { kind: 'exact', total: 2 },
    itemIds: ['a'],
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  state = first.state;
  assert.equal(summarizeDatasetCoverage(state).status, 'partial');

  const second = applyCoveragePage(state, {
    partitionId: 'p1',
    inputCursor: 'p1-next',
    outputCursor: null,
    exhaustion: 'exhausted',
    denominator: { kind: 'exact', total: 2 },
    itemIds: ['b'],
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  state = second.state;

  const third = applyCoveragePage(state, {
    partitionId: 'p2',
    inputCursor: null,
    outputCursor: null,
    exhaustion: 'exhausted',
    denominator: { kind: 'exact', total: 2 },
    itemIds: ['d', 'c'],
  });
  assert.equal(third.ok, true);
  if (!third.ok) return;
  const summary = summarizeDatasetCoverage(third.state);
  assert.deepEqual(summary, {
    status: 'complete',
    observed: 4,
    denominator: { kind: 'exact', total: 4 },
    exhaustion: 'exhausted',
    reasons: [],
  });
});

test('unknown denominator or exhaustion can never produce universal completeness', () => {
  let unknownDenominator = createDatasetCoverageState(
    'set-a',
    { kind: 'closed', partitionIds: ['p1'] },
    { kind: 'unknown' },
  );
  const exactPage = applyCoveragePage(unknownDenominator, {
    partitionId: 'p1',
    inputCursor: null,
    outputCursor: null,
    exhaustion: 'exhausted',
    denominator: { kind: 'exact', total: 1 },
    itemIds: ['a'],
  });
  assert.equal(exactPage.ok, true);
  if (!exactPage.ok) return;
  unknownDenominator = exactPage.state;
  const denominatorSummary = summarizeDatasetCoverage(unknownDenominator);
  assert.equal(denominatorSummary.status, 'unknown');
  assert.ok(denominatorSummary.reasons.includes('dataset_denominator_not_exact'));

  let unknownExhaustion = createDatasetCoverageState(
    'set-b',
    { kind: 'closed', partitionIds: ['p1'] },
    { kind: 'exact', total: 1 },
  );
  const uncertainPage = applyCoveragePage(unknownExhaustion, {
    partitionId: 'p1',
    inputCursor: null,
    outputCursor: null,
    exhaustion: 'unknown',
    denominator: { kind: 'exact', total: 1 },
    itemIds: ['a'],
  });
  assert.equal(uncertainPage.ok, true);
  if (!uncertainPage.ok) return;
  unknownExhaustion = uncertainPage.state;
  const exhaustionSummary = summarizeDatasetCoverage(unknownExhaustion);
  assert.equal(exhaustionSummary.status, 'unknown');
  assert.ok(exhaustionSummary.reasons.includes('exhaustion_unknown'));
});

test('coverage cursor gaps and denominator contradictions fail closed while exact replay is idempotent', () => {
  const initial = createDatasetCoverageState(
    'set-a',
    { kind: 'closed', partitionIds: ['p1'] },
    { kind: 'exact', total: 2 },
  );
  const pageInput = {
    partitionId: 'p1',
    inputCursor: null,
    outputCursor: 'next',
    exhaustion: 'more' as const,
    denominator: { kind: 'exact' as const, total: 2 },
    itemIds: ['a'],
  };
  const first = applyCoveragePage(initial, pageInput);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const replay = applyCoveragePage(first.state, pageInput);
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.idempotent, true);
    assert.equal(replay.state, first.state);
  }

  const gap = applyCoveragePage(first.state, {
    partitionId: 'p1',
    inputCursor: 'other',
    outputCursor: null,
    exhaustion: 'exhausted',
    denominator: { kind: 'exact', total: 2 },
    itemIds: ['b'],
  });
  assert.equal(gap.ok, false);
  if (!gap.ok) {
    assert.equal(gap.reason, 'cursor_discontinuity');
    assert.equal(gap.state, first.state);
  }

  const contradiction = applyCoveragePage(first.state, {
    partitionId: 'p1',
    inputCursor: 'next',
    outputCursor: null,
    exhaustion: 'exhausted',
    denominator: { kind: 'exact', total: 3 },
    itemIds: ['b'],
  });
  assert.equal(contradiction.ok, false);
  if (!contradiction.ok) assert.equal(contradiction.reason, 'denominator_contradiction');
});

test('an item identity appearing in two declared partitions fails closed', () => {
  let state = createDatasetCoverageState(
    'set-a',
    { kind: 'closed', partitionIds: ['p1', 'p2'] },
    { kind: 'exact', total: 2 },
  );
  const first = applyCoveragePage(state, {
    partitionId: 'p1',
    inputCursor: null,
    outputCursor: null,
    exhaustion: 'exhausted',
    denominator: { kind: 'exact', total: 1 },
    itemIds: ['same'],
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  state = first.state;
  const collision = applyCoveragePage(state, {
    partitionId: 'p2',
    inputCursor: null,
    outputCursor: null,
    exhaustion: 'exhausted',
    denominator: { kind: 'exact', total: 1 },
    itemIds: ['same'],
  });
  assert.equal(collision.ok, false);
  if (!collision.ok) {
    assert.equal(collision.reason, 'item_partition_collision');
    assert.equal(collision.state, state);
  }
});

test('coverage retains an unbounded cursor history and all unique item identities', () => {
  const total = 140;
  let state = createDatasetCoverageState(
    'set-a',
    { kind: 'closed', partitionIds: ['p1'] },
    { kind: 'exact', total },
  );
  let cursor: string | null = null;
  for (let index = 0; index < total; index += 1) {
    const last = index === total - 1;
    const next = last ? null : `cursor-${index + 1}`;
    const advanced = applyCoveragePage(state, {
      partitionId: 'p1',
      inputCursor: cursor,
      outputCursor: next,
      exhaustion: last ? 'exhausted' : 'more',
      denominator: { kind: 'exact', total },
      itemIds: [`item-${index.toString().padStart(4, '0')}`],
    });
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    state = advanced.state;
    cursor = next;
  }
  assert.equal(state.partitions.p1.pages.length, total);
  assert.equal(state.partitions.p1.itemIds.length, total);
  assert.equal(summarizeDatasetCoverage(state).status, 'complete');
});

test('an explicitly empty closed dataset can truthfully complete at exact zero', () => {
  const state = createDatasetCoverageState(
    'set-empty',
    { kind: 'closed', partitionIds: [] },
    { kind: 'exact', total: 0 },
  );
  assert.deepEqual(summarizeDatasetCoverage(state), {
    status: 'complete',
    observed: 0,
    denominator: { kind: 'exact', total: 0 },
    exhaustion: 'exhausted',
    reasons: [],
  });
});
