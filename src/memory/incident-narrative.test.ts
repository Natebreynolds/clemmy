/**
 * Run: npx tsx --test src/memory/incident-narrative.test.ts
 *
 * Pins the incident-narrative quarantine (live 2026-07-31: reflection turned
 * a bad afternoon into durable "character" facts that primed the Salesforce
 * misdiagnosis months later). Complaints about moments stay episodic; durable
 * knowledge and user rules pass untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeIncidentNarrative } from './incident-narrative.js';

test('the two live poison facts quarantine, verbatim', () => {
  assert.equal(looksLikeIncidentNarrative(
    "Nate's tool environment is persistently unreliable, with expired Composio connections, missing CLI installs, and stale Salesforce sessions repeatedly requiring re-auth",
  ), true);
  assert.equal(looksLikeIncidentNarrative(
    'Tool infrastructure reliability is a recurring cross-cutting concern, with sf CLI unavailability, expired Composio integrations, Salesforce daemon permission errors',
  ), true);
  assert.equal(looksLikeIncidentNarrative('The OAuth token keeps expiring on the daemon'), true);
});

test('durable knowledge and rules never quarantine', () => {
  const keep = [
    'User maintains a spreadsheet tracking 120 law firm accounts assigned to 8 sales representatives',
    'The pipeline uses Salesforce CLI via the sf data query --json command to run SOQL queries',
    'Salesforce is accessed ONLY through the authenticated sf CLI, never Composio',
    'The client is unreliable about replying to emails before noon',
    'Weekly meeting with the marketing team happens Tuesdays',
  ];
  for (const text of keep) {
    assert.equal(looksLikeIncidentNarrative(text), false, `must keep: ${text.slice(0, 60)}`);
  }
});
