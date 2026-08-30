/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/tools/account-selection-session-identity.red.test.ts
 *
 * Live 2026-08-29 invite: OUTLOOK_CALENDAR_CREATE_EVENT stayed
 * account_selection_required for owner@acme.example vs
 * owner@personal.example. Clem named the Acme mailbox;
 * the user said "That's the correct account"; the next search still
 * withheld the capabilityRef because it only inspected the current
 * utterance.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-account-session-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { createSession, appendEvent, resetEventLog, closeEventLog } = await import('../runtime/harness/eventlog.js');
const {
  connectedAccountExplicitlySelectedInCurrentText,
  planningConnectionForOperation,
  sessionEstablishedConnectedAccountEmail,
  uniqueConnectedAccountFromSelectionReply,
} = await import('./tool-search-provider-sources.js');
const { userChoiceToolUseBehavior } = await import('../agents/orchestrator.js');

const CONNECTED = new Set([
  'owner@acme.example',
  'owner@personal.example',
]);

test.after(() => {
  closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('NEGATIVE: confirming the named connected mailbox is session-established identity', () => {
  resetEventLog();
  const session = createSession({ kind: 'chat', channel: 'mobile' });
  const first = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Can you send Alex Rivera an invite to his acme email for today at 1pm' },
  });
  assert.equal(
    sessionEstablishedConnectedAccountEmail({
      sessionId: session.id,
      sourceUserSeq: first.seq,
      connectedEmails: CONNECTED,
    }),
    undefined,
    'the first ask does not name a sending mailbox',
  );
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'Clem',
    type: 'conversation_completed',
    data: {
      presentation: {
        text: 'Confirm owner@acme.example is the account to use, and I\'ll invite alex.rivera@acme.example.',
      },
      reply: 'Confirm owner@acme.example is the account to use.',
    },
  });
  const confirm = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: "That's the correct account" },
  });
  assert.equal(
    sessionEstablishedConnectedAccountEmail({
      sessionId: session.id,
      sourceUserSeq: confirm.seq,
      connectedEmails: CONNECTED,
    }),
    'owner@acme.example',
    'a recipient address is not a connected identity; the named sending mailbox is',
  );
});

test('NEGATIVE: a later reply that drops the mailbox does not erase session identity', () => {
  resetEventLog();
  const session = createSession({ kind: 'chat', channel: 'mobile' });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send Alex an invite at 1pm' },
  });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'Clem',
    type: 'conversation_completed',
    data: {
      presentation: {
        text: 'Confirm owner@acme.example is the account to use.',
      },
    },
  });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: "That's the correct account" },
  });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'Clem',
    type: 'conversation_completed',
    data: {
      presentation: { text: 'Still blocked — no approval-card queue is available in this session.' },
    },
  });
  const retry = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Try this again please' },
  });
  assert.equal(
    sessionEstablishedConnectedAccountEmail({
      sessionId: session.id,
      sourceUserSeq: retry.seq,
      connectedEmails: CONNECTED,
    }),
    'owner@acme.example',
    'the earlier host-named mailbox remains the unique connected identity',
  );
});

test('a connected attendee never becomes session-established source authority', () => {
  resetEventLog();
  const session = createSession({ kind: 'chat', channel: 'mobile' });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Schedule a meeting with owner@personal.example.' },
  });
  const retry = appendEvent({
    sessionId: session.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Try that again.' },
  });
  assert.equal(
    sessionEstablishedConnectedAccountEmail({
      sessionId: session.id,
      sourceUserSeq: retry.seq,
      connectedEmails: CONNECTED,
    }),
    undefined,
  );
});

test('the explicit source survives session continuity when its attendee is another connected account', () => {
  resetEventLog();
  const session = createSession({ kind: 'chat', channel: 'mobile' });
  appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: 'Using my Acme Outlook account, schedule a meeting with owner@personal.example.',
    },
  });
  const retry = appendEvent({
    sessionId: session.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Try that again.' },
  });
  assert.equal(
    sessionEstablishedConnectedAccountEmail({
      sessionId: session.id,
      sourceUserSeq: retry.seq,
      connectedEmails: CONNECTED,
    }),
    'owner@acme.example',
  );
});

test('NEGATIVE: "My acme email please" uniquely selects the offered Acme mailbox', () => {
  assert.equal(
    uniqueConnectedAccountFromSelectionReply({
      reply: 'My acme email please',
      choices: [...CONNECTED],
    }),
    'owner@acme.example',
  );
  assert.equal(
    uniqueConnectedAccountFromSelectionReply({
      reply: 'personal',
      choices: [...CONNECTED],
    }),
    'owner@personal.example',
  );
  assert.equal(
    uniqueConnectedAccountFromSelectionReply({
      reply: 'email please',
      choices: [...CONNECTED],
    }),
    undefined,
    'a reply that matches every mailbox is not a choice',
  );
});

test('current request selects a connected account only from explicit account language', () => {
  assert.equal(
    connectedAccountExplicitlySelectedInCurrentText({
      text: 'Send Alex an invite using my Acme email.',
      choices: [...CONNECTED],
    }),
    'owner@acme.example',
  );
  assert.equal(
    connectedAccountExplicitlySelectedInCurrentText({
      text: 'Send Alex an invite from owner@personal.example.',
      choices: [...CONNECTED],
    }),
    'owner@personal.example',
    'an exact connected address remains a closed-set selection',
  );
  for (const recipientText of [
    'Invite Alex using his Acme email.',
    "Invite Alex using Alex's Acme email.",
    'Send the invite to alex.rivera@acme.example.',
    'Ask Alex to use owner@personal.example for replies.',
    'Alex is using owner@personal.example for this meeting.',
  ]) {
    assert.equal(
      connectedAccountExplicitlySelectedInCurrentText({
        text: recipientText,
        choices: [...CONNECTED],
      }),
      undefined,
      `recipient wording must not select sender authority: ${recipientText}`,
    );
  }
});

test('planning materialization consumes the current explicit account selection', () => {
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
  const selected = planningConnectionForOperation(
    'OUTLOOK_CALENDAR_CREATE_EVENT',
    'Send Alex an invite using my Acme email.',
    connections,
  );
  assert.equal(selected.kind, 'resolved');
  assert.equal(
    selected.kind === 'resolved' ? selected.connection.connectionId : undefined,
    'ca-acme',
  );

  assert.equal(
    planningConnectionForOperation(
      'OUTLOOK_CALENDAR_CREATE_EVENT',
      'Send Alex an invite using his Acme email.',
      connections,
    ).kind,
    'account_selection_required',
    'a recipient organization cannot choose among connected sender accounts',
  );
});

test('current account selection and tool-result arbitration use the same predicate', () => {
  const query = 'create Outlook calendar event';
  const roleKey = 'clause-0:write';
  const blockerResult = {
    query,
    role_key: roleKey,
    results: [{
      name: 'OUTLOOK_CALENDAR_CREATE_EVENT',
      planningRefStatus: 'account_selection_required',
      accountChoices: [...CONNECTED],
    }],
  };
  const toolResult = {
    type: 'function_output',
    tool: { name: 'tool_search' },
    output: blockerResult,
    argumentsJson: JSON.stringify({ query, role_key: roleKey, limit: 8, cursor: null }),
  } as const;

  resetEventLog();
  const selectedSession = createSession({ kind: 'chat', channel: 'mobile' });
  const selectedText = 'Create the Outlook invite using my Acme email.';
  const selectedSource = appendEvent({
    sessionId: selectedSession.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: selectedText },
  });
  const selected = userChoiceToolUseBehavior(
    { context: { sessionId: selectedSession.id, turn: 1, sourceUserSeq: selectedSource.seq } },
    [toolResult],
    {
      actionExpectedWork: true,
      accountSelectionRequirements: [{ roleKey, text: selectedText, resolved: false }],
    },
  );
  assert.equal(selected.isFinalOutput, false, 'a truly selected account must not be re-asked');

  resetEventLog();
  const recipientSession = createSession({ kind: 'chat', channel: 'mobile' });
  const recipientText = 'Create the Outlook invite using his Acme email.';
  const recipientSource = appendEvent({
    sessionId: recipientSession.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: recipientText },
  });
  const unresolved = userChoiceToolUseBehavior(
    { context: { sessionId: recipientSession.id, turn: 1, sourceUserSeq: recipientSource.seq } },
    [toolResult],
    {
      actionExpectedWork: true,
      accountSelectionRequirements: [{ roleKey, text: recipientText, resolved: false }],
    },
  );
  assert.equal(unresolved.isFinalOutput, true, 'recipient wording cannot suppress the sender-account question');
  assert.match(String(unresolved.finalOutput), /Which connected account should I use\?/);
});
