import assert from 'node:assert/strict';
import test from 'node:test';
import { withDiscoveryDeadline } from './discovery-deadline.js';

test('a nineteen-second review does not expire an eight-second discovery budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let waited = 0;
  let returned = false;
  const result = withDiscoveryDeadline({ deadlineAt: Date.now() + 8_000,
    onModelWait: ms => { waited += ms; } }, async control => {
    await control.awaitModelReview(() => ready);
    assert.equal(control.signal.aborted, false);
    assert.equal(control.deadlineAt - Date.now(), 8_000);
    return 'current result';
  }).then(value => { returned = true; return value; });
  t.mock.timers.tick(19_000);
  await Promise.resolve();
  assert.equal(returned, false);
  release();
  assert.equal(await result, 'current result');
  assert.equal(waited, 19_000);
});

test('cancelling a pending review prevents late publication', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const owner = new AbortController();
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let published = false;
  const result = withDiscoveryDeadline({ deadlineAt: Date.now() + 8_000, signal: owner.signal }, async control => {
    await control.awaitModelReview(() => ready);
    if (!control.signal.aborted) published = true;
    return 'late';
  });
  owner.abort();
  assert.equal(await result, null);
  release();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(published, false);
});

test('ordinary metadata still expires and cannot publish late', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let published = false;
  const result = withDiscoveryDeadline({ deadlineAt: Date.now() + 8_000 }, async control => {
    await ready;
    if (!control.signal.aborted) published = true;
    return 'late';
  });
  t.mock.timers.tick(8_000);
  assert.equal(await result, null);
  release(); await Promise.resolve();
  assert.equal(published, false);
});
