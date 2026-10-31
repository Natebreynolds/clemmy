import assert from 'node:assert/strict';
import test from 'node:test';
import { homeReadConfirmed, showHomeBusinessStarter, WEEKLY_BRIEF_REQUEST } from './home-starter';

const fresh = () => ({ data: {}, loading: false, stale: false, error: null, offline: false });
const empty = () => ({ preferencesReady: true, countKnown: true, countLive: true, needsYou: 0,
  workKnown: true, workError: null, workOffline: false, workCount: 0,
  homeComplete: true, homeRead: fresh(), homeRows: 0, fromClemRead: fresh(), fromClemRows: 0,
  recentRead: fresh(), recentRows: 0, quickActions: 0, pinsConfirmedEmpty: true, missedRunsConfirmedEmpty: true });

test('a business start requires confirmed empty work, not remembered zeroes or a partial Home read', () => {
  assert.equal(showHomeBusinessStarter(empty()), true);
  for (const patch of [
    { preferencesReady: false }, { countKnown: false }, { countLive: false }, { needsYou: 1 },
    { workKnown: false }, { workError: 'Unavailable' }, { workOffline: true }, { workCount: 1 },
    { homeComplete: false }, { homeRows: 1 }, { fromClemRows: 1 }, { recentRows: 1 },
    { quickActions: 1 }, { pinsConfirmedEmpty: false }, { missedRunsConfirmedEmpty: false },
  ]) assert.equal(showHomeBusinessStarter({ ...empty(), ...patch }), false, JSON.stringify(patch));
  for (const field of ['homeRead', 'fromClemRead', 'recentRead'] as const) {
    for (const failure of [{ data: null }, { loading: true }, { stale: true }, { error: 'Retry' }, { offline: true }]) {
      const value = empty(); value[field] = { ...fresh(), ...failure } as ReturnType<typeof fresh>;
      assert.equal(showHomeBusinessStarter(value), false, `${field}: ${JSON.stringify(failure)}`);
    }
  }
});

test('in-flight refresh keeps a successful empty snapshot stable until a failure or new value arrives', () => {
  assert.equal(homeReadConfirmed({ ...fresh(), refreshing: true } as ReturnType<typeof fresh>), true);
  assert.equal(homeReadConfirmed({ ...fresh(), stale: true, error: 'The refresh failed' }), false);
  assert.match(WEEKLY_BRIEF_REQUEST, /Ask what the brief should cover/);
  assert.match(WEEKLY_BRIEF_REQUEST, /Ask before connecting accounts, scheduling work, or sending anything/);
  assert.doesNotMatch(WEEKLY_BRIEF_REQUEST, /gmail|outlook|slack|salesforce/i);
});
