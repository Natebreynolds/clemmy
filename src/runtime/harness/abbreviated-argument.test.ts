/**
 * Run: npx tsx --test src/runtime/harness/abbreviated-argument.test.ts
 *
 * An opaque value shortened with "..." is named back with the full values this
 * turn returned that begin the same way; the host never chooses among them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { abbreviatedArgumentNote, abbreviatedArguments, fullValuesStartingWith } from './abbreviated-argument.js';

const pageToken = (skip: number) => Buffer.from(JSON.stringify({ v: 1, e: 'https://records.example/v1/list', p: { top: '1000' }, skip: String(skip) })).toString('base64');
const page = (skip: number) => JSON.stringify({ data: { value: [{ id: `row-${skip}` }], next_page_token: pageToken(skip + 1000) } });

test('a shortened opaque value inside a carrier\'s nested JSON is found; prose with an ellipsis is not', () => {
  const shortened = `${pageToken(4000).slice(0, 40)}...5000`;
  const carrier = { requirement_id: 'cap:x', name: 'gateway', args_json: JSON.stringify({ tool_slug: 'LIST', arguments: JSON.stringify({ page_token: shortened, top: 1000 }) }) };
  assert.deepEqual(abbreviatedArguments(carrier), [{ path: 'args_json.arguments.page_token', prefix: pageToken(4000).slice(0, 40) }]);
  assert.deepEqual(abbreviatedArguments({ body: 'Thanks for the update... talk soon', note: 'short...' }), []);
});

test('the full values that begin the same way are listed newest first, whole', () => {
  const texts = [page(4000), page(3000), page(2000)];
  const prefix = pageToken(4000).slice(0, 40);
  const values = fullValuesStartingWith(prefix, texts);
  assert.deepEqual(values, [pageToken(5000), pageToken(4000), pageToken(3000)], 'every page token shares the prefix; newest first');
  const note = abbreviatedArgumentNote({
    callId: 'call-6', args: { page_token: `${prefix}...5000` }, textsNewestFirst: texts,
  })!;
  assert.match(note, /Call call-6 passed page_token shortened with "\.\.\."\. A value like that goes back whole/);
  assert.ok(note.includes(JSON.stringify(pageToken(5000))), 'the newest full token is named whole');
  assert.equal(abbreviatedArgumentNote({ callId: 'c', args: { page_token: `${'Z'.repeat(20)}...` }, textsNewestFirst: texts }), undefined,
    'nothing this turn returned begins that way');
});

test('a match inside a longer token is not a value start, and the note stays inside its bound', () => {
  assert.deepEqual(fullValuesStartingWith('abcdefghijklmnop', ['xabcdefghijklmnopqrs "abcdefghijklmnopTUV"']), ['abcdefghijklmnopTUV']);
  const long = `${'q'.repeat(16)}${'r'.repeat(3_000)}`;
  assert.equal(abbreviatedArgumentNote({ callId: 'c', args: { id: `${'q'.repeat(16)}...` }, textsNewestFirst: [long], maxChars: 1_600 }), undefined,
    'a value too long for the note is not clipped into it');
});
