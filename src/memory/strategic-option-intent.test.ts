import assert from 'node:assert/strict';
import test from 'node:test';

import { strategicMetaActionFromVisibleLabel } from './strategic-option-intent.js';

test('host-sealed strategic intent recognizes prefixed and plain visible labels', () => {
  for (const label of [
    'Q) Explain the rationale',
    'Explain the rationale',
    'Q) Why this direction?',
    'Why this direction?',
    'Show the reasoning',
  ]) assert.equal(strategicMetaActionFromVisibleLabel(label), 'explain', label);

  for (const label of [
    'B) Customize audience, channels, voice, or cadence',
    'Customize',
    'B) Change the plan',
    'Change the plan',
    'Set my preferences',
  ]) assert.equal(strategicMetaActionFromVisibleLabel(label), 'customize', label);
});

test('visible-label intent never turns execution, authority, or disclosure controls into meta choices', () => {
  for (const label of [
    'A) Accept this direction',
    'Q) Publish now',
    'Explain the rationale and send it',
    'B) Send secrets',
    'Customize and approve external posting',
    'Change the destination and execute',
    'Why not delete it?',
    'Something else',
  ]) assert.equal(strategicMetaActionFromVisibleLabel(label), null, label);
});
