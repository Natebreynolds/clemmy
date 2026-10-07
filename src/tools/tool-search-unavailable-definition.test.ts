/**
 * A provider that LISTS an operation but will not serve its definition must
 * not be searched for by the same name again: tool_search names the toolkit's
 * served siblings instead. Live 2026-10-06: Slack listed
 * SLACK_DELETE_A_SLACK_REMINDER, served SLACK_DELETE_REMINDER, and the brain
 * burned six refused calls on the listed name before blaming the provider.
 *
 * Run: node scripts/run-tests-isolated.mjs src/tools/tool-search-unavailable-definition.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-tool-search-unavailable-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-tool-search-unavailable\n');

const fixtures = await import('../runtime/harness/current-capability-manifest.fixture.js');
const toolSearch = await import('./tool-search-tool.js');
const prior = fixtures.installCurrentCapabilityManifestFixtures([
  { operationId: 'SLACK_DELETE_REMINDER', providerKind: 'composio', effect: 'external_write' },
  { operationId: 'SLACK_CREATE_A_REMINDER', providerKind: 'composio', effect: 'external_write' },
  { operationId: 'SLACK_SEND_MESSAGE', providerKind: 'composio', effect: 'external_write' },
]);
test.after(() => {
  fixtures.restoreCurrentCapabilityManifestFixtures(prior);
  rmSync(HOME, { recursive: true, force: true });
});

test('an unmaterializable listed operation points at served siblings of the same toolkit, never at itself', () => {
  const siblings = toolSearch.servedSiblingsFor('SLACK_DELETE_A_SLACK_REMINDER', 'delete a slack reminder');
  assert.deepEqual(siblings, ['SLACK_CREATE_A_REMINDER', 'SLACK_DELETE_REMINDER']);
  const step = toolSearch.unavailableDefinitionNextStep('SLACK_DELETE_A_SLACK_REMINDER', siblings);
  assert.match(step, /listed by its provider but its definition could not be fetched/);
  assert.match(step, /SLACK_DELETE_REMINDER/);
  assert.doesNotMatch(step, /Search once for the exact operation/);
  // No served sibling: plain-word search, still never the same name.
  const alone = toolSearch.unavailableDefinitionNextStep('SLACK_DELETE_A_SLACK_REMINDER', []);
  assert.match(alone, /plain words for what you need, without this name/);
});
