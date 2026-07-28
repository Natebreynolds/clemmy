/** Run: npx tsx --test apps/console-web/src/lib/inbox.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseAttentionRows, type NotificationRow } from './inbox.js';

const row = (id: string, title: string, createdAt: string): NotificationRow => ({ id, title, createdAt });

test('duplicate workflow needs-attention rows collapse to the newest with a count', () => {
  const collapsed = collapseAttentionRows([
    row('n1', 'Workflow needs attention: morning-prospect-prep', '2026-07-27T10:00:00Z'),
    row('n2', 'Workflow needs attention: morning-prospect-prep', '2026-07-27T12:00:00Z'),
    row('n3', 'Workflow needs attention: morning-prospect-prep', '2026-07-27T11:00:00Z'),
    row('n4', 'Workflow needs attention: weekly-review', '2026-07-27T09:00:00Z'),
  ]);
  assert.equal(collapsed.length, 2);
  // Newest of the duplicate group leads, carrying the earlier two.
  assert.equal(collapsed[0].row.id, 'n2');
  assert.equal(collapsed[0].collapsedCount, 2);
  assert.deepEqual(collapsed[0].groupIds, ['n2', 'n3', 'n1']);
  // The distinct workflow keeps its own row, no count.
  assert.equal(collapsed[1].row.id, 'n4');
  assert.equal(collapsed[1].collapsedCount, 0);
});

test('unrelated titles never merge; ordering is newest-first across groups', () => {
  const collapsed = collapseAttentionRows([
    row('a', 'Task blocked: deploy snapshot', '2026-07-27T08:00:00Z'),
    row('b', 'Task blocked: deploy snapshot', '2026-07-27T09:30:00Z'),
    row('c', 'Needs input: which channel?', '2026-07-27T09:00:00Z'),
  ]);
  assert.deepEqual(collapsed.map((c) => c.row.id), ['b', 'c']);
  assert.equal(collapsed[0].collapsedCount, 1);
});
