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

const { darkWriteReadBackAfter } = await import('./accepted-source-settlement-audit.js');

test('a write that ended without acknowledgement is answered by a successful read settled after it, and by nothing else', () => {
  // Live 2026-10-13: a note that landed while the connection dropped, read
  // back under the write freeze and reported, still ended "1 irreversible
  // external write(s) require reconciliation".
  const dark = { mutating: 1, execution_kind: 'provider_execution', outcome_kind: 'uncertain_write', outcome_detail: 'unacknowledged_mutation', settled_at: '2026-10-13T23:24:51.700Z' };
  const readAfter = { mutating: 0, outcome_kind: 'succeeded', settled_at: '2026-10-13T23:25:02.100Z' };
  const readBefore = { mutating: 0, outcome_kind: 'succeeded', settled_at: '2026-10-13T23:24:25.700Z' };
  const failedReadAfter = { mutating: 0, outcome_kind: 'unknown', settled_at: '2026-10-13T23:24:57.600Z' };
  const writeAfter = { mutating: 1, outcome_kind: 'succeeded', settled_at: '2026-10-13T23:25:30.000Z' };
  assert.equal(darkWriteReadBackAfter(dark, [readBefore, failedReadAfter, readAfter]), true, 'a read that returned after it answers it');
  assert.equal(darkWriteReadBackAfter(dark, [readBefore, failedReadAfter]), false, 'a read before it, or a read that failed, does not');
  assert.equal(darkWriteReadBackAfter(dark, [writeAfter]), false, 'a later write is not a read');
  assert.equal(darkWriteReadBackAfter({ ...dark, outcome_detail: 'provider_refused_envelope' }, [readAfter]), false, 'only the dark needs the read; a refusal is answered already');
  assert.equal(darkWriteReadBackAfter({ ...dark, execution_kind: 'refused_pre_dispatch' }, [readAfter]), false);
  assert.equal(darkWriteReadBackAfter({ ...dark, settled_at: null }, [readAfter]), false, 'no settlement time, no ordering, no answer');
  assert.equal(darkWriteReadBackAfter({ ...dark, execution_kind: 'local_execution' }, [readAfter]), true, 'a command that left the machine is the same case');
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
