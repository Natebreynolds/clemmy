/**
 * Run: npx tsx --test src/runtime/harness/envelope-narration.test.ts
 *
 * Live 3.5.0 defect: a user was shown Clem's internal decision envelope as
 * prose instead of her answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNarratedEnvelope,
  publicReplyFromNarratedEnvelope,
  stripNarratedEnvelope,
} from './envelope-narration.js';
import { toOrchestratorDecision } from './turn-decision.js';

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

test('the live narrated envelope preserves field semantics but publishes only the reply and question', () => {
  const parsed = parseNarratedEnvelope(LIVE);
  assert.ok(parsed, 'the envelope is detected');
  assert.match(parsed!.preamble, /^Which Firecrawl connection/);
  assert.match(parsed!.fields.summary ?? '', /Boston prospecting run/);
  assert.match(parsed!.fields.done ?? '', /Confirmed the old DataForSEO task/);
  assert.match(parsed!.fields.nextaction ?? '', /Run the four Boston searches/);
  assert.match(parsed!.fields.reason ?? '', /wrong organization/);

  const shown = stripNarratedEnvelope(LIVE);
  assert.match(shown, /Which Firecrawl connection should I use/, 'the actual question survives');
  assert.match(shown, /two accounts are connected/, 'the human-facing reply survives');
  assert.doesNotMatch(shown, /Confirmed the old DataForSEO task is unavailable/, 'done bookkeeping is not chat copy');
  assert.doesNotMatch(shown, /Run the four Boston searches/, 'nextAction bookkeeping is not chat copy');
  assert.doesNotMatch(shown, /wrong organization/, 'reason bookkeeping is not chat copy');
  for (const leaked of ['summary:', 'reply:', 'done:', 'nextAction:', 'reason:']) {
    assert.ok(!shown.includes(leaked), `internal field label "${leaked}" must not reach the user`);
  }

  const decision = toOrchestratorDecision(LIVE);
  assert.equal(decision?.done, false);
  assert.equal(decision?.nextAction, 'awaiting_user_input');
  assert.equal(decision?.reply, shown);
});

test('a successful narrated run keeps evidence in typed fields without narrating it as the answer', () => {
  const success = [
    'summary: All 10 prospects were added to Lunar Local CRM successfully.',
    'reply: Chris, they are in the Leads table of the Lunar Local CRM Airtable base.',
    'done: Verified exactly 10 Boston records. Each includes the firm, website, contact details, fit score, SEO issues, and outreach angle.',
    'nextAction: The four firms still missing a verified decision-maker can be contact-enriched later: Boston Injury Law Group, Neumann Law Group, TopDog Law, and Diller Law.',
    'reason: The Airtable read-back returned all 10 requested firms, confirming the batch landed correctly.',
  ].join('\n');
  const parsed = parseNarratedEnvelope(success);
  assert.ok(parsed);
  assert.match(parsed!.fields.done ?? '', /Verified exactly 10 Boston records/);
  assert.match(parsed!.fields.nextaction ?? '', /Neumann Law Group/);
  assert.match(parsed!.fields.reason ?? '', /read-back returned all 10/);

  const shown = publicReplyFromNarratedEnvelope(success) ?? '';
  assert.match(shown, /Leads table/, 'the answer survives');
  assert.doesNotMatch(shown, /Verified exactly 10 Boston records/);
  assert.doesNotMatch(shown, /Neumann Law Group/);
  assert.doesNotMatch(shown, /read-back returned all 10/);
  assert.ok(!/^\s*(summary|reply|done|nextAction|reason)\s*:/m.test(shown), 'no field labels remain');

  const decision = toOrchestratorDecision(success);
  assert.equal(decision?.done, true);
  assert.equal(decision?.nextAction, 'completed');
  assert.equal(decision?.reply, shown);
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

test('a partial envelope with no explicit reply fails closed at the public boundary', () => {
  const partial = [
    'summary: something happened',
    'done: true',
    'nextAction: keep going',
  ].join('\n');
  assert.equal(publicReplyFromNarratedEnvelope(partial), null);
  assert.equal(stripNarratedEnvelope(partial), '');
  assert.equal(toOrchestratorDecision(partial), null);
});

test('two-field envelopes containing reply are still contract narration', () => {
  const summaryReply = [
    'summary: Asked the user which account to use.',
    'reply: Which account should I use?',
  ].join('\n');
  assert.ok(parseNarratedEnvelope(summaryReply));
  assert.equal(publicReplyFromNarratedEnvelope(summaryReply), 'Which account should I use?');
  assert.equal(stripNarratedEnvelope(summaryReply), 'Which account should I use?');

  const replyDone = [
    'reply: The report is ready.',
    'done: Verified the internal delivery ledger.',
  ].join('\n');
  assert.ok(parseNarratedEnvelope(replyDone));
  assert.equal(stripNarratedEnvelope(replyDone), 'The report is ready.');
});

test('markdown-decorated envelope lines are still caught', () => {
  const decorated = [
    '- summary: scoped the project',
    '- reply: I pulled 10 firms and put them in the base.',
    '- done: base created',
    '- nextAction: enrich contacts',
  ].join('\n');
  assert.match(stripNarratedEnvelope(decorated), /I pulled 10 firms/);
  assert.doesNotMatch(stripNarratedEnvelope(decorated), /scoped the project/);
  assert.doesNotMatch(stripNarratedEnvelope(decorated), /base created/);
  assert.ok(!stripNarratedEnvelope(decorated).includes('nextAction:'));
});
