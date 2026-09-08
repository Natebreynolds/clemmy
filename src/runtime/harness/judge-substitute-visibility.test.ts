import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBoundaryJudgeChain, downshiftForBoundary } from './debate-model.js';
import type { ResolvedRoleModel } from './model-roles.js';

// Reviewer: "a substitute or fail-open result must not be reported as successful
// Opus qualification." A cheaper chain lane standing in for an honoured exact pin
// must be identifiable from the routing itself.
test('an honoured exact pin is marked on the routing it produces', () => {
  const pinned = downshiftForBoundary({
    modelId: 'claude-opus-5', provider: 'claude', source: 'settings',
  } as ResolvedRoleModel);
  assert.equal(pinned.modelId, 'claude-opus-5', 'the pin must survive');
  assert.equal(pinned.exactHeavyweightPin, true, 'and be marked as exact');
});

test('a default flagship carries no exact-pin marking, so nothing downstream claims one', () => {
  const dflt = downshiftForBoundary({
    modelId: 'claude-opus-5', provider: 'claude', source: 'default',
  } as ResolvedRoleModel);
  assert.notEqual(dflt.modelId, 'claude-opus-5');
  assert.ok(!dflt.exactHeavyweightPin);
});

/** Drive the judge role deterministically instead of inheriting the machine's. */
function withJudgeRole<T>(roles: string | null, run: () => T): T {
  const prior = process.env.CLEMMY_MODEL_ROLES;
  if (roles === null) delete process.env.CLEMMY_MODEL_ROLES;
  else process.env.CLEMMY_MODEL_ROLES = roles;
  try { return run(); } finally {
    if (prior === undefined) delete process.env.CLEMMY_MODEL_ROLES;
    else process.env.CLEMMY_MODEL_ROLES = prior;
  }
}

test('with NO judge pin configured, no lane may claim to be a substitute', () => {
  withJudgeRole(null, () => {
    for (const lane of resolveBoundaryJudgeChain()) {
      assert.ok(!lane.substituteForExactPin, 'no substitute marking without a requested pin');
      assert.ok(!lane.requestedModelId, 'and nothing to report as requested');
    }
  });
});

test('lanes standing in for a requested pin are marked, and name what was requested', () => {
  const roles = JSON.stringify([
    { role: 'judge', modelId: 'claude-opus-5', scope: 'durable', source: 'settings' },
  ]);
  withJudgeRole(roles, () => {
    const chain = resolveBoundaryJudgeChain();
    if (chain.length === 0) return; // no provider could build here
    const lead = chain[0]!;
    for (const lane of chain) {
      if (lane.exactHeavyweightPin === true) {
        assert.ok(!lane.substituteForExactPin, 'the pinned lane itself is not a substitute');
        continue;
      }
      assert.equal(
        lane.substituteForExactPin, true,
        `lane ${lane.modelId} stands in for the pin and must say so`,
      );
      assert.equal(lane.requestedModelId, 'claude-opus-5', 'the requested id must travel with it');
      assert.ok(
        lane.substituteReason === 'exact_pin_unresolved'
          || lane.substituteReason === 'chain_fallback_after_exact_pin',
        `a substitute must state why: ${String(lane.substituteReason)}`,
      );
    }
    // THE REGRESSION the reviewer identified: when exact resolution fails, the
    // FIRST lane is already a stand-in. Keying the marking off chain[0]'s own pin
    // flag left it unmarked in exactly that case.
    if (!lead.exactHeavyweightPin) {
      assert.equal(
        lead.substituteForExactPin, true,
        'an unresolved pin must leave the leading lane marked as a substitute',
      );
      assert.equal(lead.substituteReason, 'exact_pin_unresolved');
    }
  });
});

// ─── Reviewer residuals (C13 review, 05:48 UTC) ──────────────────────────────

test('a HEALTHY explicit light-model pin is never labelled a substitute', () => {
  // downshiftForBoundary stamps exactHeavyweightPin only for flagship ids, so a
  // deliberately chosen light judge resolves WITHOUT that flag. Keying the
  // marking off the flag reported this honoured pin as `exact_pin_unresolved`
  // while that exact model was doing the judging.
  for (const light of ['claude-haiku-4-5', 'gpt-5.4-mini']) {
    const roles = JSON.stringify([
      { role: 'judge', modelId: light, scope: 'durable', source: 'settings' },
    ]);
    withJudgeRole(roles, () => {
      const chain = resolveBoundaryJudgeChain();
      const lead = chain[0];
      if (!lead || lead.modelId !== light) return; // that lane could not build here
      assert.ok(
        !lead.substituteForExactPin,
        `${light} is the requested judge and is running — it is not a substitute`,
      );
    });
  }
});

test('the single-lane resolver marks substitutes too, not only the chain', async () => {
  // objective-judge (and grounding) call resolveBoundaryJudge, not the chain.
  // While only the chain marked substitutes, those doors recorded none at all.
  const { requestedJudgePinModelId } = await import('./debate-model.js');
  withJudgeRole(null, () => {
    assert.equal(requestedJudgePinModelId(), null, 'no pin ⇒ nothing requested');
  });
  const roles = JSON.stringify([
    { role: 'judge', modelId: 'claude-opus-5', scope: 'durable', source: 'settings' },
  ]);
  withJudgeRole(roles, () => {
    assert.equal(
      requestedJudgePinModelId(), 'claude-opus-5',
      'the requested pin must be readable by every judge door, however it resolves',
    );
  });
});
