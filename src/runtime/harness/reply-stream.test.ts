import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReplyStreamExtractor, extractReplyValueSoFar } from './reply-stream.js';

function runChunks(chunks: string[]): string {
  const ex = createReplyStreamExtractor();
  return chunks.map((c) => ex(c)).join('');
}

test('reply envelope streamed one CHAR at a time → clean unescaped prose, no JSON leak', () => {
  const full = '{"reply":"Local SEO matters.\\nLine two with a \\"quote\\" and slash \\/ done."}';
  const out = runChunks(full.split(''));
  assert.equal(out, 'Local SEO matters.\nLine two with a "quote" and slash / done.');
  assert.ok(!out.includes('{"reply"'), 'no JSON wrapper leaked to the dock');
});

test('reply envelope in realistic token chunks', () => {
  assert.equal(runChunks(['{"', 'reply', '":"', 'Hello', ' world', '"}']), 'Hello world');
});

test('plain prose (no envelope) streams through verbatim', () => {
  assert.equal(runChunks(['Hello', ' ', 'there!']), 'Hello there!');
});

test('leading whitespace before the envelope is tolerated', () => {
  assert.equal(runChunks(['  {"reply":"', 'ok', '"}']), 'ok');
});

test('trailing "} after the value is dropped', () => {
  assert.equal(runChunks(['{"reply":"done"}']), 'done');
});

test('extractReplyValueSoFar waits on a dangling escape / incomplete \\u', () => {
  assert.deepEqual(extractReplyValueSoFar('{"reply":"ab\\'), { text: 'ab', done: false });
  assert.deepEqual(extractReplyValueSoFar('{"reply":"x\\u26'), { text: 'x', done: false });
  assert.deepEqual(extractReplyValueSoFar('{"reply":"x\\u0041y"'), { text: 'xAy', done: true });
});
