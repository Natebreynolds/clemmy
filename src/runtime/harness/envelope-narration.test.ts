/**
 * Run: npx tsx --test src/runtime/harness/envelope-narration.test.ts
 *
 * Live 3.5.0 defect: a user was shown Clem's internal decision envelope as
 * prose instead of her answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNarratedEnvelope, stripNarratedEnvelope } from './envelope-narration.js';

// Reproduced from the live screenshot.
const LIVE = [
  'Which Firecrawl connection should I use: `firecrawl_aurin-cha` or `firecrawl_stot-merida`?',
  '',
  'summary: The Boston prospecting run has started, but SERP discovery is blocked on choosing the correct Firecrawl account.',
  'reply: The remembered DataForSEO task has expired, and there is no currently configured DataForSEO MCP server. Firecrawl is the available search fallback, but two accounts are connected and I can\'t safely choose between them.',
  'done: Confirmed the old DataForSEO task is unavailable and identified the two usable Firecrawl connections.',
  'nextAction: Run the four Boston searches through your selected Firecrawl account, qualify and enrich 10 firms, then create the new Airtable base.',
  'reason: Selecting the wrong connected account could use the wrong organization\'s credits or data.',
].join('\n');

test('the live narrated envelope loses its labels and keeps every word', () => {
  const parsed = parseNarratedEnvelope(LIVE);
  assert.ok(parsed, 'the envelope is detected');
  assert.match(parsed!.preamble, /^Which Firecrawl connection/);

  const shown = stripNarratedEnvelope(LIVE);
  assert.match(shown, /Which Firecrawl connection should I use/, 'the actual question survives');
  assert.match(shown, /two accounts are connected/, 'the human-facing reply survives');
  assert.match(shown, /Confirmed the old DataForSEO task is unavailable/, 'what was done survives');
  assert.match(shown, /Run the four Boston searches/, 'the next step survives');
  assert.match(shown, /wrong organization/, 'the justification survives');
  for (const leaked of ['summary:', 'reply:', 'done:', 'nextAction:', 'reason:']) {
    assert.ok(!shown.includes(leaked), `internal field label "${leaked}" must not reach the user`);
  }
});

test('a SUCCESSFUL run keeps its substance — stripping to reply-only would gut the report', () => {
  // Second live case: the work went perfectly, and the useful detail lived
  // under done/nextAction/reason. Showing only `reply` would have reduced a
  // real report to one line.
  const success = [
    'summary: All 10 prospects were added to Lunar Local CRM successfully.',
    'reply: Chris, they are in the Leads table of the Lunar Local CRM Airtable base.',
    'done: Verified exactly 10 Boston records. Each includes the firm, website, contact details, fit score, SEO issues, and outreach angle.',
    'nextAction: The four firms still missing a verified decision-maker can be contact-enriched later: Boston Injury Law Group, Neumann Law Group, TopDog Law, and Diller Law.',
    'reason: The Airtable read-back returned all 10 requested firms, confirming the batch landed correctly.',
  ].join('\n');
  const shown = stripNarratedEnvelope(success);
  assert.match(shown, /Leads table/, 'the answer survives');
  assert.match(shown, /Verified exactly 10 Boston records/, 'the verification detail survives');
  assert.match(shown, /Neumann Law Group/, 'the named follow-ups survive');
  assert.match(shown, /read-back returned all 10/, 'the evidence survives');
  assert.ok(!/^\s*(summary|reply|done|nextAction|reason)\s*:/m.test(shown), 'no field labels remain');
});

test('ordinary prose is never rewritten', () => {
  const cases = [
    'Here is the summary: we found 12 firms and I will draft outreach next.',
    'Two notes:\n- reason: the API was slow\nThat is all.',
    'done: yes',
    '',
    'I checked the calendar and you have three meetings today.',
  ];
  for (const text of cases) {
    assert.equal(stripNarratedEnvelope(text), text, `must not touch: ${text.slice(0, 40)}`);
    assert.equal(parseNarratedEnvelope(text), null);
  }
});

test('a partial envelope with no usable reply is left alone rather than blanked', () => {
  const partial = [
    'summary: something happened',
    'done: true',
    'nextAction: keep going',
  ].join('\n');
  // Three keys present and no `reply` — the remaining values are still real
  // content, so they are kept (label-free) rather than discarded.
  const shown = stripNarratedEnvelope(partial);
  assert.match(shown, /something happened/);
  assert.match(shown, /keep going/);
  assert.ok(!shown.includes('nextAction:'));
});

test('markdown-decorated envelope lines are still caught', () => {
  const decorated = [
    '- summary: scoped the project',
    '- reply: I pulled 10 firms and put them in the base.',
    '- done: base created',
    '- nextAction: enrich contacts',
  ].join('\n');
  assert.match(stripNarratedEnvelope(decorated), /scoped the project/);
  assert.match(stripNarratedEnvelope(decorated), /I pulled 10 firms/);
  assert.ok(!stripNarratedEnvelope(decorated).includes('nextAction:'));
});
