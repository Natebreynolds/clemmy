import test from 'node:test';
import assert from 'node:assert/strict';
import { exactGroundedIdentifierMatch as matches } from './grounded-identifier-match.js';
test('whole email matches with prose punctuation and case folding', () => {
  for (const text of ['Use <Dana@Acme.example>.', 'Email: dana@acme.example, confirmed.', 'dana@acme.example.']) assert.equal(matches(text, 'dana@acme.example'), true);
});
test('different mailbox and extended domains are not identity proof', () => {
  for (const text of ['notdana@acme.example', 'x.dana@acme.example', 'dana@acme.example.evil', 'dana@acme.examples']) assert.equal(matches(text, 'dana@acme.example'), false);
});
test('domain host matches but lookalikes and subdomains do not', () => {
  for (const text of ['https://acme.example/path', 'dana@acme.example', 'Acme.example.']) assert.equal(matches(text, 'acme.example'), true);
  for (const text of ['notacme.example', 'acme.example.evil', 'sub.acme.example', 'acme.examples']) assert.equal(matches(text, 'acme.example'), false);
  assert.equal(matches('anything', ''), false);
});
