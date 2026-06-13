import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReasoningEffort } from './reasoning-effort.js';

test('short read-only lookups → low', () => {
  for (const q of [
    "what's my calendar today?",
    'show me unread emails',
    'how many leads do I have?',
    'list my open workflows',
    'do I have any meetings tomorrow?',
  ]) {
    assert.equal(selectReasoningEffort(q).effort, 'low', q);
  }
});

test('complex / multi-step requests → high', () => {
  for (const q of [
    'research these prospects and build me a brief',
    'audit the SEO baseline for revill law firm',
    'draft an outreach campaign for my warm leads',
    'analyze the market and design a landing page',
    'refactor the autonomy engine',
  ]) {
    assert.equal(selectReasoningEffort(q).effort, 'high', q);
  }
});

test('continuations / acks → medium, never low', () => {
  for (const q of ['go ahead', 'yes', 'do it', 'sounds good', 'continue', 'ok']) {
    assert.equal(selectReasoningEffort(q).effort, 'medium', q);
  }
});

test('active goal forces high regardless of phrasing', () => {
  assert.equal(selectReasoningEffort('what next?', { hasActiveGoal: true }).effort, 'high');
  assert.equal(selectReasoningEffort('go ahead', { hasActiveGoal: true }).effort, 'high');
});

test('long input → high even without keywords', () => {
  const long = Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ');
  assert.equal(selectReasoningEffort(long).effort, 'high');
});

test('ambiguous mid-length statements → medium', () => {
  assert.equal(selectReasoningEffort('send a note to the Eley account about Tuesday').effort, 'medium');
  assert.equal(selectReasoningEffort('I think we should move the meeting').effort, 'medium');
});

test('empty / whitespace input → medium (safe default)', () => {
  assert.equal(selectReasoningEffort('').effort, 'medium');
  assert.equal(selectReasoningEffort('   ').effort, 'medium');
});

test('every result carries a reason tag', () => {
  const r = selectReasoningEffort("what's my calendar?");
  assert.ok(r.reason && typeof r.reason === 'string');
});
