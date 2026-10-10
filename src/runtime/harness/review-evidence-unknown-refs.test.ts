import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessReviewCoverage, parseNeedsAllOf, reviewCoverageFinding,
  reviewCoverageFollowUp, type ReviewedEvidenceRow } from './review-evidence-coverage.js';

const whole: ReviewedEvidenceRow = { logicalToolCallId: 'call_whole', resultHandleId: 'rh_whole',
  toolName: 'provider_read', outcome: 'succeeded', status: 'verified', evidenceKind: 'source_result',
  contentComplete: true, sourceExhausted: true };
const bounded: ReviewedEvidenceRow = { ...whole, logicalToolCallId: 'call_bounded', resultHandleId: 'rh_bounded',
  contentComplete: false };

test('only an explicit lone none attests that no whole result is needed', () => {
  for (const none of ['none', 'NONE.', 'none!', 'None;']) {
    assert.deepEqual(parseNeedsAllOf(`DONE: reviewed.\nNEEDS ALL OF: ${none}`), [], none);
  }
  for (const malformed of ['', '   ', 'none, call_invented', 'none; rh_whole', 'none because one record was shown', ', ;', '[]', '``']) {
    const parsed = parseNeedsAllOf(`DONE: reviewed.\nNEEDS ALL OF: ${malformed}\nFinal note.`);
    assert.notDeepEqual(parsed, [], `malformed ${JSON.stringify(malformed)} cannot waive inspection`);
    assert.equal(parsed, null, malformed);
    assert.equal(assessReviewCoverage({ results: [bounded], needsAllOf: parsed }).status, 'unattested');
  }
});

test('duplicate and conflicting attestation lines remain unattested instead of taking the first line', () => {
  for (const second of ['none', 'call_whole', 'call_invented', '']) {
    assert.equal(parseNeedsAllOf(`DONE: reviewed.\nNEEDS ALL OF: none\nNEEDS ALL OF: ${second}`), null);
  }
  assert.equal(parseNeedsAllOf('DONE: reviewed.\r\nNEEDS ALL OF:\r\ncall_invented'), null,
    'blank line parsing never consumes a following line as its scope');
});

test('unambiguous exact call and result-handle lists keep their existing punctuation and alias grammar', () => {
  const parsed = parseNeedsAllOf('DONE: reviewed.\r\n  needs all of - call_whole; `rh_whole`. call_whole');
  assert.deepEqual(parsed, ['call_whole', 'rh_whole']);
  assert.equal(assessReviewCoverage({ results: [whole], needsAllOf: parsed }).status, 'sufficient');
  const unknown = parseNeedsAllOf('DONE: reviewed.\nNEEDS ALL OF: call_invented');
  assert.deepEqual(unknown, ['call_invented']);
  assert.equal(assessReviewCoverage({ results: [whole], needsAllOf: unknown }).status, 'insufficient');
});

test('an unknown whole-result attestation is insufficient even when every supplied result is shown whole', () => {
  const assessed = assessReviewCoverage({ results: [whole], needsAllOf: parseNeedsAllOf('DONE: reviewed.\nNEEDS ALL OF: call_invented') });
  assert.equal(assessed.status, 'insufficient');
  assert.deepEqual(assessed.unknownRefs, ['call_invented']);
  assert.deepEqual(assessed.unsupported, []);
  assert.match(reviewCoverageFollowUp(assessed), /These refs match no result under review: call_invented/);
  assert.match(reviewCoverageFinding(assessed), /\(1\).*\[call_invented\].*matches no retained result/,
    'if the reviewer repeats the unknown binding, the assistant receives a concrete correction');
  assert.equal(assessReviewCoverage({ results: [], needsAllOf: ['call_invented'] }).status, 'insufficient');
});

test('known call and result-handle aliases remain valid while a mixed or similar unknown ref cannot borrow their coverage', () => {
  assert.equal(assessReviewCoverage({ results: [whole], needsAllOf: ['call_whole', 'rh_whole'] }).status, 'sufficient');
  const assessed = assessReviewCoverage({ results: [whole], needsAllOf: ['rh_whole', 'rh_whole_extra'] });
  assert.equal(assessed.status, 'insufficient');
  assert.deepEqual(assessed.unknownRefs, ['rh_whole_extra']);
  assert.equal(assessReviewCoverage({ results: [whole], needsAllOf: [] }).status, 'sufficient',
    'a verdict resting only on what was shown retains the existing none contract');
});

test('complete focused replies and duplicate-result aliases keep their own exact inspection coverage', () => {
  const focus: ReviewedEvidenceRow = { ...whole, logicalToolCallId: 'call_focus', resultHandleId: 'rh_focus',
    evidenceKind: 'retained_projection', sourceLogicalToolCallId: 'call_bounded', sourceResultHandleId: 'rh_bounded' };
  assert.equal(assessReviewCoverage({ results: [bounded, focus], needsAllOf: ['call_focus', 'rh_focus'] }).status, 'sufficient');
  const duplicate: ReviewedEvidenceRow = { ...whole, logicalToolCallId: 'call_repeat', resultHandleId: 'rh_repeat',
    contentComplete: false, contentDisposition: 'duplicate_content', contentDigest: 'a'.repeat(64) };
  assert.equal(assessReviewCoverage({ results: [{ ...whole, contentDigest: 'a'.repeat(64) }, duplicate],
    needsAllOf: ['call_repeat', 'rh_repeat'] }).status, 'sufficient');
});

test('lookup receipts inspect only their exact retained owner and unknown lookups create no result authority', () => {
  const validLookup = { tool: 'open_evidence' as const, ref: 'rh_bounded', charStart: 0, charEnd: 100, charTotal: 100 };
  assert.equal(assessReviewCoverage({ results: [bounded], lookups: [validLookup], needsAllOf: ['call_bounded'] }).status, 'sufficient');
  const unknown = assessReviewCoverage({ results: [bounded], lookups: [{ ...validLookup, ref: 'call_invented' }],
    needsAllOf: ['call_bounded', 'call_invented'] });
  assert.equal(unknown.status, 'insufficient');
  assert.deepEqual(unknown.unsupported.map(row => row.ref), ['call_bounded']);
  assert.deepEqual(unknown.unknownRefs, ['call_invented']);
  assert.match(reviewCoverageFinding(unknown), /\(1\).*call_bounded.*\(2\).*call_invented/);
});
