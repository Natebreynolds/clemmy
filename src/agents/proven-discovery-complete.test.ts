/**
 * Run: node scripts/run-tests-isolated.mjs src/agents/proven-discovery-complete.test.ts
 *
 * When a turn's proven operations are already disclosed as callable, the
 * planning instruction itself says discovery is done. Live 279653 and 280037:
 * the trailing PROVEN OPERATION note alone did not stop a 31 s / 10 s
 * tool_search account_selection frame on every calendar turn.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clem-discovery-complete-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { renderProvenDiscoveryCompleteLine } = await import('./orchestrator.js');

const descriptor = { id: 'cap:resolved:outlook_get_calendar_view:definition:abc', effect: 'read' } as never;

test('a callable proven disclosure yields the discovery-complete line with tools and the bound account', () => {
  const line = renderProvenDiscoveryCompleteLine({
    skipDiscoverySearch: true,
    descriptors: [descriptor],
    tools: ['outlook_get_calendar_view'],
    boundAccounts: [{ slug: 'OUTLOOK_GET_CALENDAR_VIEW', accountId: 'ca_one', label: 'alex@corp.example' }],
  });
  assert.ok(line);
  assert.match(line, /^\[discovery-complete\]/);
  assert.match(line, /outlook_get_calendar_view/);
  assert.match(line, /already bound by the host \(OUTLOOK_GET_CALENDAR_VIEW: alex@corp\.example \(ca_one\)\)/);
  assert.match(line, /no account_selection is needed/);
  assert.match(line, /use tool_search only for something they cannot do/);
});

test('no line without a callable disclosure, and no account claim without a bound account', () => {
  assert.equal(renderProvenDiscoveryCompleteLine({ skipDiscoverySearch: false, descriptors: [descriptor], tools: ['x'], boundAccounts: [] }), null);
  assert.equal(renderProvenDiscoveryCompleteLine({ skipDiscoverySearch: true, descriptors: [], tools: ['x'], boundAccounts: [] }), null);
  const unbound = renderProvenDiscoveryCompleteLine({ skipDiscoverySearch: true, descriptors: [descriptor], tools: ['salesforce_sf_soql_query'], boundAccounts: [] });
  assert.ok(unbound);
  assert.doesNotMatch(unbound, /already bound/);
});
