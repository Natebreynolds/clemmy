/**
 * Run: npx tsx --test apps/mobile-web/src/lib/streaming.test.ts
 *
 * Pins the mobile streaming-bubble reducer: stream_token rows accumulate into
 * the provisional text and stay OUT of the transcript; any other event ends
 * the provisional text. Regression pin for the dead `delta` listener + the
 * per-token wipe (live 2026-08-04: mobile showed no streaming at all).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceStreamingText } from './streaming';

test('stream_token rows accumulate and are consumed', () => {
  let out = reduceStreamingText('', { type: 'stream_token', data: { delta: 'Wor' } });
  assert.deepEqual(out, { streaming: 'Wor', consumed: true });
  out = reduceStreamingText(out.streaming, { type: 'stream_token', data: { delta: 'king…' } });
  assert.deepEqual(out, { streaming: 'Working…', consumed: true });
});

test('any non-token event ends the provisional text and merges normally', () => {
  const out = reduceStreamingText('Working…', { type: 'conversation_completed', data: { reply: 'Done.' } });
  assert.deepEqual(out, { streaming: '', consumed: false });
});

test('a malformed token row is consumed without corrupting the text', () => {
  const out = reduceStreamingText('Wor', { type: 'stream_token', data: {} });
  assert.deepEqual(out, { streaming: 'Wor', consumed: true });
});
