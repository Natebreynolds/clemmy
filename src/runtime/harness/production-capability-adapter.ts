/**
 * Provider-neutral production capability adapter.
 *
 * Trusted manifests are the only source of effect, destination, account, and
 * policy. Live observations supply shape/version fingerprints. Search,
 * memory, slug heuristics, and model-facing Tool objects never register.
 *
 * Provider rules stay here — never in the graph compiler.
 */
import { createHash } from 'node:crypto';
import { realpathSync, statSync, readFileSync } from 'node:fs';
import { TOOL_REGISTRY } from '../../tools/tool-registry.js';
import { persistCapabilityLiveIdentity } from './capability-live-identity.js';
import { observeComposioIndependently } from './production-capability-adapters.js';
import { observeHostCallable } from './production-capability-catalog.js';
import { portImplementationIdentity, resolveProductionPortsForManifest } from './production-capability-ports.js';
import {
  adoptObservedCapabilityIdentity,
  independentlyObserveCapability,
  observationIsFresh,
  registerIndependentCapabilityObservation,
} from './independent-capability-observation.js';
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
  type CapabilityManifestV1,
  type CapabilityProviderKind,
} from './capability-manifest.js';
import {
  peekCapabilityManifestStore,
  resolveCapabilityManifestStore,
  type CapabilityManifestStore,
} from './capability-manifest-store.js';
import {
  createHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
  type GraphNodeCapabilityInvoke,
  type GraphNodeCapabilityReconcile,
  type HostCapabilityCatalogFactory,
  type RegisteredHostCapability,
} from './host-capability-catalog-factory.js';

export interface LiveCapabilityObservation {
  definitionFingerprint: string;
  providerVersion: string;
  operationVersion: string;
  accountId: string;
  observedAt: number;
  /** CLI only: structured argv, reviewed realpath, binary digest, shell:false. */
  reviewedCli?: {
    argv: readonly string[];
    executableRealpath: string;
    binaryFingerprint: string;
    shell: false;
  };
}

export type LiveObservationRefusal =
  | 'unknown'
  | 'stale'
  | 'ambiguous'
  | 'mismatched'
  | 'missing';

export type LiveCapabilityObserver = (
  manifest: CapabilityManifestV1,
) => LiveCapabilityObservation | LiveObservationRefusal;

export interface ManifestInvokePorts {
  invoke: GraphNodeCapabilityInvoke;
  reconcile?: GraphNodeCapabilityReconcile;
}

export interface ProductionCapabilityAdapter {
  observe: Record<CapabilityProviderKind, LiveCapabilityObserver>;
  invokesFor(manifest: CapabilityManifestV1): ManifestInvokePorts | null;
  refresh(): { registered: number; refused: Array<{ manifestId: string; reason: string }> };
}

export interface AdapterInstallResult {
  registered: number;
  refused: Array<{ manifestId: string; reason: string }>;
}

const LOCAL_REGISTRY_VERSION = 'tool-registry-v1';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function missing(_manifest: CapabilityManifestV1): LiveObservationRefusal {
  return 'missing';
}

export function liveLocalRegistryIdentity(operationId: string): LiveCapabilityObservation | LiveObservationRefusal {
  const decl = TOOL_REGISTRY.find((entry) => entry.name === operationId);
  if (!decl) return 'unknown';
  return {
    definitionFingerprint: sha256(JSON.stringify({
      name: decl.name,
      description: decl.description ?? '',
      sideEffect: decl.sideEffect,
      projectEffect: 'projectEffect' in decl ? decl.projectEffect : null,
      inputSchema: 'inputSchema' in decl ? decl.inputSchema ?? null : null,
      outputSchema: 'outputSchema' in decl ? decl.outputSchema ?? null : null,
    })),
    providerVersion: LOCAL_REGISTRY_VERSION,
    operationVersion: '1',
    accountId: 'local_registry:host',
    observedAt: Date.now(),
  };
}

function observeLocalRegistry(manifest: CapabilityManifestV1): LiveCapabilityObservation | LiveObservationRefusal {
  if (manifest.providerIdentity !== 'local_registry') return 'mismatched';
  const host = observeHostCallable(manifest.operationId, manifest.accountId);
  if (host !== 'unknown') return host;
  return liveLocalRegistryIdentity(manifest.operationId);
}

function observeComposio(manifest: CapabilityManifestV1): LiveCapabilityObservation | LiveObservationRefusal {
  const port = resolveProductionPortsForManifest(manifest);
  const fromPort = port?.observe?.(manifest);
  const independently = fromPort && typeof fromPort !== 'string'
    ? fromPort
    : observeComposioIndependently(manifest.operationId);
  if (!independently || typeof independently === 'string') return independently ?? 'missing';
  if (!independently.accountId.trim() || !independently.providerVersion.trim()) return 'missing';
  if (!independently.definitionFingerprint.trim()) return 'missing';
  persistCapabilityLiveIdentity({
    operationId: manifest.operationId,
    providerKind: 'composio',
    definitionFingerprint: independently.definitionFingerprint,
    providerVersion: independently.providerVersion,
    operationVersion: independently.operationVersion,
    accountId: independently.accountId,
    providerIdentity: 'composio',
    observedAt: independently.observedAt,
  });
  return independently;
}

function observeNativeMcp(manifest: CapabilityManifestV1): LiveCapabilityObservation | LiveObservationRefusal {
  const port = resolveProductionPortsForManifest(manifest);
  if (!port?.observe) return 'missing';
  return port.observe(manifest);
}

function observeReviewedCli(manifest: CapabilityManifestV1): LiveCapabilityObservation | LiveObservationRefusal {
  if (manifest.operationId.includes(' ') || manifest.operationId.includes('|')) {
    return 'unknown';
  }
  try {
    const real = realpathSync(manifest.providerIdentity);
    const stats = statSync(real);
    if (!stats.isFile()) return 'unknown';
    const binaryFingerprint = sha256(readFileSync(real));
    const port = resolveProductionPortsForManifest(manifest);
    const argv = port?.argv ? [...port.argv] : null;
    if (!argv || argv.length === 0 || argv.some((part) => part.includes('|') || part.includes(' '))) {
      return 'unknown';
    }
    return {
      definitionFingerprint: sha256(JSON.stringify({ real, binaryFingerprint, argv })),
      providerVersion: binaryFingerprint,
      operationVersion: '1',
      accountId: 'reviewed_cli:host',
      observedAt: Date.now(),
      reviewedCli: {
        argv,
        executableRealpath: real,
        binaryFingerprint,
        shell: false,
      },
    };
  } catch {
    return 'unknown';
  }
}

export function observationMatchesManifest(
  manifest: CapabilityManifestV1,
  observation: LiveCapabilityObservation | LiveObservationRefusal,
): { ok: true; observation: LiveCapabilityObservation } | { ok: false; reason: LiveObservationRefusal | 'stale' } {
  if (typeof observation === 'string') return { ok: false, reason: observation };
  if (observation.definitionFingerprint !== manifest.definitionFingerprint) {
    return { ok: false, reason: 'mismatched' };
  }
  if (observation.providerVersion !== manifest.providerVersion) {
    return { ok: false, reason: 'mismatched' };
  }
  if (observation.operationVersion !== manifest.operationVersion) {
    return { ok: false, reason: 'stale' };
  }
  if (observation.accountId !== manifest.accountId) {
    return { ok: false, reason: 'mismatched' };
  }
  if (manifest.providerKind === 'reviewed_cli') {
    const cli = observation.reviewedCli;
    if (!cli || cli.shell !== false || !Array.isArray(cli.argv) || cli.argv.length === 0) {
      return { ok: false, reason: 'unknown' };
    }
    if (cli.argv.some((part) => typeof part !== 'string' || part.includes('|'))) {
      return { ok: false, reason: 'unknown' };
    }
    if (cli.executableRealpath !== manifest.providerIdentity) {
      return { ok: false, reason: 'mismatched' };
    }
    if (cli.binaryFingerprint !== manifest.providerVersion) {
      return { ok: false, reason: 'mismatched' };
    }
  }
  return { ok: true, observation };
}

export function registeredCapabilityFromManifest(input: {
  manifest: CapabilityManifestV1;
  observation: LiveCapabilityObservation;
  invoke: GraphNodeCapabilityInvoke;
  reconcile?: GraphNodeCapabilityReconcile;
}): RegisteredHostCapability {
  return {
    capabilityId: input.manifest.manifestId,
    toolName: input.manifest.operationId,
    schemaVersion: input.manifest.operationVersion,
    schemaDigest: input.manifest.definitionFingerprint,
    effect: input.manifest.effect,
    ...(input.manifest.destination ? { destination: input.manifest.destination } : {}),
    account: input.manifest.accountId,
    advisoryRoles: input.manifest.advisoryRoles,
    manifestDigest: capabilityManifestDigest(input.manifest),
    providerKind: input.manifest.providerKind,
    liveFingerprint: input.observation.definitionFingerprint,
    delegatedFrom: input.manifest.delegatedFrom,
    manifest: input.manifest,
    ...(input.reconcile ? { reconcile: input.reconcile } : {}),
    invoke: input.invoke,
    implementationDigest: portImplementationIdentity({
      kind: 'invoke',
      invokePortId: input.manifest.invokePortId,
      reconcilePortId: input.manifest.reconcilePortId,
    }),
    invokeImplementationDigest: portImplementationIdentity({
      kind: 'invoke',
      invokePortId: input.manifest.invokePortId,
      reconcilePortId: input.manifest.reconcilePortId,
    }),
    ...(input.reconcile && input.manifest.reconcilePortId
      ? {
          reconcileImplementationDigest: portImplementationIdentity({
            kind: 'reconcile',
            invokePortId: input.manifest.invokePortId,
            reconcilePortId: input.manifest.reconcilePortId,
          }),
        }
      : {}),
  };
}

export function createProductionCapabilityAdapter(input: {
  factory?: HostCapabilityCatalogFactory;
  store?: CapabilityManifestStore;
  observe?: Partial<Record<CapabilityProviderKind, LiveCapabilityObserver>>;
  invokePorts?: (manifest: CapabilityManifestV1) => ManifestInvokePorts | null;
} = {}): ProductionCapabilityAdapter {
  const factory = input.factory ?? peekHostCapabilityCatalogFactory() ?? createHostCapabilityCatalogFactory();
  const store = input.store ?? resolveCapabilityManifestStore();
  const observe: Record<CapabilityProviderKind, LiveCapabilityObserver> = {
    local_registry: input.observe?.local_registry ?? observeLocalRegistry,
    composio: input.observe?.composio ?? observeComposio,
    native_mcp: input.observe?.native_mcp ?? observeNativeMcp,
    reviewed_cli: input.observe?.reviewed_cli ?? observeReviewedCli,
  };
  const adapter: ProductionCapabilityAdapter = {
    observe,
    invokesFor(manifest) {
      if (input.invokePorts) return input.invokePorts(manifest);
      const registered = resolveProductionPortsForManifest(manifest);
      if (!registered) return null;
      const mutation = manifest.effect === 'local_write'
        || manifest.effect === 'external_write'
        || manifest.effect === 'admin';
      const requiresReconcile = mutation && (
        manifest.reconciliation.supported
        || manifest.reconciliation.policy !== 'none'
      );
      if (requiresReconcile && !registered.reconcile) return null;
      return { invoke: registered.invoke, reconcile: registered.reconcile };
    },
    refresh() {
      const refused: Array<{ manifestId: string; reason: string }> = [];
      let registered = 0;
      for (const entry of store.list()) {
        const current = currentCapabilityManifest(entry.manifest);
        if (!current) {
          refused.push({
            manifestId: entry.manifest.manifestId,
            reason: entry.manifest.lifecycle.state === 'revoked'
              ? 'revoked'
              : entry.manifest.lifecycle.state === 'superseded'
                ? 'superseded'
                : 'unknown',
          });
          continue;
        }
        const already = factory.get(current.manifestId);
        const priorIndependent = independentlyObserveCapability(current.operationId, current.accountId);
        if (
          already?.invoke
          && priorIndependent
          && priorIndependent.origin === 'independent'
          && observationIsFresh(priorIndependent)
          && observationMatchesManifest(current, {
            definitionFingerprint: priorIndependent.definitionFingerprint,
            providerVersion: priorIndependent.providerVersion,
            operationVersion: priorIndependent.operationVersion,
            accountId: priorIndependent.accountId,
            observedAt: priorIndependent.observedAt,
          }).ok
        ) {
          registered += 1;
          continue;
        }
        const port = resolveProductionPortsForManifest(current);
        const liveObserver = input.observe
          ? observe[current.providerKind]
          : (port?.observe && (port.observe as unknown) !== observeHostCallable ? port.observe : undefined);
        const observed = (liveObserver ?? observe[current.providerKind])(current);
        let matched = observationMatchesManifest(current, observed);
        if (!matched.ok && (observed === 'missing' || observed === 'unknown')) {
          const prior = independentlyObserveCapability(current.operationId, current.accountId);
          if (
            prior
            && prior.origin === 'independent'
            && observationIsFresh(prior)
          ) {
            matched = observationMatchesManifest(current, {
              definitionFingerprint: prior.definitionFingerprint,
              providerVersion: prior.providerVersion,
              operationVersion: prior.operationVersion,
              accountId: prior.accountId,
              observedAt: prior.observedAt,
            });
          }
        }
        if (!matched.ok) {
          refused.push({ manifestId: current.manifestId, reason: matched.reason });
          factory.forget(current.manifestId);
          continue;
        }
        const ports = adapter.invokesFor(current);
        if (!ports) {
          const existing = factory.get(current.manifestId);
          if (existing?.invoke) {
            registered += 1;
            continue;
          }
          refused.push({ manifestId: current.manifestId, reason: 'missing' });
          factory.forget(current.manifestId);
          continue;
        }
        // Independence comes from the attested observer reading provider bytes,
        // never from the presence of a callback. Relabelling on callback
        // presence let a real observation be demoted to pack_attested and then
        // refused, which also forgot the capability.
        if (liveObserver) {
          registerIndependentCapabilityObservation({
            operationId: current.operationId,
            accountId: matched.observation.accountId,
            definitionFingerprint: matched.observation.definitionFingerprint,
            providerVersion: matched.observation.providerVersion,
            operationVersion: matched.observation.operationVersion,
            observedAt: matched.observation.observedAt,
            origin: 'independent',
            observe: () => {
              const live = liveObserver(current);
              if (typeof live === 'string') {
                return {
                  operationId: current.operationId,
                  accountId: matched.observation.accountId,
                  definitionFingerprint: matched.observation.definitionFingerprint,
                  providerVersion: matched.observation.providerVersion,
                  operationVersion: matched.observation.operationVersion,
                  observedAt: 0,
                };
              }
              return {
                operationId: current.operationId,
                accountId: live.accountId,
                definitionFingerprint: live.definitionFingerprint,
                providerVersion: live.providerVersion,
                operationVersion: live.operationVersion,
                observedAt: live.observedAt,
              };
            },
          });
        } else if (!adoptObservedCapabilityIdentity({
          operationId: current.operationId,
          accountId: matched.observation.accountId,
          definitionFingerprint: matched.observation.definitionFingerprint,
          providerVersion: matched.observation.providerVersion,
          operationVersion: matched.observation.operationVersion,
        })) {
          refused.push({ manifestId: current.manifestId, reason: 'observation_unavailable' });
          factory.forget(current.manifestId);
          continue;
        }
        try {
          factory.register(registeredCapabilityFromManifest({
            manifest: current,
            observation: matched.observation,
            invoke: ports.invoke,
            reconcile: ports.reconcile,
          }));
          registered += 1;
        } catch (error) {
          factory.forget(current.manifestId);
          refused.push({
            manifestId: current.manifestId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { registered, refused };
    },
  };
  return adapter;
}

let installedAdapter: ProductionCapabilityAdapter | null = null;

export function installProductionCapabilityAdapter(
  adapter: ProductionCapabilityAdapter | null,
): void {
  installedAdapter = adapter;
}

export function peekProductionCapabilityAdapter(): ProductionCapabilityAdapter | null {
  return installedAdapter;
}

/**
 * Install the shared production adapter against the already-installed
 * factory and trusted store. Does not scan model-facing tools. An empty
 * store leaves the catalog empty.
 */
export function installProductionCatalogAdapter(): ProductionCapabilityAdapter {
  const factory = peekHostCapabilityCatalogFactory() ?? createHostCapabilityCatalogFactory();
  const store = peekCapabilityManifestStore() ?? resolveCapabilityManifestStore();
  const adapter = createProductionCapabilityAdapter({ factory, store });
  installProductionCapabilityAdapter(adapter);
  adapter.refresh();
  return adapter;
}

/**
 * Isolated-daemon / test bootstrap: install trusted manifests and refresh
 * the shared production adapter. Search and model-facing tools never call this.
 */
export function installTrustedCapabilityManifests(
  manifests: readonly CapabilityManifestV1[],
  invokePorts: (manifest: CapabilityManifestV1) => ManifestInvokePorts | null,
): AdapterInstallResult {
  const store = resolveCapabilityManifestStore();
  for (const manifest of manifests) {
    const installed = store.install(manifest);
    if (!installed.ok) {
      return { registered: 0, refused: [{ manifestId: manifest.manifestId, reason: installed.reason }] };
    }
  }
  const factory = peekHostCapabilityCatalogFactory() ?? createHostCapabilityCatalogFactory();
  const adapter = createProductionCapabilityAdapter({ factory, store, invokePorts });
  installProductionCapabilityAdapter(adapter);
  return adapter.refresh();
}

export function catalogSnapshotDigestFromFactory(factory: HostCapabilityCatalogFactory): string {
  return sha256(JSON.stringify(factory.snapshot().map((entry) => ({
    capabilityId: entry.capabilityId,
    toolName: entry.toolName,
    schemaVersion: entry.schemaVersion,
    schemaDigest: entry.schemaDigest,
    effect: entry.effect,
    destination: entry.destination ?? null,
    account: entry.account ?? null,
    manifestDigest: entry.manifestDigest ?? null,
    invokePortId: entry.manifest?.invokePortId ?? null,
    reconcilePortId: entry.manifest?.reconcilePortId ?? null,
    implementationDigest: entry.implementationDigest ?? null,
  })).sort((a, b) => a.capabilityId.localeCompare(b.capabilityId))));
}
