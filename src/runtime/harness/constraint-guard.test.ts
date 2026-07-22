import { formatConstraintEscalation, type ConstraintViolation } from './constraint-guard.js';

// Test formatConstraintEscalation
{
  const violation: ConstraintViolation = {
    constraint: {
      id: 1,
      kind: 'constraint',
      content: 'Use corp.example email account for all Outlook sends',
      source: {},
      score: 1.0,
      active: true,
      createdAt: '2026-06-10T00:00:00Z',
      updatedAt: '2026-06-10T00:00:00Z',
      pinned: true,
    },
    reason: 'Email account "legacy@coaching.example" violates constraint requiring "corp.example"',
    toolName: 'composio_execute_tool',
    violatingField: 'from/account',
  };

  const msg = formatConstraintEscalation(violation);
  if (!msg.includes('⚠️  This action would violate a standing constraint')) {
    throw new Error('formatConstraintEscalation should include warning prefix');
  }
  if (!msg.includes('composio_execute_tool')) {
    throw new Error('formatConstraintEscalation should include tool name');
  }
}

// isEmailFamilySend — the scope gate that keeps a MAILBOX-identity constraint
// off non-email sends (live 2026-07-22: the Scorpion-Outlook email constraint
// blocked SLACK_SEND_MESSAGE and broke the user's team-activity workflow).
{
  const { isEmailFamilySend } = await import('./constraint-guard.js');
  // Email family: slug says so…
  if (!isEmailFamilySend('OUTLOOK_SEND_EMAIL', {})) throw new Error('OUTLOOK send is email-family');
  if (!isEmailFamilySend('GMAIL_SEND_EMAIL', {})) throw new Error('GMAIL send is email-family');
  if (!isEmailFamilySend('OUTLOOK_FORWARD_MAIL', {})) throw new Error('forward is email-family');
  // …or the ADDRESSING fields carry real email addresses (provider-agnostic).
  if (!isEmailFamilySend('CRM_SEND_CAMPAIGN', { to: 'a@b.com' })) throw new Error('addressed-by-email send is email-family');
  if (!isEmailFamilySend('SOME_TOOL_SEND', { to_recipients: [{ address: 'x@y.co' }] })) throw new Error('structured recipients count');
  // NOT email family: chat posts — even when an email is MENTIONED in the body.
  if (isEmailFamilySend('SLACK_SEND_MESSAGE', { channel: 'C123', text: 'contact bob@x.com about the report' })) {
    throw new Error('a Slack post is never an email send — body mentions do not count');
  }
  if (isEmailFamilySend('DISCORD_POST_MESSAGE', { channel_id: '9', content: 'hi' })) throw new Error('Discord post is not email');
}
