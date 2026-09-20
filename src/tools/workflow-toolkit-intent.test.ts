import test from 'node:test';
import assert from 'node:assert/strict';
import { requestsToolkitUse } from './workflow-toolkit-intent.js';

test('upstream reporting and source labels do not request new provider calls', () => {
  assert.equal(requestsToolkitUse('Join selected firms with crawled pages. Review source is always "Google Business listing via DataForSEO".', 'DataForSEO'), false);
  assert.equal(requestsToolkitUse('Produce the final coverage report from upstream results only. State DataForSEO tasks used, Apify run id / dataset id, pages crawled and shortfalls.', 'Apify'), false);
  assert.equal(requestsToolkitUse('Describe the Apify actor and API response already supplied.', 'Apify'), false);
});

test('explicit toolkit instructions still qualify for binding', () => {
  for (const prompt of ['Use the Apify scraper to pull data.', 'Prefer a reliable Apify public Facebook page/posts scraper.', 'Run the Apify actor.']) {
    assert.equal(requestsToolkitUse(prompt, 'Apify'), true, prompt);
  }
  assert.equal(requestsToolkitUse('Use the Salesforce connector to pull open opportunities.', 'Salesforce'), true);
});
