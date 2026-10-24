/**
 * Run: npx tsx --test src/lib/display-rail.test.ts   (from apps/mobile-web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { railSide } from './display-rail.js';

test('a deep side inset on a portrait window is a rail the places can stand in', () => {
  // The Duo's front screen: 466 x 678 with an 84pt trailing rail.
  assert.equal(railSide({ left: 0, right: 84 }, 466, 678), 'right');
  assert.equal(railSide({ left: 84, right: 0 }, 466, 678), 'left');
  // A notched phone on its side reserves ~59pt both sides: no rail, and not portrait.
  assert.equal(railSide({ left: 59, right: 59 }, 874, 402), null);
  // An ordinary phone held upright has no side inset.
  assert.equal(railSide({ left: 0, right: 0 }, 402, 874), null);
});
