/**
 * Run: npx tsx --test src/lib/chat-chrome.test.ts   (from apps/mobile-web)
 *
 * Pin the thread chrome we just unified with AskCapsule: SVG send/stop/back,
 * 16px composer type, keyboard-safe dock, title that actually truncates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('thread composer is a docked card with SVG send, not unicode chrome', () => {
  // The composer is one component (components/Composer.tsx) shared by the
  // thread dock and the Home capsule; the thread mounts it inside .chat-dock.
  const composer = read('../components/Composer.tsx');
  assert.match(composer, /enterkeyhint="send"/);
  assert.match(composer, /class="chat-send"/);
  assert.match(composer, /<path d="M12 19V5M5 12l7-7 7 7" \/>/);
  assert.match(composer, /class="chat-stop"/);
  assert.match(composer, /<rect x="7" y="7" width="10" height="10" rx="1.5"/);
  assert.doesNotMatch(composer, />\s*↑\s*</);
  assert.doesNotMatch(composer, />\s*■\s*</);
  // No focus rectangle inside the card: the card itself marks focus.
  const css = read('../styles.css');
  assert.match(css, /\.composer-input:focus-visible \{[\s\S]*?outline: none/);
  const chat = read('../screens/Chat.tsx');
  assert.match(chat, /class="chat-dock"/);
  assert.match(chat, /<ChatBackButton /);
  assert.doesNotMatch(chat, /aria-label="Back">←</);
  assert.doesNotMatch(chat, />\s*↑\s*</);
  assert.doesNotMatch(chat, />\s*■\s*</);
});

test('thread title beats the page h2 and truncates beside Brain', () => {
  const css = read('../styles.css');
  assert.match(css, /\.app-main \.chat-header h2\.chat-title \{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-width:\s*0;[\s\S]*?font-size:\s*var\(--t-body\)/);
  assert.match(css, /\.composer-input,[\s\S]*?font-size:\s*16px/);
  assert.match(css, /\.chat-dock \{[\s\S]*?position:\s*fixed/);
  assert.match(css, /\.composer \{[\s\S]*?backdrop-filter:\s*blur\(20px\)/);
});

test('chat preview is gated behind ?preview=chat and never the default render', () => {
  const main = read('../main.tsx');
  assert.match(main, /get\('preview'\)/);
  assert.match(main, /preview === 'chat' \? <ChatPreview \/> : <App \/>/);
});

test('the phone shows a confirmed change in another app while the turn is still live', () => {
  const chat = read('../screens/Chat.tsx');
  assert.match(chat, /\{thinking \? <OutsideWork activity=\{message\.activity\} \/> : <TurnReceipt message=\{message\} sessionId=\{sessionId\} \/>\}/,
    'desktop parity: confirmed writes show at once; the receipt line waits for the end');
  assert.match(chat, /function TurnReceipt[\s\S]*?<OutsideWork activity=\{message\.activity\} \/>/,
    'the finished receipt keeps the cards in the same place');
});

test('a notice is the app’s status line with its action, and pills carry what was kept, as on the desktop', () => {
  const chat = read('../screens/Chat.tsx');
  // One wording for both surfaces, from chat-engine.
  assert.match(chat, /const notice = terminalNoticeLine\(t\);/);
  assert.match(chat, /terminalStatusPill\(t, \{ wordless: !turnText\.showReply \}\)/);
  assert.match(chat, /retainedOutsideChange\(t\)/);
  // A decided card keeps its decision on the card; it no longer vanishes.
  assert.doesNotMatch(chat, /cardDecisionNoticeOnly\(message\)\) return null/);
  assert.match(chat, /message\.approval\.resolution === 'approved' \? 'Approved' : 'Declined'/);
  assert.match(chat, /onAnswer\(NOTICE_ACTION_LABEL\.try_again\)/);
  assert.match(chat, /onChangeModel=\{\(\) => setConversationPanel\('model'\)\}/);
  assert.doesNotMatch(chat, /'Stopped here — your work is kept'/, 'the hand-written typed pills are gone');
  const chats = read('../screens/Chats.tsx');
  assert.equal(chats.match(/onOpenSettings=\{onOpenSettings\}/g)?.length, 2, 'both chat mounts can open Settings');
});

test('the phone review chip reads the host’s ruling, and its finding is detail labelled as the review', () => {
  const chat = read('../screens/Chat.tsx');
  assert.match(chat, /turnReview\(message\.activity, message\.terminal\)/);
  assert.match(chat, /needs_recheck: \{ label: 'Needs a fresh check', ok: false \}/);
  assert.match(chat, /reveal && reviewNote \? <span class="receipt-model receipt-review-note">Review: \{reviewNote\}<\/span>/);
});
