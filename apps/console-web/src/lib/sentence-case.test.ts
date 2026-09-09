import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentence } from './sentence-case';

test('an enum value becomes a readable label', () => {
  // The exact values that were being rendered through `uppercase`: a JSON-patch
  // op in the workspace diff, and a meeting platform id.
  assert.equal(sentence('add'), 'Add');
  assert.equal(sentence('replace'), 'Replace');
  assert.equal(sentence('zoom'), 'Zoom');
});

test('underscores and dashes are word breaks, not characters', () => {
  assert.equal(sentence('google_meet'), 'Google meet');
  assert.equal(sentence('awaiting-approval'), 'Awaiting approval');
  assert.equal(sentence('external_send'), 'External send');
});

test('sentence case, not Title Case — only the first word rises', () => {
  assert.equal(sentence('awaiting approval'), 'Awaiting approval');
  assert.notEqual(sentence('awaiting approval'), 'Awaiting Approval');
});

test('a shouted word is un-shouted', () => {
  // Styling expressed in the data. Removing `uppercase` from the class must not
  // leave "FAILED" shouting from the string instead.
  assert.equal(sentence('FAILED'), 'Failed');
  assert.equal(sentence('AWAITING_APPROVAL'), 'Awaiting approval');
});

test('a short all-caps token is an acronym and survives intact', () => {
  assert.equal(sentence('API'), 'API');
  assert.equal(sentence('MCP server'), 'MCP server');
  assert.equal(sentence('sf CLI'), 'Sf CLI');
});

test('blank in, blank out — never "Undefined"', () => {
  assert.equal(sentence(''), '');
  assert.equal(sentence('   '), '');
  assert.equal(sentence('___'), '');
});

test('an already-correct label is left exactly as it is', () => {
  assert.equal(sentence('Awaiting approval'), 'Awaiting approval');
  assert.equal(sentence('Workflow'), 'Workflow');
});
