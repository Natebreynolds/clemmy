import test from 'node:test';
import assert from 'node:assert/strict';
import { composeModeFromSearch, consumeComposeSearch } from './compose-route.js';

test('widget compose routes select only known controls in a new chat', () => {
  assert.equal(composeModeFromSearch('?tab=chats&compose=voice'), 'voice');
  assert.equal(composeModeFromSearch('?tab=chats&compose=dictate'), 'dictate');
  for (const query of ['?compose=voice', '?tab=spaces&compose=voice', '?tab=chats&compose=send', '?tab=chats&compose=voice&compose=dictate', '?tab=chats&tab=home&compose=voice']) {
    assert.equal(composeModeFromSearch(query), null);
  }
});

test('consuming a compose link prevents it from reopening on reload and retains other state', () => {
  assert.equal(consumeComposeSearch('?tab=chats&compose=voice'), '?tab=chats');
  assert.equal(consumeComposeSearch('?tab=chats&compose=dictate&other=kept'), '?tab=chats&other=kept');
});
