import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBlockedSteps } from './workflow-diagnosis.js';

// These tests cover the additive, domain-agnostic self-reported-failure
// signal in detectBlockedSteps: a step that returns normal JSON but declares
// its own failure (ok:false / non-empty error string / a `*status` key whose
// value is in the small failure vocabulary) must be flagged as a blocked /
// needs-attention step, without the engine knowing any specific field name.

const ids = (steps: { stepId: string }[]) => steps.map((s) => s.stepId);

test('ok:false is flagged', () => {
  const out = detectBlockedSteps({ deliver: { ok: false } });
  assert.deepEqual(ids(out), ['deliver']);
});

test('a top-level non-empty error string is flagged', () => {
  const out = detectBlockedSteps({ deliver: { error: 'deploy failed: 500' } });
  assert.deepEqual(ids(out), ['deliver']);
});

test('an empty error string is NOT flagged', () => {
  const out = detectBlockedSteps({ deliver: { error: '   ' } });
  assert.deepEqual(out, []);
});

test('validationStatus:"fail" is flagged (caught by *status shape, not by name)', () => {
  const out = detectBlockedSteps({ audit: { validationStatus: 'fail' } });
  assert.deepEqual(ids(out), ['audit']);
});

test('deployStatus:"not_deployed" is flagged', () => {
  const out = detectBlockedSteps({ audit: { deployStatus: 'not_deployed' } });
  assert.deepEqual(ids(out), ['audit']);
});

test('the real failing run output is flagged', () => {
  const out = detectBlockedSteps({
    audit: { validationStatus: 'fail', deployStatus: 'not_deployed', netlifyUrl: null, score: 0 },
  });
  assert.deepEqual(ids(out), ['audit']);
});

test('the real healthy run output is NOT flagged', () => {
  const out = detectBlockedSteps({
    audit: { deployStatus: 'deployed', validationStatus: 'pass', score: 87.1, netlifyUrl: 'https://x.netlify.app' },
  });
  assert.deepEqual(out, []);
});

test('deployStatus:"deployed" is NOT flagged', () => {
  const out = detectBlockedSteps({ audit: { deployStatus: 'deployed' } });
  assert.deepEqual(out, []);
});

test('validationStatus:"pass" is NOT flagged', () => {
  const out = detectBlockedSteps({ audit: { validationStatus: 'pass' } });
  assert.deepEqual(out, []);
});

test('status:"active" is NOT flagged', () => {
  const out = detectBlockedSteps({ s: { status: 'active' } });
  assert.deepEqual(out, []);
});

test('status:"success" is NOT flagged', () => {
  const out = detectBlockedSteps({ s: { status: 'success' } });
  assert.deepEqual(out, []);
});

test('non-failure vocab values are NOT flagged', () => {
  const out = detectBlockedSteps({
    a: { status: 'ok' },
    b: { jobStatus: 'complete' },
    c: { runStatus: 'done' },
  });
  assert.deepEqual(out, []);
});

test('a healthy step reporting a sub-source as "unavailable" is NOT flagged', () => {
  // Corpus reality: a degraded-but-complete research step legitimately
  // reports adsStatus:"unavailable" (a partial-data marker, not a failure).
  // 'unavailable' / 'incomplete' are deliberately excluded from the vocab.
  const out = detectBlockedSteps({
    research: { adsStatus: 'unavailable', validationStatus: 'pass', score: 80 },
    deliver: { reviewStatus: 'incomplete', deployStatus: 'deployed' },
  });
  assert.deepEqual(out, []);
});

test('an output with none of the signals is NOT flagged', () => {
  const out = detectBlockedSteps({
    deliver: { ok: true, score: 92, url: 'https://x', items: ['a', 'b'] },
  });
  assert.deepEqual(out, []);
});

test('ok:true is NOT flagged (success boolean)', () => {
  const out = detectBlockedSteps({ deliver: { ok: true } });
  assert.deepEqual(out, []);
});

test('a JSON-string output is parsed and flagged', () => {
  const out = detectBlockedSteps({ deliver: '{"deployStatus":"not_deployed"}' });
  assert.deepEqual(ids(out), ['deliver']);
});

test('regression: existing {blocked:true} is STILL flagged', () => {
  const out = detectBlockedSteps({ s: { blocked: true, reason: 'connection expired' } });
  assert.deepEqual(ids(out), ['s']);
  assert.equal(out[0].reason, 'connection expired');
});

test('__synthesis__ / __-prefixed step outputs are skipped', () => {
  const out = detectBlockedSteps({ __synthesis__: { ok: false }, deliver: { ok: true } });
  assert.deepEqual(out, []);
});

test('the reason string names the offending field and value', () => {
  const out = detectBlockedSteps({ audit: { deployStatus: 'not_deployed' } });
  assert.equal(out.length, 1);
  assert.match(out[0].reason, /deployStatus/);
  assert.match(out[0].reason, /not_deployed/);
});

test('the ok=false reason is actionable', () => {
  const out = detectBlockedSteps({ deliver: { ok: false } });
  assert.equal(out.length, 1);
  assert.match(out[0].reason, /ok=false/);
});

test('the error reason includes the error text', () => {
  const out = detectBlockedSteps({ deliver: { error: 'auth token expired' } });
  assert.equal(out.length, 1);
  assert.match(out[0].reason, /auth token expired/);
});

// ─── kind: self_reported_failure must NOT route to the prompt-rewrite Doctor ───
// A step that RAN but self-declared a failure (missing data / provider) is a
// real outcome, not a bad prompt. It is tagged 'self_reported_failure' so the
// runner surfaces needs-attention WITHOUT proposing a bogus edit_step fix.
// An explicit {blocked:true} / prose block stays 'blocked' (Doctor-eligible).

test('a self-reported failure (validationStatus:fail) is tagged self_reported_failure', () => {
  const out = detectBlockedSteps({ audit: { validationStatus: 'fail' } });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'self_reported_failure');
});

test('ok:false is tagged self_reported_failure', () => {
  const out = detectBlockedSteps({ deliver: { ok: false } });
  assert.equal(out[0].kind, 'self_reported_failure');
});

test('an explicit {blocked:true} is tagged blocked (Doctor-eligible)', () => {
  const out = detectBlockedSteps({ s: { blocked: true, reason: 'connection expired' } });
  assert.equal(out[0].kind, 'blocked');
});

test('a prose block is tagged blocked', () => {
  const out = detectBlockedSteps({ s: 'Blocked: Drive connection expired.' });
  assert.equal(out[0].kind, 'blocked');
});

test('mixed run: explicit block is Doctor-eligible, polite failure is not', () => {
  const out = detectBlockedSteps(
    { a: { blocked: true, reason: 'drive expired' }, b: { deployStatus: 'not_deployed' } },
    ['a', 'b'],
  );
  const byId = Object.fromEntries(out.map((o) => [o.stepId, o.kind]));
  assert.equal(byId.a, 'blocked');
  assert.equal(byId.b, 'self_reported_failure');
  // The runner filters to kind==='blocked' before calling the Doctor.
  const doctorEligible = out.filter((o) => o.kind === 'blocked');
  assert.deepEqual(doctorEligible.map((o) => o.stepId), ['a']);
});
