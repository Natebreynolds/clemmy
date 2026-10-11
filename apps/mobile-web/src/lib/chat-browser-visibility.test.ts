import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationBrowsersInUse } from './chat-browser-visibility';

test('an unused conversation and terminal browser history do not create a standing shortcut', () => {
  assert.deepEqual(conversationBrowsersInUse([]), []);
  assert.deepEqual(conversationBrowsersInUse([{ state: 'stopped' as const }, { state: 'expired' as const }]), []);
});

test('starting, active, stopping and uncertain browser work remains reachable', () => {
  const work = ['starting', 'active', 'stopping', 'uncertain'].map(state => ({ state: state as 'starting' | 'active' | 'stopping' | 'uncertain' }));
  assert.deepEqual(conversationBrowsersInUse([...work, { state: 'stopped' as const }]), work);
});

test('unconfirmed return of control stays visible even beside a terminal status', () => {
  const pending = { state: 'stopped' as const, returnPending: true };
  assert.deepEqual(conversationBrowsersInUse([pending]), [pending]);
});
