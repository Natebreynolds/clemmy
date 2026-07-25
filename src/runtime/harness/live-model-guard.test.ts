import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLiveModelTransportAllowed,
  liveModelTransportsDisabled,
} from './live-model-guard.js';

test('isolated-suite live model guard fails before a real transport can run', () => {
  const previous = process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS;
  process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
  try {
    assert.equal(liveModelTransportsDisabled(), true);
    assert.throws(
      () => assertLiveModelTransportAllowed('test transport'),
      (err: unknown) => {
        assert.equal((err as Error).name, 'LiveModelTransportDisabledError');
        assert.match((err as Error).message, /test transport/);
        return true;
      },
    );
  } finally {
    if (previous == null) delete process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS;
    else process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = previous;
  }
});

test('live model guard is inert outside the isolated suite', () => {
  const previous = process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS;
  delete process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS;
  try {
    assert.equal(liveModelTransportsDisabled(), false);
    assert.doesNotThrow(() => assertLiveModelTransportAllowed('production transport'));
  } finally {
    if (previous == null) delete process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS;
    else process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = previous;
  }
});
