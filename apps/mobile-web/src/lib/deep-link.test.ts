import assert from 'node:assert/strict';
import test from 'node:test';
import {
  destinationSearch,
  inboxNotificationFromSearch,
  runFromSearch,
  searchHasDestination,
  tabFromSearch,
} from './deep-link';

test('a push URL resolves to its exact tab and addressed row', () => {
  assert.equal(tabFromSearch('?tab=inbox&notification=n1'), 'inbox');
  assert.equal(inboxNotificationFromSearch('?tab=inbox&notification=n1'), 'n1');
  assert.equal(tabFromSearch('?tab=nonsense'), 'home', 'an unknown tab falls back to Home');
  assert.equal(tabFromSearch(''), 'home');
});

test('a run link opens a run only on the tab that owns the run view', () => {
  assert.equal(runFromSearch('?tab=activity&run=sess-42'), 'sess-42');
  assert.equal(runFromSearch('?run=sess-42'), null, 'a run outside Activity is not a destination');
  assert.equal(runFromSearch('?tab=inbox&run=sess-42'), null);
  assert.equal(runFromSearch('?tab=activity&run='), null);
});

test('any addressed destination outranks the open-on-launch preference', () => {
  for (const search of ['?tab=chats', '?notification=n1', '?workspace=w1', '?tab=activity&run=s1', '?pair=t', '?adopt=t']) {
    assert.equal(searchHasDestination(search), true, search);
  }
  assert.equal(searchHasDestination(''), false);
});

test('a tab only carries the parameters it can act on', () => {
  assert.equal(destinationSearch({ tab: 'home' }), '');
  assert.equal(destinationSearch({ tab: 'inbox', notificationId: 'n1' }), '?tab=inbox&notification=n1');
  assert.equal(destinationSearch({ tab: 'activity', runId: 'sess-42' }), '?tab=activity&run=sess-42');
  assert.equal(
    destinationSearch({ tab: 'chats', notificationId: 'n1', runId: 'sess-42' }),
    '?tab=chats',
    'a stale selection never rides along to a tab that cannot show it',
  );
});

test('round trip: what destinationSearch writes is what the parsers read back', () => {
  const search = destinationSearch({ tab: 'activity', runId: 'sess/42 a' });
  assert.equal(tabFromSearch(search), 'activity');
  assert.equal(runFromSearch(search), 'sess/42 a');
});
