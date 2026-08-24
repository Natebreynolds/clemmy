/** Run: node scripts/run-tests-isolated.mjs src/integrations/composio/capability-schema-deposit.test.ts
 *
 * CAT-7 — CATALOGUED IS NOT USABLE.
 *
 * Connect time received each operation's input schema in the same provider
 * response that named the operation, and discarded it. The result was not a
 * slower path but a closed one: every gate on the bind path resolves a schema
 * from the durable contract store, so an install could catalogue thousands of
 * operations and bind none. Measured on a live install: 2,414 catalogued
 * operations, 1 bound graph in 491 compilations.
 *
 * Reachability was bought back per turn instead, with a live discovery search
 * — the exact tax the index was built to remove, re-paid on every turn because
 * the provider result is cached in memory for 15 minutes and never persisted.
 *
 * These pins hold the deposit and, more importantly, the ONE-WRITER boundary
 * it must not violate: the index still stores no schema. The enumerator hands
 * each fact to the store that owns it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-schema-deposit-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-schema-deposit\n', 'utf8');

const { indexComposioToolkit } = await import('./capability-enumeration.js');
const { getCachedToolSchema } = await import('../../tools/composio-schema-cache.js');
const { capabilityIndexDatabase, listCapabilityOperationsForCarrier } = await import('../../memory/capability-index.js');

/** Exactly the shape `listComposioToolkitTools` returns, schema included. */
const PROVIDER_RESPONSE = [
  {
    slug: 'GENERIC_LIST_RECORDS',
    name: 'List records',
    description: 'Return the records in a collection.',
    inputParameters: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
    },
  },
  {
    slug: 'GENERIC_CREATE_ARTIFACT',
    name: 'Create artifact',
    description: 'Create a new artifact from collected rows.',
    inputParameters: {
      type: 'object',
      required: ['title', 'rows'],
      properties: { title: { type: 'string' }, rows: { type: 'array' } },
    },
  },
  // A provider that returns no schema for an operation must not break the rest.
  { slug: 'GENERIC_UNDOCUMENTED', name: 'Undocumented', description: 'No schema supplied.' },
];

/** The deposit is fire-and-forget so it can never slow a connection refresh. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('a blank install can resolve a schema for a freshly connected operation', async () => {
  assert.ok(
    !getCachedToolSchema('GENERIC_LIST_RECORDS'),
    'precondition: nothing is known before the carrier is connected',
  );

  const recorded = await indexComposioToolkit({
    slug: 'generic_provider',
    listOperations: async () => PROVIDER_RESPONSE,
  });
  assert.equal(recorded, 3, 'every operation is catalogued');
  await settle();

  // This is the whole point: the schema is resolvable with NO further provider
  // call and NO prior usage — the two things a blank install cannot supply.
  const schema = getCachedToolSchema('GENERIC_LIST_RECORDS') as Record<string, unknown> | null;
  assert.ok(schema, 'the schema the provider already returned must be resolvable');
  assert.deepEqual(schema.required, ['query']);

  const create = getCachedToolSchema('GENERIC_CREATE_ARTIFACT') as Record<string, unknown> | null;
  assert.ok(create, 'writes need their schema too — this is the leg that blocks construct binds');
  assert.deepEqual(create.required, ['title', 'rows']);
});

test('the deposit is DURABLE — it reaches the store the bind path actually reads', async () => {
  // This is the assertion the whole change exists for. `getCachedToolSchema`
  // can be satisfied by a 30-minute process cache, which a restart erases and
  // which `productionRegistryView` never consults. The bind path builds its
  // candidate set from `listToolContractFiles()`; on a blank install that
  // returned [], and every downstream gate therefore failed closed.
  const { listToolContractFiles, loadToolContract } = await import('../../tools/tool-contract-store.js');
  const stored = listToolContractFiles();
  assert.ok(stored.length > 0, 'connect time must leave the durable contract store non-empty');

  const contract = loadToolContract('GENERIC_CREATE_ARTIFACT');
  assert.ok(contract, 'the create leg must be resolvable from disk, not just from memory');
  assert.ok(
    contract.schema && typeof contract.schema === 'object',
    'and it must carry the frozen input shape a bind needs',
  );
});

test('an operation the provider documented no schema for is catalogued anyway', () => {
  // Reachability must not become all-or-nothing: a schema-less operation is
  // still discoverable and citable, it simply is not yet bindable.
  const rows = listCapabilityOperationsForCarrier('composio', 'generic_provider');
  assert.equal(rows.length, 3);
  assert.ok(!getCachedToolSchema('GENERIC_UNDOCUMENTED'), 'no schema was supplied, so none is resolvable');
});

test('ONE WRITER HOLDS — the index still stores no schema', () => {
  // CAT-7 obliges the enumerator to hand the fact to its owner. It does not
  // make the index a writer of schema truth, and the moment it does, two
  // stores can disagree about what an operation accepts.
  const columns = (capabilityIndexDatabase()
    .pragma('table_info(capability_operations)') as Array<{ name: string }>)
    .map((column) => column.name);
  for (const forbidden of ['schema', 'input_schema', 'input_parameters', 'schema_digest']) {
    assert.ok(!columns.includes(forbidden), `the index must not own ${forbidden}`);
  }
});

test('a schema store that refuses does not fail the enumeration', async () => {
  // The deposit is a courtesy on the connection path. An install whose
  // contract store is unwritable must still get its catalogue.
  const recorded = await indexComposioToolkit({
    slug: 'second_provider',
    listOperations: async () => [
      // Deliberately hostile: a non-record schema, which rememberToolSchema refuses.
      { slug: 'SECOND_OP', name: 'Second', description: 'x', inputParameters: 'not-a-schema' },
    ],
  });
  await settle();
  assert.equal(recorded, 1, 'the catalogue lands regardless');
  assert.ok(!getCachedToolSchema('SECOND_OP'), 'and the bad schema is refused, not stored');
});
