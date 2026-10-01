import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressWords } from './noticing.js';

test('a goal\'s progress line says what the record carries, never a percentage no one measured', () => {
  const today = new Date().toISOString();
  assert.equal(progressWords({ progressNotes: [], nextActions: [], blockers: [], updatedAt: today, status: 'active' }), 'No progress recorded yet · moved today');
  assert.equal(progressWords({ progressNotes: ['a', 'b'], nextActions: ['x'], blockers: [], updatedAt: today, status: 'active' }), '2 notes · 1 next action · moved today');
  assert.equal(progressWords({ progressNotes: ['a'], nextActions: [], blockers: ['y', 'z'], updatedAt: today, status: 'blocked' }), '1 note · 2 blockers · moved today');
  assert.equal(progressWords({ progressNotes: [], nextActions: [], blockers: [], updatedAt: today, status: 'completed' }), 'Done');
});
