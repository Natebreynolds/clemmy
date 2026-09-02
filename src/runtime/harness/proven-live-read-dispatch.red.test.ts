/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/runtime/harness/proven-live-read-dispatch.red.test.ts
 *
 * OPEN-THE-GATES live miss, sess-mob-416706 seq 95976
 * ("What's the latest on the platform 49 sheet"):
 *   planning card disclosed googlesheets_query_table (read)
 *   plan_task admitted
 *   work_call google_sheets__batch_get / GOOGLESHEETS_BATCH_GET
 *   refused catalog_entry_or_manifest_missing
 *     candidates=0 proven=cap:resolved:googlesheets_batch_get
 *
 * The host had already proved the read. The frozen snapshot is the WRITE bar.
 * Name spelling and fail-closed write classification are not safety properties
 * for a same-turn proven live read.
 *
 * Re-break:
 *   (i)  gate the live-read path on decision.effect === 'read'
 *   (ii) require exactEntryMatches (byte-identical operationId) on the live
 *        proven read candidate
 *   (iii) require same-turn readDescent before resolveProvenLiveReadCatalogEntry
 *         (live workflow:1788024507349 — worker proven=none)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const HOST = new URL('./host-turn-runner.ts', import.meta.url);
const FACTORY = new URL('./host-capability-catalog-factory.ts', import.meta.url);
const EFFECT = new URL('./tool-effect.ts', import.meta.url);
const IDENTITY = new URL('./runtime-tool-identity.ts', import.meta.url);

test('NEGATIVE: native MCP, Composio, and catalog Sheets-read spellings are one operation', async () => {
  const { catalogOperationIdentitiesEqual } = await import('./runtime-tool-identity.js');
  assert.equal(
    catalogOperationIdentitiesEqual('google_sheets__batch_get', 'GOOGLESHEETS_BATCH_GET'),
    true,
  );
  assert.equal(
    catalogOperationIdentitiesEqual('GOOGLESHEETS_BATCH_GET', 'googlesheets_batch_get'),
    true,
  );
  assert.equal(
    catalogOperationIdentitiesEqual('GOOGLESHEETS_BATCH_GET', 'GOOGLESHEETS_VALUES_UPDATE'),
    false,
  );
});

test('NEGATIVE: live-read dispatch does not require the name classifier to say read', () => {
  const src = readFileSync(HOST, 'utf8');
  const liveBlock = src.slice(
    src.indexOf('const provenReadCandidate = candidates.length === 0'),
    src.indexOf('// G2 (gate 10)'),
  );
  assert.doesNotMatch(
    liveBlock,
    /decision\.effect === 'read'/,
    'a proven live read must not wait on the spelling classifier',
  );
  assert.match(liveBlock, /resolveProvenLiveReadCatalogEntry/);
  assert.match(src, /catalogOperationIdentitiesEqual/);
});

test('re-break (i): the old live-read path was gated on decision.effect === read', () => {
  const src = readFileSync(HOST, 'utf8');
  assert.match(
    src,
    /const provenReadCandidate = candidates.length === 0/,
    'a snapshot miss opens the live-read path',
  );
  assert.doesNotMatch(
    src.slice(
      src.indexOf('const provenReadCandidate = candidates.length === 0'),
      src.indexOf('// G2 (gate 10)'),
    ),
    /&& readDescent/,
    'a worker session has no same-turn proof and must still bind a current live read',
  );
  const dispatchBlock = src.slice(
    src.indexOf("const dispatchEffect: HostCallAttestation['effect'] | null"),
    src.indexOf('const common = {'),
  );
  assert.match(
    dispatchBlock,
    /provenReadCandidate\s*\?\s*'read'\s*:\s*decision\.effect === 'unknown'\s*\?\s*null\s*:\s*decision\.effect/,
    'a proven live read overrides the spelling classifier while an unproven unknown effect remains null',
  );
  assert.match(
    dispatchBlock,
    /if \(!dispatchEffect\) \{\s*return miss\(`effect_unknown:/,
    'an unproven unknown effect still fails closed before dispatch',
  );
});

// THE READ BAR (2026-09-01): the write bar's identity arithmetic must never
// come back onto the read path. Each guard below names the live read it killed.
test('re-break (ii): the read path carries no write-bar identity replay', () => {
  const src = readFileSync(HOST, 'utf8');
  const exact = src.slice(
    src.indexOf('const exactProductionHostCall = ('),
    src.indexOf("const dispatchEffect: HostCallAttestation['effect'] | null"),
  );
  assert.doesNotMatch(exact, /liveReadDiscoveryMatches/, 'nine-digest discovery replay (sess-mob-416706)');
  assert.doesNotMatch(exact, /planningReadMatches/, 'planning-card digest replay');
  assert.doesNotMatch(exact, /liveReadEntryDispatchable/, 'a second read predicate beside the catalog\'s own');
  assert.doesNotMatch(
    src.slice(src.indexOf('const provenReadCandidate = candidates.length === 0'), src.indexOf('// G2 (gate 10)')),
    /exactEntryMatches\(/,
    'byte-identical operationId is the write bar, not the live-read bar',
  );
  const factory = readFileSync(FACTORY, 'utf8');
  const resolver = factory.slice(
    factory.indexOf('export function resolveProvenLiveReadCatalogEntry'),
    factory.indexOf('export function resolveRuntimeCapabilityCatalog'),
  );
  assert.doesNotMatch(resolver, /installed\.digest|\.digest !== entry\.manifestDigest/, 'durable-store digest identity (SLACK history, 09-01)');
  assert.doesNotMatch(resolver, /sameLineageFamily|:definition:/, 'lineage occupancy arithmetic (BATCH_GET, 08-29)');
  assert.match(resolver, /lifecycle\.state !== 'revoked'/, 'a disconnect still refuses');
  assert.match(resolver, /entry\.manifest\.effect === 'read'/, 'the sealed manifest is the effect authority');
});

test('re-break: namespaced MCP consults the catalog before fail-closed write', () => {
  const src = readFileSync(EFFECT, 'utf8');
  const classify = src.slice(src.indexOf('export function classifyRuntimeToolEffect'));
  const namespaced = classify.slice(
    classify.indexOf('const isNamespaced = normalized.includes(\'__\')'),
    classify.indexOf('A bare SCREAMING_SNAKE name'),
  );
  assert.match(namespaced, /classifyBareCurrentCatalogCapability/);
  assert.match(
    namespaced,
    /if \(registered\.matched\) return registered\.decision/,
  );
  const identity = readFileSync(IDENTITY, 'utf8');
  assert.match(identity, /export function catalogOperationIdentityKey/);
});

test('NEGATIVE: Composio gateway classifies from the inner catalog, not occupancy', () => {
  const src = readFileSync(EFFECT, 'utf8');
  const fn = src.slice(
    src.indexOf('function classifyComposio'),
    src.indexOf('function classifyNativeMcp'),
  );
  assert.match(fn, /classifyBareCurrentCatalogCapability\(slug\)/);
  assert.match(fn, /if \(registered\.matched\) return registered\.decision/);
});
