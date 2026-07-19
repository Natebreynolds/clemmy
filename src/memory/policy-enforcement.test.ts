import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyConstraintEnforcement } from './policy-enforcement.js';

test('policy compiler recognizes only deterministic dispatch rule families', () => {
  assert.equal(classifyConstraintEnforcement(
    'Always send Outlook email via owner@example.com.',
  ).family, 'outlook_sender');
  assert.equal(classifyConstraintEnforcement(
    'For Acme calendar lookups, use Outlook connection ca_abc123.',
  ).family, 'outlook_calendar_route');
  assert.equal(classifyConstraintEnforcement(
    'Always call Salesforce via the local sf CLI, never via the Composio Salesforce toolkit.',
  ).family, 'salesforce_cli_only');
});

test('prompt guidance is never mislabeled as deterministic enforcement', () => {
  const policy = classifyConstraintEnforcement(
    'Client-facing reports must use generic vendor labels.',
  );
  assert.equal(policy.family, 'unclassified');
  assert.equal(policy.deterministic, false);
  assert.deepEqual(policy.tools, []);
});
