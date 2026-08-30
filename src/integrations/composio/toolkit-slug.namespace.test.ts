import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-toolkit-namespace-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const stateDir = path.join(TEST_HOME, 'state');
mkdirSync(stateDir, { recursive: true });
writeFileSync(path.join(stateDir, 'composio-catalog-cache.json'), JSON.stringify({
  at: Date.now(),
  data: [
    {
      slug: 'stellar_archive',
      name: 'Stellar Archive',
      authMode: 'managed',
      categories: [],
    },
    {
      slug: 'quartz_chat',
      name: 'Quartz Chat / Quartz Rooms',
      authMode: 'managed',
      categories: [],
    },
  ],
}), 'utf8');

const toolkits = await import('./toolkit-slug.js');
const alignment = await import('../../runtime/semantic-boundary/capability-namespace-alignment.js');

after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

test('cached provider namespaces extend alignment without a kernel allowlist', () => {
  const inventory = toolkits.listRegisteredToolkitNamespaces();
  assert.ok(inventory.some((entry) => (
    entry.namespaceId === 'stellar_archive'
    && entry.aliases.includes('Stellar Archive')
  )));
  assert.equal(
    toolkits.registeredToolkitNamespaceOfOperation('STELLAR_ARCHIVE_QUERY_RECORDS'),
    'stellar_archive',
    'longest exact registered prefix survives multiword generated namespaces',
  );
  assert.equal(
    toolkits.registeredToolkitNamespaceOfOperation('UNREGISTERED_PROVIDER_QUERY_RECORDS'),
    null,
    'an operation prefix does not invent adapter namespace authority',
  );
  assert.deepEqual(alignment.explicitCapabilityNamespaceConflict({
    acceptedText: 'Read the newest record from Stellar Archive.',
    namespaceInventory: inventory,
    selectedNamespaceIds: ['quartz_chat'],
  }), {
    requestedNamespaces: ['stellar_archive'],
    selectedNamespace: 'quartz_chat',
  });
  assert.equal(alignment.explicitCapabilityNamespaceConflict({
    acceptedText: 'Read Stellar Archive, then post a summary to Quartz Rooms.',
    namespaceInventory: inventory,
    selectedNamespaceIds: ['stellar_archive', 'quartz_chat'],
  }), null);
  assert.equal(alignment.explicitCapabilityNamespaceConflict({
    acceptedText: 'Collect restaurant records and put them in a new Google Sheet.',
    namespaceInventory: inventory,
    selectedNamespaceIds: ['googlesheets'],
  }), null, 'adapter-declared singular aliases align the exact curated namespace');
});
