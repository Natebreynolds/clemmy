/**
 * Run:
 *   node scripts/run-tests-isolated.mjs src/tools/account-named-by-label.test.ts
 *
 * An account is established when the session has NAMED it — by the label it is
 * offered under, not only by its address.
 *
 * Live 2026-09-11: turn 1 answered "your Workco calendar". Turn 2 asked to
 * book an hour on it and could not reuse that, because only an exact address
 * counted. Clem asked which of two calendars to use — a question turn 1 had
 * already answered — costing a model call, the question, the user's reply and
 * a whole extra turn, about 80 seconds end to end.
 *
 * The safety property is unchanged and is what most of these cases defend:
 * binding the wrong account writes to the wrong place, so anything ambiguous
 * stays unresolved and the user is asked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-account-label-'));
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { uniqueConnectedAccountFromLabel } = await import('./tool-search-provider-sources.js');

const WORK = 'owner@work-example.co';
const PERSONAL = 'owner@personal-example.ai';
const CHOICES = [WORK, PERSONAL];
const LABELS = { [WORK]: 'workco', [PERSONAL]: 'personalco' };

const match = (text: string): string | undefined => uniqueConnectedAccountFromLabel({
  text,
  choices: CHOICES,
  labels: LABELS,
});

test('a label the host itself offered resolves the account', () => {
  // Verbatim from the live run's turn 1.
  assert.equal(
    match('Tomorrow (9/12) is completely clear on your Workco calendar — no events found.'),
    WORK,
  );
  assert.equal(match('Nothing on your personalco calendar.'), PERSONAL);
});

test('two labels in one sentence resolve nothing — that is a question, not an answer', () => {
  assert.equal(match('I checked workco and personalco — both are clear.'), undefined);
});

test('a label must stand as its own word', () => {
  // The failure that matters: a common word inside other prose silently
  // binding a write to an account nobody chose.
  assert.equal(match('The workcos exhibit opens at 2.'), undefined);
  assert.equal(match('Nothing found.'), undefined);
  assert.equal(match(''), undefined);
});

test('short or address-shaped labels never match', () => {
  // A 3-letter label collides with ordinary prose; an address is already the
  // exact matcher's job, and matching it loosely here would widen that gate.
  assert.equal(
    uniqueConnectedAccountFromLabel({
      text: 'put it on the ops calendar',
      choices: CHOICES,
      labels: { [WORK]: 'ops', [PERSONAL]: 'personalco' },
    }),
    undefined,
  );
  assert.equal(
    uniqueConnectedAccountFromLabel({
      text: `send from ${WORK}`,
      choices: CHOICES,
      labels: { [WORK]: WORK, [PERSONAL]: PERSONAL },
    }),
    undefined,
  );
});

test('a single connected account needs no disambiguation from prose', () => {
  assert.equal(
    uniqueConnectedAccountFromLabel({
      text: 'the workco calendar',
      choices: [WORK],
      labels: LABELS,
    }),
    undefined,
    'one choice is resolved upstream; this matcher exists only to break a tie',
  );
});

test('no labels supplied means no label matching', () => {
  assert.equal(
    uniqueConnectedAccountFromLabel({ text: 'the workco calendar', choices: CHOICES }),
    undefined,
  );
});
