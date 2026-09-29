import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentFromSearch,
  destinationSearch,
  inboxNotificationFromSearch,
  projectFromSearch,
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
  for (const search of ['?tab=chats', '?notification=n1', '?workspace=w1', '?tab=activity&run=s1', '?tab=projects&project=p1', '?pair=t', '?adopt=t']) {
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

test('a project link opens a project only on the Projects tab', () => {
  assert.equal(tabFromSearch('?tab=projects'), 'projects');
  assert.equal(projectFromSearch('?tab=projects&project=prj_1'), 'prj_1');
  assert.equal(projectFromSearch('?tab=projects'), null, 'the tab alone is the list');
  assert.equal(projectFromSearch('?project=prj_1'), null, 'a project outside Projects is not a destination');
  assert.equal(projectFromSearch('?tab=agents&project=prj_1'), null);
  assert.equal(projectFromSearch('?tab=projects&project=%20'), null);
});

test('a project rides only on the Projects tab, and reads back as written', () => {
  assert.equal(destinationSearch({ tab: 'projects' }), '?tab=projects');
  const search = destinationSearch({ tab: 'projects', projectId: 'prj 1/a' });
  assert.equal(tabFromSearch(search), 'projects');
  assert.equal(projectFromSearch(search), 'prj 1/a');
  assert.equal(destinationSearch({ tab: 'chats', projectId: 'prj_1' }), '?tab=chats',
    'a project never rides along to a tab that cannot show it');
  assert.equal(destinationSearch({ tab: 'projects', projectId: 'prj_1', runId: 's1', notificationId: 'n1' }), '?tab=projects&project=prj_1');
});

test('an agent link opens an agent only on the Agents tab', () => {
  assert.equal(agentFromSearch('?tab=agents&agent=agt_1'), 'agt_1');
  assert.equal(agentFromSearch('?tab=projects&agent=agt_1'), null);
  assert.equal(agentFromSearch('?tab=agents'), null);
  assert.equal(destinationSearch({ tab: 'agents', agentId: 'agt_1', projectId: 'prj_1' }), '?tab=agents&agent=agt_1');
  assert.equal(destinationSearch({ tab: 'projects', agentId: 'agt_1' }), '?tab=projects');
});
