/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/plan-task-account-selection.red.test.ts
 *
 * OPEN-THE-GATES Change 2. Live session-example-account-selection
 * seq 98075→98118: tool_search returned OUTLOOK_CALENDAR_CREATE_EVENT with
 * account_selection_required (owner@acme.example vs
 * owner@personal.example). Clem cited that write in plan_task.
 * Admission said it was not disclosed and offered greenhouse/airtable.
 * Clem then invented a write-gate. The missing fact is which mailbox —
 * outside the host — so the check must ASK, not substitute a different write.
 *
 * Re-break:
 *   (i)  accountSelectionForCitedWrite is not consulted before admission
 *   (ii) the repair tells the model to pick from admissibleCapabilities
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-plan-account-sel-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const PLAN = new URL('./plan-tools.ts', import.meta.url);
const {
  accountSelectionForCitedWrite,
  citationMatchesDisclosedOperation,
  thisTurnSearchAccountSelectionBlockers,
  uniqueConnectedAccountQuestion,
} = await import('./tool-search-provider-sources.js');
const { createSession, appendEvent, closeEventLog } = await import('../runtime/harness/eventlog.js');

test.after(() => {
  closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const CHOICES = [
  'owner@acme.example',
  'owner@personal.example',
] as const;

test('NEGATIVE: citing the matching write that still needs a mailbox is account selection, not a missing capability', () => {
  const live = accountSelectionForCitedWrite({
    citedRefs: ['OUTLOOK_CALENDAR_CREATE_EVENT'],
    blockers: [{ name: 'OUTLOOK_CALENDAR_CREATE_EVENT', choices: [...CHOICES] }],
  });
  assert.deepEqual(live, {
    name: 'OUTLOOK_CALENDAR_CREATE_EVENT',
    choices: [...CHOICES],
  });
  assert.deepEqual(
    accountSelectionForCitedWrite({
      citedRefs: ['cap:resolved:outlook_calendar_create_event'],
      blockers: [{ name: 'OUTLOOK_CALENDAR_CREATE_EVENT', choices: [...CHOICES] }],
    }),
    live,
    'a minted-ref spelling of the same write is still that write',
  );
  assert.deepEqual(
    accountSelectionForCitedWrite({
      citedRefs: ['composio:OUTLOOK_CALENDAR_CREATE_EVENT'],
      blockers: [{ name: 'OUTLOOK_CALENDAR_CREATE_EVENT', choices: [...CHOICES] }],
    }),
    live,
    'a carrier-prefixed slug from plan_task is still that write',
  );
  assert.equal(
    accountSelectionForCitedWrite({
      citedRefs: ['cap:resolved:greenhouse_create_interview'],
      blockers: [{ name: 'OUTLOOK_CALENDAR_CREATE_EVENT', choices: [...CHOICES] }],
    }),
    null,
    'an unrelated index write is not the matching account question',
  );
});

test('citation spellings of one Outlook create are one operation', () => {
  assert.equal(
    citationMatchesDisclosedOperation(
      'cap:resolved:outlook_calendar_create_event:owner@acme.example',
      'OUTLOOK_CALENDAR_CREATE_EVENT',
    ),
    true,
  );
  assert.equal(
    citationMatchesDisclosedOperation('GOOGLESHEETS_CREATE_GOOGLE_SHEET1', 'OUTLOOK_CALENDAR_CREATE_EVENT'),
    false,
  );
});

test('this-turn tool_search blockers are the live account-selection fact', () => {
  const session = createSession({ kind: 'chat', channel: 'mobile' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send Alex Rivera an invite to his acme email today at 1pm called AI check in' },
  });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: {
      sourceUserSeq: source.seq,
      tool: 'tool_search',
      result: JSON.stringify({
        query: 'create Outlook calendar event invite attendee',
        results: [{
          name: 'OUTLOOK_CALENDAR_CREATE_EVENT',
          planningRefStatus: 'account_selection_required',
          accountChoices: [...CHOICES],
        }, {
          name: 'OUTLOOK_CREATE_CALENDAR_EVENT',
          planningRefStatus: 'account_selection_required',
          accountChoices: [...CHOICES],
        }],
      }),
    },
  });
  const blockers = thisTurnSearchAccountSelectionBlockers({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.equal(blockers.some((row) => row.name === 'OUTLOOK_CALENDAR_CREATE_EVENT'), true);
  const ask = accountSelectionForCitedWrite({
    citedRefs: ['cap:resolved:outlook_calendar_create_event'],
    blockers,
  });
  assert.equal(ask?.name, 'OUTLOOK_CALENDAR_CREATE_EVENT');
  assert.deepEqual(ask?.choices, [...CHOICES]);
});

test('NEGATIVE: one mailbox choice set across search writes is a question, not a plan', () => {
  const question = uniqueConnectedAccountQuestion([
    { name: 'OUTLOOK_CALENDAR_CREATE_EVENT', choices: [...CHOICES] },
    { name: 'OUTLOOK_CREATE_CALENDAR_EVENT', choices: [...CHOICES] },
  ]);
  assert.deepEqual(question?.choices, [...CHOICES]);
  assert.equal(
    uniqueConnectedAccountQuestion([
      { name: 'OUTLOOK_CALENDAR_CREATE_EVENT', choices: [...CHOICES] },
      { name: 'SLACK_SEND_MESSAGE', choices: ['workspace-a', 'workspace-b'] },
    ]),
    null,
    'two different choice sets stay ambiguous',
  );
});

test('re-break (i): plan_task must consult account selection before admission', () => {
  const src = readFileSync(PLAN, 'utf8');
  const fn = src.slice(src.indexOf('async function executePlanTask'), src.indexOf('export function buildPlanTaskTool'));
  const askAt = fn.indexOf('accountSelectionForCitedWrite(');
  const admitAt = fn.indexOf('admitAndCompilePrimaryModelProposal');
  assert.ok(askAt >= 0 && admitAt > askAt, 'account selection must precede plan admission');
  assert.match(fn, /thisTurnSearchAccountSelectionBlockers/);
  assert.match(fn, /code: 'account_selection_required'/);
  assert.match(fn, /question: 'Which connected account should I use\?'/);
});

test('re-break (ii): the repair must ask, not offer a substitute write', () => {
  const src = readFileSync(PLAN, 'utf8');
  const fn = src.slice(src.indexOf('async function executePlanTask'), src.indexOf('export function buildPlanTaskTool'));
  const block = fn.slice(fn.indexOf('accountSelectionForCitedWrite('), fn.indexOf('const proposal = proposalFromDraft'));
  assert.match(block, /Ask the user which exact connected account/);
  assert.match(block, /Do not pick a substitute write/);
  assert.doesNotMatch(block, /admissibleCapabilities/);
});
