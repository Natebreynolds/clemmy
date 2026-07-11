import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMailboxEmails } from './sender-verify.js';

// Fix A (findings 1,7): a Composio FAILURE envelope is returned as data, and its
// error text can carry a stray email literal. Identity enrichment must NOT
// scavenge that into a cached mailbox — structuredOnly disables the regex
// fallback so only real profile fields count.
test('extractMailboxEmails: structuredOnly ignores an email buried in an error envelope', () => {
  const failureEnvelope = {
    successful: false,
    error: 'Connection token expired — contact support@composio.dev to reconnect.',
  };
  // Default (sender-verify's own guarded path) scavenges the stray address...
  assert.deepEqual(extractMailboxEmails(failureEnvelope), ['support@composio.dev']);
  // ...but the enrichment/alias path must get NOTHING from it.
  assert.deepEqual(extractMailboxEmails(failureEnvelope, { structuredOnly: true }), []);
});

test('extractMailboxEmails: structuredOnly still reads REAL profile fields', () => {
  const profile = { data: { response_data: { mail: 'Nate@Scorpion.co', userPrincipalName: 'nate@scorpion.co' } } };
  assert.deepEqual(extractMailboxEmails(profile, { structuredOnly: true }), ['nate@scorpion.co']);
});

test('extractMailboxEmails: structuredOnly reads proxyAddresses (SMTP: prefixes normalized)', () => {
  const profile = { data: { proxyAddresses: ['SMTP:Primary@corp.com', 'smtp:alias@corp.com'] } };
  const got = extractMailboxEmails(profile, { structuredOnly: true });
  assert.ok(got.includes('primary@corp.com'));
  assert.ok(got.includes('alias@corp.com'));
});
