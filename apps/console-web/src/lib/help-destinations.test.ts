import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_PLACES } from '../../../../packages/chat-engine/src/app-places';
import { helpDestinations } from './help-destinations';

test('Help presents one canonical page while compatibility links remain untouched', () => {
  const map = helpDestinations(APP_PLACES);
  assert.equal(map.length, new Set(map.map(place => place.desktop)).size);
  for (const id of ['needs-you', 'clem-thread', 'projects', 'help']) assert.equal(map.some(place => place.id === id), false);
  for (const id of ['today', 'inbox', 'work', 'agents', 'models', 'model-accounts']) assert.equal(map.some(place => place.id === id), true);
  assert.ok(APP_PLACES.some(place => place.id === 'clem-thread'), 'compatibility destinations remain unchanged');
});
