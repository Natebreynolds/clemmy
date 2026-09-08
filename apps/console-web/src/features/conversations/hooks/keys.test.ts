import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionsQuery, sessionKeys } from './keys.js';

test('every server-side filter reaches the wire, limit included', () => {
  // The rail asks for a larger page now that runs share it with chats. A limit
  // the query string drops would silently restore the 100-row default and let
  // a busy morning of runs bury yesterday's conversations.
  assert.equal(
    buildSessionsQuery({ q: 'pipeline', tag: 'folder:Sales', includeArchived: true, limit: 200 }),
    '?q=pipeline&tag=folder%3ASales&includeArchived=1&limit=200',
  );
  assert.equal(buildSessionsQuery({}), '');
  assert.equal(buildSessionsQuery({ limit: 200 }), '?limit=200');
});

test('the list cache key separates one server-side filter set from another', () => {
  assert.notDeepEqual(sessionKeys.list({ limit: 200 }), sessionKeys.list({ limit: 100 }));
  assert.deepEqual(sessionKeys.list({ q: 'a' }), sessionKeys.list({ q: 'a' }));
});
