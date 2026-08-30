/**
 * Materialize one explicitly reviewed Clementine-local tool into the same
 * immutable catalog/port/observation surface used by external workflow calls.
 * The registry and current captured schema nominate the operation; only this
 * exact materialization plus the workflow v3 activation can execute it.
 */
import {
  capabilityManifestDigest,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import { resolveCapabilityManifestStore } from './capability-manifest-store.js';
import {
  canonicalCatalogIdentityOf,
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
  type CanonicalCatalogIdentityV1,
  type RegisteredHostCapability,
} from './host-capability-catalog-factory.js';
import {
  portImplementationDigest,
  peekProductionCapabilityPort,
  productionPortIdentityFromManifest,
  registerProductionCapabilityPort,
} from './production-capability-ports.js';
import {
  peekIndependentCapabilityObservation,
  registerIndependentCapabilityObservation,
} from './independent-capability-observation.js';
import { loadShippedImplementations } from './shipped-implementation-identity.js';
import {
  observeReviewedLocalTool,
  observeReviewedLocalTransport,
  reviewedLocalCapabilityManifest,
  reviewedLocalToolArgumentsMatch,
  REVIEWED_LOCAL_ACCOUNT,
  REVIEWED_LOCAL_ARGUMENT_COMPILER,
  REVIEWED_LOCAL_OPERATION_VERSION,
  REVIEWED_LOCAL_PROVIDER_IDENTITY,
  REVIEWED_LOCAL_PROVIDER_VERSION,
  type ReviewedLocalToolObservation,
} from './reviewed-local-tool-carrier.js';

export type EnsureReviewedLocalWorkflowCapabilityResult =
  | {
      ok: true;
      identity: Readonly<CanonicalCatalogIdentityV1>;
      manifest: Readonly<CapabilityManifestV1>;
    }
  | {
      ok: false;
      reason:
        | 'not_reviewed'
        | 'arguments_invalid'
        | 'manifest_invalid'
        | 'manifest_conflict'
        | 'implementation_unavailable'
        | 'observation_conflict'
        | 'catalog_registration_failed';
      detail?: string;
    };

function registerOrReusePort(manifest: CapabilityManifestV1) {
  const identity = productionPortIdentityFromManifest(manifest);
  const existing = peekProductionCapabilityPort(identity);
  if (existing) return existing;
  const shipped = loadShippedImplementations();
  const port = {
    invoke: shipped.invokeForSealedManifest(manifest),
    reconcile: shipped.reconcileForSealedManifest(manifest),
  };
  const registered = registerProductionCapabilityPort(identity, port);
  if (!registered.ok) return null;
  return peekProductionCapabilityPort(identity);
}

function catalogEntry(
  manifest: CapabilityManifestV1,
  port: NonNullable<ReturnType<typeof registerOrReusePort>>,
  observed: ReviewedLocalToolObservation,
): RegisteredHostCapability {
  return {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    ...(manifest.destination ? { destination: manifest.destination } : {}),
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    sourceSchemaFingerprint: observed.definition.schemaFingerprint,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    reconcile: port.reconcile!,
    invoke: port.invoke,
    implementationDigest: portImplementationDigest(port),
    invokeImplementationDigest: portImplementationDigest(port, 'invoke'),
    reconcileImplementationDigest: portImplementationDigest(port, 'reconcile'),
  };
}

export function ensureReviewedLocalWorkflowCapability(input: {
  operationId: string;
  args: Record<string, unknown>;
}): EnsureReviewedLocalWorkflowCapabilityResult {
  const observed = observeReviewedLocalTool(input.operationId);
  if (!observed) return { ok: false, reason: 'not_reviewed' };
  if (!reviewedLocalToolArgumentsMatch(observed, input.args)) {
    return { ok: false, reason: 'arguments_invalid' };
  }
  const manifest = reviewedLocalCapabilityManifest(observed);
  if (!manifest) return { ok: false, reason: 'manifest_invalid' };

  const store = resolveCapabilityManifestStore();
  const current = store.list().filter((entry) => (
    entry.manifest.providerKind === 'local_registry'
    && entry.manifest.operationId === input.operationId
    && entry.manifest.provenance.issuer === 'host:reviewed-local-registry'
    && entry.manifest.lifecycle.state === 'current'
  ));
  if (current.length > 1) return { ok: false, reason: 'manifest_conflict' };
  const prior = current[0];
  const desiredDigest = capabilityManifestDigest(manifest);
  const sameId = store.get(manifest.manifestId);
  if (sameId && sameId.digest !== desiredDigest) {
    return { ok: false, reason: 'manifest_conflict', detail: 'identity_mismatch' };
  }
  const priorObservation = peekIndependentCapabilityObservation(
    input.operationId,
    REVIEWED_LOCAL_ACCOUNT,
  );
  if (
    priorObservation
    && (
      priorObservation.definitionFingerprint !== observed.definition.envelopeFingerprint
      || priorObservation.providerVersion !== REVIEWED_LOCAL_PROVIDER_VERSION
      || priorObservation.operationVersion !== REVIEWED_LOCAL_OPERATION_VERSION
    )
  ) {
    return { ok: false, reason: 'observation_conflict', detail: 'identity_exists' };
  }

  let port: ReturnType<typeof registerOrReusePort>;
  try {
    port = registerOrReusePort(manifest);
  } catch (error) {
    return {
      ok: false,
      reason: 'implementation_unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!port) return { ok: false, reason: 'implementation_unavailable' };

  const installed = !prior || prior.manifest.manifestId === manifest.manifestId
    ? store.install(manifest)
    : store.supersede(prior.manifest.manifestId, manifest);
  if (!installed.ok) {
    return { ok: false, reason: 'manifest_conflict', detail: installed.reason };
  }

  const observation = observeReviewedLocalTransport(input.operationId, REVIEWED_LOCAL_ACCOUNT);
  if (!observation) return { ok: false, reason: 'observation_conflict' };
  const registeredObservation = registerIndependentCapabilityObservation({
    ...observation,
    origin: 'independent',
    observe: () => {
      const live = observeReviewedLocalTransport(input.operationId, REVIEWED_LOCAL_ACCOUNT);
      if (!live) throw new Error('reviewed local capability is no longer configured');
      return live;
    },
  });
  if (!registeredObservation.ok) {
    return { ok: false, reason: 'observation_conflict', detail: registeredObservation.reason };
  }

  const factory = peekHostCapabilityCatalogFactory() ?? createHostCapabilityCatalogFactory();
  for (const entry of factory.snapshot()) {
    if (
      entry.capabilityId !== manifest.manifestId
      && entry.providerKind === 'local_registry'
      && entry.manifest?.operationId === input.operationId
      && entry.manifest.provenance.issuer === 'host:reviewed-local-registry'
    ) factory.forget(entry.capabilityId);
  }
  const entry = catalogEntry(manifest, port, observed);
  factory.register(entry);
  if (!peekHostCapabilityCatalogFactory()) installHostCapabilityCatalogFactory(factory);
  const identity = canonicalCatalogIdentityOf(entry);
  if (!identity) return { ok: false, reason: 'catalog_registration_failed' };
  return {
    ok: true,
    identity: Object.freeze({ ...identity }),
    manifest: Object.freeze({ ...manifest }),
  };
}
