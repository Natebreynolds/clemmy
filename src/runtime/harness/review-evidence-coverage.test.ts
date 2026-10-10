import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  assessReviewCoverage, parseNeedsAllOf, reviewCoverageFinding, reviewCoverageFollowUp, reviewCoverageLedger, reviewEvidenceCoverage,
} = await import('./review-evidence-coverage.js');
type Row = Parameters<typeof reviewEvidenceCoverage>[0][number];
type Lookup = NonNullable<Parameters<typeof reviewEvidenceCoverage>[1]>[number];

/** A list read shown to the review as a bounded view: 94 records, about one
 * percent of the bytes, the source complete for its request. */
const boundedList = (over: Partial<Row> = {}): Row => ({
  logicalToolCallId: 'call_list', toolName: 'provider_list_records', outcome: 'succeeded', status: 'verified',
  evidenceKind: 'source_result', resultHandleId: 'rh_list', contentComplete: false,
  rawByteCount: 351_835, shownByteCount: 3_687, recordCount: 94, sourceExhausted: true, ...over,
});
const writeReceipt: Row = {
  logicalToolCallId: 'call_write', toolName: 'provider_create_record', outcome: 'succeeded', status: 'verified',
  evidenceKind: 'source_result', resultHandleId: 'rh_write', contentComplete: true, rawByteCount: 2_879, shownByteCount: 2_879,
};
const page = (offset: number, returned: number, total = 94): Lookup => ({
  tool: 'query_evidence', ref: 'call_list', recordPath: 'data.value', recordsTotal: total,
  recordsMatched: total, recordsReturned: returned, offset,
});

test('a record count and a successful outcome are not an inspection', () => {
  const [row] = reviewEvidenceCoverage([boundedList()]);
  assert.equal(row!.inspection, 'unopened');
  assert.equal(row!.exhaustive, false, '94 records returned successfully says nothing about what they contain');
  const assessed = assessReviewCoverage({ results: [boundedList(), writeReceipt], needsAllOf: ['call_list'] });
  assert.equal(assessed.status, 'insufficient');
  assert.deepEqual(assessed.unsupported.map((entry) => entry.ref), ['call_list']);
});

test('a verdict needing the whole of nothing it holds in part is sufficient, with bounded results left open', () => {
  const assessed = assessReviewCoverage({ results: [boundedList(), writeReceipt], needsAllOf: ['call_write'] });
  assert.equal(assessed.status, 'sufficient');
  assert.deepEqual(assessed.open.map((entry) => entry.ref), ['call_list'], 'the bounded result stays on record as not inspected');
  assert.equal(assessReviewCoverage({ results: [boundedList(), writeReceipt], needsAllOf: [] }).status, 'sufficient');
});

test('a verdict that does not say what it needs the whole of is unattested while a result is only partly shown', () => {
  assert.equal(assessReviewCoverage({ results: [boundedList(), writeReceipt], needsAllOf: null }).status, 'unattested');
  assert.equal(assessReviewCoverage({ results: [writeReceipt], needsAllOf: null }).status, 'sufficient',
    'with every result whole there is nothing left to attest');
});

test('the target may be on a later page: one page of a list is a partial inspection', () => {
  const first = assessReviewCoverage({ results: [boundedList()], lookups: [page(0, 50)], needsAllOf: ['call_list'] });
  assert.equal(first.rows[0]!.inspection, 'partial');
  assert.equal(first.status, 'insufficient');
  const both = assessReviewCoverage({ results: [boundedList()], lookups: [page(0, 50), page(50, 44)], needsAllOf: ['call_list'] });
  assert.equal(both.rows[0]!.inspection, 'inspected');
  assert.equal(both.status, 'sufficient');
  const gap = assessReviewCoverage({ results: [boundedList()], lookups: [page(0, 40), page(50, 44)], needsAllOf: ['rh_list'] });
  assert.equal(gap.status, 'insufficient', 'records 40 to 49 were never returned');
});

test('a page cut inside a record returned no whole record and covers nothing', () => {
  const clipped = assessReviewCoverage({ results: [boundedList()], lookups: [page(0, 0)], needsAllOf: ['call_list'] });
  assert.equal(clipped.rows[0]!.inspection, 'partial');
  assert.equal(clipped.status, 'insufficient');
});

test('a criterion checked against every record is an exhaustive query', () => {
  const filtered: Lookup = { tool: 'query_evidence', ref: 'rh_list', recordPath: 'data.value', recordsTotal: 94,
    recordsMatched: 0, recordsReturned: 0, offset: 0, filter: { field: 'subject', mode: 'contains' }, fields: ['subject', 'start'] };
  const assessed = assessReviewCoverage({ results: [boundedList()], lookups: [filtered], needsAllOf: ['call_list'] });
  assert.equal(assessed.rows[0]!.inspection, 'queried');
  assert.equal(assessed.status, 'sufficient');
});

test('opening the text in ranges counts only when the ranges meet', () => {
  const open = (charStart: number, charEnd: number): Lookup => ({ tool: 'open_evidence', ref: 'call_list', charStart, charEnd, charTotal: 30_000 });
  assert.equal(reviewEvidenceCoverage([boundedList()], [open(0, 12_000), open(12_000, 24_000), open(24_000, 30_000)])[0]!.inspection, 'inspected');
  assert.equal(reviewEvidenceCoverage([boundedList()], [open(0, 12_000), open(18_000, 30_000)])[0]!.inspection, 'partial');
});

test('a refused or unknown lookup inspects nothing', () => {
  const refused: Lookup[] = [{ tool: 'query_evidence', ref: 'call_list', refused: 'budget' }, { tool: 'open_evidence', ref: 'call_other', refused: 'unknown_ref' }];
  assert.equal(reviewEvidenceCoverage([boundedList()], refused)[0]!.inspection, 'unopened');
});

test('more at the source: a fully shown page cannot show what lies beyond it', () => {
  const shownPage = boundedList({ contentComplete: true, shownByteCount: 351_835, sourceExhausted: false });
  const assessed = assessReviewCoverage({ results: [shownPage], needsAllOf: ['call_list'] });
  assert.equal(assessed.rows[0]!.inspection, 'shown');
  assert.equal(assessed.rows[0]!.moreAtSource, true);
  assert.equal(assessed.status, 'insufficient', 'the source had a further page or never said it was complete');
  assert.match(reviewCoverageFinding(assessed), /source reported more results/);
});

test('an empty complete result is sufficient evidence of an empty result', () => {
  const empty: Row = { logicalToolCallId: 'call_empty', toolName: 'provider_list_records', outcome: 'empty_result', status: 'verified',
    evidenceKind: 'source_result', resultHandleId: 'rh_empty', contentComplete: true, rawByteCount: 42, shownByteCount: 42,
    recordCount: 0, sourceExhausted: true };
  const assessed = assessReviewCoverage({ results: [empty], needsAllOf: ['call_empty'] });
  assert.equal(assessed.status, 'sufficient');
  assert.equal(assessed.open.length, 0);
  assert.equal(reviewCoverageLedger([empty]), undefined);
});

test('a complete retained read of a bounded result is its inspection; an incomplete one is not', () => {
  const projection = (contentComplete: boolean): Row => ({ logicalToolCallId: 'call_projection', toolName: 'tool_output_query',
    outcome: 'succeeded', status: 'verified', evidenceKind: 'retained_projection', resultHandleId: 'rh_projection',
    contentComplete, sourceLogicalToolCallId: 'call_list', sourceResultHandleId: 'rh_list' });
  const covered = assessReviewCoverage({ results: [boundedList(), projection(true)], needsAllOf: ['call_list'] });
  assert.equal(covered.status, 'sufficient');
  const bounded = assessReviewCoverage({ results: [boundedList(), projection(false)], needsAllOf: ['call_list'] });
  assert.equal(bounded.status, 'insufficient');
});

test('a wholly shown focused query supports its selection without certifying the whole producer', () => {
  const focused: Row = { logicalToolCallId: 'call_focus', toolName: 'tool_output_query',
    outcome: 'succeeded', status: 'verified', evidenceKind: 'retained_projection', resultHandleId: 'rh_focus',
    contentComplete: true, sourceSelectionComplete: false,
    sourceLogicalToolCallId: 'call_list', sourceResultHandleId: 'rh_list' };
  const wholeSource = assessReviewCoverage({ results: [boundedList(), focused], needsAllOf: ['call_list'] });
  assert.equal(wholeSource.status, 'insufficient');
  assert.equal(wholeSource.rows.find(row => row.ref === 'call_list')?.inspection, 'unopened');
  const selection = assessReviewCoverage({ results: [boundedList(), focused], needsAllOf: ['rh_focus'] });
  assert.equal(selection.status, 'sufficient', 'the exact selected reply is useful, fully shown evidence');
  assert.equal(selection.rows.find(row => row.ref === 'call_focus')?.exhaustive, true);
  assert.deepEqual(selection.open.map(row => row.ref), ['call_list']);
});

test('reading a focused reply whole cannot promote its ancestor through coverage lineage', () => {
  const focused: Row = { logicalToolCallId: 'call_focus', toolName: 'tool_output_query',
    outcome: 'succeeded', status: 'verified', evidenceKind: 'retained_projection', resultHandleId: 'rh_focus',
    contentComplete: false, sourceSelectionComplete: false, sourceLogicalToolCallId: 'call_list' };
  const reopened: Row = { logicalToolCallId: 'call_reopen', toolName: 'recall_tool_result',
    outcome: 'succeeded', status: 'verified', evidenceKind: 'retained_projection', resultHandleId: 'rh_reopen',
    contentComplete: true, sourceLogicalToolCallId: 'call_focus', sourceResultHandleId: 'rh_focus' };
  const assessed = assessReviewCoverage({ results: [boundedList(), focused, reopened], needsAllOf: ['call_list'] });
  assert.equal(assessed.status, 'insufficient');
  assert.equal(assessed.rows.find(row => row.ref === 'call_focus')?.inspection, 'queried');
  assert.equal(assessed.rows.find(row => row.ref === 'call_list')?.inspection, 'unopened');
});

test('discovery, repeated bytes and failed calls carry no claim and are never open coverage', () => {
  const rows: Row[] = [
    boundedList({ logicalToolCallId: 'call_search', toolName: 'tool_search', resultHandleId: 'rh_search', contentDisposition: 'discovery_navigation' }),
    boundedList({ logicalToolCallId: 'call_repeat', resultHandleId: 'rh_repeat', contentDisposition: 'duplicate_content' }),
    { logicalToolCallId: 'call_failed', toolName: 'provider_list_records', outcome: 'unknown', status: 'not_succeeded' },
  ];
  assert.deepEqual(reviewEvidenceCoverage(rows), []);
  assert.equal(assessReviewCoverage({ results: rows, needsAllOf: ['call_search'] }).status, 'sufficient');
  const assessed = assessReviewCoverage({ results: rows, needsAllOf: ['call_search', 'call_invented'] });
  assert.equal(assessed.status, 'insufficient');
  assert.deepEqual(assessed.unknownRefs, ['call_invented'], 'a ref matching no judged result is reported, not trusted');
});

test('a read made before a write keeps that order on its coverage row', () => {
  const [row] = reviewEvidenceCoverage([boundedList({ precedesWrite: true })]);
  assert.equal(row!.precedesWrite, true);
  assert.match(reviewCoverageLedger([boundedList({ precedesWrite: true })])!, /read before a write by this request/);
});

test('the rests-on line is parsed from the verdict, exactly and only when present', () => {
  assert.equal(parseNeedsAllOf('DONE: nine events created, each with a write receipt'), null);
  assert.deepEqual(parseNeedsAllOf('DONE: created.\nNEEDS ALL OF: none'), []);
  assert.deepEqual(parseNeedsAllOf('DONE: created.\nNEEDS ALL OF: call_write, `rh_list`.'), ['call_write', 'rh_list']);
  assert.deepEqual(parseNeedsAllOf('done: x\nneeds all of - call_a; call_a call_b'), ['call_a', 'call_b']);
});

test('the ledger and follow-up name the exact results and what was read of them', () => {
  const ledger = reviewCoverageLedger([boundedList(), writeReceipt])!;
  assert.match(ledger, /call_list \(provider_list_records\): 3687 of 351835 bytes shown; 94 records; nothing else opened/);
  assert.doesNotMatch(ledger, /call_write/, 'a result shown whole is not listed');
  const unattested = reviewCoverageFollowUp(assessReviewCoverage({ results: [boundedList()], needsAllOf: null }));
  assert.match(unattested, /did not say which results it needs the whole of/);
  const insufficient = assessReviewCoverage({ results: [boundedList()], lookups: [page(0, 50)], needsAllOf: ['call_list'] });
  assert.match(reviewCoverageFollowUp(insufficient), /1 lookup\(s\), not covering the rest/);
  assert.match(reviewCoverageFinding(insufficient), /holds 94 records and only part of it was read/);
});

test('resting on a repeated read is resting on the one view of those bytes', () => {
  const repeat = boundedList({ logicalToolCallId: 'call_repeat', resultHandleId: 'rh_repeat',
    contentDigest: 'd'.repeat(64), contentDisposition: 'duplicate_content', shownByteCount: 0 });
  const original = boundedList({ contentDigest: 'd'.repeat(64) });
  const assessed = assessReviewCoverage({ results: [original, repeat], needsAllOf: ['call_repeat'] });
  assert.equal(assessed.status, 'insufficient');
  assert.deepEqual(assessed.unsupported.map((entry) => entry.ref), ['call_list']);
  const whole = assessReviewCoverage({ results: [{ ...original, contentComplete: true }, repeat], needsAllOf: ['rh_repeat'] });
  assert.equal(whole.status, 'sufficient');
});

test('a verdict resting on the shown part of a large result needs none of the rest', () => {
  // The record the reply quotes is inside the view. Nothing about the rest of
  // the result has to be true for the verdict to hold, so nothing is reopened.
  const assessed = assessReviewCoverage({ results: [boundedList()], needsAllOf: [] });
  assert.equal(assessed.status, 'sufficient');
  assert.deepEqual(assessed.open.map((entry) => entry.ref), ['call_list']);
  assert.deepEqual(assessed.unsupported, []);
});

test('a result that is not a list is described by what was shown of it, never as zero records', () => {
  const text = boundedList({ logicalToolCallId: 'call_text', resultHandleId: 'rh_text', toolName: 'read_file', recordCount: 0 });
  const ledger = reviewCoverageLedger([text])!;
  assert.match(ledger, /call_text \(read_file\): 3687 of 351835 bytes shown; nothing else opened/);
  assert.doesNotMatch(ledger, /0 records/);
  assert.match(reviewCoverageFinding(assessReviewCoverage({ results: [text], needsAllOf: ['call_text'] })), /but only part of it was read/);
});

test('the line naming what a verdict needs is asked for only where a result is held in part', () => {
  assert.match(reviewCoverageLedger([boundedList()])!, /NEEDS ALL OF: <ref>, <ref>/);
  assert.equal(reviewCoverageLedger([writeReceipt]), undefined);
});
