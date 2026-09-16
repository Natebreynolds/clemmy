import assert from 'node:assert/strict';
import test from 'node:test';
import {
  locateBeforeEditRefusal,
  locateResourceArgs,
  omitBlankIdentityFields,
  resourceIdsFromProviderResult,
} from './session-resource-locator.js';

const EVENT_ID = 'AAMkADExOGRmNmY1LWQ1MmEtNGUwMi05MTk0LTA4MmY5NTg2NTgxYQBGAAAAAAA=';
const createReceipt = {
  slug: 'OUTLOOK_CALENDAR_CREATE_EVENT',
  result: { successful: true, data: { id: EVENT_ID, subject: 'Discuss Clementine' } },
};

test('omitBlankIdentityFields drops empty calendar_id and keeps the event id', () => {
  const { args, omitted } = omitBlankIdentityFields({
    calendar_id: '',
    event_id: EVENT_ID,
    body: { content: 'Clem' },
  });
  assert.deepEqual(omitted, ['calendar_id']);
  assert.equal(args.event_id, EVENT_ID);
  assert.equal('calendar_id' in args, false);
});

test('resourceIdsFromProviderResult reads Graph data.id', () => {
  assert.equal(resourceIdsFromProviderResult(createReceipt.result).id, EVENT_ID);
});

test('an event update fills event_id from the unique same-session create', () => {
  const located = locateResourceArgs({
    toolSlug: 'OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR',
    args: { calendar_id: '', event_id: '', body: { content: 'Clem' } },
    receipts: [createReceipt],
    schema: { type: 'object', required: ['event_id'], properties: { event_id: { type: 'string' }, calendar_id: { type: 'string' } } },
  });
  assert.equal(located.args.event_id, EVENT_ID);
  assert.equal('calendar_id' in located.args, false);
  assert.deepEqual(located.missingRequired, []);
  assert.match(located.changes.join(' '), /omitted blank calendar_id/);
  assert.match(located.changes.join(' '), /event_id located/);
});

test('IN_CALENDAR still missing a required calendar_id is a locate refusal, not a Graph 400', () => {
  const located = locateResourceArgs({
    toolSlug: 'OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR',
    args: { calendar_id: '', event_id: EVENT_ID, body: { content: 'Clem' } },
    receipts: [createReceipt],
    schema: {
      type: 'object',
      required: ['calendar_id', 'event_id'],
      properties: { calendar_id: { type: 'string' }, event_id: { type: 'string' } },
    },
  });
  assert.deepEqual(located.missingRequired, ['calendar_id']);
  assert.equal(located.locatedEventId, EVENT_ID);
  assert.match(
    locateBeforeEditRefusal({
      toolSlug: 'OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR',
      missingRequired: located.missingRequired,
      locatedEventId: located.locatedEventId,
    }),
    /Locate the resource first/,
  );
});

test('two creates in the same toolkit do not guess which event to edit', () => {
  const located = locateResourceArgs({
    toolSlug: 'OUTLOOK_UPDATE_CALENDAR_EVENT',
    args: { event_id: '' },
    receipts: [
      createReceipt,
      { slug: 'OUTLOOK_CALENDAR_CREATE_EVENT', result: { data: { id: 'other-event' } } },
    ],
  });
  assert.equal('event_id' in located.args, false);
});

test('a Sheets create does not locate an Outlook event', () => {
  const located = locateResourceArgs({
    toolSlug: 'OUTLOOK_UPDATE_CALENDAR_EVENT',
    args: { event_id: '' },
    receipts: [{ slug: 'GOOGLESHEETS_CREATE_SPREADSHEET', result: { data: { id: 'sheet-1' } } }],
  });
  assert.equal('event_id' in located.args, false);
});

test('an argument-less call passes through the locator untouched instead of crashing', () => {
  // Full-suite 2026-09-15: a Composio read dispatched with no arguments died in
  // omitBlankIdentityFields ("Cannot convert undefined or null to object").
  assert.deepEqual(omitBlankIdentityFields(undefined as never), { args: {}, omitted: [] });
  assert.deepEqual(omitBlankIdentityFields(null as never), { args: {}, omitted: [] });
  const located = locateResourceArgs({ toolSlug: 'FIXTURE_LIST_ITEMS', args: undefined as never });
  assert.equal(located.args, undefined);
  assert.deepEqual(located.changes, []);
  assert.deepEqual(located.missingRequired, []);
});
