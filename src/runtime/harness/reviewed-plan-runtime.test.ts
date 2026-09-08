import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveReviewedStepArguments } from './reviewed-plan-runtime.js';
const step = { staticArguments: { subject: 'Reviewed exact LF\nsubject', nested: {} }, dependsOn: ['read'], dynamicBindings: [{ producerStepId: 'read', outputPath: '/data/id', targetPath: '/nested/id', expectedType: 'string' }] };
test('dynamic reviewed argument resolves exact durable producer path with static bytes unchanged', () => {
  const calls: string[] = [];
  assert.deepEqual(resolveReviewedStepArguments(step, id => { calls.push(id); return { data: { id: 'provider-exact-id' } }; }), { subject: step.staticArguments.subject, nested: { id: 'provider-exact-id' } });
  assert.deepEqual(calls, ['read']);
});
test('missing producer fields, wrong types, absent dependencies and static overrides refuse without guessing', () => {
  assert.throws(() => resolveReviewedStepArguments(step, () => ({ data: {} })), /did not return/);
  assert.throws(() => resolveReviewedStepArguments(step, () => ({ data: Object.create({ id: 'inherited-id' }) })), /did not return/);
  assert.throws(() => resolveReviewedStepArguments(step, () => ({ data: { id: 42 } })), /type/);
  assert.throws(() => resolveReviewedStepArguments({ ...step, dependsOn: [] }, () => ({})), /malformed/);
  assert.throws(() => resolveReviewedStepArguments({ ...step, staticArguments: { nested: { id: 'override' } } }, () => ({ data: { id: 'actual' } })), /both a static/);
  assert.throws(() => resolveReviewedStepArguments({ ...step, dynamicBindings: [...step.dynamicBindings, ...step.dynamicBindings] }, () => ({ data: { id: 'actual' } })), /ambiguous/);
});

test('reviewed native artifact arguments retain full bytes above the generic64KB limit', () => {
  const content = 'Exact reviewed native HTML content.\n'.repeat(2_500);
  assert.ok(Buffer.byteLength(content) > 75_000);
  assert.equal(resolveReviewedStepArguments({ staticArguments: { view_html: content }, dependsOn: [], dynamicBindings: [] }, () => { throw new Error('no producer required'); }).view_html, content);
});
