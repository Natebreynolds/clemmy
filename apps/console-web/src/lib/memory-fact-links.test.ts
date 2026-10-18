import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryFactHref, memoryFactId } from './memory-fact-links.js';

test('retained fact links use only their exact canonical positive identity', () => {
  for (const value of [17, '17', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
    assert.equal(memoryFactId(value), Number(value));
    assert.equal(memoryFactHref(value), `/memory?fact=${value}`);
  }
});

test('untrusted or missing identities never become a search, another route or an approximate fact', () => {
  for (const value of [undefined, null, {}, [], true, false, 0, -1, NaN, Infinity, 1.5,
    Number.MAX_SAFE_INTEGER + 1, '', '0', '01', ' 17', '17 ', '17x', '1e2', '1.5', '+17',
    '17&tab=tools', '../facts', '9007199254740992', '__proto__']) {
    assert.equal(memoryFactId(value), null, `must refuse ${String(value)}`);
    assert.equal(memoryFactHref(value), null);
  }
});
