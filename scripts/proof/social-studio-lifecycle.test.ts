import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  socialStudioComposeInstructions,
  socialStudioProviderDispatchesValid,
} from './scenarios/social-studio-lifecycle.js';

test('social studio proof admits source reads plus exactly one publish and nothing else', () => {
  assert.equal(
    socialStudioProviderDispatchesValid([
      'PROOF_SOCIAL_GET_CONTENT_PLAN',
      'INSTAGRAM_CREATE_POST',
    ]),
    true,
  );
  assert.equal(
    socialStudioProviderDispatchesValid([
      'PROOF_SOCIAL_GET_CONTENT_PLAN',
      'PROOF_SOCIAL_GET_CONTENT_PLAN',
      'INSTAGRAM_CREATE_POST',
    ]),
    true,
  );
  assert.equal(socialStudioProviderDispatchesValid(['PROOF_SOCIAL_GET_CONTENT_PLAN']), false);
  assert.equal(
    socialStudioProviderDispatchesValid([
      'INSTAGRAM_CREATE_POST',
      'INSTAGRAM_CREATE_POST',
    ]),
    false,
  );
  assert.equal(
    socialStudioProviderDispatchesValid([
      'PROOF_SOCIAL_GET_CONTENT_PLAN',
      'GMAIL_SEND_EMAIL',
      'INSTAGRAM_CREATE_POST',
    ]),
    false,
  );
});

test('social studio compose proof requires context fields without leaking expected campaign values', () => {
  const instructions = socialStudioComposeInstructions('DRAFT_MARKER:test');
  for (const field of ['brand', 'handle', 'campaign', 'offer', 'hashtag', 'sourceMarker']) {
    assert.match(instructions, new RegExp(`context\\.${field}`));
  }
  for (const leakedValue of [
    'Juniper Vale Coffee',
    '@junipervale',
    'Rainy Day Roast',
    'Complimentary oat-milk upgrade on August 14',
    '#RainyDayRoast',
    'SOCIAL_SOURCE:PROOF_ONLY',
  ]) {
    assert.equal(instructions.includes(leakedValue), false, leakedValue);
  }
});
