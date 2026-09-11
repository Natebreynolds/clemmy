/**
 * The composer model popover must keep Brain / Workers / Judge inside the
 * 420px card. Native <select> min-content is the longest option, so the
 * control column has to be allowed to shrink.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('./ModelPicker.tsx', import.meta.url), 'utf8');

test('role rows shrink: grid minmax, full-width triggers, overflow clipped', () => {
  assert.match(SOURCE, /grid-cols-\[7\.5rem_minmax\(0,1fr\)\]/, 'the control column must be allowed to shrink below option min-content');
  assert.match(SOURCE, /flex h-8 w-full min-w-0/, 'Brain trigger fills the same column as Workers/Judge');
  assert.match(SOURCE, /w-full min-w-0 appearance-none/, 'native selects cannot size to the longest option');
  assert.match(SOURCE, /w-\[420px\] overflow-hidden/, 'the popover clips any leftover overflow');
});

test('Workers and Judge stay native selects with a full-width label', () => {
  assert.match(SOURCE, /aria-label=\{label\}/);
  assert.match(SOURCE, /label="Workers model"/);
  assert.match(SOURCE, /label="Judge model"/);
  assert.equal([...SOURCE.matchAll(/<RoleSelect/g)].length, 2);
});
