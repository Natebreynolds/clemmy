import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composerUsesVoiceControl } from './Composer';

const empty = { hasVoiceControl: true, value: '', stagedCount: 0, hasContext: false,
  busy: false, submitting: false, voiceActive: false };

test('Talk occupies the idle empty slot only where conversational voice is provided', () => {
  assert.equal(composerUsesVoiceControl(empty), true);
  assert.equal(composerUsesVoiceControl({ ...empty, value: ' \n ' }), true);
  assert.equal(composerUsesVoiceControl({ ...empty, hasVoiceControl: false }), false);
});

test('a draft, selected file, upload, or in-flight request keeps Send in the action row', () => {
  for (const state of [
    { value: 'Keep my unsent draft' },
    { value: 'First line\nSecond line' },
    { stagedCount: 1 },
    { hasContext: true },
    { busy: true },
    { submitting: true },
  ]) assert.equal(composerUsesVoiceControl({ ...empty, ...state }), false, JSON.stringify(state));
});

test('End voice remains available while an active conversation waits for its reply', () => {
  assert.equal(composerUsesVoiceControl({ ...empty, voiceActive: true, busy: true }), true);
  assert.equal(composerUsesVoiceControl({ ...empty, voiceActive: true, busy: true, hasVoiceControl: false }), false);
});
