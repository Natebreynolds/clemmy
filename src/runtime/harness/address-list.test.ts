/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/address-list.test.ts
 *
 * A recipient field's value is an address list. Live 2026-09-25: one send's
 * recorded targets held the merged string "A, B" as a third recipient beside
 * A and B. These pin the structural parse that splits it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddressList } from './address-list.js';

test('a merged recipient string is its separate addresses, lower-cased and de-duplicated', () => {
  assert.deepEqual(parseAddressList('Pat@Example.test, Sam.Lee@Example.test'),
    ['pat@example.test', 'sam.lee@example.test']);
  assert.deepEqual(parseAddressList('A@example.test, a@EXAMPLE.test'), ['a@example.test']);
  assert.deepEqual(parseAddressList('pat@example.test'), ['pat@example.test']);
});

test('grammar delimiters, not commas, decide where one mailbox ends', () => {
  assert.deepEqual(parseAddressList('"Doe, Pat" <Pat@Example.test>, sam@example.test'),
    ['pat@example.test', 'sam@example.test'], 'a comma inside a quoted display name');
  assert.deepEqual(parseAddressList('Pat (work, primary) <pat@example.test>; Lee <lee@example.test>'),
    ['pat@example.test', 'lee@example.test'], 'a comma inside a comment, and a semicolon separator');
  assert.deepEqual(parseAddressList('Team: a@example.test, b@example.test;, c@example.test'),
    ['a@example.test', 'b@example.test', 'c@example.test'], 'group syntax');
  assert.deepEqual(parseAddressList('José Núñez <jose@example.test>, J. Doe <j@example.test>'),
    ['jose@example.test', 'j@example.test'], 'international and dotted display names');
  assert.deepEqual(parseAddressList('"quoted local"@example.test, user@[192.0.2.1]'),
    ['"quoted local"@example.test', 'user@[192.0.2.1]']);
  assert.deepEqual(parseAddressList('a@example.test,, b@example.test,'),
    ['a@example.test', 'b@example.test'], 'empty members are skipped');
});

test('a value that is not an address list stays whole: no guessed split', () => {
  for (const value of [
    'https://example.test/a,b',
    'Sheet1!A1:B2',
    'C12345',
    '+1 555 0100',
    'not an address, also not',
    'a@example.test, not-an-address',
    'Pat@Work <p@example.test>',
    '<a@example.test',
    'undisclosed-recipients:;',
    '',
    '   ',
  ]) {
    assert.equal(parseAddressList(value), null, JSON.stringify(value));
  }
});
