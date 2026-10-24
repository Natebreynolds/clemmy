/**
 * Run: npx tsx --test src/lib/fold-pages.test.ts   (from apps/mobile-web)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldPagesShown } from './fold-pages.js';

test('two pages show only for a vertical fold in a window wide enough for both', () => {
  assert.equal(foldPagesShown({ dataset: { foldAxis: 'vertical' } }, true), true);
  // Turned, the crease runs across the screen: one page, read top to bottom.
  assert.equal(foldPagesShown({ dataset: { foldAxis: 'horizontal' } }, true), false);
  // A narrow window (Split View, the closed phone) keeps the single-page layout.
  assert.equal(foldPagesShown({ dataset: { foldAxis: 'vertical' } }, false), false);
  // A flat display publishes no fold at all.
  assert.equal(foldPagesShown({ dataset: {} }, true), false);
});
