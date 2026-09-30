/**
 * A live turn's story is the work line. A hollow reply shell ("Reply lands
 * here" / "Stopped." in a wide empty card) is wasted canvas, and Clem's answer
 * reads as a page rather than sitting in a box.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('./ChatBubble.tsx', import.meta.url), 'utf8');
const WORK_LINE = readFileSync(new URL('./WorkLine.tsx', import.meta.url), 'utf8');
const RECEIPT = readFileSync(new URL('./TurnReceipt.tsx', import.meta.url), 'utf8');

test('live with no tokens does not render a hollow reply', () => {
  assert.doesNotMatch(SOURCE, /Reply lands here as soon as it/);
  assert.doesNotMatch(SOURCE, /Working out the steps/);
  assert.match(SOURCE, /STOPPED_PLACEHOLDER = 'Stopped\.'/);
  assert.match(SOURCE, /stoppedPlaceholder/);
  assert.match(SOURCE, /showReply && \(/);
  assert.match(SOURCE, /hasReplyText/);
});

test('the answer is typeset by the shared escaping renderer, never boxed', () => {
  assert.match(SOURCE, /renderMarkdown\(text, \{ workspaceLinks: false \}\)/);
  assert.doesNotMatch(SOURCE, /rounded-tl-sm border border-border bg-surface/,
    'the reply card is back: Clem\'s answer sits in a box again');
});

test('a running turn can always be moved to the background from its work line', () => {
  assert.match(SOURCE, /onBackground=\{live \? onBackground : undefined\}/);
  assert.match(WORK_LINE, /Move to background/);
});

test('suggested answers are buttons only where an answer can land', () => {
  // The answer may carry a connection resume (setup inside the task); the
  // buttons still land only where an answer can.
  assert.match(SOURCE, /onAnswer\?: \(text: string, resume\?: ConnectionResume\)/);
  assert.match(SOURCE, /const answerable = message\.status === 'awaiting-reply' && Boolean\(onAnswer\)/);
});

test('the receipt never lets an unchecked answer borrow a pass', () => {
  assert.match(RECEIPT, /review === 'checked'/);
  assert.match(RECEIPT, /Not checked/);
  assert.match(RECEIPT, /group-hover\/turn:opacity-100/, 'the model name shows on hover only');
});

test('suggested answers stop being buttons once anything follows the question', () => {
  for (const rel of ['../../screens/Chat.tsx', '../../features/conversations/chat/ConversationThread.tsx']) {
    const screen = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.match(screen, /onAnswer=\{index === chat\.messages\.length - 1 \?/, `${rel} offers answers on an old question`);
  }
});

test('an expired card says so instead of offering its controls, queued action or not', () => {
  // The host marks a card expired when nobody answered in its lifetime; a
  // queued action's Execute button must not come back on it.
  assert.match(SOURCE, /resolution === 'expired' \? 'Expired without an answer — it did not run\.'/);
  assert.match(SOURCE, /message\.approval\?\.resolution && \(!pendingAction \|\| message\.approval\.resolution === 'expired'\) \?/);
});

test('a confirmed change in another app shows while the turn is still live', () => {
  assert.match(SOURCE, /live\s*\?\s*<OutsideWorkCards activity=\{message\.activity\} \/>\s*:\s*<TurnReceipt/,
    'while the answer is written and checked, confirmed writes already show; the full receipt waits for the end');
  assert.match(RECEIPT, /export function OutsideWorkCards/);
  assert.match(RECEIPT, /<OutsideWorkCards activity=\{activity\}>/, 'the finished receipt keeps the cards in the same place');
  assert.match(RECEIPT, /const outside = outsideWorkCards\(activity\);\s*const workflows = workflowCards\(activity\);\s*if \(outside\.length === 0 && workflows\.length === 0 && !children\) return null;/,
    'only writes the provider confirmed become cards');
});
