/**
 * STEP 2, site 5 of docs/SPELLING-IS-NOT-IDENTITY-PLAN-2026-09-18.md —
 * CHARACTERIZATION. Listed as Category B; executing it proved otherwise.
 *
 * `normalizedOperationIds` uppercases every id and requires three or more
 * segments. Two things follow, and only one of them is a hazard:
 *
 *  1. NOT a live defect. The scope filter is consulted only for `composio`
 *     catalog entries — every other providerKind short-circuits past it in
 *     admit-and-compile-accepted-source.ts — and both sides of the comparison
 *     uppercase, so a reviewed CLI read passes through unaffected. Its only
 *     producer, workflow-step-external-catalog, admits three-or-more-segment
 *     composio slugs exclusively, so nothing reaches the throw.
 *
 *  2. A LATENT hazard worth naming. The uppercasing MUTATES identity: a
 *     lower_snake operation stored here is no longer the operation it names.
 *     And the segment floor rejects a two-segment provider slug (GMAIL_SEND)
 *     and any MCP identity (server__tool) outright, by throwing. Today nothing
 *     sends those; the day something does, it fails as a scope error rather
 *     than as anything legible.
 *
 * No change was made: with no reachable failure, a rewrite here would be
 * complexity rather than a fix — the same conclusion the red-before proof
 * forced at site 3. These pins record the boundary so a later change is a
 * decision rather than an accident.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/accepted-source-catalog-scope-identity.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-accepted-scope-identity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-accepted-scope-identity\n', 'utf8');

import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  withAcceptedSourceCatalogManifestScope,
  currentAcceptedSourceCatalogManifestScope,
} = await import('./accepted-source-catalog-scope.js');

const scopeWith = (operationIds: string[]) => withAcceptedSourceCatalogManifestScope(
  { manifestIds: [], operationIds },
  () => currentAcceptedSourceCatalogManifestScope(),
);

test.after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

test('a three-segment provider slug scopes normally', () => {
  const scope = scopeWith(['GOOGLESHEETS_VALUES_GET']);
  assert.equal(scope?.operationIds.has('GOOGLESHEETS_VALUES_GET'), true);
});

test('a lower_snake operation is accepted but stored UPPERCASED', () => {
  // The latent hazard, pinned: what goes in is not what comes out. Harmless
  // today only because non-composio entries never consult this scope.
  const scope = scopeWith(['salesforce_sf_soql_query']);
  assert.equal(scope?.operationIds.has('SALESFORCE_SF_SOQL_QUERY'), true, 'stored uppercased');
  assert.equal(scope?.operationIds.has('salesforce_sf_soql_query'), false,
    'the id it was given is NOT what the scope holds — identity was mutated by normalization');
});

test('a two-segment slug and an MCP identity are refused outright', () => {
  // Unreachable from the current producer, which is why this is a pin and not
  // a fix. It is recorded so the failure is recognisable if a producer changes.
  assert.throws(() => scopeWith(['GMAIL_SEND']), /1\.\.32 exact operation ids/);
  assert.throws(() => scopeWith(['fixture__mcp_read']), /1\.\.32 exact operation ids/);
});

test('an empty scope is refused', () => {
  assert.throws(() => scopeWith([]), /1\.\.32 exact operation ids/);
});
