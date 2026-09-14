import assert from 'node:assert/strict';
import test from 'node:test';
import { evidencePortions } from './evidence-portions.js';

test('every character survives portions including unicode, boundaries and the last source', () => {
  const source = ('Source α\n\n' + '🦊'.repeat(41) + '\n\n').repeat(20) + 'DECISIVE LAST FACT';
  const fits = (s: string) => Buffer.byteLength(s) <= 250;
  const portions = evidencePortions(source, fits);
  assert.ok(portions.length > 1);
  assert.equal(portions.join(''), source);
  assert.ok(portions.every(fits));
  assert.ok(portions.every(s => Buffer.from(s).toString() === s));
  assert.match(portions.at(-1)!, /DECISIVE LAST FACT$/);
});

test('a fitting request is unchanged; impossible base instructions fail explicitly', () => {
  assert.deepEqual(evidencePortions('entire result', () => true), ['entire result']);
  assert.throws(() => evidencePortions('result', () => false), /instructions exceed/);
  assert.throws(() => evidencePortions('🦊', text => Buffer.byteLength(text) < 4), /next source character/);
});
