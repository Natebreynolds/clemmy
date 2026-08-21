/**
 * Fixture-only construct-provider catalog.
 *
 * Builds a host-local capability catalog from in-process callbacks under a
 * fixed `host:construct-test` account. This is a test seam, not production
 * authority: it installs manifests into the durable store and registers its own
 * observations, so it must never be reachable from a shipped entry point. It
 * lived in `admitted-construct-run.ts` while every one of its callers was a
 * test, which kept a test-only writer inside the production module.
 */
import { createHash } from 'node:crypto';
import {
  attachSemanticContract,
  capabilityManifestDigest,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
} from './host-capability-catalog-factory.js';
import {
  peekCapabilityManifestStore,
  resolveCapabilityManifestStore,
} from './capability-manifest-store.js';
import { registerIndependentCapabilityObservation } from './independent-capability-observation.js';
import {
  configureTypedExecutionRuntime,
  refreshTypedExecutionReadiness,
} from '../semantic-boundary/configure-typed-execution-runtime.js';
import type {
  BoundNodeCapability,
  GraphNodeCapabilityReconcile,
  HostCapabilityCatalog,
} from './graph-node-capability.js';
import type { ConstructProviderPorts } from './admitted-construct-run.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function asRecords(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  if (payload && typeof payload === 'object' && Array.isArray((payload as { records?: unknown }).records)) {
    return (payload as { records: Array<Record<string, unknown>> }).records;
  }
  return [];
}

function constructProviderManifest(input: {
  role: string;
  toolName: string;
  effect: BoundNodeCapability['effect'];
  schemaDigest: string;
}): CapabilityManifestV1 {
  const write = input.effect === 'external_write' || input.effect === 'local_write';
  return attachSemanticContract({
    version: 1,
    manifestId: `host:${input.toolName}:${input.role}`,
    providerKind: 'local_registry',
    operationId: input.toolName,
    providerIdentity: 'local_registry',
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    definitionFingerprint: input.schemaDigest,
    effect: input.effect,
    ...(write ? { destination: { family: 'workbook', posture: 'create_new' } } : {}),
    accountId: 'host:construct-test',
    idempotency: {
      required: write,
      policy: write ? 'key_before_dispatch' : 'none',
    },
    reconciliation: {
      supported: write,
      policy: write ? 'exact_artifact' : 'none',
    },
    outputContract: { kind: write ? 'created_resource' : 'records' },
    evidenceContract: {
      kinds: write ? ['receipt', 'readback'] : ['payload'],
      readbackRequired: write,
    },
    provenance: {
      issuer: 'host:construct-provider-adapter',
      issuedAt: '1970-01-01T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: [input.role],
  });
}

export function catalogFromConstructProviders(
  ports: ConstructProviderPorts,
  options: {
    /** Also register the single-read 'lookup' capability. Opt-in: the default
     *  eight roles exactly fill the candidate shortlist, and a ninth entry
     *  would displace 'readback' from every collect→construct proposal. */
    lookup?: boolean;
  } = {},
): HostCapabilityCatalog {
  const installed = peekHostCapabilityCatalogFactory();
  const factory = installed ?? createHostCapabilityCatalogFactory();
  const store = peekCapabilityManifestStore() ?? resolveCapabilityManifestStore();
  const register = (
    role: string,
    run: (payload: unknown) => Promise<unknown>,
    effect: BoundNodeCapability['effect'],
    toolName: string,
    reconcile?: GraphNodeCapabilityReconcile,
  ): void => {
    const schemaDigest = sha256(`${toolName}:construct:1`);
    const manifest = constructProviderManifest({ role, toolName, effect, schemaDigest });
    store.install(manifest);
    const observedAt = Date.now();
    registerIndependentCapabilityObservation({
      operationId: manifest.operationId,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt,
      origin: 'independent',
      observe: () => ({
        operationId: manifest.operationId,
        accountId: manifest.accountId,
        definitionFingerprint: manifest.definitionFingerprint,
        providerVersion: manifest.providerVersion,
        operationVersion: manifest.operationVersion,
        observedAt,
      }),
    });
    factory.register({
      capabilityId: manifest.manifestId,
      toolName,
      schemaVersion: manifest.operationVersion,
      schemaDigest,
      effect,
      advisoryRoles: [role],
      manifestDigest: capabilityManifestDigest(manifest),
      providerKind: manifest.providerKind,
      liveFingerprint: schemaDigest,
      manifest,
      account: manifest.accountId,
      ...(effect === 'external_write' || effect === 'local_write'
        ? { destination: { family: 'workbook', posture: 'create_new' } }
        : {}),
      ...(effect === 'external_write' || effect === 'local_write'
        ? { reconcile: reconcile ?? (async () => ({ exists: false })) }
        : reconcile ? { reconcile } : {}),
      invoke: async ({ payload }) => run(payload),
    });
  };
  register('source', () => ports.sourceRead('source'), 'read', 'host_lookup');
  if (options.lookup) {
    register('lookup', () => ports.sourceRead('lookup'), 'read', 'host_lookup');
  }
  register('collection', () => ports.collectionRead('collection'), 'read', 'host_lookup');
  register('collect', () => ports.collectionRead('collect'), 'read', 'host_lookup');
  register('transform', (payload) => ports.transform(asRecords(payload)), 'host_only', 'host_transform');
  register('extract', (payload) => ports.transform(asRecords(payload)), 'host_only', 'host_transform');
  register('destination', (payload) => ports.create(asRecords(payload)), 'external_write', 'host_create', ports.reconcile);
  register('create', (payload) => ports.create(asRecords(payload)), 'external_write', 'host_create', ports.reconcile);
  register('readback', (payload) => {
    const id = typeof payload === 'string' ? payload : String((payload as { id?: unknown })?.id ?? '');
    return ports.readback(id);
  }, 'read', 'host_lookup');
  if (!installed) installHostCapabilityCatalogFactory(factory);
  configureTypedExecutionRuntime();
  refreshTypedExecutionReadiness();
  return factory.catalog();
}
