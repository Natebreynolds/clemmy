/**
 * Test-only: bind a fake handler into both the source adapter singleton and
 * the attested isolated transport artifact. Never imported by production
 * adapter bundles.
 */
import type { CapabilityManifestV1 } from './capability-manifest.js';
import { isolatedTestContractActive } from './isolated-test-contract.js';
import { installProductionTransport, type ProductionTransport } from './production-capability-adapters.js';
import {
  productionPortIdentityFromManifest,
  registerProductionCapabilityPort,
} from './production-capability-ports.js';
import { loadShippedImplementations } from './shipped-implementation-identity.js';
import { registerIndependentCapabilityObservation } from './independent-capability-observation.js';

export function installIsolatedAttestedTransport(transport: ProductionTransport | null): void {
  if (!isolatedTestContractActive()) {
    throw new Error('isolated attested transport bind requires the isolated-test contract');
  }
  installProductionTransport(transport);
  loadShippedImplementations().bindIsolatedTransport(transport);
}

export function registerShippedTestPort(manifest: CapabilityManifestV1, observedAt = Date.now()): void {
  const shipped = loadShippedImplementations();
  const write = manifest.effect === 'external_write' || manifest.effect === 'local_write';
  registerProductionCapabilityPort(productionPortIdentityFromManifest(manifest), {
    invoke: shipped.invokeForSealedManifest(manifest),
    ...(write ? { reconcile: shipped.reconcileForSealedManifest(manifest) } : {}),
  });
  shipped.registerIsolatedObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt,
  });
  registerIndependentCapabilityObservation({
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt,
    origin: 'independent',
  });
}
