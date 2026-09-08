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
test('malformed pointers and inherited schema fields cannot identify prepared inputs', () => {
  assert.throws(() => validatePlanArgumentPreparation({ ...input, dynamicBindings: [{ ...binding, targetPath: '/destination/~9id' }] }), /exact JSON pointer/);
  assert.throws(() => validatePlanArgumentPreparation({ ...input, dynamicBindings: [{ ...binding, outputPath: '/__proto__/id' }] }), /unsafe/);
  assert.throws(() => validatePlanArgumentPreparation({ ...input, dynamicBindings: [{ ...binding, targetPath: '/constructor' }] }), /unsafe/);
});
