/**
 * STEP 2, site 1 of docs/SPELLING-IS-NOT-IDENTITY-PLAN-2026-09-18.md.
 *
 * `callable-surface` answers "can this name be dispatched this turn, and
 * through what?". It decided that from two name SHAPES — a composio-style
 * UPPER_SNAKE slug, or an MCP `server__tool` identity. An operation matching
 * neither fell through to "not provably dispatchable this turn" with a null
 * carrier.
 *
 * Every reviewed CLI read matches neither: they are lower_snake. So a Salesforce
 * read whose manifest sat in the catalog, declaring both its carrier and its
 * read effect, was reported unreachable.
 *
 * Reachability now comes from what the operation DECLARES. Shape survives only
 * for a provider slug discovery has not seen yet — the one case no registry can
 * answer.
 *
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/callable-surface-declared-identity.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-callable-surface-identity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-callable-surface-identity\n', 'utf8');

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { resolveCallable } = await import('./callable-surface.js');

/** The reviewed CLI read the whole wave is measured against. */
const CLI_READ = 'salesforce_sf_soql_query';

test.after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

test('a declared reviewed-CLI read is reachable through a local carrier', () => {
  const entry = resolveCallable(CLI_READ);
  assert.equal(
    entry.reachable,
    true,
    'THE REGRESSION: this reported reachable:false because the name is not UPPER_SNAKE',
  );
  assert.equal(entry.carrier, 'call_tool', 'a local binary is reached through the local dispatcher, never the composio gateway');
});

test('a composio slug still reaches the provider carrier', () => {
  // Shape still answers for a provider slug no registry carries yet — the one
  // case identity cannot cover, and the reason that branch is kept.
  const entry = resolveCallable('OUTLOOK_OUTLOOK_SEND_EMAIL');
  assert.equal(entry.reachable, true);
  assert.equal(entry.carrier, 'provider_carrier');
});

test('an MCP identity still reaches call_tool', () => {
  const entry = resolveCallable('fixtureserver__read_rows');
  assert.equal(entry.reachable, true);
  assert.equal(entry.carrier, 'call_tool');
});

test('a bare unknown name is still not dispatchable', () => {
  // Identity must not manufacture reachability: this is what keeps the branch
  // honest rather than merely permissive.
  const entry = resolveCallable('totally_unknown_local_thing');
  assert.equal(entry.reachable, false);
  assert.equal(entry.carrier, null);
});
