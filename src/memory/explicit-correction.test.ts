import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isExplicitCorrectionText } from './explicit-correction.js';

test('curated replacement wording preserves explicit correction intent', () => {
  for (const text of [
    'Correction: put the central estimate first.',
    'Put the central estimate first. This replaces the previous bounds-first convention.',
    'This supersedes my prior reporting preference.',
    'The old value was wrong; use the new value instead.',
  ]) assert.equal(isExplicitCorrectionText(text), true, text);
});

test('a new preference or generic replacement task is not an explicit correction', () => {
  for (const text of [
    'Prefer uncertainty bounds before the central estimate.',
    'Replace the component on this page.',
    'A replacement part is needed for the observatory.',
  ]) assert.equal(isExplicitCorrectionText(text), false, text);
});
