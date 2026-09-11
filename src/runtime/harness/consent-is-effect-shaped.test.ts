/**
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/runtime/harness/consent-is-effect-shaped.test.ts
 *
 * One-line consent must key on the EFFECT, never on which product the write
 * happens to land in.
 *
 * It used to gate on `label !== 'email'` plus an email-shaped subject and body,
 * with the label chosen by a regex of vendor and channel nouns held right here
 * in the harness. Two consequences, both live on 2026-09-11: a calendar invite
 * with one attendee, a subject and a time — every bit as reviewable in one
 * sentence as an email — fell through to the formal card; and supporting
 * anything else would have meant a new branch per service, forever, inside a
 * consent path.
 *
 * The layer below already had this right: the effect taxonomy keys on the verb
 * plus an externality cue and names no vendor at all. These pins keep this
 * layer from drifting back.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-consent-shape-'));
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { actionLabel, autonomousSendConsent } = await import('./autonomous-send-consent.js');

const pendingFor = (toolName: string, payload: unknown) => (
  { kind: 'external_send' as const, toolName, payload }
);

/** Vendor and channel nouns that must not appear in a consent decision. Written
 *  as fragments so this file can name what it forbids without becoming the
 *  very list it forbids elsewhere. */
const VENDOR_NOUN_RE = new RegExp(
  ['sl' + 'ack', 'gm' + 'ail', 'tw' + 'eet', 'twit' + 'ter', 'out' + 'look',
    'air' + 'table', 'no' + 'tion', 'dis' + 'cord', 'goo' + 'gle', 'hub' + 'spot',
    'sales' + 'force'].join('|'),
  'i',
);

const CONSENT_PATH = 'src/runtime/harness/autonomous-send-consent.ts';

/** Comment lines are documentation — including documentation of the defect
 *  these pins exist to prevent, which necessarily quotes it. Pins that assert
 *  about CODE must read code. */
function codeLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

test('the consent surface names no vendor, in code or in prose', () => {
  const source = readFileSync(path.resolve(CONSENT_PATH), 'utf8');
  const hits = source.split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((row) => VENDOR_NOUN_RE.test(row.line));
  assert.deepEqual(
    hits.map((row) => `${row.number}: ${row.line.trim().slice(0, 90)}`),
    [],
    'a service named here is a service the harness has to be taught — and every '
    + 'service it has not been taught silently loses conversational consent',
  );
});

test('the gate asks whether the write is reviewable, not what product it is', () => {
  const source = codeLines(readFileSync(path.resolve(CONSENT_PATH), 'utf8'));
  // The exact shape of the old defect: an equality test against one label.
  assert.doesNotMatch(
    source,
    /label\s*!==\s*'[a-z]+'/,
    'consent must not turn on which label the operation matched',
  );
  assert.match(
    source,
    /if \(!target \|\| !detail\) return null;/,
    'the gate is one unambiguous destination plus a legible description',
  );
});

test('the label is read from the operation, so an unknown service still works', () => {
  // Nothing below is known to the harness; each label comes from the
  // operation's own words.
  assert.equal(actionLabel('ACME_CRM_CREATE_RECORD', 'create'), 'record');
  assert.equal(actionLabel('SOME_SUITE_CALENDAR_CREATE_EVENT', 'create'), 'event');
  assert.equal(actionLabel('BRANDNEW_SAAS_SCHEDULE_APPOINTMENT', 'schedule'), 'appointment');
  assert.equal(actionLabel('WIDGETCO_SEND_INVOICE', 'send'), 'invoice');
});

test('an operation that names no object degrades to a neutral word, never a wrong one', () => {
  // A label is prose shown to a person ("I left the exact ___ unsent"), so the
  // failure mode that matters is confidently saying the wrong noun.
  assert.equal(actionLabel('work_call', undefined), 'send');
  assert.equal(actionLabel('', undefined), 'send');
  assert.equal(actionLabel('OPAQUE', undefined), 'send');
});

test('the persistence boundary accepts any operation noun', () => {
  const registry = readFileSync(
    path.resolve('src/runtime/harness/approval-registry.ts'),
    'utf8',
  );
  assert.doesNotMatch(
    registry,
    /\['email',\s*'message',\s*'post',\s*'send'\]/,
    'a closed label enum at the store boundary is the same vendor list one layer down',
  );
});


test('a write that addresses one person is describable whatever shape it has', () => {
  // The live case, with the vendor swapped for one that does not exist: an
  // invite naming a single attendee, a subject and a time. Nothing about this
  // is an email, and every part of it is reviewable in a sentence.
  const args = {
    subject: 'Nate / James Marshall',
    attendees_info: [{ email: 'james.marshall@example.co' }],
    start_datetime: '2026-09-12T14:00:00',
  };
  const consent = autonomousSendConsent(
    'SUITE_CALENDAR_CREATE_EVENT',
    args,
    pendingFor('SUITE_CALENDAR_CREATE_EVENT', args),
  );
  assert.ok(consent, 'a single-attendee invite must get the one-line ask, not the formal card');
  assert.equal(consent.actionLabel, 'event');
  assert.equal(consent.target, 'james.marshall@example.co');
  assert.match(consent.question, /Nate \/ James Marshall/);
});

test('email keeps the behaviour it always had', () => {
  const args = { to: 'a@example.co', subject: 'Hi', body: 'Hello there' };
  const consent = autonomousSendConsent(
    'MAILER_SEND_EMAIL',
    args,
    pendingFor('MAILER_SEND_EMAIL', args),
  );
  assert.ok(consent);
  assert.equal(consent.actionLabel, 'email');
  assert.equal(consent.target, 'a@example.co');
});

test('more than one destination is a card, not a sentence', () => {
  // The safety half of the change. Widening WHICH writes can be asked about in
  // one line must not widen how much a single line is allowed to hide.
  const args = {
    subject: 'Team sync',
    attendees_info: [{ email: 'a@example.co' }, { email: 'b@example.co' }],
    start_datetime: '2026-09-12T14:00:00',
  };
  assert.equal(
    autonomousSendConsent(
      'SUITE_CALENDAR_CREATE_EVENT',
      args,
      pendingFor('SUITE_CALENDAR_CREATE_EVENT', args),
    ),
    null,
  );
});


// ─── What the old email-shaped gate was ALSO defending ──────────────────────
//
// `!subject` was doing two jobs: an email-shaped requirement (the defect) and
// a fail-closed ambiguity check (a real safety property). Removing the first
// silently removed the second — caught by two existing tests, restored as
// explicit rules, and pinned here so the next simplification sees them.

test('conflicting payload candidates fail closed, whatever the shape', () => {
  // A nested decoy: two subject candidates in one payload. There is no way to
  // know which one a person would be saying yes to.
  const args = {
    to: 'avery@example.co',
    subject: 'DECOY subject',
    arguments: JSON.stringify({ subject: 'ACTUAL subject', body: 'ACTUAL body' }),
  };
  assert.equal(
    autonomousSendConsent('MAILER_SEND_EMAIL', args, pendingFor('MAILER_SEND_EMAIL', args)),
    null,
  );
});

test('a payload with a body must also name what it is', () => {
  // Shape rule, not product rule: something written to be read has a header,
  // and "send this body" without one announces nothing reviewable.
  const args = { to_email: 'blake@example.co', body: 'No subject supplied.' };
  assert.equal(
    autonomousSendConsent('MAILER_SEND_EMAIL', args, pendingFor('MAILER_SEND_EMAIL', args)),
    null,
  );
  // The same rule must NOT catch a write that has no body at all — that is the
  // whole point of the change, and the line these two rules sit either side of.
  const invite = {
    subject: 'Nate / James',
    attendees: ['james@example.co'],
    start_datetime: '2026-09-12T14:00:00',
  };
  assert.ok(autonomousSendConsent(
    'SUITE_CALENDAR_CREATE_EVENT',
    invite,
    pendingFor('SUITE_CALENDAR_CREATE_EVENT', invite),
  ));
});
