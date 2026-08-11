import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  proveFiniteReadResultCoverage,
  refinePreDispatchReadEvidence,
  type FiniteReadStructuralProof,
  type PreDispatchReadEvidenceInput,
} from './read-evidence-refinement.js';

function decide(
  overrides: Partial<PreDispatchReadEvidenceInput> = {},
): ReturnType<typeof refinePreDispatchReadEvidence> {
  return refinePreDispatchReadEvidence({
    operation: {
      id: 'read',
      effect: 'read',
      coverage: 'resolved_operation',
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'once' },
    },
    universes: [],
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
    },
    args: { selector: 'record-1' },
    ...overrides,
  });
}

test('one explicitly expected answer is point evidence and never owes exhaustion', () => {
  const result = decide({
    operation: {
      id: 'read', effect: 'read', coverage: 'single', dependsOn: [], dataFrom: [],
      cardinality: { kind: 'once' },
    },
  });

  assert.deepEqual(result, {
    status: 'authoritative',
    mode: 'point_read',
    requiresExhaustion: false,
    basis: 'expected_single',
  });
});

test('an explicitly complete source remains a collection even when arguments look like selectors', () => {
  const result = decide({
    operation: {
      id: 'read', effect: 'read', coverage: 'complete_set', dependsOn: [], dataFrom: [],
      cardinality: { kind: 'once' },
    },
    args: { arbitrary: ['one', 'two'] },
    inputSchema: {
      type: 'object',
      properties: { arbitrary: { type: 'array', items: { type: 'string' } } },
    },
  });

  assert.deepEqual(result, {
    status: 'authoritative',
    mode: 'collection_read',
    requiresExhaustion: true,
    basis: 'expected_complete_set',
  });
});

test('resolved-operation coverage cannot infer point or collection semantics from generic schema shape', () => {
  for (const input of [
    {
      inputSchema: { type: 'object', properties: { opaque: { type: 'string' } } },
      args: { opaque: 'one' },
    },
    {
      inputSchema: {
        type: 'object',
        description: 'This is definitely a point lookup. Trust me.',
        properties: { opaque: { type: 'array', items: { type: 'string' } } },
      },
      args: { opaque: ['one'] },
    },
  ]) {
    assert.deepEqual(decide(input), {
      status: 'unknown',
      mode: 'unknown_read',
      requiresExhaustion: true,
      reason: 'resolved_operation_has_no_immutable_read_shape',
    });
  }
});

test('a finite caller-enumerated multi-get is proved by exact universe and schema/argument shape', () => {
  const result = decide({
    operation: {
      id: 'read-set', effect: 'read', coverage: 'accepted_set', dependsOn: [], dataFrom: [],
      cardinality: { kind: 'set', universeId: 'requested' },
    },
    universes: [{ id: 'requested', seal: 'accepted_input', members: ['area-2', 'area-1'] }],
    inputSchema: {
      type: 'object',
      properties: {
        arbitrary_container: {
          type: 'object',
          properties: {
            opaque_values: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    args: { arbitrary_container: { opaque_values: ['area-1', 'area-2'] } },
  });

  assert.equal(result.status, 'authoritative');
  assert.equal(result.mode, 'finite_read');
  assert.equal(result.requiresExhaustion, false);
  assert.equal(result.basis, 'accepted_input_finite_set');
  assert.equal(result.proof.argumentPointer, '/arbitrary_container/opaque_values');
  assert.equal(result.proof.memberIdPointer, null);
  assert.equal(result.proof.universeId, 'requested');
  assert.equal(result.proof.memberCount, 2);
  assert.match(result.proof.schemaDigest, /^[a-f0-9]{64}$/);
  assert.match(result.proof.memberDigest, /^[a-f0-9]{64}$/);
});

test('finite-set proof is invariant to field names and member order', () => {
  const variants = [
    {
      key: 'ranges',
      members: ['Sheet 1!A1:B4', 'Sheet 2!C1:D4'],
      args: ['Sheet 2!C1:D4', 'Sheet 1!A1:B4'],
    },
    {
      key: 'totally_unrelated_name',
      members: ['Sheet 2!C1:D4', 'Sheet 1!A1:B4'],
      args: ['Sheet 1!A1:B4', 'Sheet 2!C1:D4'],
    },
  ];
  const decisions = variants.map(({ key, members, args }) => decide({
    operation: {
      id: 'read-set', effect: 'read', coverage: 'accepted_set', dependsOn: [], dataFrom: [],
      cardinality: { kind: 'set', universeId: 'requested' },
    },
    universes: [{ id: 'requested', seal: 'accepted_input', members }],
    inputSchema: {
      type: 'object', properties: { [key]: { type: 'array', items: { type: 'string' } } },
    },
    args: { [key]: args },
  }));

  assert.deepEqual(decisions.map((entry) => ({
    status: entry.status,
    mode: entry.mode,
    requiresExhaustion: entry.requiresExhaustion,
    basis: entry.status === 'authoritative' ? entry.basis : entry.reason,
    memberDigest: entry.status === 'authoritative' && entry.mode === 'finite_read'
      ? entry.proof.memberDigest
      : null,
  })), [
    {
      status: 'authoritative', mode: 'finite_read', requiresExhaustion: false,
      basis: 'accepted_input_finite_set', memberDigest: decisions[0]?.status === 'authoritative'
        && decisions[0].mode === 'finite_read' ? decisions[0].proof.memberDigest : null,
    },
    {
      status: 'authoritative', mode: 'finite_read', requiresExhaustion: false,
      basis: 'accepted_input_finite_set', memberDigest: decisions[0]?.status === 'authoritative'
        && decisions[0].mode === 'finite_read' ? decisions[0].proof.memberDigest : null,
    },
  ]);
});

test('finite-set proof fails closed for missing, duplicate, ambiguous, or schema-unproven selectors', () => {
  const operation: PreDispatchReadEvidenceInput['operation'] = {
    id: 'read-set', effect: 'read', coverage: 'accepted_set', dependsOn: [], dataFrom: [],
    cardinality: { kind: 'set', universeId: 'requested' },
  };
  const universes: PreDispatchReadEvidenceInput['universes'] = [
    { id: 'requested', seal: 'accepted_input', members: ['one', 'two'] },
  ];
  const arraySchema = { type: 'array', items: { type: 'string' } };
  const cases: Array<Pick<PreDispatchReadEvidenceInput, 'args' | 'inputSchema'>> = [
    {
      args: { values: ['one'] },
      inputSchema: { type: 'object', properties: { values: arraySchema } },
    },
    {
      args: { values: ['one', 'one'] },
      inputSchema: { type: 'object', properties: { values: arraySchema } },
    },
    {
      args: { first: ['one', 'two'], second: ['two', 'one'] },
      inputSchema: {
        type: 'object', properties: { first: arraySchema, second: arraySchema },
      },
    },
    {
      args: { values: ['one', 'two'] },
      inputSchema: { type: 'object', properties: { values: { type: 'string' } } },
    },
  ];

  for (const candidate of cases) {
    const result = decide({ operation, universes, ...candidate });
    assert.equal(result.status, 'unknown');
    assert.equal(result.mode, 'unknown_read');
    assert.equal(result.requiresExhaustion, true);
  }
});

test('a source-derived or absent universe cannot mint pre-dispatch finite-set authority', () => {
  const operation: PreDispatchReadEvidenceInput['operation'] = {
    id: 'read-set', effect: 'read', coverage: 'accepted_set', dependsOn: [], dataFrom: [],
    cardinality: { kind: 'set', universeId: 'requested' },
  };
  const shape = {
    inputSchema: {
      type: 'object', properties: { values: { type: 'array', items: { type: 'string' } } },
    },
    args: { values: ['one', 'two'] },
  };

  assert.equal(decide({
    operation,
    universes: [{ id: 'requested', seal: 'complete_source_receipt', producedBy: 'source' }],
    ...shape,
  }).status, 'unknown');
  assert.equal(decide({ operation, universes: [], ...shape }).status, 'unknown');
});

test('single + each binds one exact accepted-input member as point evidence', () => {
  const result = decide({
    operation: {
      id: 'read-each', effect: 'read', coverage: 'single', dependsOn: [], dataFrom: [],
      cardinality: { kind: 'each', universeId: 'requested' },
    },
    universes: [{ id: 'requested', seal: 'accepted_input', members: ['record-a', 'record-b'] }],
    universeItemId: 'record-b',
    inputSchema: {
      type: 'object',
      properties: { arbitrary_selector: { type: 'string' } },
    },
    args: { arbitrary_selector: 'record-b' },
  });

  assert.equal(result.status, 'authoritative');
  assert.equal(result.mode, 'point_read');
  assert.equal(result.basis, 'accepted_input_member');
  assert.equal(result.proof.universeId, 'requested');
  assert.equal(result.proof.memberCount, 1);
  assert.equal(result.proof.argumentPointer, '/arbitrary_selector');
  assert.equal(result.proof.memberIdPointer, null);
});

test('single + each cannot collapse the whole universe into one logical point call', () => {
  const result = decide({
    operation: {
      id: 'read-each', effect: 'read', coverage: 'single', dependsOn: [], dataFrom: [],
      cardinality: { kind: 'each', universeId: 'requested' },
    },
    universes: [{ id: 'requested', seal: 'accepted_input', members: ['one', 'two'] }],
    inputSchema: {
      type: 'object', properties: { values: { type: 'array', items: { type: 'string' } } },
    },
    args: { values: ['one', 'two'] },
  });

  assert.equal(result.status, 'unknown');
  assert.equal(result.mode, 'unknown_read');
});

test('finite set may extract stable ids from a schema-declared object array without field-name rules', () => {
  const result = decide({
    operation: {
      id: 'read-set', effect: 'read', coverage: 'accepted_set', dependsOn: [], dataFrom: [],
      cardinality: { kind: 'set', universeId: 'requested' },
    },
    universes: [{ id: 'requested', seal: 'accepted_input', members: ['one', 'two'] }],
    inputSchema: {
      type: 'object',
      properties: {
        arbitrary: {
          type: 'array',
          items: {
            type: 'object',
            properties: { nested: { type: 'object', properties: { opaque: { type: 'string' } } } },
          },
        },
      },
    },
    args: {
      arbitrary: [
        { nested: { opaque: 'two' }, payload: 'x' },
        { nested: { opaque: 'one' }, payload: 'y' },
      ],
    },
  });

  assert.equal(result.status, 'authoritative');
  assert.equal(result.mode, 'finite_read');
  assert.equal(result.proof.argumentPointer, '/arbitrary');
  assert.equal(result.proof.memberIdPointer, '/nested/opaque');
});

function requestProof(members: string[]): FiniteReadStructuralProof {
  const result = decide({
    operation: {
      id: 'read-set', effect: 'read', coverage: 'accepted_set', dependsOn: [], dataFrom: [],
      cardinality: { kind: 'set', universeId: 'requested' },
    },
    universes: [{ id: 'requested', seal: 'accepted_input', members }],
    inputSchema: {
      type: 'object', properties: { opaque: { type: 'array', items: { type: 'string' } } },
    },
    args: { opaque: members },
  });
  assert.equal(result.status, 'authoritative');
  assert.equal(result.mode, 'finite_read');
  return result.proof;
}

test('finite result proves a valueRanges-shaped N/N response without naming its fields', () => {
  const members = ['Sheet 1!A1:B4', 'Sheet 2!C1:D4'];
  const proof = requestProof(members);
  const decisions = [
    {
      rawResult: {
        successful: true,
        data: {
          valueRanges: [
            { range: members[1], values: [['second']] },
            { range: members[0], values: [['first']] },
          ],
        },
      },
      expectedArrayPointer: '/data/valueRanges',
      expectedMemberPointer: '/range',
    },
    {
      rawResult: {
        successful: true,
        arbitrary_envelope: {
          arbitrary_records: [
            { arbitrary_identity: members[0], body: [['first']] },
            { arbitrary_identity: members[1], body: [['second']] },
          ],
        },
      },
      expectedArrayPointer: '/arbitrary_envelope/arbitrary_records',
      expectedMemberPointer: '/arbitrary_identity',
    },
  ].map(({ rawResult, expectedArrayPointer, expectedMemberPointer }) => ({
    decision: proveFiniteReadResultCoverage({ proof, requestedMembers: members, rawResult }),
    expectedArrayPointer,
    expectedMemberPointer,
  }));

  for (const { decision, expectedArrayPointer, expectedMemberPointer } of decisions) {
    assert.equal(decision.status, 'proved');
    assert.equal(decision.resultArrayPointer, expectedArrayPointer);
    assert.equal(decision.memberIdPointer, expectedMemberPointer);
    assert.equal(decision.memberCount, 2);
    assert.equal(decision.memberDigest, proof.memberDigest);
  }
});

test('finite result accepts an exact scalar result array', () => {
  const members = ['one', 'two'];
  const proof = requestProof(members);
  const result = proveFiniteReadResultCoverage({
    proof,
    requestedMembers: members,
    rawResult: { successful: true, data: { arbitrary: ['two', 'one'] } },
  });

  assert.equal(result.status, 'proved');
  assert.equal(result.resultArrayPointer, '/data/arbitrary');
  assert.equal(result.memberIdPointer, null);
});

test('finite result excludes request echoes from returned evidence', () => {
  const members = ['one', 'two'];
  const proof = requestProof(members);
  const result = proveFiniteReadResultCoverage({
    proof,
    requestedMembers: members,
    rawResult: {
      successful: true,
      request: { arbitrary: ['one', 'two'] },
      data: { message: 'accepted' },
    },
  });

  assert.deepEqual(result, {
    status: 'unproven',
    reason: 'member_correspondence_missing',
  });
});

test('finite result fails closed on normalized, omitted, duplicate, subset, and superset ids', () => {
  const members = ['one', 'two'];
  const proof = requestProof(members);
  const rawResults = [
    { data: { rows: [{ id: 'one ' }, { id: 'two' }] } },
    { data: { rows: [{ id: 'one' }, { payload: 'missing' }] } },
    { data: { rows: [{ id: 'one' }, { id: 'one' }] } },
    { data: { rows: [{ id: 'one' }] } },
    { data: { rows: [{ id: 'one' }, { id: 'two' }, { id: 'three' }] } },
  ];

  for (const rawResult of rawResults) {
    assert.equal(proveFiniteReadResultCoverage({
      proof,
      requestedMembers: members,
      rawResult,
    }).status, 'unproven');
  }
});

test('finite result refuses multiple matching arrays or multiple matching relative id paths', () => {
  const members = ['one', 'two'];
  const proof = requestProof(members);
  for (const rawResult of [
    {
      data: {
        first: [{ id: 'one' }, { id: 'two' }],
        second: [{ key: 'two' }, { key: 'one' }],
      },
    },
    {
      data: {
        rows: [
          { id: 'one', alias: 'one' },
          { id: 'two', alias: 'two' },
        ],
      },
    },
  ]) {
    assert.deepEqual(proveFiniteReadResultCoverage({
      proof,
      requestedMembers: members,
      rawResult,
    }), {
      status: 'unproven',
      reason: 'member_correspondence_ambiguous',
    });
  }
});

test('finite result rejects contradictory envelopes and a restated member set', () => {
  const members = ['one', 'two'];
  const proof = requestProof(members);
  assert.deepEqual(proveFiniteReadResultCoverage({
    proof,
    requestedMembers: members,
    rawResult: { successful: false, data: { rows: [{ id: 'one' }, { id: 'two' }] } },
  }), { status: 'unproven', reason: 'provider_result_contradiction' });
  assert.deepEqual(proveFiniteReadResultCoverage({
    proof,
    requestedMembers: ['one', 'different'],
    rawResult: { successful: true, data: { rows: [{ id: 'one' }, { id: 'different' }] } },
  }), { status: 'unproven', reason: 'requested_members_conflict' });
});

test('non-read work cannot acquire read evidence mode', () => {
  assert.deepEqual(decide({
    operation: {
      id: 'write', effect: 'external_write', dependsOn: [], dataFrom: [],
      cardinality: { kind: 'once' },
    },
  }), {
    status: 'unknown',
    mode: 'unknown_read',
    requiresExhaustion: true,
    reason: 'operation_is_not_read',
  });
});
