import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Optional request-local narrowing for an accepted source whose immutable
 * owner already enumerated exact durable capability manifests (currently a
 * workflow step with literal Composio operation ids).
 *
 * This is display/freeze scope, not effect authority. Graph admission, plan
 * scope, manifests, accounts, schemas, and physical dispatch still apply in
 * full. The scope can only subtract Composio catalog rows; it can never add
 * one. Local reviewed host capabilities retain their ordinary planning rules.
 */
export interface AcceptedSourceCatalogManifestScope {
  manifestIds: ReadonlySet<string>;
  operationIds: ReadonlySet<string>;
}

const acceptedSourceCatalogScopeStorage = new AsyncLocalStorage<AcceptedSourceCatalogManifestScope>();

function normalizedManifestIds(manifestIds: readonly string[]): string[] {
  const normalized = [...new Set(manifestIds.map((value) => value.trim()).filter(Boolean))].sort();
  if (normalized.length > 32) {
    throw new Error('accepted-source catalog scope may contain at most 32 exact manifest ids');
  }
  return normalized;
}

function normalizedOperationIds(operationIds: readonly string[]): string[] {
  const normalized = [...new Set(operationIds.map((value) => value.trim().toUpperCase()).filter(Boolean))].sort();
  if (
    normalized.length === 0
    || normalized.length > 32
    || normalized.some((value) => !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}$/.test(value))
  ) {
    throw new Error('accepted-source catalog scope must contain 1..32 exact operation ids');
  }
  return normalized;
}

export function withAcceptedSourceCatalogManifestScope<T>(
  input: { manifestIds: readonly string[]; operationIds: readonly string[] } | undefined,
  work: () => T,
): T {
  if (!input) return work();
  const manifestIds = normalizedManifestIds(input.manifestIds);
  const operationIds = normalizedOperationIds(input.operationIds);
  const active = acceptedSourceCatalogScopeStorage.getStore();
  if (active) {
    if (
      JSON.stringify([...active.manifestIds].sort()) !== JSON.stringify(manifestIds)
      || JSON.stringify([...active.operationIds].sort()) !== JSON.stringify(operationIds)
    ) {
      throw new Error('nested accepted-source catalog scope identity changed');
    }
    return work();
  }
  return acceptedSourceCatalogScopeStorage.run({
    manifestIds: new Set(manifestIds),
    operationIds: new Set(operationIds),
  }, work);
}

export function currentAcceptedSourceCatalogManifestScope(): AcceptedSourceCatalogManifestScope | null {
  return acceptedSourceCatalogScopeStorage.getStore() ?? null;
}
