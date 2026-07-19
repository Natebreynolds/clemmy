import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyVoiceGuards, _testOnly_sanitizeVoiceOutput } from './voice-rewrite.js';

// These cover the verdict-preservation guards that run AFTER the model call —
// the part that must never let a tone pass turn a snag/failure into "all set"
// or silence a run that needs the user. The LLM call itself is fail-open and
// exercised by the live smoke, not here.

test('clean done run can be a warm no-op', () => {
  const out = applyVoiceGuards(
    { message: 'Hey Alex — inbox is clear, nothing new to triage.', nothingHappened: true },
    'No qualifying unread Inbox emails were found using the bounded UTC filter window.',
    'done',
  );
  assert.equal(out.nothingHappened, true);
  assert.match(out.message, /inbox is clear/i);
});

test('done run that did work is not a no-op', () => {
  const out = applyVoiceGuards(
    { message: 'Hey Alex — triaged 3 emails, 1 needs your reply.', nothingHappened: false },
    'Processed 3 messages; 1 flagged.',
    'done',
  );
  assert.equal(out.nothingHappened, false);
});

test('blocked lane can NEVER be flagged as a no-op', () => {
  // Even if the model wrongly returns nothingHappened=true, a blocked run delivers.
  const out = applyVoiceGuards(
    { message: 'Hey Alex — this hit a snag; reply `apply fix abc123` to retry.', nothingHappened: true },
    'Step failed: needs approval.',
    'blocked',
  );
  assert.equal(out.nothingHappened, false);
});

test('failed lane can NEVER be flagged as a no-op', () => {
  const out = applyVoiceGuards(
    { message: 'Hey Alex — the run broke. Reply `apply fix xyz` and I will retry.', nothingHappened: true },
    'Workflow failed: timeout.',
    'failed',
  );
  assert.equal(out.nothingHappened, false);
});

test('failed lane reworded into success vocab falls back to original', () => {
  const original = 'Workflow failed: timeout reaching DataForSEO. Reply `apply fix xyz` to retry.';
  const out = applyVoiceGuards(
    { message: 'Hey Alex — all set, good to go!', nothingHappened: false },
    original,
    'failed',
  );
  // The lying tone is rejected; the honest original is delivered instead.
  assert.equal(out.message, original);
  assert.equal(out.nothingHappened, false);
});

test('blocked lane reworded into success vocab falls back to original', () => {
  const original = 'Needs attention — 1 step blocked on approval. Reply `apply fix abc` to proceed.';
  const out = applyVoiceGuards(
    { message: 'Nothing to triage — all done.', nothingHappened: false },
    original,
    'blocked',
  );
  assert.equal(out.message, original);
});

test('done lane is allowed to use all-clear vocab', () => {
  // The success-vocab guard only applies to blocked/failed — a real done run
  // SHOULD be able to say "nothing to triage".
  const out = applyVoiceGuards(
    { message: 'Hey Alex — nothing to triage today, inbox is clean.', nothingHappened: true },
    'No new emails.',
    'done',
  );
  assert.match(out.message, /nothing to triage/i);
  assert.equal(out.nothingHappened, true);
});

test('empty rewrite falls back to original body', () => {
  const out = applyVoiceGuards({ message: '   ', nothingHappened: true }, 'Original report.', 'done');
  assert.equal(out.message, 'Original report.');
  assert.equal(out.nothingHappened, false);
});

test('null result falls back to original body', () => {
  const out = applyVoiceGuards(null, 'Original report.', 'done');
  assert.equal(out.message, 'Original report.');
  assert.equal(out.nothingHappened, false);
});

test('sanitizeVoiceOutput accepts fenced JSON and schema aliases', () => {
  const out = _testOnly_sanitizeVoiceOutput('```json\n{"text":"Hey Alex — inbox is clear.","nothing_happened":"true"}\n```');
  assert.deepEqual(out, { message: 'Hey Alex — inbox is clear.', nothingHappened: true });
});

test('sanitizeVoiceOutput treats plain text as a safe non-silent rewrite', () => {
  const out = _testOnly_sanitizeVoiceOutput('Hey Alex — processed 4 messages and flagged 1 for reply.');
  assert.deepEqual(out, {
    message: 'Hey Alex — processed 4 messages and flagged 1 for reply.',
    nothingHappened: false,
  });
});
