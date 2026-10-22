import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeViewport } from './observe-viewport';

function viewportHost() {
  const host = Object.assign(new EventTarget(), {
    innerHeight: 844,
    visualViewport: Object.assign(new EventTarget(), { height: 844, offsetTop: 0 }),
    requestAnimationFrame: (callback: FrameRequestCallback) => { pending.set(++id, callback); return id; },
    cancelAnimationFrame: (key: number) => { pending.delete(key); },
  });
  let id = 0;
  const pending = new Map<number, FrameRequestCallback>();
  return {
    host: host as unknown as Parameters<typeof observeViewport>[0],
    change(height: number, top = 0) { Object.assign(host.visualViewport, { height, offsetTop: top }); },
    resizeLayout(height: number) { host.innerHeight = height; host.dispatchEvent(new Event('resize')); },
    burst() {
      host.dispatchEvent(new Event('resize'));
      host.visualViewport.dispatchEvent(new Event('resize'));
      host.visualViewport.dispatchEvent(new Event('scroll'));
    },
    flush() { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(cb => cb(1)); },
    pending,
  };
}

test('keyboard resize and pan bursts publish the latest geometry once per frame', () => {
  const fixture = viewportHost();
  const updates: unknown[] = [];
  const stop = observeViewport(fixture.host, value => updates.push(value));
  fixture.change(500); fixture.burst();
  fixture.change(410, 40); fixture.burst();
  assert.equal(updates.length, 1);
  assert.equal(fixture.pending.size, 1);
  fixture.flush();
  assert.deepEqual(updates[1], { top: 40, height: 410, bottomInset: 394 });
  fixture.burst(); fixture.flush();
  assert.equal(updates.length, 2, 'unchanged frames must not notify screens');
  stop();
});

test('a layout resize that already avoids the keyboard does not lift controls twice', () => {
  const fixture = viewportHost();
  const updates: unknown[] = [];
  const stop = observeViewport(fixture.host, value => updates.push(value));
  fixture.change(410); fixture.resizeLayout(410); fixture.flush();
  assert.deepEqual(updates.at(-1), { top: 0, height: 410, bottomInset: 0 });
  fixture.change(844); fixture.resizeLayout(844); fixture.flush();
  assert.deepEqual(updates.at(-1), { top: 0, height: 844, bottomInset: 0 });
  stop();
});

test('unmount cancels the pending frame and all viewport listeners', () => {
  const fixture = viewportHost();
  let calls = 0;
  const stop = observeViewport(fixture.host, () => calls++);
  fixture.change(410); fixture.burst(); stop(); fixture.flush();
  assert.equal(fixture.pending.size, 0);
  fixture.burst(); fixture.flush();
  assert.equal(calls, 1);
});

test('first-focus resize preserves usable height and follows the native focus pan', () => {
  const fixture = viewportHost();
  const updates: Array<{ top: number; height: number; bottomInset: number }> = [];
  const stop = observeViewport(fixture.host, value => updates.push(value));
  fixture.change(320, 340); fixture.resizeLayout(320); fixture.flush();
  assert.deepEqual(updates.at(-1), { top: 340, height: 320, bottomInset: 0 });
  fixture.change(320, 0); fixture.burst(); fixture.flush();
  assert.deepEqual(updates.at(-1), { top: 0, height: 320, bottomInset: 0 }, 'the shell must follow a cleared pan without losing height');
  fixture.change(844, 0); fixture.resizeLayout(844); fixture.flush();
  assert.deepEqual(updates.at(-1), { top: 0, height: 844, bottomInset: 0 });
  stop();
});
