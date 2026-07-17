import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyComposioSlugEffect } from './slug-effect.js';

test('provider-side research jobs remain reads', () => {
  for (const slug of [
    'DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST',
    'DATAFORSEO_GET_SERP_GOOGLE_ORGANIC_TASK_ADVANCED_BY_ID',
    'FIRECRAWL_SCRAPE',
    'FIRECRAWL_BATCH_SCRAPE',
    'FIRECRAWL_SEARCH_WEB',
    'FIRECRAWL_CRAWL_URLS',
  ]) {
    assert.equal(classifyComposioSlugEffect(slug), 'read', slug);
  }
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
