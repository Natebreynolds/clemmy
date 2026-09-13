import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePlanArgumentPreparation } from './plan-argument-preparation.js';
const schema = { type: 'object', properties: { subject: { type: 'string' }, destination: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }, required: ['subject', 'destination'] };
const binding = { producerStepId: 'lookup', outputPath: '/data/id', targetPath: '/destination/id', expectedType: 'string' as const };
const input = { schema, staticArguments: { subject: 'Known exact subject', destination: {} }, dynamicBindings: [binding] };
test('declared dynamic value is checked against exact input schema without fabricating it', () => {
  assert.doesNotThrow(() => validatePlanArgumentPreparation(input));
  assert.doesNotThrow(() => validatePlanArgumentPreparation({ ...input, localIssues: [{ path: ['destination', 'id'], code: 'invalid_type' }] }));
  assert.deepEqual(input.staticArguments.destination, {});
});
test('unknown targets, mismatched types, static conflicts and invalid known values are not ready', () => {
  assert.throws(() => validatePlanArgumentPreparation({ ...input, dynamicBindings: [{ ...binding, targetPath: '/destination/guessed' }] }), /discovered schema/);
  assert.throws(() => validatePlanArgumentPreparation({ ...input, dynamicBindings: [{ ...binding, expectedType: 'number' }] }), /declared type/);
  assert.throws(() => validatePlanArgumentPreparation({ ...input, dynamicBindings: [binding, binding] }), /unique/);
  assert.throws(() => validatePlanArgumentPreparation({ ...input, staticArguments: { subject: 'x', destination: { id: 'guessed' } } }), /both static/);
  assert.throws(() => validatePlanArgumentPreparation({ ...input, staticArguments: { subject: 3, destination: {} } }), /Static provider/);
  assert.throws(() => validatePlanArgumentPreparation({ ...input, localIssues: [{ path: ['subject'], code: 'invalid_type' }] }), /Static native/);
  assert.throws(() => validatePlanArgumentPreparation({ ...input, staticArguments: { subject: 'x' } }), /parent/);
});
test('bounded diagnostics cannot conceal a known-field failure behind many missing bindings', () => {
  const count = 100;
  const required = Array.from({ length: count }, (_, i) => `id${i}`);
  const properties = Object.fromEntries([...required.map(key => [key, { type: 'string' }]), ['known', { type: 'string' }]]);
  assert.throws(() => validatePlanArgumentPreparation({ schema: { type: 'object', required, properties }, staticArguments: { known: 5 }, dynamicBindings: required.map(key => ({ ...binding, targetPath: `/${key}` })) }), /Static provider/);
});
test('preparation diagnostics identify the missing container, bound leaf and unrelated invalid field without exposing argument values', () => {
  assert.throws(() => validatePlanArgumentPreparation({ ...input, staticArguments: { subject: 'x' } }), /parent \/destination.*omit only the bound leaf \/destination\/id/);
  assert.throws(() => validatePlanArgumentPreparation({ ...input, staticArguments: { subject: 'x', destination: { id: 'private-value' } } }), error => {
    assert.match(String(error), /both static.*\/destination\/id/);
    assert.doesNotMatch(String(error), /private-value/);
    return true;
  });
  assert.throws(() => validatePlanArgumentPreparation({ ...input, staticArguments: { subject: { private: 'secret' }, destination: {} } }), error => {
    assert.match(String(error), /"path":"\/subject","code":"type_mismatch"/);
    assert.doesNotMatch(String(error), /private|secret/);
    return true;
  });
});
test('malformed pointers and inherited schema fields cannot identify prepared inputs', () => {
  assert.throws(() => validatePlanArgumentPreparation({ ...input, dynamicBindings: [{ ...binding, targetPath: '/destination/~9id' }] }), /exact JSON pointer/);
  assert.throws(() => validatePlanArgumentPreparation({ ...input, dynamicBindings: [{ ...binding, outputPath: '/__proto__/id' }] }), /unsafe/);
  assert.throws(() => validatePlanArgumentPreparation({ ...input, dynamicBindings: [{ ...binding, targetPath: '/constructor' }] }), /unsafe/);
});

test('whole future results can bind declared open JSON data without guessing their wrapper or type', () => {
  const binding = { producerStepId: 'research', outputPath: '', targetPath: '/data' };
  assert.doesNotThrow(() => validatePlanArgumentPreparation({ schema: { type: 'object', properties: { data: { description: 'JSON body' } }, required: ['data'] }, staticArguments: {}, dynamicBindings: [binding] }));
  assert.equal((binding as any).expectedType, 'json');
});


test('result bindings prepare nested array elements and open Actor input without guessing URLs', async () => {
  const { bindReviewedCollectionItem } = await import('../runtime/harness/reviewed-plan-collection.js');
  const { resolveReviewedStepArguments } = await import('../runtime/harness/reviewed-plan-bindings.js');
  const dynamic = { producerStepId: 'search', outputPath: '/result/url', targetPath: '/input/startUrls/0/url', expectedType: 'string' as const };
  const schema = { type: 'object', properties: { input: { type: 'object', additionalProperties: true } }, required: ['input'] };
  const staticArguments = { input: { startUrls: [{}] } };
  assert.doesNotThrow(() => validatePlanArgumentPreparation({ schema, staticArguments, dynamicBindings: [dynamic] }));
  const source = { memberId: 'vendor-a', result: { url: 'https://fixture.example/discovered-page' } };
  const collection = { producerStepId: 'search', memberIdPath: '/memberId', bindings: [{ itemPath: '/result/url', targetPath: dynamic.targetPath }] };
  const expected = { input: { startUrls: [{ url: source.result.url }] } };
  assert.deepEqual(bindReviewedCollectionItem(staticArguments, collection, source), expected);
  assert.deepEqual(resolveReviewedStepArguments({ staticArguments, dependsOn: ['search'], dynamicBindings: [dynamic] }, () => source), expected);
  assert.deepEqual(staticArguments, { input: { startUrls: [{}] } });
  const strictSchema = { type: 'object', properties: { input: { type: 'object', properties: { startUrls: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } }, required: ['startUrls'] } } };
  assert.doesNotThrow(() => validatePlanArgumentPreparation({ schema: strictSchema, staticArguments, dynamicBindings: [dynamic] }));
  assert.throws(() => validatePlanArgumentPreparation({ schema: strictSchema, staticArguments, dynamicBindings: [{ ...dynamic, expectedType: 'number' }] }), /schema|type/);
  assert.throws(() => bindReviewedCollectionItem(expected, collection, source), /static/);
});
