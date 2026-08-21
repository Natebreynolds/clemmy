/**
 * Host-owned production invocation registry.
 *
 * Exact trusted-manifest identity is the only key. Tests and isolated
 * fixtures register observe/invoke/reconcile ports here. Normal bootstrap
 * looks them up; it does not invent adapters from tool names.
 */
import type { CapabilityManifestV1, CapabilityProviderKind } from './capability-manifest.js';
import { capabilityManifestDigest } from './capability-manifest.js';
import type {
  GraphNodeCapabilityInvoke,
  GraphNodeCapabilityReconcile,
} from './graph-node-capability.js';
import type { LiveCapabilityObserver } from './production-capability-adapter.js';
import { isolatedTestContractActive } from './isolated-test-contract.js';
import {
  isShippedInvoke,
  isShippedReconcile,
  peekShippedProvenance,
  shippedImplementationDigest,
} from './shipped-implementation-identity.js';

export interface ProductionPortIdentity {
  manifestId: string;
  manifestDigest: string;
  operationId: string;
  definitionFingerprint: string;
  providerKind: CapabilityProviderKind;
  accountId: string;
}

export interface ProductionCapabilityPort {
  observe?: LiveCapabilityObserver;
  invoke: GraphNodeCapabilityInvoke;
  reconcile?: GraphNodeCapabilityReconcile;
  /** Build-owned digest of the shipped invoke/reconcile adapter. */
  implementationDigest?: string;
  /** Reviewed CLI only: structured argv. Shell strings are refused. */
  argv?: readonly string[];
}

const ports = new Map<string, { identity: ProductionPortIdentity; port: ProductionCapabilityPort }>();

function identityKey(identity: ProductionPortIdentity): string {
  return JSON.stringify({
    manifestId: identity.manifestId,
    manifestDigest: identity.manifestDigest,
    operationId: identity.operationId,
    definitionFingerprint: identity.definitionFingerprint,
    providerKind: identity.providerKind,
    accountId: identity.accountId,
  });
}

export function productionPortIdentityFromManifest(manifest: CapabilityManifestV1): ProductionPortIdentity {
  return {
    manifestId: manifest.manifestId,
    manifestDigest: capabilityManifestDigest(manifest),
    operationId: manifest.operationId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerKind: manifest.providerKind,
    accountId: manifest.accountId,
  };
}

export function registerProductionCapabilityPort(
  identity: ProductionPortIdentity,
  port: ProductionCapabilityPort,
): { ok: true } | { ok: false; reason: 'identity_exists' | 'not_shipped_implementation' } {
  if (!isShippedInvoke(port.invoke)) {
    return { ok: false, reason: 'not_shipped_implementation' };
  }
  if (port.reconcile && !isShippedReconcile(port.reconcile)) {
    return { ok: false, reason: 'not_shipped_implementation' };
  }
  const key = identityKey(identity);
  const prior = ports.get(key);
  if (
    prior
    && (
      prior.port.invoke !== port.invoke
      || prior.port.reconcile !== port.reconcile
    )
  ) {
    return { ok: false, reason: 'identity_exists' };
  }
  ports.set(key, { identity, port });
  return { ok: true };
}

export function registerFixtureCapabilityPort(
  identity: ProductionPortIdentity,
  port: ProductionCapabilityPort,
): { ok: true } | { ok: false; reason: 'identity_exists' | 'not_shipped_implementation' | 'fixture_contract_inactive' } {
  if (!isolatedTestContractActive()) {
    return { ok: false, reason: 'fixture_contract_inactive' };
  }
  const key = identityKey(identity);
  const prior = ports.get(key);
  if (
    prior
    && (
      prior.port.invoke !== port.invoke
      || prior.port.reconcile !== port.reconcile
    )
  ) {
    return { ok: false, reason: 'identity_exists' };
  }
  ports.set(key, { identity, port: { ...port, implementationDigest: 'fixture' } });
  return { ok: true };
}

export function peekProductionCapabilityPort(
  identity: ProductionPortIdentity,
): ProductionCapabilityPort | null {
  return ports.get(identityKey(identity))?.port ?? null;
}

export function listProductionCapabilityPorts(): ReadonlyArray<{
  identity: ProductionPortIdentity;
  port: ProductionCapabilityPort;
}> {
  return [...ports.values()];
}

export function clearProductionCapabilityPorts(): void {
  ports.clear();
}

export function resolveProductionPortsForManifest(
  manifest: CapabilityManifestV1,
): ProductionCapabilityPort | null {
  return peekProductionCapabilityPort(productionPortIdentityFromManifest(manifest));
}

export function shippedInvokeImplementationDigest(): string {
  return shippedImplementationDigest('invoke');
}

export function shippedReconcileImplementationDigest(): string {
  return shippedImplementationDigest('reconcile');
}

export function portImplementationIdentity(input: {
  kind: 'invoke' | 'reconcile';
  invokePortId?: string;
  reconcilePortId?: string;
}): string {
  void input.invokePortId;
  void input.reconcilePortId;
  return shippedImplementationDigest(input.kind);
}

export function portImplementationDigest(
  port?: Pick<ProductionCapabilityPort, 'invoke' | 'reconcile'> & { implementationDigest?: string },
  kind: 'invoke' | 'reconcile' | 'adapter' = 'adapter',
): string {
  const fn = kind === 'reconcile' ? port?.reconcile : port?.invoke;
  const recorded = peekShippedProvenance(fn);
  if (recorded) return recorded.artifactDigest;
  if (kind === 'adapter') return shippedImplementationDigest('invoke');
  return shippedImplementationDigest(kind);
}
