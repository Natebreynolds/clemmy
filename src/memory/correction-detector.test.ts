/**
 * Run: npx tsx --test src/memory/correction-detector.test.ts
 */
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-correction-detector';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { resetMemoryDb } = await import('./db.js');
const { rememberFact } = await import('./facts.js');
const { readRecallRefUtilitySignals } = await import('./recall-usage.js');
const { recallUtilityBonus } = await import('./recall-memory.js');
const {
  detectCorrectionCue,
  recordCorrectionSignal,
  parseCorrectionVerdict,
  parseSerializedRefs,
} = await import('./correction-detector.js');

before(() => { rmSync(TEST_HOME, { recursive: true, force: true }); });
beforeEach(() => { resetMemoryDb(); });

// ---------- detectCorrectionCue (pure) ----------

test('cue: leading negations are corrections', () => {
  for (const text of [
    'No, the renewal is in March.',
    "That's wrong — the ARR is 240k.",
    "nope, it's the Denver account",
    'Actually it was Priya, not Sam.',
    "you're wrong about the close date",
    'the correct number is 42',
  ]) {
    assert.equal(detectCorrectionCue(text).cued, true, `should cue: ${text}`);
  }
});

test('cue: non-corrections do not fire', () => {
  for (const text of [
    'Yes, that looks right, thanks.',
    'Can you pull the pipeline for Q3?',
    'No worries, take your time.', // "No worries" is not a correction of a claim
    'What did the customer say on the call?',
    'Great, ship it.',
  ]) {
    assert.equal(detectCorrectionCue(text).cued, false, `should NOT cue: ${text}`);
  }
});

test('cue: empty / whitespace never cues', () => {
  assert.equal(detectCorrectionCue('').cued, false);
  assert.equal(detectCorrectionCue('   ').cued, false);
});

// ---------- recordCorrectionSignal (Tier 1) + teeth (Tier 2) ----------

test('recordCorrectionSignal records not_useful and demotes the fact', () => {
  const fact = rememberFact({ kind: 'project', content: 'The Hamilton renewal closes in September.' });
  const ref = { type: 'fact' as const, id: String(fact.id) };

  const before = readRecallRefUtilitySignals([ref]).get(`fact:${fact.id}`);
  assert.equal(before?.notUseful ?? 0, 0);

  const res = recordCorrectionSignal({
    objective: 'correction: no, it closes in March',
    refs: [ref],
    detail: 'auto:correction',
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.factIds, [fact.id]);

  const signal = readRecallRefUtilitySignals([ref]).get(`fact:${fact.id}`);
  assert.equal(signal?.notUseful, 1);
  assert.equal(signal?.used, 0);

  // Teeth: a purely-corrected fact earns a bounded negative rerank adjustment.
  const bonus = recallUtilityBonus(signal);
  assert.ok(bonus < 0, `expected penalty, got ${bonus}`);
  assert.ok(bonus >= -0.12, `penalty must be bounded, got ${bonus}`);
});

test('teeth: a single correction against a well-used fact does NOT go negative', () => {
  // used dominates -> positive branch (accumulation gate).
  const bonus = recallUtilityBonus({ used: 5, notUseful: 1, lastUsedAt: null });
  assert.ok(bonus >= 0, `well-used fact should not be penalized by one correction, got ${bonus}`);
});

test('teeth: repeated corrections deepen the penalty, capped', () => {
  const one = recallUtilityBonus({ used: 0, notUseful: 1, lastUsedAt: null });
  const three = recallUtilityBonus({ used: 0, notUseful: 3, lastUsedAt: null });
  const many = recallUtilityBonus({ used: 0, notUseful: 50, lastUsedAt: null });
  assert.ok(three < one, 'more corrections => deeper penalty');
  assert.ok(many >= -0.12, 'penalty stays bounded');
});

test('recordCorrectionSignal with no refs is a no-op', () => {
  const res = recordCorrectionSignal({ objective: 'x', refs: [], detail: 'auto:correction' });
  assert.equal(res.ok, false);
});

// ---------- parseSerializedRefs ----------

test('parseSerializedRefs parses and dedupes serialized refs', () => {
  const refs = parseSerializedRefs(['fact:12', 'fact:12', 'note:a/b.md', 'garbage', '', null]);
  assert.deepEqual(refs, [{ type: 'fact', id: '12' }, { type: 'note', id: 'a/b.md' }]);
});

// ---------- parseCorrectionVerdict (fail-closed) ----------

test('parseCorrectionVerdict: APPROVE/VETO parse; anything else is unavailable', () => {
  assert.equal(parseCorrectionVerdict('APPROVE: clearly rejects the prior number').verdict, 'approve');
  assert.equal(parseCorrectionVerdict('VETO: user is asking a new question').verdict, 'veto');
  assert.equal(parseCorrectionVerdict('').verdict, 'unavailable');
  assert.equal(parseCorrectionVerdict('I think maybe').verdict, 'unavailable');
});
