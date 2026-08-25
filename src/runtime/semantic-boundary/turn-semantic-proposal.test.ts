import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isContextCheckedTurnSemanticProposalV1,
  validateTurnSemanticProposalV1,
  type HostCapabilityDescriptorV1,
  type TurnSemanticHostViewV1,
  type TurnSemanticProposalV1,
} from './turn-semantic-proposal.js';
import { admitTurnSemantics } from './admit-turn-semantics.js';
import { workTopologyDigest } from '../graph/work-topology.js';

const activeGoal = { goalId: 'goal-17', baseRevision: 4 } as const;

function descriptor(id: string, effect: HostCapabilityDescriptorV1['effect'], inputKind: string, outputKind: string): HostCapabilityDescriptorV1 {
  return {
    id,
    effect,
    purpose: `purpose:${id}`,
    acceptedInputKinds: [inputKind],
    producedOutputKinds: [outputKind],
    applicableDeliverableKinds: [outputKind],
    inputShape: inputKind,
    outputShape: outputKind,
    outputKind,
    deliverableKind: outputKind,
    destinationPosture: effect === 'external_write' ? 'create_new' : null,
    evidenceKinds: ['payload'],
    handleRequired: effect === 'external_write',
    readbackRequired: effect === 'external_write',
    accountScope: `acct:${id}`,
    manifestDigest: id.padEnd(64, '0').slice(0, 64),
    advisoryRoles: [id === 'cap-1' ? 'source' : id === 'cap-2' ? 'destination' : 'capability'],
  };
}

function host(overrides: Partial<TurnSemanticHostViewV1> = {}): TurnSemanticHostViewV1 {
  const capabilities = [
    descriptor('cap-1', 'read', 'query', 'records'),
    descriptor('cap-2', 'external_write', 'records', 'created_resource'),
    descriptor('cap-collect', 'read', 'records', 'records'),
  ];
  return {
    source: {
      sessionId: 'session-9',
    sourceUserSeq: 42,
      inputHash: 'a'.repeat(64),
      audienceHash: 'b'.repeat(64),
    },
    policyRevision: 'd'.repeat(64),
    resumableGoals: [activeGoal],
    openQuestions: [{
      questionId: 'question-3',
      goalId: activeGoal.goalId,
      goalRevision: activeGoal.baseRevision,
      slotKey: 'resource-choice',
      question: 'Which resource should I use?',
      options: [
        { optionId: 'choice-a', label: 'First' },
        { optionId: 'choice-b', label: 'Second' },
      ],
      allowFreeText: false,
    }, {
      questionId: 'question-4',
      goalId: activeGoal.goalId,
      goalRevision: activeGoal.baseRevision,
      slotKey: 'free-value',
      question: 'Provide a value.',
      options: [],
      allowFreeText: true,
    }],
    catalog: {
      capabilityIds: new Set(capabilities.map((entry) => entry.id)),
      workflowIds: new Set(['workflow-1']),
      capabilities,
    },
    ...overrides,
  };
}

function goal() {
  return {
    objective: 'Produce the requested result under the stated constraints.',
    criteria: [
      { id: 'criterion-1', statement: 'The bounded collection is present.' },
      { id: 'criterion-2', statement: 'The requested resource is verifiable.' },
    ],
    openSlots: [],
    candidates: [
      { kind: 'capability' as const, id: 'cap-1' },
      { kind: 'workflow' as const, id: 'workflow-1' },
    ],
  };
}

function work(): NonNullable<TurnSemanticProposalV1['work']> {
  return {
    construct: 'collect_then_construct',
    cardinality: { count: 5, fields: ['title', 'date'] },
    destination: { posture: 'create_new', family: 'workbook', handleRequired: true },
    requestedEffect: 'external_write',
    operations: [
      { id: 'op-read', role: 'source', requestedEffect: 'read', dependsOn: [], evidence: [], capabilityRef: 'cap-1' },
      { id: 'op-write', role: 'destination', requestedEffect: 'external_write', dependsOn: ['op-read'], evidence: [], capabilityRef: 'cap-2' },
    ],
    deliverables: [{ id: 'artifact', kind: 'workbook' }],
    evidenceRequirements: ['readback'],
  };
}

function proposal(overrides: Partial<TurnSemanticProposalV1> = {}): TurnSemanticProposalV1 {
  return {
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: goal(),
    work: work(),
    slotAnswers: [],
    rationale: 'Diagnostic interpretation only.',
    ...overrides,
  };
}

function issueCodes(result: ReturnType<typeof validateTurnSemanticProposalV1>): string[] {
  return result.ok ? [] : result.issues.map((entry) => entry.code);
}

test('canonical work topology and digest survive semantic checking and admission without reprojection', () => {
  const topology = {
    version: 1 as const,
    operations: [
      {
        id: 'op-read',
        effect: 'read' as const,
        coverage: 'complete_set' as const,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'op-write',
        effect: 'external_write' as const,
        coverage: null,
        dependsOn: ['op-read'],
        dataFrom: ['op-read'],
        cardinality: { kind: 'once' as const },
      },
    ],
    universes: [],
  };
  const topologyHash = workTopologyDigest(topology as never);

  // REGRESSION PIN (live 2026-08-24, scorpion-facebook-trends/scrape_and_analyze):
  // the schema demanded `work.topologyHash` whenever a topology was present.
  // That digest is HOST-computed and grants no authority, so the model could
  // never produce it -- every topology-bearing proposal failed admission with
  // `model_failed` and the workflow step ended blocked, telling a scheduled run
  // to "restate it". The host must derive the digest; omitting it is legal.
  {
    const withoutHash = admitTurnSemantics(
      proposal({ work: { ...work(), topology } }),
      host(),
      {
        policyRevision: host().policyRevision,
        audienceHash: host().source.audienceHash,
        policyMaxCeiling: 'external_write',
        allowedEffects: ['read', 'external_write'],
      },
    );
    assert.equal(withoutHash.ok, true, `omitted topologyHash must admit: ${JSON.stringify(withoutHash)}`);
    if (withoutHash.ok) {
      assert.equal(
        withoutHash.clamped.workTopologyHash,
        topologyHash,
        'the host-derived digest must equal the canonical topology digest',
      );
    }
  }

  const raw = proposal({
    work: { ...work(), topology, topologyHash },
  });
  const admitted = admitTurnSemantics(raw, host(), {
    policyRevision: host().policyRevision,
    audienceHash: host().source.audienceHash,
    policyMaxCeiling: 'external_write',
    allowedEffects: ['read', 'external_write'],
  });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  if (!admitted.ok) return;
  assert.equal(admitted.clamped.workTopologyHash, topologyHash);
  assert.deepEqual(admitted.clamped.workTopology, {
    version: 1,
    operations: [
      {
        id: 'op-read', effect: 'read', coverage: 'complete_set',
        dependsOn: [], dataFrom: [], cardinality: { kind: 'once' },
      },
      {
        id: 'op-write', effect: 'external_write',
        dependsOn: ['op-read'], dataFrom: ['op-read'], cardinality: { kind: 'once' },
      },
    ],
    universes: [],
  });

  const mismatched = validateTurnSemanticProposalV1(proposal({
    work: { ...work(), topology, topologyHash: '0'.repeat(64) },
  }), host());
  assert.equal(mismatched.ok, false, 'a mismatched topology digest crossed semantic admission');
});

test('plural destinations are canonical and destination is the first-sink projection', () => {
  const result = validateTurnSemanticProposalV1(proposal({
    work: {
      ...work(),
      destinations: [
        { posture: 'create_new', family: 'workbook', handleRequired: true },
        { posture: 'named_existing', family: 'tracker', handleRequired: false },
      ],
      destination: { posture: 'create_new', family: 'workbook', handleRequired: true },
    },
  }), host());
  assert.equal(result.ok, true, issueCodes(result).join(','));
  if (result.ok) {
    assert.equal(result.checked.proposal.work?.destinations?.length, 2);
    assert.equal(result.checked.proposal.work?.destination?.family, 'workbook');
  }
});

test('destinations[0] must match destination', () => {
  const result = validateTurnSemanticProposalV1(proposal({
    work: {
      ...work(),
      destinations: [{ posture: 'named_existing', family: 'tracker', handleRequired: false }],
      destination: { posture: 'create_new', family: 'workbook', handleRequired: true },
    },
  }), host());
  assert.equal(result.ok, false);
});

test('snake_case opaque ids validate', () => {
  const result = validateTurnSemanticProposalV1(proposal({
    goal: {
      ...goal(),
      criteria: [{ id: 'c_set', statement: 'Bounded collection is present.' }],
    },
    work: {
      ...work(),
      cardinality: { count: 5, fields: ['latest_reviews', 'social_media'] },
      destination: { posture: 'create_new', family: 'google_sheets', handleRequired: true },
      operations: [
        { id: 'op_source', role: 'source', requestedEffect: 'read', dependsOn: [], evidence: [], capabilityRef: 'cap-1' },
        { id: 'op_collect', role: 'collection', requestedEffect: 'read', dependsOn: ['op_source'], evidence: [], capabilityRef: 'cap-collect' },
      ],
      deliverables: [{ id: 'artifact_1', kind: 'google_sheets' }],
      evidenceRequirements: ['create_receipt', 'exact_readback'],
    },
  }), host());
  assert.equal(result.ok, true, issueCodes(result).join(','));
});

test('checks every semantic relation without granting execution authority', () => {
  const cases: TurnSemanticProposalV1[] = [
    proposal({ relation: 'conversation', goal: null, work: null }),
    proposal(),
    proposal({ relation: 'continue_goal', targetGoal: activeGoal, goal: null, work: null }),
    proposal({
      relation: 'answer_open_slot',
      targetGoal: activeGoal,
      goal: null,
      work: null,
      slotAnswers: [{
        kind: 'option',
        questionId: 'question-3',
        slotKey: 'resource-choice',
        optionId: 'choice-a',
      }],
    }),
    proposal({
      relation: 'amend_goal',
      targetGoal: activeGoal,
    }),
    proposal({ relation: 'abandon_goal', targetGoal: activeGoal, goal: null, work: null }),
    proposal({ relation: 'ambiguous', targetGoal: activeGoal, goal: null, work: null }),
  ];

  for (const candidate of cases) {
    const result = validateTurnSemanticProposalV1(candidate, host());
    assert.equal(result.ok, true, candidate.relation);
    if (!result.ok) continue;
    assert.equal(result.checked.scope, 'semantics_only_no_execution_authority');
    assert.equal(isContextCheckedTurnSemanticProposalV1(result.checked), true);
    assert.deepEqual(result.checked.source, host().source);
    assert.match(result.checked.payloadHash, /^[a-f0-9]{64}$/);
    assert.match(result.checked.contextHash, /^[a-f0-9]{64}$/);
    assert.equal('authorized' in result.checked, false);
    assert.equal('admitted' in result.checked, false);
  }
});

test('new_goal with clarifying open-slots and no work is legal conversation, not illegal work', () => {
  const result = validateTurnSemanticProposalV1(proposal({
    work: null,
    goal: {
      ...goal(),
      objective: 'Clean up the Zephyr deal tracker and send the crew an update about it.',
      openSlots: [
        {
          slotKey: 'crew_definition',
          question: 'Who exactly is the crew that should receive the update?',
          options: [],
          allowFreeText: true,
        },
        {
          slotKey: 'update_channel',
          question: 'How should the update be sent?',
          options: [],
          allowFreeText: true,
        },
      ],
      candidates: [],
    },
  }), host());
  assert.equal(result.ok, true, issueCodes(result).join(','));
});

test('new_goal with no work is the act-directly shape and admits', () => {
  // Live 2026-08-25 (first Claude proposal on the unified workflow lane): an
  // honest goal with work:null — "I will do this with tools now" — was
  // blocked twice for the shape alone, forcing every brain to fabricate a
  // work topology for host-native tasks. Goal-only new_goal admits and the
  // turn proceeds as model-driven execution; structured work stays fully
  // validated when the proposal claims one.
  const result = validateTurnSemanticProposalV1(proposal({
    work: null,
    goal: { ...goal(), openSlots: [], candidates: [] },
  }), host());
  assert.equal(result.ok, true, issueCodes(result).join(','));
});

test('relation matrix rejects model payloads that imply another lifecycle', () => {
  const invalid = [
    proposal({ relation: 'conversation' }),
    proposal({ relation: 'new_goal', targetGoal: activeGoal }),
    proposal({ relation: 'continue_goal', targetGoal: activeGoal }),
    proposal({ relation: 'answer_open_slot', targetGoal: activeGoal, goal: null }),
    proposal({ relation: 'amend_goal', targetGoal: activeGoal, goal: null }),
    proposal({ relation: 'abandon_goal', targetGoal: activeGoal }),
    proposal({ relation: 'ambiguous', targetGoal: activeGoal }),
  ];

  for (const candidate of invalid) {
    const result = validateTurnSemanticProposalV1(candidate, host());
    assert.equal(result.ok, false, candidate.relation);
    assert.ok(issueCodes(result).includes('illegal_relation_payload'));
  }
});

test('requires the exact active goal id and revision', () => {
  for (const targetGoal of [
    { goalId: 'goal-other', baseRevision: 4 },
    { goalId: 'goal-17', baseRevision: 3 },
  ]) {
    const result = validateTurnSemanticProposalV1(proposal({
      relation: 'continue_goal',
      targetGoal,
      goal: null,
      work: null,
    }), host());
    assert.equal(result.ok, false);
    assert.ok(issueCodes(result).includes('target_goal_mismatch'));
  }
});

test('binds slot answers to the exact visible question tuple', () => {
  const base = proposal({
    relation: 'answer_open_slot',
    targetGoal: activeGoal,
    goal: null,
    work: null,
  });
  const cases: Array<[TurnSemanticProposalV1['slotAnswers'], string]> = [
    [[{ kind: 'option', questionId: 'question-other', slotKey: 'resource-choice', optionId: 'choice-a' }], 'question_slot_mismatch'],
    [[{ kind: 'option', questionId: 'question-3', slotKey: 'other-slot', optionId: 'choice-a' }], 'question_slot_mismatch'],
    [[{ kind: 'option', questionId: 'question-3', slotKey: 'resource-choice', optionId: 'hidden-choice' }], 'hidden_option'],
    [[{ kind: 'value', questionId: 'question-3', slotKey: 'resource-choice', value: 'not allowed' }], 'free_text_not_allowed'],
    [[
      { kind: 'option', questionId: 'question-3', slotKey: 'resource-choice', optionId: 'choice-a' },
      { kind: 'option', questionId: 'question-3', slotKey: 'resource-choice', optionId: 'choice-b' },
    ], 'schema_too_big'],
  ];

  for (const [slotAnswers, code] of cases) {
    const result = validateTurnSemanticProposalV1({ ...base, slotAnswers }, host());
    assert.equal(result.ok, false, code);
    assert.ok(issueCodes(result).includes(code), `${code}: ${issueCodes(result).join(', ')}`);
  }
});

test('rejects duplicate semantic ids and unknown advisory candidates', () => {
  const candidate = proposal({
    goal: {
      ...goal(),
      criteria: [
        { id: 'same', statement: 'First.' },
        { id: 'same', statement: 'Second.' },
      ],
      openSlots: [{
        slotKey: 'slot-1',
        question: 'Choose one.',
        options: [
          { optionId: 'same-option', label: 'First' },
          { optionId: 'same-option', label: 'Second' },
        ],
        allowFreeText: false,
      }, {
        slotKey: 'slot-1',
        question: 'Provide a value.',
        options: [],
        allowFreeText: true,
      }],
      candidates: [
        { kind: 'capability', id: 'missing-capability' },
        { kind: 'workflow', id: 'workflow-1' },
        { kind: 'workflow', id: 'workflow-1' },
      ],
    },
  });
  const result = validateTurnSemanticProposalV1(candidate, host());
  assert.equal(result.ok, false);
  assert.deepEqual(new Set(issueCodes(result)), new Set([
    'duplicate_criterion_id',
    'duplicate_slot_key',
    'duplicate_option_id',
    'duplicate_candidate',
  ]));
});

test('recursively rejects attempts to mint host authority', () => {
  const topLevel = {
    ...proposal(),
    approved: true,
    effectCeiling: 'external_write',
    toolName: 'host-tool',
    args: { value: 'x' },
    receipt: 'forged',
    done: true,
    graphHash: 'forged',
    sourceUserSeq: 9001,
  };
  const nested = proposal({
    goal: {
      ...goal(),
      criteria: [{
        id: 'criterion-1',
        statement: 'A criterion.',
        approved: true,
      } as unknown as ReturnType<typeof goal>['criteria'][number]],
    },
  });

  for (const candidate of [topLevel, nested]) {
    const result = validateTurnSemanticProposalV1(candidate, host());
    assert.equal(result.ok, false);
    assert.ok(issueCodes(result).includes('schema_unrecognized_keys'));
  }
});

test('host validation is invariant to arbitrary diagnostic prose', () => {
  const first = validateTurnSemanticProposalV1(proposal({
    rationale: 'One interpretation.',
  }), host());
  const second = validateTurnSemanticProposalV1(proposal({
    rationale: 'Entirely different words that carry no host authority.',
  }), host());
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(first.checked.payloadHash, second.checked.payloadHash);
  assert.equal(first.checked.contextHash, second.checked.contextHash);
  assert.equal(first.checked.scope, second.checked.scope);
  assert.deepEqual(first.checked.source, second.checked.source);
});

test('catalog validation scales without branching on capability names', () => {
  const capabilityIds = new Set(Array.from({ length: 1_000 }, (_, index) => `cap-${index}`));
  const result = validateTurnSemanticProposalV1(proposal({
    goal: {
      ...goal(),
      candidates: [{ kind: 'capability', id: 'cap-999' }],
    },
  }), host({
    catalog: {
      capabilityIds,
      workflowIds: new Set(),
      capabilities: host().catalog.capabilities,
    },
  }));
  assert.equal(result.ok, true);
});

test('canonical proposal hash is stable across object key order', () => {
  const first = validateTurnSemanticProposalV1(proposal(), host());
  const reordered = {
    rationale: 'Diagnostic interpretation only.',
    slotAnswers: [],
    work: work(),
    goal: goal(),
    targetGoal: null,
    relation: 'new_goal',
    version: 1,
  };
  const second = validateTurnSemanticProposalV1(reordered, host());
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.checked.payloadHash, second.checked.payloadHash);
  assert.equal(first.checked.contextHash, second.checked.contextHash);
});

test('a serialized checked envelope is not durable authority', () => {
  const result = validateTurnSemanticProposalV1(proposal(), host());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const revived = JSON.parse(JSON.stringify(result.checked));
  assert.equal(isContextCheckedTurnSemanticProposalV1(revived), false);
  assert.equal('authorized' in revived, false);
  assert.equal(revived.scope, 'semantics_only_no_execution_authority');
});

test('checked semantics are deeply immutable and cannot be structurally forged', () => {
  const result = validateTurnSemanticProposalV1(proposal(), host());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(Object.isFrozen(result.checked), true);
  assert.equal(Object.isFrozen(result.checked.proposal), true);
  assert.equal(Object.isFrozen(result.checked.proposal.goal?.criteria), true);
  assert.throws(() => {
    (result.checked.proposal.goal?.criteria as unknown as unknown[]).push({
      id: 'forged',
      statement: 'Forged after validation.',
    });
  }, TypeError);
  const lookalike = {
    scope: result.checked.scope,
    source: result.checked.source,
    payloadHash: result.checked.payloadHash,
    contextHash: result.checked.contextHash,
    proposal: result.checked.proposal,
  };
  assert.equal(isContextCheckedTurnSemanticProposalV1(lookalike), false);
});

test('context digest binds source, audience, visible questions, and goal revision', () => {
  const base = validateTurnSemanticProposalV1(proposal(), host());
  const differentSource = validateTurnSemanticProposalV1(proposal(), host({
    source: {
      ...host().source,
      sourceUserSeq: 43,
    },
  }));
  const differentAudience = validateTurnSemanticProposalV1(proposal(), host({
    source: {
      ...host().source,
      audienceHash: 'c'.repeat(64),
    },
  }));
  assert.equal(base.ok, true);
  assert.equal(differentSource.ok, true);
  assert.equal(differentAudience.ok, true);
  if (!base.ok || !differentSource.ok || !differentAudience.ok) return;
  assert.notEqual(base.checked.contextHash, differentSource.checked.contextHash);
  assert.notEqual(base.checked.contextHash, differentAudience.checked.contextHash);
});

test('host can expose multiple resumable goals without preselecting one', () => {
  const second = { goalId: 'goal-18', baseRevision: 2 } as const;
  const result = validateTurnSemanticProposalV1(proposal({
    relation: 'continue_goal',
    targetGoal: second,
    goal: null,
    work: null,
  }), host({ resumableGoals: [activeGoal, second] }));
  assert.equal(result.ok, true);
});

test('rejects malformed or ambiguous trusted host snapshots', () => {
  const duplicateQuestion = host().openQuestions[0]!;
  const cases: Array<[TurnSemanticHostViewV1, string]> = [
    [host({ source: { ...host().source, audienceHash: 'not-a-hash' } }), 'host_invalid_audience_hash'],
    [host({ resumableGoals: [activeGoal, activeGoal] }), 'host_duplicate_goal'],
    [host({ openQuestions: [duplicateQuestion, duplicateQuestion] }), 'host_duplicate_question'],
    [host({
      openQuestions: [{
        ...duplicateQuestion,
        options: [
          { optionId: 'choice-a', label: 'First' },
          { optionId: 'choice-a', label: 'Again' },
        ],
      }],
    }), 'host_duplicate_option'],
  ];
  for (const [candidateHost, code] of cases) {
    const result = validateTurnSemanticProposalV1(proposal(), candidateHost);
    assert.equal(result.ok, false, code);
    assert.ok(issueCodes(result).includes(code));
  }
});

test('amending a goal cannot also consume an open slot', () => {
  const result = validateTurnSemanticProposalV1(proposal({
    relation: 'amend_goal',
    targetGoal: activeGoal,
    slotAnswers: [{
      kind: 'value',
      questionId: 'question-4',
      slotKey: 'free-value',
      value: 'A user-provided value',
    }],
  }), host());
  assert.equal(result.ok, false);
  assert.ok(issueCodes(result).includes('illegal_relation_payload'));
});

test('a conversation whose work object asks for nothing is not carrying work', () => {
  // LIVE DEFECT 2026-08-22. "Hi Clem. Reply with exactly: HOST ENGINE READY"
  // terminated `blocked` with "I could not finish planning that, so I stopped
  // before using any tools."
  //
  // The model classified it correctly as `conversation` and asked for nothing —
  // but it filled the schema's shape instead of sending `work: null`, and the
  // relation matrix tested `work === null`. Key presence, not content. An empty
  // work object read as smuggled execution and killed the turn.
  //
  // The same shape had already blocked a workflow synthesis on 2026-08-21, so
  // this is the class, not the incident.
  const inertWork = {
    construct: 'none',
    cardinality: null,
    destinations: null,
    destination: null,
    requestedEffect: 'none',
    operations: [],
    deliverables: [],
    evidenceRequirements: [],
  } as const;

  const result = validateTurnSemanticProposalV1(
    proposal({ relation: 'conversation', goal: null, targetGoal: null, work: { ...inertWork } }),
    host(),
  );
  assert.equal(result.ok, true, issueCodes(result).join(','));

  // Every relation that forbids CARRYING work must read emptiness the same way.
  for (const relation of ['continue_goal', 'abandon_goal', 'ambiguous'] as const) {
    const swept = validateTurnSemanticProposalV1(
      proposal({ relation, targetGoal: activeGoal, goal: null, work: { ...inertWork } }),
      host(),
    );
    assert.ok(
      !issueCodes(swept).includes('illegal_relation_payload'),
      `${relation} still read an empty work object as carrying work: ${issueCodes(swept).join(',')}`,
    );
  }
});

test('a conversation carrying REAL work is still refused', () => {
  // The narrowing must not become a hole: emptiness is the test, not shape.
  // Anything that could actually execute — an operation, a deliverable, a
  // construct, a declared write — still makes a conversation illegal.
  const base = { relation: 'conversation', goal: null, targetGoal: null } as const;
  const empty = {
    construct: 'none' as const,
    cardinality: null,
    destinations: null,
    destination: null,
    requestedEffect: 'none' as const,
    operations: [],
    deliverables: [],
    evidenceRequirements: [],
  };

  const carrying: Array<[string, TurnSemanticProposalV1['work']]> = [
    ['a declared external write', { ...empty, requestedEffect: 'external_write' }],
    ['a construct', { ...empty, construct: 'single_act' }],
    ['a deliverable', { ...empty, deliverables: [{ id: 'deliverable-1', kind: 'workbook' }] }],
    ['a destination', { ...empty, destination: { posture: 'create_new', family: 'workbook', handleRequired: true } }],
    ['a cardinality', { ...empty, cardinality: { count: 3, fields: ['name'] } }],
  ];

  for (const [what, work] of carrying) {
    const result = validateTurnSemanticProposalV1(proposal({ ...base, work }), host());
    assert.ok(
      issueCodes(result).includes('illegal_relation_payload'),
      `a conversation carrying ${what} must still be refused`,
    );
  }
});

// REGRESSION PIN (live 2026-08-24): three scheduled workflows blocked in ONE
// batch because the schema made the model restate canonical topology facts in
// its capability bindings and match them exactly:
//   daily-standup-email -> "capability binding effect must match the canonical topology"
//   morning-briefing    -> "capability binding dependencies must match the canonical topology"
// The topology is canonical (this schema says bindings "do not restate ...
// lineage"), so admission reconciles instead of refusing. Reconciliation must
// NARROW ONLY -- a binding may never be widened by the topology.
test('capability bindings reconcile to the canonical topology and never widen effect', () => {
  const topology = {
    version: 1 as const,
    operations: [
      {
        id: 'op-read',
        effect: 'read' as const,
        coverage: 'complete_set' as const,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'op-write',
        effect: 'external_write' as const,
        coverage: null,
        dependsOn: ['op-read'],
        dataFrom: ['op-read'],
        cardinality: { kind: 'once' as const },
      },
    ],
    universes: [],
  };
  const authority = {
    policyRevision: host().policyRevision,
    audienceHash: host().source.audienceHash,
    policyMaxCeiling: 'external_write' as const,
    allowedEffects: ['read', 'external_write'] as const,
  };

  // The exact live shapes: a binding whose dependsOn omits the canonical
  // lineage, and one whose effect disagrees with the canonical topology.
  const drifted = work();
  const admitted = admitTurnSemantics(
    proposal({
      work: {
        ...drifted,
        topology,
        operations: [
          { ...drifted.operations[0]!, requestedEffect: 'read' },
          { ...drifted.operations[1]!, dependsOn: [] },
        ],
      },
    }),
    host(),
    authority as never,
  );
  assert.equal(admitted.ok, true, `drifted bindings must reconcile, not block: ${JSON.stringify(admitted)}`);
  if (!admitted.ok) return;

  const byId = new Map((admitted.clamped.operations ?? []).map((op) => [op.id, op]));
  assert.deepEqual(byId.get('op-write')?.dependsOn, ['op-read'], 'lineage comes from the canonical topology');

  // NARROW-ONLY: when the canonical topology is MORE permissive than the
  // binding, the binding's narrower effect stands. Reconciliation may only
  // narrow, never escalate authority. (Built on op-read, whose capabilityRef is
  // a read capability -- declaring a weaker effect than the ref supports trips
  // capability_ref_effect_mismatch, a separate and correct check.)
  const permissiveTopology = {
    ...topology,
    operations: [
      { ...topology.operations[0]!, effect: 'external_write' as const, coverage: null },
      topology.operations[1]!,
    ],
  };
  const narrowed = admitTurnSemantics(
    proposal({ work: { ...drifted, topology: permissiveTopology } }),
    host(),
    authority as never,
  );
  assert.equal(narrowed.ok, true, `narrower binding must admit: ${JSON.stringify(narrowed)}`);
  if (!narrowed.ok) return;
  const read = new Map((narrowed.clamped.operations ?? []).map((op) => [op.id, op])).get('op-read');
  assert.equal(
    read?.requestedEffect,
    'read',
    'a narrower binding is never widened to the more permissive topology effect',
  );
});

// ─── Refinement failures belong to admission, not the transport ──────────────
//
// The full schema used to serve as the SDK outputType, so a semantic
// refinement failure THREW inside runner.run — labelled `model_failed`,
// bypassing the bounded one-repair gate — while the identical check at
// admission produces a typed, repairable issue. All six `model_failed` records
// since 2026-08-24 were this class; zero were provider errors.
test('the wire schema accepts what the full schema refines away', async () => {
  const { TurnSemanticProposalV1Schema, TurnSemanticProposalV1WireSchema } = await import('./turn-semantic-proposal.js');
  // A proposal whose work topology violates a refinement (coverage vs
  // cardinality mismatch class): destinations[0] disagreeing with destination
  // is the cheapest deterministic refinement to trip.
  const proposal = {
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: null,
    work: {
      construct: 'single_act',
      cardinality: null,
      requestedEffect: 'read',
      destination: { posture: 'create_new', family: 'document', handleRequired: false },
      destinations: [{ posture: 'named_existing', family: 'document', handleRequired: false }],
      topology: null,
      topologyHash: null,
      operations: [],
      deliverables: [],
      evidenceRequirements: [],
    },
    slotAnswers: [],
    rationale: 'wire vs admission split fixture',
  };
  const wire = TurnSemanticProposalV1WireSchema.safeParse(proposal);
  assert.equal(wire.success, true, 'the WIRE must not throw on a semantic refinement — that is admission\'s job');
  const full = TurnSemanticProposalV1Schema.safeParse(proposal);
  assert.equal(full.success, false, 'admission still refuses the same proposal — nothing was weakened');
  // And the wire stays structurally strict: garbage shapes still fail at the wire.
  const garbage = TurnSemanticProposalV1WireSchema.safeParse({ version: 1, junk: true });
  assert.equal(garbage.success, false);
});

// ─── The wire split must not weaken admission, one level down ────────────────
//
// After the first wire split, weekly-review STILL died model_failed on
// "coverage and cardinality describe different read sets" — the topology field
// itself carried ActionWorkTopologySchema's superRefine, one level below the
// work schema. The wire now uses the structural base; admission parses the
// REFINED topology schema, so every topology check (including the
// inline-members cap, which admission's own superRefine never re-listed) is
// enforced there, and future checks added to the topology refinement are
// inherited automatically.
test('a topology refinement failure passes the wire and fails admission', async () => {
  const { TurnSemanticProposalV1Schema, TurnSemanticProposalV1WireSchema } = await import('./turn-semantic-proposal.js');
  const proposal = {
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: null,
    work: {
      construct: 'single_act',
      cardinality: null,
      requestedEffect: 'read',
      destination: null,
      destinations: [],
      topology: {
        version: 1,
        operations: [
          // dependsOn names an operation that does not exist — a DAG check that
          // lives in validateWorkTopology, reachable only via the refinement.
          { id: 'op_a', effect: 'read', coverage: null, dependsOn: ['op_missing'], dataFrom: [], cardinality: { kind: 'once' } },
        ],
        universes: [],
      },
      topologyHash: null,
      operations: [],
      deliverables: [],
      evidenceRequirements: [],
    },
    slotAnswers: [],
    rationale: 'topology wire/admission split fixture',
  };
  const wire = TurnSemanticProposalV1WireSchema.safeParse(proposal);
  assert.equal(wire.success, true, 'the wire must not throw on a topology refinement');
  const full = TurnSemanticProposalV1Schema.safeParse(proposal);
  assert.equal(full.success, false, 'admission still refuses the same topology');
});

// ─── Host-native operations under an open catalog ────────────────────────────
//
// Live incident (2026-08-25, morning-briefing brief step): with any descriptor
// disclosed, the second validator block demanded a successor descriptor from
// EVERY operation — including host_only/none/compute work, which by definition
// has no foreign descriptor to cite. The only admissible expression of "notify
// the user" was citing an irrelevant foreign capability, which then correctly
// died on capability_ref_effect_mismatch; the bounded repair re-cited from the
// same menu. Both citation blocks now share one exemption predicate.
test('a host_only operation admits without a foreign descriptor while the catalog is open', () => {
  const result = validateTurnSemanticProposalV1(proposal({
    work: {
      ...work(),
      operations: [
        { id: 'op-read', role: 'source', requestedEffect: 'read', dependsOn: [], evidence: [], capabilityRef: 'cap-1' },
        { id: 'op-write', role: 'destination', requestedEffect: 'external_write', dependsOn: ['op-read'], evidence: [], capabilityRef: 'cap-2' },
        { id: 'op-notify', role: 'presentation', requestedEffect: 'host_only', dependsOn: ['op-write'], evidence: [], capabilityRef: 'host_notify' },
      ],
    },
  }), host());
  assert.equal(result.ok, true, `host-native op must admit uncited: ${issueCodes(result).join(',')}`);
});

test('a host-native effect never exempts a FOREIGN citation from the effect check', () => {
  // The same shape, but the notify op cites a DISCLOSED foreign capability
  // with a mismatched effect — the exact live failure. The exemption keys on
  // requestedEffect, so a foreign-effect op citing garbage still rejects.
  const result = validateTurnSemanticProposalV1(proposal({
    work: {
      ...work(),
      operations: [
        { id: 'op-read', role: 'source', requestedEffect: 'read', dependsOn: [], evidence: [], capabilityRef: 'cap-1' },
        { id: 'op-notify', role: 'destination', requestedEffect: 'external_write', dependsOn: ['op-read'], evidence: [], capabilityRef: 'cap-1' },
      ],
    },
  }), host());
  assert.equal(result.ok, false, 'a mismatched foreign citation must still reject');
  assert.ok(
    issueCodes(result).includes('capability_ref_effect_mismatch'),
    `expected capability_ref_effect_mismatch, got: ${issueCodes(result).join(',')}`,
  );
});

test('kind-flow checking survives around a host-native operation in a mixed chain', () => {
  // cited read → host_only transform → cited write: the host-native middle op
  // is exempt (no descriptor pair to compare on its edges), while an edge
  // between two CITED ops with incompatible kinds must still reject.
  const chain = (midEffect: 'host_only' | 'read') => validateTurnSemanticProposalV1(proposal({
    work: {
      ...work(),
      operations: [
        { id: 'op-read', role: 'source', requestedEffect: 'read', dependsOn: [], evidence: [], capabilityRef: 'cap-1' },
        { id: 'op-mid', role: 'transform', requestedEffect: midEffect, dependsOn: ['op-read'], evidence: [], capabilityRef: midEffect === 'host_only' ? 'host_transform' : 'cap-collect' },
        { id: 'op-write', role: 'destination', requestedEffect: 'external_write', dependsOn: ['op-mid'], evidence: [], capabilityRef: 'cap-2' },
      ],
    },
  }), host());
  const mixed = chain('host_only');
  assert.equal(mixed.ok, true, `mixed chain with host-native middle must admit: ${issueCodes(mixed).join(',')}`);
  // Control: the SAME chain with a cited middle op whose produced kinds do not
  // satisfy the successor still rejects — the exemption did not swallow the
  // kind check between cited pairs. cap-collect produces 'records'; cap-2
  // accepts 'records', so build the mismatch on the first edge instead:
  // cap-1 produces 'records', cap-collect accepts 'records' — compatible.
  // Use cap-2 (accepts 'records', produces 'created_resource') feeding cap-1
  // (accepts 'query') to force the kind mismatch between two cited ops.
  const mismatched = validateTurnSemanticProposalV1(proposal({
    work: {
      ...work(),
      operations: [
        { id: 'op-a', role: 'destination', requestedEffect: 'external_write', dependsOn: [], evidence: [], capabilityRef: 'cap-2' },
        { id: 'op-b', role: 'source', requestedEffect: 'read', dependsOn: ['op-a'], evidence: [], capabilityRef: 'cap-1' },
      ],
    },
  }), host());
  assert.equal(mismatched.ok, false, 'kind mismatch between two cited ops must still reject');
  assert.ok(
    issueCodes(mismatched).includes('dag_kind_mismatch'),
    `expected dag_kind_mismatch, got: ${issueCodes(mismatched).join(',')}`,
  );
});


// ─── Candidates are hints, not authority (live 2026-08-25, unified lane) ─────
//
// A workflow step truthfully named ITS OWN workflow as a goal candidate and
// admission refused the proposal twice — the step catalog never discloses the
// step's own workflow id, and candidates were validated as if they authorized
// work. They authorize nothing: no dispatch or binding path reads them, and
// every operation keeps full citation checks. A truthful self-reference must
// not kill a run.
test('a candidate id outside the catalog admits — authority lives in the operations', () => {
  const result = validateTurnSemanticProposalV1(proposal({
    goal: {
      ...goal(),
      candidates: [
        { kind: 'workflow' as const, id: 'morning-briefing' },
        { kind: 'capability' as const, id: 'cap-1' },
      ],
    },
  }), host());
  assert.equal(result.ok, true, `advisory candidates must not block: ${issueCodes(result).join(',')}`);
});
