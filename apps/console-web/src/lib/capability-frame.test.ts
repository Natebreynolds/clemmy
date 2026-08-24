/**
 * Run: npx tsx --test apps/console-web/src/lib/capability-frame.test.ts
 *
 * Capability inventory is for the Full trace. The chat strip is the work —
 * a leftover Outlook pin on a sheet job is why this event stays off it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceActivity, type ActivityItem } from './useChat';

const EMPTY: ActivityItem[] = [];

test('capability_resolution does not appear in the chat strip', () => {
  const rows = reduceActivity(EMPTY, {
    type: 'capability_resolution',
    data: {
      entries: [
        { intent: 'outlook.calendar.view_day', kind: 'composio', identifier: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW', status: 'proven', connection: 'active', accountIdentity: 'user@example.com' },
        { intent: 'apify.google_search_scrape_public_firm_research', kind: 'composio', identifier: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', status: 'previously_failed', connection: 'active', failedAt: '2026-07-24T18:28:36.567Z' },
      ],
    },
  } as never);
  assert.equal(rows.length, 0);
});

test('an empty capability event stays silent', () => {
  assert.deepEqual(reduceActivity(EMPTY, { type: 'capability_resolution', data: { entries: [] } } as never), EMPTY);
});

test('deliverable_saved accumulates ONE rolling saved-files row', () => {
  let rows = reduceActivity(EMPTY, { type: 'deliverable_saved', data: { name: 'acme-corp.md', dir: 'drafts' } } as never);
  assert.equal(rows.length, 1);
  assert.match(rows[0].label, /Saved acme-corp\.md in drafts/);
  rows = reduceActivity(rows, { type: 'deliverable_saved', data: { name: 'baker-llp.md', dir: 'drafts' } } as never);
  rows = reduceActivity(rows, { type: 'deliverable_saved', data: { name: 'cole-law.md', dir: 'drafts' } } as never);
  assert.equal(rows.length, 1, 'files roll into one row, never N rows of noise');
  assert.equal(rows[0].count, 3);
  assert.match(rows[0].label, /Saved 3 files · latest cole-law\.md/);
  assert.equal(rows[0].tone, 'success');
});

test('the runtime publicSlug names the tool row when args are private', async () => {
  const { humanToolLabel } = await import('./toolLabels');
  assert.equal(humanToolLabel('composio_execute_tool', undefined, 'OUTLOOK_SEND_EMAIL'), 'outlook send email');
  assert.equal(humanToolLabel('composio_execute_tool', undefined, undefined), 'composio execute tool');
});

test('the visibility window: excerpts ride the deliverables row; glimpses land on tool rows', () => {
  let rows = reduceActivity(EMPTY, {
    type: 'deliverable_saved',
    data: { name: 'acme.md', dir: 'drafts', excerpt: 'Subject: Quick intro\n\nHi —' },
  } as never);
  assert.equal(rows[0].excerpt, 'Subject: Quick intro\n\nHi —');
  // A later save WITHOUT an excerpt keeps the last good peek.
  rows = reduceActivity(rows, { type: 'deliverable_saved', data: { name: 'baker.md', dir: 'drafts' } } as never);
  assert.equal(rows[0].count, 2);
  assert.ok(rows[0].excerpt?.startsWith('Subject:'));

  let tools = reduceActivity(EMPTY, { type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'c1', publicSlug: 'APIFY_RUN_ACTOR' } } as never);
  tools = reduceActivity(tools, {
    type: 'tool_returned',
    data: { tool: 'composio_execute_tool', callId: 'c1', ok: true, glimpse: { count: 12, key: 'records', fields: ['name', 'website'], sample: 'Acme Roofing' } },
  } as never);
  assert.equal(tools[0].label, 'apify run actor');
  assert.equal(tools[0].status, 'done');
  assert.match(tools[0].detail ?? '', /12 records · name, website · “Acme Roofing”/);
});
