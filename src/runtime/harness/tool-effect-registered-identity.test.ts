/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/tool-effect-registered-identity.test.ts
 *
 * A bare provider operation may obtain effect authority only from one exact,
 * current callable manifest row. Adapter kind changes transport; it must not
 * change shared effect classification or the host catalog-manifest descent.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { CapabilityManifestV1, CapabilityProviderKind, ManifestEffect } from './capability-manifest.js';
import type { HostCapabilityCatalogFactory, RegisteredHostCapability } from './host-capability-catalog-factory.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-effect-identity-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const manifests = await import('./capability-manifest.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const effects = await import('./tool-effect.js');

after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const ARGS = { scope: 'current' } as const;
const PROVIDERS = ['reviewed_cli', 'native_mcp', 'composio'] as const;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function manifestFor(input: {
  providerKind: CapabilityProviderKind;
  operationId: string;
  manifestId?: string;
  effect?: ManifestEffect;
}): CapabilityManifestV1 {
  const effect = input.effect ?? 'read';
  const write = effect === 'external_write' || effect === 'local_write';
  const providerInputSchemaDigest = digest(`schema:${input.providerKind}:${input.operationId}`);
  return manifests.attachSemanticContract({
    version: 1,
    manifestId: input.manifestId ?? `cap:effect:${input.providerKind}:${input.operationId.toLowerCase()}`,
    providerKind: input.providerKind,
    operationId: input.operationId,
    providerIdentity: input.providerKind === 'reviewed_cli'
      ? `/fixture/reviewed/${input.operationId.toLowerCase()}`
      : `fixture:${input.providerKind}:configured`,
    providerVersion: digest(`provider:${input.providerKind}`),
    operationVersion: digest(`operation:${input.providerKind}:${input.operationId}`),
    definitionFingerprint: digest(`definition:${input.providerKind}:${input.operationId}`),
    ...(input.providerKind === 'composio' || input.providerKind === 'native_mcp'
      ? {
          externalDefinition: {
            version: 1 as const,
            providerInputSchemaDigest,
            semanticName: input.operationId,
            behaviorHints: {
              readOnly: effect === 'read',
              destructive: write ? false : null,
              idempotent: effect === 'read' ? true : null,
              openWorld: false,
            },
          },
        }
      : {}),
    effect,
    accountId: input.providerKind === 'reviewed_cli'
      ? 'reviewed_cli:host'
      : `account:${input.providerKind}:fixture`,
    idempotency: write
      ? { required: true, policy: 'key_before_dispatch' as const }
      : { required: false, policy: 'none' as const },
    reconciliation: write
      ? { supported: true, policy: 'exact_artifact' as const }
      : { supported: false, policy: 'none' as const },
    outputContract: { kind: effect === 'read' ? 'records' : 'receipt' },
    purpose: effect === 'read' ? 'collect_records' : 'persist_collection',
    acceptedInputKinds: effect === 'read' ? ['query'] : ['records'],
    producedOutputKinds: effect === 'read' ? ['records'] : ['receipt'],
    applicableDeliverableKinds: effect === 'read' ? ['records'] : ['artifact'],
    evidenceContract: {
      kinds: effect === 'read' ? ['records'] : ['receipt'],
      readbackRequired: write,
    },
    provenance: {
      issuer: `host:${input.providerKind}:materializer:v1`,
      issuedAt: '2026-08-27T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: effect === 'read' ? ['source'] : ['destination'],
  });
}

function registered(manifest: CapabilityManifestV1): RegisteredHostCapability {
  return {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    ...(manifest.destination ? { destination: manifest.destination } : {}),
    account: manifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    providerInputSchemaDigest: manifest.externalDefinition?.providerInputSchemaDigest,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({ successful: true }),
  };
}

function install(entries: readonly RegisteredHostCapability[]): HostCapabilityCatalogFactory {
  const factory = catalogs.createHostCapabilityCatalogFactory();
  for (const entry of entries) factory.register(entry);
  catalogs.installHostCapabilityCatalogFactory(factory);
  return factory;
}

test('reviewed CLI, native MCP, and Composio reads classify identically and enter the same host manifest descent', () => {
  const sharedProjections: unknown[] = [];
  for (const providerKind of PROVIDERS) {
    const operationId = `FIXTURE_${providerKind.toUpperCase()}_CURRENT_RECORDS`;
    install([registered(manifestFor({ providerKind, operationId }))]);

    // Production host carriers recurse through call_tool to this same bare
    // operation. Lowercase deliberately defeats the legacy SCREAMING_SNAKE
    // fallback: only the exact current catalog identity can supply the effect.
    const decision = effects.classifyRuntimeToolEffect('call_tool', {
      name: operationId.toLowerCase(),
      args_json: JSON.stringify(ARGS),
    });
    assert.deepEqual(decision, {
      effect: 'read',
      mutating: false,
      dangerousWrite: false,
      source: providerKind,
    }, providerKind);
    assert.equal(
      effects.runtimeToolAuthorityBinding(decision),
      'catalog_manifest',
      `${providerKind} must pass the exact predicate used by production host read descent`,
    );
    sharedProjections.push({
      effect: decision.effect,
      mutating: decision.mutating,
      dangerousWrite: decision.dangerousWrite,
      authority: effects.runtimeToolAuthorityBinding(decision),
    });
  }
  assert.deepEqual(sharedProjections, Array.from({ length: PROVIDERS.length }, () => ({
    effect: 'read',
    mutating: false,
    dangerousWrite: false,
    authority: 'catalog_manifest',
  })));
});

test('one exact current write keeps its sealed write effect and full manifest authority', () => {
  const operationId = 'FIXTURE_COMPOSIO_APPEND_RECORDS';
  install([registered(manifestFor({ providerKind: 'composio', operationId, effect: 'external_write' }))]);
  const decision = effects.classifyRuntimeToolEffect(operationId.toLowerCase(), ARGS);
  assert.deepEqual(decision, {
    effect: 'external_write',
    mutating: true,
    dangerousWrite: true,
    source: 'composio',
  });
  assert.equal(effects.runtimeToolAuthorityBinding(decision), 'catalog_manifest');
});

test('stale and unattested registered names fail closed before spelling heuristics', () => {
  const staleManifest = manifestFor({
    providerKind: 'composio',
    operationId: 'FIXTURE_STALE_LIST_RECORDS',
  });
  const stale = registered(staleManifest);
  install([stale]);
  stale.liveFingerprint = digest('drift-after-registration');
  assert.equal(
    effects.classifyRuntimeToolEffect(stale.toolName, ARGS).effect,
    'unknown',
    'a stale row cannot fall through and become a name-inferred Composio read',
  );

  const unattested = registered(manifestFor({
    providerKind: 'reviewed_cli',
    operationId: 'FIXTURE_UNATTESTED_LIST_RECORDS',
  }));
  const fakeFactory = {
    register() {},
    forget() {},
    clear() {},
    snapshot: () => [unattested],
    get: () => unattested,
    catalog: () => ({ bind: () => null }),
  } as HostCapabilityCatalogFactory;
  catalogs.installHostCapabilityCatalogFactory(fakeFactory);
  assert.equal(effects.classifyRuntimeToolEffect(unattested.toolName, ARGS).effect, 'unknown');
  assert.equal(
    effects.runtimeToolAuthorityBinding(effects.classifyRuntimeToolEffect(unattested.toolName, ARGS)),
    'unknown',
  );
});

test('duplicate same-effect manifests stay readable while conflicting effects fail closed', () => {
  const operationId = 'FIXTURE_AMBIGUOUS_LIST_RECORDS';
  const read = registered(manifestFor({
    providerKind: 'native_mcp',
    operationId,
    manifestId: 'cap:ambiguous:read',
  }));
  const duplicateRead = registered(manifestFor({
    providerKind: 'native_mcp',
    operationId,
    manifestId: 'cap:ambiguous:duplicate-read',
  }));
  install([read, duplicateRead]);
  assert.equal(effects.classifyRuntimeToolEffect(operationId, ARGS).effect, 'read');

  const conflictingWrite = registered(manifestFor({
    providerKind: 'native_mcp',
    operationId,
    manifestId: 'cap:ambiguous:write',
    effect: 'external_write',
  }));
  install([read, conflictingWrite]);
  assert.equal(effects.classifyRuntimeToolEffect(operationId, ARGS).effect, 'unknown');
});

test('a unique catalog read classifies the same through native MCP and Composio spellings', () => {
  const operationId = 'GOOGLESHEETS_BATCH_GET';
  install([registered(manifestFor({ providerKind: 'composio', operationId }))]);
  for (const spelling of [
    'GOOGLESHEETS_BATCH_GET',
    'googlesheets_batch_get',
    'google_sheets__batch_get',
  ]) {
    const decision = effects.classifyRuntimeToolEffect(spelling, { spreadsheet_id: 'sheet' });
    assert.deepEqual(decision, {
      effect: 'read',
      mutating: false,
      dangerousWrite: false,
      source: 'composio',
    }, spelling);
  }
});

test('local registry tools and names absent from the catalog keep their existing boundaries', () => {
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  assert.deepEqual(effects.classifyRuntimeToolEffect('space_get', {}), {
    effect: 'read',
    mutating: false,
    dangerousWrite: false,
    source: 'registry',
  });
  assert.equal(effects.classifyRuntimeToolEffect('unheard_of_local_name', {}).effect, 'unknown');
});
