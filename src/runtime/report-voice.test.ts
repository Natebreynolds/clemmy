/**
 * Run: npx tsx --test src/runtime/report-voice.test.ts
 *
 * humanizeReportBody strips the worker's audit ledger + machine framing from a
 * HUMAN-facing notification body, and is fail-open (empty/garbage → original).
 * Pure function — no state, no CLEMENTINE_HOME needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeReportBody } from './report-voice.js';

test('drops the audit ledger from ## Evidence / Verification onward', () => {
  const worker = [
    'Yates & Wheland ranks #3 for "personal injury lawyer" in the metro.',
    '',
    '## Completed',
    '- Pulled organic SERP for the 4 target terms.',
    '',
    '## Evidence / Verification',
    '- DataForSEO task 07182, checksum ok.',
    '',
    '## Remaining Risks',
    '- Volatility on term #2.',
    '',
    '## Next Step',
    '- Re-run weekly.',
  ].join('\n');
  const out = humanizeReportBody(worker);
  assert.match(out, /Yates & Wheland ranks #3/);
  assert.match(out, /## Completed/);
  assert.doesNotMatch(out, /Evidence \/ Verification/);
  assert.doesNotMatch(out, /Remaining Risks/);
  assert.doesNotMatch(out, /Next Step/);
});

test('drops from ## Remaining Risks when no Evidence section exists', () => {
  const worker = [
    'The report is attached.',
    '',
    '## Remaining Risks',
    '- None.',
  ].join('\n');
  assert.equal(humanizeReportBody(worker), 'The report is attached.');
});

test('tolerates ### heading level and odd spacing', () => {
  const worker = 'Answer here.\n\n###   Evidence/Verification\nstuff';
  assert.equal(humanizeReportBody(worker), 'Answer here.');
});

test('strips a leading machine framing token', () => {
  const framed = '[background task bg-7 completed] Deal review\n\nThe pipeline looks healthy.';
  assert.equal(humanizeReportBody(framed), 'Deal review\n\nThe pipeline looks healthy.');
});

test('collapses 3+ blank lines to a single blank line', () => {
  assert.equal(humanizeReportBody('a\n\n\n\n\nb'), 'a\n\nb');
});

test('leaves a clean human answer untouched', () => {
  const clean = 'Booked the demo for Thursday at 2pm and sent the invite.';
  assert.equal(humanizeReportBody(clean), clean);
});

test('fail-open: empty / whitespace / all-audit input returns the original text', () => {
  assert.equal(humanizeReportBody(''), '');
  // A body that is ONLY an audit section would strip to empty → keep original.
  const onlyAudit = '## Evidence / Verification\n- proof';
  assert.equal(humanizeReportBody(onlyAudit), onlyAudit);
});

test('does not match an inline (non-heading) mention of the section words', () => {
  const inline = 'We added an Evidence / Verification column to the sheet.';
  assert.equal(humanizeReportBody(inline), inline);
});
