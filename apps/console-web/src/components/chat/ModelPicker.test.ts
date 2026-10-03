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

test('the helper and checker stay native selects with a full-width label, in the phone\'s words', () => {
  assert.match(SOURCE, /aria-label=\{label\}/);
  assert.match(SOURCE, /label="Model that helps in parallel"/);
  assert.match(SOURCE, /label="Model that checks the work"/);
  assert.doesNotMatch(SOURCE, />Brain<|>Workers<|>Judge</, 'one vocabulary with the phone and Settings');
  assert.equal([...SOURCE.matchAll(/<RoleSelect/g)].length, 2);
});

test('an agent pinned to a model: the chip names it on every composer, and a pick in the conversation lands after the switch', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  assert.match(SOURCE, /getAnsweringModel\(sessionId, agentId \?\? null\)/, 'the chip asks the daemon what answers next');
  assert.match(SOURCE, /const brain = agentModel\s*\?/, 'the chip names the agent\'s own model when it answers');
  assert.match(SOURCE, /await applyAgent\?\.\(\);[\s\S]{0,160}await roles\.onBrain\(value\)/,
    'a pending agent switch lands before the pick, so the pick is the later choice');
  assert.match(read('../../lib/model-roles.ts'), /invalidateQueries\(\{ queryKey: \['answering-model'\] \}\)/,
    'a pick re-reads what answers next');
  assert.match(read('./Composer.tsx'), /<ModelPicker sessionId=\{sessionId\} agentId=\{agentId\} applyAgent=\{applyAgent\} \/>/);
  for (const site of ['../../features/conversations/chat/ConversationThread.tsx', '../../screens/Chat.tsx', '../../screens/Home.tsx', '../../screens/AgentWorkspace.tsx']) {
    assert.match(read(site), /agentId=\{/, `${site} tells the chip which agent answers`);
  }
});

test('an approval card reads like a question card: Clem\'s question, why, the exact content, answers to tap; the owner\'s bubble reads their answer', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const bubble = read('./ChatBubble.tsx');
  assert.match(bubble, /const voicedApproval = message\.status === 'awaiting-approval' && !pendingAction\s*&& Boolean\(message\.approval\?\.preview\?\.ask\)/);
  assert.match(bubble, /\{message\.approval!\.preview!\.ask\}/);
  assert.match(bubble, /Exactly what happens/);
  assert.match(bubble, /voicedApproval \? \(\s*<ApprovalAnswers/);
  assert.match(bubble, /APPROVAL_ANSWER_WORDS\.approve/);
  assert.match(bubble, /Before you say yes/);
  for (const site of ['../../features/conversations/chat/ConversationThread.tsx', '../../screens/Chat.tsx', '../../screens/AgentWorkspace.tsx']) {
    assert.match(read(site), /displayText: APPROVAL_ANSWER_WORDS\[decision\]/, `${site} shows the owner's answer, not "approve apr-…"`);
  }
  assert.match(read('../../lib/useChat.ts'), /text: input\.displayText\?\.trim\(\) \|\| text/);
  assert.match(read('../../screens/Inbox.tsx'), /row\.presentation\?\.ask \|\| row\.subject \|\| row\.presentation\?\.action/);
});
