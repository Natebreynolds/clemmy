import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PRIOR_CLEMENTINE_HOME = process.env.CLEMENTINE_HOME;
const TEST_CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-schema-cache-'));
process.env.CLEMENTINE_HOME = TEST_CLEMENTINE_HOME;

const { BASE_DIR } = await import('../config.js');
const { getMachineId } = await import('../runtime/machine-id.js');
const {
  ensureLiveComposioSchemaFingerprint,
  ensureToolSchema,
  liveComposioSchemaFingerprint,
  _setToolSchemaLoaderForTests,
  rememberToolSchema,
  rememberToolSchemas,
  getCachedToolSchema,
  resetToolSchemaCache,
  inMemorySchemaCount,
} = await import('./composio-schema-cache.js');
const {
  _clearToolContractsForTests,
  contractFileName,
  fingerprintSchema,
  saveToolContract,
  saveToolContractExample,
} = await import('./tool-contract-store.js');

function contractPath(identifier: string): string {
  return path.join(
    BASE_DIR,
    'memory',
    'tool-contracts',
    getMachineId(),
    contractFileName(identifier),
  );
}

function rewriteContract(
  identifier: string,
  mutate: (record: Record<string, unknown>) => void,
): void {
  const file = contractPath(identifier);
  const record = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  mutate(record);
  writeFileSync(file, JSON.stringify(record, null, 2), 'utf-8');
}

try {
// remember → get round-trip
{
  resetToolSchemaCache();
  const schema = { type: 'object', required: ['spreadsheet_id'], properties: {} };
  rememberToolSchema('GOOGLESHEETS_BATCH_UPDATE_VALUES', schema);
  const got = getCachedToolSchema('GOOGLESHEETS_BATCH_UPDATE_VALUES');
  if (!got || got.required?.toString() !== 'spreadsheet_id') {
    throw new Error('Should return the deposited schema');
  }
}

// unknown slug → null
{
  resetToolSchemaCache();
  if (getCachedToolSchema('NEVER_SEEN_SLUG') !== null) {
    throw new Error('Unknown slug should be a cache miss');
  }
}

// non-object schemas are ignored (cache can only ever make validation
// MORE precise — junk must not poison it)
{
  resetToolSchemaCache();
  rememberToolSchema('JUNK_SLUG', null);
  rememberToolSchema('JUNK_SLUG', 'not a schema');
  rememberToolSchema('JUNK_SLUG', [1, 2, 3]);
  rememberToolSchema('', { type: 'object' });
  if (getCachedToolSchema('JUNK_SLUG') !== null) {
    throw new Error('Non-object schemas must be ignored');
  }
}

// batch helper deposits every valid item
{
  resetToolSchemaCache();
  rememberToolSchemas([
    { slug: 'A_TOOL', inputParameters: { type: 'object', required: ['x'] } },
    { slug: 'B_TOOL', inputParameters: undefined },
    { slug: undefined, inputParameters: { type: 'object' } },
  ]);
  if (!getCachedToolSchema('A_TOOL')) throw new Error('Batch helper should deposit A_TOOL');
  if (getCachedToolSchema('B_TOOL') !== null) throw new Error('Missing inputParameters should be skipped');
}

// Production callers explicitly pass NaN when schema provenance is missing.
// The schema remains a validation hint, but no executable lease is minted.
{
  resetToolSchemaCache();
  rememberToolSchema('UNPROVEN_SCHEMA_TOOL', { type: 'object', properties: {} }, Number.NaN);
  if (!getCachedToolSchema('UNPROVEN_SCHEMA_TOOL')) {
    throw new Error('an unproven schema should remain available for validation');
  }
  if (liveComposioSchemaFingerprint('UNPROVEN_SCHEMA_TOOL') !== undefined) {
    throw new Error('missing schema provenance minted executable authority');
  }
}

// newest write wins (a refreshed schema replaces the stale one)
{
  resetToolSchemaCache();
  rememberToolSchema('S', { type: 'object', required: ['old'] });
  rememberToolSchema('S', { type: 'object', required: ['new'] });
  const got = getCachedToolSchema('S');
  if (!got || got.required?.toString() !== 'new') {
    throw new Error('Refreshed schema should replace the previous one');
  }
}

// Provider objects are snapshotted, and any later mutation through the
// validation getter invalidates executable authority instead of rebinding the
// old observation timestamp to a new schema.
{
  resetToolSchemaCache();
  const slug = 'MUTATED_PROVIDER_SCHEMA';
  const original = { type: 'object', required: ['before'], properties: {} };
  const expected = fingerprintSchema(original);
  rememberToolSchema(slug, original, Date.now());
  original.required = ['outside-mutation'];
  if (liveComposioSchemaFingerprint(slug) !== expected) {
    throw new Error('mutating the caller-owned provider object changed the cached snapshot');
  }
  const cached = getCachedToolSchema(slug)!;
  cached.required = ['inside-mutation'];
  if (liveComposioSchemaFingerprint(slug) !== undefined) {
    throw new Error('a mutated cached schema inherited the prior provider observation lease');
  }
}

// size cap holds (oldest evicted from MEMORY, hot entries survive re-insertion)
//
// The cap bounds MEMORY in a long-lived daemon; forgetting how to call a tool
// was never the goal, it was a side effect. Now that a contract also lands on
// disk, an entry pushed out of the map is still recallable — which is the
// point: discovery is paid once per tool, not once per session. So this asserts
// the memory bound directly, and the durable store is cleared first so the
// assertion cannot be satisfied by a leftover contract from another test run.
{
  resetToolSchemaCache();
  _clearToolContractsForTests();
  for (let i = 0; i < 520; i++) {
    rememberToolSchema(`SLUG_${i}`, { type: 'object', idx: i });
  }
  if (inMemorySchemaCount() > 500) {
    throw new Error('In-memory cache must stay within its size cap');
  }
  if (!getCachedToolSchema('SLUG_519')) {
    throw new Error('Newest entry must survive the cap');
  }
  // Evicted from memory, still known: the durable contract answers for it.
  if (!getCachedToolSchema('SLUG_0')) {
    throw new Error('An entry evicted from memory must still be recallable from the durable store');
  }
  _clearToolContractsForTests();
  resetToolSchemaCache();
  if (getCachedToolSchema('SLUG_0') !== null) {
    throw new Error('With the durable store cleared, an evicted entry must be genuinely gone');
  }
}

resetToolSchemaCache();

// Restart continuity: the same 30-minute authority window as the process map
// survives a daemon restart, without resetting its observation timestamp.
{
  _clearToolContractsForTests();
  const slug = 'RESTART_CONTINUITY_TOOL';
  const schema = { type: 'object', properties: { limit: { type: 'integer' } } };
  rememberToolSchema(slug, schema, Date.now());
  const expected = fingerprintSchema(schema);
  if (liveComposioSchemaFingerprint(slug) !== expected) throw new Error('fresh live fingerprint missing');
  const beforeRestart = JSON.parse(readFileSync(contractPath(slug), 'utf-8')) as {
    savedAt: string;
    providerObservedAt: string;
    providerObservedFingerprint: string;
  };
  resetToolSchemaCache();
  if (liveComposioSchemaFingerprint(slug) !== undefined) {
    throw new Error('the process-only live accessor silently hydrated durable validation state');
  }
  let metadataObservations = 0;
  if (await ensureLiveComposioSchemaFingerprint(slug, () => { metadataObservations += 1; }) !== expected) {
    throw new Error('recent provider schema authority did not survive a process-cache restart');
  }
  resetToolSchemaCache();
  if (await ensureLiveComposioSchemaFingerprint(slug, () => { metadataObservations += 1; }) !== expected) {
    throw new Error('a second restart lost the original provider authority lease');
  }
  if (metadataObservations !== 0) throw new Error('durable lease hydration was misreported as provider metadata I/O');
  const afterRestarts = JSON.parse(readFileSync(contractPath(slug), 'utf-8')) as {
    savedAt: string;
    providerObservedAt: string;
    providerObservedFingerprint: string;
  };
  if (afterRestarts.providerObservedAt !== beforeRestart.providerObservedAt) {
    throw new Error('restart hydration extended the durable provider-observation timestamp');
  }
  if (afterRestarts.providerObservedFingerprint !== beforeRestart.providerObservedFingerprint) {
    throw new Error('restart hydration changed the provider-observed fingerprint binding');
  }
  if (afterRestarts.savedAt !== beforeRestart.savedAt) {
    throw new Error('restart hydration rewrote the validation-retention timestamp');
  }
  _clearToolContractsForTests();
}

resetToolSchemaCache();

// Provider observations are monotonic across both process and durable state.
// A stale toolkit-cache replay cannot roll a newer exact-slug schema back.
{
  _clearToolContractsForTests();
  const slug = 'MONOTONIC_PROVIDER_SCHEMA_TOOL';
  const olderSchema = { type: 'object', required: ['old_field'] };
  const newerSchema = { type: 'object', required: ['new_field'] };
  const newerObservedAt = Date.now() - 1_000;
  const olderObservedAt = newerObservedAt - 1_000;

  rememberToolSchema(slug, newerSchema, newerObservedAt);
  resetToolSchemaCache();
  rememberToolSchema(slug, olderSchema, olderObservedAt);
  if (liveComposioSchemaFingerprint(slug) !== fingerprintSchema(newerSchema)) {
    throw new Error('an older conflicting provider observation rolled live authority back');
  }

  rememberToolSchema(slug, { type: 'object', required: ['unproven_field'] }, Number.NaN);
  rememberToolSchema(slug, newerSchema, olderObservedAt);
  const durable = JSON.parse(readFileSync(contractPath(slug), 'utf-8')) as {
    schema: Record<string, unknown>;
    providerObservedAt: string;
    providerObservedFingerprint: string;
  };
  if (fingerprintSchema(durable.schema) !== fingerprintSchema(newerSchema)
    || durable.providerObservedAt !== new Date(newerObservedAt).toISOString()
    || durable.providerObservedFingerprint !== fingerprintSchema(newerSchema)) {
    throw new Error('stale or unproven replay changed the durable monotonic observation');
  }
  resetToolSchemaCache();
  if (await ensureLiveComposioSchemaFingerprint(slug) !== fingerprintSchema(newerSchema)) {
    throw new Error('the monotonic provider observation did not survive restart');
  }
  _clearToolContractsForTests();
  resetToolSchemaCache();
}

resetToolSchemaCache();

// Equal-millisecond observations of different schemas are unordered. Neither
// side remains executable across process or restart; a later observation must
// resolve the conflict.
{
  _clearToolContractsForTests();
  const slug = 'EQUAL_TIME_PROVIDER_CONFLICT_TOOL';
  const schemaA = { type: 'object', required: ['field_a'] };
  const schemaB = { type: 'object', required: ['field_b'] };
  const conflictedAt = Date.now() - 1_000;
  rememberToolSchema(slug, schemaA, conflictedAt);
  // Process evidence must fail closed even if its earlier durable write was
  // lost before the conflicting response arrived.
  _clearToolContractsForTests();
  rememberToolSchema(slug, schemaB, conflictedAt);
  if (liveComposioSchemaFingerprint(slug) !== undefined) {
    throw new Error('equal-time conflicting schemas left one side executable in process');
  }
  const conflict = JSON.parse(readFileSync(contractPath(slug), 'utf-8')) as {
    providerObservedAt?: string;
    providerObservedFingerprint?: string;
    providerAuthorityConflictAt?: string;
  };
  if (conflict.providerObservedAt !== undefined
    || conflict.providerObservedFingerprint !== undefined
    || conflict.providerAuthorityConflictAt !== new Date(conflictedAt).toISOString()) {
    throw new Error('equal-time schema conflict was not durably fail-closed');
  }

  resetToolSchemaCache();
  if (!getCachedToolSchema(slug) || liveComposioSchemaFingerprint(slug) !== undefined) {
    throw new Error('equal-time schema conflict regained authority after restart');
  }
  let loads = 0;
  _setToolSchemaLoaderForTests(async () => {
    loads += 1;
    return { inputParameters: schemaB, providerObservedAt: conflictedAt + 1 };
  });
  if (await ensureLiveComposioSchemaFingerprint(slug) !== fingerprintSchema(schemaB)) {
    throw new Error('a strictly later provider observation did not resolve the schema conflict');
  }
  if (loads !== 1) throw new Error('schema conflict resolution must perform exactly one provider refresh');
  _setToolSchemaLoaderForTests(null);
  _clearToolContractsForTests();
  resetToolSchemaCache();
}

resetToolSchemaCache();

// A durable contract older than the executable lease remains useful to local
// validation, but reading it must never elevate it to live authority.
{
  _clearToolContractsForTests();
  const slug = 'STALE_VALIDATION_ONLY_TOOL';
  const schema = { type: 'object', properties: { cursor: { type: 'string' } } };
  rememberToolSchema(slug, schema, Date.now());
  rewriteContract(slug, (record) => {
    record.providerObservedAt = new Date(Date.now() - 31 * 60_000).toISOString();
  });
  resetToolSchemaCache();
  if (!getCachedToolSchema(slug)) throw new Error('stale executable schema should remain a validation hint');
  if (liveComposioSchemaFingerprint(slug) !== undefined) {
    throw new Error('a validation read elevated stale durable state to executable authority');
  }
  let loads = 0;
  const observations: Array<{ outcome: string; durationMs: number; fingerprint?: string }> = [];
  _setToolSchemaLoaderForTests(async () => {
    loads += 1;
    return { inputParameters: schema, providerObservedAt: Date.now() };
  });
  if (await ensureLiveComposioSchemaFingerprint(slug, (observation) => { observations.push(observation); }) !== fingerprintSchema(schema)) {
    throw new Error('stale durable authority did not perform an exact-slug refresh');
  }
  if (loads !== 1) throw new Error('stale durable authority must refresh exactly once');
  if (observations.length !== 1 || observations[0]!.outcome !== 'refreshed') {
    throw new Error('physical metadata refresh did not emit one bounded observation');
  }
  _setToolSchemaLoaderForTests(null);
  _clearToolContractsForTests();
  resetToolSchemaCache();
}

// A successful business call may teach a redacted example and renew the
// validation retention timestamp. It cannot renew an expired provider schema
// observation, even when it writes the same schema immediately before restart.
{
  _clearToolContractsForTests();
  const slug = 'STALE_THEN_SUCCESSFUL_EXAMPLE_TOOL';
  const schema = { type: 'object', properties: { cursor: { type: 'string' } } };
  const staleProviderObservedAt = new Date(Date.now() - 31 * 60_000).toISOString();
  saveToolContract({
    identifier: slug,
    schema,
    providerObservedAt: staleProviderObservedAt,
  });
  saveToolContractExample({ identifier: slug, exampleArgs: { cursor: 'private-content' } });
  const afterExample = JSON.parse(readFileSync(contractPath(slug), 'utf-8')) as {
    providerObservedAt?: string;
    savedAt: string;
  };
  if (afterExample.providerObservedAt !== staleProviderObservedAt) {
    throw new Error('a successful example write renewed provider schema authority');
  }
  resetToolSchemaCache();
  if (!getCachedToolSchema(slug)) throw new Error('the successful example should preserve validation retention');
  if (liveComposioSchemaFingerprint(slug) !== undefined) {
    throw new Error('the successful example elevated stale schema authority after restart');
  }
  let loads = 0;
  _setToolSchemaLoaderForTests(async () => {
    loads += 1;
    return { inputParameters: schema, providerObservedAt: Date.now() };
  });
  if (await ensureLiveComposioSchemaFingerprint(slug) !== fingerprintSchema(schema) || loads !== 1) {
    throw new Error('stale authority did not require one provider metadata refresh after a successful example');
  }
  _setToolSchemaLoaderForTests(null);
  _clearToolContractsForTests();
  resetToolSchemaCache();
}

// Future, malformed, legacy-without-authority, identifier-swapped, rebound,
// and fingerprint-tampered durable observations are never executable authority.
// A validation read before warm admission cannot bypass that integrity boundary.
for (const fixture of ['future', 'malformed', 'legacy', 'wrong_identifier', 'rebound', 'tampered'] as const) {
  _clearToolContractsForTests();
  resetToolSchemaCache();
  const slug = `INVALID_DURABLE_${fixture.toUpperCase()}`;
  const schema = { type: 'object', properties: {} };
  rememberToolSchema(slug, schema, Date.now());
  rewriteContract(slug, (record) => {
    if (fixture === 'future') record.providerObservedAt = new Date(Date.now() + 60 * 60_000).toISOString();
    if (fixture === 'malformed') record.providerObservedAt = 'not-a-date';
    if (fixture === 'legacy') delete record.providerObservedAt;
    if (fixture === 'wrong_identifier') record.identifier = 'A_DIFFERENT_TOOL';
    if (fixture === 'rebound') {
      record.schema = { type: 'object', required: ['unobserved'] };
      record.fingerprint = fingerprintSchema(record.schema);
    }
    if (fixture === 'tampered') record.fingerprint = '0'.repeat(32);
  });
  resetToolSchemaCache();
  const validationSchema = getCachedToolSchema(slug);
  if ((fixture === 'tampered' || fixture === 'wrong_identifier') && validationSchema !== null) {
    throw new Error(`a ${fixture} durable contract influenced validation`);
  }
  let loads = 0;
  const observations: Array<Record<string, unknown>> = [];
  _setToolSchemaLoaderForTests(async () => { loads += 1; return null; });
  if (await ensureLiveComposioSchemaFingerprint(slug, (observation) => { observations.push(observation); }) !== undefined) {
    throw new Error(`${fixture} durable metadata gained executable authority`);
  }
  if (loads !== 1) throw new Error(`${fixture} durable metadata did not trigger one bounded refresh`);
  if (observations.length !== 1 || observations[0]!.outcome !== 'unavailable') {
    throw new Error(`${fixture} metadata refresh did not emit one sanitized unavailable outcome`);
  }
  if (Object.keys(observations[0]!).some((key) => /slug|schema|account|error/i.test(key))) {
    throw new Error(`${fixture} metadata observation exposed provider details`);
  }
  _setToolSchemaLoaderForTests(null);
}
_clearToolContractsForTests();
resetToolSchemaCache();

// A future-dated durable observation may still be a validation hint, but it
// cannot outrank a real current provider refresh and poison repair forever.
{
  _clearToolContractsForTests();
  const slug = 'FUTURE_OBSERVATION_REPAIR_TOOL';
  const futureSchema = { type: 'object', required: ['future_field'] };
  const currentSchema = { type: 'object', required: ['current_field'] };
  rememberToolSchema(slug, futureSchema, Date.now());
  rewriteContract(slug, (record) => {
    record.providerObservedAt = new Date(Date.now() + 60 * 60_000).toISOString();
  });
  resetToolSchemaCache();
  if (!getCachedToolSchema(slug)) {
    throw new Error('a future observation should remain available for validation');
  }
  let loads = 0;
  _setToolSchemaLoaderForTests(async () => {
    loads += 1;
    return { inputParameters: currentSchema, providerObservedAt: Date.now() };
  });
  if (await ensureLiveComposioSchemaFingerprint(slug) !== fingerprintSchema(currentSchema)) {
    throw new Error('a future validation timestamp suppressed a valid current provider refresh');
  }
  if (loads !== 1) throw new Error('future observation repair must perform exactly one provider refresh');
  _setToolSchemaLoaderForTests(null);
  _clearToolContractsForTests();
  resetToolSchemaCache();
}

// ── Schema-FIRST dispatch (live 2026-08-07 scrape) ──
// APIFY_RUN_ACTOR had no cached schema, so a call with no `actorId` fell to
// heuristic validation, reached the provider, and came back as a paid 400 —
// twice. ensureToolSchema loads the real contract once per session so the
// same mistake is refused locally, naming the missing field.
{
  const { validateComposioArgs } = await import('./composio-batch-validator.js');

  resetToolSchemaCache();
  let loads = 0;
  _setToolSchemaLoaderForTests(async (slug: string) => {
    loads += 1;
    return slug === 'APIFY_RUN_ACTOR'
      ? {
        inputParameters: { type: 'object', required: ['actorId'], properties: { actorId: { type: 'string' } } },
        providerObservedAt: Date.now(),
      }
      : null;
  });

  const contract = await ensureToolSchema('APIFY_RUN_ACTOR');
  if (!contract || String(contract.required) !== 'actorId') throw new Error('should load the real contract on first use');
  if (loads !== 1) throw new Error('first use loads exactly once');

  await ensureToolSchema('APIFY_RUN_ACTOR');
  if (loads !== 1) throw new Error('a cached contract must never refetch');
  if (!getCachedToolSchema('APIFY_RUN_ACTOR')) throw new Error('the sync reader sees the loaded contract');

  // An undescribable slug is attempted once, not per dispatch.
  if (await ensureToolSchema('UNKNOWABLE_SLUG') !== null) throw new Error('unknown slug yields null');
  if (await ensureToolSchema('UNKNOWABLE_SLUG') !== null) throw new Error('unknown slug still null');
  if (loads !== 2) throw new Error('no repeated fetches for an undescribable slug');

  // The live failure is now a LOCAL refusal naming the field.
  const missing = validateComposioArgs('APIFY_RUN_ACTOR', { input: { q: 'x' } }, contract);
  if (missing.mode !== 'schema') throw new Error('validated against the real contract');
  if (!missing.error || !/actorId/.test(String(missing.error.field))) throw new Error('missing actorId must be caught pre-dispatch');
  const complete = validateComposioArgs('APIFY_RUN_ACTOR', { actorId: 'a~b', input: {} }, contract);
  if (complete.error) throw new Error('a complete payload still passes');

  // Loader failure is fail-open: no throw, previous behavior preserved.
  _setToolSchemaLoaderForTests(async () => { throw new Error('composio down'); });
  if (await ensureToolSchema('SOME_OTHER_SLUG') !== null) throw new Error('loader failure yields null, never a throw');
  _setToolSchemaLoaderForTests(null);
  resetToolSchemaCache();
}

// A failed validation lookup cannot suppress the executable-authority refresh
// for the rest of the daemon.
{
  _clearToolContractsForTests();
  resetToolSchemaCache();
  const slug = 'VALIDATION_THEN_WARM_TOOL';
  const schema = { type: 'object', properties: {} };
  let loads = 0;
  _setToolSchemaLoaderForTests(async () => {
    loads += 1;
    return loads === 1 ? null : { inputParameters: schema, providerObservedAt: Date.now() };
  });
  if (await ensureToolSchema(slug) !== null) throw new Error('first validation lookup should miss');
  if (await ensureLiveComposioSchemaFingerprint(slug) !== fingerprintSchema(schema)) {
    throw new Error('failed validation lookup permanently suppressed warm authority refresh');
  }
  if (loads !== 2) throw new Error('warm authority did not retry once after failed validation');
  _setToolSchemaLoaderForTests(null);
  _clearToolContractsForTests();
  resetToolSchemaCache();
}

// Concurrent accepted sources share one physical exact-slug metadata lookup
// and every follower waits for the same authority result.
{
  _clearToolContractsForTests();
  resetToolSchemaCache();
  const slug = 'CONCURRENT_WARM_REFRESH_TOOL';
  const schema = { type: 'object', properties: {} };
  let loads = 0;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const observations: Array<{ outcome: string }> = [];
  _setToolSchemaLoaderForTests(async () => {
    loads += 1;
    enter();
    await gate;
    return { inputParameters: schema, providerObservedAt: Date.now() };
  });
  const first = ensureLiveComposioSchemaFingerprint(slug, (observation) => { observations.push(observation); });
  const follower = ensureLiveComposioSchemaFingerprint(slug, (observation) => { observations.push(observation); });
  await entered;
  if (loads !== 1) throw new Error('concurrent refreshes did not single-flight');
  release();
  const results = await Promise.all([first, follower]);
  if (results.some((result) => result !== fingerprintSchema(schema))) {
    throw new Error('a concurrent refresh follower fell through without authority');
  }
  if (loads !== 1) throw new Error('concurrent refresh executed more than one metadata request');
  if (observations.length !== 1 || observations[0]!.outcome !== 'refreshed') {
    throw new Error('single-flight followers emitted duplicate metadata observations');
  }
  _setToolSchemaLoaderForTests(null);
  _clearToolContractsForTests();
  resetToolSchemaCache();
}

// If validation starts the physical metadata request first, the first warm
// joiner still owns its single accounting event; concurrency cannot hide I/O.
{
  _clearToolContractsForTests();
  resetToolSchemaCache();
  const slug = 'VALIDATION_OWNER_WARM_OBSERVER_TOOL';
  const schema = { type: 'object', properties: {} };
  let loads = 0;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const observations: Array<{ outcome: string }> = [];
  _setToolSchemaLoaderForTests(async () => {
    loads += 1;
    enter();
    await gate;
    return { inputParameters: schema, providerObservedAt: Date.now() };
  });
  const validation = ensureToolSchema(slug);
  await entered;
  const warm = ensureLiveComposioSchemaFingerprint(
    slug,
    (observation) => { observations.push(observation); },
  );
  release();
  const [validationSchema, warmFingerprint] = await Promise.all([validation, warm]);
  if (!validationSchema || warmFingerprint !== fingerprintSchema(schema) || loads !== 1) {
    throw new Error('validation-owner/warm-follower single-flight did not converge');
  }
  if (observations.length !== 1 || observations[0]!.outcome !== 'refreshed') {
    throw new Error('validation-owned metadata I/O was missing or double-counted for the warm joiner');
  }
  _setToolSchemaLoaderForTests(null);
  _clearToolContractsForTests();
  resetToolSchemaCache();
}

// An absent durable observation may refresh once by exact slug. This is
// metadata authority only; it never executes the business tool.
{
  _clearToolContractsForTests();
  resetToolSchemaCache();
  let loads = 0;
  const slug = 'WARM_REFRESH_TOOL';
  const schema = { type: 'object', properties: {} };
  _setToolSchemaLoaderForTests(async (requested: string) => {
    loads += 1;
    return requested === slug
      ? { inputParameters: schema, providerObservedAt: Date.now() }
      : null;
  });
  if (await ensureLiveComposioSchemaFingerprint(slug) !== fingerprintSchema(schema)) {
    throw new Error('exact-slug metadata refresh did not restore live fingerprint authority');
  }
  if (loads !== 1) throw new Error('live fingerprint refresh must run exactly once');
  await ensureLiveComposioSchemaFingerprint(slug);
  if (loads !== 1) throw new Error('live fingerprint refresh repeated after the cache was restored');
  _setToolSchemaLoaderForTests(null);
  _clearToolContractsForTests();
  resetToolSchemaCache();
}

console.log('composio-schema-cache tests passed');
} finally {
  _setToolSchemaLoaderForTests(null);
  resetToolSchemaCache();
  _clearToolContractsForTests();
  rmSync(TEST_CLEMENTINE_HOME, { recursive: true, force: true });
  if (PRIOR_CLEMENTINE_HOME === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = PRIOR_CLEMENTINE_HOME;
}
