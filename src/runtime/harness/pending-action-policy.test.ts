/**
 * The conversation-mandate door for irreversible sends.
 *
 * GRANT INVARIANT I1 stands: an irreversible send executes only on HUMAN
 * consent, and a policy-minted approval is inert. What this door adds is the
 * second honest derivation of that consent: in YOLO scope, a send whose every
 * recipient address the user personally TYPED in this conversation is already
 * user-consented — the ask is the approval. Live 2026-08-12: "…and then send
 * me an email to nathan@…" still carded the send, and the approve-resume then
 * failed, so the explicitly requested email never went out.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-send-mandate-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-send-mandate\n', 'utf8');

const eventlog = await import('./eventlog.js');
const policy = await import('./pending-action-policy.js');
const proactivity = await import('../../agents/proactivity-policy.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function chatWithAsk(text: string): string {
  const session = eventlog.createSession({ id: `send-mandate-${++serial}`, kind: 'chat' });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  return session.id;
}

const DIRECT_SEND = {
  kind: 'external_send',
  toolName: 'composio_execute_tool',
  payload: {
    tool_slug: 'OUTLOOK_SEND_EMAIL',
    arguments: JSON.stringify({
      subject: 'Deal analysis',
      body: 'Here you go.',
      to_recipients: [{ emailAddress: { address: 'avery@example.ai' } }],
      from: { emailAddress: { address: 'clem@corp.example.com' } },
    }),
    connected_account_id: 'ca_fixture',
  },
};

test('a YOLO send always parks for a fresh human decision, even when the user typed the recipient', () => {
  const sessionId = chatWithAsk(
    'Analyze the deals and then send me an email to avery@example.ai please.',
  );
  assert.equal(
    policy.pendingActionRequiresHumanApproval(DIRECT_SEND, { sessionId }),
    true,
    'the original ask identifies the target but is not fresh boundary consent',
  );

  // No session context → the card stays (existing behavior byte-for-byte).
  assert.equal(policy.pendingActionRequiresHumanApproval(DIRECT_SEND), true);

  // A recipient the user never typed keeps the card.
  const strangerSession = chatWithAsk('Analyze the deals and email the summary to my team.');
  assert.equal(
    policy.pendingActionRequiresHumanApproval(DIRECT_SEND, { sessionId: strangerSession }),
    true,
    'an address the user never wrote is not consented',
  );

  // The SENDER address appearing in conversation can never satisfy the door.
  const senderOnly = chatWithAsk('Use clem@corp.example.com to send the mail.');
  assert.equal(
    policy.pendingActionRequiresHumanApproval(DIRECT_SEND, { sessionId: senderOnly }),
    true,
    'from/sender fields are not recipients',
  );
});

test('a two-step send-draft also always parks for the fresh human decision', () => {
  const sessionId = chatWithAsk(
    'Pull the opportunities, analyze them, and then send me an email to avery@example.ai please.',
  );
  const messageId = 'AAMkADExOGRmNmY1LWQ1MmEtNGUwMi05fixture0';
  eventlog.writeToolOutput({
    sessionId,
    callId: 'call_create_draft_fixture',
    invocationNonce: 'nonce-create-draft',
    tool: 'composio_execute_tool',
    output: JSON.stringify({
      successful: true,
      data: {
        id: messageId,
        subject: 'Deal analysis',
        toRecipients: [{ emailAddress: { address: 'avery@example.ai', name: 'Nathan' } }],
        from: { emailAddress: { address: 'clem@corp.example.com' } },
      },
    }),
  });
  const sendDraft = {
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: {
      tool_slug: 'OUTLOOK_SEND_DRAFT',
      arguments: JSON.stringify({ user_id: 'clem@corp.example.com', message_id: messageId }),
      connected_account_id: 'ca_fixture',
    },
  };
  assert.equal(
    policy.pendingActionRequiresHumanApproval(sendDraft, { sessionId }),
    true,
    'a draft echo does not bypass the final irreversible-send decision',
  );

  // A draft whose echo names a recipient the user never typed keeps the card.
  const otherSession = chatWithAsk('Send the draft when ready.');
  eventlog.writeToolOutput({
    sessionId: otherSession,
    callId: 'call_create_draft_other',
    invocationNonce: 'nonce-create-other',
    tool: 'composio_execute_tool',
    output: JSON.stringify({
      successful: true,
      data: {
        id: messageId,
        toRecipients: [{ emailAddress: { address: 'someone-else@example.com' } }],
      },
    }),
  });
  assert.equal(
    policy.pendingActionRequiresHumanApproval(sendDraft, { sessionId: otherSession }),
    true,
  );

  // A send whose payload references no resolvable resource keeps the card.
  const unresolved = {
    ...sendDraft,
    payload: {
      tool_slug: 'OUTLOOK_SEND_DRAFT',
      arguments: JSON.stringify({ user_id: 'clem@corp.example.com', message_id: 'AAMk-neverstored00' }),
      connected_account_id: 'ca_fixture',
    },
  };
  assert.equal(policy.pendingActionRequiresHumanApproval(unresolved, { sessionId }), true);
});

test('outside YOLO scope the card always stays', () => {
  const sessionId = chatWithAsk('Send me an email to avery@example.ai please.');
  const saved = proactivity.loadProactivityPolicy();
  writeFileSync(
    path.join(TMP_HOME, 'state', 'proactivity-policy.json'),
    JSON.stringify({ ...saved, autoApproveScope: 'workspace' }, null, 2),
    'utf8',
  );
  try {
    assert.equal(
      policy.pendingActionRequiresHumanApproval(DIRECT_SEND, { sessionId }),
      true,
      'the mandate door is a YOLO-scope door only',
    );
  } finally {
    writeFileSync(
      path.join(TMP_HOME, 'state', 'proactivity-policy.json'),
      JSON.stringify(saved, null, 2),
      'utf8',
    );
  }
});
