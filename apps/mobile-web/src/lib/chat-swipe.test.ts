/**
 * Run: npx tsx --test src/lib/chat-swipe.test.ts   (from apps/mobile-web)
 *
 * A row reveals its actions on a clear leftward drag, settles open past half
 * of them, and never fights the list's own vertical scroll.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SWIPE_ACTIONS_WIDTH, swipeIntent, swipeOffset, swipeSettles } from './chat-swipe';

test('a drag says which way it is going only once it has moved', () => {
  assert.equal(swipeIntent(4, 3), null);
  assert.equal(swipeIntent(-30, 6), 'horizontal');
  assert.equal(swipeIntent(5, 40), 'vertical', 'a scroll stays a scroll');
});

test('the row follows the finger left, never right of rest, with a soft stop', () => {
  assert.equal(swipeOffset(0, 40), 0);
  assert.equal(swipeOffset(0, -60), -60);
  assert.equal(swipeOffset(0, -500), -(SWIPE_ACTIONS_WIDTH + 24));
  assert.equal(swipeOffset(-SWIPE_ACTIONS_WIDTH, 50), -SWIPE_ACTIONS_WIDTH + 50, 'an open row closes from where it is');
});

test('it settles open past half of its actions', () => {
  assert.equal(swipeSettles(-(SWIPE_ACTIONS_WIDTH / 2) - 1), 'open');
  assert.equal(swipeSettles(-(SWIPE_ACTIONS_WIDTH / 2) + 1), 'closed');
});
