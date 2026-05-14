/**
 * Run: npx tsx --test src/assistant/instructions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderChannelDirective } from './instructions.js';

test('discord: requests tight replies under 500 chars', () => {
  const d = renderChannelDirective('discord');
  assert.match(d, /Discord/);
  assert.match(d, /under 500 characters/);
});

test('discord: warns against markdown headers', () => {
  const d = renderChannelDirective('discord');
  assert.match(d, /Avoid markdown headers/);
});

test('discord: tells the model to chunk long responses', () => {
  const d = renderChannelDirective('discord');
  assert.match(d, /split into 2–3 short turns/);
});

test('discord-prefixed channels also match (e.g. discord:dm:123)', () => {
  const d = renderChannelDirective('discord:dm:1234567890');
  assert.match(d, /Discord/);
});

test('cli: allows markdown and matches user tone', () => {
  const c = renderChannelDirective('cli');
  assert.match(c, /CLI/);
  assert.match(c, /Markdown renders cleanly/);
});

test('chat: matches CLI guidance', () => {
  const c = renderChannelDirective('chat');
  assert.match(c, /Markdown renders cleanly/);
});

test('webhook: clean structured replies', () => {
  const w = renderChannelDirective('webhook');
  assert.match(w, /clean structured replies/);
});

test('api: matches webhook guidance', () => {
  const w = renderChannelDirective('api');
  assert.match(w, /clean structured replies/);
});

test('agent (autonomy): emits nothing — autonomy-v2 owns shape', () => {
  assert.equal(renderChannelDirective('agent'), '');
});

test('unknown / undefined channel: emits nothing', () => {
  assert.equal(renderChannelDirective(undefined), '');
  assert.equal(renderChannelDirective(''), '');
  assert.equal(renderChannelDirective('mystery'), '');
});

test('case-insensitive match', () => {
  assert.match(renderChannelDirective('DISCORD'), /Discord/);
  assert.match(renderChannelDirective('Discord'), /Discord/);
});
