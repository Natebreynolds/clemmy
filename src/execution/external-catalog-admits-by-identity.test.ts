/**
 * STEP 2, site 3 of docs/SPELLING-IS-NOT-IDENTITY-PLAN-2026-09-18.md —
 * CHARACTERIZATION. The plan listed this site as Category B. Executing it
 * proved otherwise, and this test is the evidence.
 *
 * `prepareWorkflowStepExternalCatalog` reconstructs exact ports for the
 * provider operations a step names. It admits an `allowedTools` entry only when
 * the name is spelled UPPERCASE — a guard with a real incident behind it:
 * uppercasing the local tool name `composio_search_tools` minted a phantom
 * `COMPOSIO_SEARCH_TOOLS` "operation" and parked scorpion-facebook-trends on a
 * capability block (2026-09-01).
 *
 * Replacing that with `operationIdentity` was tried and REVERTED: the
 * red-before proof would not go red. Identity and shape reach the same verdict
 * for every input this site sees, because the only names it must admit are
 * composio slugs, which are uppercase by construction. A change that cannot be
 * shown to change anything is complexity, not a fix — so this site stays as it
 * is and is reclassified Category A (composio-specific admission).
 *
 * These pins exist so the behaviour is protected either way: the phantom stays
 * excluded, a reviewed CLI read stays excluded (it is materialized through the
 * acquisition registry at step start, never provisioned as a provider
 * operation), and an uppercase provider slug still reaches provisioning.
 *
 * Run: node scripts/run-tests-isolated.mjs src/execution/external-catalog-admits-by-identity.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-external-catalog-identity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-external-catalog-identity\n', 'utf8');

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { prepareWorkflowStepExternalCatalog } = await import('./workflow-step-external-catalog.js');

const prepare = (allowedTools: string[], prompt = 'Do the authored work.') =>
  prepareWorkflowStepExternalCatalog({ immutablePrompt: prompt, allowedTools });

test.after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

test('a local tool name is never minted into a phantom operation', async () => {
  // THE 2026-09-01 GUARD, kept — by identity now rather than by spelling.
  const prepared = await prepare(['composio_search_tools']);
  assert.equal(prepared.status, 'none',
    'uppercasing a local tool name must not manufacture COMPOSIO_SEARCH_TOOLS');
});

test('a reviewed CLI read is not provisioned as a provider operation', async () => {
  // It is a real operation — operationIdentity says so — but its carrier is a
  // local binary, acquired at step start. Sending it down the composio
  // provisioning path would be the mirror of the phantom bug.
  const prepared = await prepare(['salesforce_sf_soql_query']);
  assert.equal(prepared.status, 'none', 'a local CLI read has no provider ports to reconstruct');
});

test('an unknown lowercase name is still not an operation', async () => {
  const prepared = await prepare(['totally_unknown_local_thing']);
  assert.equal(prepared.status, 'none');
});

test('a composio slug no registry carries yet is still admitted', async () => {
  // Shape remains the fallback for a provider operation discovery has not seen.
  // With no accepted source it cannot provision, and refusing for THAT reason
  // proves it was admitted as an operation rather than skipped as a name.
  const prepared = await prepare(['OUTLOOK_OUTLOOK_SEND_EMAIL']);
  assert.notEqual(prepared.status, 'none',
    'an uppercase provider slug must still reach provisioning');
});
