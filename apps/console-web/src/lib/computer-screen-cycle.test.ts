import test from 'node:test';
import assert from 'node:assert/strict';
import { startComputerScreenCycle } from './computer-screen-cycle';

function fixture() {
  const shown: string[] = [];
  const timers: Array<{ run: () => void; delayMs: number; cancelled: boolean }> = [];
  let failures = 0;
  let sequence = 0;
  const cycle = startComputerScreenCycle({
    source: () => `capture:${++sequence}`,
    show: source => shown.push(source),
    fail: () => { failures++; },
    schedule: (run, delayMs) => {
      const timer = { run, delayMs, cancelled: false }; timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  });
  return { cycle, shown, timers, failures: () => failures };
}

test('a slow capture stays in flight until it loads, then refreshes two seconds later', () => {
  const f = fixture();
  assert.deepEqual(f.shown, ['capture:1']);
  assert.equal(f.timers.length, 0, 'a 30-second capture is never replaced by a two-second interval');
  f.cycle.loaded('capture:1');
  assert.equal(f.timers[0].delayMs, 2_000);
  assert.equal(f.shown.length, 1, 'a successful picture remains visible during the refresh delay');
  f.timers[0].run();
  assert.deepEqual(f.shown, ['capture:1', 'capture:2']);
  f.cycle.loaded('capture:1');
  assert.equal(f.timers.length, 1, 'an old image cannot schedule another capture while the next one waits');
  f.cycle.loaded('capture:2');
  assert.equal(f.timers.length, 2);
});

test('capture failure waits for an explicit new cycle instead of retrying in the background', () => {
  const f = fixture(); f.cycle.failed('capture:1');
  assert.equal(f.failures(), 1);
  f.cycle.loaded('capture:1'); f.cycle.failed('capture:1');
  assert.equal(f.failures(), 1);
  assert.equal(f.timers.length, 0);
  assert.equal(f.shown.length, 1);
  const retry = fixture();
  assert.deepEqual(retry.shown, ['capture:1']);
  retry.cycle.loaded('capture:1');
  assert.equal(retry.timers.length, 1);
});

test('closing, changing chat or disconnecting cancels refresh and ignores a late image', () => {
  for (const cause of ['close', 'chat change', 'disconnect']) {
    const pending = fixture(); pending.cycle.stop(); pending.cycle.loaded('capture:1'); pending.cycle.failed('capture:1');
    assert.equal(pending.timers.length, 0, cause);
    assert.equal(pending.failures(), 0, cause);
    const loaded = fixture(); loaded.cycle.loaded('capture:1'); loaded.cycle.stop();
    assert.equal(loaded.timers[0].cancelled, true, cause);
    loaded.timers[0].run();
    assert.equal(loaded.shown.length, 1, cause);
  }
});
