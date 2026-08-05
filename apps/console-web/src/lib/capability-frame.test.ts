/**
 * Run: npx tsx --test apps/console-web/src/lib/capability-frame.test.ts
 *
 * The chat activity strip renders the typed capability_resolution event as
 * ONE plain-voice grounding row — statuses and dates, never raw identifiers
 * as the label (the Brett release bar: no ids, plain voice).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceActivity, type ActivityItem } from './useChat';

const EMPTY: ActivityItem[] = [];

test('capability_resolution renders one plain-voice grounding row', () => {
  const rows = reduceActivity(EMPTY, {
    type: 'capability_resolution',
    data: {
      entries: [
        { intent: 'outlook.calendar.view_day', kind: 'composio', identifier: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW', status: 'proven', connection: 'active', accountIdentity: 'user@example.com' },
        { intent: 'apify.google_search_scrape_public_firm_research', kind: 'composio', identifier: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS', status: 'previously_failed', connection: 'active', failedAt: '2026-07-24T18:28:36.567Z' },
      ],
    },
  } as never);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.kind, 'event');
  assert.equal(row.tone, 'warning', 'a previously-failed path warns');
  assert.match(row.label, /1 proven tool/);
  assert.match(row.label, /1 needs a re-check/);
  assert.match(row.detail ?? '', /outlook calendar view day ✓/);
  assert.match(row.detail ?? '', /re-checking \(failed 2026-07-24\)/);
  assert.doesNotMatch(row.label, /OUTLOOK_|APIFY_/, 'raw identifiers never appear in the label');
});

test('a disconnected toolkit escalates the tone; an empty event renders nothing', () => {
  const rows = reduceActivity(EMPTY, {
    type: 'capability_resolution',
    data: {
      entries: [
        { intent: 'sheets.append', kind: 'composio', identifier: 'GOOGLESHEETS_BATCH_UPDATE', status: 'proven', connection: 'missing' },
      ],
    },
  } as never);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tone, 'danger');
  assert.match(rows[0].detail ?? '', /not connected/);

  assert.deepEqual(reduceActivity(EMPTY, { type: 'capability_resolution', data: { entries: [] } } as never), EMPTY);
});
