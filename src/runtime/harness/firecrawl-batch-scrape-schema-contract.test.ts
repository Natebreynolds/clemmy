import assert from 'node:assert/strict';
import test from 'node:test';

import { firecrawlBatchScrapeSchemasMatchV20260826 } from './firecrawl-batch-scrape-schema-contract.js';

const startInput = {
  type: 'object', required: ['urls'], properties: {
    urls: { type: 'array', minItems: 1, items: { type: 'string' } },
    formats: { type: 'array', items: { enum: ['markdown', 'html', 'rawHtml'] } },
  },
};
const startOutput = { type: 'object', properties: {
  success: { type: 'boolean' }, id: { type: 'string' }, url: { type: 'string' },
} };
const getterInput = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
const getterOutput = { type: 'object', properties: {
  status: { type: 'string' }, total: { type: 'number' }, completed: { type: 'number' },
  creditsUsed: { type: 'number' }, expiresAt: { type: 'string' },
  data: { type: 'array', items: { type: 'object', properties: {
    rawHtml: { type: 'string' }, metadata: { type: 'object', additionalProperties: true },
  } } },
} };

test('exact current batch start/get semantic schema pair is recognized', () => {
  assert.equal(firecrawlBatchScrapeSchemasMatchV20260826({
    startInput, startOutput, getterInput, getterOutput,
  }), true);
});

test('schema lookalikes cannot inherit the batch continuation pointers', () => {
  for (const changed of [
    { startInput: { ...startInput, required: [] }, startOutput, getterInput, getterOutput },
    { startInput, startOutput: { ...startOutput, properties: { ...startOutput.properties, id: { type: 'number' } } }, getterInput, getterOutput },
    { startInput, startOutput, getterInput: { ...getterInput, required: ['id', 'account'] }, getterOutput },
    { startInput, startOutput, getterInput, getterOutput: { ...getterOutput, properties: { ...getterOutput.properties, data: { type: 'array', items: { type: 'object', properties: { html: { type: 'string' }, metadata: { type: 'object' } } } } } } },
  ]) assert.equal(firecrawlBatchScrapeSchemasMatchV20260826(changed), false);
});
