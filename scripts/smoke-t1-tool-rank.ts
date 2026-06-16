/**
 * smoke-t1-tool-rank.ts — live verification of the T1 semantic tool ranker
 * against the REAL OpenAI embedding model (no daemon needed).
 *
 *   npx tsx scripts/smoke-t1-tool-rank.ts
 *
 * Proves rankToolsBySemantic() surfaces the RELEVANT tools for a query — the
 * core mechanism that turns the fail-open "arbitrary N" into "the N most
 * relevant N". Uses the daemon's real config (CLEMENTINE_HOME) so the OpenAI
 * key resolves exactly as in production.
 */
import { rankToolsBySemantic, _resetToolRankCachesForTest } from '../src/runtime/mcp-tool-rank.js';
import { isEmbeddingsEnabled } from '../src/memory/embeddings.js';

const tool = (name: string, description: string): any => ({ name, description, inputSchema: { type: 'object' } });

// A realistic, multi-domain fail-open universe (the kind that balloons past the
// 12-tool cap with no keyword family to narrow it).
const UNIVERSE = [
  tool('airtable__create_record', 'Create a new record (row) in an Airtable base table'),
  tool('airtable__list_records', 'List records from an Airtable base table'),
  tool('slack__post_message', 'Post a message to a Slack channel'),
  tool('slack__list_channels', 'List the Slack channels in the workspace'),
  tool('github__create_issue', 'Open a new issue in a GitHub repository'),
  tool('github__list_prs', 'List open pull requests in a GitHub repository'),
  tool('dataforseo__backlinks_summary', 'Get a backlinks summary (referring domains, anchors) for a domain'),
  tool('dataforseo__keyword_rankings', 'Get organic keyword rankings for a domain'),
  tool('gcal__create_event', 'Create an event on the user Google Calendar'),
  tool('gcal__list_events', 'List upcoming Google Calendar events'),
  tool('gmail__send_email', 'Send an email through Gmail'),
  tool('notion__create_page', 'Create a new page in Notion'),
  tool('stripe__create_invoice', 'Create and send a Stripe invoice'),
  tool('twilio__send_sms', 'Send an SMS text message via Twilio'),
];

let pass = 0, fail = 0;
const ok = (m: string) => { console.log(`   \x1b[32m✓\x1b[0m ${m}`); pass++; };
const no = (m: string, d = '') => { console.log(`   \x1b[31m✗\x1b[0m ${m}${d ? ' — ' + d : ''}`); fail++; };

function topN(scores: Map<string, number>, n: number): string[] {
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

async function check(query: string, expectTop: string[], label: string) {
  _resetToolRankCachesForTest();
  const scores = await rankToolsBySemantic(query, UNIVERSE);
  if (!scores) { no(label, 'ranker returned undefined (embeddings unavailable?)'); return; }
  const top = topN(scores, expectTop.length);
  const hit = expectTop.every((t) => top.includes(t));
  if (hit) ok(`${label} → top-${expectTop.length}: ${top.join(', ')}`);
  else no(label, `expected ${expectTop.join('+')} in top-${expectTop.length}, got ${top.join(', ')}`);
}

console.log('\n\x1b[1m== T1 semantic tool-rank smoke (real embeddings) ==\x1b[0m');

if (!isEmbeddingsEnabled()) {
  console.log('   \x1b[31m✗\x1b[0m embeddings not enabled in this env (need OPENAI_API_KEY) — cannot verify ranking');
  process.exit(1);
}
ok('embeddings enabled (real model)');

// Each query should surface its domain's tools above the 12 unrelated ones.
await check('add a new row to my Airtable base and post an update in Slack',
  ['airtable__create_record', 'slack__post_message'], 'airtable + slack intent');
await check('check the backlinks and keyword rankings for my website',
  ['dataforseo__backlinks_summary', 'dataforseo__keyword_rankings'], 'SEO/dataforseo intent');
await check('schedule a meeting on my calendar for tomorrow',
  ['gcal__create_event', 'gcal__list_events'], 'calendar intent (domain surfaced)');
await check('text the customer their appointment reminder',
  ['twilio__send_sms'], 'SMS intent');

// Negative-relevance sanity: an unrelated tool should NOT crowd the top.
_resetToolRankCachesForTest();
const seoScores = await rankToolsBySemantic('check the backlinks for my website', UNIVERSE);
if (seoScores) {
  const top4 = topN(seoScores, 4);
  if (!top4.includes('twilio__send_sms') && !top4.includes('stripe__create_invoice'))
    ok('unrelated tools (twilio/stripe) stay out of the top-4 for an SEO query');
  else no('relevance separation', `top-4: ${top4.join(', ')}`);
}

console.log(`\n\x1b[1m== ${pass} passed, ${fail} failed ==\x1b[0m\n`);
process.exit(fail ? 1 : 0);
