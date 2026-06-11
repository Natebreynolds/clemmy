/**
 * Run: npx tsx --test src/runtime/harness/stream-reply.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createJsonFieldStreamer } = await import('./stream-reply.js');

function collect(fields: string[], chunks: string[]): string {
  let out = '';
  const feed = createJsonFieldStreamer(fields, (d) => { out += d; });
  for (const c of chunks) feed(c);
  return out;
}

test('extracts only the reply value from a decision JSON, across arbitrary chunk splits', () => {
  const json = '{"summary":"internal log text","reply":"Here is your brief — 3 tools compared.","done":true,"nextAction":"completed"}';
  // single chunk
  assert.equal(collect(['reply'], [json]), 'Here is your brief — 3 tools compared.');
  // per-character chunks (worst-case token splits)
  assert.equal(collect(['reply'], json.split('')), 'Here is your brief — 3 tools compared.');
});

test('decodes JSON escapes and unicode in the streamed value', () => {
  const json = '{"reply":"line one\\nline two \\"quoted\\" \\u2014 dash"}';
  assert.equal(collect(['reply'], [json]), 'line one\nline two "quoted" — dash');
});

test('a wanted key NAME inside another value never false-triggers', () => {
  const json = '{"summary":"the model said \\"reply\\": something","reply":"clean"}';
  assert.equal(collect(['reply'], [json]), 'clean');
});

test('plan streaming: objective then step actions, separated by blank lines', () => {
  const json = '{"objective":"Audit example.com","steps":[{"n":1,"action":"Crawl the site","rationale":"baseline"},{"n":2,"action":"Write the brief","rationale":"deliverable"}],"successCriteria":["brief exists"]}';
  assert.equal(
    collect(['objective', 'action'], [json]),
    'Audit example.com\n\nCrawl the site\n\nWrite the brief',
  );
});

test('multiple sequential JSON objects (multi-turn) separate their replies', () => {
  const a = '{"reply":"First turn.","done":false}';
  const b = '{"reply":"Second turn.","done":true}';
  assert.equal(collect(['reply'], [a, b]), 'First turn.\n\nSecond turn.');
});

test('non-JSON / plain prose emits nothing', () => {
  assert.equal(collect(['reply'], ['I will check the version now, no JSON here.']), '');
});

test('null/number/bool values for wanted keys emit nothing and do not break state', () => {
  const json = '{"reply":null,"count":3,"ok":true,"summary":"s"}{"reply":"after"}';
  assert.equal(collect(['reply'], [json]), 'after');
});
