/** Run: npx tsx --test apps/console-web/src/lib/greeting.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greetingName, timeGreeting } from './greeting';

test('the greeting uses the user\'s name when Clem knows one', () => {
  assert.equal(timeGreeting(9, 'Nathan'), 'Good morning, Nathan');
  assert.equal(timeGreeting(14, 'Nathan'), 'Good afternoon, Nathan');
  assert.equal(timeGreeting(21, 'Nathan'), 'Good evening, Nathan');
  // Unknown name degrades to the plain greeting, never a placeholder.
  assert.equal(timeGreeting(9), 'Good morning');
  assert.equal(timeGreeting(9, ''), 'Good morning');
});

test('greetingName prefers the chosen casual name, then first name, never a hardcode', () => {
  assert.equal(greetingName({ preferredName: 'Nate', displayName: 'Nathan Reynolds' }), 'Nate');
  // preferredName is used verbatim — it is already the user's chosen form.
  assert.equal(greetingName({ preferredName: 'Nathan R.' }), 'Nathan R.');
  // Full names collapse to the first word.
  assert.equal(greetingName({ displayName: 'Nathan Reynolds' }), 'Nathan');
  assert.equal(greetingName({ name: 'Nathan Reynolds' }), 'Nathan');
  assert.equal(greetingName({}), '');
  assert.equal(greetingName(null), '');
  assert.equal(greetingName({ displayName: '   ' }), '');
});
