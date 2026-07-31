/**
 * Run: npx tsx --test src/lib/greeting.test.ts   (from apps/mobile-web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greetingName, timeGreeting } from './greeting.js';

test('greetingName takes a first name and refuses placeholder identities', () => {
  assert.equal(greetingName('Nathan'), 'Nathan');
  assert.equal(greetingName('  Nathan Reynolds '), 'Nathan');
  // The live bug this pins: "the user" once greeted as "Good afternoon, the".
  for (const generic of ['the user', 'User', 'owner', 'there', 'unknown', 'n/a', '', null, undefined]) {
    assert.equal(greetingName(generic), '', `${String(generic)} must not become a name`);
  }
});

test('timeGreeting spans the whole clock and stays graceful without a name', () => {
  assert.equal(timeGreeting(2, 'Nathan'), 'Still up, Nathan');
  assert.equal(timeGreeting(9, 'Nathan'), 'Good morning, Nathan');
  assert.equal(timeGreeting(13, 'Nathan'), 'Good afternoon, Nathan');
  assert.equal(timeGreeting(21, 'Nathan'), 'Good evening, Nathan');
  assert.equal(timeGreeting(9), 'Good morning');
});
