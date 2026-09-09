import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-provider-schema-representation-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
const schemas = await import('./composio-schema-cache.js');
const contracts = await import('./tool-contract-store.js');
const { canonicalExternalInputSchemaDigestV1 } = await import('../runtime/harness/external-capability-risk-loader.js');
const { selectExactPreparedExternalCall } = await import('../runtime/harness/host-interactive-consent.js');
const { durableLogicalCallContract } = await import('../runtime/harness/logical-call-contract.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const EXPECTED = 'e76f11e4b4d7b4ee8f075b8f43a7d6a329e09d6b3dcabfceab8685f9817dd418';
function providerSchema() {
  return JSON.parse(readFileSync(new URL('./fixtures/outlook-create-draft-input-schema.json', import.meta.url), 'utf8'));
}
function sdkSchema() {
  const schema = providerSchema();
  schema.properties.attachment.anyOf[0].description = undefined;
  return schema;
}

test.after(() => {
  schemas._setToolSchemaLoaderForTests(null);
  schemas.resetToolSchemaCache();
  eventlog.closeEventLog();
  rmSync(fixtureHome, { recursive: true, force: true });
});

test('the actual SDK attachment optional description closes to the same e76 schema in memory, disk and reopen', async () => {
  const raw = sdkSchema();
  assert.equal(contracts.digestSchema(raw), EXPECTED);
  assert.equal(canonicalExternalInputSchemaDigestV1(raw), null, 'this is the live pre-fix refusal');
  const observedAt = Date.now() - 1_000;
  schemas.rememberToolSchema('OUTLOOK_CREATE_DRAFT', raw, observedAt, '20260903_00', { type: 'object', description: undefined });
  const cached = schemas.getCachedToolSchema('OUTLOOK_CREATE_DRAFT')!;
  assert.deepEqual(cached, providerSchema());
  assert.equal(canonicalExternalInputSchemaDigestV1(cached), EXPECTED);
  assert.equal(contracts.digestSchema(cached), EXPECTED);
  assert.equal(schemas.liveComposioSchemaFingerprint('OUTLOOK_CREATE_DRAFT'), EXPECTED.slice(0, 32));
  const durable = contracts.loadToolContract('OUTLOOK_CREATE_DRAFT')!;
  assert.equal(durable.providerObservedAt, new Date(observedAt).toISOString());
  assert.deepEqual(durable.schema, cached);
  assert.deepEqual(durable.providerOutputSchema, { type: 'object' });
  schemas.resetToolSchemaCache();
  assert.deepEqual(schemas.getCachedToolSchema('OUTLOOK_CREATE_DRAFT'), cached);
  assert.equal(await schemas.ensureLiveComposioSchemaFingerprint('OUTLOOK_CREATE_DRAFT'), EXPECTED.slice(0, 32));
  assert.equal(contracts.loadToolContract('OUTLOOK_CREATE_DRAFT')?.providerObservedAt, durable.providerObservedAt, 'reopen preserves the original lease');
  assert.equal(Object.hasOwn(raw.properties.attachment.anyOf[0], 'description'), true, 'normalization does not mutate SDK-owned input');
});

test('exact metadata refresh returns the same closed input and output snapshots it cached', async () => {
  schemas._setToolSchemaLoaderForTests(async () => ({ inputParameters: sdkSchema(), providerObservedAt: Date.now(),
    providerOperationVersion: '20260903_00', outputParameters: { type: 'object', properties: { id: { type: 'string', description: undefined } } } }));
  const refreshed = await schemas.refreshExactComposioSchemaFromProvider('OUTLOOK_CREATE_DRAFT');
  assert.ok(refreshed);
  assert.equal(canonicalExternalInputSchemaDigestV1(refreshed.schema), EXPECTED);
  assert.deepEqual(refreshed.schema, schemas.getCachedToolSchema('OUTLOOK_CREATE_DRAFT'));
  assert.deepEqual(refreshed.outputSchema, { type: 'object', properties: { id: { type: 'string' } } });
  schemas._setToolSchemaLoaderForTests(null);
});

test('SDK normalization cannot turn non-JSON schema values into a live definition', () => {
  let getterReads = 0;
  const accessor = Object.defineProperty({}, 'description', { enumerable: true, get() { getterReads += 1; return undefined; } });
  const hidden = Object.defineProperty({}, 'description', { enumerable: false, value: undefined });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const sparse = new Array(2); sparse[1] = 'present';
  const invalid = [accessor, hidden, { [Symbol('secret')]: undefined }, { type: NaN }, { type: Infinity }, { type: 1n },
    { type() {} }, { anyOf: [undefined] }, { anyOf: sparse }, { value: new Date() }, cyclic,
    JSON.parse('{"properties":{"__proto__":{"type":"string"}}}')];
  for (const [index, value] of invalid.entries()) {
    const slug = `INVALID_SCHEMA_${index}`;
    schemas.rememberToolSchema(slug, value, Date.now(), '1', { type: 'object' });
    assert.equal(schemas.getCachedToolSchema(slug), null, `invalid schema ${index} was cached`);
    assert.equal(schemas.liveComposioSchemaFingerprint(slug), undefined);
  }
  assert.equal(getterReads, 0);
});

test('normalization preserves schema and argument tamper refusals at the exact prepared-call boundary', () => {
  schemas.rememberToolSchema('OUTLOOK_CREATE_DRAFT', sdkSchema(), Date.now(), '20260903_00', { type: 'object' });
  const schema = schemas.getCachedToolSchema('OUTLOOK_CREATE_DRAFT')!;
  const args = { subject: 'schema-proof', body: 'Exact authored bytes.', is_html: false };
  const logical = durableLogicalCallContract('schema-task', 'OUTLOOK_CREATE_DRAFT', args)!;
  const select = (inputSchema: unknown, candidateArgs: unknown = args) => selectExactPreparedExternalCall({
    providerInputSchemaDigest: EXPECTED, acceptedTaskId: 'schema-task', effectiveArgumentDigest: logical.argumentDigest,
    effectiveToolName: logical.toolName, candidates: [{ inputSchema, arguments: candidateArgs, logicalToolName: 'OUTLOOK_CREATE_DRAFT' }],
  });
  assert.ok(select(schema));
  const weakened = structuredClone(schema); weakened.required = ['subject'];
  assert.equal(select(weakened), null);
  const changedDescription = providerSchema(); changedDescription.properties.attachment.anyOf[0].description = 'New actual provider metadata';
  assert.notEqual(contracts.digestSchema(changedDescription), EXPECTED);
  assert.equal(select(changedDescription), null);
  assert.equal(select(schema, { ...args, body: 'Tampered authored bytes.' }), null);
  assert.equal(select(sdkSchema()), null, 'strict consent never opts in to ingestion normalization');
});
