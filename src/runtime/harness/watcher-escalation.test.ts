import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_WATCHER_INJECTIONS,
  shouldStartWatcherCheck,
  watcherEscalation,
  type WatcherGateInput,
} from './watcher-judge.js';

/**
 * Reconstructed from the live turn that made this necessary.
 *
 * 2026-09-21, "create a workflow for my old market leader accounts": the
 * watcher caught drift 90 seconds in with the correct instruction — "publish
 * the required plan of substance now, before loading skills" — injected and
 * DELIVERED it, then did the same again. The model kept searching. Injections
 * reached 2 of 2 at 18:36:08, `injectionsUsed < maxInjections` went false, and
 * the gate stopped starting checks. The turn then ran unsupervised from 18:37
 * to 18:43, repeating three tool_search queries it had already issued, until
 * the owner stopped it: 8.5 minutes, 90 tool calls, 282,762 uncached tokens,
 * zero plans published.
 *
 * Nothing was undetected and nothing was discarded. Supervision simply ended
 * because the watcher had used up its right to speak.
 */
const base: WatcherGateInput = {
  enabled: true,
  totalToolCalls: 40,
  lastCheckedAtToolCalls: 0,
  checkIntervalTools: 12,
  injectionsUsed: MAX_WATCHER_INJECTIONS,
  maxInjections: MAX_WATCHER_INJECTIONS,
  checksUsed: 3,
  maxChecks: 4,
  checkInFlight: false,
};

test('an exhausted steer budget no longer stops the watch while drift is unresolved', () => {
  assert.equal(shouldStartWatcherCheck({ ...base, unresolvedDrift: true }), true,
    'the turn that burned six unsupervised minutes must still be observed');
});

test('an exhausted steer budget still stops the watch once drift is resolved', () => {
  assert.equal(shouldStartWatcherCheck({ ...base, unresolvedDrift: false }), false);
  assert.equal(shouldStartWatcherCheck(base), false,
    'omitting the field preserves the original gate exactly');
});

test('maxChecks remains the real bound — unresolved drift cannot run forever', () => {
  assert.equal(
    shouldStartWatcherCheck({ ...base, checksUsed: 4, maxChecks: 4, unresolvedDrift: true }),
    false,
    'keeping the watch alive must not become an unbounded check loop',
  );
});

test('every other cap still applies with drift unresolved', () => {
  const drifting = { ...base, unresolvedDrift: true };
  assert.equal(shouldStartWatcherCheck({ ...drifting, enabled: false }), false, 'disabled');
  assert.equal(shouldStartWatcherCheck({ ...drifting, checkInFlight: true }), false, 'never stack checks');
  assert.equal(shouldStartWatcherCheck({ ...drifting, totalToolCalls: 5 }), false, 'interval not elapsed');
});

test('a third finding on unresolved drift becomes a bound, not a third nudge', () => {
  assert.equal(watcherEscalation({
    verdict: 'drift', deliveredSteers: 2, maxInjections: 2, hasSteer: true,
  }), 'bound', 'told twice and still drifting is not a case for saying it again');
});

test('the first two findings still steer', () => {
  assert.equal(watcherEscalation({ verdict: 'drift', deliveredSteers: 0, maxInjections: 2, hasSteer: true }), 'steer');
  assert.equal(watcherEscalation({ verdict: 'drift', deliveredSteers: 1, maxInjections: 2, hasSteer: true }), 'steer');
});

test('on_track never bounds a turn', () => {
  assert.equal(watcherEscalation({
    verdict: 'on_track', deliveredSteers: 2, maxInjections: 2, hasSteer: true,
  }), 'observe', '191 of 240 live reviews were on_track — none may end a turn');
});

test('drift with nothing to say never bounds a turn', () => {
  assert.equal(watcherEscalation({
    verdict: 'drift', deliveredSteers: 2, maxInjections: 2, hasSteer: false,
  }), 'observe', 'a turn must never be stopped on a finding that carries no words');
});

test('only DELIVERED steers count as having told the model', () => {
  // Live 2026-09-21 across three days: 49 drift verdicts, 28 injected. An
  // injected-but-undelivered steer was never seen, so it cannot justify a bound.
  assert.equal(watcherEscalation({
    verdict: 'drift', deliveredSteers: 1, maxInjections: 2, hasSteer: true,
  }), 'steer', 'a steer the model never received is not a warning it ignored');
});

test('a null verdict observes — an unavailable reviewer cannot end a turn', () => {
  assert.equal(watcherEscalation({
    verdict: null, deliveredSteers: 2, maxInjections: 2, hasSteer: true,
  }), 'observe');
});
