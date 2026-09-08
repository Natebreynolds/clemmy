import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileProofProviderArgs,
  createProofProviderForegroundPayloadValidator,
  validateProofProviderArguments,
} from './proof-provider-args.js';

// The actor identifier and input shape reproduce the captured provider contract;
// no network, owner home, credentials or live actor invocation is involved.
const actorSchema = {
  type: 'object', additionalProperties: true, required: ['actorId'],
  properties: {
    actorId: { type: 'string' },
    input: { type: 'object', additionalProperties: true, default: {} },
    limit: { type: 'integer' }, format: { type: 'string', enum: ['json', 'csv'] },
  },
};
const actorArgs = {
  actorId: 'apify/facebook-posts-scraper',
  input: { startUrls: [{ url: 'https://www.facebook.com/scorpion.co' }], resultsLimit: 25 },
  limit: 25, format: 'json',
};

test('a provider-declared open actor input reaches the sealed compiler unchanged', () => {
  const check = createProofProviderForegroundPayloadValidator({ operationId: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', schema: actorSchema })!;
  assert.deepEqual(check(actorArgs), { ok: true });
  const compiled = compileProofProviderArgs({ schema: actorSchema, payload: actorArgs,
    role: 'foreground', effect: 'read', acceptAuthorityBoundPayload: true,
    authorityBoundPayloadKind: 'provider_arguments' });
  assert.deepEqual(compiled, actorArgs);
  assert.notEqual(compiled, actorArgs);
  assert.notEqual(compiled!.input, actorArgs.input);
  assert.equal(validateProofProviderArguments({ schema: actorSchema, payload: { ...actorArgs, input: {} } }).ok, true,
    'the provider contract does not declare actor-specific required fields; host must not invent them');
});

test('open data preserves named type and required constraints', () => {
  const bad = validateProofProviderArguments({ schema: actorSchema, payload: { ...actorArgs, actorId: 4, format: 'invalid' } });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.failingPaths, ['/actorId', '/format']);
  assert.equal(validateProofProviderArguments({ schema: actorSchema, payload: { input: actorArgs.input } }).ok, false);
});

test('open input cannot open a closed sibling or a closed empty object', () => {
  const schema = { ...actorSchema, additionalProperties: false,
    properties: { ...actorSchema.properties, exact: { type: 'object', additionalProperties: false } } };
  const bad = validateProofProviderArguments({ schema, payload: { ...actorArgs, extra: 1, exact: { extra: 2 } } });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.failingPaths, ['/exact/extra', '/extra']);
});

test('schema-constrained extension maps validate their values and name the bad member', () => {
  const schema = { type: 'object', additionalProperties: {
    type: 'object', additionalProperties: false, required: ['count'], properties: { count: { type: 'integer' } },
  } };
  assert.equal(validateProofProviderArguments({ schema, payload: { north: { count: 3 } } }).ok, true);
  const bad = validateProofProviderArguments({ schema, payload: { south: { count: 'three' } } });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.deepEqual(bad.failingPaths, ['/south/count']);
    assert.deepEqual(bad.unknownFields, []);
    assert.deepEqual(bad.invalidFields, ['south']);
  }
});

test('patterned and named constraints both apply, and unmatched closed keys stay closed', () => {
  const schema = { type: 'object', additionalProperties: false,
    properties: { n_fixed: { type: 'integer' } }, patternProperties: { '^n_': { type: 'number' } } };
  assert.equal(validateProofProviderArguments({ schema, payload: { n_fixed: 1, n_other: 2.5 } }).ok, true);
  for (const payload of [{ n_fixed: 1.5 }, { n_other: '2' }, { other: 3 }]) {
    assert.equal(validateProofProviderArguments({ schema, payload }).ok, false);
  }
});

test('provider-data support does not opt an unsealed caller into payload passthrough', () => {
  const compiled = compileProofProviderArgs({ schema: actorSchema, payload: actorArgs, role: 'foreground', effect: 'read' });
  assert.equal(compiled, null);
});
