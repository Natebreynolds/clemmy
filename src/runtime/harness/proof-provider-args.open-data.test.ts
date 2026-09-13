import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileProofProviderArgs,
  createProofProviderForegroundPayloadValidator,
  validateProofProviderArguments,
  collectProviderSchemaFailures,
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

test('an explicitly nullable integer accepts null through matching and failure projection', () => {
  const schema = { type: 'object', additionalProperties: false, properties: { count: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } };
  for (const count of [null, 12]) assert.equal(validateProofProviderArguments({ schema, payload: { count } }).ok, true);
  for (const count of ['12', 1.5, {}]) assert.equal(validateProofProviderArguments({ schema, payload: { count } }).ok, false);
  assert.equal(validateProofProviderArguments({ schema: { ...schema, properties: { count: { type: 'integer' } } }, payload: { count: null } }).ok, false);
});

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

test('annotations on declared open JSON data cannot change object or array admission', () => {
  const annotations = { description: 'JSON request body', title: 'Body', default: {}, examples: [{}], deprecated: false };
  for (const value of [{ tasks: [{ term: 'fixture' }] }, [{ term: 'fixture' }], 'literal', 3, false, null]) {
    const schema = { type: 'object', additionalProperties: false, required: ['method'], properties: {
      method: { type: 'string', enum: ['POST'] }, data: annotations,
      items: { type: 'array', items: annotations },
    } };
    const payload = { method: 'POST', data: value, items: [value] };
    const result = validateProofProviderArguments({ schema, payload });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.deepEqual(result.args, payload);
    const failures: Parameters<typeof collectProviderSchemaFailures>[3] = [];
    collectProviderSchemaFailures(payload, schema, '', failures);
    assert.deepEqual(failures, []);
    assert.equal(validateProofProviderArguments({ schema, payload: { ...payload, method: 'DELETE' } }).ok, false);
    assert.equal(validateProofProviderArguments({ schema, payload: { ...payload, operation: 'other' } }).ok, false);
  }
});

test('annotations do not erase constraints or admit non-JSON data', () => {
  const schema = (data: unknown) => ({ type: 'object', properties: { data } });
  for (const data of [undefined, Infinity, () => 1, { nested: undefined }]) {
    assert.equal(validateProofProviderArguments({ schema: schema({ description: 'Open data' }), payload: { data } }).ok, false);
  }
  for (const constraint of [{ type: 'string' }, { $ref: '#/$defs/unknown' }, { not: {} }]) {
    assert.equal(validateProofProviderArguments({ schema: schema({ description: 'A description', ...constraint }), payload: { data: {} } }).ok, false);
  }
});
