/**
 * Run: node scripts/run-tests-isolated.mjs apps/mobile-web/src/lib/back-gesture.test.ts
 *
 * The iOS shell already sets allowsBackForwardNavigationGestures = true
 * (PinnedWebView.swift:61). The app simply never created history entries, so
 * the gesture had nothing to navigate and a deep view could only be left via
 * the arrow at the top of a scrolling screen — meaning a long chat had to be
 * scrolled all the way up before it could be closed.
 *
 * Both failure modes here are SILENT, which is why they are pinned:
 *   - closing by TAP without unwinding the pushed entry: the next swipe
 *     appears to do nothing, because it consumes the stale entry instead;
 *   - closing by SWIPE and then ALSO calling history.back(): one gesture
 *     travels two levels and can walk the user out of the app.
 *
 * These drive the real exported functions the hook calls. An earlier version
 * of this file asserted on its own fixture and proved nothing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

/** Minimal history double, installed before the module is imported. */
let pushed: unknown[] = [];
let backCalls = 0;
let popListener: (() => void) | null = null;

(globalThis as Record<string, unknown>).window = {
  history: {
    pushState: (state: unknown) => { pushed.push(state); },
    back: () => {
      backCalls += 1;
      // A real back() over a same-document entry fires popstate.
      popListener?.();
    },
  },
  addEventListener: (type: string, fn: () => void) => {
    if (type === 'popstate') popListener = fn;
  },
};

const {
  openBackEntry,
  closeBackEntry,
  abandonBackEntry,
  _resetBackGestureForTest,
  _backGestureDepthForTest,
} = await import('./back-gesture.js');

function reset(): void {
  pushed = [];
  backCalls = 0;
  _resetBackGestureForTest();
}

const settle = () => new Promise((r) => setTimeout(r, 5));

test('opening a deep view pushes exactly one history entry and navigates nothing', () => {
  reset();
  const id = openBackEntry(() => {});
  assert.equal(pushed.length, 1, 'one entry per deep view');
  assert.equal(backCalls, 0, 'opening must never navigate');
  assert.equal(_backGestureDepthForTest(), 1);
  assert.ok(id > 0);
});

test('the SWIPE closes the view, and the view must not navigate again', async () => {
  reset();
  let closed = 0;
  openBackEntry(() => { closed += 1; });

  popListener!();                       // the user swipes
  assert.equal(closed, 1, 'the swipe closes the view');
  assert.equal(_backGestureDepthForTest(), 0, 'the entry is consumed');
  assert.equal(backCalls, 0,
    'servicing a pop must not call back() — that would skip a level');
  await settle();
});

test('the TAP closes the view AND unwinds its entry, so the next swipe still works', async () => {
  reset();
  const id = openBackEntry(() => {});
  closeBackEntry(id);                   // the user taps the arrow

  assert.equal(backCalls, 1, 'a tap unwinds the entry it pushed');
  assert.equal(_backGestureDepthForTest(), 0,
    'a stale entry here is what makes the NEXT swipe look broken');
  await settle();
});

test('a swiped-away view closing itself afterwards is inert, not a second navigation', async () => {
  reset();
  let id = 0;
  id = openBackEntry(() => { closeBackEntry(id); });

  popListener!();                       // swipe -> close() -> closeBackEntry()
  await settle();
  assert.equal(backCalls, 0,
    'the close path must detect history already moved; otherwise one gesture '
    + 'travels two levels and eventually exits the app');
});

test('nested depth unwinds one level per gesture', async () => {
  reset();
  const closed: string[] = [];
  openBackEntry(() => closed.push('list'));
  openBackEntry(() => closed.push('detail'));
  assert.equal(_backGestureDepthForTest(), 2);

  popListener!();
  assert.deepEqual(closed, ['detail'], 'the innermost view closes first');
  assert.equal(_backGestureDepthForTest(), 1, 'the outer view is still open');
  await settle();
});

test('a swipe with nothing open is inert', () => {
  reset();
  popListener!();
  assert.equal(backCalls, 0);
  assert.equal(_backGestureDepthForTest(), 0);
});

test('unmounting while open drops the entry without navigating', () => {
  reset();
  const id = openBackEntry(() => {});
  abandonBackEntry(id);
  assert.equal(_backGestureDepthForTest(), 0,
    'a dangling entry would swallow the next back gesture');
  assert.equal(backCalls, 0, 'a tab switch is not a navigation');
});

test('a blocked history API still opens and closes the view', () => {
  const saved = (globalThis as Record<string, any>).window.history;
  (globalThis as Record<string, any>).window.history = {
    pushState: () => { throw new Error('blocked'); },
    back: () => { throw new Error('blocked'); },
  };
  reset();
  let closed = 0;
  const id = openBackEntry(() => { closed += 1; });
  closeBackEntry(id);
  assert.equal(_backGestureDepthForTest(), 0,
    'the in-page arrow must keep working when history is unavailable');
  void closed;
  (globalThis as Record<string, any>).window.history = saved;
});
