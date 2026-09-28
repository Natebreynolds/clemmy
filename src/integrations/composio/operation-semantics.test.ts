import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentedComposioManifestOperationSemantics, validatedDocumentedComposioDefinitionContracts } from './operation-semantics.js';
import { classifyComposioActionConsequence, classifyComposioSlugEffect } from './slug-effect.js';

const inputSchema = { type: 'object', properties: {
  channel: { type: 'string' }, users: { type: 'string' },
  prevent_creation: { type: 'boolean' }, return_im: { type: 'boolean' },
} };
const contract = (schema: unknown, operationId = 'SLACK_OPEN_DM') => validatedDocumentedComposioDefinitionContracts({ operationId, inputSchema: schema, outputSchema: null });

test('documented conversation preparation stays a provider write but is not message delivery', () => {
  assert.equal(classifyComposioSlugEffect('SLACK_OPEN_DM'), 'external_write');
  assert.equal(classifyComposioActionConsequence('SLACK_OPEN_DM'), 'create');
  assert.deepEqual(contract(inputSchema), { ok: true, verificationContract: null,
    operationSemantics: { version: 1, reversibility: 'ordinary_non_destructive' } });
  assert.equal(classifyComposioActionConsequence('SLACK_SEND_MESSAGE'), 'send');
  assert.equal(documentedComposioManifestOperationSemantics('SLACK_SEND_MESSAGE'), null);
  assert.equal(documentedComposioManifestOperationSemantics('SLACK_OPEN_DM_AND_SEND'), null);
});

test('provider schema additions, missing fields, changed types and conditional definitions invalidate the preparation contract', () => {
  const { channel: _, ...missing } = inputSchema.properties;
  for (const schema of [
    { ...inputSchema, properties: { ...inputSchema.properties, text: { type: 'string' } } },
    { ...inputSchema, properties: missing },
    { ...inputSchema, properties: { ...inputSchema.properties, users: { type: 'array' } } },
    { ...inputSchema, allOf: [{ properties: { notify: { const: true } } }] },
    { ...inputSchema, additionalProperties: true },
    { ...inputSchema, required: ['message'] },
  ]) assert.deepEqual(contract(schema), { ok: false });
});
