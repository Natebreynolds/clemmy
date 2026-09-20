/**
 * A reopened conversation is not a lesser conversation, and a replay is not a
 * control panel.
 *
 * TWO REGRESSIONS THIS CLOSES.
 *
 * 1. `/chat` wired Continue-in-background and plan Prepare; `/chat/:sessionId`
 *    did not. Reopening a conversation — the way most of them are reached —
 *    silently dropped both, with nothing on screen to say why.
 * 2. The read-only transcript passed `onApprove={() => {}} onReject={() => {}}`,
 *    so a historical approval drew live-looking Approve / Not now buttons that
 *    did nothing when clicked. A surface that cannot carry a decision must not
 *    draw the controls for one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const thread = read('./chat/ConversationThread.tsx');
const bubble = read('../../components/chat/ChatBubble.tsx');

test('a reopened conversation keeps every control the new-chat surface has', () => {
  for (const [prop, what] of [
    ['onBackground', 'Continue in background'],
    ['onPreparePlan', 'plan Prepare'],
    ['onStop', 'Stop'],
    ['onRetryPending', 'retry an unconfirmed send'],
  ] as [string, string][]) {
    assert.ok(thread.includes(prop),
      `ConversationThread dropped ${prop} — "${what}" vanishes when a conversation is reopened.`);
  }
});

test('the read-only transcript renders no decision handlers at all', () => {
  assert.ok(!/onApprove=\{\(\) => \{\}\}/.test(thread),
    'A no-op onApprove is back: the replay thread draws buttons that do nothing.');
  assert.ok(!/onReject=\{\(\) => \{\}\}/.test(thread),
    'A no-op onReject is back: the replay thread draws buttons that do nothing.');
});

test('the bubble only draws decision controls when a decision can land', () => {
  assert.match(bubble, /onApprove\?:/,
    'ChatBubble made onApprove required again, forcing callers to invent a handler.');
  assert.ok(bubble.includes('const canDecide = Boolean(onApprove && onReject)'),
    'ChatBubble lost its canDecide guard; a replay thread renders live controls again.');
  assert.match(bubble, /record of what was asked/,
    'The record-not-control copy is gone; a replay approval needs to say what it is.');
});
