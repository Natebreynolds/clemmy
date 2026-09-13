import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-discovery-navigation-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { discoveryNavigation } = await import('./discovered-tool-context.js');
after(() => rmSync(home, { recursive: true, force: true }));
test('discovery navigation retains exact schema handles, accounts, carriers and blockers without repeating schema dumps', () => {
  const handle = { cursor: 'tool_search_schema:v1:abc:0', sha256: 'abc' };
  const rows = discoveryNavigation(JSON.stringify({ results: [
    { name: 'ATLAS_READ', capabilityRef: 'cap:read', carrier: 'work_call', selectedAccount: { accountIdentity: 'one' } },
    { name: 'ATLAS_CREATE', planningRefStatus: 'materialization_unavailable', materializationReason: 'exact_definition_unavailable' },
  ], schemas: { ATLAS_READ: { description: 'LARGE_SCHEMA'.repeat(10000) } }, schema_handles: { ATLAS_READ: handle } }));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0]?.schemaHandle, handle);
  assert.deepEqual(rows[0]?.selectedAccount, { accountIdentity: 'one' });
  assert.equal(rows[0]?.capabilityRef, 'cap:read');
  assert.equal(rows[1]?.planningRefStatus, 'materialization_unavailable');
  assert.equal(rows[1]?.capabilityRef, undefined);
  assert.doesNotMatch(JSON.stringify(rows), /LARGE_SCHEMA/);
  assert.deepEqual(discoveryNavigation('malformed'), []);
});
