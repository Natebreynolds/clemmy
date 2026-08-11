import assert from 'node:assert/strict';
import test from 'node:test';

import { staleValueAssertedAsCurrent } from './scenarios/correction-sticks.js';

const STALE = 'Zubrowka-7741';

test('correction proof distinguishes a retired mention from a stale assertion', () => {
  assert.equal(
    staleValueAssertedAsCurrent(
      `Your code is Marzipan-9214. ${STALE} is stale and should not be used.`,
      STALE,
    ),
    false,
  );
  assert.equal(
    staleValueAssertedAsCurrent(`Your current code is ${STALE}. An old note was corrected.`, STALE),
    true,
    'an unrelated retirement word elsewhere cannot excuse the stale value',
  );
  assert.equal(
    staleValueAssertedAsCurrent(
      `${STALE} is stale. For a second system, your current code is ${STALE}.`,
      STALE,
    ),
    true,
    'every occurrence must be locally marked as retired',
  );
  assert.equal(
    staleValueAssertedAsCurrent(`The superseded code ${STALE} should not be used.`, STALE),
    false,
  );
  assert.equal(
    staleValueAssertedAsCurrent(
      `${STALE} is the retired value and should not be used as current.`,
      STALE,
    ),
    false,
    'a determiner between the copula and retirement marker remains an explicit retirement',
  );
  assert.equal(
    staleValueAssertedAsCurrent(
      `Your code is Marzipan-9214. The earlier **${STALE}** is retired and should not be used.`,
      STALE,
    ),
    false,
    'Markdown emphasis around a locally retired value is presentation-only',
  );
  assert.equal(
    staleValueAssertedAsCurrent(`Your current code is **${STALE}**.`, STALE),
    true,
    'Markdown emphasis cannot excuse a stale-as-current assertion',
  );
  assert.equal(
    staleValueAssertedAsCurrent(
      `${STALE} was stale, but it is current again and should be used.`,
      STALE,
    ),
    true,
    'a later reversal in the same local clause defeats the retirement marker',
  );
  assert.equal(staleValueAssertedAsCurrent('Your code is Marzipan-9214.', STALE), false);
});
