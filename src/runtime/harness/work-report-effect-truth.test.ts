/**
 * Effect-truth pins for user-facing write descriptions (B1).
 *
 * Two live lies motivated this (2026-08 ledger): OUTLOOK_UPDATE_EMAIL on a
 * twice-stated draft-only task rendered "Sent a message", and
 * SLACK_DELETE_MESSAGE matched /MESSAGE/ before /DELETE/. The fix derives the
 * phrase from verb-consequence + the write's recorded `irreversible` bit.
 *
 * Pin classes here:
 *   - fails-on-old-code pins for both observed lies;
 *   - the structural invariant: irreversible === false ⇒ never delivery language;
 *   - a no-catalog source pin so the ordered regex chain cannot grow back;
 *   - a CONNECTION pin through synthesizeWorkReport proving the real callsite
 *     passes the recorded bit (a green unit test on the helper alone proves it
 *     runs, not that anything calls it with the truth);
 *   - server ↔ console-web parity over a shared fixture table (console cannot
 *     import server code, so the two copies are pinned behaviorally).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeExternalWrite, resolveWriteEvidence, synthesizeWorkReport } from './work-report.js';
import type { EventRow } from './eventlog.js';
// The console mirror — pure TS, no DOM. Parity is pinned here because
// console-web cannot import server modules.
import { describeExternalWrite as consoleDescribeExternalWrite } from '../../../apps/console-web/src/lib/toolLabels.js';
// The shared chat engine both apps render live rows with.
import { describeExternalWrite as engineDescribeExternalWrite } from '../../../packages/chat-engine/src/tool-labels.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function row(overrides: Partial<EventRow> & { data: Record<string, unknown> }): EventRow {
  return {
    seq: 1,
    id: 'evt-1',
    sessionId: 'sess-test',
    turn: 0,
    role: 'assistant',
    type: 'external_write' as EventRow['type'],
    parentEventId: null,
    createdAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  };
}

test('OUTLOOK_UPDATE_EMAIL never renders as Sent (the live lie)', () => {
  const line = describeExternalWrite('OUTLOOK_UPDATE_EMAIL', 'composio_execute_tool', [], {
    irreversible: false,
    actionKey: 'shape:outlook:update:email',
  });
  assert.doesNotMatch(line, /sent/i);
  assert.match(line, /^Updated a record/);
});

test('SLACK_DELETE_MESSAGE renders as a deletion, never a send (the second lie)', () => {
  const line = describeExternalWrite('SLACK_DELETE_MESSAGE', '', [], { irreversible: true });
  assert.doesNotMatch(line, /sent/i);
  assert.match(line, /^Deleted a record/);
});

test('draft family: compose stays a draft, dispatching the draft is a send', () => {
  assert.match(describeExternalWrite('OUTLOOK_CREATE_DRAFT', '', [], { irreversible: false }), /^Created a draft/);
  assert.match(describeExternalWrite('OUTLOOK_CREATE_REPLY_DRAFT', '', [], { irreversible: false }), /^Created a draft/);
  assert.match(describeExternalWrite('OUTLOOK_UPDATE_DRAFT', '', [], { irreversible: false }), /^Updated a draft/);
  assert.match(describeExternalWrite('GMAIL_SEND_DRAFT', '', [], { irreversible: true }), /^Sent a message/);
});

test('INVARIANT: a write recorded reversible may never use delivery language', () => {
  const slugs = [
    'GMAIL_SEND_EMAIL', 'SLACK_SEND_MESSAGE', 'TWILIO_SEND_SMS', 'OUTLOOK_FORWARD_MAIL',
    'X_POST_TWEET', 'LINKEDIN_PUBLISH_POST', 'DISCORD_SEND_DM', 'PHONE_DIAL_NUMBER',
    'AIRTABLE_CREATE_RECORD', 'GOOGLESHEETS_VALUES_UPDATE', 'SLACK_DELETE_MESSAGE',
    'DRIVE_UPLOAD_FILE', 'CRM_SET_STAGE', 'CALENDAR_INVITE_ATTENDEE',
  ];
  for (const slug of slugs) {
    const line = describeExternalWrite(slug, '', ['x@example.com'], { irreversible: false });
    assert.doesNotMatch(line, /sent|published|delivered/i, `${slug} rendered delivery while reversible: "${line}"`);
  }
});

test('irreversible sends still read as delivery; legacy rows keep their meaning', () => {
  assert.match(describeExternalWrite('GMAIL_SEND_EMAIL', '', ['a@b.co'], { irreversible: true }), /^Sent a message to a@b\.co/);
  assert.match(describeExternalWrite('LINKEDIN_PUBLISH_POST', '', [], { irreversible: true }), /^Published a post/);
  // Legacy rows predate the bit — undefined preserves the historical reading.
  assert.match(describeExternalWrite('GMAIL_SEND_EMAIL', '', []), /^Sent a message/);
});

test('consequence phrasing: create/update/delete/file are verb-derived, not noun-derived', () => {
  assert.match(describeExternalWrite('AIRTABLE_CREATE_RECORD', '', []), /^Created a record/);
  assert.match(describeExternalWrite('GOOGLESHEETS_VALUES_UPDATE', '', []), /^Updated a record/);
  assert.match(describeExternalWrite('NOTION_ARCHIVE_PAGE', '', []), /^Deleted a record/);
  assert.match(describeExternalWrite('DRIVE_UPLOAD_FILE', '', []), /^Saved a file/);
  assert.match(describeExternalWrite('SHAREPOINT_SAVE_DOCUMENT', '', []), /^Saved a file/);
  // A pure noun with no verb evidence stays neutral — nouns do not deliver.
  assert.match(describeExternalWrite('OUTLOOK_EMAIL', '', []), /^Ran outlook email/);
});

test('NO-CATALOG source pin: the ordered slug-regex chain must not grow back', () => {
  const source = readFileSync(path.join(HERE, 'work-report.ts'), 'utf8');
  assert.doesNotMatch(
    source,
    /SEND\|EMAIL\|DELIVER\|DISPATCH/,
    'work-report.ts regrew the noun-alternation catalog that shipped "Sent a message" on a draft-only task',
  );
});

test('CONNECTION pin: synthesizeWorkReport passes the recorded irreversible bit through', () => {
  const report = synthesizeWorkReport([
    row({
      seq: 10,
      data: {
        shapeKey: 'OUTLOOK_UPDATE_EMAIL',
        actionKey: 'shape:outlook:update:email',
        toolName: 'composio_execute_tool',
        targets: [],
        irreversible: false,
        preDispatch: true,
        canonicalCallId: 'call-1',
      },
    }),
    row({
      seq: 11,
      type: 'external_write_succeeded' as EventRow['type'],
      data: { shapeKey: 'OUTLOOK_UPDATE_EMAIL', canonicalCallId: 'call-1' },
    }),
  ]);
  assert.ok(report, 'expected a synthesized report');
  assert.doesNotMatch(report, /sent/i, `real callsite still says Sent: ${report}`);
  assert.match(report, /Updated a record/);
});

// One effect label (live 2026-09-25). A row carrying the consent
// classification's consequence reads from it, not from verbs in the operation
// name: a named send reads as delivery even when the name says create, and a
// consequence the classification could not name reads as the call it was even
// when the name holds a delivery verb.
test('CONNECTION pin: synthesizeWorkReport reads the consequence the consent recorded', () => {
  const reserved = (seq: number, callId: string, shapeKey: string, consequence: string, irreversible: boolean): EventRow[] => [
    row({
      seq,
      id: `reserve-${callId}`,
      data: {
        shapeKey, toolName: shapeKey, targets: ['a@example.test'], irreversible,
        reversibility: irreversible ? 'irreversible' : 'ordinary_non_destructive',
        consequence, preDispatch: true, canonicalCallId: callId,
      },
    }),
    row({
      seq: seq + 1,
      id: `settle-${callId}`,
      type: 'external_write_succeeded' as EventRow['type'],
      parentEventId: `reserve-${callId}`,
      data: { shapeKey, canonicalCallId: callId },
    }),
  ];
  const report = synthesizeWorkReport([
    ...reserved(30, 'call-named-send', 'PROVIDER_CREATE_EVENT', 'send', true),
    ...reserved(40, 'call-unnamed', 'provider__api_post_request', 'unknown', false),
  ]);
  assert.ok(report, 'expected a synthesized report');
  assert.match(report, /Sent a message to a@example\.test/, report);
  assert.doesNotMatch(report, /Created a record/, report);
  assert.match(report, /Ran provider {2}api post request/, report);
  assert.doesNotMatch(report, /Published a post/, report);
});

test('PARITY pin: server, console-web and chat-engine copies agree on a recorded consequence', () => {
  const fixtures: Array<[string, { irreversible?: boolean; consequence?: string }]> = [
    ['PROVIDER_CREATE_EVENT', { irreversible: true, consequence: 'send' }],
    ['provider__api_post_request', { irreversible: false, consequence: 'unknown' }],
    ['PROVIDER_SEND_MESSAGE', { consequence: 'execute' }],
    ['MAIL_CREATE_DRAFT', { irreversible: false, consequence: 'create' }],
    ['MAIL_UPDATE_DRAFT', { consequence: 'update' }],
    ['PROVIDER_RECORD', { consequence: 'delete' }],
    ['PROVIDER_UPLOAD_FILE', { consequence: 'create' }],
  ];
  for (const [slug, opts] of fixtures) {
    const server = describeExternalWrite(slug, '', [], opts);
    assert.equal(consoleDescribeExternalWrite(slug, '', [], opts), server, `console copy diverged on ${slug} (${JSON.stringify(opts)})`);
    assert.equal(engineDescribeExternalWrite(slug, '', [], opts), server, `engine copy diverged on ${slug} (${JSON.stringify(opts)})`);
  }
  assert.match(describeExternalWrite('PROVIDER_SEND_MESSAGE', '', [], { consequence: 'execute' }), /^Ran /,
    'a consequence that is not a change never reads as one');
});

test('write resolution gives decisive truth precedence over orphan and fails closed on conflicting decisive terminals', () => {
  const reservation = row({
    seq: 20,
    id: 'reservation-decisive-order',
    data: {
      preDispatch: true,
      canonicalCallId: 'call-decisive-order',
      shapeKey: 'UPDATE_RECORD',
    },
  });
  const success = row({
    seq: 21,
    id: 'success-decisive-order',
    type: 'external_write_succeeded' as EventRow['type'],
    parentEventId: reservation.id,
    data: { canonicalCallId: 'call-decisive-order', shapeKey: 'UPDATE_RECORD' },
  });
  const lateOrphan = row({
    seq: 22,
    id: 'orphan-after-decisive',
    type: 'external_write_orphaned' as EventRow['type'],
    parentEventId: reservation.id,
    data: { canonicalCallId: 'call-decisive-order', shapeKey: 'UPDATE_RECORD' },
  });
  const decisive = resolveWriteEvidence([reservation, success, lateOrphan]);
  assert.deepEqual(decisive.confirmed.map((event) => event.id), [reservation.id]);
  assert.equal(decisive.uncertain.length, 0, 'orphan cannot downgrade decisive success');

  const conflict = row({
    seq: 23,
    id: 'failed-conflict-after-success',
    type: 'external_write_failed' as EventRow['type'],
    parentEventId: reservation.id,
    data: { canonicalCallId: 'call-decisive-order', shapeKey: 'UPDATE_RECORD' },
  });
  const conflicted = resolveWriteEvidence([reservation, success, lateOrphan, conflict]);
  assert.equal(conflicted.confirmed.length, 0);
  assert.deepEqual(conflicted.uncertain.map((event) => event.id), [reservation.id]);
});

test('PARITY pin: server and console-web copies phrase-match over the fixture table', () => {
  const fixtures: Array<[string, { irreversible?: boolean } | undefined]> = [
    ['OUTLOOK_UPDATE_EMAIL', { irreversible: false }],
    ['SLACK_DELETE_MESSAGE', { irreversible: true }],
    ['OUTLOOK_CREATE_DRAFT', { irreversible: false }],
    ['OUTLOOK_UPDATE_DRAFT', { irreversible: false }],
    ['GMAIL_SEND_DRAFT', { irreversible: true }],
    ['GMAIL_SEND_EMAIL', { irreversible: true }],
    ['GMAIL_SEND_EMAIL', { irreversible: false }],
    ['LINKEDIN_PUBLISH_POST', { irreversible: true }],
    ['AIRTABLE_CREATE_RECORD', undefined],
    ['GOOGLESHEETS_VALUES_UPDATE', undefined],
    ['DRIVE_UPLOAD_FILE', undefined],
    ['NOTION_ARCHIVE_PAGE', undefined],
    ['OUTLOOK_EMAIL', undefined],
    ['shape:outlook:update:email', { irreversible: false }],
  ];
  for (const [slug, opts] of fixtures) {
    const server = describeExternalWrite(slug, '', [], opts);
    const console_ = consoleDescribeExternalWrite(slug, '', [], opts);
    assert.equal(console_, server, `copies diverged on ${slug} (${JSON.stringify(opts)})`);
  }
});
