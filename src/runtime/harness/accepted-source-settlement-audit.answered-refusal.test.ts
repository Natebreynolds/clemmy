/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/accepted-source-settlement-audit.answered-refusal.test.ts
 *
 * A provider that answered a write with its own refusal is an answered
 * attempt the model reads back, never an irreversible write the audit holds
 * for reconciliation (live 2026-10-07, Slack `not_found` on a delete).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { answeredRefusalSettlement } = await import('./accepted-source-settlement-audit.js');

test('an answered refusal is exactly a mutating provider execution settled uncertain by the provider\'s own refusal envelope', () => {
  const base = { mutating: 1, execution_kind: 'provider_execution', outcome_kind: 'uncertain_write', outcome_detail: 'provider_refused_envelope' };
  assert.equal(answeredRefusalSettlement(base), true);
  assert.equal(answeredRefusalSettlement({ ...base, outcome_detail: 'unacknowledged_mutation' }), false, 'a dropped acknowledgement is the dark');
  assert.equal(answeredRefusalSettlement({ ...base, outcome_kind: 'unknown' }), false);
  assert.equal(answeredRefusalSettlement({ ...base, mutating: 0 }), false, 'a read has nothing to reconcile either way');
  assert.equal(answeredRefusalSettlement({ ...base, execution_kind: 'local_execution' }), false);
});
