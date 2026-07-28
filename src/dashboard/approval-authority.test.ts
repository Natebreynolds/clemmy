import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exactApprovalAuthorityMatches,
  selectSoleExactApprovalDuplicate,
  type ApprovalAuthority,
} from '../runtime/harness/approval-authority.js';

function approval(
  overrides: Partial<ApprovalAuthority> = {},
): ApprovalAuthority {
  return {
    approvalId: 'apr-original',
    sessionId: 'sess-social',
    tool: 'composio_execute_tool',
    args: {
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: {
        to: 'approved@example.com',
        subject: 'Approved subject',
        body: 'Approved body',
      },
      pendingActionId: 'pa-approved',
    },
    resumeKey: null,
    ...overrides,
  };
}

test('exact approval authority ignores display identity but preserves the exact durable action', () => {
  const granted = approval();
  const duplicate = approval({
    approvalId: 'apr-fresh',
    args: {
      pendingActionId: 'pa-approved',
      arguments: {
        body: 'Approved body',
        subject: 'Approved subject',
        to: 'approved@example.com',
      },
      tool_slug: 'GMAIL_SEND_EMAIL',
    },
  });

  assert.equal(
    exactApprovalAuthorityMatches(granted, duplicate),
    true,
    'object key order and a fresh approval id do not change action authority',
  );
  assert.equal(selectSoleExactApprovalDuplicate(granted, [duplicate]), duplicate);
});

test('changed tool, recipient, payload, pending action, session, or resume key cannot inherit approval', () => {
  const granted = approval();
  const changed: Array<[string, ApprovalAuthority]> = [
    ['tool', approval({ approvalId: 'apr-tool', tool: 'airtable_create_record' })],
    ['recipient', approval({
      approvalId: 'apr-recipient',
      args: {
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: {
          to: 'different@example.com',
          subject: 'Approved subject',
          body: 'Approved body',
        },
        pendingActionId: 'pa-approved',
      },
    })],
    ['payload', approval({
      approvalId: 'apr-payload',
      args: {
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: {
          to: 'approved@example.com',
          subject: 'Changed subject',
          body: 'Approved body',
        },
        pendingActionId: 'pa-approved',
      },
    })],
    ['pending action', approval({
      approvalId: 'apr-pending-action',
      args: {
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: {
          to: 'approved@example.com',
          subject: 'Approved subject',
          body: 'Approved body',
        },
        pendingActionId: 'pa-different',
      },
    })],
    ['session', approval({ approvalId: 'apr-session', sessionId: 'sess-other' })],
    ['resume key', approval({ approvalId: 'apr-resume-key', resumeKey: 'resume:different' })],
  ];

  for (const [label, candidate] of changed) {
    assert.equal(exactApprovalAuthorityMatches(granted, candidate), false, label);
    assert.equal(
      selectSoleExactApprovalDuplicate(granted, [candidate]),
      null,
      `${label} approval remains pending and cannot authorize an external write`,
    );
  }
});

test('a mixed pending set never resumes because the runtime resume decision is session-wide', () => {
  const granted = approval();
  const exact = approval({ approvalId: 'apr-exact' });
  const changedRecipient = approval({
    approvalId: 'apr-other-recipient',
    args: {
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: {
        to: 'other@example.com',
        subject: 'Approved subject',
        body: 'Approved body',
      },
      pendingActionId: 'pa-approved',
    },
  });

  assert.equal(
    selectSoleExactApprovalDuplicate(granted, [exact, changedRecipient]),
    null,
    'resuming the exact row alongside another interruption could broaden authority',
  );
  assert.equal(
    selectSoleExactApprovalDuplicate(granted, []),
    null,
    'no pending action means there is nothing to resume',
  );
});

test('non-JSON authority fails closed instead of collapsing to a matching payload', () => {
  const granted = approval({ args: { value: undefined } });
  const candidate = approval({ approvalId: 'apr-fresh', args: { value: undefined } });
  assert.equal(exactApprovalAuthorityMatches(granted, candidate), false);
  assert.equal(selectSoleExactApprovalDuplicate(granted, [candidate]), null);
});
