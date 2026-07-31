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

test('the live narrated envelope collapses to the question plus the reply', () => {
  const parsed = parseNarratedEnvelope(LIVE);
  assert.ok(parsed, 'the envelope is detected');
  assert.match(parsed!.reply, /^The remembered DataForSEO task has expired/);
  assert.match(parsed!.preamble, /^Which Firecrawl connection/);

  const shown = stripNarratedEnvelope(LIVE);
  assert.match(shown, /Which Firecrawl connection should I use/, 'the actual question survives');
  assert.match(shown, /two accounts are connected/, 'the human-facing reply survives');
  for (const leaked of ['summary:', 'done:', 'nextAction:', 'reason:']) {
    assert.ok(!shown.includes(leaked), `internal field "${leaked}" must not reach the user`);
  }
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
  // Three keys present, but no `reply` — returning '' would erase the only text
  // the user has.
  assert.equal(parseNarratedEnvelope(partial), null);
  assert.equal(stripNarratedEnvelope(partial), partial);
});

test('markdown-decorated envelope lines are still caught', () => {
  const decorated = [
    '- summary: scoped the project',
    '- reply: I pulled 10 firms and put them in the base.',
    '- done: base created',
    '- nextAction: enrich contacts',
  ].join('\n');
  assert.equal(stripNarratedEnvelope(decorated), 'I pulled 10 firms and put them in the base.');
});
