/** Run: npx tsx --test apps/console-web/src/lib/fusion.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fusionOutcomeLabel } from './fusion.js';

test('trace outcomes map to user language and never leak raw tokens', () => {
  assert.equal(fusionOutcomeLabel('checker-accepted-draft'), 'accepted the draft unchanged');
  assert.equal(fusionOutcomeLabel('checker-correction-applied'), 'returned one bounded correction');
  assert.equal(fusionOutcomeLabel('checker-timeout-ship-draft'), 'kept Clementine’s draft (the checker could not complete)');
  // Unknown outcomes: neutral, no raw token, no stronger claim than the trace.
  assert.equal(fusionOutcomeLabel('some-new-outcome'), 'recorded a verification');
  assert.equal(fusionOutcomeLabel(undefined), 'ran');
});
