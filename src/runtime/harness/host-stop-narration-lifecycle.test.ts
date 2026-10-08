import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOwnedHostStopNarration } from './host-stop-narration-lifecycle.js';

function barrier<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}
const owned = () => {};
const notStopped = () => false;

test('a successful narration keeps the same request signal and passes its final ownership fence', async () => {
  let checks = 0;
  const value = await runOwnedHostStopNarration({ deadlineMs: 45_000, isStopped: notStopped,
    assertOwned: () => { checks += 1; },
    work: async (scope) => { scope.assertCurrent(); assert.equal(scope.signal.aborted, false); return 'words'; },
  });
  assert.equal(value, 'words');
  assert.ok(checks >= 3);
});

test('an already stopped source never enters preparation or the provider', async () => {
  let work = 0;
  assert.equal(await runOwnedHostStopNarration({ deadlineMs: 45_000, assertOwned: owned,
    isStopped: () => true, work: async () => { work += 1; return 'words'; },
  }), undefined);
  assert.equal(work, 0);
});

test('Stop during preparation prevents dispatch after the pending preparation resolves', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const started = barrier();
  const prepared = barrier();
  let stopped = false;
  let dispatches = 0;
  const pending = runOwnedHostStopNarration({ deadlineMs: 45_000, assertOwned: owned,
    isStopped: () => stopped,
    work: async (scope) => { started.release(); await prepared.promise; scope.assertCurrent(); dispatches += 1; return 'words'; },
  });
  await started.promise;
  stopped = true;
  t.mock.timers.tick(250);
  assert.equal(await pending, undefined);
  prepared.release();
  await prepared.promise;
  await Promise.resolve();
  assert.equal(dispatches, 0);
});

test('Stop aborts the in-flight request and late words from an ignoring provider are discarded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const started = barrier<AbortSignal>();
  const response = barrier<string>();
  let stopped = false;
  const pending = runOwnedHostStopNarration({ deadlineMs: 45_000, assertOwned: owned,
    isStopped: () => stopped,
    work: async (scope) => { started.release(scope.signal); return response.promise; },
  });
  const signal = await started.promise;
  stopped = true;
  t.mock.timers.tick(250);
  assert.equal(await pending, undefined);
  assert.equal(signal.aborted, true);
  response.release('late words');
  await response.promise;
  await Promise.resolve();
  assert.equal(await pending, undefined);
});

test('an outer cancellation keeps its own reason and does not manufacture owner Stop evidence', async () => {
  const outer = new AbortController();
  const started = barrier<AbortSignal>();
  const response = barrier<string>();
  let stopChecks = 0;
  const reason = new Error('transport caller retired');
  const pending = runOwnedHostStopNarration({ signal: outer.signal, deadlineMs: 45_000, assertOwned: owned,
    isStopped: () => { stopChecks += 1; return false; },
    work: async (scope) => { started.release(scope.signal); return response.promise; },
  });
  const signal = await started.promise;
  outer.abort(reason);
  assert.equal(await pending, undefined);
  assert.equal(signal.reason, reason);
  assert.equal(stopChecks, 1);
  response.release('discarded');
});

test('loss of exact ownership fences a response even before the next Stop poll', async () => {
  const started = barrier();
  const response = barrier<string>();
  let current = true;
  const pending = runOwnedHostStopNarration({ deadlineMs: 45_000, isStopped: notStopped,
    assertOwned: () => { if (!current) throw new Error('a successor owns this source'); },
    work: async () => { started.release(); return response.promise; },
  });
  await started.promise;
  current = false;
  response.release('stale words');
  assert.equal(await pending, undefined);
});

test('the existing narration deadline also bounds a provider that ignores abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const started = barrier<AbortSignal>();
  const response = barrier<string>();
  const pending = runOwnedHostStopNarration({ deadlineMs: 45_000, assertOwned: owned, isStopped: notStopped,
    work: async (scope) => { started.release(scope.signal); return response.promise; },
  });
  const signal = await started.promise;
  t.mock.timers.tick(45_000);
  assert.equal(await pending, undefined);
  assert.equal(signal.aborted, true);
  assert.match(String(signal.reason), /deadline/);
  response.release('discarded');
});
