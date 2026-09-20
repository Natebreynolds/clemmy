import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectToolChoicesForContext } from './tool-choice-context-selection.js';

test('matched procedures keep full invocation and account bindings without unrelated backfill', () => {
  const unrelated = { intent: 'fixture.weather', choice: { identifier: 'weather' } };
  const read = { intent: 'fixture.local.read', choice: { identifier: 'read_file', invocationTemplate: '{"path":"{{path}}"}', accountIdentity: 'fixture@example.invalid' } };
  const query = { intent: 'fixture.local.query', choice: { identifier: 'file_query' } };
  const records = Object.freeze([unrelated, read, query]);
  const selected = selectToolChoicesForContext(records, new Set([query.intent, read.intent]));
  assert.deepEqual(selected, [read, query]);
  assert.equal(selected[0], read);
  assert.equal(selected[1], query);
  assert.deepEqual(records, [unrelated, read, query]);
});

test('missing, unavailable, or stale matches retain discovery context', () => {
  const records = Object.freeze([{ intent: 'fixture.local.read' }]);
  assert.equal(selectToolChoicesForContext(records, new Set()), records);
  assert.equal(selectToolChoicesForContext(records, new Set(['missing'])), records);
  assert.deepEqual(selectToolChoicesForContext([], new Set(['missing'])), []);
});

test('an explicit task with no matching procedures does not backfill unrelated memories', () => {
  const records = [{ intent: 'fixture.weather' }];
  assert.deepEqual(selectToolChoicesForContext(records, new Set(), true), []);
  assert.deepEqual(records, [{ intent: 'fixture.weather' }]);
});
