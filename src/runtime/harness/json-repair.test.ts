import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonCandidate, repairToParseableJson, isParseableJson } from './json-repair.js';

test('repair: ```json fenced object is unwrapped and parses', () => {
  const { text, repaired } = repairToParseableJson('```json\n{"done": true}\n```');
  assert.equal(repaired, true);
  assert.deepEqual(JSON.parse(text), { done: true });
});

test('repair: no-language fence is unwrapped', () => {
  const { text } = repairToParseableJson('```\n{"a": 1}\n```');
  assert.deepEqual(JSON.parse(text), { a: 1 });
});

test('repair: prose before AND after a bare object is stripped', () => {
  const { text, repaired } = repairToParseableJson('Here is the result:\n{"verdict":"done"}\nHope that helps!');
  assert.equal(repaired, true);
  assert.deepEqual(JSON.parse(text), { verdict: 'done' });
});

test('repair: already-clean object is returned byte-for-byte (idempotent)', () => {
  const input = '{"a":1}';
  const { text, repaired } = repairToParseableJson(input);
  assert.equal(text, input);
  assert.equal(repaired, false);
});

test('repair: top-level array (fenced + bare) is extracted', () => {
  assert.deepEqual(JSON.parse(repairToParseableJson('```json\n[1,2,3]\n```').text), [1, 2, 3]);
  assert.deepEqual(JSON.parse(repairToParseableJson('result: [1,2]').text), [1, 2]);
});

test('repair: braces inside a string do NOT truncate the object (string-aware scan)', () => {
  const { text } = repairToParseableJson('prefix {"reason":"use } and { inside"} suffix');
  assert.deepEqual(JSON.parse(text), { reason: 'use } and { inside' });
});

test('repair: nested object with trailing prose yields the correct balanced slice', () => {
  const { text } = repairToParseableJson('{"a":{"b":1}} trailing words');
  assert.deepEqual(JSON.parse(text), { a: { b: 1 } });
});

test('repair: empty / prose-only / fence-only returns the original untouched', () => {
  for (const junk of ['', '   ', 'no json here at all', '```\n```']) {
    const { text, repaired } = repairToParseableJson(junk);
    assert.equal(text, junk);
    assert.equal(repaired, false);
  }
});

test('repair: MiniMax-style <think> prefix is stripped before the JSON', () => {
  const { text, repaired } = repairToParseableJson('<think>\nThe user said go.\n</think>\n\n{"ok": true}');
  assert.equal(repaired, true);
  assert.deepEqual(JSON.parse(text), { ok: true });
});

test('repair: <think> block that RESTATES the schema (braces) does not derail extraction', () => {
  // The reasoning contains a decoy {"x": 2}; the real answer is {"a": 1} after </think>.
  const raw = '<think>I should return {"x": 2}? No — the format is {"a": 1}.</think>\n{"a": 1}';
  const { text } = repairToParseableJson(raw);
  assert.deepEqual(JSON.parse(text), { a: 1 });
});

test('repair: <think> prefix + fenced JSON', () => {
  const { text } = repairToParseableJson('<think>reasoning here</think>\n```json\n{"done": false}\n```');
  assert.deepEqual(JSON.parse(text), { done: false });
});

test('repair: truncated/unclosed <think> with no JSON → null (lets the re-ask recover, never crashes)', () => {
  const { text, repaired } = repairToParseableJson('<think>\nI am still reasoning and the output got cut off mid');
  assert.equal(repaired, false);
  assert.equal(text, '<think>\nI am still reasoning and the output got cut off mid');
  assert.equal(extractJsonCandidate(text), null);
});

test('repair: unclosed <think> followed by the real JSON still extracts it', () => {
  const { text } = repairToParseableJson('<think>\nlet me answer {"done": true}');
  assert.deepEqual(JSON.parse(text), { done: true });
});

test('extractJsonCandidate: returns null when nothing recoverable', () => {
  assert.equal(extractJsonCandidate('totally not json'), null);
});

test('isParseableJson basic', () => {
  assert.equal(isParseableJson('{"a":1}'), true);
  assert.equal(isParseableJson('{a:1}'), false);
});
