/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/tools/account-selection-current-source-service.red.test.ts
 *
 * Live 2026-08-29 source 100077 named the source as "using my Acme
 * Outlook". The account selector understood "my Acme email" but treated
 * the provider/service suffix as no selection, so discovery returned a write
 * with account_selection_required even though the current source had already
 * supplied the answer.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-account-source-service-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const {
  connectedAccountExplicitlySelectedInCurrentText,
  planningConnectionForOperation,
} = await import('./tool-search-provider-sources.js');
const {
  appendEvent,
  closeEventLog,
  createSession,
  listEvents,
  resetEventLog,
} = await import('../runtime/harness/eventlog.js');
const {
  rememberAccountAlias,
  resetAccountAliasesForTest,
} = await import('../memory/account-alias-store.js');
const { userChoiceToolUseBehavior } = await import('../agents/orchestrator.js');

const CHOICES = [
  'owner@acme.example',
  'owner@personal.example',
] as const;
const LIVE_TEXT = 'Can you schedule a meeting for me and Alex Rivera using my Acme Outlook please';
const LIVE_CANARY_TEXT = 'Using my Acme Outlook account, schedule a 15-minute meeting on Monday, August 31, 2026 at 9:30 AM Pacific with owner@personal.example.';

test.beforeEach(() => {
  rmSync(path.join(TEST_HOME, 'memory', 'account-aliases.json'), { force: true });
  resetAccountAliasesForTest();
});

test.after(() => {
  closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('live source-service wording explicitly selects the connected source account', () => {
  assert.equal(
    connectedAccountExplicitlySelectedInCurrentText({ text: LIVE_TEXT, choices: CHOICES }),
    'owner@acme.example',
  );

  assert.equal(
    connectedAccountExplicitlySelectedInCurrentText({
      text: 'Create the report using my Personal Salesforce workspace for owner@acme.example.',
      choices: CHOICES,
    }),
    'owner@personal.example',
    'the grammar is independent of a particular provider or resource suffix',
  );

  assert.equal(
    connectedAccountExplicitlySelectedInCurrentText({
      text: 'Identify which connected Outlook account you would use when I say my Acme Outlook account.',
      choices: CHOICES,
    }),
    undefined,
    'reported/descriptive text is not current source authority',
  );
});

test('provider words cannot compete with the leading source alias', () => {
  assert.equal(
    connectedAccountExplicitlySelectedInCurrentText({
      text: 'Using my Acme Outlook account, schedule the meeting.',
      choices: [
        'owner@acme.example',
        'owner@personal.example',
      ],
    }),
    'owner@acme.example',
    'Outlook is the provider suffix, not a second account nomination',
  );
});

test('live canary: a connected attendee address cannot override the explicit first-person source account', () => {
  assert.equal(
    connectedAccountExplicitlySelectedInCurrentText({
      text: LIVE_CANARY_TEXT,
      choices: CHOICES,
    }),
    'owner@acme.example',
    'the attendee is a target even though it is also a connected mailbox',
  );

  const selection = planningConnectionForOperation(
    'OUTLOOK_CALENDAR_CREATE_EVENT',
    LIVE_CANARY_TEXT,
    [{
      slug: 'outlook',
      connectionId: 'ca-acme-current',
      status: 'ACTIVE',
      accountEmail: 'owner@acme.example',
    }, {
      slug: 'outlook',
      connectionId: 'ca-personal-current',
      status: 'ACTIVE',
      accountEmail: 'owner@personal.example',
    }],
  );
  assert.equal(selection.kind, 'resolved');
  assert.equal(
    selection.kind === 'resolved' ? selection.connection.connectionId : undefined,
    'ca-acme-current',
  );
});

test('recipient and third-party service wording never selects source authority', () => {
  for (const text of [
    'Schedule with Alex using his Acme Outlook.',
    "Schedule with Alex using Alex's Acme Outlook.",
    'Schedule with Alex using their Acme Outlook.',
    'Alex uses Acme Outlook for his calendar.',
    'Use the Acme Outlook account Alex gave us.',
    'Invite Alex at alex.rivera@acme.example using his Outlook calendar.',
    'Look up Alex in my contacts, then use his Acme Outlook.',
    'Schedule a meeting with owner@personal.example.',
    'Add owner@personal.example as the attendee.',
    'Send the invite to owner@personal.example.',
    'Read the newest Inbox message from owner@personal.example.',
    'Read the newest Inbox message sent to owner@personal.example.',
    'Do not use my Acme Outlook.',
    "I don't want to use my Acme Outlook for this.",
    'Avoid using my Acme Outlook.',
  ]) {
    assert.equal(
      connectedAccountExplicitlySelectedInCurrentText({ text, choices: CHOICES }),
      undefined,
      `recipient/third-party wording must abstain: ${text}`,
    );
  }
});

test('targets, exclusions, quotations, and reported speech cannot activate a durable alias', () => {
  rememberAccountAlias({
    toolkit: 'outlook',
    label: 'acme',
    email: 'owner@acme.example',
    connectionId: 'ca-acme',
  });
  const connections = [{
    slug: 'outlook',
    connectionId: 'ca-acme',
    status: 'ACTIVE',
    accountEmail: 'owner@acme.example',
  }, {
    slug: 'outlook',
    connectionId: 'ca-personal',
    status: 'ACTIVE',
    accountEmail: 'owner@personal.example',
  }];
  for (const text of [
    'Send this to my Acme Outlook account.',
    'Send this from any account except my Acme Outlook account.',
    'Send this without using my Acme Outlook account.',
    'Send this, but not from my Acme Outlook account.',
    'Send this not-from my Acme Outlook account.',
    'The subject should say "use my Acme Outlook account".',
    'Alex said use my Acme Outlook account.',
  ]) {
    assert.equal(
      connectedAccountExplicitlySelectedInCurrentText({
        text,
        choices: connections.map((connection) => connection.accountEmail),
      }),
      undefined,
      `non-source wording must abstain: ${text}`,
    );
    const selection = planningConnectionForOperation(
      'OUTLOOK_SEND_EMAIL',
      text,
      connections,
    );
    assert.equal(
      selection.kind,
      'account_selection_required',
      `durable memory must not turn non-source wording into authority: ${text}`,
    );
  }
});

test('a strong multi-word durable alias reattaches only through a fresh relevant connection', () => {
  rememberAccountAlias({
    toolkit: 'outlook',
    label: 'client ops',
    email: 'owner@acme.example',
    connectionId: 'ca-old-reauth',
  });
  const selection = planningConnectionForOperation(
    'OUTLOOK_CALENDAR_CREATE_EVENT',
    'Using my Client Ops Outlook account, schedule the meeting.',
    [{
      slug: 'outlook',
      connectionId: 'ca-fresh-reauth',
      status: 'ACTIVE',
      accountEmail: 'owner@acme.example',
      createdAt: '2026-08-30T10:00:00.000Z',
    }, {
      slug: 'outlook',
      connectionId: 'ca-personal',
      status: 'ACTIVE',
      accountEmail: 'owner@personal.example',
    }, {
      slug: 'salesforce',
      connectionId: 'ca-irrelevant-toolkit',
      status: 'ACTIVE',
      accountEmail: 'owner@acme.example',
    }],
  );
  assert.equal(selection.kind, 'resolved');
  assert.equal(
    selection.kind === 'resolved' ? selection.connection.connectionId : undefined,
    'ca-fresh-reauth',
    'the durable label nominates a stable mailbox, then the fresh toolkit snapshot chooses its current connection',
  );
});

test('a durable alias whose identity is absent from the fresh toolkit snapshot asks', () => {
  rememberAccountAlias({
    toolkit: 'outlook',
    label: 'archive',
    email: 'archive@retired.example',
    connectionId: 'ca-retired',
  });
  const selection = planningConnectionForOperation(
    'OUTLOOK_SEND_EMAIL',
    'Use my Archive Outlook account to send the message.',
    [{
      slug: 'outlook',
      connectionId: 'ca-work',
      status: 'ACTIVE',
      accountEmail: 'owner@work.example',
    }, {
      slug: 'outlook',
      connectionId: 'ca-personal',
      status: 'ACTIVE',
      accountEmail: 'owner@personal.example',
    }],
  );
  assert.equal(selection.kind, 'account_selection_required');
  assert.deepEqual(
    selection.kind === 'account_selection_required' ? selection.choices : [],
    ['owner@work.example', 'owner@personal.example'],
    'a stale saved connection cannot become provider authority or fall through to a default',
  );
});

test('an unknown source alias cannot fall through to a lone provider account', () => {
  const selection = planningConnectionForOperation(
    'OUTLOOK_SEND_EMAIL',
    'Use my Unknown Client Outlook account to send the message.',
    [{
      slug: 'outlook',
      connectionId: 'ca-only',
      status: 'ACTIVE',
      accountEmail: 'owner@work.example',
    }],
  );
  assert.equal(selection.kind, 'account_selection_required');
  assert.deepEqual(
    selection.kind === 'account_selection_required' ? selection.choices : [],
    ['owner@work.example'],
  );
});

test('one saved alias cannot swallow a second unknown source nomination', () => {
  rememberAccountAlias({
    toolkit: 'outlook',
    label: 'work',
    email: 'owner@work.example',
    connectionId: 'ca-work',
  });
  const text = 'Use my Work Outlook account or use my Unknown Outlook account to send it.';
  const connections = [{
    slug: 'outlook',
    connectionId: 'ca-work',
    status: 'ACTIVE',
    accountEmail: 'owner@work.example',
  }, {
    slug: 'outlook',
    connectionId: 'ca-personal',
    status: 'ACTIVE',
    accountEmail: 'owner@personal.example',
  }];
  assert.equal(
    connectedAccountExplicitlySelectedInCurrentText({
      text,
      choices: connections.map((connection) => connection.accountEmail),
    }),
    undefined,
  );
  const selection = planningConnectionForOperation(
    'OUTLOOK_SEND_EMAIL',
    text,
    connections,
  );
  assert.equal(selection.kind, 'account_selection_required');
});

test('exact connected addresses still select authority in explicit source-account grammar', () => {
  assert.equal(
    connectedAccountExplicitlySelectedInCurrentText({
      text: 'Send the invite from owner@acme.example to owner@personal.example.',
      choices: CHOICES,
    }),
    'owner@acme.example',
  );
  assert.equal(
    connectedAccountExplicitlySelectedInCurrentText({
      text: 'The sending account is owner@personal.example; invite client@example.test.',
      choices: CHOICES,
    }),
    'owner@personal.example',
  );
  assert.equal(
    connectedAccountExplicitlySelectedInCurrentText({
      text: 'Read the newest Inbox message for owner@acme.example.',
      choices: CHOICES,
    }),
    'owner@acme.example',
    'an exact mailbox owner remains a valid source selection for a mailbox read',
  );
  assert.equal(
    connectedAccountExplicitlySelectedInCurrentText({
      text: 'Do not use owner@personal.example; use my Acme Outlook account.',
      choices: CHOICES,
    }),
    'owner@acme.example',
    'a negated exact source mention cannot conflict with the positive source selection',
  );
});

test('the shared selector resolves live-shaped planning materialization', () => {
  const selection = planningConnectionForOperation(
    'OUTLOOK_CALENDAR_CREATE_EVENT',
    LIVE_TEXT,
    [{
      slug: 'outlook',
      connectionId: 'ca-acme',
      status: 'ACTIVE',
      accountEmail: 'owner@acme.example',
    }, {
      slug: 'outlook',
      connectionId: 'ca-personal',
      status: 'ACTIVE',
      accountEmail: 'owner@personal.example',
    }],
  );
  assert.equal(selection.kind, 'resolved');
  assert.equal(
    selection.kind === 'resolved' ? selection.connection.connectionId : undefined,
    'ca-acme',
  );
});

test('the orchestrator consumes the same selection and does not ask again', () => {
  resetEventLog();
  const session = createSession({ kind: 'chat', channel: 'mobile' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: LIVE_TEXT },
  });
  const result = userChoiceToolUseBehavior(
    { context: { sessionId: session.id, turn: 1, sourceUserSeq: source.seq } },
    [{
      type: 'function_output',
      tool: { name: 'tool_search' },
      output: {
        query: 'create event for attendee',
        results: [{
          name: 'CALENDAR_CREATE_EVENT',
          planningRefStatus: 'account_selection_required',
          accountChoices: [...CHOICES],
        }],
      },
    }],
  );
  assert.equal(result.isFinalOutput, false, 'current source selection must suppress a redundant account ask');
  assert.equal(listEvents(session.id, { types: ['awaiting_user_input'] }).length, 0);
});
