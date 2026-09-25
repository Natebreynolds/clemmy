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
  assert.match(SOURCE, /onAnswer\?: \(text: string\)/);
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
