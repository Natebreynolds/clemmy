/**
 * The composer model popover must keep Brain / Workers / Judge inside its
 * card, and the card inside the window. Native <select> min-content is the
 * longest option, so the control column has to be allowed to shrink.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('./ModelPicker.tsx', import.meta.url), 'utf8');

test('role rows shrink: grid minmax, full-width triggers, overflow clipped', () => {
  assert.match(SOURCE, /grid-cols-\[7\.5rem_minmax\(0,1fr\)\]/, 'the control column must be allowed to shrink below option min-content');
  assert.match(SOURCE, /flex h-8 w-full min-w-0/, 'Brain trigger fills the same column as Workers/Judge');
  assert.match(SOURCE, /w-full min-w-0 appearance-none/, 'native selects cannot size to the longest option');
  assert.match(SOURCE, /overflow-y-auto overflow-x-hidden/, 'the popover scrolls inside its height and clips sideways overflow');
});

test('the popover is placed against the window, not inside the composer', () => {
  // The Space dock is 400px wide inside a scrolling <main>: an absolutely
  // positioned 420px card there was cut off at the window's left side.
  assert.match(SOURCE, /createPortal\(/);
  assert.match(SOURCE, /placePopover\(\{/);
  assert.match(SOURCE, /viewport: \{ width: document\.documentElement\.clientWidth, height: document\.documentElement\.clientHeight \}/);
  assert.match(SOURCE, /maxHeight: p\.maxHeight/);
  assert.match(SOURCE, /window\.addEventListener\('scroll', place, true\)/);
  assert.doesNotMatch(SOURCE, /absolute bottom-full right-0/);
});

test('keyboard and pointer: Escape returns focus to the chip; outside clicks and focus close it', () => {
  assert.match(SOURCE, /e\.key === 'Escape'\) \{ e\.stopPropagation\(\); close\(true\);/);
  assert.match(SOURCE, /if \(returnFocus\) chipRef\.current\?\.focus\(\)/);
  assert.match(SOURCE, /document\.addEventListener\('focusin', onFocus\)/);
  assert.match(SOURCE, /popRef\.current\?\.focus\(\)/);
});

test('a change is called saved only when the daemon reads back the same brain', () => {
  assert.match(SOURCE, /brainMismatch = picked !== null && roles\.saved === 'brain' && !roles\.fetching && roles\.brainValue !== picked/);
  assert.match(SOURCE, /That change didn’t take/);
  assert.doesNotMatch(SOURCE, /min-w-0 flex-1 truncate">\s*\{roles\.error/);
});

test('Workers and Judge stay native selects with a full-width label', () => {
  assert.match(SOURCE, /aria-label=\{label\}/);
  assert.match(SOURCE, /label="Workers model"/);
  assert.match(SOURCE, /label="Judge model"/);
  assert.equal([...SOURCE.matchAll(/<RoleSelect/g)].length, 2);
});
