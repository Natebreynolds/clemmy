/**
 * Saving a CLI must make it PLANNABLE, not merely visible.
 *
 * Live 2026-08-28: `sf` was in CLEMMY_SAVED_CLIS, local_cli_list offered it,
 * and Clem said "I'm blocked from accessing the authenticated Salesforce CLI"
 * — because a saved name reaches six consumers and NONE of them is the
 * capability index or the plan_task ref mint. Every plan citing it refused as
 * undisclosed.
 *
 * The reconcile that fixes this keyed eligibility on the catalog CONNECT
 * registry, which had no state on disk at all, so it could never fire for a
 * CLI the user had saved. saved-clis.ts exists precisely because tools like
 * `sf` EPERM under the daemon (macOS TCC) and can never be PATH-scanned —
 * saving is the only way they are known, so it has to be the signal that
 * counts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const RECONCILE = new URL('./catalog-reviewed-cli-reconcile.ts', import.meta.url);
const DISCOVERY = new URL('../cli-discovery.ts', import.meta.url);

test('a saved CLI is user-confirmed for reviewed-read provisioning', () => {
  const src = readFileSync(RECONCILE, 'utf8');
  assert.match(src, /getSavedClis/, 'the reconcile must consult the saved-CLI list');
  assert.match(
    src,
    /function entryIsUserConfirmed/,
    'eligibility must be a named predicate, not an inline connect lookup',
  );
  // The exact regression: gating on the connect registry alone.
  assert.doesNotMatch(
    src,
    /if \(!connected\[entry\.id\] \|\| forgotten/,
    'provisioning must not require a catalog connect when the user has saved the CLI',
  );
  assert.doesNotMatch(
    src,
    /if \(!connected\[catalog\.id\] \|\| forgotten/,
    'removal must not drop a descriptor for a CLI the user still has saved',
  );
});

test('eligibility matches the command the user types, not the internal id', () => {
  const src = readFileSync(RECONCILE, 'utf8');
  // The save box takes a bare command ("sf"); catalog ids are internal keys the
  // user never sees. Matching on id would silently never fire.
  assert.match(src, /entry\.command\.trim\(\)\.toLowerCase\(\)/);
});

test('reviewed reads reconcile wherever the CLI inventory refreshes', () => {
  const src = readFileSync(DISCOVERY, 'utf8');
  // This seam already documents itself as "the one place a newly installed CLI
  // becomes a retrievable capability". Being retrievable is not the same as
  // being citable, and both have to happen here or a saved CLI stays unusable
  // until something else happens to run.
  assert.match(src, /reconcileCatalogReviewedCliReads/);
  assert.match(
    src,
    /scheduleLocalCapabilityIndex\(async \(\) => \{[\s\S]*indexDiscoveredClis[\s\S]*reconcileCatalogReviewedCliReads/,
    'the reviewed-read reconcile must run in the same inventory refresh as indexing',
  );
});
