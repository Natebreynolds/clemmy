/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/interactive-consent-policy.test.ts */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateInteractiveConsentV1,
  type CapabilityRiskAttestationV1,
  type EvaluateInteractiveConsentInputV1,
  type ExactUserGrantV1,
  type ExactWorkCoverageV1,
} from './interactive-consent-policy.js';

const digest = (letter: string): string => letter.repeat(64);

function call(
  overrides: Partial<CapabilityRiskAttestationV1> = {},
): CapabilityRiskAttestationV1 {
  return {
    version: 1,
    source: { kind: 'accepted_turn', id: 'source-1', digest: digest('f') },
    acceptedTaskId: 'task-1',
    bindingDigest: digest('a'),
    logicalToolCallId: 'call-1',
    operationId: 'operation-1',
    argumentDigest: digest('b'),
    schemaFingerprint: digest('c'),
    effect: 'local_write',
    accountId: null,
    destination: { digest: digest('d'), posture: 'create_new' },
    cardinality: { kind: 'once' },
    risk: { reversibility: 'reversible', consequence: 'create', destructive: false },
    semanticBasis: { kind: 'local_registry', digest: digest('e') },
    safety: 'admissible',
    ...overrides,
  };
}

function coverage(
  exactCall: CapabilityRiskAttestationV1,
  overrides: Partial<ExactWorkCoverageV1> = {},
): ExactWorkCoverageV1 {
  return {
    version: 1,
    source: { kind: 'accepted_turn', id: 'source-1', digest: digest('f') },
    acceptedTaskId: 'task-1',
    contractId: 'contract-1',
    requirementId: 'requirement-1',
    requirementDigest: digest('1'),
    semanticScope: {
      operationId: exactCall.operationId,
      schemaFingerprint: exactCall.schemaFingerprint,
      effect: exactCall.effect,
      accountId: exactCall.accountId,
      destination: { ...exactCall.destination },
      cardinality: { ...exactCall.cardinality },
      semanticBasis: { ...exactCall.semanticBasis },
    },
    callBinding: {
      logicalToolCallId: exactCall.logicalToolCallId,
      argumentDigest: exactCall.argumentDigest,
      bindingDigest: exactCall.bindingDigest,
    },
    reservationKey: 'contract-1\0requirement-1',
    ...overrides,
  };
}

function grant(exactCall: CapabilityRiskAttestationV1): ExactUserGrantV1 {
  return {
    version: 1,
    source: 'approval_resolution',
    grantDigest: digest('2'),
    scope: {
      source: { ...exactCall.source },
      acceptedTaskId: exactCall.acceptedTaskId,
      logicalToolCallId: exactCall.logicalToolCallId,
      bindingDigest: exactCall.bindingDigest,
      operationId: exactCall.operationId,
      argumentDigest: exactCall.argumentDigest,
      schemaFingerprint: exactCall.schemaFingerprint,
      effect: exactCall.effect,
      accountId: exactCall.accountId,
      destination: { ...exactCall.destination },
      cardinality: { ...exactCall.cardinality },
      risk: { ...exactCall.risk },
      semanticBasis: { ...exactCall.semanticBasis },
    },
  };
}

function input(
  exactCall: CapabilityRiskAttestationV1,
  overrides: Partial<EvaluateInteractiveConsentInputV1> = {},
): EvaluateInteractiveConsentInputV1 {
  return {
    call: exactCall,
    coverage: coverage(exactCall),
    userGrant: null,
    readiness: { kind: 'ready' },
    crossing: 'not_started',
    reservationAlreadyClaimed: false,
    ...overrides,
  };
}

test('reads and exact accepted reversible or ordinary work proceed without a human gate', () => {
  const read = call({
    effect: 'read',
    risk: { reversibility: 'read_only', consequence: 'read', destructive: false },
    destination: { digest: digest('0'), posture: 'not_applicable' },
  });
  assert.deepEqual(evaluateInteractiveConsentV1(input(read, { coverage: null })), {
    kind: 'proceed', basis: 'no_effect', authorityDigest: read.bindingDigest,
  });

  const write = call();
  assert.deepEqual(evaluateInteractiveConsentV1(input(write)), {
    kind: 'proceed',
    basis: 'exact_reversible_work',
    authorityDigest: digest('1'),
    reservationKey: 'contract-1\0requirement-1',
  });

  const ordinary = call({
    risk: {
      reversibility: 'ordinary_non_destructive',
      consequence: 'update',
      destructive: false,
    },
  });
  assert.deepEqual(evaluateInteractiveConsentV1(input(ordinary)), {
    kind: 'proceed',
    basis: 'exact_ordinary_work',
    authorityDigest: digest('1'),
    reservationKey: 'contract-1\0requirement-1',
  });
  assert.deepEqual(evaluateInteractiveConsentV1(input(ordinary, { coverage: null })), {
    kind: 'repair', reason: 'coverage_missing',
  });
});

test('a graph-neutral surprise write or any exact scope drift repairs to the model', () => {
  const exactCall = call();
  assert.deepEqual(
    evaluateInteractiveConsentV1(input(exactCall, { coverage: null })),
    { kind: 'repair', reason: 'coverage_missing' },
  );

  const fields: Array<[string, ExactWorkCoverageV1]> = [
    ['source', coverage(exactCall, { source: { kind: 'accepted_turn', id: 'other', digest: digest('f') } })],
    ['task', coverage(exactCall, { acceptedTaskId: 'other-task' })],
    ['operation', coverage(exactCall, { semanticScope: { ...coverage(exactCall).semanticScope, operationId: 'other' } })],
    ['arguments', coverage(exactCall, { callBinding: { ...coverage(exactCall).callBinding, argumentDigest: digest('9') } })],
    ['schema', coverage(exactCall, { semanticScope: { ...coverage(exactCall).semanticScope, schemaFingerprint: digest('9') } })],
    ['account', coverage(exactCall, { semanticScope: { ...coverage(exactCall).semanticScope, accountId: 'other' } })],
    ['destination', coverage(exactCall, { semanticScope: { ...coverage(exactCall).semanticScope, destination: { digest: digest('9'), posture: 'create_new' } } })],
    ['cardinality', coverage(exactCall, { semanticScope: { ...coverage(exactCall).semanticScope, cardinality: { kind: 'each', universeDigest: digest('9') } } })],
    ['semantics', coverage(exactCall, { semanticScope: { ...coverage(exactCall).semanticScope, semanticBasis: { kind: 'local_registry', digest: digest('9') } } })],
  ];
  for (const [label, changed] of fields) {
    assert.deepEqual(
      evaluateInteractiveConsentV1(input(exactCall, { coverage: changed })),
      { kind: 'repair', reason: 'scope_mismatch' },
      label,
    );
  }
});

test('high-consequence work needs one exact grant and mismatched grants never authorize', () => {
  for (const exactCall of [
    call({ risk: { reversibility: 'irreversible', consequence: 'send', destructive: false } }),
    call({ risk: { reversibility: 'reversible', consequence: 'delete', destructive: true } }),
    call({ effect: 'admin', risk: { reversibility: 'reversible', consequence: 'admin', destructive: false } }),
    // Consequence is an independent safety floor. Neither an ordinary nor an
    // unknown reversibility projection may downgrade SEND/DELETE/ADMIN.
    call({ risk: { reversibility: 'ordinary_non_destructive', consequence: 'send', destructive: false } }),
    call({ risk: { reversibility: 'unknown', consequence: 'delete', destructive: false } }),
    call({ risk: { reversibility: 'unknown', consequence: 'admin', destructive: false } }),
    call({ risk: { reversibility: 'unknown', consequence: 'unknown', destructive: true } }),
  ]) {
    assert.equal(evaluateInteractiveConsentV1(input(exactCall)).kind, 'needs_user');
    assert.deepEqual(evaluateInteractiveConsentV1(input(exactCall, { userGrant: grant(exactCall) })), {
      kind: 'proceed',
      basis: 'exact_user_grant',
      authorityDigest: digest('2'),
      reservationKey: 'contract-1\0requirement-1',
    });
    const wrong = grant(exactCall);
    wrong.scope.argumentDigest = digest('8');
    assert.deepEqual(evaluateInteractiveConsentV1(input(exactCall, { userGrant: wrong })), {
      kind: 'repair', reason: 'scope_mismatch',
    });
  }

  const surpriseSend = call({
    risk: { reversibility: 'irreversible', consequence: 'send', destructive: false },
  });
  assert.deepEqual(evaluateInteractiveConsentV1(input(surpriseSend, { coverage: null })), {
    kind: 'repair', reason: 'coverage_missing',
  });
});

test('credentials, choices, essential input, explicit checkpoints, and unknown effects stay distinct', () => {
  const exactCall = call();
  assert.equal(evaluateInteractiveConsentV1(input(exactCall, {
    readiness: { kind: 'credential_missing', connectionRef: 'connection-1' },
  })).kind, 'needs_user');
  assert.equal(evaluateInteractiveConsentV1(input(exactCall, {
    readiness: { kind: 'choice_required', field: 'account', candidates: ['a', 'b'] },
  })).kind, 'needs_user');
  assert.equal(evaluateInteractiveConsentV1(input(exactCall, {
    readiness: { kind: 'essential_input', slot: 'destination' },
  })).kind, 'needs_user');
  assert.deepEqual(evaluateInteractiveConsentV1(input(exactCall, {
    explicitHumanCheckpoint: { subjectDigest: digest('7') },
  })), {
    kind: 'needs_user',
    need: 'approval',
    subjectDigest: digest('7'),
    reason: 'This accepted workflow explicitly requires a human checkpoint.',
  });
  const checkpointedRead = call({
    effect: 'read',
    risk: { reversibility: 'read_only', consequence: 'read', destructive: false },
    destination: { digest: digest('0'), posture: 'not_applicable' },
  });
  assert.equal(evaluateInteractiveConsentV1(input(checkpointedRead, {
    coverage: null,
    explicitHumanCheckpoint: { subjectDigest: digest('7') },
  })).kind, 'needs_user');
  assert.equal(evaluateInteractiveConsentV1(input(checkpointedRead, {
    coverage: null,
    explicitHumanCheckpoint: { subjectDigest: digest('7') },
    userGrant: grant(checkpointedRead),
  })).kind, 'proceed');
  assert.deepEqual(evaluateInteractiveConsentV1(input(exactCall, { crossing: 'possibly_started' })), {
    kind: 'reconcile', reason: 'possible_effect', retry: 'never_blind',
  });
});

test('protected/untrusted calls refuse, unknown semantics repair, and spent cardinality never re-executes', () => {
  assert.deepEqual(evaluateInteractiveConsentV1(input(call({ safety: 'protected' }))), {
    kind: 'refuse', reason: 'protected_target',
  });
  assert.deepEqual(evaluateInteractiveConsentV1(input(call({ safety: 'untrusted' }))), {
    kind: 'refuse', reason: 'untrusted_execution',
  });
  for (const impossible of [
    call({
      effect: 'read',
      risk: { reversibility: 'irreversible', consequence: 'read', destructive: false },
    }),
    call({
      effect: 'read',
      risk: { reversibility: 'read_only', consequence: 'send', destructive: false },
    }),
    call({
      effect: 'compute',
      risk: { reversibility: 'read_only', consequence: 'delete', destructive: false },
    }),
    call({
      effect: 'host_only',
      risk: { reversibility: 'read_only', consequence: 'read', destructive: true },
    }),
  ]) {
    assert.deepEqual(evaluateInteractiveConsentV1(input(impossible, { coverage: null })), {
      kind: 'repair', reason: 'authority_conflict',
    });
  }
  const mixed = call({
    risk: { reversibility: 'unknown', consequence: 'unknown', destructive: false },
  });
  assert.deepEqual(evaluateInteractiveConsentV1(input(mixed)), {
    kind: 'repair', reason: 'risk_unknown',
  });
  assert.deepEqual(evaluateInteractiveConsentV1(input(mixed, { coverage: null })), {
    kind: 'repair', reason: 'coverage_missing',
  });
  assert.deepEqual(evaluateInteractiveConsentV1(input(call(), { reservationAlreadyClaimed: true })), {
    kind: 'repair', reason: 'cardinality_spent',
  });

  const replay = call();
  assert.deepEqual(evaluateInteractiveConsentV1(input(replay, {
    crossing: 'settled',
    readiness: { kind: 'credential_missing', connectionRef: 'removed-after-success' },
    reservationAlreadyClaimed: true,
  })), {
    kind: 'proceed', basis: 'settled_replay', authorityDigest: replay.bindingDigest,
  });
});
