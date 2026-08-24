/** Run: node scripts/run-tests-isolated.mjs src/runtime/gate-reason.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GATE_REASONS,
  deriveGateReason,
  disposeGate,
  interruptsUser,
  type GateFacts,
} from './gate-reason.js';

function prompts(facts: GateFacts): number {
  return interruptsUser(disposeGate(facts)) ? 1 : 0;
}

test('conversation never prompts and never holds', () => {
  const disposition = disposeGate({ posture: 'conversation' });
  assert.deepEqual(disposition, { status: 'proceed' });
  assert.equal(prompts({ posture: 'conversation' }), 0);
});

test('an authorized read never prompts, even when it could have been a write', () => {
  // The live failure this encodes: a user asked "who has already been sent the
  // invite?" and was answered as though something had been sent. Looking is not
  // doing, so no read may produce an interactive gate.
  assert.equal(prompts({ posture: 'authorized_read' }), 0);
  assert.equal(prompts({
    posture: 'authorized_read',
    uncoveredIrreversibleEffect: { effect: 'external_write' },
  }), 0);
  assert.equal(prompts({
    posture: 'authorized_read',
    discretionaryChoice: { optionIds: ['a', 'b'] },
  }), 0);
});

test('authorized reversible work proceeds without asking', () => {
  assert.equal(prompts({ posture: 'authorized_reversible' }), 0);
  assert.equal(prompts({
    posture: 'authorized_reversible',
    uncoveredIrreversibleEffect: { effect: 'local_write' },
  }), 0, 'reversible work is not gated by an irreversible-effect label');
});

test('deterministic holds block with zero prompts and no user decision', () => {
  const holds = [
    'admission_refused',
    'capability_identity_mismatch',
    'observation_unavailable',
    'provider_unavailable',
    'lease_unavailable',
    'reconciliation_pending',
    'budget_exhausted',
  ] as const;
  for (const hold of holds) {
    const facts: GateFacts = { posture: 'authorized_reversible', deterministicHold: hold };
    assert.deepEqual(disposeGate(facts), { status: 'blocked', hold });
    assert.equal(prompts(facts), 0, `${hold} must not become a question`);
  }
});

test('determinate reconciliation resolves without the user', () => {
  for (const reconciliation of ['present', 'absent'] as const) {
    const facts: GateFacts = {
      posture: 'irreversible',
      possiblyCommittedEffect: { physicalDispatchId: 'phys:1', reconciliation },
    };
    assert.equal(prompts(facts), 0, `${reconciliation} is determinate and needs no user`);
  }
});

test('an unresolved possibly-committed effect asks exactly once and outranks all else', () => {
  const facts: GateFacts = {
    posture: 'irreversible',
    possiblyCommittedEffect: { physicalDispatchId: 'phys:1', reconciliation: 'unknown' },
  };
  assert.deepEqual(disposeGate(facts), {
    status: 'needs_input',
    reason: 'uncertain_external_effect_requires_user',
  });
  // Even a deterministic hold cannot mask it: retrying could duplicate a real
  // external change, so this is the one fact that must reach the user.
  assert.deepEqual(
    disposeGate({ ...facts, deterministicHold: 'provider_unavailable' }),
    { status: 'needs_input', reason: 'uncertain_external_effect_requires_user' },
  );
});

test('each user-owned dependency asks exactly once, with its exact reason', () => {
  const cases: Array<[GateFacts, string]> = [
    [{ posture: 'irreversible', missingCredentialConnection: { capabilityId: 'cap-1' } }, 'credential_connection_required'],
    [{ posture: 'irreversible', missingUserAuthority: { requiredScope: 'send_as' } }, 'user_authority_required'],
    [{ posture: 'irreversible', missingEssentialInput: { slotIds: ['recipient'] } }, 'essential_input_required'],
    [{ posture: 'irreversible', discretionaryChoice: { optionIds: ['draft', 'send'] } }, 'discretion_required'],
    [{ posture: 'irreversible', uncoveredIrreversibleEffect: { effect: 'external_write' } }, 'irreversible_approval_required'],
  ];
  for (const [facts, expected] of cases) {
    const disposition = disposeGate(facts);
    assert.equal(disposition.status, 'needs_input', expected);
    assert.equal(disposition.status === 'needs_input' && disposition.reason, expected);
    assert.equal(prompts(facts), 1, `${expected} must ask exactly once`);
  }
});

test('a single option is not a choice', () => {
  assert.equal(prompts({
    posture: 'irreversible',
    discretionaryChoice: { optionIds: ['only'] },
  }), 0, 'one acceptable outcome is a decision the host can make');
});

test('an irreversible effect already covered by authority does not gate', () => {
  assert.equal(prompts({ posture: 'irreversible' }), 0,
    'irreversible alone is not a gate; only an UNCOVERED effect is');
});

test('no model or checker input can manufacture a gate', () => {
  // Facts carries no confidence, verdict, risk score, tool count or step count,
  // so these cannot be expressed. Passing them anyway must change nothing.
  const invalid = {
    posture: 'authorized_reversible' as const,
    modelConfidence: 0.1,
    checkerDisagreed: true,
    riskLabel: 'high',
    toolCount: 29,
    stepCount: 12,
    judgeVerdict: 'needs_approval',
    harnessWantsConfirmation: true,
    gateReason: 'irreversible_approval_required',
    reason: 'discretion_required',
  } as unknown as GateFacts;
  assert.equal(deriveGateReason(invalid), null);
  assert.deepEqual(disposeGate(invalid), { status: 'proceed' });
});

test('the reason set is closed and every reason is derivable', () => {
  assert.equal(GATE_REASONS.length, 6);
  assert.equal(new Set(GATE_REASONS).size, 6);
  assert.throws(() => { (GATE_REASONS as string[]).push('invented'); });

  const derivable = new Set(
    ([
      { posture: 'irreversible', discretionaryChoice: { optionIds: ['a', 'b'] } },
      { posture: 'irreversible', missingUserAuthority: { requiredScope: 's' } },
      { posture: 'irreversible', missingCredentialConnection: { capabilityId: 'c' } },
      { posture: 'irreversible', missingEssentialInput: { slotIds: ['x'] } },
      { posture: 'irreversible', uncoveredIrreversibleEffect: { effect: 'external_write' } },
      { posture: 'irreversible', possiblyCommittedEffect: { physicalDispatchId: 'p', reconciliation: 'unknown' } },
    ] satisfies GateFacts[]).map((facts) => deriveGateReason(facts)),
  );
  // Every allowed reason is reachable, and nothing outside the set is.
  assert.deepEqual([...derivable].sort(), [...GATE_REASONS].sort());
});
