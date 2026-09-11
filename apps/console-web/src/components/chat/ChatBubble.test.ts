/**
 * A live turn's story is the activity card. A hollow reply shell ("Reply
 * lands here" / "Stopped." in an 80%-wide card) is wasted canvas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('./ChatBubble.tsx', import.meta.url), 'utf8');

test('live with no tokens does not render a hollow reply card', () => {
  assert.doesNotMatch(SOURCE, /Reply lands here as soon as it/);
  assert.doesNotMatch(SOURCE, /Working out the steps/);
  assert.match(SOURCE, /STOPPED_PLACEHOLDER = 'Stopped\.'/);
  assert.match(SOURCE, /stoppedPlaceholder/);
  assert.match(SOURCE, /showReplyCard && \(/);
  assert.match(SOURCE, /hasReplyText/);
});

test('the assistant column is not unconditionally flex-1', () => {
  assert.match(SOURCE, /const fillColumn = live \|\| showReplyCard/);
  assert.match(SOURCE, /fillColumn && 'w-full'/);
  assert.match(SOURCE, /min-w-0 max-w-\[80%\]',\s*fillColumn && 'w-full'/);
});

test('Stop before tokens still offers background on the live card', () => {
  assert.match(SOURCE, /live && !hasReplyText && onBackground/);
  assert.match(SOURCE, /BackgroundControl/);
});
