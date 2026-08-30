/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/tools/composio-reviewed-cli-effect-scope.red.test.ts
 *
 * OPEN-THE-GATES Slice 5. `composioToolkitSuppressedByReviewedCliRead` ran
 * before any effect check, so a read-only reviewed CLI (`salesforce.data.query`)
 * dropped Composio Salesforce writes too. The replacement has also never
 * crossed, so even reads must stay until the CLI descriptor is reachable.
 *
 * Re-break two ways:
 *   (i)  toolkit-only drop (old predicate)
 *   (ii) drop a write slug
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-composio-cli-effect-scope-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.HOME = HOME;
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const {
  composioDiscoveryDispositionAgainstReviewedCli,
  composioToolkitSuppressedByReviewedCliRead,
  composioToolkitOverlapsReviewedCliRead,
} = await import('./tool-search-provider-sources.js');

test.after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test('NEGATIVE: a toolkit-only call must not suppress discovery', () => {
  assert.equal(composioToolkitSuppressedByReviewedCliRead('salesforce'), false);
  assert.equal(
    composioDiscoveryDispositionAgainstReviewedCli({
      toolkit: 'salesforce',
      slug: 'SALESFORCE_CREATE_OPPORTUNITY',
    }),
    'keep',
  );
});

test('NEGATIVE: a write is kept even when the toolkit overlaps a reviewed CLI read', () => {
  assert.equal(
    composioDiscoveryDispositionAgainstReviewedCli({
      toolkit: 'salesforce',
      slug: 'SALESFORCE_UPDATE_ACCOUNT',
    }),
    'keep',
  );
  assert.equal(
    composioDiscoveryDispositionAgainstReviewedCli({
      toolkit: 'salesforce',
      slug: 'SALESFORCE_SOQL_QUERY',
    }),
    'keep',
    'reads stay until the replacement is reachable',
  );
});

test('re-break (i): the old toolkit-only drop is gone from the search merge', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./tool-search-provider-sources.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(
    src,
    /if \(composioToolkitSuppressedByReviewedCliRead\(toolkit\)\) return false;/,
    'the merge must not drop a toolkit before classifying effect',
  );
});

test('re-break (ii): overlap is not enough to demote a write', () => {
  // Overlap without a connected CLI is false in this isolated home.
  assert.equal(composioToolkitOverlapsReviewedCliRead('outlook'), false);
  assert.equal(
    composioDiscoveryDispositionAgainstReviewedCli({
      toolkit: 'salesforce',
      slug: 'SALESFORCE_CREATE_LEAD',
    }),
    'keep',
  );
});
