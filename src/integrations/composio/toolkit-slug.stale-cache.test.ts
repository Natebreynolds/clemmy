/**
 * Run: node scripts/run-tests-isolated.mjs src/integrations/composio/toolkit-slug.stale-cache.test.ts
 *
 * Live 2026-09-01: a 46-hour-old toolkit catalog cache read as EMPTY, so every
 * non-curated provider stopped being a registered namespace and the JIT read
 * edge refused FIRECRAWL_SCRAPE as an "invalid operation". Age is not identity.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-toolkit-stale-cache-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const stateDir = path.join(TEST_HOME, 'state');
mkdirSync(stateDir, { recursive: true });
writeFileSync(path.join(stateDir, 'composio-catalog-cache.json'), JSON.stringify({
  at: Date.now() - 3 * 24 * 60 * 60_000,
  data: [{ slug: 'firecrawl', name: 'Firecrawl', authMode: 'managed', categories: [] }],
}), 'utf8');

const toolkits = await import('./toolkit-slug.js');
after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

test('a toolkit in a days-old catalog cache is still a registered namespace', () => {
  assert.equal(toolkits.isRegisteredToolkitSlug('firecrawl'), true, 'a stale cache is not an empty cache');
  assert.equal(toolkits.registeredToolkitOfSlug('FIRECRAWL_SCRAPE'), 'firecrawl');
});
