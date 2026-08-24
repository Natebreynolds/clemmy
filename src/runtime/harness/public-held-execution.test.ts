/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/public-held-execution.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';

const { heldExecutionTextForInternalReason, publicHeldExecutionText } = await import('./public-presentation.js');

test('blocked account and uncertain write copy stay user-facing and secret-free', () => {
  const blocked = publicHeldExecutionText({
    kind: 'blocked',
    cause: 'account',
    providerCallOccurred: false,
    externalChangePossible: false,
    retrySafe: true,
    willResumeAutomatically: false,
  });
  assert.match(blocked, /No provider call was made/);
  assert.match(blocked, /reconnect the exact account/i);
  assert.doesNotMatch(blocked, /could not interpret/i);
  assert.doesNotMatch(blocked, /authorityDigest|canonicalArgs|acct:beta/i);

  const uncertain = publicHeldExecutionText({
    kind: 'uncertain',
    cause: 'reconciliation',
    providerCallOccurred: true,
    externalChangePossible: true,
    retrySafe: false,
    willResumeAutomatically: false,
  });
  assert.match(uncertain, /provider call was already reserved/);
  assert.match(uncertain, /will not write again/);
  assert.match(uncertain, /verify the artifact/i);
});

test('blocked and uncertain copy is the same on every public surface', () => {
  const surfaces = ['home', 'dashboard', 'webhook', 'cli', 'cron', 'discord', 'gateway'] as const;
  const blocked = heldExecutionTextForInternalReason('account_mismatch: live lease missing', 'blocked');
  const uncertain = heldExecutionTextForInternalReason('reconciliation_required: recovered crossing could not settle', 'uncertain');
  for (const surface of surfaces) {
    assert.equal(heldExecutionTextForInternalReason('account_mismatch: live lease missing', 'blocked'), blocked, surface);
    assert.equal(
      heldExecutionTextForInternalReason('reconciliation_required: recovered crossing could not settle', 'uncertain'),
      uncertain,
      surface,
    );
  }
  assert.match(blocked, /reconnect the exact account/i);
  assert.doesNotMatch(blocked, /could not interpret/i);
  assert.match(uncertain, /provider call was already reserved|An external change may already exist/i);
  assert.doesNotMatch(uncertain, /authorityDigest|canonicalArgs|acct:beta/i);
});
