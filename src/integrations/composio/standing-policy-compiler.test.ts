import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStandingPolicyDescriptor } from '../../memory/policy-enforcement.js';
import { compileComposioStandingPolicy } from './standing-policy-compiler.js';

test('adapter compiler seals extracted operands instead of leaving prose as execution authority', () => {
  const senderSource = 'Always send Outlook email via Owner+Ops@Example.com.';
  const sender = compileComposioStandingPolicy(senderSource);
  assert.equal(sender.deterministic, true);
  assert.equal(sender.policyClass, 'verified_sender_identity');
  assert.equal(sender.directives[0]?.kind, 'verified_identity');
  if (sender.directives[0]?.kind === 'verified_identity') {
    assert.equal(sender.directives[0].requiredValue, 'owner+ops@example.com');
  }
  assert.deepEqual(parseStandingPolicyDescriptor(JSON.stringify(sender), senderSource), sender);

  const routeSource = 'For Acme calendar lookups, use Outlook connection ca_abc123.';
  const route = compileComposioStandingPolicy(routeSource);
  assert.equal(route.directives[0]?.kind, 'route');
  if (route.directives[0]?.kind === 'route') {
    assert.equal(route.directives[0].bindingValue, 'ca_abc123');
    assert.ok(route.directives[0].intentLabels.includes('acme'));
  }
});

test('unsupported prose remains sealed prompt guidance, never pretend dispatch enforcement', () => {
  const source = 'Client-facing reports must use generic vendor labels.';
  const policy = compileComposioStandingPolicy(source);
  assert.equal(policy.policyClass, 'unclassified');
  assert.equal(policy.deterministic, false);
  assert.deepEqual(policy.directives, []);
});

test('non-executable provider rules bind the CONNECTED toolkits they name — never a list compiled into the harness', async () => {
  // Owner rule (2026-09-02): the harness holds no toolkit names. A policy
  // binds to whichever connected toolkit its own words name; the connection
  // registry is the authority for what exists.
  const { _setConnectedToolkitsSnapshotForTests } = await import('./client.js');
  const source = 'Route all Outlook sends through the shared compliance mailbox.';
  try {
    _setConnectedToolkitsSnapshotForTests([
      { slug: 'outlook', connectionId: 'ca_test_outlook', status: 'ACTIVE' },
      { slug: 'googlesheets', connectionId: 'ca_test_sheets', status: 'ACTIVE' },
    ]);
    const policy = compileComposioStandingPolicy(source);
    assert.equal(policy.deterministic, false);
    assert.deepEqual(policy.directives, []);
    assert.deepEqual(policy.bindings, [{ adapterId: 'composio', kind: 'toolkit', value: 'outlook' }],
      'only the connected toolkit the text names is bound');
    assert.ok(parseStandingPolicyDescriptor(JSON.stringify(policy), source));

    // A toolkit that is NOT connected is never bound, however familiar its name.
    _setConnectedToolkitsSnapshotForTests([{ slug: 'googlesheets', connectionId: 'ca_test_sheets', status: 'ACTIVE' }]);
    assert.deepEqual(compileComposioStandingPolicy(source).bindings, []);

    // A connected toolkit with a multi-word slug is recognized however the
    // text spells it.
    _setConnectedToolkitsSnapshotForTests([{ slug: 'google_sheets', connectionId: 'ca_test_gs', status: 'ACTIVE' }]);
    assert.deepEqual(
      compileComposioStandingPolicy('Never overwrite the Google Sheets log tab.').bindings,
      [{ adapterId: 'composio', kind: 'toolkit', value: 'google_sheets' }],
    );
  } finally {
    _setConnectedToolkitsSnapshotForTests(null);
  }
});
