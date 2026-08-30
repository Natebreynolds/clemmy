/**
 * Claude/Codex-style Auto is Clementine's default interaction contract.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/runtime/harness/auto-mode-interactive-consent.acceptance.test.ts
 *
 * This is deliberately provider- and tool-name-neutral. The model proposes
 * work; the host projects one exact admitted call into structural effect,
 * consequence, cardinality, readiness, and authority facts. Only that closed
 * shape may decide whether the user sees a card.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  evaluateInteractiveConsentV1,
  type CapabilityRiskAttestationV1,
  type EvaluateInteractiveConsentInputV1,
  type ExactUserGrantV1,
  type ExactWorkCoverageV1,
  type InteractiveConsentDecisionV1,
  type InteractiveConsentReadiness,
} from './interactive-consent-policy.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function exactCall(
  label: string,
  overrides: Partial<CapabilityRiskAttestationV1> = {},
): CapabilityRiskAttestationV1 {
  return {
    version: 1,
    source: {
      kind: 'accepted_turn',
      id: `source:${label}`,
      digest: sha256(`source:${label}`),
    },
    acceptedTaskId: `task:${label}`,
    bindingDigest: sha256(`binding:${label}`),
    logicalToolCallId: `call:${label}`,
    operationId: `operation:${label}`,
    argumentDigest: sha256(`arguments:${label}`),
    schemaFingerprint: sha256(`schema:${label}`),
    effect: 'external_write',
    accountId: `account:${label}`,
    destination: {
      digest: sha256(`destination:${label}`),
      posture: 'named_existing',
    },
    cardinality: { kind: 'once' },
    risk: {
      reversibility: 'ordinary_non_destructive',
      consequence: 'update',
      destructive: false,
    },
    semanticBasis: {
      kind: 'current_external_definition',
      digest: sha256(`semantics:${label}`),
    },
    safety: 'admissible',
    ...overrides,
  };
}

function exactCoverage(call: CapabilityRiskAttestationV1): ExactWorkCoverageV1 {
  return {
    version: 1,
    source: { ...call.source },
    acceptedTaskId: call.acceptedTaskId,
    contractId: `contract:${call.logicalToolCallId}`,
    requirementId: `requirement:${call.logicalToolCallId}`,
    requirementDigest: sha256(`requirement:${call.logicalToolCallId}`),
    semanticScope: {
      operationId: call.operationId,
      schemaFingerprint: call.schemaFingerprint,
      effect: call.effect,
      accountId: call.accountId,
      destination: { ...call.destination },
      cardinality: { ...call.cardinality },
      semanticBasis: { ...call.semanticBasis },
    },
    callBinding: {
      logicalToolCallId: call.logicalToolCallId,
      argumentDigest: call.argumentDigest,
      bindingDigest: call.bindingDigest,
    },
    reservationKey: `reservation:${call.logicalToolCallId}`,
  };
}

function exactGrant(call: CapabilityRiskAttestationV1): ExactUserGrantV1 {
  return {
    version: 1,
    source: 'approval_resolution',
    grantDigest: sha256(`grant:${call.logicalToolCallId}`),
    scope: {
      source: { ...call.source },
      acceptedTaskId: call.acceptedTaskId,
      logicalToolCallId: call.logicalToolCallId,
      bindingDigest: call.bindingDigest,
      operationId: call.operationId,
      argumentDigest: call.argumentDigest,
      schemaFingerprint: call.schemaFingerprint,
      effect: call.effect,
      accountId: call.accountId,
      destination: { ...call.destination },
      cardinality: { ...call.cardinality },
      risk: { ...call.risk },
      semanticBasis: { ...call.semanticBasis },
    },
  };
}

function decide(
  call: CapabilityRiskAttestationV1,
  overrides: Partial<EvaluateInteractiveConsentInputV1> = {},
): InteractiveConsentDecisionV1 {
  const noMutation = call.effect === 'read'
    || call.effect === 'compute'
    || call.effect === 'host_only';
  return evaluateInteractiveConsentV1({
    call,
    coverage: noMutation ? null : exactCoverage(call),
    userGrant: null,
    readiness: { kind: 'ready' },
    crossing: 'not_started',
    reservationAlreadyClaimed: false,
    ...overrides,
  });
}

function cards(decision: InteractiveConsentDecisionV1): InteractiveConsentDecisionV1[] {
  return decision.kind === 'needs_user' ? [decision] : [];
}

test('Auto emits zero cards for conversation, local search, Clem internals, and exact ordinary work', () => {
  // Conversation has no admitted call, therefore it never enters the consent
  // reducer and has no card surface.
  const conversationCards: InteractiveConsentDecisionV1[] = [];
  assert.equal(conversationCards.length, 0);

  const localFileSearch = exactCall('local-file-search', {
    effect: 'read',
    accountId: null,
    destination: { digest: sha256('local-file-search:none'), posture: 'not_applicable' },
    risk: { reversibility: 'read_only', consequence: 'read', destructive: false },
    semanticBasis: { kind: 'local_registry', digest: sha256('local-file-search:registry') },
  });
  const clemBookkeeping = exactCall('clem-bookkeeping', {
    effect: 'host_only',
    accountId: null,
    destination: { digest: sha256('clem-bookkeeping:none'), posture: 'not_applicable' },
    risk: { reversibility: 'read_only', consequence: 'read', destructive: false },
    semanticBasis: { kind: 'local_registry', digest: sha256('clem-bookkeeping:registry') },
  });
  const localCreate = exactCall('local-create', {
    effect: 'local_write',
    accountId: null,
    destination: { digest: sha256('local-create:new'), posture: 'create_new' },
    risk: { reversibility: 'reversible', consequence: 'create', destructive: false },
    semanticBasis: { kind: 'local_registry', digest: sha256('local-create:registry') },
  });
  const externalCreate = exactCall('external-create', {
    destination: { digest: sha256('external-create:new'), posture: 'create_new' },
    risk: {
      reversibility: 'ordinary_non_destructive',
      consequence: 'create',
      destructive: false,
    },
  });
  const externalUpdate = exactCall('external-update');

  const ordinary = [
    decide(localFileSearch),
    decide(clemBookkeeping),
    decide(localCreate),
    decide(externalCreate),
    decide(externalUpdate),
  ];
  assert.deepEqual(ordinary.map((decision) => decision.kind), [
    'proceed', 'proceed', 'proceed', 'proceed', 'proceed',
  ]);
  assert.equal(ordinary.flatMap(cards).length, 0);
});

test('host bookkeeping and internal recovery can repair but can never ask the user', () => {
  const hostOnly = exactCall('host-recovery', {
    effect: 'host_only',
    accountId: null,
    destination: { digest: sha256('host-recovery:none'), posture: 'not_applicable' },
    risk: { reversibility: 'read_only', consequence: 'read', destructive: false },
    semanticBasis: { kind: 'local_registry', digest: sha256('host-recovery:registry') },
  });
  const impossibleReadiness: InteractiveConsentReadiness[] = [
    { kind: 'credential_missing', connectionRef: 'internal-state-is-not-a-user-credential' },
    { kind: 'choice_required', field: 'target', candidates: ['host-a', 'host-b'] },
    { kind: 'essential_input', slot: 'internal_checkpoint' },
    { kind: 'invalid', reason: 'stale internal recovery projection' },
  ];
  for (const readiness of impossibleReadiness) {
    const decision = decide(hostOnly, { readiness });
    assert.notEqual(decision.kind, 'needs_user', JSON.stringify({ readiness, decision }));
    assert.equal(cards(decision).length, 0);
  }
  const checkpoint = decide(hostOnly, {
    explicitHumanCheckpoint: { subjectDigest: sha256('bad-internal-checkpoint') },
  });
  assert.notEqual(checkpoint.kind, 'needs_user', JSON.stringify(checkpoint));
  assert.equal(cards(checkpoint).length, 0);
});

test('Auto emits exactly one actionable approval or choice for genuine user-owned stops', () => {
  const highConsequence = [
    exactCall('irreversible-send', {
      risk: { reversibility: 'irreversible', consequence: 'send', destructive: false },
    }),
    exactCall('destructive-delete', {
      risk: { reversibility: 'reversible', consequence: 'delete', destructive: true },
    }),
    exactCall('administrative-change', {
      effect: 'admin',
      risk: { reversibility: 'reversible', consequence: 'admin', destructive: false },
    }),
    exactCall('bulk-reversible-update', {
      cardinality: { kind: 'set', universeDigest: sha256('reviewed-bulk-set') },
      risk: { reversibility: 'reversible', consequence: 'update', destructive: false },
    }),
    // Financial authority is structural, not a provider/tool-name list. A
    // transaction is an irreversible execution even when an opposite
    // compensating transaction may be possible later.
    exactCall('financial-transaction', {
      risk: { reversibility: 'irreversible', consequence: 'execute', destructive: false },
    }),
  ];

  for (const call of highConsequence) {
    const decision = decide(call);
    assert.deepEqual(cards(decision).length, 1, call.logicalToolCallId);
    assert.equal(decision.kind, 'needs_user', call.logicalToolCallId);
    if (decision.kind !== 'needs_user') continue;
    assert.equal(decision.need, 'approval', call.logicalToolCallId);
    assert.equal(decision.subjectDigest, call.bindingDigest, call.logicalToolCallId);
    assert.ok(decision.reason.length > 0, call.logicalToolCallId);
  }

  const ordinary = exactCall('ambiguous-external-target');
  for (const readiness of [
    { kind: 'choice_required', field: 'account', candidates: ['account-a', 'account-b'] },
    { kind: 'choice_required', field: 'target', candidates: ['target-a', 'target-b'] },
  ] satisfies InteractiveConsentReadiness[]) {
    const decision = decide(ordinary, { readiness });
    assert.equal(cards(decision).length, 1, JSON.stringify(readiness));
    assert.equal(decision.kind, 'needs_user');
    if (decision.kind !== 'needs_user') continue;
    assert.equal(decision.need, 'choice');
    assert.equal(decision.subjectDigest, ordinary.bindingDigest);
    assert.match(decision.reason, new RegExp(readiness.field));
  }
});

test('one exact approval resumes only the sealed call and cannot spend its reservation twice', () => {
  const call = exactCall('sealed-high-consequence', {
    risk: { reversibility: 'irreversible', consequence: 'send', destructive: false },
  });
  const grant = exactGrant(call);
  const first = decide(call, { userGrant: grant });
  assert.deepEqual(first, {
    kind: 'proceed',
    basis: 'exact_user_grant',
    authorityDigest: grant.grantDigest,
    reservationKey: `reservation:${call.logicalToolCallId}`,
  });

  const sibling = exactCall('sealed-high-consequence-sibling', {
    risk: { reversibility: 'irreversible', consequence: 'send', destructive: false },
  });
  assert.deepEqual(decide(sibling, { userGrant: grant }), {
    kind: 'repair',
    reason: 'scope_mismatch',
  });
  assert.deepEqual(decide(call, {
    userGrant: grant,
    reservationAlreadyClaimed: true,
  }), {
    kind: 'repair',
    reason: 'cardinality_spent',
  });
});
