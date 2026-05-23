import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArchitectDiff } from './architect-diff.js';

test('returns plain text when no fenced JSON block is present', () => {
  const raw = 'Looks good — the dependency chain is acyclic.';
  const { text, diff } = extractArchitectDiff(raw);
  assert.equal(text, raw);
  assert.equal(diff, null);
});

test('parses a valid trailing fenced JSON block', () => {
  const raw = [
    'Added a research step.',
    '',
    '```json',
    '{',
    '  "ops": [',
    '    { "type": "add_step", "step": { "id": "research", "prompt": "Gather context." } }',
    '  ],',
    '  "summary": "Added research step."',
    '}',
    '```',
  ].join('\n');
  const { text, diff } = extractArchitectDiff(raw);
  assert.equal(text, 'Added a research step.');
  assert.ok(diff);
  assert.equal(diff.ops.length, 1);
  assert.equal(diff.summary, 'Added research step.');
});

test('treats empty ops array as no diff but strips the empty block', () => {
  const raw = 'No changes needed.\n\n```json\n{"ops": []}\n```';
  const { text, diff } = extractArchitectDiff(raw);
  assert.equal(text, 'No changes needed.');
  assert.equal(diff, null);
});

test('falls back to plain text on malformed JSON (lossless)', () => {
  const raw = 'Proposing changes:\n\n```json\n{ ops: [ this is not valid json ] }\n```';
  const { text, diff } = extractArchitectDiff(raw);
  // The whole raw response is preserved as text so the user can still
  // read it — we never want a single broken char to nuke the chat.
  assert.equal(text.includes('Proposing changes:'), true);
  assert.equal(diff, null);
});

test('handles multiple ops in order', () => {
  const raw = [
    '```json',
    '{',
    '  "ops": [',
    '    { "type": "set_field", "path": "name", "value": "weekly-research" },',
    '    { "type": "add_step", "step": { "id": "a", "prompt": "..." } },',
    '    { "type": "add_step", "step": { "id": "b", "prompt": "...", "dependsOn": ["a"] } }',
    '  ]',
    '}',
    '```',
  ].join('\n');
  const { diff } = extractArchitectDiff(raw);
  assert.ok(diff);
  assert.equal(diff.ops.length, 3);
  assert.deepEqual((diff.ops[0] as { type: string }).type, 'set_field');
  assert.deepEqual((diff.ops[2] as { step: { dependsOn: string[] } }).step.dependsOn, ['a']);
});

test('ignores non-object JSON gracefully', () => {
  const raw = 'Here you go.\n\n```json\n["just", "an", "array"]\n```';
  const { diff } = extractArchitectDiff(raw);
  // Arrays are objects in JS, but they lack .ops; should not crash, should
  // return null diff. (Array.isArray(obj.ops) is false on an array literal.)
  assert.equal(diff, null);
});

test('empty input', () => {
  const { text, diff } = extractArchitectDiff('');
  assert.equal(text, '');
  assert.equal(diff, null);
});

test('summary field is optional', () => {
  const raw = '```json\n{"ops":[{"type":"remove_step","id":"draft"}]}\n```';
  const { diff } = extractArchitectDiff(raw);
  assert.ok(diff);
  assert.equal(diff.summary, undefined);
  assert.equal(diff.ops.length, 1);
});
