import assert from 'node:assert/strict';
import test from 'node:test';
import { dismissExploration, explorationDraftStamp, explorationWasDismissed, onboardingCompletionNavigation,
  onboardingDraftReturn, onboardingModelAccounts, readOnboardingEntry } from './onboarding-entry';

test('explore opens Today without remembered-chat or auto-send flags; ready opens existing editable new chat', () => {
  const explore = onboardingCompletionNavigation(true, 303_040_101);
  assert.equal(explore.pathname, '/chat'); assert.equal('newChat' in explore.state, false); assert.equal('prompt' in explore.state, false);
  const ready = onboardingCompletionNavigation(false, 303_040_102);
  assert.equal(ready.state.newChat, 303_040_102); assert.equal(ready.state.onboardingEntry.intent, 'ready');
  const accounts = onboardingModelAccounts(explore.state.onboardingEntry);
  const back = onboardingDraftReturn(accounts.state)!;
  assert.equal(explorationDraftStamp('/chat', explore.state), explorationDraftStamp('/chat', back.state));
  assert.equal(explorationDraftStamp('/chat/session:other', back.state), undefined);
  assert.equal(explorationDraftStamp('/chat', ready.state), undefined);
  assert.equal(onboardingDraftReturn({}), null);
});
test('only a valid explicit entry can claim an exploration draft or notice', () => {
  const valid = onboardingCompletionNavigation(true, 303_040_103).state;
  for (const state of [undefined, {}, { onboardingEntry: { ...valid.onboardingEntry, intent: 'unknown' } },
    { onboardingEntry: { ...valid.onboardingEntry, stamp: '303040103' } },
    { onboardingEntry: { ...valid.onboardingEntry, stamp: -1 } }, Object.create(valid),
    { onboardingEntry: Object.create(valid.onboardingEntry) }]) assert.equal(readOnboardingEntry(state), null);
});
test('dismissal is retained locally for the exact entry and does not create a returning-user prompt', () => {
  let stored: string | null = null;
  const storage = { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } };
  const first = onboardingCompletionNavigation(true, 303_040_104).state.onboardingEntry;
  const second = onboardingCompletionNavigation(true, 303_040_105).state.onboardingEntry;
  assert.equal(explorationWasDismissed(first, storage), false);
  dismissExploration(first, storage);
  assert.equal(explorationWasDismissed(first, storage), true);
  assert.equal(explorationWasDismissed(second, storage), false);
  assert.equal(readOnboardingEntry(null), null);
  assert.match(stored!, /303040104/);
});
