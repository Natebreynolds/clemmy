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

test('an answered refusal is exactly a mutating execution settled uncertain by the provider\'s own refusal, on a provider or host crossing', () => {
  const base = { mutating: 1, execution_kind: 'provider_execution', outcome_kind: 'uncertain_write', outcome_detail: 'provider_refused_envelope' };
  assert.equal(answeredRefusalSettlement(base), true);
  assert.equal(answeredRefusalSettlement({ ...base, outcome_detail: 'unacknowledged_mutation' }), false, 'a dropped acknowledgement is the dark');
  assert.equal(answeredRefusalSettlement({ ...base, outcome_kind: 'unknown' }), false);
  assert.equal(answeredRefusalSettlement({ ...base, mutating: 0 }), false, 'a read has nothing to reconcile either way');
  // A command that leaves the machine runs on the host's own crossing; a
  // completed non-zero exit is the same answer (owner 2026-10-09).
  assert.equal(answeredRefusalSettlement({ ...base, execution_kind: 'local_execution' }), true);
  assert.equal(answeredRefusalSettlement({ ...base, execution_kind: 'refused_pre_dispatch' }), false);
});

test('provider contradiction stays answered while an unacknowledged write needs its own exact proof', () => {
  const base = { mutating: 1, execution_kind: 'provider_execution', outcome_kind: 'uncertain_write', outcome_detail: 'provider_envelope_contradiction' };
  assert.equal(answeredRefusalSettlement(base), true);
  assert.equal(answeredRefusalSettlement({ ...base, execution_kind: 'local_execution' }), true);
  assert.equal(answeredRefusalSettlement({ ...base, outcome_detail: 'unacknowledged_mutation' }), false);
});

test('a host adapter that reported the provider\'s own refusal with no effect is an answered refusal too', () => {
  // Live 2026-10-05: Browserbase refused a new session (plan or concurrency
  // limit); the cloud browser tool reported it in a typed field, the model
  // said so, and the turn still ended "1 business call failure(s) have no
  // successful recovery".
  const limit = { mutating: 1, execution_kind: 'local_execution', outcome_kind: 'input_required', outcome_detail: 'host_reported:provider_limit' };
  assert.equal(answeredRefusalSettlement(limit), true);
  assert.equal(answeredRefusalSettlement({ ...limit, outcome_kind: 'invalid_arguments', outcome_detail: 'host_reported:cloud_browser_not_dispatched' }), true);
  assert.equal(answeredRefusalSettlement({ ...limit, outcome_kind: 'auth_failure', outcome_detail: 'host_reported:credential_unavailable' }), true);
  assert.equal(answeredRefusalSettlement({ ...limit, outcome_kind: 'unknown', outcome_detail: 'execution_failed' }), false, 'a failure nobody reported stays unrecovered');
  assert.equal(answeredRefusalSettlement({ ...limit, outcome_detail: 'host_reported_failure' }), false, 'a report without a token names no refusal');
  assert.equal(answeredRefusalSettlement({ ...limit, mutating: 0 }), false);
  assert.equal(answeredRefusalSettlement({ ...limit, execution_kind: 'refused_pre_dispatch' }), false);
  assert.equal(answeredRefusalSettlement({ ...limit, outcome_kind: 'uncertain_write' }), false, 'an uncertain write needs its own reply detail');
});
