import assert from 'node:assert/strict';
import test from 'node:test';
import { guidanceTargetEligible, watchGuidanceTarget, type GuidanceTargetCandidate, type GuidanceTargetState } from './guidance-target';

function fixture() {
  let found = false;
  let observed = () => {};
  let timeout = () => {};
  let stopped = 0;
  let cleared = 0;
  const states: GuidanceTargetState[] = [];
  const cancel = watchGuidanceTarget({ find: () => found, observe: check => { observed = check; return () => { stopped++; }; }, later: (check, ms) => { assert.equal(ms, 8_000); timeout = check; return () => { cleared++; }; } }, state => states.push(state));
  return { states, cancel, observe: () => observed(), expire: () => timeout(), find: () => { found = true; }, lose: () => { found = false; }, resources: () => ({ stopped, cleared }) };
}
test('guidance keeps a ready target under observation until closing', () => {
  const f = fixture();
  assert.deepEqual(f.states, ['checking']);
  f.observe(); assert.deepEqual(f.states, ['checking']);
  f.find(); f.observe();
  assert.deepEqual(f.states, ['checking', 'ready']);
  assert.deepEqual(f.resources(), { stopped: 0, cleared: 1 });
  f.expire(); f.cancel();
  assert.deepEqual(f.states, ['checking', 'ready']);
  assert.deepEqual(f.resources(), { stopped: 1, cleared: 1 });
});
test('a target removed or made unavailable starts a fresh bounded check', () => {
  const f = fixture(); f.find(); f.observe();
  f.lose(); f.observe();
  assert.deepEqual(f.states, ['checking', 'ready', 'checking']);
  f.find(); f.observe();
  assert.deepEqual(f.states, ['checking', 'ready', 'checking', 'ready']);
  f.lose(); f.observe(); f.expire();
  assert.deepEqual(f.states, ['checking', 'ready', 'checking', 'ready', 'checking', 'unavailable']);
  f.find(); f.observe();
  assert.equal(f.states.at(-1), 'unavailable', 'timed out guidance needs an explicit retry');
  assert.deepEqual(f.resources(), { stopped: 1, cleared: 3 });
});
test('a guide never selects hidden, inert, detached or disabled controls', () => {
  const visible: GuidanceTargetCandidate = { isConnected: true, getClientRects: () => [{}], closest: () => null, matches: () => false };
  assert.equal(guidanceTargetEligible(visible), true);
  assert.equal(guidanceTargetEligible(null), false);
  assert.equal(guidanceTargetEligible({ ...visible, isConnected: false }), false);
  assert.equal(guidanceTargetEligible({ ...visible, getClientRects: () => [] }), false);
  assert.equal(guidanceTargetEligible({ ...visible, closest: selector => { assert.match(selector, /hidden.*aria-hidden.*inert.*aria-disabled/); return {}; } }), false);
  assert.equal(guidanceTargetEligible({ ...visible, matches: selector => { assert.equal(selector, ':disabled'); return true; } }), false);
});
test('missing guidance reaches an unavailable state and a retry starts a fresh lookup', () => {
  const f = fixture(); f.expire();
  assert.deepEqual(f.states, ['checking', 'unavailable']);
  const retry = fixture(); retry.find(); retry.observe();
  assert.deepEqual(retry.states, ['checking', 'ready']);
  assert.deepEqual(f.resources(), { stopped: 1, cleared: 1 });
});
test('closing or navigating away cancels lookup without late state changes', () => {
  const f = fixture(); f.cancel(); f.find(); f.observe(); f.expire();
  assert.deepEqual(f.states, ['checking']);
  assert.deepEqual(f.resources(), { stopped: 1, cleared: 1 });
});
