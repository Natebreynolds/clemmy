import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalComposioEmailTransport,
  correlatePendingActionRequest,
  exactEmailShape,
  exactProviderPayloadObservation,
  naturalSendPrompt,
  parseProofComposioPayloadLog,
  type PendingActionFile,
  type ProofGraphEvent,
} from './scenarios/pending-action-exact-once.js';
import { replyOffersFinalExecuteGate } from './scenarios/pending-action-gate.js';
import { createProofComposioShim } from './provision.js';

test('proof Composio payload log preserves the exact provider argument bytes', () => {
  const payload = '{"to":"proof+approve@example.com","subject":"Exact \\"quoted\\" subject","body":"line one\\nline two"}';
  const rows = parseProofComposioPayloadLog([
    JSON.stringify({ slug: 'GMAIL_SEND_EMAIL', payload }),
    '{bad json',
    JSON.stringify({ slug: '', payload: '{}' }),
    '',
  ].join('\n'));

  assert.deepEqual(rows, [{ slug: 'GMAIL_SEND_EMAIL', payload }]);
  assert.equal(rows[0]?.payload, payload);
});

test('exact provider observation requires one byte-identical dispatch', () => {
  const expected = '{"to":"proof+approve@example.com","subject":"Proof exact once","body":"Only once."}';
  const exact = exactProviderPayloadObservation(expected, [
    { slug: 'GMAIL_SEND_EMAIL', payload: expected },
  ]);
  assert.equal(exact.pass, true);
  assert.equal(exact.exactCount, 1);

  const reordered = exactProviderPayloadObservation(expected, [
    {
      slug: 'GMAIL_SEND_EMAIL',
      payload: '{"subject":"Proof exact once","to":"proof+approve@example.com","body":"Only once."}',
    },
  ]);
  assert.equal(reordered.pass, false, 'semantic equality is not byte equality');

  const duplicate = exactProviderPayloadObservation(expected, [
    { slug: 'GMAIL_SEND_EMAIL', payload: expected },
    { slug: 'GMAIL_SEND_EMAIL', payload: expected },
  ]);
  assert.equal(duplicate.pass, false);
  assert.equal(duplicate.exactCount, 2);
});

test('proof correlates queued actions by the durable sourceUserSeq edge, not payload vocabulary', () => {
  const request = 'Send the exact fixture email.';
  const events: ProofGraphEvent[] = [
    { seq: 3, type: 'user_input_received', data: { text: 'Older request.' } },
    {
      seq: 5,
      type: 'autonomy_note',
      data: {
        kind: 'pending_action_queued',
        sourceUserSeq: 3,
        pendingActionId: 'pa-older',
      },
    },
    { seq: 8, type: 'user_input_received', data: { text: request } },
    {
      seq: 11,
      type: 'autonomy_note',
      data: {
        kind: 'pending_action_queued',
        sourceUserSeq: 8,
        pendingActionId: 'pa-request-owned',
        payloadHash: 'hash-with-recipient_email-alias',
        approvalIntent: 'request_now',
        autoMaterialize: true,
      },
    },
    {
      seq: 12,
      type: 'autonomy_note',
      data: {
        kind: 'pending_action_queued',
        sourceUserSeq: 3,
        pendingActionId: 'pa-unrelated-late-edge',
      },
    },
    { seq: 13, type: 'user_input_received', data: { text: '[approval-resume] synthetic', synthetic: true } },
  ];

  assert.deepEqual(correlatePendingActionRequest(events, request), {
    sourceUserSeq: 8,
    pendingActionIds: ['pa-request-owned'],
    edgeCount: 1,
    typedRequestNowEdgeCount: 1,
  });
  assert.deepEqual(correlatePendingActionRequest(events, 'Missing request.'), {
    sourceUserSeq: null,
    pendingActionIds: [],
    edgeCount: 0,
    typedRequestNowEdgeCount: 0,
  });
});

function pendingEmailAction(
  toolName: string,
  payload: unknown,
): PendingActionFile {
  return {
    id: 'pa-proof',
    status: 'approval_requested',
    kind: 'external_send',
    toolName,
    sessionId: 'proof-session',
    approvalId: 'apr-proof',
    payloadHash: 'hash-proof',
    payload,
  };
}

test('semantic email shape accepts the provider recipient alias while canonical transport is scored separately', () => {
  const expected = {
    to: 'proof+alias@example.com',
    subject: 'Alias proof',
    body: 'Neutral fixture body.',
  };
  const canonical = pendingEmailAction('composio_execute_tool', {
    tool_slug: 'GMAIL_SEND_EMAIL',
    arguments: JSON.stringify({
      recipient_email: expected.to,
      subject: expected.subject,
      body: expected.body,
    }),
  });
  assert.equal(exactEmailShape(canonical, expected), true);
  assert.equal(canonicalComposioEmailTransport(canonical), true);

  const directButSemanticallyExact = pendingEmailAction('GMAIL_SEND_EMAIL', {
    to: expected.to,
    subject: expected.subject,
    body: expected.body,
  });
  assert.equal(exactEmailShape(directButSemanticallyExact, expected), true);
  assert.equal(
    canonicalComposioEmailTransport(directButSemanticallyExact),
    false,
    'transport failure must not erase the request-owned semantic action',
  );

  const extraField = pendingEmailAction('composio_execute_tool', {
    tool_slug: 'GMAIL_SEND_EMAIL',
    arguments: JSON.stringify({
      recipient_email: expected.to,
      subject: expected.subject,
      body: expected.body,
      cc: 'extra@example.com',
    }),
  });
  assert.equal(exactEmailShape(extraField, expected), false, 'exact shape rejects extra fields');

  const ambiguousRecipient = pendingEmailAction('composio_execute_tool', {
    tool_slug: 'GMAIL_SEND_EMAIL',
    arguments: JSON.stringify({
      to: expected.to,
      recipient_email: expected.to,
      subject: expected.subject,
      body: expected.body,
    }),
  });
  assert.equal(exactEmailShape(ambiguousRecipient, expected), false, 'exact shape requires one recipient key');
});

test('proof prompt keeps a neutral fixture body exact', () => {
  const prompt = naturalSendPrompt({
    to: 'fixture@example.com',
    subject: 'Fixture subject',
    body: 'Neutral fixture body.',
  });
  assert.match(prompt, /Body: Neutral fixture body\./);
  assert.doesNotMatch(prompt, /must (?:never )?reach|provider shim/i);
});

test('final execute-gate prose does not need to predict the materialized approval id', () => {
  const reply = 'The exact email action is queued but not sent. Do you want me to execute it?';
  assert.equal(reply.includes('apr-'), false);
  assert.equal(replyOffersFinalExecuteGate(reply), true);
  assert.equal(replyOffersFinalExecuteGate('The exact email action is queued for later.'), false);
  assert.equal(replyOffersFinalExecuteGate('I could not send it. What should I do next?'), false);
  assert.equal(replyOffersFinalExecuteGate('The send is blocked. Which account should I use?'), false);
});

test('proof-local Composio shim records the raw provider argument and keeps the legacy slug log', {
  skip: process.platform === 'win32' ? 'POSIX proof shim execution test' : false,
}, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-composio-shim-'));
  try {
    createProofComposioShim(home);
    writeFileSync(path.join(home, 'proof-composio-connected'), 'connected\n', 'utf8');
    const payload = '{"to":"proof+shim@example.com","subject":"Exact \\"shim\\" bytes","body":"line one\\nline two"}';
    execFileSync(
      path.join(home, 'proof-bin', 'composio'),
      ['execute', 'GMAIL_SEND_EMAIL', '-d', payload],
      {
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      },
    );

    assert.deepEqual(
      parseProofComposioPayloadLog(readFileSync(path.join(home, 'proof-composio-payloads.log'), 'utf8')),
      [{ slug: 'GMAIL_SEND_EMAIL', payload }],
    );
    assert.equal(
      readFileSync(path.join(home, 'proof-composio-dispatches.log'), 'utf8'),
      'GMAIL_SEND_EMAIL\n',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
