import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyComposioActionConsequence,
  classifyComposioSlugEffect,
  composioActionIsEphemeralCompute,
  composioSlugEffectEvidence,
} from './slug-effect.js';

test('provider-side research jobs remain reads', () => {
  for (const slug of [
    'DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST',
    'DATAFORSEO_GET_SERP_GOOGLE_ORGANIC_TASK_ADVANCED_BY_ID',
    'DATAFORSEO_SERP_GOOGLE_ORGANIC_TASKS_READY',
    'DATAFORSEO_SERP_GOOGLE_ORGANIC_LIVE_ADVANCED',
    'DATAFORSEO_LABS_GOOGLE_KEYWORDS_FOR_SITE',
    'DATAFORSEO_BACKLINKS_SUMMARY_LIVE',
    'FIRECRAWL_SCRAPE',
    'FIRECRAWL_BATCH_SCRAPE',
    'FIRECRAWL_SEARCH_WEB',
    'FIRECRAWL_CRAWL_URLS',
  ]) {
    assert.equal(classifyComposioSlugEffect(slug), 'read', slug);
  }
});

test('DataForSEO family membership never exempts mutations or unfamiliar actions', () => {
  for (const slug of [
    'DATAFORSEO_SET_CREDENTIALS',
    'DATAFORSEO_ENABLE_WEBHOOK',
    'DATAFORSEO_ARCHIVE_REPORT',
    'DATAFORSEO_SERP_SET_WEBHOOK',
  ]) {
    assert.equal(composioSlugEffectEvidence(slug), 'write', slug);
    assert.equal(classifyComposioSlugEffect(slug), 'external_write', slug);
  }
  assert.equal(composioSlugEffectEvidence('DATAFORSEO_ACCOUNT_SNAPSHOT'), 'unknown');
  assert.equal(classifyComposioSlugEffect('DATAFORSEO_ACCOUNT_SNAPSHOT'), 'external_write');
  assert.equal(composioSlugEffectEvidence('DATAFORSEO_ACCOUNT_SERP_SNAPSHOT'), 'unknown');
  assert.equal(classifyComposioSlugEffect('DATAFORSEO_ACCOUNT_SERP_SNAPSHOT'), 'external_write');
});

test('Firecrawl read-job family membership never exempts an explicit mutation', () => {
  for (const slug of [
    'FIRECRAWL_SCRAPE_AND_PUBLISH',
    'FIRECRAWL_CRAWL_AND_DELETE',
    'FIRECRAWL_MAP_AND_SAVE',
    'FIRECRAWL_SEARCH_AND_SEND',
  ]) {
    assert.equal(composioSlugEffectEvidence(slug), 'write', slug);
    assert.equal(classifyComposioSlugEffect(slug), 'external_write', slug);
  }
});

test('evidence grade: pure noun endpoints are unknown; verb slugs are affirmative', () => {
  // Pure noun endpoints carry NO action verb — genuinely unknown, so a caller's
  // declared sideEffect is the best signal (an existing declared-read workflow
  // must keep validating). classifyComposioSlugEffect stays conservative here.
  for (const slug of ['SLACK_CONVERSATIONS_HISTORY', 'TWITTER_USER_TIMELINE', 'GMAIL_USERS_MESSAGES', 'ACME_DO_THING']) {
    assert.equal(composioSlugEffectEvidence(slug), 'unknown', slug);
    assert.equal(classifyComposioSlugEffect(slug), 'external_write', slug);
  }
  // A read token in a trailing STATE position is a mutation signal, NOT unknown
  // — a mislabeled sideEffect:read must never downgrade these.
  for (const slug of ['GMAIL_MARK_AS_READ', 'SLACK_MARK_CHANNEL_READ', 'SOMETOOL_RUN_CHECK']) {
    assert.equal(composioSlugEffectEvidence(slug), 'write', slug);
  }
  assert.equal(composioSlugEffectEvidence('GMAIL_SEND_EMAIL'), 'write');
  assert.equal(composioSlugEffectEvidence('TWITTER_GET_POST'), 'read');
  assert.equal(composioSlugEffectEvidence(''), 'unknown');
});

test('write tokens win over read tokens and unknown slugs stay conservative', () => {
  for (const slug of [
    'HUBSPOT_FIND_OR_CREATE_CONTACT',
    'AIRTABLE_SEARCH_AND_UPDATE_RECORD',
    'GMAIL_SEND_EMAIL',
    'ACME_DO_THING',
    '',
  ]) {
    assert.equal(classifyComposioSlugEffect(slug), 'external_write', slug || '(missing)');
  }
});

test('ordinary lookup and batch-get slugs are reads', () => {
  for (const slug of [
    'OUTLOOK_LIST_MESSAGES',
    'GOOGLESHEETS_BATCH_GET',
    'SALESFORCE_DESCRIBE_OBJECT',
    'GONG_GET_CALL_TRANSCRIPT',
    'VAPI_RETRIEVE_CALL',
    'TWILIO_LIST_CALLS',
  ]) {
    assert.equal(classifyComposioSlugEffect(slug), 'read', slug);
  }
});

test('CALL is only a read noun when no other mutation action is present', () => {
  for (const slug of [
    'VAPI_CREATE_CALL',
    'TWILIO_MAKE_OUTBOUND_CALL',
    'GONG_GET_CALL_AND_UPDATE_CONTACT',
    'ACME_FIND_OR_CREATE_CALL',
  ]) {
    assert.equal(classifyComposioSlugEffect(slug), 'external_write', slug);
  }
});

test('fold #3: unknown-verb mutations with a trailing read STATE word never classify read', () => {
  // MARK/FLAG/PIN-style verbs are not in the write list; the trailing READ is a
  // state noun, not the action — these must stay conservative writes.
  for (const slug of [
    'GMAIL_MARK_AS_READ',
    'SLACK_MARK_CHANNEL_READ',
    'ACME_SET_TO_PREVIEW',
    'SOMETOOL_RUN_CHECK',
  ]) {
    assert.equal(classifyComposioSlugEffect(slug), 'external_write', slug);
  }
});

test('fold #5: POST as the OBJECT of a read verb classifies read; bare POST actions stay writes', () => {
  for (const slug of ['TWITTER_GET_POST', 'REDDIT_GET_POST_COMMENTS', 'LINKEDIN_GET_POSTS']) {
    assert.equal(classifyComposioSlugEffect(slug), 'read', slug);
  }
  for (const slug of ['TWITTER_POST', 'TWITTER_CREATE_POST', 'LINKEDIN_POST_UPDATE']) {
    assert.equal(classifyComposioSlugEffect(slug), 'external_write', slug);
  }
});

test('trailing pure read VERBS still classify read (search/fetch/get suffixes)', () => {
  for (const slug of ['GMAIL_SEARCH', 'NOTION_GET', 'LINEAR_LIST', 'WEB_FETCH']) {
    assert.equal(classifyComposioSlugEffect(slug), 'read', slug);
  }
});

// Ephemeral-compute rule (live 2026-07-24): OPENAI_CREATE_CHAT_COMPLETION was
// classified a mutating external write ("CREATE" prefix), dragging the
// execution-wrap ceremony onto every inference batch through the Composio
// OpenAI lane. Creating a completion/embedding creates no durable state.
test('CREATE + compute noun is a read; durable creations stay writes', async () => {
  const { composioSlugEffectEvidence } = await import('./slug-effect.js');
  assert.equal(composioSlugEffectEvidence('OPENAI_CREATE_CHAT_COMPLETION'), 'read');
  assert.equal(composioSlugEffectEvidence('OPENAI_CREATE_EMBEDDING'), 'read');
  assert.equal(composioSlugEffectEvidence('OPENAI_CREATE_MODERATION'), 'read');
  assert.equal(composioActionIsEphemeralCompute('OPENAI_CREATE_CHAT_COMPLETION'), true);
  assert.equal(composioActionIsEphemeralCompute('OPENAI_RUN_TRANSCRIPTION'), true);
  // Durable creations are still writes, full stop.
  assert.equal(composioSlugEffectEvidence('GMAIL_CREATE_DRAFT'), 'write');
  assert.equal(composioActionIsEphemeralCompute('GMAIL_CREATE_DRAFT'), false);
  assert.equal(composioSlugEffectEvidence('GOOGLESHEETS_CREATE_GOOGLE_SHEET1'), 'write');
  assert.equal(composioSlugEffectEvidence('OUTLOOK_CREATE_EVENT'), 'write');
});

test('consequence is derived from the action\'s own verb — invented tools, randomized names', () => {
  // RANDOMIZED so no slug list, provider name, or incident-specific rule can
  // pass this. The verbs are the only thing carrying meaning.
  const nonce = Math.random().toString(36).slice(2, 8).toUpperCase();
  const app = `ZZ${nonce}`;
  const noun = `WIDGET${nonce}`;

  assert.equal(classifyComposioActionConsequence(`${app}_CREATE_${noun}`), 'create');
  assert.equal(classifyComposioActionConsequence(`${app}_UPDATE_${noun}`), 'update');
  assert.equal(classifyComposioActionConsequence(`${app}_DELETE_${noun}`), 'delete');
  assert.equal(classifyComposioActionConsequence(`${app}_SEND_${noun}`), 'send');
  assert.equal(classifyComposioActionConsequence(`${app}_LIST_${noun}`), 'read');

  // The distinction that matters: create and update are BOTH writes, and are
  // not interchangeable outcomes. A caller offered the wrong one is being
  // offered a materially different result.
  assert.notEqual(
    classifyComposioActionConsequence(`${app}_CREATE_${noun}`),
    classifyComposioActionConsequence(`${app}_UPDATE_${noun}`),
    'create and update must be distinguishable consequences',
  );

  // Most consequential declared verb wins when a slug names several.
  assert.equal(classifyComposioActionConsequence(`${app}_CREATE_OR_DELETE_${noun}`), 'delete');

  // An unrecognised verb is not guessed into a class.
  assert.equal(classifyComposioActionConsequence(`${app}_FLURBLE_${noun}`), 'other');
  assert.equal(classifyComposioActionConsequence(''), 'other');
  assert.equal(classifyComposioActionConsequence(null), 'other');
});
